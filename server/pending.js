/**
 * Pending coordinator (Phase 5).
 *
 * Each HTTP `/api/siri/play` request submits a pending play command. The
 * coordinator mints a reqId + expiresAt (client-side TTL), exposes a promise
 * that resolves when the matching `play.ack` arrives via `handleAck`, and
 * auto-resolves with `TIMEOUT` after `waitMs` (HTTP_ACK_WAIT_MS). Prune is a
 * defensive safety net for entries that are never awaited (should not happen).
 */
import { randomUUID } from 'node:crypto';
import config from './config.js';

export function createPendingCoordinator({
  ttlMs = config.LIMITS.PENDING_TTL_MS,
  waitMs = config.LIMITS.HTTP_ACK_WAIT_MS,
  successGraceMs = config.LIMITS.PENDING_SUCCESS_GRACE_MS,
  getNow = () => Date.now(),
  log = () => {}
} = {}) {
  const items = new Map(); // reqId -> item
  const timers = new Map(); // reqId -> ack-wait timer

  function submit(query) {
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
      resolve: resolveAck,
      settled: false,
      fallbackAck: null,
      graceTimer: null,
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
      if (item.graceTimer) {
        clearTimeout(item.graceTimer);
        item.graceTimer = null;
      }
      timers.delete(reqId);
      items.delete(reqId);
      item.resolve(ack);
    };

    item.waitTimer = setTimeout(() => {
      // Prefer a recorded failure over a bare TIMEOUT when a client answered
      // but another (success) ack is still in flight.
      item.settle(item.fallbackAck || { ok: false, error: 'TIMEOUT' });
    }, waitMs);
    timers.set(reqId, item.waitTimer);

    log('pending submit', reqId, 'waitMs', waitMs);
    return { reqId, expiresAt, promise };
  }

  function handleAck(ack) {
    const reqId = ack && ack.reqId;
    const item = items.get(reqId);
    if (!item || item.settled) return false;
    if (ack && ack.ok === true) {
      item.settle(ack);
      return true;
    }
    // Failure ack: remember the first one but keep waiting briefly for a
    // possible success ack (another client may still be answering).
    if (!item.fallbackAck) {
      item.fallbackAck = ack;
      item.graceTimer = setTimeout(() => item.settle(item.fallbackAck), successGraceMs);
    }
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
    handleAck,
    prune,
    list,
    get count() {
      return items.size;
    }
  };
}