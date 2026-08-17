import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { runScript, runScriptAsync, makeKb, writeRaw, tmp, git, gitInit, read, exists, join, mkdirSync, writeFileSync } from './helpers.mjs';
import { sniffSelector, contentHash as contentHashAcquire } from '../llm-wiki/scripts/acquire.mjs';
import { splitFrontmatter, contentHash } from '../llm-wiki/scripts/validate.mjs';

const NOENV = { ...process.env, LLM_WIKI_KB: undefined };
const run = (args) => runScript('acquire.mjs', args, { env: NOENV });

/** Upstream OpenWiki fixture repo: collision pair + skip-list files + nested page. */
function makeOpenwikiRepo({ withGit = true } = {}) {
  const repo = tmp();
  const ow = join(repo, 'openwiki');
  mkdirSync(join(ow, 'architecture'), { recursive: true });
  mkdirSync(join(ow, 'a'), { recursive: true });
  writeFileSync(join(ow, 'index.md'), '# Index\n');
  writeFileSync(join(ow, 'architecture', 'overview.md'), '# Overview\n');
  writeFileSync(join(ow, 'a', 'b.md'), '# a/b\n');
  writeFileSync(join(ow, 'a--b.md'), '# a--b\n');
  writeFileSync(join(ow, 'INSTRUCTIONS.md'), 'do not ingest\n');
  writeFileSync(join(ow, '.last-update.json'), '{}');
  writeFileSync(join(ow, 'source-maps.json'), '{}');
  if (withGit) gitInit(repo);
  return repo;
}

function readRaw(kb, id) {
  return splitFrontmatter(read(join(kb, 'raw', 'openwiki', id + '.md')));
}

// ---- selector sniffing (§1.4) ----

test('selector sniffing: url > issue key > query > error', () => {
  assert.equal(sniffSelector('https://jira.x.com/browse/PROJ-1'), 'url');
  assert.equal(sniffSelector('PROJ-123'), 'key');
  assert.equal(sniffSelector('project = PAY ORDER BY updated'), 'query');
  assert.equal(sniffSelector('assignee=me'), 'query');
  assert.equal(sniffSelector('pay core team'), 'query');        // whitespace
  assert.equal(sniffSelector('PROJ-'), null);
  assert.equal(sniffSelector('lowercase'), null);               // single lowercase word
});

// ---- CLI contract: jira/confluence connectors configured via kb.json (§2.7) ----

test('jira/confluence: connector not configured in kb.json → exit 1 JSON error naming kb.json connectors.<x>', () => {
  const kb = makeKb(tmp()); // no connectors block
  for (const cmd of ['jira', 'confluence']) {
    const r = run([cmd, '--kb', kb, '--selector', 'PROJ-1']);
    assert.equal(r.code, 1);
    assert.equal(r.json.error.code, 'connector-not-configured');
    assert.match(r.json.error.hint, new RegExp(`connectors\\.${cmd}`));
  }
});

test('CLI: unsniffable selector → exit 64 with hint listing all four legal forms', () => {
  const kb = makeKb(tmp());
  const r = run(['jira', '--kb', kb, '--selector', 'lowercase']);
  assert.equal(r.code, 64);
  assert.match(r.json.error.hint, /URL/);
  assert.match(r.json.error.hint, /PROJ-123/);
  assert.match(r.json.error.hint, /JQL/);
  assert.match(r.json.error.hint, /CQL/);
});

test('CLI: explicit --selector-type wins over sniffing', () => {
  const kb = makeKb(tmp());
  // 'PROJ-1' sniffs as key; explicit cql is legal for confluence → passes validation →
  // reaches the connector, which then reports the missing connectors.confluence config
  const r = run(['confluence', '--kb', kb, '--selector', 'PROJ-1', '--selector-type', 'cql']);
  assert.equal(r.code, 1);
  assert.equal(r.json.error.code, 'connector-not-configured');
});

test('CLI: --selector-type jql with confluence (or cql with jira) → exit 64', () => {
  const kb = makeKb(tmp());
  assert.equal(run(['confluence', '--kb', kb, '--selector', 'x = y', '--selector-type', 'jql']).code, 64);
  assert.equal(run(['jira', '--kb', kb, '--selector', 'x = y', '--selector-type', 'cql']).code, 64);
  assert.equal(run(['jira', '--kb', kb, '--selector', 'PROJ-1', '--selector-type', 'bogus']).code, 64);
});

test('CLI: missing --selector / unknown subcommand → exit 64', () => {
  const kb = makeKb(tmp());
  assert.equal(run(['jira', '--kb', kb]).code, 64);
  assert.equal(run(['gitlab', '--kb', kb]).code, 64);
});

test('CLI: bad boolean flag value → exit 64; --flag=false accepted', () => {
  const kb = makeKb(tmp());
  const repo = makeOpenwikiRepo();
  assert.equal(run(['openwiki', '--kb', kb, '--repo', repo, '--detect-only', 'maybe']).code, 64);
  assert.equal(run(['openwiki', '--kb', kb, '--repo', repo, '--detect-only=false']).code, 0);
});

// ---- openwiki connector (§3.1) ----

test('openwiki: flatten / → --, strip .md, collision gets hash suffix, skip-list applied', () => {
  const repo = tmp();
  // write openwiki/index.md, openwiki/architecture/overview.md, openwiki/a/b.md, openwiki/a--b.md,
  // openwiki/INSTRUCTIONS.md, openwiki/.last-update.json, openwiki/source-maps.json
  const ow = join(repo, 'openwiki');
  mkdirSync(join(ow, 'architecture'), { recursive: true });
  mkdirSync(join(ow, 'a'), { recursive: true });
  writeFileSync(join(ow, 'index.md'), '# Index\n');
  writeFileSync(join(ow, 'architecture', 'overview.md'), '# Overview\n');
  writeFileSync(join(ow, 'a', 'b.md'), '# a/b\n');
  writeFileSync(join(ow, 'a--b.md'), '# a--b\n');
  writeFileSync(join(ow, 'INSTRUCTIONS.md'), 'do not ingest\n');
  writeFileSync(join(ow, '.last-update.json'), '{}');
  writeFileSync(join(ow, 'source-maps.json'), '{}');
  gitInit(repo);
  const kb = makeKb(tmp());
  const r = run(['openwiki', '--kb', kb, '--repo', repo]);
  assert.equal(r.code, 0);
  assert.equal(r.json.created, 4); // index, architecture--overview, a--b, a--b-<hash8>
  assert.ok(exists(join(kb, 'raw/openwiki/architecture--overview.md')));
  assert.ok(!exists(join(kb, 'raw/openwiki/INSTRUCTIONS.md')));
  const names = readdirSync(join(kb, 'raw/openwiki')).sort();
  assert.equal(names.filter(n => n.startsWith('a--b')).length, 2);
  assert.ok(names.some(n => /^a--b-[0-9a-f]{8}\.md$/.test(n)));
});

test('openwiki: flattened id failing SOURCE_ID_RE is skipped into errors (no escaping)', () => {
  const repo = tmp();
  const ow = join(repo, 'openwiki');
  mkdirSync(ow, { recursive: true });
  writeFileSync(join(ow, '.draft.md'), '# draft\n'); // flattens to '.draft' → invalid
  gitInit(repo);
  const kb = makeKb(tmp());
  const r = run(['openwiki', '--kb', kb, '--repo', repo]);
  assert.equal(r.code, 0);
  assert.equal(r.json.created, 0);
  assert.equal(r.json.errors.length, 1);
  assert.equal(r.json.errors[0].code, 'invalid-source-id');
  assert.ok(r.json.errors[0].target.includes('.draft.md'));
  assert.ok(!exists(join(kb, 'raw/openwiki/.draft.md')));
});

test('openwiki: source_url = <remote>#<repo-relpath> when origin remote is set', () => {
  const repo = makeOpenwikiRepo();
  git(repo, 'remote', 'add', 'origin', 'https://example.com/r.git');
  const kb = makeKb(tmp());
  const r = run(['openwiki', '--kb', kb, '--repo', repo]);
  assert.equal(r.code, 0);
  const { data } = readRaw(kb, 'index');
  assert.equal(data.source_url, 'https://example.com/r.git#openwiki/index.md');
});

test('openwiki: source_url falls back to file:// absolute path without a remote', () => {
  const repo = makeOpenwikiRepo({ withGit: false });
  const kb = makeKb(tmp());
  const r = run(['openwiki', '--kb', kb, '--repo', repo]);
  assert.equal(r.code, 0);
  const { data } = readRaw(kb, 'index');
  assert.equal(data.source_url, 'file://' + join(repo, 'openwiki', 'index.md').replace(/\\/g, '/'));
});

test('openwiki: source_version = last commit ISO time in a git repo', () => {
  const repo = makeOpenwikiRepo();
  const kb = makeKb(tmp());
  const r = run(['openwiki', '--kb', kb, '--repo', repo]);
  assert.equal(r.code, 0);
  const expected = git(repo, 'log', '-1', '--format=%cI', '--', 'openwiki/index.md');
  assert.equal(readRaw(kb, 'index').data.source_version, expected);
});

test('openwiki: source_version falls back to file mtime (ISO 8601) outside git', () => {
  const repo = makeOpenwikiRepo({ withGit: false });
  const kb = makeKb(tmp());
  const r = run(['openwiki', '--kb', kb, '--repo', repo]);
  assert.equal(r.code, 0);
  const expected = statSync(join(repo, 'openwiki', 'index.md')).mtime.toISOString();
  assert.equal(readRaw(kb, 'index').data.source_version, expected);
});

test('openwiki: --subdir pulls only that subtree; deletion scoped to the subtree prefix', () => {
  const repo = tmp();
  const ow = join(repo, 'openwiki');
  mkdirSync(join(ow, 'architecture'), { recursive: true });
  writeFileSync(join(ow, 'index.md'), '# Index\n');
  writeFileSync(join(ow, 'architecture', 'overview.md'), '# Overview\n');
  gitInit(repo);
  const kb = makeKb(tmp());

  // pre-existing raw outside the subtree — must survive subdir-scoped runs
  writeRaw(kb, 'openwiki', 'index', {
    source_url: 'file:///x', source_version: 'v0', pulled_at: '2026-01-01T00:00:00.000Z', content_hash: 'manual',
  }, '# old index\n');

  const r1 = run(['openwiki', '--kb', kb, '--repo', repo, '--subdir', 'architecture']);
  assert.equal(r1.code, 0);
  assert.equal(r1.json.created, 1); // architecture--overview only
  assert.ok(exists(join(kb, 'raw/openwiki/architecture--overview.md')));
  assert.equal(r1.json.removed_upstream, 0); // index is out of scope, not "removed upstream"
  assert.ok(exists(join(kb, 'raw/openwiki/index.md')));

  // delete the upstream page inside the subtree → scoped deletion removes its raw
  unlinkSync(join(ow, 'architecture', 'overview.md'));
  const r2 = run(['openwiki', '--kb', kb, '--repo', repo, '--subdir', 'architecture']);
  assert.equal(r2.code, 0);
  assert.equal(r2.json.removed_upstream, 1);
  assert.ok(!exists(join(kb, 'raw/openwiki/architecture--overview.md')));
  assert.ok(exists(join(kb, 'raw/openwiki/index.md')));
});

test('openwiki: --subdir deletion scoping uses upstream relpath, not flattened-id prefix', () => {
  // 'a/c.md' flattens into the same id namespace as top-level 'a--b.md'; a prefix-based
  // deletion scope would falsely delete the alive out-of-scope raw a--b.md.
  const repo = tmp();
  const ow = join(repo, 'openwiki');
  mkdirSync(join(ow, 'a'), { recursive: true });
  writeFileSync(join(ow, 'a', 'c.md'), '# a/c\n');
  writeFileSync(join(ow, 'a--b.md'), '# a--b\n');
  gitInit(repo);
  const kb = makeKb(tmp());

  const r1 = run(['openwiki', '--kb', kb, '--repo', repo]);
  assert.equal(r1.json.created, 2); // a--c and a--b
  assert.ok(exists(join(kb, 'raw/openwiki/a--b.md')));

  const r2 = run(['openwiki', '--kb', kb, '--repo', repo, '--subdir', 'a']);
  assert.equal(r2.code, 0);
  assert.equal(r2.json.removed_upstream, 0); // a--b is out of scope, must survive
  assert.ok(exists(join(kb, 'raw/openwiki/a--b.md')));
  assert.ok(exists(join(kb, 'raw/openwiki/a--c.md')));
});

test('openwiki: --subdir scoping must not delete the collision-suffixed out-of-scope raw', () => {
  // collision pair: 'a/b.md' claims id a--b, top-level 'a--b.md' gets a--b-<hash8> —
  // both ids start with 'a--', but only the former is under openwiki/a/.
  const repo = tmp();
  const ow = join(repo, 'openwiki');
  mkdirSync(join(ow, 'a'), { recursive: true });
  writeFileSync(join(ow, 'a', 'b.md'), '# a/b\n');
  writeFileSync(join(ow, 'a--b.md'), '# a--b\n');
  gitInit(repo);
  const kb = makeKb(tmp());

  assert.equal(run(['openwiki', '--kb', kb, '--repo', repo]).json.created, 2);
  const names = readdirSync(join(kb, 'raw/openwiki')).sort();
  assert.ok(names.some(n => /^a--b-[0-9a-f]{8}\.md$/.test(n)));

  const r = run(['openwiki', '--kb', kb, '--repo', repo, '--subdir', 'a']);
  assert.equal(r.code, 0);
  assert.equal(r.json.removed_upstream, 0);
  assert.deepEqual(readdirSync(join(kb, 'raw/openwiki')).sort(), names); // both raws survive
});

test('openwiki: --subdir in-scope deletion still works (remote #relpath source_url)', () => {
  const repo = tmp();
  const ow = join(repo, 'openwiki');
  mkdirSync(join(ow, 'a'), { recursive: true });
  writeFileSync(join(ow, 'a', 'c.md'), '# a/c\n');
  writeFileSync(join(ow, 'a--b.md'), '# a--b\n');
  gitInit(repo);
  git(repo, 'remote', 'add', 'origin', 'https://example.com/r.git'); // exercise the '<remote>#<relpath>' form
  const kb = makeKb(tmp());

  assert.equal(run(['openwiki', '--kb', kb, '--repo', repo]).json.created, 2);
  unlinkSync(join(ow, 'a', 'c.md'));
  const r = run(['openwiki', '--kb', kb, '--repo', repo, '--subdir', 'a']);
  assert.equal(r.code, 0);
  assert.equal(r.json.removed_upstream, 1);
  assert.ok(!exists(join(kb, 'raw/openwiki/a--c.md'))); // in-scope upstream deletion removed
  assert.ok(exists(join(kb, 'raw/openwiki/a--b.md')));  // out-of-scope raw untouched
});

test('openwiki: upstream deletion removes raw, counts removed_upstream, logs to log.md', () => {
  const repo = tmp();
  const ow = join(repo, 'openwiki');
  mkdirSync(join(ow, 'architecture'), { recursive: true });
  writeFileSync(join(ow, 'index.md'), '# Index\n');
  writeFileSync(join(ow, 'architecture', 'overview.md'), '# Overview\n');
  gitInit(repo);
  const kb = makeKb(tmp());

  assert.equal(run(['openwiki', '--kb', kb, '--repo', repo]).json.created, 2);
  unlinkSync(join(ow, 'architecture', 'overview.md'));
  const r = run(['openwiki', '--kb', kb, '--repo', repo]);
  assert.equal(r.code, 0);
  assert.equal(r.json.removed_upstream, 1);
  assert.ok(!exists(join(kb, 'raw/openwiki/architecture--overview.md')));
  assert.ok(exists(join(kb, 'raw/openwiki/index.md')));
  const log = read(join(kb, 'log.md'));
  assert.match(log, /^## \[[^\]]+\] acquire \| pull \| raw\/openwiki\/architecture--overview\.md \| removed_upstream$/m);
});

test('openwiki: --detect-only classifies but writes nothing (no files, no log, no commit)', () => {
  const repo = makeOpenwikiRepo();
  const kb = makeKb(tmp());
  gitInit(kb);
  const headBefore = git(kb, 'rev-parse', 'HEAD');
  const r = run(['openwiki', '--kb', kb, '--repo', repo, '--detect-only']);
  assert.equal(r.code, 0);
  assert.equal(r.json.created, 4);
  assert.equal(readdirSync(join(kb, 'raw', 'openwiki')).length, 0);
  assert.equal(read(join(kb, 'log.md')), '');
  assert.equal(git(kb, 'rev-parse', 'HEAD'), headBefore);
});

test('openwiki: identical second run → all unchanged; modified upstream → updated', () => {
  const repo = makeOpenwikiRepo();
  const kb = makeKb(tmp());
  assert.equal(run(['openwiki', '--kb', kb, '--repo', repo]).json.created, 4);

  const r2 = run(['openwiki', '--kb', kb, '--repo', repo]);
  assert.equal(r2.code, 0);
  assert.deepEqual(
    [r2.json.created, r2.json.updated, r2.json.unchanged, r2.json.removed_upstream],
    [0, 0, 4, 0]);

  writeFileSync(join(repo, 'openwiki', 'index.md'), '# Index v2\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', 'update index');
  const r3 = run(['openwiki', '--kb', kb, '--repo', repo]);
  assert.deepEqual(
    [r3.json.created, r3.json.updated, r3.json.unchanged, r3.json.removed_upstream],
    [0, 1, 3, 0]);
});

test('openwiki: stdout shape is exactly {created, updated, unchanged, removed_upstream, errors}', () => {
  const repo = makeOpenwikiRepo();
  const kb = makeKb(tmp());
  gitInit(kb); // git repo → no warnings key
  const r = run(['openwiki', '--kb', kb, '--repo', repo]);
  assert.equal(r.code, 0);
  assert.deepEqual(Object.keys(r.json).sort(),
    ['created', 'errors', 'removed_upstream', 'unchanged', 'updated']);
  assert.deepEqual(r.json.errors, []);
});

test('openwiki: OKF frontmatter preserved verbatim as raw body; our frontmatter leads', () => {
  const repo = tmp();
  const ow = join(repo, 'openwiki');
  mkdirSync(ow, { recursive: true });
  const okf = '---\ntitle: Architecture\ndescription: OKF v0.1 page\n---\n\n# Architecture\n\nBody text.\n';
  writeFileSync(join(ow, 'page.md'), okf);
  gitInit(repo);
  const kb = makeKb(tmp());
  const r = run(['openwiki', '--kb', kb, '--repo', repo]);
  assert.equal(r.code, 0);

  const text = read(join(kb, 'raw', 'openwiki', 'page.md'));
  // frontmatter field order: source, source_id, source_url, source_version, pulled_at, content_hash
  assert.deepEqual(text.split('\n').slice(0, 8).map(l => l.split(':')[0]),
    ['---', 'source', 'source_id', 'source_url', 'source_version', 'pulled_at', 'content_hash', '---']);
  const { data, body } = splitFrontmatter(text);
  assert.equal(data.source, 'openwiki');
  assert.equal(data.source_id, 'page');
  assert.equal(body, okf); // original page (incl. its own OKF frontmatter) verbatim
});

test('openwiki: content_hash is byte-consistent with validate.mjs contentHash(source_version, body)', () => {
  const repo = makeOpenwikiRepo();
  const kb = makeKb(tmp());
  const r = run(['openwiki', '--kb', kb, '--repo', repo]);
  assert.equal(r.code, 0);
  for (const id of ['index', 'architecture--overview']) {
    const { data, body } = readRaw(kb, id);
    const expected = contentHash(data.source_version, body); // validate.mjs's export
    assert.equal(data.content_hash, expected);
    assert.equal(contentHashAcquire(data.source_version, body), expected); // cross-script byte-consistency
  }
});

// ---- raw write + git commit plumbing (§2.2/§2.8) ----

test('openwiki: KB not a git repo → files still written, warnings notes git failure, exit 0', () => {
  const repo = makeOpenwikiRepo();
  const kb = makeKb(tmp()); // no gitInit
  const r = run(['openwiki', '--kb', kb, '--repo', repo]);
  assert.equal(r.code, 0);
  assert.equal(r.json.created, 4);
  assert.ok(exists(join(kb, 'raw/openwiki/index.md')));
  assert.ok(Array.isArray(r.json.warnings));
  assert.ok(r.json.warnings.some(w => /git commit failed/.test(w)));
});

test('openwiki: KB git repo → one commit "acquire: openwiki (+4 ~0 -0)"', () => {
  const repo = makeOpenwikiRepo();
  const kb = makeKb(tmp());
  gitInit(kb);
  const r = run(['openwiki', '--kb', kb, '--repo', repo]);
  assert.equal(r.code, 0);
  assert.equal(git(kb, 'log', '-1', '--format=%s'), 'acquire: openwiki (+4 ~0 -0)');
});

test('openwiki: KB nested in a larger repo stages only raw/ + log.md (never unrelated user work)', () => {
  const repo = makeOpenwikiRepo();
  const outer = tmp();
  const kb = makeKb(join(outer, 'kb'));
  gitInit(outer); // the OUTER repo owns the KB directory
  writeFileSync(join(outer, 'unrelated-user-work.txt'), 'do not commit me');
  const r = run(['openwiki', '--kb', kb, '--repo', repo]);
  assert.equal(r.code, 0);
  assert.equal(git(outer, 'log', '-1', '--format=%s'), 'acquire: openwiki (+4 ~0 -0)');
  const committed = git(outer, 'show', '--name-only', '--format=', 'HEAD');
  assert.ok(committed.includes('kb/raw/openwiki/index.md'));
  assert.ok(!committed.includes('unrelated-user-work.txt'));
});

test('openwiki: missing openwiki/ directory in repo → exit 1 JSON error', () => {
  const kb = makeKb(tmp());
  const r = run(['openwiki', '--kb', kb, '--repo', tmp()]);
  assert.equal(r.code, 1);
  assert.ok(r.json.error);
});

// ==== Jira + Confluence connectors (§3) ====

import { createServer } from 'node:http';
import { once } from 'node:events';
import { adfToText, xhtmlToMd } from '../llm-wiki/scripts/acquire.mjs';

/** Start a fake Jira/Confluence server on 127.0.0.1:0; returns { base, requests, close }. */
async function startFakeServer(handler) {
  const requests = [];
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    requests.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), auth: req.headers.authorization ?? null });
    Promise.resolve(handler(req, res, u)).catch(e => { res.writeHead(500); res.end(String(e)); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { base: `http://127.0.0.1:${server.address().port}`, requests, close: () => server.close() };
}
const jsonRes = (res, obj, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const runWithPat = (args, pat = 'SECRET-SENTINEL', extraEnv = {}) => runScriptAsync('acquire.mjs', args, { env: { ...NOENV, JIRA_TEST_PAT: pat, CONF_TEST_PAT: pat, ...extraEnv } });
const makeJiraKb = (base) => makeKb(tmp(), { connectors: { jira: { base_url: base, pat_env: 'JIRA_TEST_PAT' } } });
const makeConfKb = (base) => makeKb(tmp(), { connectors: { confluence: { base_url: base, pat_env: 'CONF_TEST_PAT' } } });

const JIRA_FULL_FIELDS = 'summary,description,comment,attachment,issuetype,priority,labels,status,assignee,created,updated';

/** Standard fake issue payload; description/comments/attachments overridable. */
function jiraIssue(key, { summary = 'Pay table design', updated = '2026-08-01T10:00:00.000+0000', ...over } = {}) {
  return {
    key,
    fields: {
      summary, updated,
      description: 'h2. Design\n\nUse table *pay_core*.',
      comment: { comments: [] },
      attachment: [],
      issuetype: { name: 'Story' },
      priority: { name: 'High' },
      labels: ['pay', 'core'],
      status: { name: 'In Progress' },
      assignee: { displayName: 'Alice' },
      created: '2026-07-01T09:00:00.000+0000',
      ...over,
    },
  };
}
function jiraHandler(issuesByKey, extra = {}) {
  return (req, res, u) => {
    const m = u.pathname.match(/^\/rest\/api\/2\/issue\/([^/?]+)$/);
    if (m) {
      const key = decodeURIComponent(m[1]);
      const issue = issuesByKey[key];
      if (!issue) return jsonRes(res, { errorMessages: ['Issue Does Not Exist'] }, 404);
      const wantLight = u.searchParams.get('fields') === 'summary,updated';
      if (wantLight) return jsonRes(res, { key: issue.key, fields: { summary: issue.fields.summary, updated: issue.fields.updated } });
      return jsonRes(res, issue);
    }
    if (u.pathname === '/rest/api/2/search' && extra.search) return extra.search(req, res, u);
    if (extra.fallback) return extra.fallback(req, res, u);
    jsonRes(res, { errorMessages: ['not found'] }, 404);
  };
}
const readJiraRaw = (kb, key) => splitFrontmatter(read(join(kb, 'raw', 'jira', key + '.md')));
const readConfRaw = (kb, id) => splitFrontmatter(read(join(kb, 'raw', 'confluence', id + '.md')));

// ---- adfToText unit tests ----

test('adfToText: paragraph/text/heading/hardBreak', () => {
  const doc = { type: 'doc', content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Title' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'line1' }, { type: 'hardBreak' }, { type: 'text', text: 'line2' }] },
  ] };
  assert.equal(adfToText(doc), '## Title\n\nline1\nline2');
});

test('adfToText: bulletList/orderedList/listItem', () => {
  const doc = { type: 'doc', content: [
    { type: 'bulletList', content: [
      { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }] },
      { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'y' }] }] },
    ] },
    { type: 'orderedList', content: [
      { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first' }] }] },
    ] },
  ] };
  assert.equal(adfToText(doc), '- x\n- y\n\n1. first');
});

test('adfToText: codeBlock, mention, emoji', () => {
  const doc = { type: 'doc', content: [
    { type: 'codeBlock', attrs: { language: 'js' }, content: [{ type: 'text', text: 'let a = 1;' }] },
    { type: 'paragraph', content: [
      { type: 'mention', attrs: { text: 'Alice' } },
      { type: 'text', text: ' shipped it ' },
      { type: 'emoji', attrs: { shortName: ':tada:' } },
    ] },
  ] };
  assert.equal(adfToText(doc), '```js\nlet a = 1;\n```\n\n@Alice shipped it :tada:');
});

test('adfToText: unknown node type falls back to concatenated child text (never dropped)', () => {
  const doc = { type: 'doc', content: [
    { type: 'mediaSingle', content: [
      { type: 'media', content: [{ type: 'text', text: 'inner text' }] },
    ] },
  ] };
  assert.equal(adfToText(doc), 'inner text');
  assert.equal(adfToText(null), '');
  assert.equal(adfToText('plain'), 'plain');
});

// ---- xhtmlToMd unit tests (§3 conversion table) ----

test('xhtmlToMd: headings + inline strong/em', () => {
  assert.equal(xhtmlToMd('<h1>T</h1><p>a <strong>b</strong> <em>c</em></p>', '9'), '# T\n\na **b** *c*');
});

test('xhtmlToMd: unordered and ordered lists', () => {
  assert.equal(xhtmlToMd('<ul><li>x</li><li>y</li></ul>', '9'), '- x\n- y');
  assert.equal(xhtmlToMd('<ol><li>a</li><li>b</li></ol>', '9'), '1. a\n2. b');
});

test('xhtmlToMd: table', () => {
  assert.equal(
    xhtmlToMd('<table><tr><th>H</th></tr><tr><td>1</td></tr></table>', '9'),
    '| H |\n| --- |\n| 1 |');
});

test('xhtmlToMd: code macro with CDATA (angle brackets preserved verbatim)', () => {
  const x = '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">js</ac:parameter>' +
    '<ac:plain-text-body><![CDATA[x<y]]></ac:plain-text-body></ac:structured-macro>';
  assert.equal(xhtmlToMd(x, '9'), '```js\nx<y\n```');
});

test('xhtmlToMd: unknown macro degrades to [macro: name] placeholder (never dropped)', () => {
  assert.equal(
    xhtmlToMd('<ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">PAY-1</ac:parameter></ac:structured-macro>', '9'),
    '[macro: jira]');
});

test('xhtmlToMd: link, br, entities, inline code', () => {
  assert.equal(xhtmlToMd('<p><a href="https://x">t</a><br/>a &lt; b &amp; c &quot;d&quot; &#39;e&#39; <code>f()</code></p>', '9'),
    '[t](https://x)\na < b & c "d" \'e\' `f()`');
});

test('xhtmlToMd: ac:image attachment rewritten to page-relative asset path', () => {
  assert.equal(
    xhtmlToMd('<p><ac:image><ri:attachment ri:filename="a.png"/></ac:image></p>', '42'),
    '![a.png](../assets/confluence/42/a.png)');
});

test('xhtmlToMd: ac:link page link degrades to its link-body text', () => {
  assert.equal(
    xhtmlToMd('<p><ac:link><ri:page ri:content-title="Other"/><ac:link-body>see</ac:link-body></ac:link></p>', '9'),
    'see');
});

test('xhtmlToMd: pre becomes fenced code; block separation is exactly one blank line', () => {
  assert.equal(xhtmlToMd('<h2>A</h2><pre>raw <x></pre><p>tail</p>', '9'), '## A\n\n```\nraw <x>\n```\n\ntail');
});

// ---- Jira connector ----

test('jira: missing PAT env var → exit 1 error naming the env var, never a PAT value', async () => {
  const srv = await startFakeServer(jiraHandler({ 'PROJ-123': jiraIssue('PROJ-123') }));
  try {
    const kb = makeKb(tmp(), { connectors: { jira: { base_url: srv.base, pat_env: 'JIRA_PAT_NOT_SET_XYZ' } } });
    const r = run(['jira', '--kb', kb, '--selector', 'PROJ-123']);
    assert.equal(r.code, 1);
    assert.equal(r.json.error.code, 'missing-pat');
    assert.match(r.json.error.hint, /JIRA_PAT_NOT_SET_XYZ/);
  } finally { srv.close(); }
});

test('jira: key pull writes raw with metadata frontmatter, description and ≤10 latest comments', async () => {
  const comments = Array.from({ length: 12 }, (_, i) => ({
    author: { displayName: `User${i + 1}` }, created: `2026-08-0${(i % 9) + 1}T00:00:00.000+0000`, body: `comment ${i + 1}`,
  }));
  const srv = await startFakeServer(jiraHandler({ 'PROJ-123': jiraIssue('PROJ-123', { comment: { comments } }) }));
  try {
    const kb = makeJiraKb(srv.base);
    const r = await runWithPat(['jira', '--kb', kb, '--selector', 'PROJ-123']);
    assert.equal(r.code, 0);
    assert.equal(r.json.created, 1);
    const { data, body } = readJiraRaw(kb, 'PROJ-123');
    assert.equal(data.source, 'jira');
    assert.equal(data.source_id, 'PROJ-123');
    assert.equal(data.issue_type, 'Story');
    assert.equal(data.priority, 'High');
    assert.deepEqual(data.labels, ['pay', 'core']);
    assert.equal(data.status, 'In Progress');
    assert.equal(data.assignee, 'Alice');
    assert.equal(data.source_version, '2026-08-01T10:00:00.000+0000');
    assert.equal(data.source_url, `${srv.base}/browse/PROJ-123`);
    assert.ok(body.includes('h2. Design')); // plain-string description verbatim
    assert.ok(body.includes('## Comments'));
    assert.ok(!body.includes('comment 1\n') && !body.includes('comment 2\n')); // only the latest 10
    assert.ok(body.includes('comment 3\n')); // boundary: comment 3 is the oldest kept
    assert.ok(body.includes('comment 12'));
    assert.ok(body.includes('User12'));
    // detect-first, then exactly one full pull
    const light = srv.requests.filter(q => q.path === '/rest/api/2/issue/PROJ-123' && q.query.fields === 'summary,updated');
    const full = srv.requests.filter(q => q.path === '/rest/api/2/issue/PROJ-123' && q.query.fields === JIRA_FULL_FIELDS);
    assert.equal(light.length, 1);
    assert.equal(full.length, 1);
    assert.ok(srv.requests.every(q => q.auth === 'Bearer SECRET-SENTINEL')); // PAT auth, server-side asserted
  } finally { srv.close(); }
});

test('jira: URL selector extracts the issue key from /browse/<KEY>', async () => {
  const srv = await startFakeServer(jiraHandler({ 'PROJ-7': jiraIssue('PROJ-7') }));
  try {
    const kb = makeJiraKb(srv.base);
    const r = await runWithPat(['jira', '--kb', kb, '--selector', `${srv.base}/browse/PROJ-7`]);
    assert.equal(r.code, 0);
    assert.equal(r.json.created, 1);
    assert.ok(exists(join(kb, 'raw', 'jira', 'PROJ-7.md')));
  } finally { srv.close(); }
});

test('jira: ADF description converted via adfToText', async () => {
  const adf = { type: 'doc', version: 1, content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'ADF body here' }] },
  ] };
  const srv = await startFakeServer(jiraHandler({ 'PROJ-9': jiraIssue('PROJ-9', { description: adf }) }));
  try {
    const kb = makeJiraKb(srv.base);
    const r = await runWithPat(['jira', '--kb', kb, '--selector', 'PROJ-9']);
    assert.equal(r.code, 0);
    const { body } = readJiraRaw(kb, 'PROJ-9');
    assert.ok(body.includes('ADF body here'));
    assert.ok(!body.includes('"type"'));
  } finally { srv.close(); }
});

test('jira: attachment downloaded to raw/assets/jira/<KEY>/ and body reference rewritten', async () => {
  const bytes = Buffer.from('fake-png-bytes');
  const handler = jiraHandler({ 'PROJ-5': jiraIssue('PROJ-5', {
    description: 'See diagram.png for details.',
    attachment: [{ filename: 'diagram.png', content: '/secure/attachment/1/diagram.png' }],
  }) }, { fallback: (req, res, u) => {
    if (u.pathname === '/secure/attachment/1/diagram.png') { res.writeHead(200); res.end(bytes); return; }
    jsonRes(res, {}, 404);
  } });
  const srv = await startFakeServer(handler);
  try {
    const kb = makeJiraKb(srv.base);
    const r = await runWithPat(['jira', '--kb', kb, '--selector', 'PROJ-5']);
    assert.equal(r.code, 0);
    assert.ok(exists(join(kb, 'raw', 'assets', 'jira', 'PROJ-5', 'diagram.png')));
    assert.deepEqual(read(join(kb, 'raw', 'assets', 'jira', 'PROJ-5', 'diagram.png')), String(bytes));
    const { body } = readJiraRaw(kb, 'PROJ-5');
    assert.ok(body.includes('../assets/jira/PROJ-5/diagram.png'));
    const dl = srv.requests.find(q => q.path === '/secure/attachment/1/diagram.png');
    assert.equal(dl.auth, 'Bearer SECRET-SENTINEL'); // attachment download also authenticated
  } finally { srv.close(); }
});

test('jira: second identical run → unchanged, no full pull', async () => {
  const srv = await startFakeServer(jiraHandler({ 'PROJ-123': jiraIssue('PROJ-123') }));
  try {
    const kb = makeJiraKb(srv.base);
    assert.equal((await runWithPat(['jira', '--kb', kb, '--selector', 'PROJ-123'])).json.created, 1);
    const before = srv.requests.length;
    const r2 = await runWithPat(['jira', '--kb', kb, '--selector', 'PROJ-123']);
    assert.equal(r2.code, 0);
    assert.deepEqual([r2.json.created, r2.json.updated, r2.json.unchanged], [0, 0, 1]);
    const after = srv.requests.slice(before);
    assert.equal(after.length, 1); // light detect only
    assert.equal(after[0].query.fields, 'summary,updated');
  } finally { srv.close(); }
});

test('jira: JQL classifies new/changed/unchanged; --detect-only pulls and writes nothing', async () => {
  const issues = {
    'PROJ-1': jiraIssue('PROJ-1', { updated: '2026-08-01T00:00:00.000+0000' }),
    'PROJ-2': jiraIssue('PROJ-2', { updated: '2026-08-05T00:00:00.000+0000' }),
    'PROJ-3': jiraIssue('PROJ-3', { updated: '2026-08-03T00:00:00.000+0000' }),
  };
  const search = (req, res, u) => jsonRes(res, {
    startAt: 0, maxResults: 100, total: 3,
    issues: ['PROJ-1', 'PROJ-2', 'PROJ-3'].map(k => ({ key: k, fields: { summary: issues[k].fields.summary, updated: issues[k].fields.updated } })),
  });
  const srv = await startFakeServer(jiraHandler(issues, { search }));
  try {
    const kb = makeJiraKb(srv.base);
    // pre-existing raws: PROJ-1 same version (unchanged), PROJ-2 older version (changed)
    writeRaw(kb, 'jira', 'PROJ-1', {
      source_url: `${srv.base}/browse/PROJ-1`, source_version: '2026-08-01T00:00:00.000+0000',
      pulled_at: '2026-08-01T01:00:00.000Z', content_hash: 'manual',
    }, 'old body 1');
    writeRaw(kb, 'jira', 'PROJ-2', {
      source_url: `${srv.base}/browse/PROJ-2`, source_version: '2026-08-02T00:00:00.000+0000',
      pulled_at: '2026-08-02T01:00:00.000Z', content_hash: 'manual',
    }, 'old body 2');

    const rd = await runWithPat(['jira', '--kb', kb, '--selector', 'project = PROJ', '--detect-only']);
    assert.equal(rd.code, 0);
    assert.deepEqual([rd.json.created, rd.json.updated, rd.json.unchanged], [1, 1, 1]);
    assert.equal(read(join(kb, 'raw', 'jira', 'PROJ-2.md')).includes('old body 2'), true); // untouched
    assert.ok(!exists(join(kb, 'raw', 'jira', 'PROJ-3.md')));
    assert.equal(read(join(kb, 'log.md')), ''); // no log writes under --detect-only

    const r = await runWithPat(['jira', '--kb', kb, '--selector', 'project = PROJ']);
    assert.equal(r.code, 0);
    assert.deepEqual([r.json.created, r.json.updated, r.json.unchanged], [1, 1, 1]);
    assert.ok(exists(join(kb, 'raw', 'jira', 'PROJ-3.md')));
    const searchReq = srv.requests.find(q => q.path === '/rest/api/2/search');
    assert.equal(searchReq.query.jql, 'project = PROJ');
    assert.equal(searchReq.query.fields, 'summary,updated');
  } finally { srv.close(); }
});

test('jira: JQL pagination walks startAt; hard cap 500 issues stops with a warning', async () => {
  // total 501 → pages of 100: startAt 0..500; the run stops at 500 pulled issues
  const search = (req, res, u) => {
    const startAt = Number(u.searchParams.get('startAt'));
    const n = Math.min(100, 501 - startAt);
    return jsonRes(res, {
      startAt, maxResults: 100, total: 501,
      issues: Array.from({ length: n }, (_, i) => {
        const key = `PROJ-${startAt + i + 1}`;
        return { key, fields: { summary: key, updated: '2026-08-01T00:00:00.000+0000' } };
      }),
    });
  };
  const handler = jiraHandler({}, { search, fallback: (req, res, u) => {
    const m = u.pathname.match(/^\/rest\/api\/2\/issue\/(.+)$/);
    if (m) return jsonRes(res, jiraIssue(decodeURIComponent(m[1])));
    jsonRes(res, {}, 404);
  } });
  const srv = await startFakeServer(handler);
  try {
    const kb = makeJiraKb(srv.base);
    const r = await runWithPat(['jira', '--kb', kb, '--selector', 'project = PROJ']);
    assert.equal(r.code, 0);
    assert.equal(r.json.created, 500);
    assert.ok(Array.isArray(r.json.warnings));
    assert.ok(r.json.warnings.some(w => /500/.test(w) && /cap/i.test(w)));
    const starts = srv.requests.filter(q => q.path === '/rest/api/2/search').map(q => Number(q.query.startAt));
    assert.deepEqual(starts, [0, 100, 200, 300, 400]); // stops at the 500-issue cap before paging further
  } finally { srv.close(); }
});

test('jira: two-strike removed_upstream — first missing keeps raw + warning + state; second deletes + logs', async () => {
  const srv = await startFakeServer(jiraHandler({})); // issue never exists upstream
  try {
    const kb = makeJiraKb(srv.base);
    writeRaw(kb, 'jira', 'PROJ-99', {
      source_url: `${srv.base}/browse/PROJ-99`, source_version: '2026-08-01T00:00:00.000+0000',
      pulled_at: '2026-08-01T01:00:00.000Z', content_hash: 'manual',
    }, 'old body');

    const r1 = await runWithPat(['jira', '--kb', kb, '--selector', 'PROJ-99']);
    assert.equal(r1.code, 0);
    assert.equal(r1.json.removed_upstream, 0);
    assert.ok(exists(join(kb, 'raw', 'jira', 'PROJ-99.md'))); // kept on first strike
    assert.ok(r1.json.warnings.some(w => /PROJ-99/.test(w)));
    const state1 = JSON.parse(read(join(kb, '.kb', 'acquire-state.json')));
    assert.ok(state1['jira/PROJ-99'].firstMissingAt);
    assert.equal(read(join(kb, 'log.md')), ''); // no removal log on first strike

    const r2 = await runWithPat(['jira', '--kb', kb, '--selector', 'PROJ-99']);
    assert.equal(r2.code, 0);
    assert.equal(r2.json.removed_upstream, 1);
    assert.ok(!exists(join(kb, 'raw', 'jira', 'PROJ-99.md'))); // deleted on second strike
    const state2 = JSON.parse(read(join(kb, '.kb', 'acquire-state.json')));
    assert.ok(!('jira/PROJ-99' in state2)); // state entry cleared
    assert.match(read(join(kb, 'log.md')),
      /^## \[[^\]]+\] acquire \| pull \| raw\/jira\/PROJ-99\.md \| removed_upstream$/m);
  } finally { srv.close(); }
});

test('jira: reappearing issue clears the first-strike state entry', async () => {
  const issues = {};
  const srv = await startFakeServer(jiraHandler(issues));
  try {
    const kb = makeJiraKb(srv.base);
    writeRaw(kb, 'jira', 'PROJ-99', {
      source_url: `${srv.base}/browse/PROJ-99`, source_version: '2026-08-01T00:00:00.000+0000',
      pulled_at: '2026-08-01T01:00:00.000Z', content_hash: 'manual',
    }, 'old body');
    assert.equal((await runWithPat(['jira', '--kb', kb, '--selector', 'PROJ-99'])).json.removed_upstream, 0);
    assert.ok(JSON.parse(read(join(kb, '.kb', 'acquire-state.json')))['jira/PROJ-99']);
    issues['PROJ-99'] = jiraIssue('PROJ-99', { updated: '2026-08-09T00:00:00.000+0000' }); // reappears, changed
    const r = await runWithPat(['jira', '--kb', kb, '--selector', 'PROJ-99']);
    assert.equal(r.code, 0);
    assert.equal(r.json.updated, 1);
    assert.ok(!('jira/PROJ-99' in JSON.parse(read(join(kb, '.kb', 'acquire-state.json')))));
  } finally { srv.close(); }
});

test('jira: two consecutive pulls of a never-pulled key → both typed not-found, no state, no log', async () => {
  const srv = await startFakeServer(jiraHandler({})); // issue never exists upstream
  try {
    const kb = makeJiraKb(srv.base);
    for (let i = 0; i < 2; i++) {
      const r = await runWithPat(['jira', '--kb', kb, '--selector', 'PROJ-404']);
      assert.equal(r.code, 1);
      assert.equal(r.json.error.code, 'not-found');
    }
    assert.ok(!exists(join(kb, '.kb', 'acquire-state.json'))); // no strike for never-pulled keys
    assert.equal(read(join(kb, 'log.md')), ''); // no bogus removed_upstream log line
    assert.ok(!exists(join(kb, 'raw', 'jira', 'PROJ-404.md')));
  } finally { srv.close(); }
});

test('jira: 401 mid-run aborts the connector — exit 1, PAT-env hint, sentinel PAT nowhere in output', async () => {
  const srv = await startFakeServer((req, res) => jsonRes(res, { errorMessages: ['SECRET-SENTINEL not allowed'] }, 401));
  try {
    const kb = makeJiraKb(srv.base);
    const r = await runWithPat(['jira', '--kb', kb, '--selector', 'PROJ-1']);
    assert.equal(r.code, 1);
    assert.equal(r.json.error.code, 'auth-failed');
    assert.match(r.json.error.hint, /JIRA_TEST_PAT/); // names the env var to rotate
    assert.ok(!r.stdout.includes('SECRET-SENTINEL')); // PAT (even server-echoed) never leaks
    assert.ok(!r.stderr.includes('SECRET-SENTINEL'));
  } finally { srv.close(); }
});

test('jira: non-OK upstream error → typed JSON error, exit 1, no raw written', async () => {
  const srv = await startFakeServer((req, res) => jsonRes(res, { errorMessages: ['boom'] }, 500));
  try {
    const kb = makeJiraKb(srv.base);
    const r = await runWithPat(['jira', '--kb', kb, '--selector', 'PROJ-1']);
    assert.equal(r.code, 1);
    assert.ok(r.json.error);
    assert.ok(!exists(join(kb, 'raw', 'jira', 'PROJ-1.md')));
  } finally { srv.close(); }
});

// ---- Confluence connector ----

const CONF_FULL_EXPAND = 'body.storage,version,metadata.labels,children.attachment';

function confPage(id, { title = 'Pay Table Design', versionWhen = '2026-08-01T10:00:00.000Z', ...over } = {}) {
  return {
    id, title,
    version: { when: versionWhen, number: 3 },
    body: { storage: { value: '<h1>Design</h1><p>body text</p>' } },
    metadata: { labels: { results: [{ name: 'pay' }, { name: 'core' }] } },
    children: { attachment: { results: [] } },
    ...over,
  };
}
function confHandler(pagesById, extra = {}) {
  return (req, res, u) => {
    const m = u.pathname.match(/^\/rest\/api\/content\/(\d+)$/);
    if (m) {
      const page = pagesById[m[1]];
      if (!page) return jsonRes(res, { message: 'not found' }, 404);
      if (u.searchParams.get('expand') === 'version')
        return jsonRes(res, { id: page.id, title: page.title, version: page.version });
      return jsonRes(res, page);
    }
    if (u.pathname === '/rest/api/content/search' && extra.search) return extra.search(req, res, u);
    if (extra.fallback) return extra.fallback(req, res, u);
    jsonRes(res, { message: 'not found' }, 404);
  };
}

test('confluence: viewpage URL selector pulls the page; labels in frontmatter; XHTML converted', async () => {
  const srv = await startFakeServer(confHandler({ '42': confPage('42') }));
  try {
    const kb = makeConfKb(srv.base);
    const r = await runWithPat(['confluence', '--kb', kb, '--selector', `${srv.base}/pages/viewpage.action?pageId=42`]);
    assert.equal(r.code, 0);
    assert.equal(r.json.created, 1);
    const { data, body } = readConfRaw(kb, '42');
    assert.equal(data.source, 'confluence');
    assert.equal(data.source_id, '42');
    assert.equal(data.source_version, '2026-08-01T10:00:00.000Z');
    assert.equal(data.source_url, `${srv.base}/pages/viewpage.action?pageId=42`);
    assert.deepEqual(data.labels, ['pay', 'core']);
    assert.ok(body.includes('# Design'));
    assert.ok(body.includes('body text'));
    const light = srv.requests.filter(q => q.path === '/rest/api/content/42' && q.query.expand === 'version');
    const full = srv.requests.filter(q => q.path === '/rest/api/content/42' && q.query.expand === CONF_FULL_EXPAND);
    assert.equal(light.length, 1);
    assert.equal(full.length, 1);
    assert.ok(srv.requests.every(q => q.auth === 'Bearer SECRET-SENTINEL'));
  } finally { srv.close(); }
});

test('confluence: _links.webui preferred for source_url when present', async () => {
  const srv = await startFakeServer(confHandler({ '7': confPage('7', { _links: { webui: '/spaces/PAY/pages/7/Custom+Title' } }) }));
  try {
    const kb = makeConfKb(srv.base);
    const r = await runWithPat(['confluence', '--kb', kb, '--selector', `${srv.base}/pages/viewpage.action?pageId=7`]);
    assert.equal(r.code, 0);
    assert.equal(readConfRaw(kb, '7').data.source_url, `${srv.base}/spaces/PAY/pages/7/Custom+Title`);
  } finally { srv.close(); }
});

test('confluence: /display/SPACE/Title URL resolves via CQL search containing space and title', async () => {
  const search = (req, res, u) => {
    const cql = u.searchParams.get('cql');
    assert.ok(cql.includes('space = "PAY"'), `cql has space: ${cql}`);
    assert.ok(cql.includes('title = "Pay Table Design"'), `cql has title: ${cql}`);
    return jsonRes(res, { results: [{ id: '42', version: { when: '2026-08-01T10:00:00.000Z' } }] });
  };
  const srv = await startFakeServer(confHandler({ '42': confPage('42') }, { search }));
  try {
    const kb = makeConfKb(srv.base);
    const r = await runWithPat(['confluence', '--kb', kb, '--selector', `${srv.base}/display/PAY/Pay+Table+Design`]);
    assert.equal(r.code, 0);
    assert.equal(r.json.created, 1);
    assert.ok(exists(join(kb, 'raw', 'confluence', '42.md')));
  } finally { srv.close(); }
});

test('confluence: CQL pull paginates, classifies, downloads attachments, rewrites ac:image', async () => {
  const png = Buffer.from('png-bytes');
  const page1 = confPage('101', {
    versionWhen: '2026-08-02T00:00:00.000Z', // changed vs local 2026-08-01
    body: { storage: { value: '<p>chart: <ac:image><ri:attachment ri:filename="a.png"/></ac:image></p>' } },
    children: { attachment: { results: [{ title: 'a.png', _links: { download: '/download/attachments/101/a.png' } }] } },
    metadata: { labels: { results: [] } },
  });
  const page2 = confPage('102', { versionWhen: '2026-08-01T00:00:00.000Z' });
  const search = (req, res, u) => jsonRes(res, {
    results: [
      { id: '101', version: { when: '2026-08-02T00:00:00.000Z' } },
      { id: '102', version: { when: '2026-08-01T00:00:00.000Z' } },
      { id: '103', version: { when: '2026-08-03T00:00:00.000Z' } },
    ],
  });
  const fallback = (req, res, u) => {
    if (u.pathname === '/download/attachments/101/a.png') { res.writeHead(200); res.end(png); return; }
    jsonRes(res, {}, 404);
  };
  const pages = { '101': page1, '102': page2, '103': confPage('103') };
  const srv = await startFakeServer(confHandler(pages, { search, fallback }));
  try {
    const kb = makeConfKb(srv.base);
    writeRaw(kb, 'confluence', '101', {
      source_url: `${srv.base}/pages/viewpage.action?pageId=101`, source_version: '2026-08-01T00:00:00.000Z',
      pulled_at: '2026-08-01T01:00:00.000Z', content_hash: 'manual',
    }, 'old 101');
    writeRaw(kb, 'confluence', '102', {
      source_url: `${srv.base}/pages/viewpage.action?pageId=102`, source_version: '2026-08-01T00:00:00.000Z',
      pulled_at: '2026-08-01T01:00:00.000Z', content_hash: 'manual',
    }, 'old 102');

    const rd = await runWithPat(['confluence', '--kb', kb, '--selector', 'space = PAY', '--detect-only']);
    assert.equal(rd.code, 0);
    assert.deepEqual([rd.json.created, rd.json.updated, rd.json.unchanged], [1, 1, 1]);
    assert.ok(!exists(join(kb, 'raw', 'confluence', '103.md'))); // detect-only purity
    assert.ok(read(join(kb, 'raw', 'confluence', '101.md')).includes('old 101'));

    const r = await runWithPat(['confluence', '--kb', kb, '--selector', 'space = PAY']);
    assert.equal(r.code, 0);
    assert.deepEqual([r.json.created, r.json.updated, r.json.unchanged], [1, 1, 1]);
    assert.ok(exists(join(kb, 'raw', 'assets', 'confluence', '101', 'a.png')));
    const { data, body } = readConfRaw(kb, '101');
    assert.equal(data.source_version, '2026-08-02T00:00:00.000Z');
    assert.ok(body.includes('![a.png](../assets/confluence/101/a.png)'));
    assert.equal(data.labels, undefined); // labels omitted when empty
    const searchReq = srv.requests.find(q => q.path === '/rest/api/content/search');
    assert.equal(searchReq.query.cql, 'space = PAY');
    assert.equal(searchReq.query.expand, 'version');
  } finally { srv.close(); }
});

test('confluence: CQL 500-page cap — exactly 500 matches warns NOT; 501 warns (totalSize-based)', async () => {
  // fake server: totalSize pages of 100; content endpoint serves any id
  const makeSrv = (totalSize) => startFakeServer((req, res, u) => {
    if (u.pathname === '/rest/api/content/search') {
      const start = Number(u.searchParams.get('start') ?? 0);
      const n = Math.min(100, totalSize - start);
      return jsonRes(res, {
        totalSize,
        results: Array.from({ length: n }, (_, i) => ({ id: String(start + i + 1), version: { when: '2026-08-01T00:00:00.000Z' } })),
      });
    }
    const m = u.pathname.match(/^\/rest\/api\/content\/(\d+)$/);
    if (m) return jsonRes(res, confPage(m[1]));
    jsonRes(res, {}, 404);
  });

  const srv500 = await makeSrv(500);
  try {
    const kb = makeConfKb(srv500.base);
    const r = await runWithPat(['confluence', '--kb', kb, '--selector', 'space = PAY']);
    assert.equal(r.code, 0);
    assert.equal(r.json.created, 500);
    assert.ok(!r.json.warnings || !r.json.warnings.some(w => /cap/i.test(w))); // exactly 500 → no false positive
  } finally { srv500.close(); }

  const srv501 = await makeSrv(501);
  try {
    const kb = makeConfKb(srv501.base);
    const r = await runWithPat(['confluence', '--kb', kb, '--selector', 'space = PAY']);
    assert.equal(r.code, 0);
    assert.equal(r.json.created, 500);
    assert.ok(r.json.warnings.some(w => /500/.test(w) && /cap/i.test(w)));
  } finally { srv501.close(); }
});

test('confluence: second identical run → unchanged, no full pull', async () => {
  const srv = await startFakeServer(confHandler({ '42': confPage('42') }));
  try {
    const kb = makeConfKb(srv.base);
    assert.equal((await runWithPat(['confluence', '--kb', kb, '--selector', `${srv.base}/pages/viewpage.action?pageId=42`])).json.created, 1);
    const before = srv.requests.length;
    const r2 = await runWithPat(['confluence', '--kb', kb, '--selector', `${srv.base}/pages/viewpage.action?pageId=42`]);
    assert.equal(r2.code, 0);
    assert.deepEqual([r2.json.created, r2.json.updated, r2.json.unchanged], [0, 0, 1]);
    const after = srv.requests.slice(before);
    assert.equal(after.length, 1);
    assert.equal(after[0].query.expand, 'version'); // light detect only
  } finally { srv.close(); }
});

test('confluence: 401 aborts — exit 1, hint names pat_env, sentinel PAT absent from output', async () => {
  const srv = await startFakeServer((req, res) => jsonRes(res, { message: 'SECRET-SENTINEL denied' }, 401));
  try {
    const kb = makeConfKb(srv.base);
    const r = await runWithPat(['confluence', '--kb', kb, '--selector', `${srv.base}/pages/viewpage.action?pageId=1`]);
    assert.equal(r.code, 1);
    assert.equal(r.json.error.code, 'auth-failed');
    assert.match(r.json.error.hint, /CONF_TEST_PAT/);
    assert.ok(!r.stdout.includes('SECRET-SENTINEL'));
    assert.ok(!r.stderr.includes('SECRET-SENTINEL'));
  } finally { srv.close(); }
});

// ---- Confluence two-strike removed_upstream (§3 rule extended by controller decision) ----

function writeConfRaw(kb, id, version = '2026-08-01T00:00:00.000Z') {
  writeRaw(kb, 'confluence', id, {
    source_url: `http://x/pages/viewpage.action?pageId=${id}`, source_version: version,
    pulled_at: '2026-08-01T01:00:00.000Z', content_hash: 'manual',
  }, 'old body');
}

test('confluence: two-strike — first missing keeps raw + warning + state; second deletes + logs', async () => {
  const srv = await startFakeServer(confHandler({})); // page never exists upstream
  try {
    const kb = makeConfKb(srv.base);
    writeConfRaw(kb, '55');

    const r1 = await runWithPat(['confluence', '--kb', kb, '--selector', `${srv.base}/pages/viewpage.action?pageId=55`]);
    assert.equal(r1.code, 0);
    assert.equal(r1.json.removed_upstream, 0);
    assert.ok(exists(join(kb, 'raw', 'confluence', '55.md'))); // kept on first strike
    assert.ok(r1.json.warnings.some(w => /55/.test(w)));
    const state1 = JSON.parse(read(join(kb, '.kb', 'acquire-state.json')));
    assert.ok(state1['confluence/55'].firstMissingAt);
    assert.equal(read(join(kb, 'log.md')), ''); // no removal log on first strike

    const r2 = await runWithPat(['confluence', '--kb', kb, '--selector', `${srv.base}/pages/viewpage.action?pageId=55`]);
    assert.equal(r2.code, 0);
    assert.equal(r2.json.removed_upstream, 1);
    assert.ok(!exists(join(kb, 'raw', 'confluence', '55.md'))); // deleted on second strike
    assert.ok(!('confluence/55' in JSON.parse(read(join(kb, '.kb', 'acquire-state.json')))));
    assert.match(read(join(kb, 'log.md')),
      /^## \[[^\]]+\] acquire \| pull \| raw\/confluence\/55\.md \| removed_upstream$/m);
  } finally { srv.close(); }
});

test('confluence: reappearing page clears the first-strike state entry', async () => {
  const pages = {};
  const srv = await startFakeServer(confHandler(pages));
  try {
    const kb = makeConfKb(srv.base);
    writeConfRaw(kb, '55');
    const r1 = await runWithPat(['confluence', '--kb', kb, '--selector', `${srv.base}/pages/viewpage.action?pageId=55`]);
    assert.equal(r1.json.removed_upstream, 0);
    assert.ok(JSON.parse(read(join(kb, '.kb', 'acquire-state.json')))['confluence/55']);
    pages['55'] = confPage('55', { versionWhen: '2026-08-09T00:00:00.000Z' }); // reappears, changed
    const r2 = await runWithPat(['confluence', '--kb', kb, '--selector', `${srv.base}/pages/viewpage.action?pageId=55`]);
    assert.equal(r2.code, 0);
    assert.equal(r2.json.updated, 1);
    assert.ok(!('confluence/55' in JSON.parse(read(join(kb, '.kb', 'acquire-state.json')))));
  } finally { srv.close(); }
});

test('confluence: CQL results missing a local raw → same two-strike handling', async () => {
  const search = (req, res) => jsonRes(res, { results: [{ id: '42', version: { when: '2026-08-01T00:00:00.000Z' } }] });
  const srv = await startFakeServer(confHandler({ '42': confPage('42') }, { search }));
  try {
    const kb = makeConfKb(srv.base);
    writeConfRaw(kb, '42'); // present upstream, same version → unchanged
    writeConfRaw(kb, '999'); // absent from CQL results

    const r1 = await runWithPat(['confluence', '--kb', kb, '--selector', 'space = PAY']);
    assert.equal(r1.code, 0);
    assert.equal(r1.json.removed_upstream, 0);
    assert.ok(exists(join(kb, 'raw', 'confluence', '999.md'))); // kept on first strike
    assert.ok(r1.json.warnings.some(w => /999/.test(w)));
    assert.ok(JSON.parse(read(join(kb, '.kb', 'acquire-state.json')))['confluence/999']);

    const r2 = await runWithPat(['confluence', '--kb', kb, '--selector', 'space = PAY']);
    assert.equal(r2.code, 0);
    assert.equal(r2.json.removed_upstream, 1);
    assert.ok(!exists(join(kb, 'raw', 'confluence', '999.md'))); // deleted on second strike
    assert.ok(exists(join(kb, 'raw', 'confluence', '42.md'))); // present page untouched
    assert.ok(!('confluence/999' in JSON.parse(read(join(kb, '.kb', 'acquire-state.json')))));
    assert.match(read(join(kb, 'log.md')),
      /^## \[[^\]]+\] acquire \| pull \| raw\/confluence\/999\.md \| removed_upstream$/m);
  } finally { srv.close(); }
});

test('confluence: single-page 404 with no local raw → typed not-found error, exit 1', async () => {
  const srv = await startFakeServer(confHandler({}));
  try {
    const kb = makeConfKb(srv.base);
    const r = await runWithPat(['confluence', '--kb', kb, '--selector', `${srv.base}/pages/viewpage.action?pageId=404`]);
    assert.equal(r.code, 1);
    assert.equal(r.json.error.code, 'not-found');
    assert.ok(!exists(join(kb, '.kb', 'acquire-state.json'))); // no strike recorded for never-pulled pages
  } finally { srv.close(); }
});

// ---- tombstones + --force (§1.4/§2.6) ----

function writeTombstone(kb, key) {
  writeFileSync(join(kb, '.kb', 'govern', 'source-tombstones.json'),
    JSON.stringify({ [key]: { ts: '2026-08-10T00:00:00Z', reason: 'archive-loser', decision: 'd-20260810-001' } }, null, 2));
}

test('tombstone: pull of tombstoned source_id is skipped with errors entry, exit 0, nothing created', async () => {
  const srv = await startFakeServer(jiraHandler({ 'PROJ-123': jiraIssue('PROJ-123') }));
  try {
    const kb = makeJiraKb(srv.base);
    writeTombstone(kb, 'raw:jira/PROJ-123');
    const r = await runWithPat(['jira', '--kb', kb, '--selector', 'PROJ-123']);
    assert.equal(r.code, 0);
    assert.equal(r.json.created, 0);
    assert.equal(r.json.errors.length, 1);
    assert.equal(r.json.errors[0].code, 'tombstoned');
    assert.match(r.json.errors[0].target, /jira\/PROJ-123/);
    assert.ok(!exists(join(kb, 'raw', 'jira', 'PROJ-123.md')));
  } finally { srv.close(); }
});

test('tombstone: --detect-only --force has NO side effects (tombstone file and log.md unchanged)', async () => {
  const srv = await startFakeServer(jiraHandler({ 'PROJ-123': jiraIssue('PROJ-123') }));
  try {
    const kb = makeJiraKb(srv.base);
    writeTombstone(kb, 'raw:jira/PROJ-123');
    const tombBefore = read(join(kb, '.kb', 'govern', 'source-tombstones.json'));
    const r = await runWithPat(['jira', '--kb', kb, '--selector', 'PROJ-123', '--detect-only', '--force']);
    assert.equal(r.code, 0);
    assert.equal(r.json.created, 0); // suppressed in detect-only even with --force
    assert.ok(r.json.warnings.some(w => /tombstone/i.test(w)));
    assert.equal(read(join(kb, '.kb', 'govern', 'source-tombstones.json')), tombBefore); // tombstone intact
    assert.equal(read(join(kb, 'log.md')), ''); // no 'force: tombstone cleared' line
    assert.ok(!exists(join(kb, 'raw', 'jira', 'PROJ-123.md'))); // nothing pulled
  } finally { srv.close(); }
});

test('tombstone: --force pulls normally, deletes the tombstone key, logs force note', async () => {
  const srv = await startFakeServer(jiraHandler({ 'PROJ-123': jiraIssue('PROJ-123') }));
  try {
    const kb = makeJiraKb(srv.base);
    writeTombstone(kb, 'raw:jira/PROJ-123');
    const r = await runWithPat(['jira', '--kb', kb, '--selector', 'PROJ-123', '--force']);
    assert.equal(r.code, 0);
    assert.equal(r.json.created, 1);
    assert.ok(exists(join(kb, 'raw', 'jira', 'PROJ-123.md')));
    const tombs = JSON.parse(read(join(kb, '.kb', 'govern', 'source-tombstones.json')));
    assert.ok(!('raw:jira/PROJ-123' in tombs)); // tombstone cleared
    assert.match(read(join(kb, 'log.md')),
      /^## \[[^\]]+\] acquire \| pull \| raw\/jira\/PROJ-123\.md \| force: tombstone cleared$/m);
  } finally { srv.close(); }
});

// ---- hardening regression tests ----

test('hardening I1: unresponsive server → fetch-failed timeout (LLM_WIKI_FETCH_TIMEOUT_MS override), no PAT leak', async () => {
  const srv = await startFakeServer(() => { /* accepts but never responds */ });
  try {
    const kb = makeJiraKb(srv.base);
    const r = await runWithPat(['jira', '--kb', kb, '--selector', 'PROJ-1'], 'SECRET-SENTINEL', { LLM_WIKI_FETCH_TIMEOUT_MS: '500' });
    assert.equal(r.code, 1);
    assert.equal(r.json.error.code, 'fetch-failed');
    assert.match(r.json.error.message, /timed out/);
    assert.match(r.json.error.hint, /network/);
    assert.ok(!r.stdout.includes('SECRET-SENTINEL'));
    assert.ok(!r.stderr.includes('SECRET-SENTINEL'));
  } finally { srv.close(); }
});

test('hardening I2: xhtmlToMd on 2000 unclosed CDATA/macro openers completes in <2s', () => {
  const hostile = '<p>ok</p>' + '<![CDATA[orphan'.repeat(2000) + '<ac:structured-macro ac:name="x">'.repeat(2000) + '<pre>'.repeat(2000);
  const t0 = Date.now();
  const out = xhtmlToMd(hostile, '9');
  assert.ok(Date.now() - t0 < 2000);
  assert.ok(out.includes('ok'));
});

test('hardening I3: bad attachment filenames and failing downloads degrade to warnings; page raw still written', async () => {
  const handler = jiraHandler({ 'PROJ-8': jiraIssue('PROJ-8', {
    description: 'see attachments',
    attachment: [
      { filename: '..', content: '/att/dot' },
      { filename: 'a?b:c.txt', content: '/att/reserved' },
      { filename: 'bad.txt', content: '/att/500' },
      { filename: 'good.txt', content: '/att/good' },
    ],
  }) }, { fallback: (req, res, u) => {
    if (u.pathname === '/att/good') { res.writeHead(200); res.end('fine'); return; }
    jsonRes(res, {}, 500);
  } });
  const srv = await startFakeServer(handler);
  try {
    const kb = makeJiraKb(srv.base);
    const r = await runWithPat(['jira', '--kb', kb, '--selector', 'PROJ-8']);
    assert.equal(r.code, 0);
    assert.equal(r.json.created, 1); // page raw still written
    assert.ok(exists(join(kb, 'raw', 'jira', 'PROJ-8.md')));
    const w = r.json.warnings.filter(x => !/git commit failed/.test(x)); // KB is not a git repo here
    assert.equal(w.length, 3); // '..', 'a?b:c.txt', and the 500 download
    assert.ok(w.some(x => /unusable filename/.test(x)));
    assert.ok(w.some(x => /bad\.txt/.test(x) && /not downloaded/.test(x)));
    assert.ok(exists(join(kb, 'raw', 'assets', 'jira', 'PROJ-8', 'good.txt'))); // good attachment landed
    assert.ok(!exists(join(kb, 'raw', 'assets', 'jira', 'PROJ-8', 'bad.txt')));
  } finally { srv.close(); }
});

test('hardening I4: JSON response over the 50MB content-length cap → typed upstream-error, exit 1', async () => {
  const srv = await startFakeServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(60 * 1024 * 1024) });
    res.end('{}'); // client aborts on the header before reading
  });
  try {
    const kb = makeJiraKb(srv.base);
    const r = await runWithPat(['jira', '--kb', kb, '--selector', 'PROJ-1']);
    assert.equal(r.code, 1);
    assert.equal(r.json.error.code, 'upstream-error');
    assert.match(r.json.error.message, /50MB/);
  } finally { srv.close(); }
});

test('hardening I4: attachment over the 50MB cap → warning + skip, page raw still written', async () => {
  const handler = jiraHandler({ 'PROJ-6': jiraIssue('PROJ-6', {
    description: 'see big.bin',
    attachment: [{ filename: 'big.bin', content: '/att/big' }],
  }) }, { fallback: (req, res, u) => {
    if (u.pathname === '/att/big') {
      res.writeHead(200, { 'content-length': String(60 * 1024 * 1024) });
      res.end('small'); // client skips on the header
      return;
    }
    jsonRes(res, {}, 404);
  } });
  const srv = await startFakeServer(handler);
  try {
    const kb = makeJiraKb(srv.base);
    const r = await runWithPat(['jira', '--kb', kb, '--selector', 'PROJ-6']);
    assert.equal(r.code, 0);
    assert.equal(r.json.created, 1);
    assert.ok(r.json.warnings.some(w => /big\.bin/.test(w) && /50MB/.test(w)));
    assert.ok(!exists(join(kb, 'raw', 'assets', 'jira', 'PROJ-6', 'big.bin')));
  } finally { srv.close(); }
});

test('hardening M6: corrupt source-tombstones.json → fail-closed exit 1 with precise error', async () => {
  const srv = await startFakeServer(jiraHandler({ 'PROJ-123': jiraIssue('PROJ-123') }));
  try {
    const kb = makeJiraKb(srv.base);
    writeFileSync(join(kb, '.kb', 'govern', 'source-tombstones.json'), '{corrupt!!!');
    const r = await runWithPat(['jira', '--kb', kb, '--selector', 'PROJ-123']);
    assert.equal(r.code, 1);
    assert.equal(r.json.error.code, 'corrupt-tombstones');
    assert.match(r.json.error.hint, /fix or delete \.kb\/govern\/source-tombstones\.json/i);
    assert.ok(!exists(join(kb, 'raw', 'jira', 'PROJ-123.md'))); // nothing pulled while suppression is unreadable
  } finally { srv.close(); }
});

test('hardening M7: subdir-scoped deletion works when the repo path itself contains an /openwiki/ segment', () => {
  // file:// fallback + repo at <tmp>/openwiki/proj — indexOf would recover 'openwiki/proj/openwiki/...'
  const repo = join(tmp(), 'openwiki', 'proj');
  const ow = join(repo, 'openwiki');
  mkdirSync(join(ow, 'a'), { recursive: true });
  writeFileSync(join(ow, 'a', 'c.md'), '# a/c\n');
  writeFileSync(join(ow, 'top.md'), '# top\n');
  const kb = makeKb(tmp());

  assert.equal(run(['openwiki', '--kb', kb, '--repo', repo]).json.created, 2);
  unlinkSync(join(ow, 'a', 'c.md'));
  const r = run(['openwiki', '--kb', kb, '--repo', repo, '--subdir', 'a']);
  assert.equal(r.code, 0);
  assert.equal(r.json.removed_upstream, 1); // in-scope deletion must work despite the nested segment
  assert.ok(!exists(join(kb, 'raw', 'openwiki', 'a--c.md')));
  assert.ok(exists(join(kb, 'raw', 'openwiki', 'top.md'))); // out-of-scope raw survives
});

test('hardening M8: malformed percent-encoding in /display/ URL → typed bad-selector, exit 64', async () => {
  const srv = await startFakeServer(confHandler({}));
  try {
    const kb = makeConfKb(srv.base);
    const r = await runWithPat(['confluence', '--kb', kb, '--selector', `${srv.base}/display/PAY/Bad%ZZTitle`]);
    assert.equal(r.code, 64);
    assert.equal(r.json.error.code, 'bad-selector');
    assert.equal(srv.requests.length, 0); // rejected before any network call
  } finally { srv.close(); }
});

test('hardening M10: non-JSON 200 response → typed upstream-error, exit 1, no raw written', async () => {
  const srv = await startFakeServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>not a jira</html>');
  });
  try {
    const kb = makeJiraKb(srv.base);
    const r = await runWithPat(['jira', '--kb', kb, '--selector', 'PROJ-1']);
    assert.equal(r.code, 1);
    assert.equal(r.json.error.code, 'upstream-error');
    assert.match(r.json.error.message, /non-JSON/);
    assert.ok(!exists(join(kb, 'raw', 'jira', 'PROJ-1.md')));
  } finally { srv.close(); }
});
