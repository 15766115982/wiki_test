import { mkdtempSync, cpSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SCRIPTS = join(REPO_ROOT, 'llm-wiki', 'scripts');
export const FIXTURES = join(REPO_ROOT, 'llm-wiki', 'fixtures');

export function tmp(prefix = 'llmwiki-test-') { return mkdtempSync(join(tmpdir(), prefix)); }

/** Run a script CLI; returns { code, json, stdout, stderr }. Never throws on non-zero exit. */
export function runScript(script, args, opts = {}) {
  const r = spawnSync(process.execPath, [join(SCRIPTS, script), ...args], {
    encoding: 'utf8', env: { ...process.env, ...(opts.env || {}) },
  });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* leave null */ }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

/**
 * Async variant of runScript. Required when the test itself hosts an in-process node:http
 * server (fake Jira/Confluence): spawnSync would block the event loop and deadlock the server.
 */
export function runScriptAsync(script, args, opts = {}) {
  return new Promise((res, rej) => {
    // spawn timeout: a wedged child fails the test (code null) instead of hanging the runner
    const p = spawn(process.execPath, [join(SCRIPTS, script), ...args],
      { env: { ...process.env, ...(opts.env || {}) }, timeout: opts.timeout ?? 60_000 });
    let stdout = '', stderr = '';
    p.stdout.on('data', d => { stdout += d; });
    p.stderr.on('data', d => { stderr += d; });
    p.on('error', rej);
    p.on('close', code => {
      let json = null;
      try { json = JSON.parse(stdout); } catch { /* leave null */ }
      res({ code, json, stdout, stderr });
    });
  });
}

export function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
}
export function gitInit(dir) { mkdirSync(dir, { recursive: true }); git(dir, 'init'); git(dir, 'add', '-A'); git(dir, 'commit', '-m', 'init', '--allow-empty'); }

/** Minimal valid KB tree (§2.1) without content; caller fills raw/wiki files. */
export function makeKb(dir, kbJson = {}) {
  const dirs = ['raw/jira', 'raw/confluence', 'raw/chat', 'raw/local', 'raw/openwiki', 'raw/assets',
    'wiki/sources', 'wiki/syntheses', 'wiki/concepts', 'wiki/entities', 'wiki/archive', '.kb/govern/reports', '.kb/site'];
  for (const d of dirs) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'kb.json'), JSON.stringify({ contract_version: 1, language: 'en', ...kbJson }, null, 2));
  writeFileSync(join(dir, 'GOVERNANCE.md'), '');
  writeFileSync(join(dir, 'log.md'), '');
  writeFileSync(join(dir, '.gitignore'), '.kb/\n');
  return dir;
}

/** Write a raw doc with frontmatter + body; returns absolute path. */
export function writeRaw(kb, source, sourceId, fm, body) {
  const p = join(kb, 'raw', source, sourceId + '.md');
  const lines = ['---'];
  for (const [k, v] of Object.entries({ source, source_id: sourceId, ...fm }))
    lines.push(`${k}: ${Array.isArray(v) ? '[' + v.join(', ') + ']' : v}`);
  lines.push('---', '', body);
  writeFileSync(p, lines.join('\n'));
  return p;
}

export const read = (p) => readFileSync(p, 'utf8');
export const exists = (p) => existsSync(p);
export { join, resolve, mkdirSync, writeFileSync, cpSync };
