/**
 * Controller store (Phase 1: unique paired controller).
 *
 * Persists the single controller device id to `run/controller.json`:
 *   { "version": 1, "deviceId": "<uuid>", "pairedAt": 0 }
 *
 * The file is written atomically (temp file + rename). A missing or corrupt
 * file means "no controller paired" — the system must NOT fall back to
 * loopback / recency based target selection. A corrupt file is surfaced via
 * `get().corrupt` so health/debug output can report an abnormal pairing state.
 */
import fs from 'node:fs';
import path from 'node:path';

const EMPTY = Object.freeze({ version: 1, deviceId: null, pairedAt: 0, corrupt: false });

export function createControllerStore({
  filePath = null,
  getNow = () => Date.now(),
  log = () => {}
} = {}) {
  let state = load();

  function load() {
    if (!filePath) return { ...EMPTY };
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (_err) {
      // missing file -> no controller (not an error condition)
      return { ...EMPTY };
    }
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch (_err) {
      log('controller.json corrupt; treating as unpaired');
      return { ...EMPTY, corrupt: true };
    }
    if (
      !data ||
      typeof data.deviceId !== 'string' ||
      data.deviceId.length === 0 ||
      data.deviceId.length > 128
    ) {
      log('controller.json invalid shape; treating as unpaired');
      return { ...EMPTY, corrupt: true };
    }
    return {
      version: Number.isInteger(data.version) ? data.version : 1,
      deviceId: data.deviceId,
      pairedAt: Number.isFinite(data.pairedAt) ? data.pairedAt : 0,
      corrupt: false
    };
  }

  function persist() {
    if (!filePath) return;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
  }

  return {
    /** Current controller state (copy). Never null. */
    get() {
      return { ...state };
    },
    get deviceId() {
      return state.deviceId;
    },
    /** Replace the controller with a new device id (atomic). */
    set(deviceId) {
      const id = String(deviceId || '');
      if (!id || id.length > 128) {
        throw new Error('controller-store: invalid deviceId');
      }
      state = { version: 1, deviceId: id, pairedAt: getNow(), corrupt: false };
      persist();
      log('controller paired', id);
      return { ...state };
    },
    isController(deviceId) {
      return typeof deviceId === 'string' && deviceId.length > 0 && deviceId === state.deviceId;
    },
    get filePath() {
      return filePath;
    }
  };
}