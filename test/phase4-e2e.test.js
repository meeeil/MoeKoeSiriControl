import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { readFileSync } from 'node:fs';
import { createControlServer } from '../server/control-server.js';
import { createControllerStore } from '../server/controller-store.js';
import { makePairCookieValue, PAIR_COOKIE } from '../server/pairing.js';
import config from '../server/config.js';
import control from '../client/siri-control.cjs';

const { createWsClient, createCommandHandler } = control;

const CONTROLLER_DEVICE_ID = 'controller-device-1';
const controllerStore = createControllerStore({ filePath: null });
controllerStore.set(CONTROLLER_DEVICE_ID);
const CONTROLLER_COOKIE = `${PAIR_COOKIE}=${makePairCookieValue(
  config.SIRI_HTTP_TOKEN,
  CONTROLLER_DEVICE_ID
)}`;

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
  controllerStore,
  handlers: { onAck: (ack) => acks.push(ack) }
});

let wsUrl;
before(async () => {
  await new Promise((resolve) => server.httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = server.httpServer.address();
  wsUrl = `ws://127.0.0.1:${port}${config.WS_PATH}`;
});

after(() => server.close());

function startControllerClient({ search, player }) {
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
    version: config.PROTOCOL_VERSION,
    headers: { Cookie: CONTROLLER_COOKIE },
    onMessage: (msg) => handler.handleMessage(msg),
    log: () => {}
  });
  client.start();
  return { client, handler };
}

test('full loop: broadcast play.req -> controller search+play -> play.ack on server', async () => {
  acks.length = 0;
  const calls = [];
  let playing = false;
  let currentSong = null;
  const { client } = startControllerClient({
    search: async () => ({ ok: true, payload: successPayload }),
    player: {
      get playing() {
        return playing;
      },
      get currentSong() {
        return currentSong;
      },
      addSongToQueue: async (hash, name, img, author) => {
        calls.push({ hash, name, img, author });
        currentSong = { hash, name, img, author };
        playing = true;
        return { song: { hash } };
      }
    }
  });
  try {
    await waitFor(() => client.state.authenticated === true);

    const sent = server.sendPlayRequest({ type: 'play.req', reqId: 'e2e-1', query: '七里香' });
    assert.equal(sent.sent, true);
    assert.ok(server.isControllerConnection(sent.connectionId));

    await waitFor(() => acks.length === 1, 3000);
    assert.equal(acks[0].reqId, 'e2e-1');
    assert.equal(acks[0].ok, true);
    assert.equal(acks[0].song.hash, 'D4B1F7A1A1B1C1D1E1F1A2B2C2D2E2F2A');
    assert.equal(calls.length, 1);
  } finally {
    client.stop();
    await waitFor(() => server.activeClients === 0, 1000);
  }
});

test('full loop error path: no results -> play.ack with NO_RESULTS', async () => {
  acks.length = 0;
  const { client } = startControllerClient({
    search: async () => ({ ok: true, payload: { status: 1, data: { lists: [] } } }),
    player: {
      get playing() {
        return false;
      },
      get currentSong() {
        return null;
      },
      addSongToQueue: async () => ({ song: { hash: 'x' } })
    }
  });
  try {
    await waitFor(() => client.state.authenticated === true);

    const sent = server.sendPlayRequest({ type: 'play.req', reqId: 'e2e-2', query: 'zzzz' });
    assert.equal(sent.sent, true);
    await waitFor(() => acks.length === 1, 3000);
    assert.equal(acks[0].reqId, 'e2e-2');
    assert.equal(acks[0].ok, false);
    assert.equal(acks[0].error, 'NO_RESULTS');
  } finally {
    client.stop();
    await waitFor(() => server.activeClients === 0, 1000);
  }
});