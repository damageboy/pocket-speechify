import { defineConfig } from 'wxt';
import { execSync } from 'child_process';
import { existsSync } from 'fs';

function computeVersion() {
  try {
    const tag = execSync('git describe --tags --abbrev=0', { encoding: 'utf8' }).trim();
    const base = tag.replace(/^v/, '');
    const parts = base.split('.');
    parts[parts.length - 1] = String(Number(parts[parts.length - 1]) + 1);
    const numeric = parts.join('.');

    const isDirty = execSync('git status --porcelain', { encoding: 'utf8' }).trim().length > 0;
    const hash = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
    const full = isDirty ? `${numeric}-${hash}-dirty` : `${numeric}-${hash}`;

    return { numeric, full };
  } catch {
    return { numeric: '0.0.1', full: '0.0.1-dev' };
  }
}

const { numeric: version, full: versionName } = computeVersion();

export default defineConfig({
  srcDir: '.',
  manifest: {
    name: 'Pocket Speechify',
    version,
    version_name: versionName,
    description: 'Text-to-speech with a floating pill player',
    permissions: ['offscreen', 'storage'],
    icons: {
      16: 'assets/icons/icon16.png',
      32: 'assets/icons/icon32.png',
      48: 'assets/icons/icon48.png',
      128: 'assets/icons/icon128.png',
    },
    action: {
      default_icon: {
        16: 'assets/icons/icon16.png',
        32: 'assets/icons/icon32.png',
        48: 'assets/icons/icon48.png',
      },
      default_title: 'Pocket Speechify',
    },
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
    web_accessible_resources: [
      {
        resources: ['assets/*', 'css/*'],
        matches: ['<all_urls>'],
      },
    ],
  },
  vite: () => ({
    plugins: [
      {
        name: 'pocket-tts-wasm-build',
        async buildStart() {
          if (!existsSync('public/wasm/pocket_tts_bg.wasm')) {
            console.log('[wxt] WASM artifacts missing, running build-wasm.sh...');
            execSync('bash scripts/build-wasm.sh', { stdio: 'inherit' });
          }
        },
      },
    ],
  }),
});
