import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { hostname } from 'node:os';
import { runScript, makeKb, writeRaw, tmp, git, gitInit, read, exists, join, writeFileSync } from './helpers.mjs';

// ---- local helpers ----
function writePage(kb, rel, fm, body) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fm))
    lines.push(`${k}: ${v === null ? 'null' : Array.isArray(v) ? '[' + v.join(', ') + ']' : v}`);
  lines.push('---', '', body);
  writeFileSync(join(kb, rel), lines.join('\n'));
}
const RAW_FM = { source_url: 'https://x/1', source_version: '1', pulled_at: '2026-08-01T00:00:00Z', content_hash: 'sha256:aaaa' };
const PAGE_FM = { status: 'approved', title: 'T', summary: 's', created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z' };
const today = () => new Date().toISOString().slice(0, 10).replaceAll('-', '');

// ---- run.lock (verbatim from plan) ----
test('run.lock: second invocation while locked → exit 1; stale >2h reclaimed', () => {
  const kb = makeKb(tmp());
  writeFileSync(join(kb, '.kb/govern/run.lock'), JSON.stringify({ pid: 999999, ts: new Date().toISOString(), host: 'test' }));
  const r1 = runScript('govern.mjs', ['--kb', kb, 'sweep']);
  assert.equal(r1.code, 1);
  assert.match(r1.json.error.message, /another run/i);
  writeFileSync(join(kb, '.kb/govern/run.lock'), JSON.stringify({ pid: 999999, ts: new Date(Date.now() - 3 * 3600e3).toISOString(), host: 'test' }));
  const r2 = runScript('govern.mjs', ['--kb', kb, 'sweep']);
  assert.equal(r2.code, 0);
  assert.ok(!exists(join(kb, '.kb/govern/run.lock')));
});

test('run.lock: same-host lock with dead pid is reclaimed immediately (fresh ts)', () => {
  const kb = makeKb(tmp());
  const dead = spawnSync(process.execPath, ['-e', '']).pid; // spawned-and-reaped → definitely dead
  writeFileSync(join(kb, '.kb/govern/run.lock'), JSON.stringify({ pid: dead, ts: new Date().toISOString(), host: hostname() }));
  const r = runScript('govern.mjs', ['--kb', kb, 'sweep']);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!exists(join(kb, '.kb/govern/run.lock')));
});

// ---- sweep ----
test('sweep: rejected archive files flipped to archived, others untouched, log line written', () => {
  const kb = makeKb(tmp());
  writePage(kb, 'wiki/archive/old.candidate.md', { type: 'source', status: 'rejected', title: 'O', summary: 'o', created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z', source_ref: 'local/old' }, 'rejected body');
  writePage(kb, 'wiki/archive/done.md', { type: 'concept', status: 'archived', title: 'D', summary: 'd', created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z', sources: [] }, 'already archived');
  const before = read(join(kb, 'wiki/archive/done.md'));
  const r = runScript('govern.mjs', ['--kb', kb, 'sweep']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json, { archived: ['wiki/archive/old.candidate.md'] });
  assert.match(read(join(kb, 'wiki/archive/old.candidate.md')), /^status: archived$/m);
  assert.equal(read(join(kb, 'wiki/archive/done.md')), before);
  assert.match(read(join(kb, 'log.md')), /govern \| sweep \| wiki\/archive\/old\.candidate\.md \| rejected → archived/);
});

// ---- plan (verbatim from plan) ----
test('plan: six lists, pending new/stale via git baseline', () => {
  const kb = makeKb(tmp());
  gitInit(kb);
  // raw A (has source page) + raw C (has source page, stays untouched) committed at the baseline
  writeRaw(kb, 'local', 'a', { ...RAW_FM }, 'body a v1');
  writePage(kb, 'wiki/sources/a.md', { ...PAGE_FM, type: 'source', source_ref: 'local/a' }, 'page a');
  writeRaw(kb, 'local', 'c', { ...RAW_FM, source_url: 'https://x/3' }, 'body c');
  writePage(kb, 'wiki/sources/c.md', { ...PAGE_FM, type: 'source', source_ref: 'local/c' }, 'page c');
  git(kb, 'add', '-A'); git(kb, 'commit', '-m', 'govern: run 2026-08-12T00:00:00Z');
  // then modify raw A (version bumped too → stale, not anomaly); add raw B (no source page)
  writeRaw(kb, 'local', 'a', { ...RAW_FM, source_version: '2', content_hash: 'sha256:bbbb' }, 'body a v2');
  writeRaw(kb, 'local', 'b', { ...RAW_FM, source_url: 'https://x/2' }, 'body b');
  const r = runScript('govern.mjs', ['--kb', kb, 'plan']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(Object.keys(r.json).sort(), ['anomalies', 'errors', 'human_lists', 'pending', 'review_queue', 'suppressed']);
  assert.deepEqual(r.json.pending.find(p => p.raw === 'raw/local/b.md'), { raw: 'raw/local/b.md', status: 'new' });
  assert.deepEqual(r.json.pending.find(p => p.raw === 'raw/local/a.md'), { raw: 'raw/local/a.md', status: 'stale' });
  assert.ok(!r.json.pending.some(p => p.raw === 'raw/local/c.md'));
});

test('plan: no baseline → raws without pages new, with pages stale (conservative)', () => {
  const kb = makeKb(tmp());
  gitInit(kb); // git repo but no 'govern: run' commit
  writeRaw(kb, 'local', 'n', { ...RAW_FM }, 'no page');
  writeRaw(kb, 'local', 's', { ...RAW_FM, source_url: 'https://x/2' }, 'has page');
  writePage(kb, 'wiki/sources/s.md', { ...PAGE_FM, type: 'source', source_ref: 'local/s' }, 'page');
  const r = runScript('govern.mjs', ['--kb', kb, 'plan']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json.pending.find(p => p.raw === 'raw/local/n.md'), { raw: 'raw/local/n.md', status: 'new' });
  assert.deepEqual(r.json.pending.find(p => p.raw === 'raw/local/s.md'), { raw: 'raw/local/s.md', status: 'stale' });
  assert.equal(r.json.anomalies.length, 0);
});

test('plan errors: unparseable frontmatter and missing contract fields', () => {
  const kb = makeKb(tmp());
  writeFileSync(join(kb, 'raw/local/bad.md'), '---\nsource: local\n  indented: nope\n---\nbody\n');
  writeRaw(kb, 'local', 'partial', { source_url: 'https://x/9' }, 'body');
  const r = runScript('govern.mjs', ['--kb', kb, 'plan']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json.errors.find(e => e.file === 'raw/local/bad.md'), { file: 'raw/local/bad.md', kind: 'unparseable' });
  assert.deepEqual(r.json.errors.find(e => e.file === 'raw/local/partial.md'),
    { file: 'raw/local/partial.md', kind: 'missing-fields', missing: ['source_version', 'pulled_at', 'content_hash'] });
  assert.ok(!r.json.pending.some(p => p.raw === 'raw/local/partial.md'));
});

test('plan anomalies: hash changed + version unchanged flagged; version bump not; manual skipped', () => {
  const kb = makeKb(tmp());
  gitInit(kb);
  writeRaw(kb, 'local', 'x', { source_url: 'u', source_version: '1', pulled_at: '2026-08-01T00:00:00Z', content_hash: 'sha256:aaa' }, 'old body');
  git(kb, 'add', '-A'); git(kb, 'commit', '-m', 'govern: run 2026-08-12T00:00:00Z');
  // body changed, source_version kept → anomaly
  writeRaw(kb, 'local', 'x', { source_url: 'u', source_version: '1', pulled_at: '2026-08-02T00:00:00Z', content_hash: 'sha256:bbb' }, 'new body');
  let r = runScript('govern.mjs', ['--kb', kb, 'plan']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json.anomalies, [{ raw: 'raw/local/x.md', page: null, kind: 'hash-changed-version-unchanged' }]);
  // source_version changed too → pending stale / new, NOT anomaly
  writeRaw(kb, 'local', 'x', { source_url: 'u', source_version: '2', pulled_at: '2026-08-02T00:00:00Z', content_hash: 'sha256:bbb' }, 'new body');
  r = runScript('govern.mjs', ['--kb', kb, 'plan']);
  assert.equal(r.json.anomalies.length, 0);
  // manual hash → anomaly detection skipped (§2.2)
  writeRaw(kb, 'local', 'x', { source_url: 'u', source_version: '1', pulled_at: '2026-08-02T00:00:00Z', content_hash: 'manual' }, 'new body');
  r = runScript('govern.mjs', ['--kb', kb, 'plan']);
  assert.equal(r.json.anomalies.length, 0);
});

test('plan review_queue: candidate sidecars listed; missing keys defaulted', () => {
  const kb = makeKb(tmp());
  writePage(kb, 'wiki/sources/foo.candidate.md', { type: 'source', status: 'candidate', title: 'F', summary: 'f', created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z', source_ref: 'local/foo', base: 'wiki/sources/foo.md', review_note: 'new page' }, 'cand body');
  writePage(kb, 'wiki/concepts/bar.candidate.md', { type: 'concept', status: 'candidate', title: 'B', summary: 'b', created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z', sources: [] }, 'no review note, no base');
  const r = runScript('govern.mjs', ['--kb', kb, 'plan']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json.review_queue.find(q => q.candidate === 'wiki/sources/foo.candidate.md'),
    { candidate: 'wiki/sources/foo.candidate.md', base: 'wiki/sources/foo.md', review_note: 'new page' });
  assert.deepEqual(r.json.review_queue.find(q => q.candidate === 'wiki/concepts/bar.candidate.md'),
    { candidate: 'wiki/concepts/bar.candidate.md', base: null, review_note: '(missing review_note)' });
});

test('plan human_lists: orphan and dangling-link', () => {
  const kb = makeKb(tmp());
  writePage(kb, 'wiki/concepts/alpha.md', { ...PAGE_FM, type: 'concept', sources: [] }, 'see [[beta]] and [[ghost]]');
  writePage(kb, 'wiki/concepts/beta.md', { ...PAGE_FM, type: 'concept', sources: [] }, 'nothing here');
  const r = runScript('govern.mjs', ['--kb', kb, 'plan']);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.json.human_lists.some(e => e.kind === 'orphan' && e.page === 'wiki/concepts/alpha.md'));
  assert.ok(!r.json.human_lists.some(e => e.kind === 'orphan' && e.page === 'wiki/concepts/beta.md'));
  assert.deepEqual(r.json.human_lists.find(e => e.kind === 'dangling-link'),
    { kind: 'dangling-link', page: 'wiki/concepts/alpha.md', target: 'ghost' });
});

test('plan human_lists: conflict-pair via Jaccard ≥ 0.5; dismissal suppresses the pair', () => {
  const kb = makeKb(tmp());
  const body = 'the quick brown fox jumps over the lazy dog near the river bank';
  writePage(kb, 'wiki/sources/p1.md', { ...PAGE_FM, type: 'source', source_ref: 'local/p1' }, body);
  writePage(kb, 'wiki/sources/p2.md', { ...PAGE_FM, type: 'source', source_ref: 'local/p2' }, body);
  writePage(kb, 'wiki/sources/p3.md', { ...PAGE_FM, type: 'source', source_ref: 'local/p3' }, 'completely different vocabulary zzz qqq xylophone');
  let r = runScript('govern.mjs', ['--kb', kb, 'plan']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json.human_lists.find(e => e.kind === 'conflict-pair'),
    { kind: 'conflict-pair', a: 'wiki/sources/p1.md', b: 'wiki/sources/p2.md', similarity: 1 });
  // dismissal recorded with raw: refs (order flipped) → pair suppressed
  writeFileSync(join(kb, '.kb/govern/conflict-dismissals.json'),
    JSON.stringify([{ a: 'raw:local/p2', b: 'raw:local/p1', ts: '2026-08-12T00:00:00Z', decision: 'd-20260812-001' }]));
  r = runScript('govern.mjs', ['--kb', kb, 'plan']);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!r.json.human_lists.some(e => e.kind === 'conflict-pair'));
});

test('plan human_lists: hand-edit attribution (docs commit flagged; review: commit not; working tree flagged)', () => {
  const kb = makeKb(tmp());
  gitInit(kb);
  writePage(kb, 'wiki/concepts/topic.md', { ...PAGE_FM, type: 'concept', sources: [] }, 'v1');
  git(kb, 'add', '-A'); git(kb, 'commit', '-m', 'govern: run 2026-08-12T00:00:00Z');
  writePage(kb, 'wiki/concepts/topic.md', { ...PAGE_FM, type: 'concept', sources: [] }, 'v2');
  git(kb, 'add', '-A'); git(kb, 'commit', '-m', 'docs: tweak');
  const docsSha = git(kb, 'rev-parse', 'HEAD');
  writePage(kb, 'wiki/concepts/topic.md', { ...PAGE_FM, type: 'concept', sources: [] }, 'v3');
  git(kb, 'add', '-A'); git(kb, 'commit', '-m', 'review: 2 decisions');
  const reviewSha = git(kb, 'rev-parse', 'HEAD');
  let r = runScript('govern.mjs', ['--kb', kb, 'plan']);
  assert.equal(r.code, 0, r.stderr);
  const handEdits = r.json.human_lists.filter(e => e.kind === 'hand-edit');
  assert.ok(handEdits.some(e => e.page === 'wiki/concepts/topic.md' && e.commit === docsSha));
  assert.ok(!handEdits.some(e => e.commit === reviewSha));
  // uncommitted working-tree modification → '(working-tree)'
  writePage(kb, 'wiki/concepts/topic.md', { ...PAGE_FM, type: 'concept', sources: [] }, 'v4 uncommitted');
  r = runScript('govern.mjs', ['--kb', kb, 'plan']);
  assert.ok(r.json.human_lists.some(e => e.kind === 'hand-edit' && e.page === 'wiki/concepts/topic.md' && e.commit === '(working-tree)'));
});

test('plan human_lists: missing-raw for source page whose raw no longer exists', () => {
  const kb = makeKb(tmp());
  writePage(kb, 'wiki/sources/gone.md', { ...PAGE_FM, type: 'source', source_ref: 'local/gone' }, 'body');
  const r = runScript('govern.mjs', ['--kb', kb, 'plan']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json.human_lists.find(e => e.kind === 'missing-raw'),
    { kind: 'missing-raw', page: 'wiki/sources/gone.md', source_ref: 'local/gone' });
});

test('plan suppressed: tombstoned raw listed and excluded from pending; corrupt tombstone file fails closed', () => {
  const kb = makeKb(tmp());
  writeRaw(kb, 'local', 'z', { ...RAW_FM }, 'body z');
  writeFileSync(join(kb, '.kb/govern/source-tombstones.json'),
    JSON.stringify({ 'raw:local/z': { ts: '2026-08-12T00:00:00Z', reason: 'loser', decision: 'd-20260812-003' } }));
  let r = runScript('govern.mjs', ['--kb', kb, 'plan']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json.suppressed, [{ raw: 'raw/local/z.md', tombstone: { reason: 'loser', decision: 'd-20260812-003' } }]);
  assert.ok(!r.json.pending.some(p => p.raw === 'raw/local/z.md'));
  writeFileSync(join(kb, '.kb/govern/source-tombstones.json'), '{not json');
  r = runScript('govern.mjs', ['--kb', kb, 'plan']);
  assert.equal(r.code, 1);
  assert.match(r.json.error.message, /tombstone/i);
});

test('plan: CJK raw filename tracked through the git baseline (core.quotepath=false)', () => {
  const kb = makeKb(tmp());
  gitInit(kb);
  writeRaw(kb, 'local', '中文id', { source_url: 'u', source_version: '1', pulled_at: '2026-08-01T00:00:00Z', content_hash: 'sha256:aaa' }, '旧正文');
  writePage(kb, 'wiki/sources/cjk.md', { ...PAGE_FM, type: 'source', source_ref: 'local/中文id' }, 'page');
  git(kb, 'add', '-A'); git(kb, 'commit', '-m', 'govern: run 2026-08-12T00:00:00Z');
  // body changed, source_version kept → stale AND anomaly
  writeRaw(kb, 'local', '中文id', { source_url: 'u', source_version: '1', pulled_at: '2026-08-02T00:00:00Z', content_hash: 'sha256:bbb' }, '新正文');
  const r = runScript('govern.mjs', ['--kb', kb, 'plan']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json.pending.find(p => p.raw === 'raw/local/中文id.md'), { raw: 'raw/local/中文id.md', status: 'stale' });
  assert.deepEqual(r.json.anomalies, [{ raw: 'raw/local/中文id.md', page: 'wiki/sources/cjk.md', kind: 'hash-changed-version-unchanged' }]);
});

test('plan hand-edit: staged rename (R) in porcelain reports the NEW path', () => {
  const kb = makeKb(tmp());
  gitInit(kb);
  writePage(kb, 'wiki/concepts/old-name.md', { ...PAGE_FM, type: 'concept', sources: [] }, 'v1');
  git(kb, 'add', '-A'); git(kb, 'commit', '-m', 'govern: run 2026-08-12T00:00:00Z');
  git(kb, 'mv', 'wiki/concepts/old-name.md', 'wiki/concepts/new-name.md');
  const r = runScript('govern.mjs', ['--kb', kb, 'plan']);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.json.human_lists.some(e => e.kind === 'hand-edit' && e.page === 'wiki/concepts/new-name.md' && e.commit === '(working-tree)'));
  assert.ok(!r.json.human_lists.some(e => e.kind === 'hand-edit' && e.page === 'wiki/concepts/old-name.md'));
});

test('plan writes .kb/govern/last-plan.json with the six lists + ts', () => {
  const kb = makeKb(tmp());
  const r = runScript('govern.mjs', ['--kb', kb, 'plan']);
  assert.equal(r.code, 0, r.stderr);
  const lp = JSON.parse(read(join(kb, '.kb/govern/last-plan.json')));
  assert.deepEqual(Object.keys(lp).sort(), ['anomalies', 'errors', 'human_lists', 'pending', 'review_queue', 'suppressed', 'ts']);
});

// ---- rebuild-index (verbatim from plan) ----
test('rebuild-index: grouped, sorted, per-type line format, candidate/archive excluded', () => {
  const kb = makeKb(tmp());
  gitInit(kb);
  writePage(kb, 'wiki/sources/pay-table-v3.md', { type: 'source', status: 'approved', title: 'Pay Table v3', summary: '7 tables', created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-09T10:00:00Z', source_ref: 'confluence/102' }, 'body');
  writePage(kb, 'wiki/sources/pay-ops.md', { type: 'source', status: 'approved', title: 'Pay Ops', summary: 'ops runbook', created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-10T00:00:00Z', source_ref: 'jira/PAY-1' }, 'body');
  writePage(kb, 'wiki/syntheses/payment.md', { type: 'synthesis', status: 'approved', title: 'Payment', summary: 'cross-source narrative', created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-12T00:00:00Z', sources: ['raw:confluence/102', 'raw:jira/PAY-1', 'raw:local/x', 'raw:chat/conv-abc'] }, 'body');
  writePage(kb, 'wiki/concepts/ordering.md', { type: 'concept', status: 'approved', title: 'Ordering', summary: 'order states', created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-11T00:00:00Z', sources: ['raw:confluence/102'] }, 'body');
  writePage(kb, 'wiki/entities/pay-team.md', { type: 'entity', status: 'approved', title: 'Pay Team', summary: 'owners', created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z', kind: 'team', sources: ['raw:jira/PAY-1'] }, 'body');
  writePage(kb, 'wiki/sources/zzz.candidate.md', { type: 'source', status: 'candidate', title: 'Zzz', summary: 'zzz', created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z', source_ref: 'local/zzz', base: null, review_note: 'n' }, 'candidate body');
  writePage(kb, 'wiki/archive/gone.md', { type: 'source', status: 'archived', title: 'Gone', summary: 'gone', created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z', source_ref: 'local/gone' }, 'archived body');
  const r = runScript('govern.mjs', ['--kb', kb, 'rebuild-index']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json.counts, { sources: 2, syntheses: 1, concepts: 1, entities: 1 });
  const idx = read(join(kb, 'wiki/index.md'));
  assert.match(idx, /- \[\[pay-table-v3\|Pay Table v3\]\] — 7 tables \(confluence\/102, updated 2026-08-09\)/);
  assert.match(idx, /- \[\[payment\|Payment\]\] — cross-source narrative \(4 sources, updated 2026-08-12\)/);
  assert.match(idx, /- \[\[pay-team\|Pay Team\]\] — owners \(team, updated 2026-08-01\)/);
  assert.ok(!idx.includes('candidate'));
  assert.ok(!idx.includes('[[gone|'));
  // runs.jsonl got a completed line; commit message starts with 'govern: run '
  const runs = read(join(kb, '.kb/govern/runs.jsonl')).trim().split('\n').map(JSON.parse);
  assert.equal(runs.at(-1).status, 'completed');
  assert.deepEqual(runs.at(-1).stats, { sources: 2, syntheses: 1, concepts: 1, entities: 1 });
  assert.match(git(kb, 'log', '-1', '--format=%s'), /^govern: run /);
});

test('rebuild-index: non-git KB → warnings, exit 0, index still written', () => {
  const kb = makeKb(tmp());
  writePage(kb, 'wiki/concepts/c1.md', { ...PAGE_FM, type: 'concept', sources: [] }, 'body');
  const r = runScript('govern.mjs', ['--kb', kb, 'rebuild-index']);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(Array.isArray(r.json.warnings), `expected warnings, got: ${r.stdout}`);
  assert.equal(r.json.counts.concepts, 1);
  assert.ok(exists(join(kb, 'wiki/index.md')));
});

test('rebuild-index: KB nested in a larger repo stages only wiki/ + log.md (never unrelated user work, never run.lock)', () => {
  const outer = tmp();
  const kb = makeKb(join(outer, 'kb'));
  gitInit(outer); // the OUTER repo owns the KB directory
  writePage(kb, 'wiki/concepts/c1.md', { ...PAGE_FM, type: 'concept', sources: [] }, 'body');
  writeFileSync(join(outer, 'unrelated-user-work.txt'), 'do not commit me');
  const r = runScript('govern.mjs', ['--kb', kb, 'rebuild-index']);
  assert.equal(r.code, 0, r.stderr);
  const committed = git(outer, 'show', '--name-only', '--format=', 'HEAD');
  assert.ok(committed.includes('kb/wiki/index.md'));
  assert.ok(!committed.includes('unrelated-user-work.txt'));
  assert.ok(!committed.includes('run.lock'));
});

// ---- record-decision (verbatim from plan) ----
test('record-decision: human without reason rejected; agent requires cited flag; id allocates d-<yyyymmdd>-<seq3>', () => {
  const kb = makeKb(tmp());
  const bad = runScript('govern.mjs', ['--kb', kb, 'record-decision', '--actor', 'human', '--action', 'approve', '--page', 'wiki/sources/x.md']);
  assert.equal(bad.code, 64);
  const bad2 = runScript('govern.mjs', ['--kb', kb, 'record-decision', '--actor', 'agent', '--action', 'auto-approve', '--page', 'wiki/sources/x.md']);
  assert.equal(bad2.code, 64);
  const ok = runScript('govern.mjs', ['--kb', kb, 'record-decision', '--actor', 'human', '--action', 'approve', '--page', 'wiki/sources/x.md', '--reason', 'looks right']);
  assert.equal(ok.code, 0);
  const lines = read(join(kb, '.kb/govern/decisions.jsonl')).trim().split('\n').map(JSON.parse);
  const today = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  assert.equal(lines[0].id, `d-${today}-001`);
  assert.equal(lines[0].actor, 'human');
});

test('record-decision: seq increments; invalid action lists vocabulary; cited "" → []; corrupt line skipped + warning; log lines', () => {
  const kb = makeKb(tmp());
  const r1 = runScript('govern.mjs', ['--kb', kb, 'record-decision', '--actor', 'human', '--action', 'approve', '--page', 'wiki/sources/x.md', '--reason', 'first']);
  assert.equal(r1.code, 0, r1.stderr);
  assert.equal(r1.json.id, `d-${today()}-001`);
  assert.equal(r1.json.cited, undefined);
  // agent with --cited "" → cited: []
  const r2 = runScript('govern.mjs', ['--kb', kb, 'record-decision', '--actor', 'agent', '--action', 'auto-approve', '--page', 'wiki/sources/y.md', '--cited', '']);
  assert.equal(r2.code, 0, r2.stderr);
  assert.equal(r2.json.id, `d-${today()}-002`);
  assert.deepEqual(r2.json.cited, []);
  assert.equal(r2.json.reason, undefined);
  // invalid action → 64 listing the vocabulary
  const bad = runScript('govern.mjs', ['--kb', kb, 'record-decision', '--actor', 'human', '--action', 'nope', '--page', 'wiki/sources/x.md', '--reason', 'r']);
  assert.equal(bad.code, 64);
  assert.match(JSON.stringify(bad.json), /auto-approve/);
  // corrupt existing line → skipped with stderr warning, seq still allocated
  writeFileSync(join(kb, '.kb/govern/decisions.jsonl'), read(join(kb, '.kb/govern/decisions.jsonl')) + '{corrupt\n');
  const r3 = runScript('govern.mjs', ['--kb', kb, 'record-decision', '--actor', 'agent', '--action', 'keep-both', '--page', 'wiki/sources/z.md', '--cited', 'd-20260812-001,d-20260812-002']);
  assert.equal(r3.code, 0, r3.stderr);
  assert.match(r3.stderr, /unparseable|skipping/i);
  assert.equal(r3.json.id, `d-${today()}-003`);
  assert.deepEqual(r3.json.cited, ['d-20260812-001', 'd-20260812-002']);
  // log.md lines for both actors (§2.5 mapping)
  const log = read(join(kb, 'log.md'));
  assert.match(log, /review \| approve \| wiki\/sources\/x\.md \| first/);
  assert.match(log, /govern \| auto:auto-approve \| wiki\/sources\/y\.md \| cited=\[\]/);
});
