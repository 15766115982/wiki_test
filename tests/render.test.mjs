import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { runScript, makeKb, writeRaw, tmp, read, exists, join } from './helpers.mjs';
import { lineDiff, renderMarkdown, escapeHtml, reportPathFor } from '../llm-wiki/scripts/render.mjs';
import { serializeFrontmatter } from '../llm-wiki/scripts/render.mjs';

// ---- local helpers ----
function writePage(kb, rel, fm, body) {
  const p = join(kb, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, serializeFrontmatter(fm, body));
  return p;
}
function writeJsonl(kb, rel, lines) {
  writeFileSync(join(kb, rel), lines.map(l => typeof l === 'string' ? l : JSON.stringify(l)).join('\n') + '\n');
}
function island(html) {
  const m = html.match(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/);
  assert.ok(m, 'data island missing');
  return JSON.parse(m[1]);
}
const FM_BASE = { type: 'concept', status: 'approved', title: 'T', summary: 's', created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z', sources: ['raw:local/notes'] };

// ================= Task 7: report =================

test('report: writes run-id html + latest.html; all dynamic content entity-escaped', () => {
  const kb = makeKb(tmp());
  // candidate sidecar with XSS payload in review_note & title; base page; decisions.jsonl history; last-plan.json
  const note = '"><script>alert(1)</script><img src=x onerror=alert(2)>';
  writePage(kb, 'wiki/concepts/evil.md', { ...FM_BASE, title: '"><script>alert(1)</script>' }, 'old body\n');
  writePage(kb, 'wiki/concepts/evil.candidate.md',
    { ...FM_BASE, status: 'candidate', title: '"><script>alert(1)</script>', base: 'wiki/concepts/evil.md', review_note: note }, 'new body\n');
  writeJsonl(kb, '.kb/govern/decisions.jsonl', [
    { id: 'd-20260801-001', ts: '2026-08-01T00:00:00Z', actor: 'human', action: 'approve', page: 'wiki/concepts/evil.candidate.md', reason: 'ok' },
  ]);
  writeFileSync(join(kb, '.kb/govern/last-plan.json'), JSON.stringify({
    ts: '2026-08-12T00:00:00Z', pending: [], anomalies: [], errors: [],
    review_queue: [{ candidate: 'wiki/concepts/evil.candidate.md', base: 'wiki/concepts/evil.md', review_note: note }],
    human_lists: [], suppressed: [],
  }));
  const r = runScript('render.mjs', ['--kb', kb, 'report']);
  assert.equal(r.code, 0);
  assert.ok(exists(join(kb, '.kb/govern/reports/latest.html')));
  const html = read(r.json.written);
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;') || html.includes('\\u003cscript'));
  assert.ok(!/fetch\s*\(|XMLHttpRequest|localStorage/.test(html));
});

test('report: latest.html identical to run-id file; stdout {written, candidates}; forward slashes', () => {
  const kb = makeKb(tmp());
  writePage(kb, 'wiki/concepts/a.candidate.md',
    { ...FM_BASE, status: 'candidate', base: null, review_note: 'new concept' }, 'body\n');
  const r = runScript('render.mjs', ['--kb', kb, 'report']);
  assert.equal(r.code, 0);
  assert.equal(r.json.candidates, 1);
  assert.match(r.json.written, /\/\.kb\/govern\/reports\/\d{8}T\d{6}\.html$/);
  assert.ok(!r.json.written.includes('\\'));
  assert.equal(read(r.json.written), read(join(kb, '.kb/govern/reports/latest.html')));
});

test('report: new-page candidate (base null) renders without crash and notes empty base', () => {
  const kb = makeKb(tmp());
  writePage(kb, 'wiki/concepts/brand-new.candidate.md',
    { ...FM_BASE, status: 'candidate', base: null, review_note: 'new page' }, 'line1\nline2\n');
  const r = runScript('render.mjs', ['--kb', kb, 'report']);
  assert.equal(r.code, 0);
  const data = island(read(r.json.written));
  assert.equal(data.cases.length, 1);
  const diffText = JSON.stringify(data.cases[0].diff);
  assert.match(diffText, /base/);
  assert.ok(data.cases[0].diff.some(([k, t]) => k === 'add' && t.includes('line1')));
});

test('report: conflict-prefixed review_note → conflict parties present in data island', () => {
  const kb = makeKb(tmp());
  writePage(kb, 'wiki/syntheses/payment.md', { ...FM_BASE, type: 'synthesis' }, 'old\n');
  const note = 'conflict: factual | parties: confluence/102 vs jira/PROJ-55';
  writePage(kb, 'wiki/syntheses/payment.candidate.md',
    { ...FM_BASE, type: 'synthesis', status: 'candidate', base: 'wiki/syntheses/payment.md',
      review_note: note }, 'new\n');
  writeFileSync(join(kb, '.kb/govern/last-plan.json'), JSON.stringify({
    ts: '2026-08-12T00:00:00Z', pending: [], anomalies: [], errors: [],
    review_queue: [{ candidate: 'wiki/syntheses/payment.candidate.md', base: 'wiki/syntheses/payment.md', review_note: note }],
    human_lists: [], suppressed: [],
  }));
  const r = runScript('render.mjs', ['--kb', kb, 'report']);
  assert.equal(r.code, 0);
  const data = island(read(r.json.written));
  const c = data.cases[0].conflict;
  assert.ok(c, 'conflict block expected');
  assert.equal(c.kind, 'factual');
  assert.deepEqual(c.parties.map(p => p.id), ['confluence/102', 'jira/PROJ-55']);
});

test('report: candidate whose page is in last-plan conflict-pair gets a conflict block', () => {
  const kb = makeKb(tmp());
  writePage(kb, 'wiki/sources/a.md', { type: 'source', status: 'approved', title: 'A', summary: 's', created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z', source_ref: 'local/a' }, 'A body\n');
  writePage(kb, 'wiki/sources/a.candidate.md',
    { type: 'source', status: 'candidate', title: 'A', summary: 's', created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z',
      source_ref: 'local/a', base: 'wiki/sources/a.md', review_note: 'update' }, 'A body v2\n');
  writeFileSync(join(kb, '.kb/govern/last-plan.json'), JSON.stringify({
    ts: '2026-08-12T00:00:00Z', pending: [], anomalies: [], errors: [],
    review_queue: [{ candidate: 'wiki/sources/a.candidate.md', base: 'wiki/sources/a.md', review_note: 'update' }],
    human_lists: [{ kind: 'conflict-pair', a: 'wiki/sources/a.md', b: 'wiki/sources/b.md', similarity: 0.72 }], suppressed: [],
  }));
  const r = runScript('render.mjs', ['--kb', kb, 'report']);
  assert.equal(r.code, 0);
  const data = island(read(r.json.written));
  const c = data.cases[0].conflict;
  assert.ok(c, 'conflict block from plan pair expected');
  assert.deepEqual(c.parties.map(p => p.id), ['wiki/sources/a.md', 'wiki/sources/b.md']);
  assert.equal(c.sim, '0.72');
});

test('report: reply contract strings present in template JS', () => {
  const kb = makeKb(tmp());
  const r = runScript('render.mjs', ['--kb', kb, 'report']);
  assert.equal(r.code, 0);
  const html = read(r.json.written);
  assert.ok(html.includes('decision: '));
  assert.ok(html.includes(' | page: '));
  assert.ok(html.includes(' | reason: '));
  assert.ok(html.includes(' | loser: '));
});

test('report: archive-loser reply emits loser BEFORE reason (free-text reason stays last, SKILL.md §4.2 extension)', () => {
  const kb = makeKb(tmp());
  const r = runScript('render.mjs', ['--kb', kb, 'report']);
  assert.equal(r.code, 0);
  const html = read(r.json.written);
  const m = html.match(/reply\.textContent = 'decision: ' \+ action \+ ' \| page: ' \+ c2\.path \+ '([^']+)' \+ sel\.value \+ '([^']+)' \+ reason/);
  assert.ok(m, 'archive-loser reply construction not found');
  assert.equal(m[1], ' | loser: ');
  assert.equal(m[2], ' | reason: ');
});

test('report: history filtered to the page; corrupt lines skipped with warning', () => {
  const kb = makeKb(tmp());
  writePage(kb, 'wiki/concepts/h.md', { ...FM_BASE }, 'v1\n');
  writePage(kb, 'wiki/concepts/h.candidate.md',
    { ...FM_BASE, status: 'candidate', base: 'wiki/concepts/h.md', review_note: 'update' }, 'v2\n');
  writeJsonl(kb, '.kb/govern/decisions.jsonl', [
    { id: 'd-1', ts: '2026-08-01T00:00:00Z', actor: 'human', action: 'approve', page: 'wiki/concepts/h.md', reason: 'first' },
    '{corrupt line',
    { id: 'd-2', ts: '2026-08-02T00:00:00Z', actor: 'human', action: 'reject', page: 'wiki/concepts/other.md', reason: 'unrelated' },
  ]);
  const r = runScript('render.mjs', ['--kb', kb, 'report']);
  assert.equal(r.code, 0);
  assert.match(r.stderr, /unparseable|skipping/i);
  const data = island(read(r.json.written));
  const hist = data.cases[0].hist;
  assert.equal(hist.length, 1);
  assert.match(hist[0], /approve/);
  assert.match(hist[0], /first/);
});

test('report: auto-approved count = decisions with action auto-approve since plan ts', () => {
  const kb = makeKb(tmp());
  writePage(kb, 'wiki/concepts/x.candidate.md',
    { ...FM_BASE, status: 'candidate', base: null, review_note: 'n' }, 'b\n');
  writeJsonl(kb, '.kb/govern/decisions.jsonl', [
    { id: 'd-1', ts: '2026-08-11T00:00:00Z', actor: 'agent', action: 'auto-approve', page: 'wiki/sources/old.md', cited: [] },
    { id: 'd-2', ts: '2026-08-12T01:00:00Z', actor: 'agent', action: 'auto-approve', page: 'wiki/sources/new.md', cited: [] },
    { id: 'd-3', ts: '2026-08-12T02:00:00Z', actor: 'human', action: 'approve', page: 'wiki/sources/other.md', reason: 'r' },
  ]);
  writeFileSync(join(kb, '.kb/govern/last-plan.json'), JSON.stringify({
    ts: '2026-08-12T00:00:00Z', pending: [], anomalies: [], errors: [], review_queue: [], human_lists: [], suppressed: [],
  }));
  const r = runScript('render.mjs', ['--kb', kb, 'report']);
  assert.equal(r.code, 0);
  const data = island(read(r.json.written));
  assert.equal(data.autoApproved, 1);
});

test('report: missing last-plan.json falls back to globbing sidecars', () => {
  const kb = makeKb(tmp());
  writePage(kb, 'wiki/concepts/f.candidate.md',
    { ...FM_BASE, status: 'candidate', base: null, review_note: 'fallback' }, 'b\n');
  const r = runScript('render.mjs', ['--kb', kb, 'report']);
  assert.equal(r.code, 0);
  const data = island(read(r.json.written));
  assert.equal(data.cases.length, 1);
  assert.equal(data.cases[0].note, 'fallback');
  assert.equal(data.autoApproved, 0);
});

test('report: provenance excerpts come from raw bodies (first 500 chars)', () => {
  const kb = makeKb(tmp());
  writeRaw(kb, 'local', 'notes', { source_url: 'u', source_version: '1', pulled_at: '2026-08-01T00:00:00Z', content_hash: 'manual' }, 'X'.repeat(600));
  writePage(kb, 'wiki/concepts/p.candidate.md',
    { ...FM_BASE, status: 'candidate', base: null, review_note: 'n' }, 'b\n');
  const r = runScript('render.mjs', ['--kb', kb, 'report']);
  assert.equal(r.code, 0);
  const data = island(read(r.json.written));
  assert.equal(data.cases[0].sources.length, 1);
  assert.equal(data.cases[0].sources[0].excerpt.length, 500);
});

test('report: run-id collision in the same second → -2, -3 suffixes, never overwrite', () => {
  const kb = makeKb(tmp());
  const dir = join(kb, '.kb/govern/reports');
  const now = new Date('2026-08-12T14:23:00.000Z');
  const p1 = reportPathFor(dir, now);
  assert.match(p1, /20260812T142300\.html$/);
  writeFileSync(p1, 'first');
  const p2 = reportPathFor(dir, now);
  assert.match(p2, /20260812T142300-2\.html$/);
  writeFileSync(p2, 'second');
  assert.match(reportPathFor(dir, now), /20260812T142300-3\.html$/);
  assert.equal(read(p1), 'first'); // never overwritten
  assert.equal(read(p2), 'second');
});

test('report: candidate whose base file is missing renders without crash', () => {
  const kb = makeKb(tmp());
  writePage(kb, 'wiki/concepts/orphan-cand.candidate.md',
    { ...FM_BASE, status: 'candidate', base: 'wiki/concepts/gone.md', review_note: 'base was deleted' }, 'v2\n');
  const r = runScript('render.mjs', ['--kb', kb, 'report']);
  assert.equal(r.code, 0);
  assert.equal(r.json.candidates, 1);
  const data = island(read(r.json.written));
  assert.ok(JSON.stringify(data.cases[0].diff).includes('gone.md'));
});

// ---- lineDiff unit tests ----

test('lineDiff: ctx/del/add runs from LCS', () => {
  const d = lineDiff('a\nb\nc\n', 'a\nx\nc\n');
  assert.deepEqual(d, [['ctx', ' a'], ['del', '- b'], ['add', '+ x'], ['ctx', ' c']]);
});

test('lineDiff: header line prepended when given; pure addition', () => {
  const d = lineDiff('a\n', 'a\nb\n', 'hdr');
  assert.deepEqual(d[0], ['h', 'hdr']);
  assert.deepEqual(d.slice(1), [['ctx', ' a'], ['add', '+ b']]);
});

test('lineDiff: empty base → all adds', () => {
  const d = lineDiff('', 'x\ny\n');
  assert.deepEqual(d, [['add', '+ x'], ['add', '+ y']]);
});

test('lineDiff: >2000 lines on either side → too-large note + bounded context', () => {
  const big = Array.from({ length: 2001 }, (_, i) => 'L' + i).join('\n');
  const d = lineDiff(big, big);
  assert.ok(d.some(([k, t]) => k === 'h' && /too large/i.test(t)));
  assert.ok(d.length <= 50, 'fallback output must be bounded');
});

// ================= Task 8: site =================

function siteKb() {
  const kb = makeKb(tmp());
  writeRaw(kb, 'jira', 'PROJ-1', { source_url: 'u', source_version: '1', pulled_at: '2026-08-01T00:00:00Z', content_hash: 'manual', issue_type: 'Task' }, 'jira body');
  writeRaw(kb, 'confluence', '102', { source_url: 'u', source_version: '2', pulled_at: '2026-08-01T00:00:00Z', content_hash: 'manual' }, 'conf body');
  writePage(kb, 'wiki/sources/proj-1.md',
    { type: 'source', status: 'approved', title: 'PROJ-1', summary: 'jira src', created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z', source_ref: 'jira/PROJ-1', tags: ['pay'] },
    'Body with <script>alert(1)</script> and [[payment]] and [bad](javascript:alert(1)) and [ok](https://example.com).\n');
  writePage(kb, 'wiki/sources/conf-102.md',
    { type: 'source', status: 'approved', title: 'Conf 102', summary: 'conf src', created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z', source_ref: 'confluence/102' },
    'Other body.\n');
  writePage(kb, 'wiki/syntheses/payment.md',
    { type: 'synthesis', status: 'approved', title: 'Payment', summary: 'syn', created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-02T00:00:00Z', sources: ['raw:jira/PROJ-1', 'raw:confluence/102'] },
    'Synthesis linking [[proj-1]] and [[conf-102]] and [[ghost]].\n');
  // excluded: candidate sidecar, archive, index.md
  writePage(kb, 'wiki/concepts/pending.candidate.md',
    { ...FM_BASE, status: 'candidate', base: null, review_note: 'n' }, 'cand\n');
  writePage(kb, 'wiki/archive/old.md', { ...FM_BASE, status: 'archived' }, 'arch\n');
  writeFileSync(join(kb, 'wiki/index.md'), '# Wiki Index\n\n- [[proj-1]] [[conf-102]] [[payment]]\n');
  writeJsonl(kb, '.kb/govern/decisions.jsonl', [
    { id: 'd-1', ts: '2026-08-02T00:00:00Z', actor: 'human', action: 'approve', page: 'wiki/syntheses/payment.md', reason: 'good' },
  ]);
  writeFileSync(join(kb, '.kb/govern/runs.jsonl'), JSON.stringify({ ts: '2026-08-02T01:00:00Z', status: 'completed', stats: { sources: 2 } }) + '\n');
  writeFileSync(join(kb, 'log.md'), '## [2026-08-02T00:30:00Z] govern | rebuild | wiki/index.md | done\n');
  return kb;
}

test('site: stdout {written:[path], pages, edges}; four view containers; no forbidden strings', () => {
  const kb = siteKb();
  const r = runScript('render.mjs', ['--kb', kb, 'site']);
  assert.equal(r.code, 0);
  assert.equal(r.json.pages, 3);
  assert.equal(r.json.written.length, 1);
  assert.match(r.json.written[0], /\/\.kb\/site\/index\.html$/);
  const html = read(r.json.written[0]);
  for (const v of ['view-browse', 'view-graph', 'view-history', 'view-overview'])
    assert.ok(html.includes(v), v + ' missing');
  assert.ok(!/fetch\s*\(|XMLHttpRequest|localStorage|sessionStorage/.test(html));
});

test('site: pages array excludes candidate/archive/index; approved only', () => {
  const kb = siteKb();
  const r = runScript('render.mjs', ['--kb', kb, 'site']);
  const data = island(read(r.json.written[0]));
  const slugs = data.pages.map(p => p.slug);
  assert.deepEqual(slugs.sort(), ['conf-102', 'payment', 'proj-1']);
  assert.ok(!slugs.includes('index'));
  assert.ok(!slugs.includes('pending'));
  assert.ok(!slugs.includes('old'));
  const src = data.pages.find(p => p.slug === 'proj-1');
  assert.equal(src.source, 'jira');
  assert.equal(src.issue_type, 'Task');
});

test('site: edges — link + provenance, no index.md participant, dedup', () => {
  const kb = siteKb();
  const r = runScript('render.mjs', ['--kb', kb, 'site']);
  const data = island(read(r.json.written[0]));
  assert.ok(data.edges.every(e => e.a !== 'index' && e.b !== 'index'));
  // provenance: source pages ↔ synthesis listing their raws
  assert.ok(data.edges.some(e => e.kind === 'provenance' && e.a === 'proj-1' && e.b === 'payment'));
  assert.ok(data.edges.some(e => e.kind === 'provenance' && e.a === 'conf-102' && e.b === 'payment'));
  // link edges from synthesis
  assert.ok(data.edges.some(e => e.kind === 'link' && e.a === 'payment' && e.b === 'proj-1'));
  // link edge from proj-1 → payment
  assert.ok(data.edges.some(e => e.kind === 'link' && e.a === 'proj-1' && e.b === 'payment'));
  // [[ghost]] must not produce an edge, but must appear in dangling health
  assert.ok(!data.edges.some(e => e.b === 'ghost'));
  assert.ok(data.health.dangling.some(d => d.page === 'payment' && d.target === 'ghost'));
  assert.equal(r.json.edges, data.edges.length);
});

test('site: body_html escapes raw HTML; non-whitelisted link scheme rendered as text', () => {
  const kb = siteKb();
  const r = runScript('render.mjs', ['--kb', kb, 'site']);
  const data = island(read(r.json.written[0]));
  const src = data.pages.find(p => p.slug === 'proj-1');
  assert.ok(src.body_html.includes('&lt;script&gt;'));
  assert.ok(!src.body_html.includes('<script>'));
  assert.ok(!src.body_html.includes('href="javascript:'));
  assert.ok(src.body_html.includes('javascript:alert(1)')); // kept as plain text
  assert.ok(src.body_html.includes('href="https://example.com"'));
  assert.ok(src.body_html.includes('href="#/page/payment"')); // wikilink → in-page anchor
});

test('site: graphMode adjacency when >500 pages', () => {
  const kb = makeKb(tmp());
  for (let i = 0; i < 501; i++) {
    const slug = 'p-' + String(i).padStart(3, '0');
    writePage(kb, 'wiki/concepts/' + slug + '.md',
      { type: 'concept', status: 'approved', title: slug, summary: 's', created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z', sources: [] },
      'tiny body\n');
  }
  const r = runScript('render.mjs', ['--kb', kb, 'site']);
  assert.equal(r.code, 0);
  assert.equal(r.json.pages, 501);
  const data = island(read(r.json.written[0]));
  assert.equal(data.graphMode, 'adjacency');
});

test('site: entity page frontmatter fully carried — relations, created_at, kind rendered in table', () => {
  const kb = makeKb(tmp());
  writePage(kb, 'wiki/entities/pay-team.md',
    { type: 'entity', status: 'approved', title: 'Pay Team', summary: 'owners', created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-02T00:00:00Z',
      sources: ['raw:local/notes'], kind: 'team', aliases: ['支付团队'], relations: [{ target: 'payment', type: 'owns' }, { target: 'order-sm', type: 'maintains' }] },
    'Team body.\n');
  const r = runScript('render.mjs', ['--kb', kb, 'site']);
  assert.equal(r.code, 0);
  const html = read(r.json.written[0]);
  const data = island(html);
  const e = data.pages.find(p => p.slug === 'pay-team');
  assert.deepEqual(e.relations, [{ target: 'payment', type: 'owns' }, { target: 'order-sm', type: 'maintains' }]);
  assert.equal(e.created_at, '2026-08-01T00:00:00Z');
  assert.deepEqual(e.aliases, ['支付团队']);
  assert.equal(e.kind, 'team');
  // template renders the rows (frontmatter table row labels present in the shipped JS)
  assert.ok(html.includes("row('relations'"));
  assert.ok(html.includes("row('created_at'"));
  assert.ok(html.includes("row('related_topics'"));
  assert.ok(html.includes("row('source_version'"));
});

test('site: graphMode force at ≤500 pages; history merges decisions + log; overview data present', () => {
  const kb = siteKb();
  const r = runScript('render.mjs', ['--kb', kb, 'site']);
  const data = island(read(r.json.written[0]));
  assert.equal(data.graphMode, 'force');
  assert.equal(data.decisions.length, 1);
  assert.ok(data.log.some(l => l.includes('rebuild')));
  assert.equal(data.runs.length, 1);
  assert.ok(Array.isArray(data.health.orphans));
});

test('site: zero pages → renders, graphMode force, empty collections', () => {
  const kb = makeKb(tmp());
  const r = runScript('render.mjs', ['--kb', kb, 'site']);
  assert.equal(r.code, 0);
  assert.equal(r.json.pages, 0);
  assert.equal(r.json.edges, 0);
  const data = island(read(r.json.written[0]));
  assert.equal(data.graphMode, 'force');
  assert.deepEqual(data.pages, []);
  assert.deepEqual(data.health, { orphans: [], dangling: [] });
});

// ---- renderMarkdown unit tests ----

test('renderMarkdown: headings, bold, em, inline code, paragraphs', () => {
  const html = renderMarkdown('# H1\n\n## H2\n\nPara with **bold** and *em* and `code`.\n');
  assert.ok(html.includes('<h1>H1</h1>'));
  assert.ok(html.includes('<h2>H2</h2>'));
  assert.ok(html.includes('<strong>bold</strong>'));
  assert.ok(html.includes('<em>em</em>'));
  assert.ok(html.includes('<code>code</code>'));
  assert.ok(html.includes('<p>'));
});

test('renderMarkdown: unordered + ordered lists', () => {
  const html = renderMarkdown('- a\n- b\n\n1. x\n2. y\n');
  assert.ok(html.includes('<ul>'));
  assert.ok(html.includes('<li>a</li>'));
  assert.ok(html.includes('<li>b</li>'));
  assert.ok(html.includes('</ul>'));
  assert.ok(html.includes('<ol>'));
  assert.ok(html.includes('<li>x</li>'));
  assert.ok(html.includes('<li>y</li>'));
  assert.ok(html.includes('</ol>'));
});

test('renderMarkdown: fenced code block escapes contents, no inline processing', () => {
  const html = renderMarkdown('```js\nif (a < b) **x**\n```\n');
  assert.ok(html.includes('<pre><code>if (a &lt; b) **x**</code></pre>'));
});

test('renderMarkdown: escape-first — raw HTML never passes through', () => {
  const html = renderMarkdown('text <img src=x onerror=alert(1)> **b**\n');
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img'));
});

test('renderMarkdown: link scheme whitelist http/https/file; others plain text', () => {
  const html = renderMarkdown('[a](https://x) [b](http://y) [c](file:///z) [d](javascript:alert(1)) [e](data:text/html,x)\n');
  assert.ok(html.includes('<a href="https://x"'));
  assert.ok(html.includes('<a href="http://y"'));
  assert.ok(html.includes('<a href="file:///z"'));
  assert.ok(!html.includes('href="javascript:'));
  assert.ok(!html.includes('href="data:'));
  assert.ok(html.includes('[d](javascript:alert(1))'));
});

test('renderMarkdown: wikilinks [[slug]] and [[slug|display]] → in-page anchors', () => {
  const html = renderMarkdown('see [[payment]] and [[order-sm|Order SM]]\n');
  assert.ok(html.includes('<a href="#/page/payment">payment</a>'));
  assert.ok(html.includes('<a href="#/page/order-sm">Order SM</a>'));
});

test('renderMarkdown: pipe table → simple table', () => {
  const html = renderMarkdown('| H1 | H2 |\n| --- | --- |\n| a | b |\n');
  assert.ok(html.includes('<table>'));
  assert.ok(html.includes('<th>H1</th>'));
  assert.ok(html.includes('<td>b</td>'));
});

test('renderMarkdown: wikilink with anchor strips anchor, keeps display ([[slug#sec|display]])', () => {
  const html = renderMarkdown('see [[payment#存储|支付域]] and [[order-sm#定义]]\n');
  assert.ok(html.includes('<a href="#/page/payment">支付域</a>'));
  assert.ok(html.includes('<a href="#/page/order-sm">order-sm</a>'));
  assert.ok(!html.includes('#/page/payment#'));
});

test('renderMarkdown: unclosed fenced block still renders as code to EOF', () => {
  const html = renderMarkdown('```js\nconst a = 1 < 2;\n');
  assert.ok(html.includes('<pre><code>const a = 1 &lt; 2;</code></pre>'));
});

test('renderMarkdown: false-positive table guard — `| foo` + `---` is not a table; real table still renders', () => {
  const notTable = renderMarkdown('| foo\n---\nnext\n');
  assert.ok(!notTable.includes('<table>'));
  assert.ok(notTable.includes('<p>'));
  const real = renderMarkdown('| H1 | H2 |\n| --- | --- |\n| a | b |\n');
  assert.ok(real.includes('<table>'));
  assert.ok(real.includes('<th>H1</th>'));
});

test('escapeHtml: all five entities', () => {
  assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
});

// ---- CLI edges ----

test('render: unknown subcommand → exit 64', () => {
  const kb = makeKb(tmp());
  const r = runScript('render.mjs', ['--kb', kb, 'bogus']);
  assert.equal(r.code, 64);
  assert.match(r.json.error.hint, /report\|site/);
});
