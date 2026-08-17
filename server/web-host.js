import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import path from 'node:path';
import config from './config.js';
import { safeTokenEqual } from './protocol.js';
import {
  derivePairValue,
  createPairingLimiter,
  PAIR_COOKIE
} from './pairing.js';

const HASHED_ASSET_RE = /[-.][A-Za-z0-9_-]{8,}\.(?:js|css|png|jpe?g|gif|svg|webp|woff2?|ico)$/i;

export function createWebHost() {
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

  app.post('/siri/pair', express.json(), (req, res) => {
    const ip = String(req.ip || 'unknown');
    if (!pairLimiter.allow(ip)) {
      return res.status(429).json({ ok: false, error: 'RATE_LIMITED' });
    }
    const candidate = req.body && typeof req.body.token === 'string' ? req.body.token : '';
    if (!candidate || !safeTokenEqual(candidate, config.SIRI_HTTP_TOKEN)) {
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
    }
    res.setHeader(
      'Set-Cookie',
      `${PAIR_COOKIE}=${derivePairValue(config.SIRI_HTTP_TOKEN)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`
    );
    return res.json({ ok: true });
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