/**
 * iPad pairing (Phase 1: unique paired controller).
 *
 * The WS token is embedded in the public hashed client script, so it alone
 * must not unlock Siri control / session recovery. The user pairs once by
 * opening /siri/pair on the iPad and submitting SIRI_HTTP_TOKEN; the server
 * generates a fresh random deviceId, records it as the single controller
 * (`run/controller.json`), and answers with a host-only HttpOnly cookie:
 *
 *   siri_pair=<deviceId>.<signature>
 *   signature = HMAC-SHA256(SIRI_HTTP_TOKEN, "siri-controller:v1:" + deviceId)
 *
 * The WS server (different port, same host) parses the cookie at handshake
 * time and marks the connection as `controller` only when the deviceId
 * matches the persisted controller. Being HMAC-derived, the cookie cannot be
 * forged without the token and survives server restarts.
 */
import crypto from 'node:crypto';
import { safeTokenEqual } from './protocol.js';

export const PAIR_COOKIE = 'siri_pair';
const PAIR_CONTEXT_PREFIX = 'siri-controller:v1:';

export const GATE_COOKIE = 'moekoe_gate';
const GATE_CONTEXT_PREFIX = 'moekoe-gate:v1:';

export function deriveGateValue(secret, gatePassword) {
  return crypto
    .createHmac('sha256', String(secret))
    .update(GATE_CONTEXT_PREFIX + String(gatePassword))
    .digest('hex');
}

export function makeGateCookieValue(secret, gatePassword) {
  return deriveGateValue(secret, gatePassword);
}

export function parseGateCookie(cookieHeader, secret, gatePassword) {
  if (!gatePassword) return true;
  if (typeof cookieHeader !== 'string' || !cookieHeader) return false;
  let value = null;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(GATE_COOKIE + '=')) {
      value = trimmed.slice(GATE_COOKIE.length + 1);
      break;
    }
  }
  if (!value) return false;
  return safeTokenEqual(value, deriveGateValue(secret, gatePassword));
}

export function derivePairValue(secret, deviceId) {
  return crypto
    .createHmac('sha256', String(secret))
    .update(PAIR_CONTEXT_PREFIX + String(deviceId))
    .digest('hex');
}

export function makePairCookieValue(secret, deviceId) {
  return `${deviceId}.${derivePairValue(secret, deviceId)}`;
}

/**
 * Parse and verify a `siri_pair` cookie header.
 * @returns {{deviceId: string} | null} deviceId on a valid signature, else null.
 */
export function parsePairCookie(cookieHeader, secret) {
  if (typeof cookieHeader !== 'string' || !cookieHeader) return null;
  let value = null;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(PAIR_COOKIE + '=')) {
      value = trimmed.slice(PAIR_COOKIE.length + 1);
      break;
    }
  }
  if (!value) return null;
  const dot = value.indexOf('.');
  if (dot <= 0 || dot >= value.length - 1) return null;
  const deviceId = value.slice(0, dot);
  const signature = value.slice(dot + 1);
  if (!safeTokenEqual(signature, derivePairValue(secret, deviceId))) return null;
  return { deviceId };
}

/** Backwards-compatible boolean check: is the cookie present and valid? */
export function verifyPairCookie(cookieHeader, secret) {
  return parsePairCookie(cookieHeader, secret) !== null;
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