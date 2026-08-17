import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionAuth, SESSION_AUTH_ERRORS } from '../server/session-auth.js';

function jsonFetch(payload, { status = 200, delayMs = 0 } = {}) {
  return async () => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    return {
      status,
      text: async () => JSON.stringify(payload)
    };
  };
}

const device = { dfid: 'df', mid: 'm', guid: 'g', serverDev: 'sd', mac: 'ma' };

test('session-auth exports only the documented error codes', () => {
  assert.deepEqual([...SESSION_AUTH_ERRORS], [
    'PAIR_REQUIRED',
    'NOT_CONFIGURED',
    'RISK_REQUIRED',
    'AUTH_REJECTED',
    'UPSTREAM_UNAVAILABLE',
    'TIMEOUT',
    'BUDGET_EXCEEDED'
  ]);
});

test('successful login returns a sanitized session (no password/username)', async () => {
  let sentBody = null;
  const auth = createSessionAuth({
    username: 'kugou-user',
    password: 'secret',
    fetchImpl: async (url, opts) => {
      sentBody = JSON.parse(opts.body);
      return jsonFetch({
        status: 1,
        data: { token: 'tok123', t1: 't1v', userid: 42, vip_type: 1, vip_token: 'vt' }
      })();
    }
  });
  const result = await auth.login(device);
  assert.equal(result.ok, true);
  assert.equal(result.session.token, 'tok123');
  assert.equal(result.session.t1, 't1v');
  assert.equal(result.session.userid, '42');
  assert.equal(result.session.vip_type, 1);
  assert.equal(result.session.vip_token, 'vt');
  assert.equal(Object.prototype.hasOwnProperty.call(result.session, 'username'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result.session, 'password'), false);
  assert.equal(sentBody.username, 'kugou-user');
  assert.equal(sentBody.password, 'secret');
  assert.deepEqual(sentBody.cookie, {
    dfid: 'df',
    KUGOU_API_MID: 'm',
    KUGOU_API_GUID: 'g',
    KUGOU_API_DEV: 'sd',
    KUGOU_API_MAC: 'ma'
  });
});

test('POST goes to the login route with a JSON body (never query string)', async () => {
  let url;
  const auth = createSessionAuth({
    username: 'u',
    password: 'p',
    fetchImpl: async (u) => {
      url = u;
      return jsonFetch({ status: 1, data: { token: 't' } })();
    }
  });
  await auth.login(device);
  assert.equal(url, 'http://127.0.0.1:6521/login');
});

test('missing credentials -> NOT_CONFIGURED, no upstream call', async () => {
  let called = false;
  const auth = createSessionAuth({
    username: '',
    password: '',
    fetchImpl: async () => {
      called = true;
      return jsonFetch({ status: 1, data: { token: 't' } })();
    }
  });
  const result = await auth.login(device);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NOT_CONFIGURED');
  assert.equal(called, false);
});

test('risk payload (error_code 20028) -> RISK_REQUIRED', async () => {
  const auth = createSessionAuth({
    username: 'u',
    password: 'p',
    fetchImpl: jsonFetch({ status: 0, error_code: 20028, data: { ssaCode: 'gz_tx_event_x' } })
  });
  const result = await auth.login(device);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'RISK_REQUIRED');
  assert.match(result.detail, /error_code=20028/);
});

test('risk payload (ssa_code without 20028) -> RISK_REQUIRED', async () => {
  const auth = createSessionAuth({
    username: 'u',
    password: 'p',
    fetchImpl: jsonFetch({ status: 0, error_code: 999, data: { ssa_code: 'abc' } })
  });
  const result = await auth.login(device);
  assert.equal(result.code, 'RISK_REQUIRED');
});

test('wrong password (status 0, no ssa) -> AUTH_REJECTED', async () => {
  const auth = createSessionAuth({
    username: 'u',
    password: 'wrong',
    fetchImpl: jsonFetch({ status: 0, error_code: 20017, data: null })
  });
  const result = await auth.login(device);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'AUTH_REJECTED');
});

test('AUTH_REJECTED hard-stops: retries are suppressed until reset()', async () => {
  let calls = 0;
  const auth = createSessionAuth({
    username: 'u',
    password: 'wrong',
    fetchImpl: async () => {
      calls += 1;
      return jsonFetch({ status: 0, error_code: 20017, data: null })();
    }
  });
  const r1 = await auth.login(device);
  assert.equal(r1.code, 'AUTH_REJECTED');
  const r2 = await auth.login(device);
  assert.equal(r2.code, 'AUTH_REJECTED');
  assert.equal(calls, 1, 'hard stop suppresses the second upstream attempt');
  assert.equal(auth.status().state, 'hard_stopped');
  auth.reset();
  const r3 = await auth.login(device);
  assert.equal(r3.code, 'AUTH_REJECTED');
  assert.equal(calls, 2, 'reset() re-enables upstream attempts');
});

test('RISK_REQUIRED hard-stops: retries are suppressed even after time passes', async () => {
  let calls = 0;
  let now = 0;
  const auth = createSessionAuth({
    username: 'u',
    password: 'p',
    getNow: () => now,
    fetchImpl: async () => {
      calls += 1;
      return jsonFetch({ status: 0, error_code: 20028, data: { ssaCode: 'gz_tx_event_x' } })();
    }
  });
  const r1 = await auth.login(device);
  assert.equal(r1.code, 'RISK_REQUIRED');
  now += 3600000;
  const r2 = await auth.login(device);
  assert.equal(r2.code, 'RISK_REQUIRED');
  assert.equal(calls, 1, 'risk stop is not a timed cooldown');
  assert.equal(auth.status().state, 'hard_stopped');
  auth.reset();
  await auth.login(device);
  assert.equal(calls, 2);
});

test('transient failure cooldown expires -> upstream is contacted again', async () => {
  let calls = 0;
  let now = 0;
  const auth = createSessionAuth({
    username: 'u',
    password: 'p',
    getNow: () => now,
    fetchImpl: async () => {
      calls += 1;
      throw new TypeError('Failed to fetch');
    }
  });
  const r1 = await auth.login(device);
  assert.equal(r1.code, 'UPSTREAM_UNAVAILABLE');
  assert.equal(auth.status().state, 'cooldown');
  const r2 = await auth.login(device);
  assert.equal(r2.code, 'UPSTREAM_UNAVAILABLE');
  assert.equal(calls, 1, 'cooldown suppresses the retry');
  now += 61000;
  await auth.login(device);
  assert.equal(calls, 2, 'cooldown expiry allows another attempt');
  assert.equal(auth.status().state, 'cooldown');
});

test('single-flight: concurrent logins produce exactly one upstream request', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const auth = createSessionAuth({
    username: 'u',
    password: 'p',
    fetchImpl: async () => {
      calls += 1;
      await gate;
      return jsonFetch({ status: 1, data: { token: 't' } })();
    }
  });
  const p1 = auth.login(device);
  const p2 = auth.login(device);
  const p3 = auth.login(device);
  release();
  const results = await Promise.all([p1, p2, p3]);
  assert.equal(calls, 1);
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, true);
  assert.equal(results[2].ok, true);
});

test('timeout aborts the login and reports TIMEOUT', async () => {
  const auth = createSessionAuth({
    username: 'u',
    password: 'p',
    timeoutMs: 30,
    fetchImpl: async (_url, opts) => {
      return new Promise((resolve, reject) => {
        const signal = opts && opts.signal;
        if (signal) {
          if (signal.aborted) {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            return;
          }
          signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          );
        }
        setTimeout(() => resolve(jsonFetch({ status: 1, data: { token: 't' } })()), 200);
      });
    }
  });
  const result = await auth.login(device);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TIMEOUT');
});

test('upstream unreachable (network error) -> UPSTREAM_UNAVAILABLE', async () => {
  const auth = createSessionAuth({
    username: 'u',
    password: 'p',
    fetchImpl: async () => {
      throw new TypeError('Failed to fetch');
    }
  });
  const result = await auth.login(device);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'UPSTREAM_UNAVAILABLE');
});

test('non-200 / non-JSON upstream -> UPSTREAM_UNAVAILABLE', async () => {
  const badStatus = createSessionAuth({
    username: 'u',
    password: 'p',
    fetchImpl: async () => ({ status: 502, text: async () => 'boom' })
  });
  assert.equal((await badStatus.login(device)).code, 'UPSTREAM_UNAVAILABLE');

  const nonJson = createSessionAuth({
    username: 'u',
    password: 'p',
    fetchImpl: async () => ({ status: 200, text: async () => 'not json' })
  });
  assert.equal((await nonJson.login(device)).code, 'UPSTREAM_UNAVAILABLE');
});

test('successful login clears breaker state for the next attempt', async () => {
  let now = 0;
  let calls = 0;
  const auth = createSessionAuth({
    username: 'u',
    password: 'p',
    getNow: () => now,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('Failed to fetch');
      return jsonFetch({ status: 1, data: { token: 't2' } })();
    }
  });
  const r1 = await auth.login(device);
  assert.equal(r1.code, 'UPSTREAM_UNAVAILABLE');
  now += 61000;
  const r2 = await auth.login(device);
  assert.equal(r2.ok, true);
  assert.equal(r2.session.token, 't2');
  assert.equal(auth.status().state, 'ready');
  const r3 = await auth.login(device);
  assert.equal(r3.ok, true, 'a success must not re-enter cooldown');
  assert.equal(calls, 3);
});

test('reset() clears hard_stopped immediately', async () => {
  let calls = 0;
  const auth = createSessionAuth({
    username: 'u',
    password: 'wrong',
    fetchImpl: async () => {
      calls += 1;
      return jsonFetch({ status: 0, error_code: 20017, data: null })();
    }
  });
  await auth.login(device);
  auth.reset();
  await auth.login(device);
  assert.equal(calls, 2);
});

test('hourly budget: at most 5 real upstream logins, 6th is BUDGET_EXCEEDED', async () => {
  let calls = 0;
  let now = 0;
  const auth = createSessionAuth({
    username: 'u',
    password: 'p',
    getNow: () => now,
    cooldownMs: 60000,
    budget: 5,
    budgetWindowMs: 3600000,
    fetchImpl: async () => {
      calls += 1;
      throw new TypeError('Failed to fetch');
    }
  });
  for (let i = 0; i < 5; i += 1) {
    const r = await auth.login(device);
    assert.equal(r.code, 'UPSTREAM_UNAVAILABLE');
    assert.equal(auth.status().attemptsRemaining, 4 - i);
    now += 61000;
  }
  assert.equal(calls, 5);
  const sixth = await auth.login(device);
  assert.equal(sixth.code, 'BUDGET_EXCEEDED');
  assert.equal(calls, 5, 'budget exhaustion must not hit upstream');

  now += 3600000;
  const seventh = await auth.login(device);
  assert.equal(seventh.code, 'UPSTREAM_UNAVAILABLE', 'window rollover restores budget');
  assert.equal(calls, 6);
});

test('a successful login clears the hourly budget', async () => {
  let calls = 0;
  let now = 0;
  const auth = createSessionAuth({
    username: 'u',
    password: 'p',
    getNow: () => now,
    cooldownMs: 60000,
    budget: 2,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('Failed to fetch');
      return jsonFetch({ status: 1, data: { token: 't' } })();
    }
  });
  assert.equal((await auth.login(device)).code, 'UPSTREAM_UNAVAILABLE');
  assert.equal(auth.status().attemptsRemaining, 1);
  now += 61000;
  const ok = await auth.login(device);
  assert.equal(ok.ok, true);
  assert.equal(auth.status().attemptsRemaining, 2, 'success resets the budget');
  assert.equal(auth.status().state, 'ready');
});

test('status() reports configured/state/lastError/cooldownUntil/attemptsRemaining', async () => {
  let now = 1000;
  const auth = createSessionAuth({
    username: 'u',
    password: 'p',
    getNow: () => now,
    fetchImpl: async () => {
      throw new TypeError('Failed to fetch');
    }
  });
  const idle = auth.status();
  assert.equal(idle.configured, true);
  assert.equal(idle.state, 'ready');
  assert.equal(idle.lastError, null);
  assert.equal(idle.cooldownUntil, 0);
  assert.equal(idle.attemptsRemaining, 5);

  await auth.login(device);
  const cooldown = auth.status();
  assert.equal(cooldown.state, 'cooldown');
  assert.equal(cooldown.lastError, 'UPSTREAM_UNAVAILABLE');
  assert.equal(cooldown.cooldownUntil, now + 60000);
  assert.equal(cooldown.attemptsRemaining, 4);

  const unconfigured = createSessionAuth({ username: '', password: '' }).status();
  assert.equal(unconfigured.configured, false);
});