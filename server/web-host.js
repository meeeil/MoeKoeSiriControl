import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import config from './config.js';
import { safeTokenEqual } from './protocol.js';
import {
  makePairCookieValue,
  parsePairCookie,
  createPairingLimiter,
  PAIR_COOKIE
} from './pairing.js';

const HASHED_ASSET_RE = /[-.][A-Za-z0-9_-]{8,}\.(?:js|css|png|jpe?g|gif|svg|webp|woff2?|ico)$/i;

export function createWebHost({ controllerStore, sessionAuth } = {}) {
  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - start;
      console.log(`[web-host] ${req.method} ${req.path} ${res.statusCode} ${ms}ms`);
    });
    next();
  });

  app.use(
    '/api',
    createProxyMiddleware({
      target: config.MOEKOE_API_URL,
      changeOrigin: true,
      logLevel: 'silent',
      pathRewrite: (pathname) => pathname.replace(/^\/api(?:\/|$)/, '/'),
      on: {
        proxyReq: (proxyReq, req) => {
          proxyReq.setHeader('X-Forwarded-Proto', req.protocol);
        },
        error: (err) => {
          console.error(`[web-host] api proxy error: ${err.message}`);
        }
      }
    })
  );

  const pairLimiter = createPairingLimiter({ limit: 5, windowMs: 60000 });

  app.get('/siri/pair', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(config.projectRoot, 'server', 'pair-page.html'));
  });

  app.get('/siri/pair-status', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const cookieHeader = req.headers.cookie || '';
    const parsed = parsePairCookie(cookieHeader, config.SIRI_HTTP_TOKEN);
    const controller = controllerStore ? controllerStore.get() : { deviceId: null };
    const paired = parsed !== null;
    const isController = paired && controller.deviceId && controller.deviceId === parsed.deviceId;
    return res.json({
      ok: true,
      paired,
      isController,
      deviceId: parsed ? parsed.deviceId : null,
      accountConfigured: sessionAuth ? sessionAuth.isConfigured() : false
    });
  });

  app.get('/siri/default-session', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!sessionAuth || !sessionAuth.isConfigured()) {
      return res.status(200).json({ ok: false, code: 'NOT_CONFIGURED' });
    }
    const result = await sessionAuth.getSession();
    if (result.ok) {
      return res.status(200).json({ ok: true, session: result.session });
    }
    return res.status(200).json({ ok: false, code: result.code, detail: result.detail });
  });

  app.post('/siri/sync-session', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!sessionAuth || !sessionAuth.isConfigured()) {
      return res.status(200).json({ ok: false, code: 'NOT_CONFIGURED' });
    }
    const result = await sessionAuth.login();
    if (result.ok) {
      return res.status(200).json({ ok: true, session: result.session });
    }
    return res.status(200).json({ ok: false, code: result.code, detail: result.detail });
  });

  app.post('/siri/save-session', express.json(), (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const session = req.body && req.body.session ? req.body.session : req.body;
    if (!session || typeof session.token !== 'string' || session.token.length === 0) {
      return res.status(400).json({ ok: false, error: 'INVALID_SESSION' });
    }
    if (sessionAuth && typeof sessionAuth.saveSession === 'function') {
      const saved = sessionAuth.saveSession(session);
      return res.json({ ok: saved, session: sessionAuth.getCachedSession() });
    }
    return res.status(500).json({ ok: false, error: 'NO_SESSION_AUTH' });
  });

  app.post('/siri/pair', express.json(), (req, res) => {
    const ip = String(req.ip || 'unknown');
    if (!pairLimiter.allow(ip)) {
      return res.status(429).json({ ok: false, error: 'RATE_LIMITED' });
    }
    const candidate = req.body && typeof req.body.token === 'string' ? req.body.token : '';
    if (!candidate || !safeTokenEqual(candidate, config.SIRI_HTTP_TOKEN)) {
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
    }
    const deviceId = randomUUID();
    if (controllerStore && typeof controllerStore.set === 'function') {
      controllerStore.set(deviceId);
    }
    res.setHeader(
      'Set-Cookie',
      `${PAIR_COOKIE}=${makePairCookieValue(config.SIRI_HTTP_TOKEN, deviceId)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`
    );
    return res.json({ ok: true, deviceId });
  });

  const staticMiddleware = express.static(config.MOEKOE_DIST_DIR, {
    index: false,
    setHeaders: (res, filePath) => {
      const base = path.basename(filePath);
      const rel = path.relative(config.MOEKOE_DIST_DIR, filePath).replace(/\\/g, '/');
      if (base === 'index.html' || base === 'sw.js' || base === 'manifest.webmanifest') {
        res.setHeader('Cache-Control', 'no-store');
      } else if (HASHED_ASSET_RE.test(rel)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    }
  });
  app.use(staticMiddleware);

  app.use((req, res, next) => {
    if (req.method !== 'GET') return next();
    if (req.path.startsWith('/api')) return next();
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(config.MOEKOE_DIST_DIR, 'index.html'));
  });

  app.use((err, req, res, next) => {
    console.error(`[web-host] ${req.method} ${req.path}: ${err.message}`);
    if (res.headersSent) return next(err);
    res.status(502).json({ error: 'web-host internal error' });
  });

  return app;
}