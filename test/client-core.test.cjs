'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const client = require('../client/siri-control.cjs');

const fixturesDir = path.join(__dirname, 'fixtures');

function fixture(name) {
  return readFileSync(path.join(fixturesDir, name), 'utf8');
}

const successJson = fixture('search-complex.success.json');
const successPayload = JSON.parse(successJson);
const emptyPayload = JSON.parse(fixture('search-complex.empty.json'));
const invalidPayload = JSON.parse(fixture('search-complex.invalid.json'));
const wrappedErrorText = fixture('search-complex.wrapped-error.txt');

/* --------------------------------------------------------------------- *
 * extractFirstSong
 * --------------------------------------------------------------------- */

test('extractFirstSong: success fixture returns first valid song', () => {
  const result = client.extractFirstSong(successPayload);
  assert.equal(result.ok, true);
  assert.equal(result.song.name, '七里香');
  assert.equal(result.song.author, '周杰伦');
  assert.equal(result.song.hash, 'D4B1F7A1A1B1C1D1E1F1A2B2C2D2E2F2A');
  assert.ok(result.song.img.startsWith('http'));
  assert.ok(!result.song.img.includes('{size}'));
});

test('extractFirstSong: empty song section -> NO_RESULTS', () => {
  assert.deepEqual(client.extractFirstSong(emptyPayload), {
    ok: false,
    code: 'NO_RESULTS'
  });
});

test('extractFirstSong: no data.lists -> INVALID_RESULT', () => {
  assert.deepEqual(client.extractFirstSong(invalidPayload), {
    ok: false,
    code: 'INVALID_RESULT'
  });
});

test('extractFirstSong: null payload -> INVALID_RESULT', () => {
  assert.deepEqual(client.extractFirstSong(null), {
    ok: false,
    code: 'INVALID_RESULT'
  });
});

test('extractFirstSong: no song section -> NO_RESULTS', () => {
  const payload = {
    status: 1,
    error_code: 0,
    data: {
      lists: [
        { type: 'author', lists: [{ AuthorName: 'x' }] },
        { type: 'special', lists: [] }
      ]
    }
  };
  assert.deepEqual(client.extractFirstSong(payload), {
    ok: false,
    code: 'NO_RESULTS'
  });
});

test('extractFirstSong: first item damaged, second valid -> plays second', () => {
  const payload = {
    status: 1,
    error_code: 0,
    data: {
      lists: [
        {
          type: 'song',
          lists: [
            { FileName: 'broken item', SingerName: 'x' },
            { FileHash: 'ABC123', OriSongName: '好歌', SingerName: '歌手' }
          ]
        }
      ]
    }
  };
  const result = client.extractFirstSong(payload);
  assert.equal(result.ok, true);
  assert.equal(result.song.name, '好歌');
  assert.equal(result.song.hash, 'ABC123');
});

test('extractFirstSong: all items hash-less -> NO_HASH', () => {
  const payload = {
    data: {
      lists: [
        {
          type: 'song',
          lists: [
            { OriSongName: '无hash', SingerName: 'a' },
            { OriSongName: '无hash2', SingerName: 'b' }
          ]
        }
      ]
    }
  };
  assert.deepEqual(client.extractFirstSong(payload), {
    ok: false,
    code: 'NO_HASH'
  });
});

test('extractFirstSong: hashes present but no song name -> INVALID_RESULT', () => {
  const payload = {
    data: {
      lists: [
        {
          type: 'song',
          lists: [{ FileHash: 'XYZ', SingerName: 'a', FileName: 'unparsed' }]
        }
      ]
    }
  };
  assert.deepEqual(client.extractFirstSong(payload), {
    ok: false,
    code: 'INVALID_RESULT'
  });
});

test('extractFirstSong: non-object song items -> INVALID_RESULT', () => {
  const payload = {
    data: {
      lists: [{ type: 'song', lists: [null, 'text', 42] }]
    }
  };
  assert.deepEqual(client.extractFirstSong(payload), {
    ok: false,
    code: 'INVALID_RESULT'
  });
});

test('extractFirstSong: missing Image -> ico.png fallback', () => {
  const payload = {
    data: {
      lists: [
        {
          type: 'song',
          lists: [{ FileHash: 'H1', OriSongName: '名', SingerName: '唱' }]
        }
      ]
    }
  };
  const result = client.extractFirstSong(payload);
  assert.equal(result.song.img, './assets/images/ico.png');
});

/* --------------------------------------------------------------------- *
 * stripKgTagWrapper / parseSearchResponse / normalizeSearchResponse
 * --------------------------------------------------------------------- */

test('stripKgTagWrapper: extracts JSON between markers', () => {
  const raw = '<!--KG_TAG_RES_START-->{  "a": 1  }<!--KG_TAG_RES_END-->';
  assert.equal(client.stripKgTagWrapper(raw), '{  "a": 1  }');
});

test('stripKgTagWrapper: no markers -> passthrough', () => {
  assert.equal(client.stripKgTagWrapper('{"a":1}'), '{"a":1}');
});

test('parseSearchResponse: valid JSON parses', () => {
  const result = client.parseSearchResponse(JSON.stringify(successPayload));
  assert.equal(result.ok, true);
  assert.equal(result.payload.status, 1);
});

test('parseSearchResponse: invalid JSON -> SEARCH_FAILED', () => {
  const result = client.parseSearchResponse('not-json{{');
  assert.deepEqual(result, { ok: false, code: 'SEARCH_FAILED' });
});

test('parseSearchResponse: KG_TAG wrapped valid JSON parses', () => {
  const wrapped = `<!--KG_TAG_RES_START-->${successJson}<!--KG_TAG_RES_END-->`;
  const result = client.parseSearchResponse(wrapped);
  assert.equal(result.ok, true);
  assert.equal(result.payload.status, 1);
});

test('normalizeSearchResponse: wrapped error_code 152 -> SESSION_EXPIRED, NOT no-results', () => {
  const result = client.normalizeSearchResponse(wrappedErrorText);
  assert.deepEqual(result, { ok: false, code: 'SESSION_EXPIRED' });
});

test('normalizeSearchResponse: error_code 152 -> SESSION_EXPIRED (plain payload)', () => {
  const result = client.normalizeSearchResponse(
    JSON.stringify({ status: 1, error_code: 152, data: { lists: [] } })
  );
  assert.deepEqual(result, { ok: false, code: 'SESSION_EXPIRED' });
});

test('normalizeSearchResponse: success payload passes through', () => {
  const result = client.normalizeSearchResponse(successJson);
  assert.equal(result.ok, true);
});

test('normalizeSearchResponse: status 0 -> SEARCH_FAILED', () => {
  const result = client.normalizeSearchResponse(JSON.stringify({ status: 0, error_code: 0 }));
  assert.deepEqual(result, { ok: false, code: 'SEARCH_FAILED' });
});

/* --------------------------------------------------------------------- *
 * getPlayerControl core
 * --------------------------------------------------------------------- */

function makePlayer() {
  return {
    playing: true,
    addSongToQueue: async () => ({ song: { name: 'x' } })
  };
}

function makeRouteProxy({ direct = false, props = false, attrs = false } = {}) {
  const proxy = {};
  if (direct) proxy.playerControl = makePlayer();
  if (props) proxy.$props = { playerControl: makePlayer() };
  if (attrs) proxy.$attrs = { playerControl: makePlayer() };
  return proxy;
}

function makeApp({ router, viaProvides = false }) {
  const app = {
    config: { globalProperties: {} },
    _context: { provides: {} }
  };
  if (viaProvides) {
    app._context.provides[Symbol('routerKey')] = router;
  } else {
    app.config.globalProperties.$router = router;
  }
  return app;
}

function makeRouter(matched) {
  const router = {
    push: async () => {},
    afterEach: () => () => {},
    currentRoute: { value: { name: 'Test', path: '/', matched } },
    isReady: async () => {},
    replace: async () => {}
  };
  return router;
}

test('getPlayerControl: found via $props.playerControl (declared prop routes)', () => {
  const matched = [
    { path: '/', name: 'HomeLayout', instances: {} },
    { path: '/search', name: 'Search', instances: { default: makeRouteProxy({ props: true }) } }
  ];
  const app = makeApp({ router: makeRouter(matched) });
  const player = client.getPlayerControlFromApp(app);
  assert.ok(player);
  assert.equal(typeof player.addSongToQueue, 'function');
  assert.equal(player.playing, true);
});

test('getPlayerControl: found via $attrs.playerControl (undeclared prop routes)', () => {
  const matched = [
    { path: '/', name: 'HomeLayout', instances: {} },
    { path: '/settings', name: 'Settings', instances: { default: makeRouteProxy({ attrs: true }) } }
  ];
  const app = makeApp({ router: makeRouter(matched) });
  assert.ok(client.getPlayerControlFromApp(app));
});

test('getPlayerControl: found via direct expose proxy', () => {
  const matched = [
    { path: '/', name: 'HomeLayout', instances: {} },
    { path: '/home', name: 'Index', instances: { default: makeRouteProxy({ direct: true }) } }
  ];
  const app = makeApp({ router: makeRouter(matched) });
  assert.ok(client.getPlayerControlFromApp(app));
});

test('getPlayerControl: /lyrics-style top-level route (no player) -> null', () => {
  const matched = [{ path: '/lyrics', name: 'Lyrics', instances: { default: {} } }];
  const app = makeApp({ router: makeRouter(matched) });
  assert.equal(client.getPlayerControlFromApp(app), null);
});

test('getPlayerControl: HomeLayout proxy without playerControl -> null', () => {
  // HomeLayout never exposes playerControl on its own public proxy; only
  // route children receive it as a prop/attr.
  const matched = [{ path: '/', name: 'HomeLayout', instances: { default: {} } }];
  const app = makeApp({ router: makeRouter(matched) });
  assert.equal(client.getPlayerControlFromApp(app), null);
});

test('getRouter: $router direct path', () => {
  const router = makeRouter([]);
  const app = makeApp({ router });
  assert.equal(client.getRouter(app), router);
});

test('getRouter: provides symbol fallback', () => {
  const router = makeRouter([{ path: '/', name: 'HomeLayout', instances: {} }]);
  const app = makeApp({ router, viaProvides: true });
  assert.equal(client.getRouter(app), router);
});

test('getRouter: rejects non-router globalProperties', () => {
  const app = {
    config: { globalProperties: { $router: { push: 'not-a-function' } } },
    _context: { provides: {} }
  };
  assert.equal(client.getRouter(app), null);
});

test('getRouter: no app -> null', () => {
  assert.equal(client.getRouter(null), null);
});

test('playerFromRouteProxy: returns first matching candidate in order', () => {
  const proxy = {
    playerControl: makePlayer(),
    $props: { playerControl: makePlayer() }
  };
  const player = client.playerFromRouteProxy(proxy);
  assert.equal(player, proxy.playerControl);
});

test('playerFromRouteProxy: null proxy -> null', () => {
  assert.equal(client.playerFromRouteProxy(null), null);
});

test('playerFromRouteProxy: non-object -> null', () => {
  assert.equal(client.playerFromRouteProxy('x'), null);
});

test('isPlayerControl: rejects objects without addSongToQueue', () => {
  assert.ok(!client.isPlayerControl({ playing: true }));
  assert.ok(!client.isPlayerControl(null));
  assert.ok(!client.isPlayerControl(undefined));
  assert.ok(!client.isPlayerControl(42));
  assert.ok(!client.isPlayerControl('x'));
});

/* --------------------------------------------------------------------- *
 * waitForPlayerControlFromApp
 * --------------------------------------------------------------------- */

test('waitForPlayerControlFromApp: non-player route navigates to Index then finds player', async () => {
  const player = makePlayer();
  const router = {
    push: async () => {},
    afterEach: () => () => {},
    isReady: async () => {},
    currentRoute: { value: { name: 'Lyrics', path: '/lyrics', matched: [{ path: '/lyrics' }] } },
    replace: async (to) => {
      assert.equal(to.name, 'Index');
      router.currentRoute.value = {
        name: 'Index',
        path: '/',
        matched: [
          { path: '/', name: 'HomeLayout', instances: {} },
          { path: '/', name: 'Index', instances: { default: { $props: { playerControl: player } } } }
        ]
      };
    }
  };
  const app = makeApp({ router });
  const found = await client.waitForPlayerControlFromApp(app, { timeoutMs: 1000 });
  assert.equal(found, player);
});

test('waitForPlayerControlFromApp: returns null when player never appears', async () => {
  const router = {
    push: async () => {},
    afterEach: () => () => {},
    isReady: async () => {},
    currentRoute: {
      value: {
        name: 'Index',
        path: '/',
        matched: [
          { path: '/', name: 'HomeLayout', instances: {} },
          { path: '/', name: 'Index', instances: { default: {} } }
        ]
      }
    },
    replace: async () => {}
  };
  const app = makeApp({ router });
  const found = await client.waitForPlayerControlFromApp(app, { timeoutMs: 250 });
  assert.equal(found, null);
});

test('waitForPlayerControlFromApp: no router -> null', async () => {
  const app = makeApp({ router: null });
  assert.equal(await client.waitForPlayerControlFromApp(app), null);
});

/* --------------------------------------------------------------------- *
 * refreshLoginSession (login_by_token keepalive)
 * --------------------------------------------------------------------- */

function memoryStorage(initial) {
  let value = initial;
  return {
    getItem: () => value,
    setItem: (_k, v) => {
      value = v;
    }
  };
}

const moeData = {
  UserInfo: { token: 'old-token', userid: '42', t1: 'old-t1' },
  Device: { dfid: 'df', mid: 'm', guid: 'g', serverDev: 'sd', mac: 'ma' }
};

function refreshFetch(responseText, { status = 200 } = {}) {
  return async () => ({
    status,
    text: async () => responseText
  });
}

test('refreshLoginSession: success updates MoeData with new token/t1/userid', async () => {
  const storage = memoryStorage(JSON.stringify(moeData));
  const result = await client.refreshLoginSession({
    storage,
    apiBase: 'http://127.0.0.1:8080/api',
    fetch: refreshFetch(
      JSON.stringify({
        status: 1,
        error_code: 0,
        data: { token: 'new-token', t1: 'new-t1', userid: 99, vip_type: 1 }
      })
    )
  });
  assert.deepEqual(result, { ok: true });
  const stored = JSON.parse(storage.getItem('MoeData'));
  assert.equal(stored.UserInfo.token, 'new-token');
  assert.equal(stored.UserInfo.t1, 'new-t1');
  assert.equal(stored.UserInfo.userid, '99');
  assert.equal(stored.UserInfo.vip_type, undefined);
});

test('refreshLoginSession: missing token -> SESSION_EXPIRED, no fetch', async () => {
  let called = false;
  const result = await client.refreshLoginSession({
    storage: memoryStorage(JSON.stringify({ UserInfo: {}, Device: {} })),
    apiBase: 'http://x',
    fetch: async () => {
      called = true;
      return { status: 200, text: async () => '' };
    }
  });
  assert.deepEqual(result, { ok: false, code: 'SESSION_EXPIRED' });
  assert.equal(called, false);
});

test('refreshLoginSession: error_code 152 -> SESSION_EXPIRED', async () => {
  const storage = memoryStorage(JSON.stringify(moeData));
  const result = await client.refreshLoginSession({
    storage,
    apiBase: 'http://127.0.0.1:8080/api',
    fetch: refreshFetch(JSON.stringify({ status: 1, error_code: 152, data: {} }))
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SESSION_EXPIRED');
  assert.match(result.detail, /error_code=152/);
  assert.equal(JSON.parse(storage.getItem('MoeData')).UserInfo.token, 'old-token');
});

test('refreshLoginSession: wrapped JSONP body is unwrapped', async () => {
  const storage = memoryStorage(JSON.stringify(moeData));
  const body = `<!--KG_TAG_RES_START-->${JSON.stringify({
    status: 1,
    error_code: 0,
    data: { token: 'wrapped-token', t1: 'wrapped-t1', userid: 7 }
  })}<!--KG_TAG_RES_END-->`;
  const result = await client.refreshLoginSession({
    storage,
    apiBase: 'http://x',
    fetch: refreshFetch(body)
  });
  assert.equal(result.ok, true);
  const stored = JSON.parse(storage.getItem('MoeData'));
  assert.equal(stored.UserInfo.token, 'wrapped-token');
  assert.equal(stored.UserInfo.userid, '7');
});

test('refreshLoginSession: network error -> REFRESH_FAILED', async () => {
  const result = await client.refreshLoginSession({
    storage: memoryStorage(JSON.stringify(moeData)),
    apiBase: 'http://x',
    fetch: async () => {
      throw new TypeError('Failed to fetch');
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'REFRESH_FAILED');
  assert.match(result.detail, /network/);
});

test('refreshLoginSession: no storage/fetch -> REFRESH_FAILED', async () => {
  const result = await client.refreshLoginSession({ apiBase: 'http://x' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'REFRESH_FAILED');
});

test('SESSION_REFRESH_MS is 45 minutes', () => {
  assert.equal(client.SESSION_REFRESH_MS, 45 * 60 * 1000);
});

/* --------------------------------------------------------------------- *
 * createSessionRecoverer (Phase 5.6)
 * --------------------------------------------------------------------- */

const moeDataWithSession = {
  UserInfo: { token: 'old-token', userid: '42', t1: 'old-t1' },
  Device: { dfid: 'df', mid: 'm', guid: 'g', serverDev: 'sd', mac: 'ma' }
};

test('recoverer: valid refresh ok -> reauth never called', async () => {
  let reauthCalls = 0;
  const recoverer = client.createSessionRecoverer({
    refresh: async () => ({ ok: true }),
    reauth: async () => {
      reauthCalls += 1;
      return { ok: true, session: { token: 'x' } };
    },
    readDevice: () => ({ dfid: 'df' })
  });
  const result = await recoverer.recover();
  assert.equal(result.ok, true);
  assert.equal(reauthCalls, 0);
});

test('recoverer: refresh SESSION_EXPIRED -> reauth called and ok propagated', async () => {
  const seenDevice = [];
  const recoverer = client.createSessionRecoverer({
    refresh: async () => ({ ok: false, code: 'SESSION_EXPIRED' }),
    reauth: async (device) => {
      seenDevice.push(device);
      return { ok: true, session: { token: 'new-token', userid: 9 } };
    },
    readDevice: () => ({ dfid: 'df', mid: 'm' })
  });
  const result = await recoverer.recover();
  assert.equal(result.ok, true);
  assert.deepEqual(seenDevice, [{ dfid: 'df', mid: 'm' }]);
});

test('recoverer: refresh non-SESSION_EXPIRED -> reauth not called, code returned', async () => {
  let reauthCalls = 0;
  const recoverer = client.createSessionRecoverer({
    refresh: async () => ({ ok: false, code: 'REFRESH_FAILED', detail: 'network' }),
    reauth: async () => {
      reauthCalls += 1;
      return { ok: true, session: { token: 'x' } };
    },
    readDevice: () => ({ dfid: 'df' })
  });
  const result = await recoverer.recover();
  assert.deepEqual(result, { ok: false, code: 'REFRESH_FAILED', detail: 'network' });
  assert.equal(reauthCalls, 0);
});

test('recoverer: no refresh dep + reauth ok -> ok', async () => {
  const recoverer = client.createSessionRecoverer({
    reauth: async () => ({ ok: true, session: { token: 'x' } }),
    readDevice: () => ({ dfid: 'df' })
  });
  const result = await recoverer.recover();
  assert.equal(result.ok, true);
});

test('recoverer: RISK_REQUIRED from reauth is returned (no loop)', async () => {
  let reauthCalls = 0;
  const recoverer = client.createSessionRecoverer({
    refresh: async () => ({ ok: false, code: 'SESSION_EXPIRED' }),
    reauth: async () => {
      reauthCalls += 1;
      return { ok: false, code: 'RISK_REQUIRED' };
    },
    readDevice: () => ({ dfid: 'df' })
  });
  const result = await recoverer.recover();
  assert.deepEqual(result, { ok: false, code: 'RISK_REQUIRED' });
  assert.equal(reauthCalls, 1);
});

test('recoverer: no device -> UPSTREAM_UNAVAILABLE without calling reauth', async () => {
  let reauthCalls = 0;
  const recoverer = client.createSessionRecoverer({
    refresh: async () => ({ ok: false, code: 'SESSION_EXPIRED' }),
    reauth: async () => {
      reauthCalls += 1;
      return { ok: true, session: { token: 'x' } };
    },
    readDevice: () => null
  });
  const result = await recoverer.recover();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'UPSTREAM_UNAVAILABLE');
  assert.equal(reauthCalls, 0);
});

test('recoverer: concurrent recover() calls share one in-flight attempt', async () => {
  let reauthCalls = 0;
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const recoverer = client.createSessionRecoverer({
    refresh: async () => ({ ok: false, code: 'SESSION_EXPIRED' }),
    reauth: async () => {
      reauthCalls += 1;
      await gate;
      return { ok: true, session: { token: 'x' } };
    },
    readDevice: () => ({ dfid: 'df' })
  });
  const a = recoverer.recover();
  const b = recoverer.recover();
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(reauthCalls, 1, 'single-flight password login');
  assert.equal(ra.ok, true);
  assert.equal(rb.ok, true);
});

test('recoverer: no reauth dep -> UPSTREAM_UNAVAILABLE', async () => {
  const recoverer = client.createSessionRecoverer({
    refresh: async () => ({ ok: false, code: 'SESSION_EXPIRED' }),
    readDevice: () => ({ dfid: 'df' })
  });
  const result = await recoverer.recover();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'UPSTREAM_UNAVAILABLE');
});

/* --------------------------------------------------------------------- *
 * readDeviceFromMoeData / mergeSessionIntoMoeData (Phase 5.6)
 * --------------------------------------------------------------------- */

test('readDeviceFromMoeData: extracts dfid/mid/guid/serverDev/mac', () => {
  const storage = memoryStorage(JSON.stringify(moeDataWithSession));
  const device = client.readDeviceFromMoeData({ storage });
  assert.deepEqual(device, { dfid: 'df', mid: 'm', guid: 'g', serverDev: 'sd', mac: 'ma' });
});

test('readDeviceFromMoeData: missing Device -> null', () => {
  const storage = memoryStorage(JSON.stringify({ UserInfo: { token: 't' } }));
  assert.equal(client.readDeviceFromMoeData({ storage }), null);
});

test('mergeSessionIntoMoeData: writes token/t1/userid + keeps Device', () => {
  const storage = memoryStorage(JSON.stringify(moeDataWithSession));
  const updated = client.mergeSessionIntoMoeData(
    { token: 'new-token', t1: 'new-t1', userid: '99', vip_type: 2, vip_token: 'vt' },
    { storage }
  );
  assert.equal(updated.token, 'new-token');
  assert.equal(updated.t1, 'new-t1');
  assert.equal(updated.userid, '99');
  assert.equal(updated.vip_type, 2);
  assert.equal(updated.vip_token, 'vt');
  const stored = JSON.parse(storage.getItem('MoeData'));
  assert.equal(stored.UserInfo.token, 'new-token');
  assert.equal(stored.UserInfo.userid, '99');
  assert.equal(stored.Device.dfid, 'df');
});

test('mergeSessionIntoMoeData: no UserInfo yet -> creates one (paired auto-login)', () => {
  const storage = memoryStorage(JSON.stringify({ UserInfo: null, Device: moeDataWithSession.Device }));
  const updated = client.mergeSessionIntoMoeData({ token: 't0', userid: '1' }, { storage });
  assert.equal(updated.token, 't0');
  assert.equal(updated.userid, '1');
  const stored = JSON.parse(storage.getItem('MoeData'));
  assert.equal(stored.UserInfo.token, 't0');
  assert.equal(stored.Device.guid, 'g');
});

test('mergeSessionIntoMoeData: empty token is ignored', () => {
  const storage = memoryStorage(JSON.stringify(moeDataWithSession));
  const updated = client.mergeSessionIntoMoeData({ token: '' }, { storage });
  assert.equal(updated, null);
  assert.equal(JSON.parse(storage.getItem('MoeData')).UserInfo.token, 'old-token');
});

/* --------------------------------------------------------------------- *
 * createRecoverySearch (Phase 5.6): one recovery per command + reauth code
 * --------------------------------------------------------------------- */

test('recoverySearch: successful search -> no recovery', async () => {
  let recovers = 0;
  const search = client.createRecoverySearch({
    search: async () => ({ ok: true, payload: {} }),
    recover: async () => {
      recovers += 1;
      return { ok: true };
    }
  });
  const result = await search('七里香');
  assert.equal(result.ok, true);
  assert.equal(recovers, 0);
});

test('recoverySearch: SESSION_EXPIRED -> recover ok -> retry search succeeds', async () => {
  let calls = 0;
  let recovers = 0;
  const search = client.createRecoverySearch({
    search: async () => {
      calls += 1;
      return calls === 1
        ? { ok: false, code: 'SESSION_EXPIRED' }
        : { ok: true, payload: {} };
    },
    recover: async () => {
      recovers += 1;
      return { ok: true };
    }
  });
  const result = await search('x');
  assert.equal(result.ok, true);
  assert.equal(recovers, 1);
  assert.equal(calls, 2, 'exactly one retry');
});

test('recoverySearch: recover RISK_REQUIRED -> SESSION_REAUTH_REQUIRED + navigate, no loop', async () => {
  let searches = 0;
  let recovers = 0;
  const navigated = [];
  const search = client.createRecoverySearch({
    search: async () => {
      searches += 1;
      return { ok: false, code: 'SESSION_EXPIRED' };
    },
    recover: async () => {
      recovers += 1;
      return { ok: false, code: 'RISK_REQUIRED' };
    },
    navigate: (path) => navigated.push(path)
  });
  const result = await search('x');
  assert.deepEqual(result, { ok: false, code: 'SESSION_REAUTH_REQUIRED' });
  assert.deepEqual(navigated, ['/login']);
  assert.equal(recovers, 1, 'no infinite loop');
  assert.equal(searches, 1);
});

test('recoverySearch: recover AUTH_REJECTED -> SESSION_REAUTH_REQUIRED', async () => {
  const search = client.createRecoverySearch({
    search: async () => ({ ok: false, code: 'SESSION_EXPIRED' }),
    recover: async () => ({ ok: false, code: 'AUTH_REJECTED' })
  });
  const result = await search('x');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SESSION_REAUTH_REQUIRED');
});

test('recoverySearch: recover UPSTREAM_UNAVAILABLE -> returned as-is', async () => {
  const search = client.createRecoverySearch({
    search: async () => ({ ok: false, code: 'SESSION_EXPIRED' }),
    recover: async () => ({ ok: false, code: 'UPSTREAM_UNAVAILABLE' })
  });
  const result = await search('x');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'UPSTREAM_UNAVAILABLE');
});

test('recoverySearch: non-SESSION_EXPIRED failure -> no recovery', async () => {
  let recovers = 0;
  const search = client.createRecoverySearch({
    search: async () => ({ ok: false, code: 'SEARCH_FAILED', detail: 'http=500' }),
    recover: async () => {
      recovers += 1;
      return { ok: true };
    }
  });
  const result = await search('x');
  assert.equal(result.code, 'SEARCH_FAILED');
  assert.equal(recovers, 0);
});

test('recoverySearch: recover ok but retry still SESSION_EXPIRED -> SESSION_EXPIRED, no second recovery', async () => {
  let recovers = 0;
  let searches = 0;
  const search = client.createRecoverySearch({
    search: async () => {
      searches += 1;
      return { ok: false, code: 'SESSION_EXPIRED' };
    },
    recover: async () => {
      recovers += 1;
      return { ok: true };
    }
  });
  const result = await search('x');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SESSION_EXPIRED');
  assert.equal(recovers, 1, 'max one recovery');
  assert.equal(searches, 2, 'initial + one retry');
});