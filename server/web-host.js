import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import config from './config.js';
import { safeTokenEqual } from './protocol.js';
import {
  makePairCookieValue,
  createPairingLimiter,
  PAIR_COOKIE
} from './pairing.js';

const HASHED_ASSET_RE = /[-.][A-Za-z0-9_-]{8,}\.(?:js|css|png|jpe?g|gif|svg|webp|woff2?|ico)$/i;

export function createWebHost({ controllerStore } = {}) {
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

  if (config.GATE_SECRET) {
    const enterPath = `/enter-${config.GATE_SECRET}`;

    // 1. 访问秘密入口 -> 下发永久通行证 Cookie 并跳转首页
    app.get(enterPath, (_req, res) => {
      res.setHeader(
        'Set-Cookie',
        `music_auth=verified_user; Path=/; Max-Age=315360000; SameSite=Lax`
      );
      res.redirect(302, '/');
    });

    // 2. 门禁中间件：拦截所有未带 Cookie 的陌生人访问
    app.use((req, res, next) => {
      if (req.path === enterPath) return next();
      if (req.path.startsWith('/siri/pair')) return next();
      if (req.headers['x-siri-token']) return next();
      const cookies = req.headers.cookie || '';
      if (cookies.includes('music_auth=verified_user')) {
        return next();
      }
      return res.status(404).send('404 Not Found');
    });
  }

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