/**
 * Control protocol message helpers (shared, pure).
 *
 * Wire format: one JSON object per message.
 *   client -> server: {"type":"auth","token":"...","version":1}
 *                     {"type":"pong","t":<echo of server ping t>}
 *   server -> client: {"type":"auth.ok","version":1}
 *                     {"type":"auth.error","reason":"..."}
 *                     {"type":"ping","t":<ms>}
 *
 * Phase 4 adds: play.req / play.ack / search.req / search.res / search.err.
 */
import crypto from 'node:crypto';

export function buildAuthOk(version) {
  return { type: 'auth.ok', version };
}

export function buildAuthError(reason) {
  return { type: 'auth.error', reason };
}

export function buildPing(t) {
  return { type: 'ping', t };
}

export function buildPong(t) {
  return { type: 'pong', t };
}

/**
 * Constant-time token comparison. Both values are hashed first so the
 * comparison is over fixed-length digests (no length side-channel).
 */
export function safeTokenEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Parse a raw WS frame into a control message.
 * @returns {object|null} the parsed object, or null if it is not a
 *   well-formed `{type:string}` JSON object.
 */
export function parseControlMessage(raw) {
  let obj;
  try {
    obj = JSON.parse(String(raw));
  } catch (_err) {
    return null;
  }
  if (!obj || typeof obj !== 'object' || typeof obj.type !== 'string') {
    return null;
  }
  return obj;
}