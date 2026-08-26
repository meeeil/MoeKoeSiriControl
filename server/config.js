import dotenv from 'dotenv';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readEnvOrFile } from './env-source.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

dotenv.config({ path: path.join(projectRoot, '.env') });

function fail(msg) {
  throw new Error(`config: ${msg}`);
}

function int(name, { min, max, def }) {
  const raw = process.env[name];
  const value = raw === undefined || raw === '' ? def : Number(raw);
  if (!Number.isInteger(value)) fail(`${name} must be an integer, got ${JSON.stringify(raw)}`);
  if (value < min || value > max) fail(`${name} out of range [${min}, ${max}]`);
  return value;
}

function token(name) {
  const value = String(readEnvOrFile(name));
  if (value.length < 32) fail(`${name} must be >= 32 bytes (got ${value.length})`);
  return value;
}

const WEB_HOST = process.env.WEB_HOST || '0.0.0.0';
const WEB_PORT = int('WEB_PORT', { min: 1, max: 65535, def: 8080 });
const CONTROL_HOST = process.env.CONTROL_HOST || '0.0.0.0';
const CONTROL_PORT = int('CONTROL_PORT', { min: 1, max: 65535, def: 8200 });

if (WEB_PORT === CONTROL_PORT) fail('WEB_PORT and CONTROL_PORT must differ');

const moekoeDirRaw = String(process.env.MOEKOE_DIR || '').trim();
const MOEKOE_DIR = moekoeDirRaw ? path.resolve(moekoeDirRaw) : null;
if (MOEKOE_DIR && !fs.existsSync(MOEKOE_DIR)) {
  fail(`MOEKOE_DIR does not exist: ${MOEKOE_DIR}`);
}

const moekoeDistRaw = process.env.MOEKOE_DIST_DIR ||
  (MOEKOE_DIR ? path.join(MOEKOE_DIR, 'dist') : '');
if (!moekoeDistRaw) {
  fail('MOEKOE_DIST_DIR is required when MOEKOE_DIR is not set');
}
const MOEKOE_DIST_DIR = path.resolve(moekoeDistRaw);
if (!fs.existsSync(MOEKOE_DIST_DIR)) {
  fail(`MOEKOE_DIST_DIR does not exist: ${MOEKOE_DIST_DIR}`);
}

const RUN_DIR = path.resolve(process.env.RUN_DIR || path.join(projectRoot, 'run'));
const trustProxyRaw = String(process.env.TRUST_PROXY || '').trim().toLowerCase();
if (trustProxyRaw && !['1', 'true', '0', 'false'].includes(trustProxyRaw)) {
  fail('TRUST_PROXY must be 1/true or 0/false');
}
const TRUST_PROXY = trustProxyRaw === '1' || trustProxyRaw === 'true' ? 1 : false;

const MOEKOE_API_URL = String(process.env.MOEKOE_API_URL || 'http://127.0.0.1:6521');
if (!/^https?:\/\//.test(MOEKOE_API_URL)) fail(`MOEKOE_API_URL must start with http(s)://`);

const WS_PATH = String(process.env.SIRI_WS_PATH || '/ws');
if (!WS_PATH.startsWith('/')) fail('SIRI_WS_PATH must start with /');

const VERSION = String(process.env.SIRI_VERSION || '1.0.0');

const WEB_ORIGINS = (process.env.WEB_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const SIRI_HTTP_TOKEN = token('SIRI_HTTP_TOKEN');
const SIRI_WS_TOKEN = token('SIRI_WS_TOKEN');
if (SIRI_HTTP_TOKEN === SIRI_WS_TOKEN) fail('SIRI_HTTP_TOKEN and SIRI_WS_TOKEN must differ');

// Optional: KuGou account used by session recovery (Phase 5.6). If missing,
// reauth returns NOT_CONFIGURED and the feature stays dormant.
const KUGOU_USERNAME = String(readEnvOrFile('KUGOU_USERNAME'));
const KUGOU_PASSWORD = String(readEnvOrFile('KUGOU_PASSWORD'));

const LIMITS = {
  PENDING_TTL_MS: 60_000,
  HTTP_ACK_WAIT_MS: 15_000,
  OFFLINE_TTL_MS: 60_000,
  OFFLINE_TERMINAL_RETAIN_MS: 120_000,
  WS_AUTH_TIMEOUT_MS: 5_000,
  HEARTBEAT_INTERVAL_MS: 15_000,
  PONG_TIMEOUT_MS: 10_000
};

const PROTOCOL_VERSION = 2;

export default {
  projectRoot,
  WEB_HOST,
  WEB_PORT,
  CONTROL_HOST,
  CONTROL_PORT,
  MOEKOE_DIR,
  MOEKOE_DIST_DIR,
  RUN_DIR,
  TRUST_PROXY,
  MOEKOE_API_URL,
  WEB_ORIGINS,
  WS_PATH,
  VERSION,
  SIRI_HTTP_TOKEN,
  SIRI_WS_TOKEN,
  KUGOU_USERNAME,
  KUGOU_PASSWORD,
  LIMITS,
  PROTOCOL_VERSION
};
