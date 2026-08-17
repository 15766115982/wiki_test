// Task 14 — end-to-end script (§10): fixtures → acquire → govern run → adjudication → render.
//
// Degraded-path equivalence note (§10 降级等价性): when Node scripts are unavailable the agent
// follows SKILL.md's manual paths; the documented product deltas vs the scripted path are:
//   1. raw docs written manually carry content_hash: "manual" (§2.2 手动豁免) — validate skips
//      hash-dup for them and plan skips anomaly detection (both directions "manual").
//   2. degraded mode forbids automatic `approved` (§1.3) — every governance action lands as a
//      sidecar candidate for batch human approval; no `auto-approve` decisions are recorded.
//   3. git commits are made by the agent with the same §2.8 messages (acquire:/govern:/review:).
// These deltas are documentation promises of SKILL.md; this file machine-checks only what the
// scripted path produces.
import test from 'node:test';
import assert from 'node:assert/strict';
import { unlinkSync, writeFileSync } from 'node:fs';
import { runScript, git, gitInit, tmp, join, read, exists, cpSync, FIXTURES } from './helpers.mjs';
import { splitFrontmatter, serializeFrontmatter } from '../llm-wiki/scripts/validate.mjs';

const CANDIDATE = 'wiki/concepts/retry-policy.candidate.md';

function setup() {
  const kb = join(tmp('llmwiki-e2e-kb-'), 'kb');
  cpSync(join(FIXTURES, 'kb'), kb, { recursive: true });
  gitInit(kb);
  const repo = join(tmp('llmwiki-e2e-upstream-'), 'repo');
  cpSync(join(FIXTURES, 'upstream-repo'), repo, { recursive: true });
  gitInit(repo);
  git(repo, 'remote', 'add', 'origin', 'https://example.com/repo.git');
  return { kb, repo };
}

test('fixtures self-check: fixtures/kb copy passes validate with exit 0', () => {
  const kb = join(tmp('llmwiki-fixcheck-'), 'kb');
  cpSync(join(FIXTURES, 'kb'), kb, { recursive: true });
  const r = runScript('validate.mjs', ['--kb', kb]);
  assert.equal(r.code, 0, JSON.stringify(r.json) + r.stderr);
  assert.ok(r.json.checked > 0 && r.json.passed);
});

test('e2e: acquire → validate → govern → render → adjudication → re-validate (§10)', () => {
  const { kb, repo } = setup();

  // --- step 2: acquire openwiki, then validate -------------------------------
  const acq = runScript('acquire.mjs', ['openwiki', '--kb', kb, '--repo', repo]);
  assert.equal(acq.code, 0, acq.stdout + acq.stderr);
  assert.ok(acq.json.created >= 1, JSON.stringify(acq.json)); // upstream index.md is new
  assert.ok(exists(join(kb, 'raw/openwiki/index.md')));
  let v = runScript('validate.mjs', ['--kb', kb]);
  assert.equal(v.code, 0, JSON.stringify(v.json) + v.stderr);

  // --- step 3: govern sweep / plan / rebuild-index ---------------------------
  const sweep = runScript('govern.mjs', ['--kb', kb, 'sweep']);
  assert.equal(sweep.code, 0, sweep.stdout + sweep.stderr);
  assert.deepEqual(sweep.json, { archived: [] }); // fixture archive entry is already archived

  const plan = runScript('govern.mjs', ['--kb', kb, 'plan']);
  assert.equal(plan.code, 0, plan.stdout + plan.stderr);
  assert.deepEqual(Object.keys(plan.json).sort(),
    ['anomalies', 'errors', 'human_lists', 'pending', 'review_queue', 'suppressed']);
  const rq = plan.json.review_queue.find(q => q.candidate === CANDIDATE);
  assert.ok(rq, JSON.stringify(plan.json.review_queue));
  assert.equal(rq.base, null);
  assert.ok(typeof rq.review_note === 'string' && rq.review_note.length > 0);

  const rb = runScript('govern.mjs', ['--kb', kb, 'rebuild-index']);
  assert.equal(rb.code, 0, rb.stdout + rb.stderr);
  assert.deepEqual(rb.json.counts, { sources: 4, syntheses: 1, concepts: 1, entities: 1 });
  // idempotence: rebuild output is byte-identical to the fixture's committed index.md
  assert.equal(read(join(kb, 'wiki', 'index.md')), read(join(FIXTURES, 'kb', 'wiki', 'index.md')));

  // --- step 4: render report + site ------------------------------------------
  const rep = runScript('render.mjs', ['--kb', kb, 'report']);
  assert.equal(rep.code, 0, rep.stdout + rep.stderr);
  assert.equal(rep.json.candidates, 1);
  const latest = join(kb, '.kb', 'govern', 'reports', 'latest.html');
  assert.ok(exists(latest));
  const html = read(latest);
  // review_note contains '<unresolved>' — must appear only in escaped form (§6)
  assert.ok(!html.includes('<unresolved>'), 'unescaped review_note leaked into HTML');
  assert.ok(html.includes('\\u003cunresolved') || html.includes('&lt;unresolved&gt;'),
    'escaped review_note not found in report');
  assert.ok(!/fetch\s*\(|localStorage|sessionStorage|XMLHttpRequest/.test(html));

  const site = runScript('render.mjs', ['--kb', kb, 'site']);
  assert.equal(site.code, 0, site.stdout + site.stderr);
  assert.ok(exists(join(kb, '.kb', 'site', 'index.html')));
  assert.equal(site.json.pages, 7); // 4 sources + 1 synthesis + 1 concept + 1 entity (approved only)
  const island = read(join(kb, '.kb', 'site', 'index.html'))
    .match(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/)[1]
    .replace(/\\u003c/g, '<');
  const siteData = JSON.parse(island);
  assert.ok(siteData.edges.length > 0);
  assert.ok(siteData.edges.every(e => e.a !== 'index' && e.b !== 'index'),
    'index.md must never participate in graph edges (§6.2)');

  // --- step 5: record-decision (human approve) --------------------------------
  const before = read(join(kb, '.kb', 'govern', 'decisions.jsonl')).trim().split('\n').length;
  const rd = runScript('govern.mjs', ['--kb', kb, 'record-decision',
    '--actor', 'human', '--action', 'approve', '--page', CANDIDATE, '--reason', 'e2e']);
  assert.equal(rd.code, 0, rd.stdout + rd.stderr);
  const today = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  assert.equal(rd.json.id, `d-${today}-001`);
  const after = read(join(kb, '.kb', 'govern', 'decisions.jsonl')).trim().split('\n').map(JSON.parse);
  assert.equal(after.length, before + 1);
  assert.equal(after.at(-1).page, CANDIDATE);
  const logLines = read(join(kb, 'log.md')).trim().split('\n');
  assert.match(logLines.at(-1), /review \| approve \| wiki\/concepts\/retry-policy\.candidate\.md \| e2e/);

  // --- step 6: apply the adjudication (agent-side file ops, §2.3 approve) -----
  const { data, body } = splitFrontmatter(read(join(kb, CANDIDATE)));
  delete data.base;
  delete data.review_note;
  data.status = 'approved';
  const placed = join(kb, 'wiki', 'concepts', 'retry-policy.md');
  runScript('validate.mjs', ['--kb', kb, '--file', CANDIDATE]); // sidecar still valid pre-apply
  unlinkSync(join(kb, CANDIDATE));
  writeFileSync(placed, serializeFrontmatter(data, body));
  v = runScript('validate.mjs', ['--kb', kb]);
  assert.equal(v.code, 0, JSON.stringify(v.json) + v.stderr);
  const rb2 = runScript('govern.mjs', ['--kb', kb, 'rebuild-index']);
  assert.equal(rb2.code, 0, rb2.stdout + rb2.stderr);
  assert.equal(rb2.json.counts.concepts, 2); // retry-policy landed as an approved concept
});
