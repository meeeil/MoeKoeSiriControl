import config from './config.js';
import { createWebHost } from './web-host.js';
import { createControlServer } from './control-server.js';
import { createPendingCoordinator } from './pending.js';
import { createOfflineCommand } from './offline-command.js';
import { createHttpApi } from './http-api.js';
import { createSessionAuth } from './session-auth.js';
import { createControllerStore } from './controller-store.js';
import path from 'node:path';
import fs from 'node:fs';

async function checkUpstream() {
  try {
    const res = await fetch(`${config.MOEKOE_API_URL}/register/dev`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(3000)
    });
    const body = await res.text();
    upstreamState = {
      reachable: res.status >= 200 && res.status < 500,
      status: res.status,
      checkedAt: Date.now()
    };
    console.log(`[index] upstream ${config.MOEKOE_API_URL} → HTTP ${res.status} (${body.slice(0, 80)})`);
  } catch (err) {
    upstreamState = { reachable: false, status: null, error: err.message, checkedAt: Date.now() };
    console.error(`[index] WARNING: upstream ${config.MOEKOE_API_URL} unreachable: ${err.message}`);
    console.error('[index] QR code / rankings / recommendation will fail until the MoeKoeMusic API is running.');
  }
}

let upstreamState = { reachable: null, status: null, checkedAt: 0 };

const controllerStore = createControllerStore({
  filePath: path.join(config.projectRoot, 'run', 'controller.json'),
  log: (...args) => console.log('[controller]', ...args)
});
const controller = controllerStore.get();
if (controller.deviceId) {
  console.log(`[index] controller paired: ${controller.deviceId} (${new Date(controller.pairedAt).toISOString()})`);
} else {
  console.log(`[index] no controller paired yet — open http://<host>:${config.WEB_PORT}/siri/pair on the target iPad${controller.corrupt ? ' (controller.json corrupt)' : ''}`);
}

const sessionAuth = createSessionAuth({
  username: config.KUGOU_USERNAME,
  password: config.KUGOU_PASSWORD,
  sessionFilePath: path.join(config.projectRoot, 'run', 'session.json'),
  log: (...args) => console.log('[session-auth]', ...args)
});

const webApp = createWebHost({ controllerStore, sessionAuth });
const webServer = webApp.listen(config.WEB_PORT, config.WEB_HOST, () => {
  console.log(`[index] web host: http://${config.WEB_HOST}:${config.WEB_PORT} (serving ${config.MOEKOE_DIST_DIR})`);
  console.log(`[index] api proxy: ${config.MOEKOE_API_URL}`);
});

const pending = createPendingCoordinator();

const offlineCommand = createOfflineCommand({
  log: (...args) => console.log('[offline]', ...args)
});

const controlServer = createControlServer({
  sessionAuth,
  controllerStore,
  upstream: {
    get: () => upstreamState,
    url: config.MOEKOE_API_URL
  },
  handlers: {
    onAck: (ack, connectionId) => {
      if (offlineCommand.handleAck(ack, connectionId)) return;
      pending.handleAck(ack, connectionId);
    },
    onAuthenticated: (conn) => {
      // Only the paired controller can trigger offline dispatch.
      if (!conn.controller) return;
      offlineCommand.dispatch({
        id: conn.id,
        send: (obj) => controlServer.sendTo(conn.id, obj)
      });
    },
    onDisconnected: (conn) => {
      offlineCommand.handleDisconnect(conn.id);
    }
  }
});

controlServer.app.use(
  createHttpApi({
    sendPlayRequest: controlServer.sendPlayRequest,
    authenticatedClients: () => controlServer.authenticatedClients,
    activeClients: () => controlServer.activeClients,
    controllerOnline: () => controlServer.controllerOnline(),
    controllerConnectionCount: () => controlServer.controllerConnectionCount(),
    controllerStore,
    pending,
    offlineCommand,
    sessionAuth
  })
);

controlServer.httpServer.listen(config.CONTROL_PORT, config.CONTROL_HOST, () => {
  console.log(`[index] control server: ws://${config.CONTROL_HOST}:${config.CONTROL_PORT}${config.WS_PATH}`);
  console.log(`[index] control server: http://${config.CONTROL_HOST}:${config.CONTROL_PORT}/health`);
  console.log(`[index] http api: http://${config.CONTROL_HOST}:${config.CONTROL_PORT}/api/siri/play`);
  console.log(`[index] http api: http://${config.CONTROL_HOST}:${config.CONTROL_PORT}/api/siri/commands/:reqId`);
  console.log(`[index] http api: http://${config.CONTROL_HOST}:${config.CONTROL_PORT}/debug/status`);
});

checkUpstream();
setInterval(checkUpstream, 60_000).unref();

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[index] ${signal} received, shutting down...`);
  await controlServer.close();
  webServer.close(() => {
    console.log('[index] web host closed');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));