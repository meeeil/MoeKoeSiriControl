import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPendingCoordinator } from '../server/pending.js';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

test('submit mints reqId + expiresAt and ack resolves the promise', async () => {
  let now = 1000;
  const pending = createPendingCoordinator({ ttlMs: 60000, getNow: () => now });
  const { reqId, expiresAt, promise } = pending.submit('七里香', { targetConnectionId: 'conn-1' });
  assert.equal(typeof reqId, 'string');
  assert.ok(reqId.length > 0);
  assert.equal(expiresAt, 61000);
  assert.equal(pending.count, 1);

  const ack = { reqId, ok: true, song: { hash: 'H1', name: '七里香' } };
  assert.equal(pending.handleAck(ack, 'conn-1'), true);
  assert.equal(await promise, ack);
  assert.equal(pending.count, 0);
});

test('an ack from a non-target connection is ignored with a warning', async () => {
  const warned = [];
  const pending = createPendingCoordinator({
    ttlMs: 60000,
    waitMs: 5000,
    log: (...args) => warned.push(args)
  });
  const { reqId, promise } = pending.submit('七里香', { targetConnectionId: 'conn-1' });
  const okAck = { reqId, ok: true, song: { hash: 'H1', name: '七里香' } };
  assert.equal(pending.handleAck(okAck, 'conn-2'), false, 'non-target ack must be ignored');
  assert.ok(warned.length >= 1, 'must log a warning');
  assert.equal(pending.count, 1, 'request must stay pending');
  assert.equal(await Promise.race([promise, sleep(30).then(() => 'pending')]), 'pending');
});

test('setTarget binds the reqId to the connection that received the play.req', async () => {
  const pending = createPendingCoordinator({ ttlMs: 60000, waitMs: 5000 });
  const { reqId, promise } = pending.submit('x');
  assert.equal(pending.setTarget(reqId, 'conn-7'), true);
  assert.equal(pending.handleAck({ reqId, ok: true }, 'conn-8'), false);
  assert.equal(pending.handleAck({ reqId, ok: true }, 'conn-7'), true);
  const ack = await promise;
  assert.equal(ack.ok, true);
});

test('submit resolves TIMEOUT when no ack arrives within waitMs', async () => {
  const pending = createPendingCoordinator({ ttlMs: 60000, waitMs: 50 });
  const { reqId, promise } = pending.submit('x');
  const ack = await promise;
  assert.deepEqual(ack, { ok: false, error: 'TIMEOUT' });
  assert.equal(pending.count, 0);
  // late ack for the same reqId is ignored
  assert.equal(pending.handleAck({ reqId, ok: true }, 'conn-1'), false);
});

test('handleAck with unknown reqId returns false', () => {
  const pending = createPendingCoordinator();
  assert.equal(pending.handleAck({ reqId: 'nope', ok: true }, 'conn-1'), false);
});

test('expired pending entries are pruned', () => {
  let now = 0;
  const pending = createPendingCoordinator({ ttlMs: 100, getNow: () => now });
  const { reqId, promise } = pending.submit('x');
  now = 200;
  assert.equal(pending.prune(), 0);
  return promise.then((ack) => {
    assert.equal(ack.ok, false);
    assert.equal(ack.error, 'PENDING_EXPIRED');
    assert.equal(reqId.length > 0, true);
  });
});

test('list reports pending items with remaining time', async () => {
  const pending = createPendingCoordinator({ ttlMs: 60000 });
  pending.submit('a');
  pending.submit('b');
  const items = pending.list();
  assert.equal(items.length, 2);
  for (const item of items) {
    assert.equal(typeof item.reqId, 'string');
    assert.equal(item.createdAt <= item.expiresAt, true);
    assert.ok(item.remainingMs > 0 && item.remainingMs <= 60000);
    assert.ok(item.query === 'a' || item.query === 'b');
  }
  await sleep(10);
  assert.equal(pending.count, 2);
});

test('a failure ack from the target settles immediately (no grace window)', async () => {
  const pending = createPendingCoordinator({ ttlMs: 60000, waitMs: 5000 });
  const { reqId, promise } = pending.submit('x', { targetConnectionId: 'conn-1' });
  const failAck = { reqId, ok: false, error: 'SEARCH_FAILED', detail: 'http=200 error_code=152' };
  assert.equal(pending.handleAck(failAck, 'conn-1'), true);
  const ack = await promise;
  assert.equal(ack.ok, false);
  assert.equal(ack.error, 'SEARCH_FAILED');
  assert.equal(ack.detail, 'http=200 error_code=152');
  assert.equal(pending.count, 0);
});

test('an ack from another connection cannot settle or race the request', async () => {
  const pending = createPendingCoordinator({ ttlMs: 60000, waitMs: 80 });
  const { reqId, promise } = pending.submit('x', { targetConnectionId: 'conn-1' });
  assert.equal(pending.handleAck({ reqId, ok: true }, 'conn-2'), false);
  const ack = await promise;
  assert.deepEqual(ack, { ok: false, error: 'TIMEOUT' });
});