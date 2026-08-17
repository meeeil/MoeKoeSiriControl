/**
 * External Vite config for the MoeKoe Siri Control web build.
 *
 * Imports the original MoeKoeMusic `vite.config.js`, then appends an
 * injection plugin that:
 *  1. Reads `client/siri-control.cjs`.
 *  2. Replaces build constants (WS token, control port, WS path, API base,
 *     version).
 *  3. Computes a SHA-256 short hash of the final script.
 *  4. Emits `siri-control.<hash>.js` via generateBundle (part of the Vite/PWA
 *     build graph, so it is picked up by VitePWA's precache generation in
 *     closeBundle).
 *  5. Injects `<script defer src="./siri-control.<hash>.js">` into index.html
 *     before `</body>`.
 *
 * MUST run with cwd = MoeKoeMusic and `VITE_APP_API_URL=/api`.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import dotenv from 'dotenv';

/**
 * Vite bundles this config into `node_modules/.vite-temp/...`, so
 * `import.meta.url` no longer points at the project root. Prefer the
 * SIRI_PROJECT_ROOT env var (set by build-web.mjs), then fall back to
 * walking up from the bundled location.
 */
function resolveProjectRoot() {
  if (process.env.SIRI_PROJECT_ROOT) {
    return path.resolve(process.env.SIRI_PROJECT_ROOT);
  }
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    if (existsSync(path.join(dir, 'client', 'siri-control.cjs'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('cannot resolve MoeKoeSiriControl project root');
}

const projectRoot = resolveProjectRoot();

dotenv.config({ path: path.join(projectRoot, '.env') });

const moekoeDir = process.env.MOEKOE_DIR
  ? path.resolve(process.env.MOEKOE_DIR)
  : null;

if (!moekoeDir) {
  throw new Error('MOEKOE_DIR is not set in .env');
}

const controlPort = String(process.env.CONTROL_PORT || '8200');
const wsPath = String(process.env.SIRI_WS_PATH || '/ws');
const apiBase = String(process.env.SIRI_API_BASE || '/api');
const version = String(process.env.SIRI_VERSION || '1.0.0');
const wsToken = String(process.env.SIRI_WS_TOKEN || '');

if (!wsToken || wsToken.length < 32) {
  throw new Error('SIRI_WS_TOKEN must be set and at least 32 bytes in .env');
}

const clientSourcePath = path.join(projectRoot, 'client', 'siri-control.cjs');
const clientTemplate = readFileSync(clientSourcePath, 'utf8');

const escapeSingleQuoted = (value) =>
  String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

// Placeholders are single-quoted in the source, so replace the raw value.
const finalClientSource = clientTemplate
  .replaceAll('__SIRI_WS_TOKEN__', () => escapeSingleQuoted(wsToken))
  .replaceAll('__SIRI_CONTROL_PORT__', () => escapeSingleQuoted(controlPort))
  .replaceAll('__SIRI_WS_PATH__', () => escapeSingleQuoted(wsPath))
  .replaceAll('__SIRI_API_BASE__', () => escapeSingleQuoted(apiBase))
  .replaceAll('__SIRI_VERSION__', () => escapeSingleQuoted(version));

if (finalClientSource.includes('__SIRI_WS_TOKEN__')) {
  throw new Error('siri-control.cjs did not replace __SIRI_WS_TOKEN__');
}

const hash = createHash('sha256').update(finalClientSource, 'utf8').digest('hex').slice(0, 10);
const siriFileName = `siri-control.${hash}.js`;
const siriScriptTag = `<script defer src="./${siriFileName}"></script>`;

const { default: baseConfig } = await import(
  pathToFileURL(path.join(moekoeDir, 'vite.config.js')).href
);

const siriInjectionPlugin = {
  name: 'siri-control-inject',
  apply: 'build',
  transformIndexHtml(html) {
    if (html.includes(siriScriptTag)) return html;
    if (!html.includes('</body>')) {
      throw new Error('index.html has no </body> to inject the siri script');
    }
    return html.replace('</body>', `${siriScriptTag}\n</body>`);
  },
  generateBundle() {
    this.emitFile({
      type: 'asset',
      fileName: siriFileName,
      source: finalClientSource
    });
  }
};

const pluginConfig = Array.isArray(baseConfig.plugins) ? baseConfig.plugins : [];
const mergedPlugins = [...pluginConfig, siriInjectionPlugin];

export default {
  ...baseConfig,
  plugins: mergedPlugins,
  define: {
    ...(baseConfig.define || {}),
    __SIRI_CONTROL__: JSON.stringify({
      version,
      controlPort,
      wsPath,
      apiBase,
      siriFileName,
      hash
    })
  },
  build: {
    ...(baseConfig.build || {}),
    outDir: baseConfig.build?.outDir || 'dist'
  }
};