import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  derivePairValue,
  verifyPairCookie,
  createPairingLimiter,
  PAIR_COOKIE
} from '../server/pairing.js';

const SECRET = 'a'.repeat(32);

test('derivePairValue is deterministic per secret', () => {
  const a = derivePairValue(SECRET);
  const b = derivePairValue(SECRET);
  assert.equal(a, b);
  assert.notEqual(a, derivePairValue('b'.repeat(32)));
});

test('verifyPairCookie accepts a valid cookie header', () => {
  const value = derivePairValue(SECRET);
  assert.equal(verifyPairCookie(`${PAIR_COOKIE}=${value}; other=1`, SECRET), true);
});

test('verifyPairCookie rejects wrong value / wrong secret / missing cookie', () => {
  const value = derivePairValue(SECRET);
  assert.equal(verifyPairCookie(`${PAIR_COOKIE}=${value}`, 'wrong-secret'), false);
  assert.equal(verifyPairCookie(`${PAIR_COOKIE}=forged`, SECRET), false);
  assert.equal(verifyPairCookie('other=1', SECRET), false);
  assert.equal(verifyPairCookie('', SECRET), false);
  assert.equal(verifyPairCookie(undefined, SECRET), false);
});

test('createPairingLimiter allows up to limit hits then blocks within the window', () => {
  const limiter = createPairingLimiter({ limit: 5, windowMs: 60000 });
  for (let i = 0; i < 5; i += 1) {
    assert.equal(limiter.allow('192.168.10.5'), true, `hit ${i}`);
  }
  assert.equal(limiter.allow('192.168.10.5'), false, '6th hit blocked');
  assert.equal(limiter.allow('192.168.10.6'), true, 'different IP unaffected');
});

test('limiter window slides: old hits expire', () => {
  let now = 0;
  const limiter = createPairingLimiter({ limit: 2, windowMs: 1000, getNow: () => now });
  assert.equal(limiter.allow('ip'), true);
  assert.equal(limiter.allow('ip'), true);
  assert.equal(limiter.allow('ip'), false);
  now += 1001;
  assert.equal(limiter.allow('ip'), true, 'old hits expired');
});

test('limiter reset clears entries', () => {
  const limiter = createPairingLimiter({ limit: 1, windowMs: 60000 });
  assert.equal(limiter.allow('ip'), true);
  assert.equal(limiter.allow('ip'), false);
  limiter.reset('ip');
  assert.equal(limiter.allow('ip'), true);
});