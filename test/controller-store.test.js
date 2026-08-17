import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createControllerStore } from '../server/controller-store.js';

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'controller-store-'));
  return path.join(dir, name);
}

test('missing file -> unpaired, not corrupt', () => {
  const store = createControllerStore({ filePath: tmpFile('missing.json') });
  const state = store.get();
  assert.equal(state.deviceId, null);
  assert.equal(state.pairedAt, 0);
  assert.equal(state.corrupt, false);
});

test('no filePath -> in-memory only (no persistence)', () => {
  const store = createControllerStore({});
  store.set('device-x');
  assert.equal(store.get().deviceId, 'device-x');
  const store2 = createControllerStore({});
  assert.equal(store2.get().deviceId, null, 'in-memory state is not shared');
});

test('set() persists atomically and reloads after restart', () => {
  const filePath = tmpFile('controller.json');
  const store = createControllerStore({ filePath, getNow: () => 123456789 });
  store.set('device-abc');
  const state = store.get();
  assert.equal(state.version, 1);
  assert.equal(state.deviceId, 'device-abc');
  assert.equal(state.pairedAt, 123456789);
  assert.equal(state.corrupt, false);

  const reloaded = createControllerStore({ filePath });
  assert.equal(reloaded.get().deviceId, 'device-abc');
  assert.equal(reloaded.get().pairedAt, 123456789);
});

test('re-pair replaces the controller (old device loses eligibility)', () => {
  const filePath = tmpFile('controller.json');
  const store = createControllerStore({ filePath });
  store.set('device-old');
  assert.equal(store.isController('device-old'), true);
  store.set('device-new');
  assert.equal(store.isController('device-old'), false);
  assert.equal(store.isController('device-new'), true);
});

test('corrupt json -> unpaired with corrupt flag', () => {
  const filePath = tmpFile('controller.json');
  fs.writeFileSync(filePath, '{not json', 'utf8');
  const store = createControllerStore({ filePath });
  assert.equal(store.get().deviceId, null);
  assert.equal(store.get().corrupt, true);
  assert.equal(store.isController('anything'), false);
});

test('invalid shape (missing/invalid deviceId) -> unpaired with corrupt flag', () => {
  for (const bad of ['{}', '{"deviceId":""}', '{"deviceId":123}', 'null', '[]']) {
    const filePath = tmpFile('controller.json');
    fs.writeFileSync(filePath, bad, 'utf8');
    const store = createControllerStore({ filePath });
    assert.equal(store.get().deviceId, null, `shape ${bad}`);
    assert.equal(store.get().corrupt, true);
  }
});

test('isController rejects empty / mismatched deviceId', () => {
  const store = createControllerStore({});
  store.set('device-1');
  assert.equal(store.isController('device-1'), true);
  assert.equal(store.isController(''), false);
  assert.equal(store.isController(null), false);
  assert.equal(store.isController(undefined), false);
  assert.equal(store.isController('device-2'), false);
});