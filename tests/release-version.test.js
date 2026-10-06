// @vitest-environment node
import { afterEach, beforeEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let root;
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pocket-version-test-'));
  git('init', '-q');
  git('config', 'user.name', 'Release Test');
  git('config', 'user.email', 'release@example.test');
  git('config', 'commit.gpgsign', 'false');
  git('commit', '--allow-empty', '-qm', 'Release fixture');
  git('tag', 'v0.10.0');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function manifestVersion() {
  const config = new URL('../wxt.config.js', import.meta.url).href;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
    `const { default: config } = await import(${JSON.stringify(config)}); console.log(JSON.stringify(config.manifest));`,
  ], { cwd: root, encoding: 'utf8' }));
}

it('uses the exact release tag in the packaged manifest without incrementing it', () => {
  expect(manifestVersion()).toMatchObject({ version: '0.10.0', version_name: '0.10.0' });
});

it('increments development builds after the release and includes their commit identity', () => {
  git('commit', '--allow-empty', '-qm', 'Development fixture');
  const hash = git('rev-parse', '--short', 'HEAD');
  expect(manifestVersion()).toMatchObject({ version: '0.10.1', version_name: `0.10.1-${hash}` });
});

it('does not label uncommitted changes on a tagged commit as a clean release', () => {
  writeFileSync(join(root, 'uncommitted.txt'), 'Local changes');
  const hash = git('rev-parse', '--short', 'HEAD');
  expect(manifestVersion()).toMatchObject({ version: '0.10.0', version_name: `0.10.0-${hash}-dirty` });
});
