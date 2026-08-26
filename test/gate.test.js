import test from 'node:test';
import assert from 'node:assert/strict';
import { GATE_COOKIE, makeGateCookieValue, parseGateCookie } from '../server/pairing.js';

const TEST_HTTP_TOKEN = '12345678901234567890123456789012';
const TEST_GATE_PASS = 'vm7o3in34';

test('parseGateCookie accepts valid cookie and rejects invalid', () => {
  const cookie = makeGateCookieValue(TEST_HTTP_TOKEN, TEST_GATE_PASS);
  assert.equal(parseGateCookie(`${GATE_COOKIE}=${cookie}`, TEST_HTTP_TOKEN, TEST_GATE_PASS), true);
  assert.equal(parseGateCookie(`${GATE_COOKIE}=wrong`, TEST_HTTP_TOKEN, TEST_GATE_PASS), false);
  assert.equal(parseGateCookie('', TEST_HTTP_TOKEN, TEST_GATE_PASS), false);
  assert.equal(parseGateCookie('siri_pair=abc', TEST_HTTP_TOKEN, TEST_GATE_PASS), false);
  assert.equal(parseGateCookie('', TEST_HTTP_TOKEN, ''), true); // Gate open if no password
});
