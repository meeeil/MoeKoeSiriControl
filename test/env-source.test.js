import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readEnvOrFile } from '../server/env-source.js';

test('readEnvOrFile prefers a direct non-empty value', () => {
  assert.equal(
    readEnvOrFile('TOKEN', { env: { TOKEN: 'direct', TOKEN_FILE: 'missing' } }),
    'direct'
  );
});

test('readEnvOrFile reads Docker secret files and removes trailing newlines', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moekoe-secret-'));
  const secret = path.join(dir, 'token');
  fs.writeFileSync(secret, 'from-file\r\n', 'utf8');
  try {
    assert.equal(readEnvOrFile('TOKEN', { env: { TOKEN_FILE: secret } }), 'from-file');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readEnvOrFile reports a missing required value without inventing a default', () => {
  assert.throws(
    () => readEnvOrFile('TOKEN', { env: {}, required: true }),
    /TOKEN or TOKEN_FILE is required/
  );
});
