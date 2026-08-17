import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAuthOk,
  buildAuthError,
  buildPing,
  buildPong,
  safeTokenEqual,
  parseControlMessage
} from '../server/protocol.js';

test('message builders produce the documented shapes', () => {
  assert.deepEqual(buildAuthOk(1), { type: 'auth.ok', version: 1 });
  assert.deepEqual(buildAuthError('invalid_token'), { type: 'auth.error', reason: 'invalid_token' });
  assert.deepEqual(buildPing(123), { type: 'ping', t: 123 });
  assert.deepEqual(buildPong(123), { type: 'pong', t: 123 });
});

test('safeTokenEqual matches equal tokens and rejects different ones', () => {
  const a = 'x'.repeat(64);
  assert.ok(safeTokenEqual(a, a));
  assert.ok(!safeTokenEqual(a, a.slice(0, -1) + 'y'));
  assert.ok(!safeTokenEqual('short-a', 'short-b'));
});

test('parseControlMessage accepts a valid object', () => {
  const msg = parseControlMessage('{"type":"auth","token":"t","version":1}');
  assert.deepEqual(msg, { type: 'auth', token: 't', version: 1 });
});

test('parseControlMessage rejects malformed payloads', () => {
  assert.equal(parseControlMessage('not json'), null);
  assert.equal(parseControlMessage('null'), null);
  assert.equal(parseControlMessage('42'), null);
  assert.equal(parseControlMessage('{"noType":1}'), null);
  assert.equal(parseControlMessage('[]'), null);
  assert.equal(parseControlMessage(''), null);
});