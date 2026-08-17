import test from 'node:test';
import assert from 'node:assert/strict';
import { runScript, makeKb, writeRaw, tmp, read, exists, join, writeFileSync } from './helpers.mjs';

// ---- local helpers (same shapes as govern.test.mjs) ----
function writePage(kb, rel, fm, body) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fm))
    lines.push(`${k}: ${v === null ? 'null' : Array.isArray(v) ? '[' + v.join(', ') + ']' : v}`);
  lines.push('---', '', body);
  writeFileSync(join(kb, rel), lines.join('\n'));
}
const RAW_FM = { source_url: 'https://x/1', source_version: '1', pulled_at: '2026-08-01T00:00:00Z', content_hash: 'sha256:aaaa' };
const PAGE_FM = { status: 'approved', title: 'T', summary: 's', created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z' };
const SYN_FM = { status: 'approved', title: 'S', summary: 's', created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z' };

// ---- fold (§4.1 step 4): mechanical serial fold executor ----

test('fold: new synthesis page created by first fold; serial union; log lines; stdout lists folded refs', () => {
  const kb = makeKb(tmp());
  writeRaw(kb, 'local', 'a', { ...RAW_FM }, 'body a');
  writeRaw(kb, 'local', 'b', { ...RAW_FM, source_url: 'https://x/2' }, 'body b');
  writePage(kb, 'wiki/sources/a.md', { ...PAGE_FM, type: 'source', source_ref: 'local/a' }, 'page a');
  writePage(kb, 'wiki/sources/b.md', { ...PAGE_FM, type: 'source', source_ref: 'local/b' }, 'page b');
  const foldsFile = join(kb, '.kb', 'govern', 'folds.json');
  writeFileSync(foldsFile, JSON.stringify([
    { ref: 'raw:local/a', paragraph: 'Alpha claim (raw:local/a).' },
    { ref: 'raw:local/b', paragraph: 'Beta claim (raw:local/b).' },
  ]));
  const r = runScript('govern.mjs', ['--kb', kb, 'fold', '--page', 'wiki/syntheses/payment.md', '--folds', foldsFile, '--title', 'Payment', '--summary', 'pay topic']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json.folded, ['raw:local/a', 'raw:local/b']);
  assert.deepEqual(r.json.skipped, []);
  const page = read(join(kb, 'wiki/syntheses/payment.md'));
  assert.match(page, /type: synthesis/);
  assert.match(page, /status: approved/);
  assert.match(page, /sources: \[raw:local\/a, raw:local\/b\]/);
  assert.match(page, /Alpha claim \(raw:local\/a\)\.\n\nBeta claim \(raw:local\/b\)\.\n\n## Open Questions/);
  assert.match(page, /- raw:local\/a — \[\[a\]\]\n- raw:local\/b — \[\[b\]\]/);
  const log = read(join(kb, 'log.md'));
  assert.match(log, /govern \| auto:apply \| wiki\/syntheses\/payment\.md \| fold 1\/2: \+raw:local\/a/);
  assert.match(log, /fold 2\/2: \+raw:local\/b/);
});

test('fold: gate failure stops the chain — last-good page stands, exit 1 names the failing fold', () => {
  const kb = makeKb(tmp());
  writeRaw(kb, 'local', 'a', { ...RAW_FM }, 'body a');
  writeRaw(kb, 'local', 'b', { ...RAW_FM, source_url: 'https://x/2' }, 'body b');
  writePage(kb, 'wiki/sources/a.md', { ...PAGE_FM, type: 'source', source_ref: 'local/a' }, 'page a');
  writePage(kb, 'wiki/sources/b.md', { ...PAGE_FM, type: 'source', source_ref: 'local/b' }, 'page b');
  const foldsFile = join(kb, '.kb', 'govern', 'folds.json');
  writeFileSync(foldsFile, JSON.stringify([
    { ref: 'raw:local/a', paragraph: 'Alpha claim (raw:local/a).' },
    { ref: 'raw:local/b', paragraph: 'Broken claim citing [[ghost-page]] (raw:local/b).' }, // dangling wikilink → validate fails
  ]));
  const r = runScript('govern.mjs', ['--kb', kb, 'fold', '--page', 'wiki/syntheses/payment.md', '--folds', foldsFile, '--title', 'Payment', '--summary', 'pay topic']);
  assert.equal(r.code, 1);
  assert.equal(r.json.error.code, 'fold-gate');
  assert.match(r.json.error.message, /fold 2\/2/);
  const page = read(join(kb, 'wiki/syntheses/payment.md'));
  assert.match(page, /sources: \[raw:local\/a\]/); // last-good = fold 1 only
  assert.doesNotMatch(page, /ghost-page|raw:local\/b/);
  const log = read(join(kb, 'log.md'));
  assert.doesNotMatch(log, /fold 2\/2/); // failed fold leaves no log line
});

test('fold: resume by structure — refs already in page.sources are skipped, rest fold', () => {
  const kb = makeKb(tmp());
  writeRaw(kb, 'local', 'a', { ...RAW_FM }, 'body a');
  writeRaw(kb, 'local', 'b', { ...RAW_FM, source_url: 'https://x/2' }, 'body b');
  writePage(kb, 'wiki/sources/a.md', { ...PAGE_FM, type: 'source', source_ref: 'local/a' }, 'page a');
  writePage(kb, 'wiki/sources/b.md', { ...PAGE_FM, type: 'source', source_ref: 'local/b' }, 'page b');
  writePage(kb, 'wiki/syntheses/payment.md', { ...SYN_FM, type: 'synthesis', sources: ['raw:local/a'] },
    '## Narrative\n\nAlpha claim (raw:local/a).\n\n## Open Questions\n\nNone.\n\n## Sources\n\n- raw:local/a — [[a]]\n');
  const foldsFile = join(kb, '.kb', 'govern', 'folds.json');
  writeFileSync(foldsFile, JSON.stringify([
    { ref: 'raw:local/a', paragraph: 'DUPLICATE should not land (raw:local/a).' },
    { ref: 'raw:local/b', paragraph: 'Beta claim (raw:local/b).' },
  ]));
  const r = runScript('govern.mjs', ['--kb', kb, 'fold', '--page', 'wiki/syntheses/payment.md', '--folds', foldsFile]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json.skipped, ['raw:local/a']);
  assert.deepEqual(r.json.folded, ['raw:local/b']);
  const page = read(join(kb, 'wiki/syntheses/payment.md'));
  assert.doesNotMatch(page, /DUPLICATE/);
  assert.match(page, /sources: \[raw:local\/a, raw:local\/b\]/);
  assert.match(page, /Beta claim \(raw:local\/b\)\.\n\n## Open Questions/);
});

test('fold: concept page without Open Questions anchor → paragraph + Sources appended at end; already-folded ref skipped', () => {
  const kb = makeKb(tmp());
  writeRaw(kb, 'local', 'a', { ...RAW_FM }, 'body a');
  writePage(kb, 'wiki/sources/a.md', { ...PAGE_FM, type: 'source', source_ref: 'local/a' }, 'page a');
  writePage(kb, 'wiki/concepts/state-machine.md', { ...PAGE_FM, type: 'concept', sources: ['raw:local/a'] }, 'Concept body.\n');
  const foldsFile = join(kb, '.kb', 'govern', 'folds.json');
  writeFileSync(foldsFile, JSON.stringify([{ ref: 'raw:local/a', paragraph: 'Extra detail (raw:local/a).' }]));
  const r = runScript('govern.mjs', ['--kb', kb, 'fold', '--page', 'wiki/concepts/state-machine.md', '--folds', foldsFile]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json.skipped, ['raw:local/a']); // already in sources → no body change
  // now a genuinely new ref on the same concept page
  writeRaw(kb, 'local', 'c', { ...RAW_FM, source_url: 'https://x/3' }, 'body c');
  writePage(kb, 'wiki/sources/c.md', { ...PAGE_FM, type: 'source', source_ref: 'local/c' }, 'page c');
  writeFileSync(foldsFile, JSON.stringify([{ ref: 'raw:local/c', paragraph: 'Extra detail (raw:local/c).' }]));
  const r2 = runScript('govern.mjs', ['--kb', kb, 'fold', '--page', 'wiki/concepts/state-machine.md', '--folds', foldsFile]);
  assert.equal(r2.code, 0, r2.stderr);
  const page = read(join(kb, 'wiki/concepts/state-machine.md'));
  assert.match(page, /Concept body\.\n\nExtra detail \(raw:local\/c\)\.\n\n## Sources\n\n- raw:local\/c — \[\[c\]\]\n$/);
});

test('fold: usage errors — bad --page shape, new page without title/summary, missing folds file, flag misplacement', () => {
  const kb = makeKb(tmp());
  const foldsFile = join(kb, '.kb', 'govern', 'folds.json');
  writeFileSync(foldsFile, '[]');
  const bad1 = runScript('govern.mjs', ['--kb', kb, 'fold', '--page', 'wiki/sources/x.md', '--folds', foldsFile]);
  assert.equal(bad1.code, 64); // sources pages do not fold
  const bad2 = runScript('govern.mjs', ['--kb', kb, 'fold', '--page', 'wiki/syntheses/new-one.md', '--folds', foldsFile]);
  assert.equal(bad2.code, 64); // new page requires --title/--summary
  const bad3 = runScript('govern.mjs', ['--kb', kb, 'fold', '--page', 'wiki/syntheses/new-one.md']);
  assert.equal(bad3.code, 64); // missing --folds
  const bad4 = runScript('govern.mjs', ['--kb', kb, 'plan', '--folds', foldsFile]);
  assert.equal(bad4.code, 64); // --folds only applies to fold
  const bad5 = runScript('govern.mjs', ['--kb', kb, 'fold', '--page', 'wiki/syntheses/new-one.md', '--folds', join(kb, 'nope.json'), '--title', 'T', '--summary', 's']);
  assert.equal(bad5.code, 1);
  assert.equal(bad5.json.error.code, 'folds-unreadable');
});

// ---- Tier 0.5 topic index (§7 scale envelope) ----

test('rebuild-index: >500 pages → wiki/topics.md written; registry corrupt → fail-closed', () => {
  const kb = makeKb(tmp());
  for (let i = 0; i < 501; i++) {
    const fm = { ...PAGE_FM, type: 'source', source_ref: `local/s${i}` };
    if (i === 0) fm.related_topics = ['Payment Flow'];
    if (i === 1) fm.related_topics = ['payment flow']; // normalizes to the same topic
    writePage(kb, `wiki/sources/s${i}.md`, fm, `body ${i}`);
  }
  writePage(kb, 'wiki/syntheses/payment-flow.md', { ...SYN_FM, type: 'synthesis', sources: ['raw:local/s0'] }, 'syn body');
  // fail-closed: corrupt registry refuses the topic index
  writeFileSync(join(kb, '.kb', 'govern', 'topic-registry.json'), '{corrupt');
  const bad = runScript('govern.mjs', ['--kb', kb, 'rebuild-index']);
  assert.equal(bad.code, 1);
  assert.equal(bad.json.error.code, 'corrupt-topic-registry');
  // valid registry → topics.md maps topic → pages
  writeFileSync(join(kb, '.kb', 'govern', 'topic-registry.json'),
    JSON.stringify({ topics: [{ topic: 'payment-flow', registered_at: '2026-08-01T00:00:00Z', synthesis: 'wiki/syntheses/payment-flow.md' }] }));
  const r = runScript('govern.mjs', ['--kb', kb, 'rebuild-index']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.topics_index, 'wiki/topics.md');
  const topics = read(join(kb, 'wiki', 'topics.md'));
  assert.match(topics, /# Topic Index/);
  assert.match(topics, /## payment-flow\n- \[\[payment-flow\|S\]\].*\(synthesis.*\)\n- \[\[s0\|T\]\].*\(source.*\)\n- \[\[s1\|T\]\]/);
  assert.match(read(join(kb, 'wiki', 'index.md')), /wiki\/topics\.md as Tier 0\.5/);
});

test('rebuild-index: ≤500 pages → no topics.md; pre-existing stale topics.md removed', () => {
  const kb = makeKb(tmp());
  writePage(kb, 'wiki/sources/a.md', { ...PAGE_FM, type: 'source', source_ref: 'local/a' }, 'page a');
  writeFileSync(join(kb, 'wiki', 'topics.md'), 'stale\n');
  const r = runScript('govern.mjs', ['--kb', kb, 'rebuild-index']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.topics_index, undefined);
  assert.equal(r.json.topics_index_removed, true);
  assert.ok(!exists(join(kb, 'wiki', 'topics.md')));
});
