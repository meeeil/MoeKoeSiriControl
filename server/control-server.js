/**
 * Control server (Phase 3: WS auth / heartbeat / origin validation).
 *
 * Listens on CONTROL_HOST:CONTROL_PORT, accepts WebSocket upgrades ONLY on
 * config.WS_PATH. HTTP GET /health is provided for basic liveness.
 *
 * WS lifecycle:
 *   connect -> client sends {"type":"auth",...} within WS_AUTH_TIMEOUT_MS
 *   -> {"type":"auth.ok"} | {"type":"auth.error"} + close
 *   server pings {"type":"ping","t":...} every heartbeatIntervalMs; client
 *   must answer {"type":"pong","t":...} within pongTimeoutMs or the socket
 *   is terminated.
 *
 * Origin: present-but-not-allowed Origins are rejected with 1008. A missing
 * Origin (non-browser clients) is allowed — the WS token is the credential.
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
import { verifyPairCookie } from './pairing.js';

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

  const app = express();
  app.disable('x-powered-by');
  app.get('/health', (_req, res) => {
    res.json({ ok: true, protocol: config.PROTOCOL_VERSION });
  });

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

  // A WebUI tab on the same PC connects as 127.0.0.1 / ::1; the real target
  // device (iPad) connects over the LAN with a non-loopback address.
  function isLoopback(remote) {
    const r = String(remote || '').toLowerCase();
    return r === '::1' || r === '::ffff:127.0.0.1' || r === '127.0.0.1' || r.endsWith('127.0.0.1');
  }

  wss.on('connection', (socket, req) => {
    const remote = req.socket.remoteAddress || 'unknown';
    const origin = req.headers.origin;

    if (origin && !allowedOrigins.has(origin)) {
      console.log(`[control] reject ws origin ${origin} (${remote})`);
      socket.close(1008, 'origin not allowed');
      return;
    }

    const conn = {
      id: randomUUID(),
      socket,
      remote,
      paired: false,
      authenticated: false,
      alive: false,
      lastAuthedAt: 0,
      authTimer: null,
      heartbeatTimer: null,
      pongTimeout: null
    };
    // Phase 5.6: only an iPad that completed /siri/pair carries the HMAC
    // pairing cookie; it can then ask for session recovery (which yields a
    // KuGou login token).
    conn.paired = verifyPairCookie(req.headers.cookie, config.SIRI_HTTP_TOKEN);
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
          if (
            typeof msg.token === 'string' &&
            msg.token.length > 0 &&
            safeTokenEqual(msg.token, config.SIRI_WS_TOKEN)
          ) {
            conn.authenticated = true;
            conn.alive = true;
            conn.lastAuthedAt = Date.now();
            clearTimeout(conn.authTimer);
            send(socket, buildAuthOk(config.PROTOCOL_VERSION));
            console.log(`[control] authenticated (${remote})`);
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
          if (typeof msg.reqId === 'string' && msg.reqId) {
            console.log(`[control] ack reqId=${msg.reqId} ok=${msg.ok === true}`);
            if (onAck) onAck(msg);
          }
          break;
        case 'session.reauth.req': {
          // Phase 5.6: password-login recovery on behalf of a paired iPad.
          // The response is sent only to the originating socket (never
          // broadcast) and only after the WS auth + pairing cookie checks.
          const reqId = typeof msg.reqId === 'string' && msg.reqId ? msg.reqId : null;
          if (!reqId) break;
          if (!conn.paired) {
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
    // Phase 5 fix: play.req must reach exactly ONE client to avoid duplicate
    // playback and racing acks (e.g. an unauthenticated WebUI tab on the PC
    // answering SEARCH_FAILED before the iPad). Prefer a non-loopback peer
    // (the physical device), then the most recently authenticated one.
    sendPlayRequest(obj) {
      let best = null;
      for (const conn of clients) {
        if (!conn.authenticated || conn.socket.readyState !== WebSocket.OPEN) continue;
        if (!best) {
          best = conn;
          continue;
        }
        const bestLoop = isLoopback(best.remote);
        const curLoop = isLoopback(conn.remote);
        if (bestLoop && !curLoop) {
          best = conn;
        } else if (bestLoop === curLoop && conn.lastAuthedAt > best.lastAuthedAt) {
          best = conn;
        }
      }
      if (!best) return 0;
      send(best.socket, obj);
      return 1;
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