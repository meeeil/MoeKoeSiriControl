import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { WebSocket } from 'ws';
import { createControlServer } from '../server/control-server.js';
import { createPendingCoordinator } from '../server/pending.js';
import { createOfflineCommand } from '../server/offline-command.js';
import { createHttpApi } from '../server/http-api.js';
import config from '../server/config.js';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn, timeoutMs = 2000, intervalMs = 10) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(intervalMs);
  }
  return fn();
}

const pending = createPendingCoordinator({ ttlMs: 60000, waitMs: 300 });
const offlineCommand = createOfflineCommand({ log: () => {} });

const server = createControlServer({
  authTimeoutMs: 500,
  heartbeatIntervalMs: 60000,
  pongTimeoutMs: 60000,
  handlers: {
    onAck: (ack) => {
      if (offlineCommand.handleAck(ack)) return;
      pending.handleAck(ack);
    },
    onAuthenticated: (conn) => {
      offlineCommand.dispatch({
        id: conn.id,
        send: (obj) => server.sendTo(conn.id, obj)
      });
    },
    onDisconnected: (conn) => {
      offlineCommand.handleDisconnect(conn.id);
    }
  }
});

server.app.use(
  createHttpApi({
    broadcast: server.broadcast,
    sendPlayRequest: server.sendPlayRequest,
    authenticatedClients: () => server.authenticatedClients,
    activeClients: () => server.activeClients,
    pending,
    offlineCommand
  })
);

let baseUrl;
let wsUrl;
before(async () => {
  await new Promise((resolve) => server.httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = server.httpServer.address();
  baseUrl = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}${config.WS_PATH}`;
});

after(() => server.close());

function connectAuthed() {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(wsUrl, { origin: 'http://127.0.0.1:8080' });
    const buffer = [];
    let phase = 'auth';
    sock.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (phase === 'auth') {
        if (msg.type === 'auth.ok') {
          phase = 'ready';
          resolve({ sock, buffer });
        } else if (msg.type === 'auth.error') {
          phase = 'failed';
          reject(new Error('auth.error ' + (msg.reason || '')));
        } else {
          buffer.push(msg);
        }
      } else {
        buffer.push(msg);
      }
    });
    sock.once('open', () => {
      sock.send(JSON.stringify({ type: 'auth', token: config.SIRI_WS_TOKEN, version: 1 }));
    });
    sock.once('error', reject);
  });
}

async function nextMessage(sock, buffer, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (buffer.length > 0) return buffer.shift();
    await sleep(10);
  }
  throw new Error('timed out waiting for next message');
}

async function postPlay(body, { token = config.SIRI_HTTP_TOKEN, header = true } = {}) {
  const headers = {};
  if (header) headers['x-siri-token'] = token;
  const url = header ? `${baseUrl}/api/siri/play` : `${baseUrl}/api/siri/play?token=${encodeURIComponent(token)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function getCommand(reqId, { token = config.SIRI_HTTP_TOKEN } = {}) {
  const res = await fetch(`${baseUrl}/api/siri/commands/${reqId}`, {
    headers: { 'x-siri-token': token }
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

test('play without token -> 401 UNAUTHORIZED', async () => {
  const { status, json } = await postPlay({ query: '七里香' }, { token: '', header: false });
  assert.equal(status, 401);
  assert.equal(json.error, 'UNAUTHORIZED');
});

test('play with wrong token -> 401 UNAUTHORIZED', async () => {
  const { status, json } = await postPlay({ query: '七里香' }, { token: 'wrong-token-aaaaaaaaaaaa' });
  assert.equal(status, 401);
  assert.equal(json.error, 'UNAUTHORIZED');
});

test('play with missing query -> 400 BAD_REQUEST', async () => {
  const { status, json } = await postPlay({});
  assert.equal(status, 400);
  assert.equal(json.error, 'BAD_REQUEST');
});

test('play without connected client -> 202 queued', async () => {
  const { status, json } = await postPlay({ query: '七里香' });
  assert.equal(status, 202);
  assert.equal(json.ok, true);
  assert.equal(json.status, 'queued');
  assert.equal(typeof json.reqId, 'string');
  assert.equal(typeof json.expiresIn, 'number');
  assert.ok(json.expiresIn > 0);
  offlineCommand.handleAck({ reqId: json.reqId, ok: true });
});

test('play via token query param works too (202 queued)', async () => {
  const { status, json } = await postPlay({ query: '七里香' }, { header: false });
  assert.equal(status, 202);
  assert.equal(json.status, 'queued');
  offlineCommand.handleAck({ reqId: json.reqId, ok: true });
});

test('full loop: POST /api/siri/play -> play.req -> play.ack -> 200 ok with song', async () => {
  const { sock, buffer } = await connectAuthed();
  try {
    const req = postPlay({ query: '七里香' });
    const msg = await nextMessage(sock, buffer);
    assert.equal(msg.type, 'play.req');
    assert.equal(msg.query, '七里香');
    assert.equal(typeof msg.expiresAt, 'number');
    assert.ok(msg.expiresAt > Date.now());

    sock.send(JSON.stringify({ type: 'play.ack', reqId: msg.reqId, ok: true, song: { hash: 'H1', name: '七里香' } }));
    const { status, json } = await req;
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.reqId, msg.reqId);
    assert.equal(json.song.hash, 'H1');
  } finally {
    sock.close();
    await waitFor(() => server.activeClients === 0);
  }
});

test('client command error passes through: NO_RESULTS -> 200 ok:false', async () => {
  const { sock, buffer } = await connectAuthed();
  try {
    const req = postPlay({ query: 'zzzz' });
    const msg = await nextMessage(sock, buffer);
    assert.equal(msg.type, 'play.req');
    sock.send(JSON.stringify({ type: 'play.ack', reqId: msg.reqId, ok: false, error: 'NO_RESULTS' }));
    const { status, json } = await req;
    assert.equal(status, 200);
    assert.equal(json.ok, false);
    assert.equal(json.error, 'NO_RESULTS');
  } finally {
    sock.close();
    await waitFor(() => server.activeClients === 0);
  }
});

test('no ack within wait window -> 504 TIMEOUT', async () => {
  const { sock } = await connectAuthed();
  try {
    const { status, json } = await postPlay({ query: 'silent' });
    assert.equal(status, 504);
    assert.equal(json.error, 'TIMEOUT');
    assert.equal(typeof json.reqId, 'string');
  } finally {
    sock.close();
    await waitFor(() => server.activeClients === 0);
  }
});

test('queued command is dispatched on the next WS auth and tracked via status API', async () => {
  const { json: queued } = await postPlay({ query: '后台歌曲' });
  assert.equal(queued.status, 'queued');
  const reqId = queued.reqId;

  const { status: st1, json: snap1 } = await getCommand(reqId);
  assert.equal(st1, 200);
  assert.equal(snap1.status, 'queued');

  const { sock, buffer } = await connectAuthed();
  try {
    const msg = await nextMessage(sock, buffer);
    assert.equal(msg.type, 'play.req');
    assert.equal(msg.reqId, reqId);
    assert.equal(msg.query, '后台歌曲');

    const { status: st2, json: snap2 } = await getCommand(reqId);
    assert.equal(st2, 200);
    assert.equal(snap2.status, 'dispatched');

    sock.send(JSON.stringify({ type: 'play.ack', reqId, ok: true, song: { hash: 'H2', name: '后台歌曲' } }));
    const { status: st3, json: snap3 } = await getCommand(reqId);
    assert.equal(st3, 200);
    assert.equal(snap3.status, 'succeeded');
    assert.equal(snap3.song.name, '后台歌曲');
  } finally {
    sock.close();
    await waitFor(() => server.activeClients === 0);
  }
});

test('queued command acked failed -> status failed with error', async () => {
  const { json: queued } = await postPlay({ query: '失败歌曲' });
  const reqId = queued.reqId;

  const { sock, buffer } = await connectAuthed();
  try {
    const msg = await nextMessage(sock, buffer);
    assert.equal(msg.type, 'play.req');
    sock.send(JSON.stringify({ type: 'play.ack', reqId, ok: false, error: 'PLAYER_NOT_READY' }));
    const { status, json } = await getCommand(reqId);
    assert.equal(status, 200);
    assert.equal(json.status, 'failed');
    assert.equal(json.error, 'PLAYER_NOT_READY');
  } finally {
    sock.close();
    await waitFor(() => server.activeClients === 0);
  }
});

test('status API rejects missing/wrong token -> 401', async () => {
  const noAuth = await fetch(`${baseUrl}/api/siri/commands/whatever`);
  assert.equal(noAuth.status, 401);
  const bad = await getCommand('whatever', { token: 'bad-token-aaaaaaaaaaaa' });
  assert.equal(bad.status, 401);
});

test('status API returns 404 for unknown reqId', async () => {
  const { status, json } = await getCommand('unknown-reqid-12345');
  assert.equal(status, 404);
  assert.equal(json.error, 'COMMAND_NOT_FOUND');
});

test('send race (client vanished after check) -> 202 queued instead of NO_CLIENT', async () => {
  const racePending = createPendingCoordinator({ ttlMs: 60000, waitMs: 300 });
  const raceOffline = createOfflineCommand({ log: () => {} });
  const app = express();
  app.use(
    createHttpApi({
      broadcast: () => 0,
      sendPlayRequest: () => 0,
      authenticatedClients: () => 1,
      activeClients: () => 0,
      pending: racePending,
      offlineCommand: raceOffline,
      log: () => {}
    })
  );
  const httpServer = http.createServer(app);
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/siri/play`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-siri-token': config.SIRI_HTTP_TOKEN },
      body: JSON.stringify({ query: '竞态歌曲' })
    });
    assert.equal(res.status, 202);
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.equal(json.status, 'queued');
    assert.equal(typeof json.reqId, 'string');
    assert.equal(raceOffline.state, 'queued');
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test('debug/status requires token and reports clients + pending + offline', async () => {
  const noAuth = await fetch(`${baseUrl}/debug/status`);
  assert.equal(noAuth.status, 401);

  const res = await fetch(`${baseUrl}/debug/status`, {
    headers: { 'x-siri-token': config.SIRI_HTTP_TOKEN }
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.protocol, config.PROTOCOL_VERSION);
  assert.equal(typeof body.authenticatedClients, 'number');
  assert.equal(typeof body.pending.count, 'number');
  assert.equal(typeof body.offline.state, 'string');
  assert.equal(typeof body.offline.terminalCount, 'number');
});