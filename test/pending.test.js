import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPendingCoordinator } from '../server/pending.js';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

test('submit mints reqId + expiresAt and ack resolves the promise', async () => {
  let now = 1000;
  const pending = createPendingCoordinator({ ttlMs: 60000, getNow: () => now });
  const { reqId, expiresAt, promise } = pending.submit('七里香');
  assert.equal(typeof reqId, 'string');
  assert.ok(reqId.length > 0);
  assert.equal(expiresAt, 61000);
  assert.equal(pending.count, 1);

  const ack = { reqId, ok: true, song: { hash: 'H1', name: '七里香' } };
  assert.equal(pending.handleAck(ack), true);
  assert.equal(await promise, ack);
  assert.equal(pending.count, 0);
});

test('submit resolves TIMEOUT when no ack arrives within waitMs', async () => {
  const pending = createPendingCoordinator({ ttlMs: 60000, waitMs: 50 });
  const { reqId, promise } = pending.submit('x');
  const ack = await promise;
  assert.deepEqual(ack, { ok: false, error: 'TIMEOUT' });
  assert.equal(pending.count, 0);
  // late ack for the same reqId is ignored
  assert.equal(pending.handleAck({ reqId, ok: true }), false);
});

test('handleAck with unknown reqId returns false', () => {
  const pending = createPendingCoordinator();
  assert.equal(pending.handleAck({ reqId: 'nope', ok: true }), false);
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

test('a failure ack does not settle immediately when a success may follow', async () => {
  let settled = false;
  const pending = createPendingCoordinator({ ttlMs: 60000, waitMs: 5000, successGraceMs: 1500 });
  const { reqId, promise } = pending.submit('x');
  promise.then(() => {
    settled = true;
  });
  const failAck = { reqId, ok: false, error: 'SEARCH_FAILED' };
  assert.equal(pending.handleAck(failAck), true);
  await sleep(50);
  assert.equal(settled, false, 'failure ack must not settle yet');

  const okAck = { reqId, ok: true, song: { hash: 'H1', name: 'x' } };
  assert.equal(pending.handleAck(okAck), true);
  assert.equal(await promise, okAck);
  assert.equal(pending.count, 0);
});

test('a lone failure ack resolves with the failure after the grace window', async () => {
  const pending = createPendingCoordinator({ ttlMs: 60000, waitMs: 5000, successGraceMs: 40 });
  const { reqId, promise } = pending.submit('x');
  const failAck = { reqId, ok: false, error: 'SEARCH_FAILED', detail: 'http=200 error_code=152' };
  assert.equal(pending.handleAck(failAck), true);
  const ack = await promise;
  assert.equal(ack.ok, false);
  assert.equal(ack.error, 'SEARCH_FAILED');
  assert.equal(ack.detail, 'http=200 error_code=152');
  assert.equal(pending.count, 0);
});

test('waitMs expiry prefers a recorded failure over TIMEOUT', async () => {
  const pending = createPendingCoordinator({ ttlMs: 60000, waitMs: 60, successGraceMs: 10000 });
  const { reqId, promise } = pending.submit('x');
  const failAck = { reqId, ok: false, error: 'NO_RESULTS' };
  pending.handleAck(failAck);
  const ack = await promise;
  assert.equal(ack.ok, false);
  assert.equal(ack.error, 'NO_RESULTS');
  assert.equal(pending.count, 0);
});