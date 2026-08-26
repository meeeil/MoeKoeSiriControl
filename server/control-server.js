/**
 * Control server (Phase 1/2: unique paired controller + protocol v2).
 *
 * Listens on CONTROL_HOST:CONTROL_PORT, accepts WebSocket upgrades ONLY on
 * config.WS_PATH. HTTP GET /health is provided for basic liveness.
 *
 * WS lifecycle:
 *   connect -> client sends {"type":"auth","token":"...","version":2} within
 *   WS_AUTH_TIMEOUT_MS -> {"type":"auth.ok","version":2,"paired":..,"controller":..}
 *   | {"type":"auth.error",...} + close. Protocol mismatch -> auth.error
 *   protocol_mismatch + close 1002.
 *   server pings {"type":"ping","t":...} every heartbeatIntervalMs; client
 *   must answer {"type":"pong","t":...} within pongTimeoutMs or the socket
 *   is terminated.
 *
 * Controller gating (Phase 1): a connection is the `controller` only when it
 * is authenticated (WS token ok) AND its pairing cookie HMAC verifies AND the
 * cookie deviceId equals the persisted controller.json deviceId. Only the
 * controller can receive play.req, trigger offline dispatch, settle play.ack,
 * or use session.reauth.req. Every other authenticated WebUI tab (phone, PC,
 * extra tabs) stays a normal client and can never steal a command.
 *
 * When a second connection authenticates with the same controller deviceId
 * (e.g. a second tab on the iPad), the older controller connection is revoked
 * first, pending/offline are notified, and it is closed with code 4001
 * ("controller_replaced") — newest authenticated tab wins.
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import config from './config.js';
import {
  buildAuthOk,
  buildAuthError,
  buildPing,
  parseControlMessage,
  safeTokenEqual
} from './protocol.js';
import { parsePairCookie } from './pairing.js';

export function createControlServer(overrides = {}) {
  const limits = {
    heartbeatIntervalMs:
      overrides.heartbeatIntervalMs ?? config.LIMITS.HEARTBEAT_INTERVAL_MS,
    pongTimeoutMs: overrides.pongTimeoutMs ?? config.LIMITS.PONG_TIMEOUT_MS,
    authTimeoutMs: overrides.authTimeoutMs ?? config.LIMITS.WS_AUTH_TIMEOUT_MS
  };

  const allowedOrigins = new Set(config.WEB_ORIGINS);
  const clients = new Set();
  const handlers = overrides.handlers || {};
  const onAck = typeof handlers.onAck === 'function' ? handlers.onAck : null;
  const onAuthenticated = typeof handlers.onAuthenticated === 'function' ? handlers.onAuthenticated : null;
  const onDisconnected = typeof handlers.onDisconnected === 'function' ? handlers.onDisconnected : null;

  // Phase 1: single source of truth for "which device is the controller".
  const controllerStore =
    overrides.controllerStore ||
    {
      get: () => ({ version: 1, deviceId: null, pairedAt: 0, corrupt: false }),
      isController: () => false
    };

  // Phase 6/7: optional upstream reachability cache + session-auth breaker.
  const upstream = overrides.upstream || { get: () => null, url: null };
  const sessionAuth = overrides.sessionAuth || null;

  const app = express();
  app.disable('x-powered-by');
  app.get('/health', (_req, res) => {
    const controller = controllerStore.get();
    const up = typeof upstream.get === 'function' ? upstream.get() : null;
    const sa = sessionAuth && typeof sessionAuth.status === 'function' ? sessionAuth.status() : null;
    res.json({
      ok: true,
      status: 'ok',
      version: config.VERSION,
      protocol: config.PROTOCOL_VERSION,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      controller: {
        paired: controller.deviceId !== null,
        online: controllerOnline()
      },
      upstream: {
        url: upstream.url || null,
        reachable: up ? up.reachable : null,
        status: up ? up.status : null,
        checkedAt: up ? up.checkedAt : 0
      },
      sessionAuth: sa
        ? {
            configured: sa.configured,
            state: sa.state,
            lastError: sa.lastError,
            cooldownUntil: sa.cooldownUntil,
            attemptsRemaining: sa.attemptsRemaining
          }
        : null
    });
  });

  const startedAt = Date.now();
  const httpServer = http.createServer(app);
  const wss = new WebSocketServer({ server: httpServer, path: config.WS_PATH });

  const send = (socket, obj) => {
    if (socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify(obj));
      } catch (_err) {
        // ignore
      }
    }
  };

  /** True when at least one controller connection is authenticated+open. */
  function controllerOnline() {
    for (const conn of clients) {
      if (conn.controller && conn.authenticated && conn.socket.readyState === WebSocket.OPEN) {
        return true;
      }
    }
    return false;
  }

  /** Count of authenticated+open controller connections. */
  function controllerConnectionCount() {
    let count = 0;
    for (const conn of clients) {
      if (conn.controller && conn.authenticated && conn.socket.readyState === WebSocket.OPEN) {
        count += 1;
      }
    }
    return count;
  }

  /** True when the given connection id is the authenticated controller. */
  function isControllerConnection(connectionId) {
    for (const conn of clients) {
      if (conn.id === connectionId && conn.controller && conn.authenticated) {
        return true;
      }
    }
    return false;
  }

  /**
   * Revoke controller status from every other connection and close it with
   * 4001, then notify pending/offline of the disconnect.
   */
  function replaceControllers(keepConn) {
    for (const other of clients) {
      if (other === keepConn || !other.controller || !other.authenticated) continue;
      other.controller = false;
      console.log(`[control] controller replaced by newer auth (${other.remote})`);
      if (onDisconnected) onDisconnected(other);
      try {
        other.socket.close(4001, 'controller_replaced');
      } catch (_err) {
        // ignore
      }
    }
  }

  function isOriginAllowed(origin) {
    if (!origin) return true;
    if (allowedOrigins.has(origin)) return true;
    if (allowedOrigins.has('*')) return true;
    try {
      const parsed = new URL(origin);
      const host = parsed.hostname;
      if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
      if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
      if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
      if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
      if (host.endsWith('.local') || host.endsWith('.lan')) return true;
    } catch (_e) {
      // ignore
    }
    return false;
  }

  wss.on('connection', (socket, req) => {
    const remote = req.socket.remoteAddress || 'unknown';
    const origin = req.headers.origin;

    if (origin && !isOriginAllowed(origin)) {
      console.log(`[control] reject ws origin ${origin} (${remote})`);
      socket.close(1008, 'origin not allowed');
      return;
    }

    const pair = parsePairCookie(req.headers.cookie, config.SIRI_HTTP_TOKEN);
    const conn = {
      id: randomUUID(),
      socket,
      remote,
      paired: pair !== null,
      deviceId: pair ? pair.deviceId : null,
      controller: false,
      authenticated: false,
      alive: false,
      lastAuthedAt: 0,
      authTimer: null,
      heartbeatTimer: null,
      pongTimeout: null
    };
    clients.add(conn);

    conn.authTimer = setTimeout(() => {
      if (!conn.authenticated && socket.readyState === WebSocket.OPEN) {
        console.log(`[control] auth timeout (${remote})`);
        socket.close(1008, 'auth timeout');
      }
    }, limits.authTimeoutMs);

    conn.heartbeatTimer = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (!conn.authenticated) return;
      if (!conn.alive) {
        console.log(`[control] heartbeat dead (${remote})`);
        socket.terminate();
        return;
      }
      conn.alive = false;
      send(socket, buildPing(Date.now()));
      conn.pongTimeout = setTimeout(() => {
        if (!conn.alive && socket.readyState === WebSocket.OPEN) {
          console.log(`[control] pong timeout (${remote})`);
          socket.terminate();
        }
      }, limits.pongTimeoutMs);
    }, limits.heartbeatIntervalMs);

    socket.on('message', (data, isBinary) => {
      if (isBinary) return;
      const msg = parseControlMessage(data);
      if (!msg) return;

      if (!conn.authenticated) {
        if (msg.type === 'auth') {
          const version = Number.isInteger(msg.version) ? msg.version : 0;
          if (version !== config.PROTOCOL_VERSION) {
            send(socket, buildAuthError('protocol_mismatch', config.PROTOCOL_VERSION));
            setTimeout(() => socket.close(1002, 'protocol_mismatch'), 100);
            return;
          }
          if (
            typeof msg.token === 'string' &&
            msg.token.length > 0 &&
            safeTokenEqual(msg.token, config.SIRI_WS_TOKEN)
          ) {
            conn.authenticated = true;
            conn.alive = true;
            conn.lastAuthedAt = Date.now();
            clearTimeout(conn.authTimer);
            conn.controller =
              conn.paired && controllerStore.isController(conn.deviceId);
            if (conn.controller) replaceControllers(conn);
            send(socket, buildAuthOk(config.PROTOCOL_VERSION, {
              paired: conn.paired,
              controller: conn.controller
            }));
            console.log(`[control] authenticated (${remote}) controller=${conn.controller}`);
            if (onAuthenticated) onAuthenticated(conn);
          } else {
            send(socket, buildAuthError('invalid_token'));
            setTimeout(() => socket.close(1008, 'invalid token'), 100);
          }
        }
        return;
      }

      switch (msg.type) {
        case 'pong':
          conn.alive = true;
          if (conn.pongTimeout) {
            clearTimeout(conn.pongTimeout);
            conn.pongTimeout = null;
          }
          break;
        case 'play.ack':
          if (!conn.controller) {
            console.log(`[control] ignored play.ack from non-controller (${remote})`);
            break;
          }
          if (typeof msg.reqId === 'string' && msg.reqId) {
            console.log(`[control] ack reqId=${msg.reqId} ok=${msg.ok === true}`);
            if (onAck) onAck(msg, conn.id);
          }
          break;
        case 'session.reauth.req': {
          // Phase 5.6: password-login recovery on behalf of the paired iPad.
          // The response is sent only to the originating socket (never
          // broadcast) and only after WS auth + controller checks.
          const reqId = typeof msg.reqId === 'string' && msg.reqId ? msg.reqId : null;
          if (!reqId) break;
          if (!conn.controller) {
            send(socket, { type: 'session.reauth.res', reqId, ok: false, error: 'PAIR_REQUIRED' });
            break;
          }
          const sessionAuth = overrides.sessionAuth;
          if (!sessionAuth || typeof sessionAuth.login !== 'function') {
            send(socket, { type: 'session.reauth.res', reqId, ok: false, error: 'NOT_CONFIGURED' });
            break;
          }
          const device = msg.device && typeof msg.device === 'object' ? msg.device : {};
          console.log(`[control] session reauth reqId=${reqId} (${remote})`);
          Promise.resolve(sessionAuth.login(device))
            .then((result) => {
              if (socket.readyState !== WebSocket.OPEN) return;
              if (result && result.ok === true) {
                send(socket, {
                  type: 'session.reauth.res',
                  reqId,
                  ok: true,
                  session: result.session
                });
              } else {
                send(socket, {
                  type: 'session.reauth.res',
                  reqId,
                  ok: false,
                  error: result && result.code ? result.code : 'UPSTREAM_UNAVAILABLE'
                });
              }
            })
            .catch(() => {
              if (socket.readyState === WebSocket.OPEN) {
                send(socket, { type: 'session.reauth.res', reqId, ok: false, error: 'UPSTREAM_UNAVAILABLE' });
              }
            });
          break;
        }
        default:
          // Phase 5 adds play.req / search.req / search.res routing.
          break;
      }
    });

    const cleanup = () => {
      clearTimeout(conn.authTimer);
      clearInterval(conn.heartbeatTimer);
      if (conn.pongTimeout) {
        clearTimeout(conn.pongTimeout);
        conn.pongTimeout = null;
      }
      clients.delete(conn);
      if (onDisconnected) onDisconnected(conn);
      console.log(`[control] disconnected (${remote})`);
    };

    socket.on('close', cleanup);
    socket.on('error', () => {
      // ws emits 'close' afterwards; nothing sensitive to log here.
    });
  });

  return {
    app,
    httpServer,
    wss,
    get activeClients() {
      return clients.size;
    },
    get authenticatedClients() {
      let count = 0;
      for (const conn of clients) {
        if (conn.authenticated) count += 1;
      }
      return count;
    },
    controllerOnline,
    controllerConnectionCount,
    isControllerConnection,
    broadcast(obj) {
      const text = JSON.stringify(obj);
      let count = 0;
      for (const conn of clients) {
        if (conn.authenticated && conn.socket.readyState === WebSocket.OPEN) {
          try {
            conn.socket.send(text);
            count += 1;
          } catch (_err) {
            // ignore
          }
        }
      }
      return count;
    },
    // Phase 1: play.req must reach ONLY the unique paired controller. Returns
    // {sent, connectionId} (never a bare 0/1).
    sendPlayRequest(obj) {
      let target = null;
      for (const conn of clients) {
        if (
          !conn.controller ||
          !conn.authenticated ||
          conn.socket.readyState !== WebSocket.OPEN
        ) {
          continue;
        }
        if (!target || conn.lastAuthedAt > target.lastAuthedAt) {
          target = conn;
        }
      }
      if (!target) return { sent: false, connectionId: null };
      send(target.socket, obj);
      return { sent: true, connectionId: target.id };
    },
    // Deliver a message to one specific connection by id (offline re-dispatch).
    // Returns 1 on send, 0 if the connection is gone / not open.
    sendTo(id, obj) {
      for (const conn of clients) {
        if (conn.id === id && conn.authenticated && conn.socket.readyState === WebSocket.OPEN) {
          try {
            conn.socket.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
            return 1;
          } catch (_err) {
            return 0;
          }
        }
      }
      return 0;
    },
    close() {
      for (const conn of clients) {
        conn.socket.terminate();
      }
      return new Promise((resolve) => {
        wss.close(() => httpServer.close(() => resolve()));
      });
    }
  };
}