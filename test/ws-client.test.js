import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket, WebSocketServer } from 'ws';
import control from '../client/siri-control.cjs';

const { createWsClient } = control;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn, timeoutMs = 3000, intervalMs = 10) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(intervalMs);
  }
  return fn();
}

function startMock({ rejectAuth = false } = {}) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const state = { connections: 0, auths: 0, pongs: [] };
  wss.on('connection', (socket) => {
    state.connections += 1;
    socket.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'auth') {
        state.auths += 1;
        if (rejectAuth) {
          socket.send(JSON.stringify({ type: 'auth.error', reason: 'invalid_token' }));
        } else {
          socket.send(JSON.stringify({ type: 'auth.ok', version: 1 }));
        }
      } else if (msg.type === 'pong') {
        state.pongs.push(msg.t);
      }
    });
  });
  return new Promise((resolve) => {
    wss.once('listening', () => {
      resolve({
        url: `ws://127.0.0.1:${wss.address().port}`,
        wss,
        state,
        sendAll(obj) {
          const text = JSON.stringify(obj);
          for (const c of wss.clients) c.send(text);
        },
        closeAll() {
          for (const c of wss.clients) c.close();
        }
      });
    });
  });
}

const mocks = [];
after(async () => {
  for (const m of mocks) await new Promise((r) => m.wss.close(r));
});

test('authenticates, then answers server ping with a pong', async () => {
  const mock = await startMock();
  mocks.push(mock);

  const client = createWsClient({
    WebSocketCtor: WebSocket,
    url: mock.url,
    token: 'secret-token',
    authTimeoutMs: 800,
    serverTimeoutMs: 500,
    reconnectBaseMs: 25,
    reconnectMaxMs: 120,
    log: () => {}
  });
  client.start();

  try {
    assert.ok(await waitFor(() => client.state.authenticated), 'should authenticate');
    assert.ok(client.state.connected);
    assert.equal(client.state.phase, 'ready');
    assert.equal(mock.state.auths, 1);

    const t = 12345;
    mock.sendAll({ type: 'ping', t });
    assert.ok(await waitFor(() => mock.state.pongs.includes(t)), 'client should answer ping with pong');
    assert.ok(client.state.lastMessageAt != null);
  } finally {
    client.stop();
  }
});

test('auth rejection is permanent (no reconnect loop)', async () => {
  const mock = await startMock({ rejectAuth: true });
  mocks.push(mock);

  const client = createWsClient({
    WebSocketCtor: WebSocket,
    url: mock.url,
    token: 'wrong-token',
    authTimeoutMs: 800,
    serverTimeoutMs: 500,
    reconnectBaseMs: 25,
    reconnectMaxMs: 120,
    log: () => {}
  });
  client.start();

  try {
    assert.ok(await waitFor(() => client.state.phase === 'auth_rejected'));
    assert.equal(client.state.authenticated, false);
    assert.equal(client.state.error, 'invalid_token');
    await sleep(150);
    assert.equal(client.state.reconnectCount, 0, 'must not reconnect after auth rejection');
    assert.equal(mock.state.connections, 1);
  } finally {
    client.stop();
  }
});

test('reconnects with backoff when the server closes the connection', async () => {
  const mock = await startMock();
  mocks.push(mock);

  const client = createWsClient({
    WebSocketCtor: WebSocket,
    url: mock.url,
    token: 'secret-token',
    authTimeoutMs: 800,
    serverTimeoutMs: 1000,
    reconnectBaseMs: 20,
    reconnectMaxMs: 100,
    log: () => {}
  });
  client.start();

  try {
    assert.ok(await waitFor(() => client.state.authenticated));
    mock.closeAll();
    assert.ok(
      await waitFor(() => client.state.authenticated && client.state.reconnectCount >= 1),
      'should reconnect and re-authenticate'
    );
    assert.ok(mock.state.connections >= 2, 'server should see a second connection');
  } finally {
    client.stop();
  }
});

test('reconnects when the server goes silent (liveness timeout)', async () => {
  const mock = await startMock();
  mocks.push(mock);

  const client = createWsClient({
    WebSocketCtor: WebSocket,
    url: mock.url,
    token: 'secret-token',
    authTimeoutMs: 800,
    serverTimeoutMs: 150,
    reconnectBaseMs: 20,
    reconnectMaxMs: 100,
    log: () => {}
  });
  client.start();

  try {
    assert.ok(await waitFor(() => client.state.authenticated));
    const reconnects = await waitFor(() => client.state.reconnectCount >= 1, 4000);
    assert.ok(reconnects, 'client should detect silence and reconnect');
    assert.ok(
      await waitFor(() => mock.state.connections >= 2, 4000),
      'server should see a second connection'
    );
  } finally {
    client.stop();
  }
});