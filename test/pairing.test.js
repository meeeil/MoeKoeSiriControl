import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  derivePairValue,
  makePairCookieValue,
  parsePairCookie,
  verifyPairCookie,
  createPairingLimiter,
  PAIR_COOKIE
} from '../server/pairing.js';

const SECRET = 'a'.repeat(32);
const DEVICE_ID = 'device-uuid-1';

test('derivePairValue is deterministic per secret and deviceId', () => {
  const a = derivePairValue(SECRET, DEVICE_ID);
  const b = derivePairValue(SECRET, DEVICE_ID);
  assert.equal(a, b);
  assert.notEqual(a, derivePairValue('b'.repeat(32), DEVICE_ID));
  assert.notEqual(a, derivePairValue(SECRET, 'other-device'));
});

test('makePairCookieValue returns <deviceId>.<signature>', () => {
  const value = makePairCookieValue(SECRET, DEVICE_ID);
  assert.ok(value.startsWith(DEVICE_ID + '.'));
  const sig = value.slice(DEVICE_ID.length + 1);
  assert.equal(sig, derivePairValue(SECRET, DEVICE_ID));
  assert.ok(sig.length >= 32);
});

test('parsePairCookie accepts a valid cookie and returns the deviceId', () => {
  const value = makePairCookieValue(SECRET, DEVICE_ID);
  const parsed = parsePairCookie(`${PAIR_COOKIE}=${value}; other=1`, SECRET);
  assert.deepEqual(parsed, { deviceId: DEVICE_ID });
});

test('parsePairCookie rejects wrong value / wrong secret / missing / malformed', () => {
  const value = makePairCookieValue(SECRET, DEVICE_ID);
  assert.equal(parsePairCookie(`${PAIR_COOKIE}=${value}`, 'wrong-secret'), null);
  assert.equal(parsePairCookie(`${PAIR_COOKIE}=forged.device.signature`, SECRET), null);
  assert.equal(parsePairCookie(`${PAIR_COOKIE}=${value.slice(0, -1)}x`, SECRET), null);
  assert.equal(parsePairCookie(`${PAIR_COOKIE}=no-dot-separator`, SECRET), null);
  assert.equal(parsePairCookie(`${PAIR_COOKIE}=.missingdevice${derivePairValue(SECRET, '')}`, SECRET), null);
  assert.equal(parsePairCookie('other=1', SECRET), null);
  assert.equal(parsePairCookie('', SECRET), null);
  assert.equal(parsePairCookie(undefined, SECRET), null);
});

test('verifyPairCookie stays true/false for valid/invalid cookies', () => {
  const value = makePairCookieValue(SECRET, DEVICE_ID);
  assert.equal(verifyPairCookie(`${PAIR_COOKIE}=${value}`, SECRET), true);
  assert.equal(verifyPairCookie(`${PAIR_COOKIE}=${value}`, 'wrong-secret'), false);
  assert.equal(verifyPairCookie(`${PAIR_COOKIE}=forged`, SECRET), false);
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