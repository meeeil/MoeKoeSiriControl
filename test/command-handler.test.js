import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import control from '../client/siri-control.cjs';

const { createCommandHandler, buildAuthHeaders, buildSearchRequest } = control;

const successPayload = JSON.parse(
  readFileSync(new URL('./fixtures/search-complex.success.json', import.meta.url), 'utf8')
);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn, timeoutMs = 3000, intervalMs = 5) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(intervalMs);
  }
  return fn();
}

function makeHandler(overrides = {}) {
  const sent = [];
  const handler = createCommandHandler({
    search: overrides.search,
    refresh: overrides.refresh,
    getPlayer: overrides.getPlayer,
    send: (obj) => sent.push(obj),
    getNow: overrides.getNow,
    log: () => {}
  });
  return { handler, sent };
}

function successSearch() {
  return async () => ({ ok: true, payload: successPayload });
}

function fakePlayer(result = { song: { hash: 'H1' } }) {
  const calls = [];
  return {
    calls,
    addSongToQueue: async (hash, name, img, author) => {
      calls.push({ hash, name, img, author });
      return result;
    }
  };
}

const SONG_IMG =
  'http://singerimg.kugou.com/uploadpic/softhead/400/480/20190110-0/webpic3_0_1104061145188714537_640.jpg';

test('play.req success sends play.ack ok with extracted song', async () => {
  const player = fakePlayer();
  const { handler, sent } = makeHandler({
    search: successSearch(),
    getPlayer: async () => player
  });
  handler.handleMessage({ type: 'play.req', reqId: 'r1', query: '七里香' });
  await waitFor(() => sent.length > 0);
  const ack = sent[0];
  assert.equal(ack.type, 'play.ack');
  assert.equal(ack.reqId, 'r1');
  assert.equal(ack.ok, true);
  assert.equal(ack.song.hash, 'D4B1F7A1A1B1C1D1E1F1A2B2C2D2E2F2A');
  assert.equal(ack.song.name, '七里香');
  assert.equal(ack.song.author, '周杰伦');
  assert.equal(player.calls.length, 1);
  assert.deepEqual(player.calls[0], {
    hash: 'D4B1F7A1A1B1C1D1E1F1A2B2C2D2E2F2A',
    name: '七里香',
    img: SONG_IMG,
    author: '周杰伦'
  });
  assert.deepEqual(handler.state.lastSong, {
    hash: 'D4B1F7A1A1B1C1D1E1F1A2B2C2D2E2F2A',
    name: '七里香',
    img: SONG_IMG,
    author: '周杰伦'
  });
});

test('expired play.req acks COMMAND_EXPIRED without searching', async () => {
  let searched = false;
  const { handler, sent } = makeHandler({
    search: async () => {
      searched = true;
      return { ok: true, payload: successPayload };
    },
    getPlayer: async () => fakePlayer(),
    getNow: () => 5000
  });
  handler.handleMessage({ type: 'play.req', reqId: 'r2', query: '七里香', expiresAt: 4000 });
  await waitFor(() => sent.length > 0);
  assert.deepEqual(sent[0], { type: 'play.ack', reqId: 'r2', ok: false, error: 'COMMAND_EXPIRED' });
  assert.equal(searched, false);
  assert.equal(handler.state.lastError, 'COMMAND_EXPIRED');
});

test('search failure acks SEARCH_FAILED', async () => {
  const { handler, sent } = makeHandler({
    search: async () => ({ ok: false, code: 'SEARCH_FAILED' })
  });
  handler.handleMessage({ type: 'play.req', reqId: 'r3', query: 'xx' });
  await waitFor(() => sent.length > 0);
  assert.equal(sent[0].ok, false);
  assert.equal(sent[0].error, 'SEARCH_FAILED');
});

test('search failure includes sanitized detail in ack', async () => {
  const { handler, sent } = makeHandler({
    search: async () => ({ ok: false, code: 'SEARCH_FAILED', detail: 'http=200 error_code=152 status=1' })
  });
  handler.handleMessage({ type: 'play.req', reqId: 'r9', query: '稻香' });
  await waitFor(() => sent.length > 0);
  assert.equal(sent[0].ok, false);
  assert.equal(sent[0].error, 'SEARCH_FAILED');
  assert.equal(sent[0].detail, 'http=200 error_code=152 status=1');
});

test('SESSION_EXPIRED triggers one refresh then search retry succeeds', async () => {
  let calls = 0;
  let refreshed = 0;
  const { handler, sent } = makeHandler({
    search: async () => {
      calls += 1;
      if (calls === 1) return { ok: false, code: 'SESSION_EXPIRED', detail: 'http=200 error_code=152 status=1' };
      return { ok: true, payload: successPayload };
    },
    refresh: async () => {
      refreshed += 1;
      return { ok: true };
    },
    getPlayer: async () => fakePlayer()
  });
  handler.handleMessage({ type: 'play.req', reqId: 'r10', query: '七里香' });
  await waitFor(() => sent.length > 0);
  assert.equal(refreshed, 1);
  assert.equal(calls, 2);
  assert.equal(sent[0].ok, true);
  assert.equal(sent[0].song.hash, 'D4B1F7A1A1B1C1D1E1F1A2B2C2D2E2F2A');
});

test('SESSION_EXPIRED refresh+retry both failing acks SESSION_EXPIRED', async () => {
  let refreshed = 0;
  const { handler, sent } = makeHandler({
    search: async () => ({ ok: false, code: 'SESSION_EXPIRED', detail: 'http=200 error_code=152 status=1' }),
    refresh: async () => {
      refreshed += 1;
      return { ok: false, code: 'SESSION_EXPIRED' };
    }
  });
  handler.handleMessage({ type: 'play.req', reqId: 'r11', query: '稻香' });
  await waitFor(() => sent.length > 0);
  assert.equal(refreshed, 1);
  assert.equal(sent[0].ok, false);
  assert.equal(sent[0].error, 'SESSION_EXPIRED');
  assert.equal(handler.state.lastError, 'SESSION_EXPIRED');
});

test('non-SESSION_EXPIRED failure does not trigger refresh', async () => {
  let refreshed = 0;
  const { handler, sent } = makeHandler({
    search: async () => ({ ok: false, code: 'SEARCH_FAILED' }),
    refresh: async () => {
      refreshed += 1;
      return { ok: true };
    }
  });
  handler.handleMessage({ type: 'play.req', reqId: 'r12', query: 'xx' });
  await waitFor(() => sent.length > 0);
  assert.equal(refreshed, 0);
  assert.equal(sent[0].error, 'SEARCH_FAILED');
});

test('empty search result acks NO_RESULTS', async () => {
  const { handler, sent } = makeHandler({
    search: async () => ({ ok: true, payload: { status: 1, data: { lists: [] } } })
  });
  handler.handleMessage({ type: 'play.req', reqId: 'r4', query: 'zzz' });
  await waitFor(() => sent.length > 0);
  assert.equal(sent[0].ok, false);
  assert.equal(sent[0].error, 'NO_RESULTS');
});

test('song without hash acks NO_HASH', async () => {
  const payload = {
    status: 1,
    data: {
      lists: [
        {
          type: 'song',
          lists: [{ FileName: '无hash - 歌手', FileHash: '', SongName: '无hash', SingerName: '歌手' }]
        }
      ]
    }
  };
  const { handler, sent } = makeHandler({ search: async () => ({ ok: true, payload }) });
  handler.handleMessage({ type: 'play.req', reqId: 'r5', query: 'x' });
  await waitFor(() => sent.length > 0);
  assert.equal(sent[0].ok, false);
  assert.equal(sent[0].error, 'NO_HASH');
});

test('player not ready acks PLAYER_NOT_READY', async () => {
  const { handler, sent } = makeHandler({
    search: successSearch(),
    getPlayer: async () => null
  });
  handler.handleMessage({ type: 'play.req', reqId: 'r6', query: '七里香' });
  await waitFor(() => sent.length > 0);
  assert.equal(sent[0].ok, false);
  assert.equal(sent[0].error, 'PLAYER_NOT_READY');
});

test('addSongToQueue rejection acks PLAY_FAILED', async () => {
  const { handler, sent } = makeHandler({
    search: successSearch(),
    getPlayer: async () => ({
      addSongToQueue: async () => {
        throw new Error('boom');
      }
    })
  });
  handler.handleMessage({ type: 'play.req', reqId: 'r7', query: '七里香' });
  await waitFor(() => sent.length > 0);
  assert.equal(sent[0].ok, false);
  assert.equal(sent[0].error, 'PLAY_FAILED');
});

test('shouldPlayNext result acks AUTOPLAY_BLOCKED', async () => {
  const { handler, sent } = makeHandler({
    search: successSearch(),
    getPlayer: async () => fakePlayer({ shouldPlayNext: true })
  });
  handler.handleMessage({ type: 'play.req', reqId: 'r8', query: '七里香' });
  await waitFor(() => sent.length > 0);
  assert.equal(sent[0].ok, false);
  assert.equal(sent[0].error, 'AUTOPLAY_BLOCKED');
});

test('second play.req while busy acks BUSY (single-flight)', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const { handler, sent } = makeHandler({
    search: async () => {
      await gate;
      return { ok: true, payload: successPayload };
    },
    getPlayer: async () => fakePlayer()
  });
  handler.handleMessage({ type: 'play.req', reqId: 'first', query: '七里香' });
  await sleep(20);
  handler.handleMessage({ type: 'play.req', reqId: 'second', query: '稻香' });
  await waitFor(() => sent.length === 1);
  assert.equal(sent[0].reqId, 'second');
  assert.equal(sent[0].ok, false);
  assert.equal(sent[0].error, 'BUSY');
  release();
  await waitFor(() => sent.length === 2);
  assert.equal(sent[1].reqId, 'first');
  assert.equal(sent[1].ok, true);
});

test('malformed play.req is ignored', async () => {
  let searched = false;
  const { handler, sent } = makeHandler({
    search: async () => {
      searched = true;
      return { ok: true, payload: successPayload };
    }
  });
  handler.handleMessage({ type: 'play.req' });
  handler.handleMessage({ type: 'play.req', reqId: '', query: '  ' });
  handler.handleMessage({ type: 'other', foo: 1 });
  await sleep(20);
  assert.equal(searched, false);
  assert.equal(sent.length, 0);
});

test('play() public method returns the ack result', async () => {
  const player = fakePlayer();
  const { handler } = makeHandler({
    search: successSearch(),
    getPlayer: async () => player
  });
  const ack = await handler.play('七里香');
  assert.equal(ack.ok, true);
  assert.ok(ack.reqId.startsWith('local-'));
  assert.equal(player.calls.length, 1);
});

test('buildAuthHeaders reads MoeData from storage', () => {
  const storage = {
    getItem: () =>
      JSON.stringify({
        UserInfo: { token: 'tok', userid: '42', t1: 't1v' },
        Device: { dfid: 'df', mid: 'm', guid: 'g', serverDev: 'sd', mac: 'ma' }
      })
  };
  const headers = buildAuthHeaders({ storage });
  assert.deepEqual(headers, {
    Authorization:
      'token=tok;userid=42;t1=t1v;dfid=df;KUGOU_API_MID=m;KUGOU_API_GUID=g;KUGOU_API_DEV=sd;KUGOU_API_MAC=ma'
  });
});

test('buildAuthHeaders tolerates missing/invalid MoeData', () => {
  assert.deepEqual(buildAuthHeaders({ storage: { getItem: () => null } }), {});
  assert.deepEqual(buildAuthHeaders({ storage: { getItem: () => 'not-json' } }), {});
  assert.deepEqual(buildAuthHeaders({ storage: null }), {});
});

test('buildSearchRequest encodes query and sets credentials include', () => {
  const { url, options } = buildSearchRequest('七里香 live', { apiBase: 'http://127.0.0.1:8080/api' });
  assert.equal(url, 'http://127.0.0.1:8080/api/search/complex?keywords=%E4%B8%83%E9%87%8C%E9%A6%99%20live');
  assert.equal(options.method, 'GET');
  assert.equal(options.credentials, 'include');
  assert.equal(options.headers['Content-Type'], 'application/json');
});