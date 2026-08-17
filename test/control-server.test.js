import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createControlServer } from '../server/control-server.js';
import config from '../server/config.js';
import { buildAuthOk } from '../server/protocol.js';
import { derivePairValue, PAIR_COOKIE } from '../server/pairing.js';

const acks = [];
const server = createControlServer({
  authTimeoutMs: 300,
  heartbeatIntervalMs: 60,
  pongTimeoutMs: 40,
  handlers: {
    onAck: (ack) => acks.push(ack)
  }
});

const ALLOWED_ORIGIN = 'http://127.0.0.1:8080';

let wsUrl;
let httpUrl;
before(async () => {
  await new Promise((resolve) => server.httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = server.httpServer.address();
  wsUrl = `ws://127.0.0.1:${port}${config.WS_PATH}`;
  httpUrl = `http://127.0.0.1:${port}`;
});

function connect(url, { origin = ALLOWED_ORIGIN } = {}) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(url, { origin });
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
    sock.once('close', (code) => resolve(code));
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

after(() => server.close());

test('health endpoint responds ok', async () => {
  const res = await fetch(`${httpUrl}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.protocol, config.PROTOCOL_VERSION);
});

test('auth with correct token -> auth.ok, stays alive through heartbeat', async () => {
  const sock = await connect(wsUrl);
  sock.send(JSON.stringify({ type: 'auth', token: config.SIRI_WS_TOKEN, version: 1 }));

  const ok = await nextMessage(sock);
  assert.deepEqual(ok, buildAuthOk(config.PROTOCOL_VERSION));

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
});

test('auth with wrong token -> auth.error then close', async () => {
  const sock = await connect(wsUrl);
  sock.send(JSON.stringify({ type: 'auth', token: 'wrong-token', version: 1 }));

  const err = await nextMessage(sock);
  assert.equal(err.type, 'auth.error');
  assert.equal(err.reason, 'invalid_token');

  const code = await waitClose(sock);
  assert.equal(code, 1008);
});

test('no auth message within timeout -> close', async () => {
  const sock = await connect(wsUrl);
  const code = await waitClose(sock);
  assert.equal(code, 1008);
});

test('disallowed origin -> close immediately', async () => {
  const sock = await connect(wsUrl, { origin: 'http://evil.example:8080' });
  const code = await waitClose(sock);
  assert.equal(code, 1008);
});

test('missed pong -> server terminates connection', async () => {
  const sock = await connect(wsUrl);
  sock.send(JSON.stringify({ type: 'auth', token: config.SIRI_WS_TOKEN, version: 1 }));
  await nextMessage(sock); // auth.ok

  const ping = await nextMessage(sock); // first server ping, do NOT pong
  assert.equal(ping.type, 'ping');

  const code = await waitClose(sock);
  assert.equal(code, 1006, 'terminate() closes without a close frame');
});

test('invalid JSON and unknown pre-auth messages are ignored (connection stays open)', async () => {
  const sock = await connect(wsUrl);
  sock.send('this is not json');
  sock.send(JSON.stringify({ type: 'unknown' }));
  await sleep(80);
  assert.equal(sock.readyState, WebSocket.OPEN);

  sock.send(JSON.stringify({ type: 'auth', token: config.SIRI_WS_TOKEN, version: 1 }));
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
  sock.send(JSON.stringify({ type: 'auth', token: config.SIRI_WS_TOKEN, version: 1 }));
  await nextMessage(sock);
  assert.equal(server.activeClients, 1);
  sock.close();
  await waitFor(() => server.activeClients === 0, 1000);
});

test('post-auth ping/pong keeps the connection alive across intervals', async () => {
  const sock = await connect(wsUrl);
  sock.send(JSON.stringify({ type: 'auth', token: config.SIRI_WS_TOKEN, version: 1 }));
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
  const authSock = await connect(wsUrl);
  authSock.send(JSON.stringify({ type: 'auth', token: config.SIRI_WS_TOKEN, version: 1 }));
  await nextMessage(authSock); // auth.ok

  const anonSock = await connect(wsUrl); // connected but never authenticates

  const sent = server.broadcast({ type: 'play.req', reqId: 'b1', query: '七里香' });
  assert.equal(sent, 1, 'only the authenticated client receives');

  const received = await nextMessage(authSock);
  assert.deepEqual(received, { type: 'play.req', reqId: 'b1', query: '七里香' });

  anonSock.close();
  authSock.close();
  await waitFor(() => server.activeClients === 0, 1000);
});

test('sendPlayRequest targets the most recently authenticated client only', async () => {
  const a = await connect(wsUrl);
  a.send(JSON.stringify({ type: 'auth', token: config.SIRI_WS_TOKEN, version: 1 }));
  await nextMessage(a); // auth.ok
  await sleep(30); // ensure distinct lastAuthedAt
  const b = await connect(wsUrl);
  b.send(JSON.stringify({ type: 'auth', token: config.SIRI_WS_TOKEN, version: 1 }));
  await nextMessage(b); // auth.ok

  const playReqs = [];
  const track = (sock, who) =>
    sock.on('message', (data) => {
      const m = JSON.parse(data.toString());
      if (m && m.type === 'play.req') playReqs.push(who);
    });
  track(a, 'a');
  track(b, 'b');

  const sent = server.sendPlayRequest({ type: 'play.req', reqId: 't1', query: '七里香' });
  assert.equal(sent, 1, 'only one client is targeted');

  await waitFor(() => playReqs.length === 1);
  assert.deepEqual(playReqs, ['b'], 'most recently authenticated client is the target');

  a.close();
  b.close();
  await waitFor(() => server.activeClients === 0, 1000);
});

test('play.ack from client invokes onAck handler', async () => {
  acks.length = 0;
  const sock = await connect(wsUrl);
  sock.send(JSON.stringify({ type: 'auth', token: config.SIRI_WS_TOKEN, version: 1 }));
  await nextMessage(sock); // auth.ok

  sock.send(
    JSON.stringify({ type: 'play.ack', reqId: 'a1', ok: true, song: { hash: 'H1', name: '七里香' } })
  );
  await waitFor(() => acks.length === 1);
  assert.equal(acks[0].reqId, 'a1');
  assert.equal(acks[0].ok, true);
  assert.equal(acks[0].song.hash, 'H1');

  sock.send(JSON.stringify({ type: 'play.ack', reqId: '', ok: false, error: 'SEARCH_FAILED' }));
  await sleep(40);
  assert.equal(acks.length, 1, 'ack without reqId is ignored');

  sock.close();
  await waitFor(() => server.activeClients === 0, 1000);
});

/* ===================================================================== *
 *  Phase 5.6: session.reauth.req / res (paired iPad password recovery)
 * ===================================================================== */

const sessionAuthLogins = [];
const reauthServer = createControlServer({
  authTimeoutMs: 300,
  heartbeatIntervalMs: 60000,
  pongTimeoutMs: 60000,
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

const PAIR_COOKIE_VALUE = derivePairValue(config.SIRI_HTTP_TOKEN);

let reauthWsUrl;
before(async () => {
  await new Promise((resolve) => reauthServer.httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = reauthServer.httpServer.address();
  reauthWsUrl = `ws://127.0.0.1:${port}${config.WS_PATH}`;
});

after(() => reauthServer.close());

function connectWithCookie(url, cookieHeader) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(url, { origin: ALLOWED_ORIGIN, headers: { Cookie: cookieHeader } });
    sock.once('open', () => resolve(sock));
    sock.once('error', (err) => reject(err));
  });
}

const reauthDevice = { dfid: 'df', mid: 'm', guid: 'g', serverDev: 'sd', mac: 'ma' };

async function authedWithCookie(url, cookieHeader) {
  const sock = await connectWithCookie(url, cookieHeader);
  sock.send(JSON.stringify({ type: 'auth', token: config.SIRI_WS_TOKEN, version: 1 }));
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
  const sock = await authedWithCookie(reauthWsUrl, `${PAIR_COOKIE}=forged`);
  sock.send(JSON.stringify({ type: 'session.reauth.req', reqId: 'r2', device: reauthDevice }));
  const res = await nextMessage(sock);
  assert.equal(res.type, 'session.reauth.res');
  assert.equal(res.error, 'PAIR_REQUIRED');
  sock.close();
});

test('reauth: unauthenticated connection ignores the reauth request', async () => {
  const sock = await connectWithCookie(reauthWsUrl, `${PAIR_COOKIE}=${PAIR_COOKIE_VALUE}`);
  sock.send(JSON.stringify({ type: 'session.reauth.req', reqId: 'r3', device: reauthDevice }));
  await sleep(80);
  assert.equal(sock.readyState, WebSocket.OPEN, 'still open (waiting for auth)');
  sock.close();
});

test('reauth: paired + authenticated -> fresh session returned only to that socket', async () => {
  const sock = await authedWithCookie(reauthWsUrl, `${PAIR_COOKIE}=${PAIR_COOKIE_VALUE}`);
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
  const a = await authedWithCookie(reauthWsUrl, `${PAIR_COOKIE}=${PAIR_COOKIE_VALUE}`);
  const b = await authedWithCookie(reauthWsUrl, `${PAIR_COOKIE}=${PAIR_COOKIE_VALUE}`);
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
  const failingServer = createControlServer({
    authTimeoutMs: 300,
    heartbeatIntervalMs: 60000,
    pongTimeoutMs: 60000,
    sessionAuth: {
      login: async () => ({ ok: false, code: 'RISK_REQUIRED', detail: 'captcha' })
    }
  });
  await new Promise((resolve) => failingServer.httpServer.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${failingServer.httpServer.address().port}${config.WS_PATH}`;
  const sock = await authedWithCookie(url, `${PAIR_COOKIE}=${PAIR_COOKIE_VALUE}`);
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
  const noAuthServer = createControlServer({
    authTimeoutMs: 300,
    heartbeatIntervalMs: 60000,
    pongTimeoutMs: 60000
  });
  await new Promise((resolve) => noAuthServer.httpServer.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${noAuthServer.httpServer.address().port}${config.WS_PATH}`;
  const sock = await authedWithCookie(url, `${PAIR_COOKIE}=${PAIR_COOKIE_VALUE}`);
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