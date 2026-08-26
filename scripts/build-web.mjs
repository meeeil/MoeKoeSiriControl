/**
 * Build the MoeKoeMusic production dist with the Siri client injected.
 *
 * Flow:
 *  1. Load and validate `.env`.
 *  2. Assert MoeKoeMusic working tree is clean (dist is git-ignored).
 *  3. Run `vite build` with cwd = MOEKOE_DIR and `VITE_APP_API_URL=/api`
 *     using `vite.siri.config.mjs`.
 *  4. Write a build marker used by start-all.ps1 / verify-build.mjs.
 *
 * Exit code non-zero on any failure. Never post-process the built HTML.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, cpSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { readEnvOrFile } from '../server/env-source.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

dotenv.config({ path: path.join(projectRoot, '.env') });

const containerBuild = /^(?:1|true)$/i.test(String(process.env.CONTAINER_BUILD || ''));

function fail(message) {
  console.error(`[build-web] ${message}`);
  process.exit(1);
}

function requireEnv(name, minLength = 0) {
  const value = String(readEnvOrFile(name));
  if (value.length < minLength) {
    fail(`missing or too short ${name} in .env (need >= ${minLength} chars)`);
  }
  return value;
}

// 1. validate
const moekoeDir = path.resolve(requireEnv('MOEKOE_DIR'));
const wsToken = requireEnv('SIRI_WS_TOKEN', 32);
if (!containerBuild) {
  const httpToken = requireEnv('SIRI_HTTP_TOKEN', 32);
  if (httpToken === wsToken) {
    fail('SIRI_HTTP_TOKEN and SIRI_WS_TOKEN must be different');
  }
}
if (!existsSync(path.join(moekoeDir, 'package.json'))) {
  fail(`MOEKOE_DIR does not contain package.json: ${moekoeDir}`);
}
if (!existsSync(path.join(moekoeDir, 'node_modules', 'vite'))) {
  fail('MoeKoeMusic node_modules is missing (run npm install there first)');
}

if (!containerBuild) {
  // 2. git clean check (local builds only; Docker contexts intentionally omit .git)
  const gitCheck = spawnSync('git', ['status', '--short'], {
    cwd: moekoeDir,
    encoding: 'utf8'
  });
  if (gitCheck.status !== 0) {
    fail('failed to run git status in MoeKoeMusic');
  }
  const dirty = (gitCheck.stdout || '').trim();
  if (dirty) {
    console.error('[build-web] MoeKoeMusic working tree is not clean:');
    console.error(dirty);
    fail('aborting build to avoid generating un-tracked source changes');
  }
}

// 2b. snapshot the current dist before replacing it (rollback source)
const distDir = path.resolve(
  process.env.MOEKOE_DIST_DIR || path.join(moekoeDir, 'dist')
);
const backupsDir = path.join(projectRoot, 'backups');
const prevDir = path.join(backupsDir, 'dist.prev');
const prevOldDir = path.join(backupsDir, 'dist.prev.old');
if (!containerBuild && existsSync(distDir) && readdirSync(distDir).length > 0) {
  mkdirSync(backupsDir, { recursive: true });
  if (existsSync(prevDir)) {
    rmSync(prevOldDir, { recursive: true, force: true });
    cpSync(prevDir, prevOldDir, { recursive: true });
    rmSync(prevDir, { recursive: true, force: true });
  }
  cpSync(distDir, prevDir, { recursive: true });
  console.log('[build-web] snapshot current dist -> backups/dist.prev');
}

// 3. run vite build
const moekoePackage = JSON.parse(
  readFileSync(path.join(moekoeDir, 'package.json'), 'utf8')
);
const viteEntry = path.join(moekoeDir, 'node_modules', 'vite', 'bin', 'vite.js');
const configPath = path.join(projectRoot, 'vite.siri.config.mjs');

console.log('[build-web] running vite build (cwd=%s)', moekoeDir);
const buildResult = spawnSync(
  process.execPath,
  [viteEntry, 'build', '--config', configPath],
  {
    cwd: moekoeDir,
    env: {
      ...process.env,
      SIRI_PROJECT_ROOT: projectRoot,
      VITE_APP_API_URL: '/api',
      npm_package_version: moekoePackage.version || '1.0.0'
    },
    stdio: 'inherit',
    encoding: 'utf8'
  }
);
if (buildResult.error) {
  fail(`failed to spawn vite: ${buildResult.error.message}`);
}
if (buildResult.status !== 0) {
  fail(`vite build exited with code ${buildResult.status}`);
}

// 4. build marker
const marker = {
  version: process.env.SIRI_VERSION || '1.0.0',
  builtAt: new Date().toISOString(),
  moekoeDir,
  moekoeVersion: moekoePackage.version,
  apiBase: '/api'
};
mkdirSync(path.join(projectRoot, 'run'), { recursive: true });
writeFileSync(
  path.join(projectRoot, 'run', 'build-ok.json'),
  JSON.stringify(marker, null, 2)
);

console.log('[build-web] done. Run `npm run verify:web` next.');
process.exit(0);
