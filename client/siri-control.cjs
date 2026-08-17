'use strict';

/**
 * MoeKoe Siri Control - client core + probe (Phase 1/2)
 *
 * Self-contained script that works in two environments:
 *  - Browser: injected into the production dist as `siri-control.<hash>.js`
 *    (classic script, no module syntax, no imports).
 *  - Node: `require`'d by unit tests for the pure functions below.
 *
 * Browser responsibilities handled in later phases:
 *  - WS connect/auth/heartbeat/reconnect        (Phase 3)
 *  - search + extractFirstSong + play + ACK     (Phase 4)
 *
 * This file must never:
 *  - call `new Audio()`, resolve song URLs, or touch the MoeKoeMusic queue
 *  - log tokens, Authorization headers, cookies, or song URLs
 */

/* ===================================================================== *
 *  Build-time constants (replaced by vite.siri.config.mjs)
 *  - SIRI_WS_TOKEN__ is replaced with a JSON string literal.
 * ===================================================================== */
const BUILD = {
  WS_TOKEN: '__SIRI_WS_TOKEN__',
  CONTROL_PORT: '__SIRI_CONTROL_PORT__',
  WS_PATH: '__SIRI_WS_PATH__',
  API_BASE: '__SIRI_API_BASE__',
  VERSION: '__SIRI_VERSION__'
};

const PROTOCOL_VERSION = 2;

const SESSION_REFRESH_MS = 45 * 60 * 1000;

const CLIENT_ERRORS = Object.freeze([
  'COMMAND_EXPIRED',
  'SESSION_EXPIRED',
  'SEARCH_FAILED',
  'NO_RESULTS',
  'INVALID_RESULT',
  'NO_HASH',
  'PLAYER_NOT_READY',
  'AUTOPLAY_BLOCKED',
  'PLAY_FAILED'
]);

const LOG_PREFIX = '[SiriControl]';

function log(...args) {
  if (typeof console !== 'undefined') {
    console.log(LOG_PREFIX, ...args);
  }
}

/* ===================================================================== *
 *  Pure string / payload helpers
 * ===================================================================== */

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value : '';
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = nonEmpty(value);
    if (text) return text;
  }
  return '';
}

function stripKgTagWrapper(text) {
  if (typeof text !== 'string') return text;
  const START = '<!--KG_TAG_RES_START-->';
  const END = '<!--KG_TAG_RES_END-->';
  const startIdx = text.indexOf(START);
  if (startIdx === -1) return text;
  const begin = startIdx + START.length;
  const endIdx = text.indexOf(END, begin);
  const slice = endIdx === -1 ? text.slice(begin) : text.slice(begin, endIdx);
  return slice.trim();
}

/**
 * Parse a `/search/complex` response body.
 * Handles the optional `KG_TAG_RES` wrapper comment before JSON parsing.
 * @returns {{ok: true, payload: any} | {ok: false, code: 'SEARCH_FAILED'}}
 */
function parseSearchResponse(text) {
  try {
    const payload = JSON.parse(stripKgTagWrapper(text));
    return { ok: true, payload };
  } catch (_err) {
    return { ok: false, code: 'SEARCH_FAILED' };
  }
}

/**
 * Normalize a `/search/complex` response body.
 * - Invalid JSON                 -> SEARCH_FAILED
 * - `status !== 1`               -> SEARCH_FAILED
 * - non-zero `error_code` (e.g. 152) -> SEARCH_FAILED (NOT "no results")
 * Otherwise returns the parsed payload.
 */
function normalizeSearchResponse(text) {
  const parsed = parseSearchResponse(text);
  if (!parsed.ok) return parsed;

  const payload = parsed.payload;
  const errorCode =
    payload && payload.error_code !== undefined ? payload.error_code : 0;

  if (!payload || payload.status !== 1 || Number(errorCode) !== 0) {
    // 152 = KuGou session/auth error (expired or missing login). Report it
    // distinctly so the caller can say "please re-login" instead of a generic
    // search failure.
    if (Number(errorCode) === 152) {
      return { ok: false, code: 'SESSION_EXPIRED' };
    }
    return { ok: false, code: 'SEARCH_FAILED' };
  }

  return { ok: true, payload };
}

/**
 * Extract the first playable song from a complex-search payload.
 * Return order is preserved; structurally broken / hash-less items are
 * skipped. No advanced ranking is performed.
 *
 * @param {any} payload top-level `/search/complex` JSON body
 * @returns {{ok: true, song: {hash, name, img, author}} | {ok: false, code}}
 */
function extractFirstSong(payload) {
  const fail = (code) => ({ ok: false, code });

  const sections =
    payload && typeof payload === 'object' && payload.data ? payload.data.lists : undefined;

  if (!Array.isArray(sections)) {
    return fail('INVALID_RESULT');
  }

  const songSection = sections.find((section) => {
    const type = section && section.type;
    return typeof type === 'string' && type.toLowerCase() === 'song';
  });

  if (!songSection || !Array.isArray(songSection.lists)) {
    return fail('NO_RESULTS');
  }

  if (songSection.lists.length === 0) {
    return fail('NO_RESULTS');
  }

  const objects = songSection.lists.filter(
    (item) => item && typeof item === 'object'
  );

  if (objects.length === 0) {
    return fail('INVALID_RESULT');
  }

  let sawHash = false;

  for (const song of objects) {
    const hash = firstNonEmpty(song.HQFileHash, song.SQFileHash, song.FileHash);
    if (!hash) continue;
    sawHash = true;

    const name = firstNonEmpty(song.OriSongName, song.SongName);
    if (!name) continue;

    return {
      ok: true,
      song: {
        hash,
        name,
        img:
          nonEmpty(song.Image).replace('{size}', '480') ||
          './assets/images/ico.png',
        author: nonEmpty(song.SingerName) || ''
      }
    };
  }

  return fail(sawHash ? 'INVALID_RESULT' : 'NO_HASH');
}

/* ===================================================================== *
 *  getPlayerControl() - production entry point
 *
 *  Router is read from `app.config.globalProperties.$router` first, with a
 *  structural `app._context.provides` fallback for version compatibility.
 *  `matched[].instances.default` holds the route component's *public proxy*,
 *  NOT an internal ComponentInternalInstance, so we read:
 *      instance.playerControl
 *      instance.$props?.playerControl
 *      instance.$attrs?.playerControl
 *  and never `instance.props.playerControl`.
 * ===================================================================== */

function isPlayerControl(value) {
  return (
    value &&
    typeof value === 'object' &&
    typeof value.addSongToQueue === 'function'
  );
}

function getVueApp(host) {
  const root = host || (typeof document !== 'undefined' ? document.querySelector('#app') : null);
  return root ? (root.__vue_app__ || null) : null;
}

function isRouterLike(value) {
  return !!(
    value &&
    typeof value.push === 'function' &&
    typeof value.afterEach === 'function' &&
    value.currentRoute &&
    value.currentRoute.value
  );
}

function getRouter(app) {
  if (!app) return null;

  const direct = app.config && app.config.globalProperties && app.config.globalProperties.$router;
  if (isRouterLike(direct)) {
    return direct;
  }

  // Version-compatibility fallback only. Do not rely on Symbol.description:
  // the production routerKey symbol has an empty description.
  const provides = app._context && app._context.provides;
  if (!provides) return null;

  for (const key of Reflect.ownKeys(provides)) {
    const candidate = provides[key];
    if (
      isRouterLike(candidate) &&
      Array.isArray(candidate.currentRoute.value.matched)
    ) {
      return candidate;
    }
  }

  return null;
}

function playerFromRouteProxy(routeProxy) {
  if (!routeProxy) return null;

  const candidates = [
    routeProxy.playerControl,
    routeProxy.$props ? routeProxy.$props.playerControl : undefined,
    routeProxy.$attrs ? routeProxy.$attrs.playerControl : undefined
  ];

  return candidates.find(isPlayerControl) || null;
}

function getPlayerControlFromApp(app) {
  const router = getRouter(app);
  if (!router) return null;

  const current = router.currentRoute && router.currentRoute.value;
  const matched = current && current.matched;
  if (!Array.isArray(matched)) return null;

  for (let i = matched.length - 1; i >= 0; i--) {
    const record = matched[i];
    const routeProxy = record && record.instances ? record.instances.default : null;
    const player = playerFromRouteProxy(routeProxy);
    if (player) return player;
  }

  return null;
}

function getPlayerControl() {
  const app = getVueApp();
  return app ? getPlayerControlFromApp(app) : null;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForVueApp(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const app = getVueApp();
    if (app) return app;
    await delay(100);
  }
  return null;
}

/**
 * Wait for a usable PlayerControl on the current route. If the current route
 * is not a HomeLayout child (e.g. /lyrics, /video where PlayerControl is not
 * mounted), navigates to Index first and waits for the player to remount.
 */
async function waitForPlayerControlFromApp(app, { timeoutMs = 8000 } = {}) {
  const router = getRouter(app);
  if (!router) return null;

  if (typeof router.isReady === 'function') {
    await router.isReady();
  }

  const current = router.currentRoute && router.currentRoute.value;
  const matched = current && current.matched;
  const isPlayerRoute =
    Array.isArray(matched) &&
    matched.length > 1 &&
    matched[0] &&
    matched[0].path === '/';

  if (!isPlayerRoute && typeof router.replace === 'function') {
    try {
      await router.replace({ name: 'Index' });
    } catch (_err) {
      return null;
    }
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const player = getPlayerControlFromApp(app);
    if (player) return player;
    await delay(100);
  }

  return null;
}

async function waitForPlayerControl({ timeoutMs = 8000 } = {}) {
  const app = await waitForVueApp(8000);
  return app ? waitForPlayerControlFromApp(app, { timeoutMs }) : null;
}

/* ===================================================================== *
 *  Phase 1 probe
 * ===================================================================== */

function describePlayerControl(player) {
  if (!player) return null;
  return {
    found: true,
    addSongToQueueType: typeof player.addSongToQueue,
    playingType: typeof player.playing
  };
}

function probeCurrent() {
  const app = getVueApp();
  const router = getRouter(app);
  const current = router ? router.currentRoute.value : null;

  const report = {
    version: BUILD.VERSION,
    vueAppFound: !!app,
    routerFound: !!router,
    routeName: current ? String(current.name || '') : null,
    routePath: current ? current.path : null,
    matched: [],
    playerControl: null
  };

  if (router && current && Array.isArray(current.matched)) {
    for (let i = 0; i < current.matched.length; i++) {
      const record = current.matched[i];
      const routeProxy = record.instances ? record.instances.default : null;
      const read = (get) => {
        try {
          return isPlayerControl(get());
        } catch (_err) {
          return false;
        }
      };
      report.matched.push({
        path: record.path,
        name: record.name || null,
        hasInstance: !!routeProxy,
        access: {
          direct: read(() => routeProxy.playerControl),
          props: read(() => routeProxy.$props && routeProxy.$props.playerControl),
          attrs: read(() => routeProxy.$attrs && routeProxy.$attrs.playerControl)
        }
      });
    }
  }

  report.playerControl = describePlayerControl(getPlayerControlFromApp(app));
  return report;
}

const PROBE_ROUTES = [
  'Index',
  'Discover',
  'Library',
  'Login',
  'Settings',
  'PlaylistDetail',
  'Search',
  'RecommendedSearch',
  'Ranking',
  'CloudDrive',
  'LocalMusic',
  'Recognize',
  'Lyrics',
  'VideoPlayer'
];

/**
 * Navigate through every known route, capture a probe report per route, then
 * return to Index. Requires an authenticated session for requiresAuth routes;
 * redirects to /login are reported as-is.
 */
async function probeAllRoutes() {
  const app = getVueApp();
  const router = getRouter(app);
  const results = {};

  if (!router) {
    return { error: 'router not found' };
  }

  try {
    await router.replace({ name: 'Index' });
    await delay(200);
  } catch (_err) {
    // ignore
  }

  for (const name of PROBE_ROUTES) {
    try {
      await router.replace({ name });
      await delay(300);
      results[name] = probeCurrent();
    } catch (err) {
      results[name] = {
        error: String((err && err.message) || err)
      };
    }
  }

  try {
    await router.replace({ name: 'Index' });
  } catch (_err) {
    // ignore
  }

  return results;
}

/* ===================================================================== *
 *  Command handler (Phase 4) - play.req -> search -> play -> play.ack
 *
 *  The search must run with the WebUI's same-origin identity: the browser
 *  sends cookies (`credentials:'include'`) and builds the Authorization
 *  header from `localStorage['MoeData']`, exactly like MoeKoeMusic's
 *  request interceptor. Playback goes through
 *  `player.addSongToQueue(hash, name, img, author)`.
 * ===================================================================== */

function buildAuthHeaders(deps = {}) {
  const storage =
    deps.storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  let data = null;
  if (storage) {
    try {
      const raw = storage.getItem('MoeData');
      if (raw) data = JSON.parse(raw);
    } catch (_err) {
      data = null;
    }
  }
  const UserInfo = data && data.UserInfo ? data.UserInfo : null;
  const Device = data && data.Device ? data.Device : null;
  const parts = [];
  if (UserInfo) {
    if (nonEmpty(UserInfo.token)) parts.push('token=' + UserInfo.token);
    if (nonEmpty(UserInfo.userid)) parts.push('userid=' + UserInfo.userid);
    if (nonEmpty(UserInfo.t1)) parts.push('t1=' + UserInfo.t1);
  }
  if (Device) {
    if (nonEmpty(Device.dfid)) parts.push('dfid=' + Device.dfid);
    if (nonEmpty(Device.mid)) parts.push('KUGOU_API_MID=' + Device.mid);
    if (nonEmpty(Device.guid)) parts.push('KUGOU_API_GUID=' + Device.guid);
    if (nonEmpty(Device.serverDev)) parts.push('KUGOU_API_DEV=' + Device.serverDev);
    if (nonEmpty(Device.mac)) parts.push('KUGOU_API_MAC=' + Device.mac);
  }
  return parts.length > 0 ? { Authorization: parts.join(';') } : {};
}

function buildSearchRequest(query, deps = {}) {
  const apiBase = deps.apiBase || BUILD.API_BASE;
  const url = apiBase + '/search/complex?keywords=' + encodeURIComponent(String(query || ''));
  return {
    url,
    options: {
      method: 'GET',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...buildAuthHeaders(deps) }
    }
  };
}

async function defaultSearch(query, deps = {}) {
  const fetcher = deps.fetch || (typeof fetch !== 'undefined' ? fetch : null);
  if (!fetcher) return { ok: false, code: 'SEARCH_FAILED', detail: 'no-fetch' };
  const req = buildSearchRequest(query, deps);
  let res;
  try {
    res = await fetcher(req.url, req.options);
  } catch (err) {
    return {
      ok: false,
      code: 'SEARCH_FAILED',
      detail: 'network:' + ((err && err.name) || String(err && err.message) || 'error')
    };
  }
  const text = await res.text();
  const normalized = normalizeSearchResponse(text);
  if (normalized.ok) return normalized;

  let detail = 'http=' + res.status;
  const stripped = stripKgTagWrapper(text);
  try {
    const payload = JSON.parse(stripped);
    if (payload && payload.error_code !== undefined) detail += ' error_code=' + payload.error_code;
    if (payload && payload.status !== undefined) detail += ' status=' + payload.status;
  } catch (_err) {
    const snippet = String(stripped || '').replace(/\s+/g, ' ').slice(0, 60);
    detail += ' body=' + (snippet || '(empty)');
  }
  return { ok: false, code: normalized.code || 'SEARCH_FAILED', detail };
}

/* ===================================================================== *
 *  Session refresh (Phase 5.5) - login_by_token keepalive
 *
 *  The WebUI never calls /login/token, so a KuGou web session is never
 *  renewed and eventually dies server-side (error_code 152). We refresh
 *  it ourselves: POST /login/token exchanges the current token for a
 *  fresh one (the local API also Set-Cookie's the new values). On
 *  success we write the new token/t1/userid back to localStorage
 *  'MoeData' and to the live Pinia store so the WebUI's own requests
 *  keep using the current token. Never logs tokens.
 * ===================================================================== */

function getStorage() {
  return typeof localStorage !== 'undefined' ? localStorage : null;
}

function readMoeData(storage) {
  if (!storage) return null;
  try {
    const raw = storage.getItem('MoeData');
    if (raw) return JSON.parse(raw);
  } catch (_err) {
    // no-op
  }
  return null;
}

function writeMoeData(data, storage) {
  if (!storage) return;
  try {
    storage.setItem('MoeData', JSON.stringify(data));
  } catch (_err) {
    // best-effort persistence
  }
}

function syncMoeUserInfo(userInfo) {
  const store = getMoeAuthStore();
  if (store && typeof store.setData === 'function') {
    try {
      store.setData({ UserInfo: userInfo });
    } catch (_err) {
      // best-effort
    }
  }
}

function getMoeAuthStore() {
  try {
    const app = getVueApp();
    const pinia =
      app && app.config && app.config.globalProperties && app.config.globalProperties.$pinia;
    if (pinia && pinia._s && typeof pinia._s.get === 'function') {
      return pinia._s.get('MoeData') || null;
    }
  } catch (_err) {
    // no-op
  }
  return null;
}

async function refreshLoginSession(deps = {}) {
  const storage = deps.storage || getStorage();
  const fetcher = deps.fetch || (typeof fetch !== 'undefined' ? fetch : null);
  if (!storage || !fetcher) {
    return { ok: false, code: 'REFRESH_FAILED', detail: 'no-storage-or-fetch' };
  }

  const data = readMoeData(storage);
  const UserInfo = data && data.UserInfo ? data.UserInfo : null;
  if (!UserInfo || !nonEmpty(UserInfo.token)) {
    return { ok: false, code: 'SESSION_EXPIRED' };
  }

  const apiBase = deps.apiBase || BUILD.API_BASE;
  const url = apiBase + '/login/token';
  let res;
  try {
    res = await fetcher(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...buildAuthHeaders(deps) }
    });
  } catch (err) {
    return {
      ok: false,
      code: 'REFRESH_FAILED',
      detail: 'network:' + ((err && err.name) || String(err && err.message) || 'error')
    };
  }

  const text = await res.text();
  let payload = null;
  try {
    payload = JSON.parse(stripKgTagWrapper(text));
  } catch (_err) {
    payload = null;
  }

  if (!payload || payload.status !== 1 || !payload.data || !nonEmpty(payload.data.token)) {
    const code = payload && payload.error_code === 152 ? 'SESSION_EXPIRED' : 'REFRESH_FAILED';
    let detail = 'http=' + res.status;
    if (payload && payload.error_code !== undefined) detail += ' error_code=' + payload.error_code;
    if (payload && payload.status !== undefined) detail += ' status=' + payload.status;
    return { ok: false, code, detail };
  }

  const updatedUserInfo = {
    ...UserInfo,
    token: payload.data.token,
    t1: nonEmpty(payload.data.t1) ? payload.data.t1 : UserInfo.t1,
    userid: payload.data.userid != null ? String(payload.data.userid) : UserInfo.userid
  };
  writeMoeData({ ...data, UserInfo: updatedUserInfo }, storage);
  syncMoeUserInfo(updatedUserInfo);
  return { ok: true };
}

/* ===================================================================== *
 *  Session recovery (Phase 5.6) - password-login fallback
 *
 *  When login_by_token cannot renew the session (error_code 152 or no token
 *  at all), the client asks the control server (via the paired WS) to log in
 *  with the KuGou account stored on the Windows side and returns a fresh
 *  session to merge into MoeData. Recovery is single-flight so concurrent
 *  refresh events / visibility events / Siri commands share one attempt, and
 *  each Siri command performs at most one recovery (the command handler
 *  retries the search exactly once after a SESSION_EXPIRED).
 * ===================================================================== */

function readDeviceFromMoeData(deps = {}) {
  const storage = deps.storage || getStorage();
  const data = readMoeData(storage);
  const Device = data && data.Device ? data.Device : null;
  if (!Device) return null;
  const device = {};
  for (const key of ['dfid', 'mid', 'guid', 'serverDev', 'mac']) {
    if (nonEmpty(Device[key])) device[key] = Device[key];
  }
  if (!device.dfid && !device.mid && !device.guid) return null;
  return device;
}

function mergeSessionIntoMoeData(session, deps = {}) {
  if (!session || !nonEmpty(session.token)) return null;
  const storage = deps.storage || getStorage();
  const data = readMoeData(storage) || { UserInfo: null, Device: null };
  const UserInfo = (data && data.UserInfo) || {};
  const updated = {
    ...UserInfo,
    token: String(session.token),
    t1: nonEmpty(session.t1) ? String(session.t1) : UserInfo.t1,
    userid: session.userid != null ? String(session.userid) : UserInfo.userid
  };
  if (session.vip_type != null) updated.vip_type = session.vip_type;
  if (nonEmpty(session.vip_token)) updated.vip_token = String(session.vip_token);
  writeMoeData({ ...data, UserInfo: updated }, storage);
  syncMoeUserInfo(updated);
  return updated;
}

/**
 * `deps`:
 *   refresh()   async -> {ok:true} | {ok:false,code}   login_by_token (may be null)
 *   reauth()    async (device) -> {ok:true, session} | {ok:false, code}
 *   readDevice() -> device | null                       iPad device fields
 *   log(...)
 */
function createSessionRecoverer(deps = {}) {
  const {
    refresh = null,
    reauth = null,
    readDevice = () => null,
    log = () => {}
  } = deps;

  let inFlight = null;

  async function recover() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      if (typeof refresh === 'function') {
        const r1 = await refresh();
        if (r1 && r1.ok === true) return r1;
        if (r1 && r1.code !== 'SESSION_EXPIRED') return r1;
      }
      if (typeof reauth !== 'function') {
        return { ok: false, code: 'UPSTREAM_UNAVAILABLE', detail: 'no-reauth' };
      }
      const device = typeof readDevice === 'function' ? readDevice() : null;
      if (!device) {
        return { ok: false, code: 'UPSTREAM_UNAVAILABLE', detail: 'no-device' };
      }
      log('session recovery: requesting password reauth');
      const r2 = await reauth(device);
      return r2 && r2.ok === true ? { ok: true } : r2;
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  return { recover };
}

// Siri-facing code when KuGou demands manual verification after recovery.
const SIRI_REAUTH_CODE = 'SESSION_REAUTH_REQUIRED';

function mapRecoveryCode(code) {
  if (code === 'RISK_REQUIRED' || code === 'AUTH_REJECTED') return SIRI_REAUTH_CODE;
  return code || 'SESSION_EXPIRED';
}

/**
 * Search wrapper performing at most ONE session recovery per command.
 * `deps`:
 *   search(query)     async -> {ok:true} | {ok:false, code}
 *   recover()         async -> {ok:true} | {ok:false, code}   shared single-flight
 *   navigate(path)    () -> void                               (best-effort, default noop)
 */
function createRecoverySearch(deps = {}) {
  const { search, recover, navigate = () => {} } = deps;
  return async function recoverySearch(query) {
    const r1 = await search(query);
    if (r1 && r1.ok === true) return r1;
    if (r1 && r1.code === 'SESSION_EXPIRED') {
      const rec = await recover();
      if (rec && rec.ok === true) return search(query);
      const code = mapRecoveryCode(rec && rec.code);
      if (code === SIRI_REAUTH_CODE) {
        try {
          navigate('/login');
        } catch (_err) {
          // best-effort: the Siri ack still reports the reauth code
        }
      }
      const out = { ok: false, code };
      if (rec && rec.detail !== undefined) out.detail = rec.detail;
      return out;
    }
    return r1;
  };
}

/**
 * Single-flight command pipeline. `deps`:
 *   search(query)  async -> {ok:true,payload} | {ok:false,code}   (default defaultSearch)
 *   refresh()      async -> {ok:true} | {ok:false,code}            (default null)
 *                  called once before a search retry when the first
 *                  search reports SESSION_EXPIRED; wired to session
 *                  recovery (login_by_token, then password reauth)
 *   getPlayer()    async -> playerControl | null                 (default waitForPlayerControl)
 *   send(obj)      sends the play.ack                             (default noop)
 */
function createCommandHandler(deps = {}) {
  const {
    search = defaultSearch,
    refresh = null,
    getPlayer = () => waitForPlayerControl({ timeoutMs: 15000 }),
    send = () => {},
    getNow = () => Date.now(),
    log = () => {}
  } = deps;

  const state = {
    busy: false,
    lastCommand: null,
    lastSong: null,
    lastAck: null,
    lastError: null
  };

  function ackPlay(reqId, payload) {
    state.lastAck = { reqId, ...payload };
    send({ type: 'play.ack', reqId, ...payload });
  }

  async function execute(command) {
    if (state.busy) {
      ackPlay(command.reqId, { ok: false, error: 'BUSY' });
      return;
    }
    state.busy = true;
    try {
      if (command.expiresAt != null && getNow() > command.expiresAt) {
        state.lastError = 'COMMAND_EXPIRED';
        ackPlay(command.reqId, { ok: false, error: 'COMMAND_EXPIRED' });
        return;
      }

      let searchResult = await search(command.query);
      if (
        refresh &&
        typeof refresh === 'function' &&
        (!searchResult || searchResult.ok !== true) &&
        searchResult &&
        searchResult.code === 'SESSION_EXPIRED'
      ) {
        try {
          await refresh();
        } catch (_err) {
          // refresh failure is non-fatal: the retried search surfaces the real state
        }
        searchResult = await search(command.query);
      }
      if (!searchResult || searchResult.ok !== true) {
        const code = searchResult && searchResult.code ? searchResult.code : 'SEARCH_FAILED';
        state.lastError = code;
        ackPlay(command.reqId, {
          ok: false,
          error: code,
          ...(searchResult && searchResult.detail ? { detail: searchResult.detail } : {})
        });
        return;
      }

      const extracted = extractFirstSong(searchResult.payload);
      if (!extracted.ok) {
        state.lastError = extracted.code;
        ackPlay(command.reqId, { ok: false, error: extracted.code });
        return;
      }

      const player = await getPlayer();
      if (!player || !isPlayerControl(player)) {
        state.lastError = 'PLAYER_NOT_READY';
        ackPlay(command.reqId, { ok: false, error: 'PLAYER_NOT_READY' });
        return;
      }

      const song = extracted.song;
      let result;
      try {
        result = await player.addSongToQueue(song.hash, song.name, song.img, song.author);
      } catch (_err) {
        state.lastError = 'PLAY_FAILED';
        ackPlay(command.reqId, { ok: false, error: 'PLAY_FAILED' });
        return;
      }

      if (result && result.song) {
        state.lastSong = song;
        state.lastError = null;
        ackPlay(command.reqId, { ok: true, song });
      } else if (result && result.shouldPlayNext) {
        state.lastError = 'AUTOPLAY_BLOCKED';
        ackPlay(command.reqId, { ok: false, error: 'AUTOPLAY_BLOCKED' });
      } else {
        state.lastError = 'PLAY_FAILED';
        ackPlay(command.reqId, { ok: false, error: 'PLAY_FAILED' });
      }
    } finally {
      state.busy = false;
    }
  }

  function handleMessage(msg) {
    if (!msg || msg.type !== 'play.req') return;
    const reqId = typeof msg.reqId === 'string' && msg.reqId ? msg.reqId : null;
    const query = typeof msg.query === 'string' && msg.query.trim() ? msg.query : null;
    if (!reqId || !query) {
      log('ignoring malformed play.req');
      return;
    }
    state.lastCommand = { reqId, query, receivedAt: getNow() };
    log('play.req', reqId, 'query=' + query);
    execute({ reqId, query, expiresAt: typeof msg.expiresAt === 'number' ? msg.expiresAt : null }).catch(
      (err) => {
        log('command error:', String((err && err.message) || err));
        ackPlay(reqId, { ok: false, error: 'PLAY_FAILED' });
      }
    );
  }

  async function play(query) {
    const reqId =
      'local-' +
      Date.now().toString(36) +
      '-' +
      Math.random().toString(36).slice(2, 8);
    state.lastCommand = { reqId, query, receivedAt: getNow() };
    await execute({ reqId, query, expiresAt: null });
    return state.lastAck;
  }

  return { state, handleMessage, play, execute };
}

/* ===================================================================== *
 *  WebSocket client (Phase 3) - auth / heartbeat / backoff reconnect
 *
 *  Dependency-injected so the same code runs in the browser (native
 *  WebSocket) and under Node tests (ws package or native WebSocket).
 *  Never logs tokens.
 * ===================================================================== */

function createWsClient(deps) {
  const {
    WebSocketCtor = globalThis.WebSocket,
    url,
    token,
    version = PROTOCOL_VERSION,
    authTimeoutMs = 5000,
    serverTimeoutMs = 45000,
    reconnectBaseMs = 1000,
    reconnectMaxMs = 30000,
    headers = null,
    onMessage = null,
    onAuthError = null,
    onDisconnect = null,
    log = () => {},
    getNow = () => Date.now()
  } = deps || {};

  const OPEN = 1;

  const state = {
    phase: 'idle',
    connected: false,
    authenticated: false,
    protocol: version,
    paired: false,
    controller: false,
    reconnectCount: 0,
    lastMessageAt: null,
    error: null
  };

  let socket = null;
  let backoff = 0;
  let stopped = false;
  let permanentFail = false;
  let authTimer = null;
  let livenessTimer = null;
  let lastError = null;

  function clearTimers() {
    if (authTimer) {
      clearTimeout(authTimer);
      authTimer = null;
    }
    if (livenessTimer) {
      clearTimeout(livenessTimer);
      livenessTimer = null;
    }
  }

  function nextDelay() {
    const base = backoff === 0 ? reconnectBaseMs : Math.min(backoff * 2, reconnectMaxMs);
    backoff = base;
    const jitter = base * (Math.random() * 0.4 - 0.2);
    return Math.max(1, Math.round(base + jitter));
  }

  function resetBackoff() {
    backoff = 0;
  }

  function send(obj) {
    if (socket && socket.readyState === OPEN) {
      try {
        socket.send(JSON.stringify(obj));
      } catch (_err) {
        // ignore
      }
    }
  }

  function startLiveness() {
    clearTimers();
    livenessTimer = setTimeout(() => {
      if (state.authenticated && !stopped) {
        log('no server messages for', serverTimeoutMs, 'ms; reconnecting');
        if (socket) {
          try {
            socket.close();
          } catch (_err) {
            // ignore
          }
        }
      }
    }, serverTimeoutMs);
  }

  function handleMessage(data) {
    state.lastMessageAt = getNow();
    let msg = null;
    try {
      msg = JSON.parse(String(data));
    } catch (_err) {
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'auth.ok':
        if (!state.authenticated) {
          state.authenticated = true;
          state.connected = true;
          state.phase = 'ready';
          state.protocol = Number.isInteger(msg.version) ? msg.version : version;
          state.paired = msg.paired === true;
          state.controller = msg.controller === true;
          resetBackoff();
          log(
            'authenticated (protocol ' +
              state.protocol +
              ') paired=' +
              state.paired +
              ' controller=' +
              state.controller
          );
          startLiveness();
        }
        break;
      case 'auth.error':
        state.authenticated = false;
        state.connected = false;
        state.phase = msg.reason === 'protocol_mismatch' ? 'protocol_mismatch' : 'auth_rejected';
        state.error = typeof msg.reason === 'string' ? msg.reason : 'auth_rejected';
        lastError = state.error;
        permanentFail = true;
        log('auth error:', state.error);
        if (typeof onAuthError === 'function') onAuthError(state.error);
        clearTimers();
        if (socket) {
          try {
            socket.close();
          } catch (_err) {
            // ignore
          }
        }
        break;
      case 'ping':
        send({ type: 'pong', t: typeof msg.t === 'number' ? msg.t : getNow() });
        break;
      default:
        // Phase 4 message types are dispatched to the command handler.
        break;
    }

    if (
      msg.type !== 'auth.ok' &&
      msg.type !== 'auth.error' &&
      msg.type !== 'ping' &&
      msg.type !== 'pong' &&
      onMessage
    ) {
      onMessage(msg);
    }
  }

  function scheduleReconnect(reason) {
    if (stopped || permanentFail) return;
    state.reconnectCount += 1;
    const wait = nextDelay();
    log('reconnect in', wait, 'ms', reason || '');
    setTimeout(() => connect(), wait);
  }

  function connect() {
    if (stopped || permanentFail) return;
    if (socket && (socket.readyState === 0 || socket.readyState === OPEN)) return;

    state.phase = 'connecting';
    state.connected = false;
    state.authenticated = false;
    state.error = null;
    log('connecting', url);

    let sock;
    try {
      sock = new WebSocketCtor(url, undefined, { headers });
    } catch (err) {
      scheduleReconnect('connect_failed');
      return;
    }
    socket = sock;

    sock.onopen = () => {
      state.phase = 'auth_pending';
      state.connected = true;
      send({ type: 'auth', token: String(token), version });
      authTimer = setTimeout(() => {
        log('auth timeout; closing socket');
        try {
          sock.close();
        } catch (_err) {
          // ignore
        }
      }, authTimeoutMs);
    };

    sock.onmessage = (ev) => {
      handleMessage(ev.data);
    };

    sock.onerror = () => {
      // 'close' always follows.
    };

    sock.onclose = () => {
      const wasAuthenticated = state.authenticated;
      clearTimers();
      state.connected = false;
      state.authenticated = false;
      if (typeof onDisconnect === 'function') onDisconnect();
      if (permanentFail) return; // keep phase 'auth_rejected'
      state.phase = 'disconnected';
      if (wasAuthenticated) log('connection lost');
      scheduleReconnect('closed');
    };
  }

  function start() {
    stopped = false;
    permanentFail = false;
    state.reconnectCount = 0;
    connect();
  }

  function stop() {
    stopped = true;
    clearTimers();
    if (socket) {
      try {
        socket.close();
      } catch (_err) {
        // ignore
      }
    }
    state.connected = false;
    state.authenticated = false;
    state.phase = 'stopped';
  }

  function reconnect() {
    stopped = false;
    permanentFail = false;
    clearTimers();
    if (socket) {
      try {
        socket.close();
      } catch (_err) {
        // ignore
      }
    }
    state.reconnectCount = 0;
    connect();
  }

  return { start, stop, reconnect, send, get state() { return state; } };
}

/* ===================================================================== *
 *  Exports (Node) / browser bootstrap
 * ===================================================================== */

const api = {
  BUILD,
  PROTOCOL_VERSION,
  SESSION_REFRESH_MS,
  CLIENT_ERRORS,
  nonEmpty,
  firstNonEmpty,
  stripKgTagWrapper,
  parseSearchResponse,
  normalizeSearchResponse,
  extractFirstSong,
  isPlayerControl,
  getVueApp,
  getRouter,
  playerFromRouteProxy,
  getPlayerControlFromApp,
  getPlayerControl,
  waitForVueApp,
  waitForPlayerControl,
  waitForPlayerControlFromApp,
  delay,
  buildAuthHeaders,
  buildSearchRequest,
  defaultSearch,
  getMoeAuthStore,
  readDeviceFromMoeData,
  mergeSessionIntoMoeData,
  refreshLoginSession,
  createSessionRecoverer,
  createRecoverySearch,
  createCommandHandler,
  probeCurrent,
  probeAllRoutes,
  createWsClient
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}

/* ===================================================================== *
 *  Browser-only runtime
 * ===================================================================== */
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  let ws = null;
  let commandHandler = null;
  let lastRefreshAt = 0;
  let lastRecovery = null;
  const pendingReauth = new Map();
  let ensureConnectedNow = () => {};

  async function maybeRefresh() {
    const now = Date.now();
    if (now - lastRefreshAt < SESSION_REFRESH_MS) return { ok: true, skipped: true };
    const result = await refreshLoginSession();
    if (result.ok || result.code === 'SESSION_EXPIRED') lastRefreshAt = now;
    return result;
  }

  function wsReauth(device, timeoutMs) {
    const wait = timeoutMs || 15000;
    if (!ws || !ws.state.authenticated) {
      return Promise.resolve({ ok: false, code: 'UPSTREAM_UNAVAILABLE', detail: 'ws-not-connected' });
    }
    const reqId =
      'reauth-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (pendingReauth.has(reqId)) {
          pendingReauth.delete(reqId);
          resolve({ ok: false, code: 'TIMEOUT' });
        }
      }, wait);
      pendingReauth.set(reqId, (result) => {
        clearTimeout(timer);
        pendingReauth.delete(reqId);
        resolve(result);
      });
      ws.send({ type: 'session.reauth.req', reqId, device });
    });
  }

  const recoverer = createSessionRecoverer({
    refresh: () => refreshLoginSession(),
    reauth: async (device) => {
      const result = await wsReauth(device);
      if (result && result.ok === true && result.session) {
        mergeSessionIntoMoeData(result.session);
      }
      return result;
    },
    readDevice: () => readDeviceFromMoeData(),
    log
  });

  async function runRecovery() {
    const result = await recoverer.recover();
    lastRecovery = {
      ok: result && result.ok === true,
      code: result && result.ok !== true && result.code ? result.code : undefined,
      at: Date.now()
    };
    return result;
  }

  const recoverySearch = createRecoverySearch({
    search: async (query) => {
      await maybeRefresh();
      return defaultSearch(query);
    },
    recover: () => runRecovery(),
    navigate: (path) => {
      const router = getRouter(getVueApp());
      if (router && typeof router.push === 'function') router.push(path);
    }
  });

  try {
    const hostname =
      typeof location !== 'undefined' && location.hostname
        ? location.hostname
        : '127.0.0.1';
    const wsUrl = 'ws://' + hostname + ':' + BUILD.CONTROL_PORT + BUILD.WS_PATH;
    commandHandler = createCommandHandler({
      search: recoverySearch,
      refresh: null,
      getPlayer: () => waitForPlayerControl({ timeoutMs: 15000 }),
      send: (obj) => {
        if (ws) ws.send(obj);
      },
      log
    });
    ws = createWsClient({
      WebSocketCtor: globalThis.WebSocket,
      url: wsUrl,
      token: BUILD.WS_TOKEN,
      version: PROTOCOL_VERSION,
      onAuthError: (reason) => {
        if (reason === 'protocol_mismatch') {
          log('protocol mismatch — refresh the WebUI to load the updated control client');
        }
      },
      onMessage: (msg) => {
        if (msg && msg.type === 'session.reauth.res') {
          const settle = pendingReauth.get(msg.reqId);
          if (settle) {
            pendingReauth.delete(msg.reqId);
            settle(
              msg.ok === true
                ? { ok: true, session: msg.session }
                : { ok: false, code: msg.error || 'UPSTREAM_UNAVAILABLE' }
            );
          }
          return;
        }
        commandHandler.handleMessage(msg);
      },
      onDisconnect: () => {
        for (const [reqId, settle] of pendingReauth) {
          pendingReauth.delete(reqId);
          settle({ ok: false, code: 'UPSTREAM_UNAVAILABLE', detail: 'ws-disconnected' });
        }
      },
      log
    });
    ws.start();
    setTimeout(() => {
      if (document.visibilityState === 'visible') maybeRefresh();
    }, 5000);
    setInterval(() => {
      if (document.visibilityState === 'visible') maybeRefresh();
    }, SESSION_REFRESH_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') maybeRefresh();
    });

    // Phase 7: after iPadOS freezes the page, a system Play / reopen wakes it.
    // Wake events force an immediate reconnect so a queued offline command is
    // dispatched without waiting out the reconnect backoff. Idempotent: only
    // acts when the socket is not already in a healthy authenticated state.
    let lastWakeReconnect = 0;
    ensureConnectedNow = () => {
      if (!ws) return;
      const phase = ws.state.phase;
      if (phase === 'stopped' || phase === 'auth_rejected' || phase === 'ready') return;
      const now = Date.now();
      if (now - lastWakeReconnect < 500) return;
      lastWakeReconnect = now;
      log('wake event; forcing reconnect');
      ws.reconnect();
    };
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') ensureConnectedNow();
    });
    document.addEventListener('pageshow', ensureConnectedNow);
    window.addEventListener('online', ensureConnectedNow);
    window.addEventListener('focus', ensureConnectedNow);
    log('ws url', wsUrl);
  } catch (err) {
    log('ws init failed:', String((err && err.message) || err));
  }

  const facade = {
    get version() {
      return BUILD.VERSION;
    },
    get protocol() {
      return ws ? ws.state.protocol : PROTOCOL_VERSION;
    },
    get connected() {
      return ws ? ws.state.connected : false;
    },
    get authenticated() {
      return ws ? ws.state.authenticated : false;
    },
    get paired() {
      return ws ? ws.state.paired : false;
    },
    get controller() {
      return ws ? ws.state.controller : false;
    },
    get wsState() {
      return ws ? ws.state.phase : 'unavailable';
    },
    get playerReady() {
      return !!getPlayerControl();
    },
    get route() {
      const app = getVueApp();
      const router = getRouter(app);
      const current = router && router.currentRoute ? router.currentRoute.value : null;
      return current ? String(current.name || current.path || '') : '';
    },
    get lastCommand() {
      return commandHandler ? commandHandler.state.lastCommand : null;
    },
    get lastSong() {
      return commandHandler ? commandHandler.state.lastSong : null;
    },
    get lastAck() {
      return commandHandler ? commandHandler.state.lastAck : null;
    },
    get lastError() {
      if (
        ws &&
        ws.state.error &&
        (ws.state.phase === 'protocol_mismatch' || ws.state.phase === 'auth_rejected')
      ) {
        return ws.state.error;
      }
      return commandHandler ? commandHandler.state.lastError : null;
    },
    get reconnectCount() {
      return ws ? ws.state.reconnectCount : 0;
    },
    get lastMessageAt() {
      return ws ? ws.state.lastMessageAt : null;
    },
    probe: () => probeCurrent(),
    probeAll: () => probeAllRoutes(),
    getPlayerControl: () => getPlayerControl(),
    play: (query) => {
      if (!commandHandler) return Promise.reject(new Error('unavailable'));
      return commandHandler.play(String(query || '').trim());
    },
    refreshSession: () => refreshLoginSession(),
    get sessionState() {
      return {
        paired: ws ? ws.state.paired : false,
        controller: ws ? ws.state.controller : false,
        lastRefreshAt,
        lastRecovery
      };
    },
    recoverSession: () =>
      runRecovery().then((result) =>
        result && result.ok === true
          ? { ok: true }
          : { ok: false, code: result && result.code ? result.code : 'UPSTREAM_UNAVAILABLE' }
      ),
    snapshot: () => ({
      version: BUILD.VERSION,
      connected: facade.connected,
      authenticated: facade.authenticated,
      wsState: facade.wsState,
      playerReady: facade.playerReady,
      route: facade.route,
      lastError: facade.lastError
    }),
    reconnect: () => {
      if (ws) {
        ws.reconnect();
        return true;
      }
      return false;
    },
    ensureConnectedNow: () => {
      ensureConnectedNow();
      return true;
    }
  };

  try {
    Object.defineProperty(window, '__siri', {
      enumerable: false,
      configurable: false,
      value: facade
    });
  } catch (_err) {
    // no-op: facade is best-effort
  }

  log('loaded v' + BUILD.VERSION, 'protocol', PROTOCOL_VERSION);
}