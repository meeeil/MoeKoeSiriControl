/**
 * Verify the MoeKoe Siri Control production build output.
 *
 * Checks:
 *  1. dist/index.html contains exactly one siri script.
 *  2. The siri script file exists and its SHA-256 short hash matches the
 *     filename.
 *  3. sw.js precaches the siri script and was generated after it.
 *  4. sw.js contains the current index.html revision (MD5 of the built file).
 *  5. The main bundle's default API base is `/api` (no hardcoded LAN URL).
 *  6. MoeKoeMusic working tree is clean.
 *
 * Exit code non-zero on any failure.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

dotenv.config({ path: path.join(projectRoot, '.env') });

const distDir = process.env.MOEKOE_DIST_DIR
  ? path.resolve(process.env.MOEKOE_DIST_DIR)
  : null;

let failures = 0;

function check(name, ok, detail) {
  const status = ok ? 'PASS' : 'FAIL';
  console.log(`[verify:web] ${status} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures++;
}

function sha256Short(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 10);
}

function md5(text) {
  return createHash('md5').update(text, 'utf8').digest('hex');
}

if (!distDir) {
  console.error('[verify:web] MOEKOE_DIST_DIR is not set in .env');
  process.exit(1);
}

const indexHtmlPath = path.join(distDir, 'index.html');
const swPath = path.join(distDir, 'sw.js');

// 1. single siri script in index.html
const indexHtml = readFileSync(indexHtmlPath, 'utf8');
const scriptMatches = [
  ...indexHtml.matchAll(/<script[^>]*src="\.\/(siri-control\.[a-f0-9]{10}\.js)"[^>]*>/g)
];
check('index.html has exactly one siri script', scriptMatches.length === 1, `${scriptMatches.length} found`);
if (scriptMatches.length !== 1) {
  console.error('[verify:web] cannot continue without a siri script in index.html');
  process.exit(1);
}
const siriFile = scriptMatches[0][1];

// 2. file exists + hash matches
const siriPath = path.join(distDir, siriFile);
check('siri script file exists', readFileExists(siriPath));
if (readFileExists(siriPath)) {
  const siriSource = readFileSync(siriPath, 'utf8');
  const expectedHash = siriFile.replace(/^siri-control\./, '').replace(/\.js$/, '');
  check(
    'siri filename hash matches content',
    sha256Short(siriSource) === expectedHash,
    `expected ${expectedHash}, got ${sha256Short(siriSource)}`
  );
  check(
    'siri script has no leftover build placeholders',
    !siriSource.includes('__SIRI_'),
    'unreplaced placeholder detected'
  );
}

// 3. sw.js precaches the siri script + is newer than it
const sw = readFileSync(swPath, 'utf8');
check('sw.js exists', true);
check('sw.js precaches siri script', sw.includes(siriFile));
if (readFileExists(siriPath)) {
  const siriMtime = statSync(siriPath).mtimeMs;
  const swMtime = statSync(swPath).mtimeMs;
  check('sw.js generated after siri script', swMtime >= siriMtime);
}

// 4. index.html revision in sw.js matches the built file
const revMatch = sw.match(/\{url:"index\.html",revision:"([a-f0-9]{32})"\}/);
check('sw.js contains index.html revision', !!revMatch);
if (revMatch) {
  const actual = md5(indexHtml);
  check('sw.js index.html revision matches built index.html', revMatch[1] === actual, `expected ${actual}`);
}

// 5. main bundle default API base is /api
const mainBundles = readdirSync(path.join(distDir, 'assets')).filter((f) => /^index-.*\.js$/.test(f));
check('main bundle present', mainBundles.length > 0, `${mainBundles.length} found`);
for (const file of mainBundles) {
  const content = readFileSync(path.join(distDir, 'assets', file), 'utf8');
  check(
    `main bundle ${file} has no hardcoded LAN API base`,
    !content.includes('http://127.0.0.1:6521')
  );
}

// 6. git clean
const moekoeDir = process.env.MOEKOE_DIR
  ? path.resolve(process.env.MOEKOE_DIR)
  : null;
const containerBuild = /^(?:1|true)$/i.test(String(process.env.CONTAINER_BUILD || ''));
if (moekoeDir && !containerBuild) {
  const git = spawnSync('git', ['status', '--short'], { cwd: moekoeDir, encoding: 'utf8' });
  const dirty = (git.stdout || '').trim();
  check('MoeKoeMusic working tree clean', dirty.length === 0, dirty || 'clean');
}

if (failures > 0) {
  console.error(`[verify:web] ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('[verify:web] all checks passed');
process.exit(0);

function readFileExists(p) {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}
