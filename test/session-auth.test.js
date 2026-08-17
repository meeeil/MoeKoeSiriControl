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
    'TIMEOUT'
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

test('AUTH_REJECTED triggers 60s cooldown: repeated login does not hit upstream', async () => {
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
  assert.equal(calls, 1, 'cooldown suppresses the second upstream attempt');
});

test('cooldown expires -> upstream is contacted again', async () => {
  let calls = 0;
  let now = 0;
  const auth = createSessionAuth({
    username: 'u',
    password: 'wrong',
    getNow: () => now,
    fetchImpl: async () => {
      calls += 1;
      return jsonFetch({ status: 0, error_code: 20017, data: null })();
    }
  });
  await auth.login(device);
  assert.equal(calls, 1);
  now += 61000;
  await auth.login(device);
  assert.equal(calls, 2);
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

test('successful login clears cooldown state for the next attempt', async () => {
  let now = 0;
  let calls = 0;
  const auth = createSessionAuth({
    username: 'u',
    password: 'p',
    getNow: () => now,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return jsonFetch({ status: 0, error_code: 20017, data: null })();
      return jsonFetch({ status: 1, data: { token: 't2' } })();
    }
  });
  const r1 = await auth.login(device);
  assert.equal(r1.code, 'AUTH_REJECTED');
  now += 61000;
  const r2 = await auth.login(device);
  assert.equal(r2.ok, true);
  assert.equal(r2.session.token, 't2');
  const r3 = await auth.login(device);
  assert.equal(r3.ok, true, 'a success must not re-enter cooldown');
  assert.equal(calls, 3);
});

test('reset() clears cooldown immediately', async () => {
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