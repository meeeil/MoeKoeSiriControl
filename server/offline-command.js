/**
 * Offline single-slot command (Phase 7).
 *
 * When no iPad WS client is online, an HTTP `/api/siri/play` is stashed into
 * this single-slot queue instead of failing with NO_CLIENT. The command is
 * auto-dispatched on the next WS authentication and re-queued if the target
 * disconnects before its ACK (as long as the TTL has not expired).
 *
 *   queued      waiting for an authenticated WS client
 *   dispatched  play.req sent to targetConnectionId, awaiting play.ack
 *   succeeded   play.ack ok
 *   failed      play.ack not ok
 *   expired     TTL passed while queued/dispatched
 *   superseded  replaced by a newer offline command
 *
 * Only the last command is kept (new submit supersedes the old one). Terminal
 * states are retained for `terminalRetainMs` so the Shortcut can poll the
 * status endpoint, then pruned. Nothing is persisted across restarts.
 *
 * A single reqId is never dispatched to more than one client: dispatch only
 * acts while the state is `queued`, and the first authenticated peer to
 * receive it becomes targetConnectionId.
 */
import { randomUUID } from 'node:crypto';
import config from './config.js';

export function createOfflineCommand({
  ttlMs = config.LIMITS.OFFLINE_TTL_MS,
  terminalRetainMs = config.LIMITS.OFFLINE_TERMINAL_RETAIN_MS,
  getNow = () => Date.now(),
  log = () => {}
} = {}) {
  let slot = null; // active command (queued/dispatched)
  const terminal = new Map(); // reqId -> settled snapshot

  function snapshot(cmd, state = cmd.state, settledAt = null) {
    const now = getNow();
    const ack = cmd.ack || null;
    return {
      reqId: cmd.reqId,
      query: cmd.query,
      createdAt: cmd.createdAt,
      expiresAt: cmd.expiresAt,
      state,
      ack,
      settledAt,
      remainingMs: state === 'queued' || state === 'dispatched'
        ? Math.max(0, cmd.expiresAt - now)
        : 0
    };
  }

  function settle(cmd, state, now = getNow()) {
    cmd.state = state;
    const snap = snapshot(cmd, state, now);
    if (terminal.size >= 50) {
      // safety cap: never grow unbounded if pollers disappear
      terminal.delete(terminal.keys().next().value);
    }
    terminal.set(cmd.reqId, snap);
    log('offline command', state, cmd.reqId);
    slot = null;
    return snap;
  }

  function submit(query) {
    const now = getNow();
    prune();
    if (slot) {
      const oldId = slot.reqId;
      settle(slot, 'superseded', now);
      log('offline command superseded', oldId);
    }
    const reqId = randomUUID();
    const expiresAt = now + ttlMs;
    slot = {
      reqId,
      query,
      createdAt: now,
      expiresAt,
      state: 'queued',
      targetConnectionId: null,
      ack: null,
      error: null
    };
    log('offline command queued', reqId, 'query=' + query);
    return { reqId, expiresAt, status: 'queued' };
  }

  function dispatch(peer) {
    if (!slot || slot.state !== 'queued') return false;
    const now = getNow();
    if (now > slot.expiresAt) {
      settle(slot, 'expired', now);
      return false;
    }
    if (typeof peer?.send !== 'function' || !peer.id) return false;
    if (slot.targetConnectionId && slot.targetConnectionId !== peer.id) return false;
    const sent = peer.send({
      type: 'play.req',
      reqId: slot.reqId,
      query: slot.query,
      expiresAt: slot.expiresAt
    });
    if (sent === 0) return false;
    slot.targetConnectionId = peer.id;
    slot.state = 'dispatched';
    log('offline command dispatched', slot.reqId, 'peer=' + peer.id);
    return true;
  }

  function handleAck(ack) {
    const reqId = ack && ack.reqId;
    if (!slot || slot.reqId !== reqId) return false;
    if (slot.state !== 'dispatched' && slot.state !== 'queued') return true;
    const now = getNow();
    slot.ack = ack;
    if (ack && ack.ok === true) {
      settle(slot, 'succeeded', now);
    } else {
      slot.error = (ack && ack.error) || 'FAILED';
      settle(slot, 'failed', now);
    }
    return true;
  }

  function handleDisconnect(connectionId) {
    if (!slot || slot.state !== 'dispatched') return false;
    if (slot.targetConnectionId !== connectionId) return false;
    const now = getNow();
    if (now > slot.expiresAt) {
      settle(slot, 'expired', now);
      return true;
    }
    slot.state = 'queued';
    slot.targetConnectionId = null;
    log('offline command re-queued after disconnect', slot.reqId);
    return true;
  }

  function get(reqId) {
    prune();
    if (slot && slot.reqId === reqId) return snapshot(slot);
    const snap = terminal.get(reqId);
    return snap ? { ...snap } : null;
  }

  function prune() {
    const now = getNow();
    if (slot && (slot.state === 'queued' || slot.state === 'dispatched') && now > slot.expiresAt) {
      settle(slot, 'expired', now);
    }
    for (const [reqId, snap] of terminal) {
      if (snap.settledAt && now - snap.settledAt > terminalRetainMs) {
        terminal.delete(reqId);
      }
    }
    return terminal.size;
  }

  function current() {
    prune();
    return slot ? snapshot(slot) : null;
  }

  return {
    submit,
    dispatch,
    handleAck,
    handleDisconnect,
    get,
    prune,
    current,
    get terminalCount() {
      return terminal.size;
    },
    get hasActive() {
      return slot !== null;
    },
    get state() {
      return slot ? slot.state : 'idle';
    }
  };
}