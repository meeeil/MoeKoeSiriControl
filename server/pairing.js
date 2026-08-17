/**
 * iPad pairing (Phase 5.6).
 *
 * The WS token is embedded in the public hashed client script, so it alone
 * must not unlock session recovery (which returns a KuGou login token). The
 * user pairs once by opening /siri/pair on the iPad and submitting
 * SIRI_HTTP_TOKEN; the server answers with a host-only HttpOnly cookie whose
 * value is an HMAC of the HTTP token. The WS server (different port, same
 * host) verifies the cookie at handshake time. Being HMAC-derived, the cookie
 * stays valid across server restarts and cannot be forged without the token.
 */
import crypto from 'node:crypto';
import { safeTokenEqual } from './protocol.js';

export const PAIR_COOKIE = 'siri_pair';
const PAIR_CONTEXT = 'siri-pair:v1';

export function derivePairValue(secret) {
  return crypto.createHmac('sha256', String(secret)).update(PAIR_CONTEXT).digest('hex');
}

export function verifyPairCookie(cookieHeader, secret) {
  if (typeof cookieHeader !== 'string' || !cookieHeader) return false;
  let value = null;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(PAIR_COOKIE + '=')) {
      value = trimmed.slice(PAIR_COOKIE.length + 1);
      break;
    }
  }
  if (!value) return false;
  return safeTokenEqual(value, derivePairValue(secret));
}

export function createPairingLimiter({
  limit = 5,
  windowMs = 60000,
  getNow = () => Date.now()
} = {}) {
  const hits = new Map();
  return {
    allow(key) {
      const now = getNow();
      const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
      if (recent.length >= limit) {
        hits.set(key, recent);
        return false;
      }
      recent.push(now);
      hits.set(key, recent);
      return true;
    },
    reset(key) {
      if (key === undefined) hits.clear();
      else hits.delete(key);
    }
  };
}