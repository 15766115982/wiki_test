import test from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { runScript, tmp, read, exists, join, resolve, mkdirSync, SCRIPTS } from './helpers.mjs';

const install = await import(pathToFileURL(join(SCRIPTS, 'install.mjs')).href);
const SKILL_DIR = resolve(SCRIPTS, '..');
const SKILL_VERSION = install.readVersion(); // parsed from CHANGELOG.md — never hardcode, it drifts on version bumps

test('install: projects to target; fallback copy writes version stamp; update re-projects and warns on drift', () => {
  const target = tmp();
  const r = runScript('install.mjs', ['--target', target]);
  assert.equal(r.code, 0);
  const dest = join(target, 'llm-wiki');
  assert.ok(exists(join(dest, 'SKILL.md')));
  assert.ok(['junction', 'symlink', 'copy'].includes(r.json.mode));
  if (r.json.mode === 'copy') {
    const stamp = JSON.parse(read(join(dest, '.install-source.json')));
    assert.equal(stamp.version, SKILL_VERSION);
  }
  // drift: modify stamp version, then update → warnings non-empty
});

test('install: expandHome/resolveTarget — ~ expansion, absolute passthrough, default target', () => {
  assert.equal(install.expandHome('~'), homedir());
  assert.equal(install.expandHome('~/x'), join(homedir(), 'x'));
  const abs = resolve(join(tmp(), 'abs'));
  assert.equal(install.expandHome(abs), abs);
  assert.equal(install.resolveTarget(undefined), resolve(homedir(), '.agents', 'skills'));
  assert.equal(install.resolveTarget(abs), resolve(abs));
});

test('install: existing dest without stamp → exit 1 refusal, dest untouched', () => {
  const target = tmp();
  const dest = join(target, 'llm-wiki');
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, 'sentinel.txt'), 'do not touch');
  const r = runScript('install.mjs', ['--target', target]);
  assert.equal(r.code, 1);
  assert.match(r.json.error.message, /not installed by this tool/);
  assert.equal(read(join(dest, 'sentinel.txt')), 'do not touch');
  assert.ok(!exists(join(dest, 'SKILL.md')));
});

test('install: copy-mode drift on update → warning + refreshed stamp (LLM_WIKI_INSTALL_FORCE=copy)', () => {
  const target = tmp();
  const env = { LLM_WIKI_INSTALL_FORCE: 'copy' };
  const dest = join(target, 'llm-wiki');
  const stampPath = join(dest, '.install-source.json');
  const stampAt = () => JSON.parse(read(stampPath));

  let r = runScript('install.mjs', ['--target', target], { env });
  assert.equal(r.code, 0);
  assert.equal(r.json.mode, 'copy');
  assert.equal(stampAt().version, SKILL_VERSION);
  assert.equal(stampAt().source, resolve(SKILL_DIR).replace(/\\/g, '/'));

  // no drift → update re-projects silently
  r = runScript('install.mjs', ['update', '--target', target], { env });
  assert.equal(r.code, 0);
  assert.deepEqual(r.json.warnings, []);

  // drift: stamp says an old version → update warns and rewrites the stamp with the current version
  writeFileSync(stampPath, JSON.stringify({ ...stampAt(), version: '0.9.0' }));
  r = runScript('install.mjs', ['update', '--target', target], { env });
  assert.equal(r.code, 0);
  assert.ok(r.json.warnings.length > 0, `expected drift warning, got ${r.stdout}`);
  assert.match(r.json.warnings[0], /0\.9\.0/);
  assert.match(r.json.warnings[0], new RegExp(SKILL_VERSION.replace(/\./g, '\\.')));
  assert.equal(stampAt().version, SKILL_VERSION);
  assert.ok(exists(join(dest, 'SKILL.md')));
});

test('install: link mode resolves to the skill source (copy fallback still functional)', () => {
  const target = tmp();
  const r = runScript('install.mjs', ['--target', target]);
  assert.equal(r.code, 0);
  const dest = join(target, 'llm-wiki');
  assert.ok(exists(join(dest, 'SKILL.md')));
  assert.ok(exists(join(dest, 'scripts', 'install.mjs')));
  if (r.json.mode === 'junction' || r.json.mode === 'symlink') {
    assert.equal(realpathSync(dest), realpathSync(SKILL_DIR));
  }
});

test('install: update on link pointing elsewhere → rebuilt + warning', (t) => {
  const target = tmp();
  const dest = join(target, 'llm-wiki');
  const decoy = tmp();
  writeFileSync(join(decoy, 'decoy.txt'), 'x');
  try { symlinkSync(resolve(decoy), dest, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (e) { t.skip(`links not permitted in this environment: ${e.code || e}`); return; }
  const r = runScript('install.mjs', ['update', '--target', target]);
  assert.equal(r.code, 0);
  assert.ok(r.json.warnings.length > 0, `expected drift warning, got ${r.stdout}`);
  assert.ok(exists(join(dest, 'SKILL.md')), 'link should now resolve to the real skill source');
  assert.ok(!exists(join(dest, 'decoy.txt')));
  if (r.json.mode === 'junction' || r.json.mode === 'symlink') {
    assert.equal(realpathSync(dest), realpathSync(SKILL_DIR));
  }
});

test('install: usage errors → exit 64 with JSON stdout', () => {
  for (const args of [['--bogus'], ['update', 'extra'], ['--target']]) {
    const r = runScript('install.mjs', args);
    assert.equal(r.code, 64, JSON.stringify(args));
    assert.ok(r.json && r.json.error, `stdout not JSON: ${r.stdout}`);
  }
});

test('install: stdout paths are forward-slashed', () => {
  const r = runScript('install.mjs', ['--target', tmp()]);
  assert.equal(r.code, 0);
  assert.ok(!r.json.target.includes('\\'), r.json.target);
});
