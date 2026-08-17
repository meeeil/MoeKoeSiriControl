/**
 * Pending coordinator.
 *
 * Each HTTP `/api/siri/play` request submits a pending play command. The
 * coordinator mints a reqId + expiresAt (client-side TTL), exposes a promise
 * that resolves when the matching `play.ack` arrives via `handleAck`, and
 * auto-resolves with `TIMEOUT` after `waitMs` (HTTP_ACK_WAIT_MS).
 *
 * An ACK is only accepted from the connection the play.req was actually sent
 * to (targetConnectionId). An ACK from any other connection is ignored and
 * logged as a warning. There is no success-grace window and no broadcast
 * fallback: a failure ack from the target settles the request immediately.
 */
import { randomUUID } from 'node:crypto';
import config from './config.js';

export function createPendingCoordinator({
  ttlMs = config.LIMITS.PENDING_TTL_MS,
  waitMs = config.LIMITS.HTTP_ACK_WAIT_MS,
  getNow = () => Date.now(),
  log = () => {}
} = {}) {
  const items = new Map(); // reqId -> item
  const timers = new Map(); // reqId -> ack-wait timer

  function submit(query, { targetConnectionId = null } = {}) {
    const now = getNow();
    const reqId = randomUUID();
    const expiresAt = now + ttlMs;
    let resolveAck;
    const promise = new Promise((resolve) => {
      resolveAck = resolve;
    });
    const item = {
      reqId,
      query,
      createdAt: now,
      expiresAt,
      targetConnectionId,
      resolve: resolveAck,
      settled: false,
      waitTimer: null
    };
    items.set(reqId, item);

    item.settle = (ack) => {
      if (item.settled) return;
      item.settled = true;
      if (item.waitTimer) {
        clearTimeout(item.waitTimer);
        item.waitTimer = null;
      }
      timers.delete(reqId);
      items.delete(reqId);
      item.resolve(ack);
    };

    item.waitTimer = setTimeout(() => {
      item.settle({ ok: false, error: 'TIMEOUT' });
    }, waitMs);
    timers.set(reqId, item.waitTimer);

    log('pending submit', reqId, 'waitMs', waitMs);
    return { reqId, expiresAt, promise };
  }

  /** Bind the reqId to the connection that actually received the play.req. */
  function setTarget(reqId, connectionId) {
    const item = items.get(reqId);
    if (!item || item.settled) return false;
    item.targetConnectionId = connectionId;
    return true;
  }

  function handleAck(ack, connectionId) {
    const reqId = ack && ack.reqId;
    const item = items.get(reqId);
    if (!item || item.settled) return false;
    if (item.targetConnectionId && item.targetConnectionId !== connectionId) {
      log(
        'pending warn: ignoring play.ack from non-target connection',
        connectionId,
        'expected',
        item.targetConnectionId,
        'reqId=' + reqId
      );
      return false;
    }
    item.settle(ack);
    return true;
  }

  function prune() {
    const now = getNow();
    for (const [reqId, item] of items) {
      if (item.expiresAt <= now) {
        item.settle({ reqId, ok: false, error: 'PENDING_EXPIRED' });
      }
    }
    return items.size;
  }

  function list() {
    const now = getNow();
    return [...items.values()].map((i) => ({
      reqId: i.reqId,
      query: i.query,
      createdAt: i.createdAt,
      expiresAt: i.expiresAt,
      remainingMs: Math.max(0, i.expiresAt - now)
    }));
  }

  return {
    submit,
    setTarget,
    handleAck,
    prune,
    list,
    get count() {
      return items.size;
    }
  };
}