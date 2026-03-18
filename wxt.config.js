import { defineConfig } from 'wxt';
import { execSync } from 'child_process';
import { existsSync } from 'fs';

export default defineConfig({
  srcDir: '.',
  manifest: {
    name: 'Pocket Speechify',
    version: '0.2.0',
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
