import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOfflineCommand } from '../server/offline-command.js';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function makePeer(id = 'peer-1', onSend = () => 1) {
  const sent = [];
  return {
    id,
    sent,
    send(obj) {
      const ok = onSend(obj);
      if (ok) sent.push(obj);
      return ok;
    }
  };
}

test('submit parks a command in queued state', () => {
  const oc = createOfflineCommand({ log: () => {} });
  const r = oc.submit('七里香');
  assert.equal(r.status, 'queued');
  assert.equal(typeof r.reqId, 'string');
  const cur = oc.current();
  assert.equal(cur.state, 'queued');
  assert.equal(cur.query, '七里香');
  assert.ok(cur.expiresAt > Date.now());
  assert.ok(cur.remainingMs > 0);
});

test('queued command is dispatched to the first authenticated peer', () => {
  const oc = createOfflineCommand({ log: () => {} });
  oc.submit('七里香');
  const peer = makePeer('iPad-1');
  assert.equal(oc.dispatch(peer), true);
  assert.equal(peer.sent.length, 1);
  assert.equal(peer.sent[0].type, 'play.req');
  assert.equal(peer.sent[0].query, '七里香');
  assert.equal(oc.current().state, 'dispatched');
});

test('a dispatched command is never re-sent to another peer', () => {
  const oc = createOfflineCommand({ log: () => {} });
  oc.submit('x');
  const a = makePeer('a');
  assert.equal(oc.dispatch(a), true);
  const b = makePeer('b');
  assert.equal(oc.dispatch(b), false);
  assert.equal(b.sent.length, 0);
  assert.equal(a.sent.length, 1);
});

test('successful ACK settles the command as succeeded', () => {
  const oc = createOfflineCommand({ log: () => {} });
  oc.submit('七里香');
  const peer = makePeer('a');
  oc.dispatch(peer);
  const reqId = peer.sent[0].reqId;
  assert.equal(oc.handleAck({ reqId, ok: true, song: { name: '七里香' } }, 'a'), true);
  const snap = oc.get(reqId);
  assert.equal(snap.state, 'succeeded');
  assert.equal(snap.ack.song.name, '七里香');
});

test('an ack from a connection other than the target is ignored with a warning', () => {
  const warned = [];
  const oc = createOfflineCommand({ log: (...args) => warned.push(args) });
  oc.submit('x');
  const a = makePeer('a');
  oc.dispatch(a);
  const reqId = a.sent[0].reqId;
  assert.equal(oc.handleAck({ reqId, ok: true }, 'other-conn'), false);
  assert.ok(warned.length >= 1, 'must log a warning');
  assert.equal(oc.current().state, 'dispatched', 'command must stay dispatched');
  assert.equal(oc.handleAck({ reqId, ok: true }, 'a'), true);
  assert.equal(oc.get(reqId).state, 'succeeded');
});

test('failure ACK settles the command as failed with error', () => {
  const oc = createOfflineCommand({ log: () => {} });
  oc.submit('x');
  const peer = makePeer('a');
  oc.dispatch(peer);
  const reqId = peer.sent[0].reqId;
  assert.equal(oc.handleAck({ reqId, ok: false, error: 'PLAYER_NOT_READY' }, 'a'), true);
  const snap = oc.get(reqId);
  assert.equal(snap.state, 'failed');
  assert.equal(snap.ack.error, 'PLAYER_NOT_READY');
});

test('target disconnect before ack re-queues the command for resend', () => {
  const oc = createOfflineCommand({ log: () => {} });
  oc.submit('x');
  const a = makePeer('a');
  oc.dispatch(a);
  assert.equal(oc.handleDisconnect('a'), true);
  assert.equal(oc.current().state, 'queued');
  assert.equal(oc.dispatch(a), true);
  assert.equal(a.sent.length, 2);
});

test('disconnect of a non-target connection does not re-queue', () => {
  const oc = createOfflineCommand({ log: () => {} });
  oc.submit('x');
  const a = makePeer('a');
  oc.dispatch(a);
  assert.equal(oc.handleDisconnect('b'), false);
  assert.equal(oc.current().state, 'dispatched');
});

test('ACK for an unknown / online reqId is not consumed', () => {
  const oc = createOfflineCommand({ log: () => {} });
  assert.equal(oc.handleAck({ reqId: 'online-1', ok: true }), false);
});

test('queued command expires after the TTL and is not dispatched', async () => {
  const oc = createOfflineCommand({ ttlMs: 40, terminalRetainMs: 400, log: () => {} });
  const { reqId } = oc.submit('x');
  await sleep(80);
  const peer = makePeer('a');
  assert.equal(oc.dispatch(peer), false);
  assert.equal(peer.sent.length, 0);
  assert.equal(oc.get(reqId).state, 'expired');
});

test('disconnect after TTL expiry settles as expired', async () => {
  const oc = createOfflineCommand({ ttlMs: 40, terminalRetainMs: 400, log: () => {} });
  oc.submit('x');
  const a = makePeer('a');
  oc.dispatch(a);
  const reqId = a.sent[0].reqId;
  await sleep(80);
  assert.equal(oc.handleDisconnect('a'), true);
  assert.equal(oc.current(), null);
  assert.equal(oc.get(reqId).state, 'expired');
});

test('a new offline command supersedes the previous one', () => {
  const oc = createOfflineCommand({ log: () => {} });
  const first = oc.submit('first');
  const second = oc.submit('second');
  assert.equal(oc.current().query, 'second');
  assert.equal(oc.get(first.reqId).state, 'superseded');
  assert.equal(oc.get(second.reqId).state, 'queued');
});

test('unknown reqId returns null', () => {
  const oc = createOfflineCommand({ log: () => {} });
  assert.equal(oc.get('nope'), null);
});

test('terminal states are pruned after terminalRetainMs', async () => {
  const oc = createOfflineCommand({ terminalRetainMs: 40, log: () => {} });
  const { reqId } = oc.submit('x');
  const peer = makePeer('a');
  oc.dispatch(peer);
  oc.handleAck({ reqId, ok: true }, 'a');
  assert.equal(oc.get(reqId).state, 'succeeded');
  await sleep(80);
  oc.prune();
  assert.equal(oc.get(reqId), null);
});

test('commands are not persisted across a restart (in-memory)', () => {
  const oc = createOfflineCommand({ log: () => {} });
  const { reqId } = oc.submit('x');
  const oc2 = createOfflineCommand({ log: () => {} });
  assert.equal(oc2.get(reqId), null);
});

test('peer without a send function is not dispatched', () => {
  const oc = createOfflineCommand({ log: () => {} });
  oc.submit('x');
  assert.equal(oc.dispatch({ id: 'no-send' }), false);
  assert.equal(oc.current().state, 'queued');
});

test('repeated dispatch after settle returns false (single-slot)', () => {
  const oc = createOfflineCommand({ log: () => {} });
  oc.submit('x');
  const a = makePeer('a');
  oc.dispatch(a);
  oc.handleAck({ reqId: a.sent[0].reqId, ok: true }, 'a');
  assert.equal(oc.dispatch(a), false);
});