import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { readFileSync } from 'node:fs';
import { createControlServer } from '../server/control-server.js';
import config from '../server/config.js';
import control from '../client/siri-control.cjs';

const { createWsClient, createCommandHandler, PROTOCOL_VERSION } = control;

const successPayload = JSON.parse(
  readFileSync(new URL('./fixtures/search-complex.success.json', import.meta.url), 'utf8')
);

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

const acks = [];
const server = createControlServer({
  authTimeoutMs: 500,
  heartbeatIntervalMs: 60,
  pongTimeoutMs: 40,
  handlers: { onAck: (ack) => acks.push(ack) }
});

let wsUrl;
before(async () => {
  await new Promise((resolve) => server.httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = server.httpServer.address();
  wsUrl = `ws://127.0.0.1:${port}${config.WS_PATH}`;
});

after(() => server.close());

function startClient({ search, player }) {
  const handler = createCommandHandler({
    search,
    getPlayer: async () => player,
    send: (obj) => client.send(obj),
    log: () => {}
  });
  const client = createWsClient({
    WebSocketCtor: WebSocket,
    url: wsUrl,
    token: config.SIRI_WS_TOKEN,
    version: PROTOCOL_VERSION,
    onMessage: (msg) => handler.handleMessage(msg),
    log: () => {}
  });
  client.start();
  return { client, handler };
}

test('full loop: broadcast play.req -> client search+play -> play.ack on server', async () => {
  acks.length = 0;
  const calls = [];
  const { client } = startClient({
    search: async () => ({ ok: true, payload: successPayload }),
    player: {
      addSongToQueue: async (hash, name, img, author) => {
        calls.push({ hash, name, img, author });
        return { song: { hash } };
      }
    }
  });
  await waitFor(() => client.state.authenticated === true);

  const sent = server.broadcast({ type: 'play.req', reqId: 'e2e-1', query: '七里香' });
  assert.equal(sent, 1);

  await waitFor(() => acks.length === 1, 3000);
  assert.equal(acks[0].reqId, 'e2e-1');
  assert.equal(acks[0].ok, true);
  assert.equal(acks[0].song.hash, 'D4B1F7A1A1B1C1D1E1F1A2B2C2D2E2F2A');
  assert.equal(calls.length, 1);

  client.stop();
  await waitFor(() => server.activeClients === 0, 1000);
});

test('full loop error path: no results -> play.ack with NO_RESULTS', async () => {
  acks.length = 0;
  const { client } = startClient({
    search: async () => ({ ok: true, payload: { status: 1, data: { lists: [] } } }),
    player: { addSongToQueue: async () => ({ song: { hash: 'x' } }) }
  });
  await waitFor(() => client.state.authenticated === true);

  server.broadcast({ type: 'play.req', reqId: 'e2e-2', query: 'zzzz' });
  await waitFor(() => acks.length === 1, 3000);
  assert.equal(acks[0].reqId, 'e2e-2');
  assert.equal(acks[0].ok, false);
  assert.equal(acks[0].error, 'NO_RESULTS');

  client.stop();
  await waitFor(() => server.activeClients === 0, 1000);
});