// @vitest-environment node
import { afterEach, beforeEach, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pocket-wasm-test-'));
  for (const dir of ['scripts', 'bin', 'public/wasm']) mkdirSync(join(root, dir), { recursive: true });
  copyFileSync(new URL('../scripts/build-wasm.sh', import.meta.url), join(root, 'scripts/build-wasm.sh'));
  writeFileSync(join(root, 'public/wasm/pocket_tts.js'), 'existing JS');
  writeFileSync(join(root, 'public/wasm/pocket_tts_bg.wasm'), 'existing WASM');
  writeFileSync(join(root, 'public/wasm/models.json'), '{"schemaVersion":1,"sourceRevision":"catalog-fixture"}');
  // Never allow a regression to launch a real source checkout/build.
  executable('git', 'echo "unexpected source build" >&2; exit 90');
  executable('gh', 'echo "unexpected authenticated download" >&2; exit 91');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function executable(name, body) {
  writeFileSync(join(root, 'bin', name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
}

function run() {
  const env = { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}` };
  for (const key of ['POCKET_TTS_DIR', 'POCKET_TTS_REPO', 'POCKET_TTS_REF', 'POCKET_TTS_REPO_URL']) delete env[key];
  return spawnSync('bash', ['scripts/build-wasm.sh'], { cwd: root, env, encoding: 'utf8' });
}

function expectExistingArtifacts() {
  expect(readFileSync(join(root, 'public/wasm/pocket_tts.js'), 'utf8')).toBe('existing JS');
  expect(readFileSync(join(root, 'public/wasm/pocket_tts_bg.wasm'), 'utf8')).toBe('existing WASM');
  expect(readFileSync(join(root, 'public/wasm/models.json'), 'utf8')).toBe('{"schemaVersion":1,"sourceRevision":"catalog-fixture"}');
}

function releaseFixture(catalog) {
  const files = join(root, 'release');
  mkdirSync(files);
  writeFileSync(join(files, 'pocket_tts.js'), 'release JS');
  writeFileSync(join(files, 'pocket_tts_bg.wasm'), 'release WASM');
  const members = ['pocket_tts.js', 'pocket_tts_bg.wasm'];
  if (catalog !== null) {
    writeFileSync(join(files, 'models.json'), catalog);
    members.push('models.json');
  }
  const archive = join(root, 'release.tar.gz');
  expect(spawnSync('tar', ['-czf', archive, '-C', files, ...members]).status).toBe(0);
  executable('curl', `cat '${archive}'`);
  // Archive fixtures bypass the pinned production checksum; the
  // corrupt-download test below exercises the real checksum verifier.
  executable('shasum', 'cat >/dev/null');
}

it.each([true, false])('installs JS, WASM and catalog together (existing install: %s)', (existingInstall) => {
  releaseFixture('{"schemaVersion":1,"sourceRevision":"release-fixture"}');
  if (!existingInstall) rmSync(join(root, 'public/wasm'), { recursive: true });
  const result = run();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(readFileSync(join(root, 'public/wasm/pocket_tts.js'), 'utf8')).toBe('release JS');
  expect(readFileSync(join(root, 'public/wasm/pocket_tts_bg.wasm'), 'utf8')).toBe('release WASM');
  expect(readFileSync(join(root, 'public/wasm/models.json'), 'utf8')).toBe('{"schemaVersion":1,"sourceRevision":"release-fixture"}');
});

it.each([null, '{"schemaVersion":2}'])('preserves the existing installation if the release catalog is missing or unsupported: %s', (catalog) => {
  releaseFixture(catalog);
  const result = run();
  expect(result.status).not.toBe(0);
  expect(result.stdout + result.stderr).toMatch(/models\.json|Unsupported model catalog schema/);
  expectExistingArtifacts();
});

it('rejects an untrusted download before extracting or replacing either existing artifact', () => {
  executable('curl', 'printf "corrupted archive"');
  const result = run();
  expect(result.status).not.toBe(0);
  expect(result.stdout + result.stderr).toMatch(/checksum.*(failed|mismatch)/i);
  expectExistingArtifacts();
});

it('reports an unavailable release without silently building different source', () => {
  executable('curl', 'echo "release unavailable" >&2; exit 1');
  const result = run();
  expect(result.status).not.toBe(0);
  expect(result.stdout + result.stderr).toContain('release unavailable');
  expect(result.stdout + result.stderr).not.toContain('unexpected source build');
  expectExistingArtifacts();
});
