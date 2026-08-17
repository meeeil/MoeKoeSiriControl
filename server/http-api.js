/**
 * HTTP API (Phase 5) mounted on the control server's express app (port 8200).
 *
 *   POST /api/siri/play   body {"query":"..."}  (or ?query=) + x-siri-token
 *   GET  /debug/status    x-siri-token required
 *
 * Flow: check auth -> check an authenticated WS client exists -> submit pending
 * -> broadcast play.req -> wait for the matching play.ack (up to
 * HTTP_ACK_WAIT_MS) -> respond with the ack.
 *
 * Token is accepted via `x-siri-token` header (preferred) or `token` query
 * param; compared in constant time.
 */
import express from 'express';
import config from './config.js';
import { safeTokenEqual } from './protocol.js';

export function createHttpApi({
  broadcast,
  sendPlayRequest,
  authenticatedClients,
  activeClients,
  pending,
  offlineCommand,
  getNow = () => Date.now(),
  log = () => {}
}) {
  const router = express.Router();
  router.use(express.json());

  function authed(req, res, next) {
    const header = req.headers['x-siri-token'];
    const queryToken = typeof req.query.token === 'string' ? req.query.token : '';
    const candidate = typeof header === 'string' ? header : queryToken;
    if (!candidate || !safeTokenEqual(candidate, config.SIRI_HTTP_TOKEN)) {
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
    }
    next();
  }

  function queuedResponse(res, queued) {
    const expiresIn = Math.max(0, Math.ceil((queued.expiresAt - getNow()) / 1000));
    return res.status(202).json({
      ok: true,
      status: 'queued',
      reqId: queued.reqId,
      expiresIn
    });
  }

  router.post('/api/siri/play', authed, async (req, res) => {
    const bodyQuery = req.body && typeof req.body.query === 'string' ? req.body.query : '';
    const query = String(bodyQuery || req.query.query || '').trim();
    if (!query) {
      return res.status(400).json({ ok: false, error: 'BAD_REQUEST', message: 'query is required' });
    }

    if (authenticatedClients() === 0) {
      const queued = offlineCommand.submit(query);
      log('[http] play queued (no client)', queued.reqId, `query=${query}`);
      return queuedResponse(res, queued);
    }

    const { reqId, expiresAt, promise } = pending.submit(query);
    const dispatch = typeof sendPlayRequest === 'function' ? sendPlayRequest : broadcast;
    const sent = dispatch({ type: 'play.req', reqId, query, expiresAt });
    if (sent === 0) {
      // Race: a client was detected but vanished before delivery. Park the
      // command in the offline slot instead of failing with NO_CLIENT.
      pending.handleAck({ reqId, ok: false, error: 'NO_CLIENT' });
      const queued = offlineCommand.submit(query);
      log('[http] play re-queued (dispatch race)', queued.reqId, `query=${query}`);
      return queuedResponse(res, queued);
    }
    log('[http] play sent', reqId, `query=${query}`);

    const ack = await promise;
    if (ack && ack.error === 'TIMEOUT') {
      return res.status(504).json({ ok: false, reqId, error: 'TIMEOUT' });
    }
    const { type: _type, ...payload } = ack || {};
    return res.json({
      ok: !!(ack && ack.ok),
      reqId,
      ...payload
    });
  });

  router.get('/api/siri/commands/:reqId', authed, (req, res) => {
    const reqId = String(req.params.reqId || '');
    if (!reqId) {
      return res.status(400).json({ ok: false, error: 'BAD_REQUEST' });
    }
    const snap = offlineCommand.get(reqId);
    if (!snap) {
      return res.status(404).json({ ok: false, error: 'COMMAND_NOT_FOUND' });
    }
    const payload = { ok: true, reqId, status: snap.state };
    if (snap.state === 'succeeded' && snap.ack && snap.ack.song) {
      payload.song = snap.ack.song;
    } else if (snap.state === 'failed') {
      payload.error = (snap.ack && snap.ack.error) || snap.error || 'FAILED';
    } else if (snap.state === 'queued' || snap.state === 'dispatched') {
      payload.expiresIn = Math.max(0, Math.ceil(snap.remainingMs / 1000));
    }
    return res.json(payload);
  });

  router.get('/debug/status', authed, (_req, res) => {
    res.json({
      ok: true,
      version: config.VERSION,
      protocol: config.PROTOCOL_VERSION,
      activeClients: activeClients(),
      authenticatedClients: authenticatedClients(),
      pending: {
        count: pending.count,
        items: pending.list()
      },
      offline: {
        state: offlineCommand.state,
        hasActive: offlineCommand.hasActive,
        terminalCount: offlineCommand.terminalCount,
        current: offlineCommand.current()
      }
    });
  });

  return router;
}