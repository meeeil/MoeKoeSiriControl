import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createWebHost } from '../server/web-host.js';
import { verifyPairCookie, PAIR_COOKIE } from '../server/pairing.js';
import config from '../server/config.js';

const app = createWebHost();
let baseUrl;
let appServer;
before(async () => {
  await new Promise((resolve) => {
    appServer = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${appServer.address().port}`;
});

after(() => appServer.close());

test('GET /siri/pair serves the pairing page', async () => {
  const res = await fetch(`${baseUrl}/siri/pair`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control') || '', /no-store/);
  const html = await res.text();
  assert.match(html, /MoeKoe Siri/);
  assert.match(html, /siri\/pair/);
});

test('POST /siri/pair with correct token sets an HMAC pairing cookie', async () => {
  const res = await fetch(`${baseUrl}/siri/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: config.SIRI_HTTP_TOKEN })
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  const setCookie = res.headers.get('set-cookie') || '';
  assert.match(setCookie, new RegExp(`^${PAIR_COOKIE}=`));
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  assert.match(setCookie, /Path=\//);
  const value = setCookie.split(';')[0].split('=')[1];
  assert.equal(verifyPairCookie(`${PAIR_COOKIE}=${value}`, config.SIRI_HTTP_TOKEN), true);
});

test('POST /siri/pair with wrong/missing token -> 401', async () => {
  const wrong = await fetch(`${baseUrl}/siri/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'wrong-token' })
  });
  assert.equal(wrong.status, 401);

  const missing = await fetch(`${baseUrl}/siri/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  assert.equal(missing.status, 401);
});

test('POST /siri/pair is rate limited to 5 per IP per minute', async () => {
  const limiterApp = createWebHost();
  let limiterServer;
  await new Promise((resolve) => {
    limiterServer = limiterApp.listen(0, '127.0.0.1', resolve);
  });
  const url = `http://127.0.0.1:${limiterServer.address().port}`;
  for (let i = 0; i < 5; i += 1) {
    const res = await fetch(`${url}/siri/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: config.SIRI_HTTP_TOKEN })
    });
    assert.equal(res.status, 200, `hit ${i} should be allowed`);
  }
  const blocked = await fetch(`${url}/siri/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: config.SIRI_HTTP_TOKEN })
  });
  assert.equal(blocked.status, 429);
  const body = await blocked.json();
  assert.equal(body.error, 'RATE_LIMITED');
  await new Promise((resolve) => limiterServer.close(resolve));
});