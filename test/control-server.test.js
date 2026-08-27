import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createControlServer } from '../server/control-server.js';
import { createControllerStore } from '../server/controller-store.js';
import config from '../server/config.js';
import { buildAuthOk } from '../server/protocol.js';
import { makePairCookieValue, PAIR_COOKIE } from '../server/pairing.js';

const CONTROLLER_DEVICE_ID = 'controller-device-1';
const controllerStore = createControllerStore({ filePath: null });
controllerStore.set(CONTROLLER_DEVICE_ID);

const acks = [];
const server = createControlServer({
  authTimeoutMs: 300,
  heartbeatIntervalMs: 60,
  pongTimeoutMs: 40,
  controllerStore,
  handlers: {
    onAck: (ack) => acks.push(ack)
  }
});

const ALLOWED_ORIGIN = 'http://127.0.0.1:8080';

const CONTROLLER_COOKIE = `${PAIR_COOKIE}=${makePairCookieValue(
  config.SIRI_HTTP_TOKEN,
  CONTROLLER_DEVICE_ID
)}`;
const OTHER_DEVICE_ID = 'other-device-2';
const OTHER_COOKIE = `${PAIR_COOKIE}=${makePairCookieValue(
  config.SIRI_HTTP_TOKEN,
  OTHER_DEVICE_ID
)}`;

let wsUrl;
let httpUrl;
before(async () => {
  await new Promise((resolve) => server.httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = server.httpServer.address();
  wsUrl = `ws://127.0.0.1:${port}${config.WS_PATH}`;
  httpUrl = `http://127.0.0.1:${port}`;
});

function connect(url, { origin = ALLOWED_ORIGIN, headers } = {}) {
  return new Promise((resolve, reject) => {
    const opts = { origin };
    if (headers) opts.headers = headers;
    const sock = new WebSocket(url, opts);
    sock.once('open', () => resolve(sock));
    sock.once('error', (err) => reject(err));
  });
}

function nextMessage(sock) {
  return new Promise((resolve) => {
    sock.once('message', (data) => resolve(JSON.parse(data.toString())));
  });
}

function waitClose(sock) {
  return new Promise((resolve) => {
    sock.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn, timeoutMs = 1000, intervalMs = 10) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(intervalMs);
  }
  return fn();
}

function sendAuth(sock, { token = config.SIRI_WS_TOKEN, version = config.PROTOCOL_VERSION } = {}) {
  sock.send(JSON.stringify({ type: 'auth', token, version }));
}

async function authedController(url = wsUrl, cookie = CONTROLLER_COOKIE) {
  const sock = await connect(url, { headers: { Cookie: cookie } });
  sendAuth(sock);
  await nextMessage(sock); // auth.ok
  return sock;
}

after(() => server.close());

test('health endpoint responds ok with controller state', async () => {
  const res = await fetch(`${httpUrl}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.protocol, config.PROTOCOL_VERSION);
  assert.equal(body.controller.paired, true);
  assert.equal(typeof body.controller.online, 'boolean');
});

test('livez is live while readyz waits for the upstream API', async () => {
  const live = await fetch(`${httpUrl}/livez`);
  assert.equal(live.status, 200);
  assert.deepEqual(await live.json(), { ok: true, status: 'live' });

  const notReady = await fetch(`${httpUrl}/readyz`);
  assert.equal(notReady.status, 503);
  const body = await notReady.json();
  assert.equal(body.ok, false);
  assert.equal(body.checks.dist, true);
  assert.equal(body.checks.upstream, false);
});

test('readyz returns 200 when dist and upstream are ready', async () => {
  const readyServer = createControlServer({
    heartbeatIntervalMs: 60000,
    pongTimeoutMs: 60000,
    upstream: { get: () => ({ reachable: true }), url: 'http://kugou-api:6521' }
  });
  await new Promise((resolve) => readyServer.httpServer.listen(0, '127.0.0.1', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${readyServer.httpServer.address().port}/readyz`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      ok: true,
      status: 'ready',
      checks: { dist: true, upstream: true }
    });
  } finally {
    await readyServer.close();
  }
});

test('health reports upstream + sessionAuth when provided', async () => {
  const store = createControllerStore({ filePath: null });
  store.set(CONTROLLER_DEVICE_ID);
  const sa = {
    status: () => ({ configured: true, state: 'ready', lastError: null, cooldownUntil: 0, attemptsRemaining: 5 })
  };
  const healthServer = createControlServer({
    authTimeoutMs: 300,
    heartbeatIntervalMs: 60000,
    pongTimeoutMs: 60000,
    controllerStore: store,
    sessionAuth: sa,
    upstream: { get: () => ({ reachable: true, status: 200, checkedAt: 123 }), url: 'http://127.0.0.1:6521' }
  });
  await new Promise((resolve) => healthServer.httpServer.listen(0, '127.0.0.1', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${healthServer.httpServer.address().port}/health`);
    const body = await res.json();
    assert.deepEqual(body.upstream, { url: 'http://127.0.0.1:6521', reachable: true, status: 200, checkedAt: 123 });
    assert.deepEqual(body.sessionAuth, {
      configured: true,
      state: 'ready',
      lastError: null,
      cooldownUntil: 0,
      attemptsRemaining: 5
    });
  } finally {
    await healthServer.close();
  }
});

test('auth with correct token (no cookie) -> auth.ok paired=false controller=false', async () => {
  const sock = await connect(wsUrl);
  sendAuth(sock);
  const ok = await nextMessage(sock);
  assert.deepEqual(ok, buildAuthOk(config.PROTOCOL_VERSION, { paired: false, controller: false }));
  sock.close();
  await waitFor(() => server.activeClients === 0, 1000);
});

test('auth with controller cookie -> auth.ok controller=true, stays alive through heartbeat', async () => {
  const sock = await authedController();
  const pings = [];
  const deadline = Date.now() + 260;
  while (Date.now() < deadline) {
    const msg = await nextMessage(sock);
    if (msg.type === 'ping') {
      pings.push(msg.t);
      sock.send(JSON.stringify({ type: 'pong', t: msg.t }));
    }
  }
  assert.ok(pings.length >= 2, `expected >=2 pings, got ${pings.length}`);
  assert.equal(sock.readyState, WebSocket.OPEN, 'socket should stay open');
  sock.close();
  await waitFor(() => server.controllerConnectionCount() === 0, 1000);
});

test('auth with other-device cookie -> auth.ok paired=true controller=false', async () => {
  const sock = await connect(wsUrl, { headers: { Cookie: OTHER_COOKIE } });
  sendAuth(sock);
  const ok = await nextMessage(sock);
  assert.deepEqual(ok, buildAuthOk(config.PROTOCOL_VERSION, { paired: true, controller: false }));
  sock.close();
});

test('auth with wrong token -> auth.error then close', async () => {
  const sock = await connect(wsUrl);
  sendAuth(sock, { token: 'wrong-token' });
  const err = await nextMessage(sock);
  assert.equal(err.type, 'auth.error');
  assert.equal(err.reason, 'invalid_token');
  const { code } = await waitClose(sock);
  assert.equal(code, 1008);
});

test('no auth message within timeout -> close', async () => {
  const sock = await connect(wsUrl);
  const { code } = await waitClose(sock);
  assert.equal(code, 1008);
});

test('disallowed origin -> close immediately', async () => {
  const sock = await connect(wsUrl, { origin: 'http://evil.example:8080' });
  const { code } = await waitClose(sock);
  assert.equal(code, 1008);
});

test('same-host external origin is accepted without a configured public domain', async () => {
  const sock = await connect(wsUrl, {
    origin: 'https://music.example.test',
    headers: { Host: 'music.example.test' }
  });
  sendAuth(sock);
  const ok = await nextMessage(sock);
  assert.equal(ok.type, 'auth.ok');
  sock.close();
});

test('missed pong -> server terminates connection', async () => {
  const sock = await connect(wsUrl);
  sendAuth(sock);
  await nextMessage(sock); // auth.ok

  const ping = await nextMessage(sock); // first server ping, do NOT pong
  assert.equal(ping.type, 'ping');

  const { code } = await waitClose(sock);
  assert.equal(code, 1006, 'terminate() closes without a close frame');
});

test('invalid JSON and unknown pre-auth messages are ignored (connection stays open)', async () => {
  const sock = await connect(wsUrl);
  sock.send('this is not json');
  sock.send(JSON.stringify({ type: 'unknown' }));
  await sleep(80);
  assert.equal(sock.readyState, WebSocket.OPEN);

  sendAuth(sock);
  const ok = await nextMessage(sock);
  assert.equal(ok.type, 'auth.ok');
  sock.close();
  await waitFor(() => server.activeClients === 0, 1000);
});

test('activeClients tracks connections', async () => {
  await waitFor(() => server.activeClients === 0, 1000);
  assert.equal(server.activeClients, 0, 'baseline should be clean');
  const sock = await connect(wsUrl);
  assert.equal(server.activeClients, 1);
  sendAuth(sock);
  await nextMessage(sock);
  assert.equal(server.activeClients, 1);
  sock.close();
  await waitFor(() => server.activeClients === 0, 1000);
});

test('post-auth ping/pong keeps the connection alive across intervals', async () => {
  const sock = await connect(wsUrl);
  sendAuth(sock);
  await nextMessage(sock); // auth.ok

  const deadline = Date.now() + 200;
  while (Date.now() < deadline) {
    const msg = await nextMessage(sock);
    if (msg.type === 'ping') {
      sock.send(JSON.stringify({ type: 'pong', t: msg.t }));
    }
  }
  assert.equal(sock.readyState, WebSocket.OPEN);
  sock.close();
});

test('broadcast sends play.req to authenticated clients only', async () => {
  const authSock = await authedController();
  const anonSock = await connect(wsUrl); // connected but never authenticates

  const sent = server.broadcast({ type: 'play.req', reqId: 'b1', query: '七里香' });
  assert.equal(sent, 1, 'only the authenticated client receives');

  const received = await nextMessage(authSock);
  assert.deepEqual(received, { type: 'play.req', reqId: 'b1', query: '七里香' });

  anonSock.close();
  authSock.close();
  await waitFor(() => server.activeClients === 0, 1000);
});

test('sendPlayRequest targets the paired controller only (returns target info)', async () => {
  const controllerSock = await authedController();
  const otherSock = await connect(wsUrl, { headers: { Cookie: OTHER_COOKIE } });
  sendAuth(otherSock);
  await nextMessage(otherSock); // auth.ok
  const plainSock = await connect(wsUrl);
  sendAuth(plainSock);
  await nextMessage(plainSock); // auth.ok

  const playReqs = [];
  controllerSock.on('message', (data) => {
    const m = JSON.parse(data.toString());
    if (m && m.type === 'play.req') playReqs.push('controller');
  });
  otherSock.on('message', (data) => {
    const m = JSON.parse(data.toString());
    if (m && m.type === 'play.req') playReqs.push('other');
  });
  plainSock.on('message', (data) => {
    const m = JSON.parse(data.toString());
    if (m && m.type === 'play.req') playReqs.push('plain');
  });

  const result = server.sendPlayRequest({ type: 'play.req', reqId: 't1', query: '七里香' });
  assert.equal(result.sent, true, 'a controller is online');
  assert.equal(typeof result.connectionId, 'string');
  assert.ok(server.isControllerConnection(result.connectionId), 'target is a controller connection');

  await waitFor(() => playReqs.length === 1);
  assert.deepEqual(playReqs, ['controller'], 'only the controller receives play.req');

  controllerSock.close();
  otherSock.close();
  plainSock.close();
  await waitFor(() => server.activeClients === 0, 1000);
});

test('sendPlayRequest with controller offline -> sent:false even when tabs are online', async () => {
  const plainSock = await connect(wsUrl);
  sendAuth(plainSock);
  await nextMessage(plainSock); // auth.ok

  const result = server.sendPlayRequest({ type: 'play.req', reqId: 't2', query: 'x' });
  assert.deepEqual(result, { sent: false, connectionId: null });
  assert.equal(server.controllerOnline(), false);
  assert.equal(server.controllerConnectionCount(), 0);
  assert.equal(server.authenticatedClients, 1, 'ordinary tab is authenticated but not controller');

  plainSock.close();
  await waitFor(() => server.activeClients === 0, 1000);
});

test('same deviceId second auth replaces the old controller connection (close 4001)', async () => {
  const replacementStore = createControllerStore({ filePath: null });
  replacementStore.set(CONTROLLER_DEVICE_ID);
  const seen = [];
  const replacementServer = createControlServer({
    authTimeoutMs: 300,
    heartbeatIntervalMs: 60000,
    pongTimeoutMs: 60000,
    controllerStore: replacementStore,
    handlers: {
      onAuthenticated: (conn) => seen.push(conn)
    }
  });
  await new Promise((resolve) => replacementServer.httpServer.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${replacementServer.httpServer.address().port}${config.WS_PATH}`;

  const a = await authedController(url);
  await waitFor(() => seen.length === 1);
  assert.equal(replacementServer.controllerConnectionCount(), 1);
  assert.ok(replacementServer.isControllerConnection(seen[0].id));

  const closed = waitClose(a);
  const b = await authedController(url); // same deviceId cookie -> newest wins
  await waitFor(() => seen.length === 2);
  assert.equal(replacementServer.controllerConnectionCount(), 1);
  const res = await closed;
  assert.equal(res.code, 4001);
  assert.match(res.reason, /controller_replaced/);
  assert.equal(seen[1].controller, true, 'newest connection is the controller');
  assert.equal(seen[0].controller, false, 'old connection lost controller status');

  b.close();
  await replacementServer.close();
  await waitFor(() => server.activeClients === 0, 1000);
});

test('play.ack from controller invokes onAck; non-controller ack is ignored', async () => {
  acks.length = 0;
  const controllerSock = await authedController();
  const otherSock = await connect(wsUrl, { headers: { Cookie: OTHER_COOKIE } });
  sendAuth(otherSock);
  await nextMessage(otherSock); // auth.ok

  otherSock.send(
    JSON.stringify({ type: 'play.ack', reqId: 'ignored', ok: true, song: { hash: 'H0', name: 'x' } })
  );
  await sleep(50);
  assert.equal(acks.length, 0, 'non-controller ack must be ignored');

  controllerSock.send(
    JSON.stringify({ type: 'play.ack', reqId: 'a1', ok: true, song: { hash: 'H1', name: '七里香' } })
  );
  await waitFor(() => acks.length === 1);
  assert.equal(acks[0].reqId, 'a1');
  assert.equal(acks[0].ok, true);
  assert.equal(acks[0].song.hash, 'H1');

  controllerSock.send(JSON.stringify({ type: 'play.ack', reqId: '', ok: false, error: 'SEARCH_FAILED' }));
  await sleep(40);
  assert.equal(acks.length, 1, 'ack without reqId is ignored');

  controllerSock.close();
  otherSock.close();
  await waitFor(() => server.activeClients === 0, 1000);
});

/* ===================================================================== *
 *  Phase 5.6: session.reauth.req / res (paired controller password recovery)
 * ===================================================================== */

const sessionAuthLogins = [];
const reauthStore = createControllerStore({ filePath: null });
reauthStore.set(CONTROLLER_DEVICE_ID);
const reauthServer = createControlServer({
  authTimeoutMs: 300,
  heartbeatIntervalMs: 60000,
  pongTimeoutMs: 60000,
  controllerStore: reauthStore,
  sessionAuth: {
    login: async (device) => {
      sessionAuthLogins.push(device);
      return {
        ok: true,
        session: { token: 'new-session-token', t1: 't1', userid: '7', vip_type: 1, vip_token: 'vt' }
      };
    }
  }
});

let reauthWsUrl;
before(async () => {
  await new Promise((resolve) => reauthServer.httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = reauthServer.httpServer.address();
  reauthWsUrl = `ws://127.0.0.1:${port}${config.WS_PATH}`;
});

after(() => reauthServer.close());

function connectWithCookie(url, cookieHeader) {
  return connect(url, { headers: { Cookie: cookieHeader } });
}

const reauthDevice = { dfid: 'df', mid: 'm', guid: 'g', serverDev: 'sd', mac: 'ma' };

async function authedWithCookie(url, cookieHeader) {
  const sock = await connectWithCookie(url, cookieHeader);
  sendAuth(sock);
  await nextMessage(sock); // auth.ok
  return sock;
}

test('reauth: unpaired (no cookie) authenticated client -> PAIR_REQUIRED', async () => {
  const sock = await authedWithCookie(reauthWsUrl, '');
  sock.send(JSON.stringify({ type: 'session.reauth.req', reqId: 'r1', device: reauthDevice }));
  const res = await nextMessage(sock);
  assert.deepEqual(res, {
    type: 'session.reauth.res',
    reqId: 'r1',
    ok: false,
    error: 'PAIR_REQUIRED'
  });
  assert.equal(sessionAuthLogins.length, 0, 'no password login for an unpaired client');
  sock.close();
  await waitFor(() => reauthServer.activeClients === 0, 1000);
});

test('reauth: forged cookie (wrong HMAC) -> PAIR_REQUIRED', async () => {
  const sock = await authedWithCookie(reauthWsUrl, `${PAIR_COOKIE}=forged.device.signature`);
  sock.send(JSON.stringify({ type: 'session.reauth.req', reqId: 'r2', device: reauthDevice }));
  const res = await nextMessage(sock);
  assert.equal(res.type, 'session.reauth.res');
  assert.equal(res.error, 'PAIR_REQUIRED');
  sock.close();
});

test('reauth: paired but NOT the controller (different deviceId) -> PAIR_REQUIRED', async () => {
  const sock = await authedWithCookie(reauthWsUrl, OTHER_COOKIE);
  sock.send(JSON.stringify({ type: 'session.reauth.req', reqId: 'r8', device: reauthDevice }));
  const res = await nextMessage(sock);
  assert.equal(res.type, 'session.reauth.res');
  assert.equal(res.error, 'PAIR_REQUIRED');
  sock.close();
});

test('reauth: unauthenticated connection ignores the reauth request', async () => {
  const sock = await connectWithCookie(reauthWsUrl, CONTROLLER_COOKIE);
  sock.send(JSON.stringify({ type: 'session.reauth.req', reqId: 'r3', device: reauthDevice }));
  await sleep(80);
  assert.equal(sock.readyState, WebSocket.OPEN, 'still open (waiting for auth)');
  sock.close();
});

test('reauth: controller + authenticated -> fresh session returned only to that socket', async () => {
  const sock = await authedWithCookie(reauthWsUrl, CONTROLLER_COOKIE);
  sock.send(JSON.stringify({ type: 'session.reauth.req', reqId: 'r4', device: reauthDevice }));
  const res = await nextMessage(sock);
  assert.equal(res.type, 'session.reauth.res');
  assert.equal(res.reqId, 'r4');
  assert.equal(res.ok, true);
  assert.deepEqual(res.session, {
    token: 'new-session-token',
    t1: 't1',
    userid: '7',
    vip_type: 1,
    vip_token: 'vt'
  });
  assert.deepEqual(sessionAuthLogins[sessionAuthLogins.length - 1], reauthDevice);
  sock.close();
  await waitFor(() => reauthServer.activeClients === 0, 1000);
});

test('reauth: session.reauth.res is never broadcast', async () => {
  const a = await authedWithCookie(reauthWsUrl, CONTROLLER_COOKIE);
  const b = await authedWithCookie(reauthWsUrl, OTHER_COOKIE);
  const bMessages = [];
  b.on('message', (data) => bMessages.push(JSON.parse(data.toString())));

  a.send(JSON.stringify({ type: 'session.reauth.req', reqId: 'r5', device: reauthDevice }));
  const res = await nextMessage(a);
  assert.equal(res.ok, true);
  await sleep(80);
  assert.equal(
    bMessages.some((m) => m.type === 'session.reauth.res'),
    false,
    'b never saw the response'
  );

  a.close();
  b.close();
  await waitFor(() => reauthServer.activeClients === 0, 1000);
});

test('reauth: sessionAuth failure code is forwarded verbatim', async () => {
  const failingStore = createControllerStore({ filePath: null });
  failingStore.set(CONTROLLER_DEVICE_ID);
  const failingServer = createControlServer({
    authTimeoutMs: 300,
    heartbeatIntervalMs: 60000,
    pongTimeoutMs: 60000,
    controllerStore: failingStore,
    sessionAuth: {
      login: async () => ({ ok: false, code: 'RISK_REQUIRED', detail: 'captcha' })
    }
  });
  await new Promise((resolve) => failingServer.httpServer.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${failingServer.httpServer.address().port}${config.WS_PATH}`;
  const sock = await authedWithCookie(url, CONTROLLER_COOKIE);
  sock.send(JSON.stringify({ type: 'session.reauth.req', reqId: 'r6', device: reauthDevice }));
  const res = await nextMessage(sock);
  assert.deepEqual(res, {
    type: 'session.reauth.res',
    reqId: 'r6',
    ok: false,
    error: 'RISK_REQUIRED'
  });
  sock.close();
  await failingServer.close();
});

test('reauth: no sessionAuth configured -> NOT_CONFIGURED', async () => {
  const noAuthStore = createControllerStore({ filePath: null });
  noAuthStore.set(CONTROLLER_DEVICE_ID);
  const noAuthServer = createControlServer({
    authTimeoutMs: 300,
    heartbeatIntervalMs: 60000,
    pongTimeoutMs: 60000,
    controllerStore: noAuthStore
  });
  await new Promise((resolve) => noAuthServer.httpServer.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${noAuthServer.httpServer.address().port}${config.WS_PATH}`;
  const sock = await authedWithCookie(url, CONTROLLER_COOKIE);
  sock.send(JSON.stringify({ type: 'session.reauth.req', reqId: 'r7', device: reauthDevice }));
  const res = await nextMessage(sock);
  assert.deepEqual(res, {
    type: 'session.reauth.res',
    reqId: 'r7',
    ok: false,
    error: 'NOT_CONFIGURED'
  });
  sock.close();
  await noAuthServer.close();
});
