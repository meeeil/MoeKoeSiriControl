/**
 * Session recovery: password login to the MoeKoeMusic API, guarded by a
 * circuit breaker.
 *
 * When the iPad's KuGou token is dead (login_by_token returns 152 or there is
 * no token at all), the Windows server logs in on behalf of the iPad using the
 * KuGou account credentials held in `.env` (KUGOU_USERNAME / KUGOU_PASSWORD).
 * The result carries only the session fields the client needs; the raw
 * credentials never appear in logs, status output, or client messages.
 *
 * POST /login (JSON body) is used instead of the WebUI's
 * `/login?username=..&password=..` query-string form so credentials never
 * travel in a URL.
 *
 * Circuit breaker (Phase 6):
 *   state        meaning
 *   ready        normal operation
 *   cooldown     transient failure (UPSTREAM_UNAVAILABLE / TIMEOUT); retries
 *                are suppressed until cooldownUntil
 *   hard_stopped AUTH_REJECTED / RISK_REQUIRED; retries are suppressed until
 *                reset() (an admin action) — retrying bad credentials or a
 *                risk-locked account just burns budget and can harden the lock
 *
 * Guards:
 *  - single-flight: concurrent `login()` calls share one upstream login
 *  - hourly budget: at most `budget` real upstream logins per rolling hour
 *  - success clears the budget and returns the state to ready
 *  - timeout: each login request is aborted after timeoutMs
 *
 * Error codes (subset of the WS reauth protocol):
 *   NOT_CONFIGURED       credentials missing in .env
 *   RISK_REQUIRED        Kugou asked for a captcha / SMS check (error 20028
 *                        or an ssaCode payload); the iPad must verify manually
 *   AUTH_REJECTED        wrong credentials or the account refused this login
 *   UPSTREAM_UNAVAILABLE the MoeKoeMusic API was unreachable / non-JSON
 *   TIMEOUT              the login request exceeded timeoutMs
 *   BUDGET_EXCEEDED      the hourly upstream-login budget is exhausted
 */
import config from './config.js';
import fs from 'node:fs';
import path from 'node:path';

export const SESSION_AUTH_ERRORS = Object.freeze([
  'PAIR_REQUIRED',
  'NOT_CONFIGURED',
  'RISK_REQUIRED',
  'AUTH_REJECTED',
  'UPSTREAM_UNAVAILABLE',
  'TIMEOUT',
  'BUDGET_EXCEEDED'
]);

const HARD_STOP_CODES = new Set(['AUTH_REJECTED', 'RISK_REQUIRED']);

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * @param {object} opts
 * @param {string} [opts.username]      KuGou account
 * @param {string} [opts.password]      KuGou password
 * @param {string} [opts.sessionFilePath] file path to persist session
 * @param {string} [opts.apiBase]       MoeKoeMusic API base (default config)
 * @param {number} [opts.timeoutMs]      login timeout (default 15000)
 * @param {number} [opts.cooldownMs]     transient-failure cooldown (default 60000)
 * @param {number} [opts.budget]         upstream logins allowed per rolling hour (default 5)
 * @param {number} [opts.budgetWindowMs] budget window length (default 3600000)
 * @param {() => number} [opts.getNow]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {(...args: unknown[]) => void} [opts.log]
 */
export function createSessionAuth({
  username,
  password,
  apiBase = config.MOEKOE_API_URL,
  sessionFilePath = null,
  timeoutMs = 15000,
  cooldownMs = 60000,
  budget = 5,
  budgetWindowMs = 3600000,
  getNow = () => Date.now(),
  fetchImpl = fetch,
  log = () => {}
} = {}) {
  let inFlight = null;
  let state = 'ready';
  let cooldownUntil = 0;
  let lastFailure = null;
  let cachedSession = null;
  const attempts = []; // timestamps of real upstream logins

  if (sessionFilePath && fs.existsSync(sessionFilePath)) {
    try {
      const raw = fs.readFileSync(sessionFilePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.token === 'string' && parsed.token.length > 0) {
        cachedSession = parsed;
        log('session-auth: loaded persisted server session');
      }
    } catch (_err) {
      log('session-auth: failed to read session.json');
    }
  }

  function saveSession(session) {
    if (!session || typeof session.token !== 'string' || session.token.length === 0) return false;
    cachedSession = {
      token: String(session.token),
      t1: session.t1 ? String(session.t1) : '',
      userid: session.userid != null ? String(session.userid) : '',
      nickname: session.nickname ? String(session.nickname) : '酷狗用户',
      pic: session.pic ? String(session.pic) : './assets/images/profile.jpg',
      vip_type: session.vip_type != null ? Number(session.vip_type) : 0,
      vip_token: session.vip_token ? String(session.vip_token) : ''
    };
    if (sessionFilePath) {
      try {
        const dir = path.dirname(sessionFilePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(sessionFilePath, JSON.stringify(cachedSession, null, 2), 'utf8');
        log('session-auth: saved server session');
      } catch (err) {
        log('session-auth: failed to write session.json', err.message);
      }
    }
    return true;
  }

  function isConfigured() {
    return (cachedSession && nonEmpty(cachedSession.token)) || (nonEmpty(username) && nonEmpty(password));
  }

  function pruneAttempts(now) {
    const cutoff = now - budgetWindowMs;
    for (let i = attempts.length - 1; i >= 0; i -= 1) {
      if (attempts[i] < cutoff) attempts.splice(i, 1);
    }
  }

  // Returns null for success, otherwise one of the SESSION_AUTH_ERRORS.
  function classify(payload) {
    const data = (payload && payload.data) || {};
    const errorCode = Number(payload?.error_code ?? data.error_code ?? 0);
    const status = Number(payload?.status ?? data.status ?? 0);
    const ssa = String(data.ssaCode || data.ssa_code || payload?.ssaCode || '');
    if (errorCode === 20028 || (status === 0 && nonEmpty(ssa))) {
      return 'RISK_REQUIRED';
    }
    if (status === 1 && nonEmpty(data.token)) {
      return null;
    }
    return 'AUTH_REJECTED';
  }

  function fail(code, detail) {
    const failure = { ok: false, code, detail };
    lastFailure = failure;
    if (HARD_STOP_CODES.has(code)) {
      state = 'hard_stopped';
      cooldownUntil = getNow() + cooldownMs;
    } else {
      state = 'cooldown';
      cooldownUntil = getNow() + cooldownMs;
    }
    return failure;
  }

  function clearState(now) {
    state = 'ready';
    cooldownUntil = 0;
    lastFailure = null;
    attempts.length = 0;
    log('session-auth: circuit reset after success');
  }

  async function doLogin(device = {}) {
    const startedAt = getNow();
    const cookie = {};
    if (nonEmpty(device.dfid)) cookie.dfid = device.dfid;
    if (nonEmpty(device.mid)) cookie.KUGOU_API_MID = device.mid;
    if (nonEmpty(device.guid)) cookie.KUGOU_API_GUID = device.guid;
    if (nonEmpty(device.serverDev)) cookie.KUGOU_API_DEV = device.serverDev;
    if (nonEmpty(device.mac)) cookie.KUGOU_API_MAC = device.mac;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(`${apiBase}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, cookie }),
        signal: controller.signal
      });
    } catch (err) {
      if (err && err.name === 'AbortError') {
        log('session-auth: login timeout after', timeoutMs, 'ms');
        return fail('TIMEOUT', 'login-timeout');
      }
      log('session-auth: login network error', String((err && err.name) || err));
      return fail('UPSTREAM_UNAVAILABLE', 'network:' + String((err && err.name) || 'error'));
    } finally {
      clearTimeout(timer);
    }

    if (res.status !== 200) {
      log('session-auth: login http', res.status);
      return fail('UPSTREAM_UNAVAILABLE', 'http=' + res.status);
    }

    let text = '';
    try {
      text = await res.text();
    } catch (_err) {
      // fall through to the non-JSON path
    }
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch (_err) {
      log('session-auth: non-JSON login response');
      return fail('UPSTREAM_UNAVAILABLE', 'http=' + res.status);
    }

    const kind = classify(payload);
    if (kind === null) {
      const d = payload.data;
      const session = {
        token: String(d.token),
        t1: nonEmpty(d.t1) ? String(d.t1) : '',
        userid: d.userid != null ? String(d.userid) : '',
        nickname: nonEmpty(d.nickname) ? String(d.nickname) : (nonEmpty(device.nickname) ? device.nickname : '酷狗用户'),
        pic: nonEmpty(d.pic) ? String(d.pic) : (nonEmpty(device.pic) ? device.pic : './assets/images/profile.jpg'),
        vip_type: d.vip_type != null ? Number(d.vip_type) : 0,
        vip_token: nonEmpty(d.vip_token) ? String(d.vip_token) : ''
      };

      cachedSession = session;
      clearState(getNow());
      log('session-auth: login ok in', getNow() - startedAt, 'ms');
      return { ok: true, session };
    }

    const errorCode = Number(payload?.error_code ?? payload?.data?.error_code ?? 0);
    log('session-auth: login rejected', kind, 'error_code=' + errorCode);
    return fail(kind, 'error_code=' + errorCode);
  }

  function login(device = {}) {
    if (!isConfigured()) {
      return Promise.resolve({ ok: false, code: 'NOT_CONFIGURED', detail: 'missing-credentials' });
    }
    if (inFlight) return inFlight;
    const now = getNow();
    if (state === 'hard_stopped') {
      return Promise.resolve(lastFailure || { ok: false, code: 'AUTH_REJECTED', detail: 'hard-stopped' });
    }
    if (state === 'cooldown' && now < cooldownUntil) {
      return Promise.resolve(lastFailure || { ok: false, code: 'UPSTREAM_UNAVAILABLE', detail: 'cooldown' });
    }
    pruneAttempts(now);
    if (attempts.length >= budget) {
      log('session-auth: hourly budget exhausted (', attempts.length, '/', budget, ')');
      return Promise.resolve({ ok: false, code: 'BUDGET_EXCEEDED', detail: 'budget-exhausted' });
    }
    attempts.push(now);
    inFlight = doLogin(device).finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  function reset() {
    state = 'ready';
    cooldownUntil = 0;
    lastFailure = null;
    attempts.length = 0;
  }

  function status() {
    const now = getNow();
    pruneAttempts(now);
    return {
      configured: isConfigured(),
      state,
      lastError: lastFailure ? lastFailure.code : null,
      cooldownUntil,
      attemptsRemaining: Math.max(0, budget - attempts.length)
    };
  }

  function getCachedSession() {
    return cachedSession;
  }

  function getSession(device = {}) {
    if (cachedSession && nonEmpty(cachedSession.token)) {
      return Promise.resolve({ ok: true, session: cachedSession });
    }
    return login(device);
  }

  return { login, getSession, getCachedSession, saveSession, reset, isConfigured, status };
}