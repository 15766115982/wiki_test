import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter, serializeFrontmatter, contentHash, splitFrontmatter, parseBoolFlag } from '../llm-wiki/scripts/validate.mjs';
import { runScript, makeKb, writeRaw, tmp, join, writeFileSync, read } from './helpers.mjs';

// ---------- pure: contentHash / frontmatter ----------

test('contentHash: version embedded, LF normalized, sha256: prefix, 64 hex', () => {
  const h = contentHash('v3', 'line1\r\nline2\r\n');
  assert.match(h, /^sha256:[0-9a-f]{64}$/);
  assert.equal(h, contentHash('v3', 'line1\nline2\n'));      // CRLF ≡ LF
  assert.notEqual(h, contentHash('v4', 'line1\nline2\n'));    // version in input
  assert.notEqual(h, contentHash('v3', 'line1\nline2\n '));   // trailing ws NOT touched
});

test('frontmatter round-trip: scalars, inline arrays, block arrays, relations', () => {
  const data = { type: 'entity', status: 'approved', title: 'Pay Team "Core"', sources: ['raw:jira/PROJ-1'],
    aliases: [], relations: [{ target: 'payment', type: 'owns' }], created_at: '2026-08-12T00:00:00Z', base: null };
  const text = serializeFrontmatter(data, '# Body\n');
  const { data: parsed, body } = splitFrontmatter(text);
  assert.deepEqual(parsed, data);
  assert.equal(body, '# Body\n');
});

test('parseFrontmatter rejects out-of-subset YAML (multiline, nested block maps)', () => {
  assert.throws(() => parseFrontmatter('---\ntitle: |\n  multi\n  line\n---\n'));
  assert.throws(() => parseFrontmatter('---\nmeta:\n  a: 1\n---\n'));
});

test('splitFrontmatter: no leading --- → data null, body = full text', () => {
  const { data, body } = splitFrontmatter('# Just markdown\n');
  assert.equal(data, null);
  assert.equal(body, '# Just markdown\n');
});

test('serialize quotes strings containing ": " or leading "#"', () => {
  const t = serializeFrontmatter({ a: 'x: y', b: '#hash' }, '');
  assert.match(t, /a: "x: y"/);
  assert.match(t, /b: "#hash"/);
  const { data } = splitFrontmatter(t);
  assert.deepEqual(data, { a: 'x: y', b: '#hash' });
});

test('parse accepts unicode/CJK values', () => {
  const data = parseFrontmatter('---\ntitle: 支付域\nsummary: 跨源主题叙事\n---\n');
  assert.deepEqual(data, { title: '支付域', summary: '跨源主题叙事' });
});

test('block array of scalars round-trip', () => {
  const src = '---\ntags:\n- alpha\n- beta\n---\nbody\n';
  const data = parseFrontmatter(src);
  assert.deepEqual(data, { tags: ['alpha', 'beta'] });
  const again = parseFrontmatter(serializeFrontmatter(data, 'body\n'));
  assert.deepEqual(again, data);
});

test('empty inline array round-trip', () => {
  const { data } = splitFrontmatter(serializeFrontmatter({ aliases: [] }, ''));
  assert.deepEqual(data, { aliases: [] });
});

test('parseBoolFlag: undefined/true/false only', () => {
  assert.equal(parseBoolFlag(undefined), true);
  assert.equal(parseBoolFlag('true'), true);
  assert.equal(parseBoolFlag('false'), false);
  assert.throws(() => parseBoolFlag('yes'));
  assert.throws(() => parseBoolFlag('1'));
});

// ---------- fixtures ----------

const FM = { source_url: 'u', source_version: '1', pulled_at: '2026-08-12T00:00:00Z' };

function makeValidKb() {
  const kb = makeKb(tmp());
  writeRaw(kb, 'jira', 'PROJ-1', { ...FM, content_hash: 'sha256:' + '1'.repeat(64), issue_type: 'Task' }, 'body A');
  writeRaw(kb, 'chat', 'conv-aaaa11111111', { source_url: 'llmwiki://chat/conv-aaaa11111111', source_version: '2026-08-12', pulled_at: '2026-08-12T00:00:00Z', content_hash: 'manual', evidence_class: 'transcript' },
    'Key point [T-1].\n\n## Appendix A — Transcript\n### T-1 (user, 2026-08-12T10:00:00Z)\nhello\n');
  writeFileSync(join(kb, 'wiki/sources/proj-1.md'), `---
type: source
status: approved
title: PROJ-1
summary: A Jira task
created_at: 2026-08-12T00:00:00Z
updated_at: 2026-08-12T00:00:00Z
source_ref: jira/PROJ-1
sources: [raw:jira/PROJ-1]
---
Summary body linking [[pay-team]].
`);
  writeFileSync(join(kb, 'wiki/entities/pay-team.md'), `---
type: entity
status: approved
title: Pay Team
summary: The payments team
created_at: 2026-08-12T00:00:00Z
updated_at: 2026-08-12T00:00:00Z
sources: [raw:jira/PROJ-1]
kind: team
---
Entity body.
`);
  return kb;
}

// ---------- govern mode ----------

test('govern mode: duplicate content_hash across two raws → 2 failures, manual exempt', () => {
  const kb = makeKb(tmp());
  writeRaw(kb, 'jira', 'PROJ-1', { ...FM, content_hash: 'sha256:' + 'a'.repeat(64), issue_type: 'Task' }, 'A');
  writeRaw(kb, 'confluence', '100', { ...FM, content_hash: 'sha256:' + 'a'.repeat(64) }, 'B');
  writeRaw(kb, 'local', 'notes', { ...FM, content_hash: 'manual' }, 'B');
  const r = runScript('validate.mjs', ['--kb', kb]);
  assert.equal(r.code, 1);
  const dups = r.json.failures.filter(f => f.check === 'hash-dup');
  assert.equal(dups.length, 2);
  assert.ok(dups.every(d => !d.file.includes('notes')));
});

test('govern frontmatter: missing contract fields listed; jira needs issue_type', () => {
  const kb = makeKb(tmp());
  writeRaw(kb, 'jira', 'PROJ-2', { source_url: 'u', pulled_at: '2026-08-12T00:00:00Z', content_hash: 'manual' }, 'B');
  const r = runScript('validate.mjs', ['--kb', kb]);
  assert.equal(r.code, 1);
  const f = r.json.failures.find(f => f.check === 'frontmatter');
  assert.ok(f, JSON.stringify(r.json.failures));
  assert.match(f.message, /source_version/);
  assert.match(f.message, /issue_type/);
});

test('govern frontmatter: unparseable frontmatter → failure mentioning unparseable', () => {
  const kb = makeKb(tmp());
  writeFileSync(join(kb, 'raw/local/broken.md'), '---\ntitle: |\n  multi\n  line\n---\nbody\n');
  const r = runScript('validate.mjs', ['--kb', kb]);
  assert.equal(r.code, 1);
  assert.ok(r.json.failures.some(f => f.check === 'frontmatter' && /unparseable/.test(f.message)));
});

test('source-id-whitelist: bad chars and filename mismatch flagged; valid passes', () => {
  const kb = makeKb(tmp());
  writeFileSync(join(kb, 'raw/local/bad id.md'), '---\nsource: local\nsource_id: bad id\nsource_url: u\nsource_version: 1\npulled_at: 2026-08-12T00:00:00Z\ncontent_hash: manual\n---\nB\n');
  writeFileSync(join(kb, 'raw/local/actual.md'), '---\nsource: local\nsource_id: other-id\nsource_url: u\nsource_version: 1\npulled_at: 2026-08-12T00:00:00Z\ncontent_hash: manual\n---\nB\n');
  writeRaw(kb, 'local', 'good-id', { ...FM, content_hash: 'manual' }, 'B');
  const r = runScript('validate.mjs', ['--kb', kb]);
  assert.equal(r.code, 1);
  const sw = r.json.failures.filter(f => f.check === 'source-id-whitelist');
  assert.ok(sw.some(f => f.file === 'raw/local/bad id.md'), JSON.stringify(sw));
  assert.ok(sw.some(f => f.file === 'raw/local/actual.md'));
  assert.ok(!sw.some(f => f.file.includes('good-id')));
});

test('refs: missing raw target, ghost wikilink, candidate-only wikilink all fail', () => {
  const kb = makeKb(tmp());
  writeRaw(kb, 'jira', 'PROJ-1', { ...FM, content_hash: 'manual', issue_type: 'Task' }, 'A');
  writeFileSync(join(kb, 'wiki/syntheses/payment.candidate.md'), `---
type: synthesis
status: candidate
title: Payment
summary: s
created_at: 2026-08-12T00:00:00Z
updated_at: 2026-08-12T00:00:00Z
sources: [raw:jira/PROJ-1]
base: null
review_note: new page
---
Body.
`);
  writeFileSync(join(kb, 'wiki/concepts/order-flow.md'), `---
type: concept
status: approved
title: Order Flow
summary: s
created_at: 2026-08-12T00:00:00Z
updated_at: 2026-08-12T00:00:00Z
sources: [raw:jira/NOPE-9]
---
Links [[ghost-page]] and [[payment|Payment]] (candidate only, not a resolution target).
`);
  const r = runScript('validate.mjs', ['--kb', kb]);
  assert.equal(r.code, 1);
  const refs = r.json.failures.filter(f => f.check === 'refs');
  assert.ok(refs.some(f => /raw:jira\/NOPE-9/.test(f.message)), JSON.stringify(refs));
  assert.ok(refs.some(f => /ghost-page/.test(f.message)));
  assert.ok(refs.some(f => /payment/.test(f.message)), 'candidate sidecar must not resolve wikilinks');
});

test('status-whitelist: page file status rejected fails; sidecar status approved fails; valid sidecar passes', () => {
  const kb = makeKb(tmp());
  writeRaw(kb, 'jira', 'PROJ-1', { ...FM, content_hash: 'manual', issue_type: 'Task' }, 'A');
  writeFileSync(join(kb, 'wiki/syntheses/payment.candidate.md'), `---
type: synthesis
status: candidate
title: Payment
summary: s
created_at: 2026-08-12T00:00:00Z
updated_at: 2026-08-12T00:00:00Z
sources: [raw:jira/PROJ-1]
base: null
review_note: ok
---
Body.
`);
  writeFileSync(join(kb, 'wiki/concepts/order-flow.md'), `---
type: concept
status: rejected
title: Order Flow
summary: s
created_at: 2026-08-12T00:00:00Z
updated_at: 2026-08-12T00:00:00Z
sources: [raw:jira/PROJ-1]
---
Body.
`);
  writeFileSync(join(kb, 'wiki/entities/pay-team.candidate.md'), `---
type: entity
status: approved
title: Pay Team
summary: s
created_at: 2026-08-12T00:00:00Z
updated_at: 2026-08-12T00:00:00Z
sources: [raw:jira/PROJ-1]
base: null
review_note: ok
---
Body.
`);
  const r = runScript('validate.mjs', ['--kb', kb]);
  assert.equal(r.code, 1);
  const sw = r.json.failures.filter(f => f.check === 'status-whitelist');
  assert.equal(sw.length, 2, JSON.stringify(sw));
  assert.ok(sw.some(f => f.file === 'wiki/concepts/order-flow.md'));
  assert.ok(sw.some(f => f.file === 'wiki/entities/pay-team.candidate.md'));
});

test('slug-whitelist: bad wiki filename slug flagged', () => {
  const kb = makeKb(tmp());
  writeRaw(kb, 'jira', 'PROJ-1', { ...FM, content_hash: 'manual', issue_type: 'Task' }, 'A');
  writeFileSync(join(kb, 'wiki/concepts/Bad_Slug.md'), `---
type: concept
status: approved
title: Bad
summary: s
created_at: 2026-08-12T00:00:00Z
updated_at: 2026-08-12T00:00:00Z
sources: [raw:jira/PROJ-1]
---
Body.
`);
  const r = runScript('validate.mjs', ['--kb', kb]);
  assert.equal(r.code, 1);
  assert.ok(r.json.failures.some(f => f.check === 'slug-whitelist' && f.file === 'wiki/concepts/Bad_Slug.md'));
});

test('sidecar-fields: candidate missing base/review_note fails; base: null with both keys passes', () => {
  const kb = makeKb(tmp());
  writeRaw(kb, 'jira', 'PROJ-1', { ...FM, content_hash: 'manual', issue_type: 'Task' }, 'A');
  writeFileSync(join(kb, 'wiki/syntheses/payment.candidate.md'), `---
type: synthesis
status: candidate
title: Payment
summary: s
created_at: 2026-08-12T00:00:00Z
updated_at: 2026-08-12T00:00:00Z
sources: [raw:jira/PROJ-1]
---
Body.
`);
  const r = runScript('validate.mjs', ['--kb', kb]);
  assert.equal(r.code, 1);
  const sf = r.json.failures.filter(f => f.check === 'sidecar-fields');
  assert.equal(sf.length, 1);
  assert.match(sf[0].message, /base/);
  assert.match(sf[0].message, /review_note/);
});

test('wiki-frontmatter: missing fields, non-source missing sources, source missing source_ref', () => {
  const kb = makeKb(tmp());
  writeRaw(kb, 'jira', 'PROJ-1', { ...FM, content_hash: 'manual', issue_type: 'Task' }, 'A');
  writeFileSync(join(kb, 'wiki/concepts/no-summary.md'), `---
type: concept
status: approved
title: X
created_at: 2026-08-12T00:00:00Z
updated_at: 2026-08-12T00:00:00Z
sources: [raw:jira/PROJ-1]
---
Body.
`);
  writeFileSync(join(kb, 'wiki/concepts/no-sources.md'), `---
type: concept
status: approved
title: Y
summary: s
created_at: 2026-08-12T00:00:00Z
updated_at: 2026-08-12T00:00:00Z
---
Body.
`);
  writeFileSync(join(kb, 'wiki/sources/no-ref.md'), `---
type: source
status: approved
title: Z
summary: s
created_at: 2026-08-12T00:00:00Z
updated_at: 2026-08-12T00:00:00Z
sources: [raw:jira/PROJ-1]
---
Body.
`);
  const r = runScript('validate.mjs', ['--kb', kb]);
  assert.equal(r.code, 1);
  const wf = r.json.failures.filter(f => f.check === 'wiki-frontmatter');
  assert.ok(wf.some(f => f.file === 'wiki/concepts/no-summary.md' && /summary/.test(f.message)), JSON.stringify(wf));
  assert.ok(wf.some(f => f.file === 'wiki/concepts/no-sources.md' && /sources/.test(f.message)));
  assert.ok(wf.some(f => f.file === 'wiki/sources/no-ref.md' && /source_ref/.test(f.message)));
});

test('whole valid KB → exit 0 {checked>0, passed:true, failures:[]}', () => {
  const kb = makeValidKb();
  const r = runScript('validate.mjs', ['--kb', kb]);
  assert.equal(r.code, 0, JSON.stringify(r.json) + r.stderr);
  assert.ok(r.json.checked > 0);
  assert.equal(r.json.passed, true);
  assert.deepEqual(r.json.failures, []);
});

// ---------- distill mode ----------

test('distill mode: [T-2] without appendix entry → failure; contiguous numbering enforced', () => {
  const kb = makeKb(tmp());
  writeRaw(kb, 'chat', 'conv-abcdef123456', { source_url: 'llmwiki://chat/conv-abcdef123456', source_version: '2026-08-12', pulled_at: '2026-08-12T00:00:00Z', content_hash: 'manual', evidence_class: 'transcript' },
    'Point one [T-1]. Point two [T-3].\n\n## Appendix A — Transcript\n### T-1 (user, 2026-08-12T10:00:00Z)\nhello\n');
  const r = runScript('validate.mjs', ['--kb', kb]);
  assert.equal(r.code, 1);
  assert.ok(r.json.failures.some(f => f.check === 'cite-resolve' && /T-3/.test(f.message)));
});

test('appendix-contiguous: T-1, T-3 entries → failure naming gap T-2', () => {
  const kb = makeKb(tmp());
  writeRaw(kb, 'chat', 'conv-gap00000001', { source_url: 'llmwiki://chat/conv-gap00000001', source_version: '2026-08-12', pulled_at: '2026-08-12T00:00:00Z', content_hash: 'manual', evidence_class: 'transcript' },
    'A [T-1]. B [T-3].\n\n## Appendix A — Transcript\n### T-1 (user, 2026-08-12T10:00:00Z)\none\n### T-3 (agent, 2026-08-12T10:01:00Z)\nthree\n');
  const r = runScript('validate.mjs', ['--kb', kb]);
  assert.equal(r.code, 1);
  assert.ok(r.json.failures.some(f => f.check === 'appendix-contiguous' && /T-2/.test(f.message)), JSON.stringify(r.json.failures));
});

test('no-frontmatter-in-body: second --- block in body → failure', () => {
  const kb = makeKb(tmp());
  writeRaw(kb, 'chat', 'conv-fm0000000001', { source_url: 'llmwiki://chat/conv-fm0000000001', source_version: '2026-08-12', pulled_at: '2026-08-12T00:00:00Z', content_hash: 'manual', evidence_class: 'transcript' },
    'Point [T-1].\n\n---\nevidence_class: transcript\n---\n\n## Appendix A — Transcript\n### T-1 (user, 2026-08-12T10:00:00Z)\nhi\n');
  const r = runScript('validate.mjs', ['--kb', kb]);
  assert.equal(r.code, 1);
  assert.ok(r.json.failures.some(f => f.check === 'no-frontmatter-in-body'), JSON.stringify(r.json.failures));
});

test('excerpt-substring: KB-local raw excerpt passes when substring, fails when not', () => {
  const kb = makeKb(tmp());
  writeRaw(kb, 'local', 'notes', { ...FM, content_hash: 'manual' }, 'alpha beta gamma evidence');
  writeRaw(kb, 'chat', 'conv-ex0000000001', { source_url: 'llmwiki://chat/conv-ex0000000001', source_version: '2026-08-12', pulled_at: '2026-08-12T00:00:00Z', content_hash: 'manual', evidence_class: 'transcript' },
    'Uses ref [R-1].\n\n## Appendix B — References\n### R-1 notes\nsource: raw/local/notes.md (pulled 2026-08-12T00:00:00Z)\nalpha beta gamma evidence\n');
  const ok = runScript('validate.mjs', ['--kb', kb]);
  assert.equal(ok.code, 0, JSON.stringify(ok.json.failures));

  const kb2 = makeKb(tmp());
  writeRaw(kb2, 'local', 'notes', { ...FM, content_hash: 'manual' }, 'alpha beta gamma evidence');
  writeRaw(kb2, 'chat', 'conv-ex0000000002', { source_url: 'llmwiki://chat/conv-ex0000000002', source_version: '2026-08-12', pulled_at: '2026-08-12T00:00:00Z', content_hash: 'manual', evidence_class: 'transcript' },
    'Uses ref [R-1].\n\n## Appendix B — References\n### R-1 notes\nsource: raw/local/notes.md (pulled 2026-08-12T00:00:00Z)\ndelta not present in the file\n');
  const bad = runScript('validate.mjs', ['--kb', kb2]);
  assert.equal(bad.code, 1);
  assert.ok(bad.json.failures.some(f => f.check === 'excerpt-substring'), JSON.stringify(bad.json.failures));
});

test('excerpt-substring: external-URL R entry is skipped (trust boundary)', () => {
  const kb = makeKb(tmp());
  writeRaw(kb, 'chat', 'conv-ext000000001', { source_url: 'llmwiki://chat/conv-ext000000001', source_version: '2026-08-12', pulled_at: '2026-08-12T00:00:00Z', content_hash: 'manual', evidence_class: 'transcript' },
    'Cites web [R-1].\n\n## Appendix B — References\n### R-1 web\nsource: https://example.com/page (pulled 2026-08-12T00:00:00Z)\nany excerpt text at all\n');
  const r = runScript('validate.mjs', ['--kb', kb]);
  assert.equal(r.code, 0, JSON.stringify(r.json.failures));
});

test('no-frontmatter-in-body: CRLF chat file with second --- block in body → failure', () => {
  const kb = makeKb(tmp());
  const fm = '---\r\nsource: chat\r\nsource_id: conv-crlf00000001\r\nsource_url: llmwiki://chat/conv-crlf00000001\r\nsource_version: 2026-08-12\r\npulled_at: 2026-08-12T00:00:00Z\r\ncontent_hash: manual\r\n---\r\n';
  const body = 'Point [T-1].\r\n\r\n---\r\nevidence_class: transcript\r\n---\r\n\r\n## Appendix A — Transcript\r\n### T-1 (user, 2026-08-12T10:00:00Z)\r\nhi\r\n';
  writeFileSync(join(kb, 'raw/chat/conv-crlf00000001.md'), fm + body);
  const r = runScript('validate.mjs', ['--kb', kb]);
  assert.equal(r.code, 1);
  assert.ok(r.json.failures.some(f => f.check === 'no-frontmatter-in-body'), JSON.stringify(r.json.failures));
});

test('default whole-KB: chat raw missing contract fields → frontmatter failure (§2.2 applies to chat)', () => {
  const kb = makeKb(tmp());
  writeRaw(kb, 'chat', 'conv-miss00000001', { source_url: 'llmwiki://chat/conv-miss00000001', content_hash: 'manual', evidence_class: 'transcript' },
    'Point [T-1].\n\n## Appendix A — Transcript\n### T-1 (user, 2026-08-12T10:00:00Z)\nhi\n');
  const r = runScript('validate.mjs', ['--kb', kb]);
  assert.equal(r.code, 1);
  const f = r.json.failures.find(f => f.check === 'frontmatter');
  assert.ok(f, JSON.stringify(r.json.failures));
  assert.equal(f.file, 'raw/chat/conv-miss00000001.md');
  assert.match(f.message, /source_version/);
  assert.match(f.message, /pulled_at/);
});

test('explicit --mode distill on chat file → distill set only, contract fields not checked', () => {
  const kb = makeKb(tmp());
  writeRaw(kb, 'chat', 'conv-miss00000002', { source_url: 'llmwiki://chat/conv-miss00000002', content_hash: 'manual', evidence_class: 'transcript' },
    'Point [T-1].\n\n## Appendix A — Transcript\n### T-1 (user, 2026-08-12T10:00:00Z)\nhi\n');
  const r = runScript('validate.mjs', ['--kb', kb, '--file', 'raw/chat/conv-miss00000002.md', '--mode', 'distill']);
  assert.equal(r.code, 0, JSON.stringify(r.json));
  assert.equal(r.json.checked, 1);
});

test('explicit --mode govern applies raw contract checks to chat files (no filtering out)', () => {
  const kb = makeKb(tmp());
  writeRaw(kb, 'chat', 'conv-miss00000003', { source_url: 'llmwiki://chat/conv-miss00000003', content_hash: 'manual', evidence_class: 'transcript' },
    'Point [T-1].\n\n## Appendix A — Transcript\n### T-1 (user, 2026-08-12T10:00:00Z)\nhi\n');
  const whole = runScript('validate.mjs', ['--kb', kb, '--mode', 'govern']);
  assert.equal(whole.code, 1);
  assert.ok(whole.json.failures.some(f => f.check === 'frontmatter' && f.file === 'raw/chat/conv-miss00000003.md'), JSON.stringify(whole.json));
  const single = runScript('validate.mjs', ['--kb', kb, '--file', 'raw/chat/conv-miss00000003.md', '--mode', 'govern']);
  assert.equal(single.code, 1);
  assert.ok(single.json.failures.some(f => f.check === 'frontmatter'));
});

// ---------- refusion-retention (§2.3 重融保持性护栏) ----------

const BASE_BODY = `Payment flow overview [[pay-team]] and [[order-flow]].
ERR_PAY_001 is raised on timeout.
The retry budget is 3 attempts.
\`pay_worker\` owns the queue.
See PROJ-1 for rollout plan.
SLA_TARGET is 200ms.
`;

function makeRefusionKb(sidecarBody, sidecarFm = '') {
  const kb = makeKb(tmp());
  writeRaw(kb, 'jira', 'PROJ-1', { ...FM, content_hash: 'manual', issue_type: 'Task' }, 'A');
  writeRaw(kb, 'confluence', '100', { ...FM, content_hash: 'manual' }, 'B');
  for (const [dir, slug, typ] of [['entities', 'pay-team', 'entity'], ['concepts', 'order-flow', 'concept']]) {
    writeFileSync(join(kb, `wiki/${dir}/${slug}.md`), `---
type: ${typ}
status: approved
title: ${slug}
summary: s
created_at: 2026-08-12T00:00:00Z
updated_at: 2026-08-12T00:00:00Z
sources: [raw:jira/PROJ-1]
---
Body.
`);
  }
  writeFileSync(join(kb, 'wiki/syntheses/payment.md'), `---
type: synthesis
status: approved
title: Payment
summary: s
created_at: 2026-08-12T00:00:00Z
updated_at: 2026-08-12T00:00:00Z
sources: [raw:jira/PROJ-1, raw:confluence/100]
---
${BASE_BODY}`);
  writeFileSync(join(kb, 'wiki/syntheses/payment.candidate.md'), `---
type: synthesis
status: candidate
title: Payment
summary: s
created_at: 2026-08-12T00:00:00Z
updated_at: 2026-08-12T00:00:00Z
sources: [raw:jira/PROJ-1, raw:confluence/100]
base: wiki/syntheses/payment.md
review_note: re-fusion proposal${sidecarFm}
---
${sidecarBody}`);
  return kb;
}

test('refusion-retention: sidecar retaining everything → pass (whole KB exit 0)', () => {
  const kb = makeRefusionKb(BASE_BODY + 'Additional merged detail.\n');
  const r = runScript('validate.mjs', ['--kb', kb]);
  assert.equal(r.code, 0, JSON.stringify(r.json.failures));
  assert.ok(!r.json.failures.some(f => f.check === 'refusion-retention'));
});

test('refusion-retention: dropped base wikilink → failure naming it', () => {
  const kb = makeRefusionKb(BASE_BODY.replace(' and [[order-flow]]', ''));
  const r = runScript('validate.mjs', ['--kb', kb]);
  assert.equal(r.code, 1);
  const f = r.json.failures.find(f => f.check === 'refusion-retention');
  assert.ok(f, JSON.stringify(r.json.failures));
  assert.match(f.message, /order-flow/);
});

test('refusion-retention: dropped base sources entry → failure naming it', () => {
  const kb = makeRefusionKb(BASE_BODY);
  // rewrite sidecar sources to drop raw:confluence/100
  const p = join(kb, 'wiki/syntheses/payment.candidate.md');
  writeFileSync(p, read(p).replace('sources: [raw:jira/PROJ-1, raw:confluence/100]', 'sources: [raw:jira/PROJ-1]'));
  const r = runScript('validate.mjs', ['--kb', kb]);
  assert.equal(r.code, 1);
  const f = r.json.failures.find(f => f.check === 'refusion-retention');
  assert.ok(f, JSON.stringify(r.json.failures));
  assert.match(f.message, /raw:confluence\/100/);
});

test('refusion-retention: >20% key-fact loss fails with ratio; exactly 20% passes', () => {
  // base has exactly 5 key-fact lines; dropping 2 → 0.40 > 0.2 → failure
  const drop2 = BASE_BODY.replace('The retry budget is 3 attempts.\n', '').replace('See PROJ-1 for rollout plan.\n', '');
  const bad = runScript('validate.mjs', ['--kb', makeRefusionKb(drop2)]);
  assert.equal(bad.code, 1);
  const f = bad.json.failures.find(f => f.check === 'refusion-retention');
  assert.ok(f, JSON.stringify(bad.json.failures));
  assert.match(f.message, /0\.40/);
  // dropping exactly 1 of 5 → 0.20, not > 0.2 → pass
  const drop1 = BASE_BODY.replace('See PROJ-1 for rollout plan.\n', '');
  const ok = runScript('validate.mjs', ['--kb', makeRefusionKb(drop1)]);
  assert.equal(ok.code, 0, JSON.stringify(ok.json.failures));
});

test('refusion-retention: base null (new-page candidate) → check skipped', () => {
  const kb = makeKb(tmp());
  writeRaw(kb, 'jira', 'PROJ-1', { ...FM, content_hash: 'manual', issue_type: 'Task' }, 'A');
  writeFileSync(join(kb, 'wiki/syntheses/payment.candidate.md'), `---
type: synthesis
status: candidate
title: Payment
summary: s
created_at: 2026-08-12T00:00:00Z
updated_at: 2026-08-12T00:00:00Z
sources: [raw:jira/PROJ-1]
base: null
review_note: new page
---
Brand new body with nothing to retain.
`);
  const r = runScript('validate.mjs', ['--kb', kb]);
  assert.equal(r.code, 0, JSON.stringify(r.json.failures));
  assert.ok(!r.json.failures.some(f => f.check === 'refusion-retention'));
});

test('refusion-retention e2e: KB whose only violation is a lossy sidecar exits 1', () => {
  const kb = makeRefusionKb(BASE_BODY.replace(' and [[order-flow]]', ''));
  const r = runScript('validate.mjs', ['--kb', kb]);
  assert.equal(r.code, 1);
  const fs = r.json.failures.filter(f => f.check === 'refusion-retention');
  assert.equal(fs.length, 1);
  assert.equal(fs[0].file, 'wiki/syntheses/payment.candidate.md');
});

// ---------- CLI edges ----------

test('--file outside raw/chat auto-selects govern; checked=1', () => {
  const kb = makeKb(tmp());
  writeRaw(kb, 'jira', 'PROJ-1', { ...FM, content_hash: 'manual', issue_type: 'Task' }, 'A');
  writeFileSync(join(kb, 'wiki/concepts/order-flow.md'), `---
type: concept
status: rejected
title: X
summary: s
created_at: 2026-08-12T00:00:00Z
updated_at: 2026-08-12T00:00:00Z
sources: [raw:jira/PROJ-1]
---
Body.
`);
  const r = runScript('validate.mjs', ['--kb', kb, '--file', 'wiki/concepts/order-flow.md']);
  assert.equal(r.code, 1);
  assert.equal(r.json.checked, 1);
  assert.ok(r.json.failures.some(f => f.check === 'status-whitelist'));
});

test('explicit --mode distill overrides location default', () => {
  const kb = makeKb(tmp());
  writeRaw(kb, 'jira', 'PROJ-2', { source_url: 'u', pulled_at: '2026-08-12T00:00:00Z', content_hash: 'manual' }, 'B');
  const govern = runScript('validate.mjs', ['--kb', kb, '--file', 'raw/jira/PROJ-2.md']);
  assert.equal(govern.code, 1); // govern: missing source_version + issue_type
  const distill = runScript('validate.mjs', ['--kb', kb, '--file', 'raw/jira/PROJ-2.md', '--mode', 'distill']);
  assert.equal(distill.code, 0, JSON.stringify(distill.json)); // distill checks: no markers → pass
});

test('usage errors exit 64: bad --mode, unknown flag, empty --kb=', () => {
  const kb = makeKb(tmp());
  assert.equal(runScript('validate.mjs', ['--kb', kb, '--mode', 'bogus']).code, 64);
  assert.equal(runScript('validate.mjs', ['--kb', kb, '--wat']).code, 64);
  assert.equal(runScript('validate.mjs', ['--kb=']).code, 64);
});

test('--file on a directory → clean JSON error, non-zero exit (no crash)', () => {
  const kb = makeValidKb();
  const r = runScript('validate.mjs', ['--kb', kb, '--file', 'raw/chat', '--mode', 'distill']);
  assert.notEqual(r.code, 0);
  assert.ok(r.json && r.json.error, `stdout not JSON: ${r.stdout}`);
  assert.match(r.stderr, /^$/); // no stack trace on stderr
});

test('--file escaping KB root → rejected with JSON error', () => {
  const kb = makeValidKb();
  const outside = tmp();
  writeFileSync(join(outside, 'escape.md'), '---\ntype: concept\n---\nx\n');
  const r = runScript('validate.mjs', ['--kb', kb, '--file', join(outside, 'escape.md')]);
  assert.notEqual(r.code, 0);
  assert.ok(r.json && r.json.error, `stdout not JSON: ${r.stdout}`);
  assert.match(r.json.error.message, /outside KB/);
});

test('contract_version newer than skill is accepted (§2.7/§9 forward compatibility)', () => {
  const kb = makeValidKb();
  writeFileSync(join(kb, 'kb.json'), JSON.stringify({ contract_version: 2, language: 'en' }, null, 2));
  const r = runScript('validate.mjs', ['--kb', kb]);
  assert.equal(r.code, 0, JSON.stringify(r.json) + r.stderr);
});

test('KB resolved from LLM_WIKI_KB env when --kb absent', () => {
  const kb = makeValidKb();
  const r = runScript('validate.mjs', [], { env: { ...process.env, LLM_WIKI_KB: kb } });
  assert.equal(r.code, 0, JSON.stringify(r.json) + r.stderr);
});

// ---------- slug-dup (plan errata 7: slugs are global across the four type dirs) ----------

const PAGE_FM = `status: approved
title: Dup
summary: s
created_at: 2026-08-12T00:00:00Z
updated_at: 2026-08-12T00:00:00Z
sources: []`;

test('slug-dup: same slug in two type dirs → one failure per file naming the collision (e2e exit 1)', () => {
  const kb = makeKb(tmp());
  writeFileSync(join(kb, 'wiki/concepts/dup.md'), `---\ntype: concept\n${PAGE_FM}\n---\nConcept body.\n`);
  writeFileSync(join(kb, 'wiki/entities/dup.md'), `---\ntype: entity\n${PAGE_FM}\n---\nEntity body.\n`);
  const r = runScript('validate.mjs', ['--kb', kb]);
  assert.equal(r.code, 1);
  const d = r.json.failures.filter(f => f.check === 'slug-dup');
  assert.equal(d.length, 2, JSON.stringify(r.json.failures));
  assert.ok(d.some(f => f.file === 'wiki/concepts/dup.md' && /wiki\/entities\/dup\.md/.test(f.message)));
  assert.ok(d.some(f => f.file === 'wiki/entities/dup.md' && /wiki\/concepts\/dup\.md/.test(f.message)));
  assert.equal(r.json.failures.length, 2, 'no other checks should fire');
});

test('slug-dup: page + its own same-dir sidecar is NOT a collision; cross-dir page/candidate is', () => {
  const kb = makeKb(tmp());
  writeFileSync(join(kb, 'wiki/concepts/alpha.md'), `---\ntype: concept\n${PAGE_FM}\n---\nAlpha body.\n`);
  writeFileSync(join(kb, 'wiki/concepts/alpha.candidate.md'), `---
type: concept
status: candidate
title: Alpha v2
summary: s
created_at: 2026-08-12T00:00:00Z
updated_at: 2026-08-12T00:00:00Z
sources: []
base: wiki/concepts/alpha.md
review_note: tweak
---
Alpha body.
`);
  // same slug, same dir (page + sidecar) → legitimate; no slug-dup expected for alpha
  let r = runScript('validate.mjs', ['--kb', kb]);
  assert.ok(!r.json.failures.some(f => f.check === 'slug-dup'), JSON.stringify(r.json.failures));
  // move the sidecar to another type dir → now a cross-dir collision
  writeFileSync(join(kb, 'wiki/entities/alpha.candidate.md'), read(join(kb, 'wiki/concepts/alpha.candidate.md'))
    .replace('base: wiki/concepts/alpha.md', 'base: null'));
  writeFileSync(join(kb, 'wiki/concepts/alpha.candidate.md'), read(join(kb, 'wiki/entities/alpha.candidate.md')));
  r = runScript('validate.mjs', ['--kb', kb]);
  const d = r.json.failures.filter(f => f.check === 'slug-dup');
  assert.ok(d.length >= 2, JSON.stringify(r.json.failures));
  assert.ok(d.some(f => f.file === 'wiki/entities/alpha.candidate.md'));
});

test('slug-dup negative: distinct slugs across dirs → whole KB exit 0', () => {
  const kb = makeValidKb();
  writeFileSync(join(kb, 'wiki/concepts/order-flow.md'), `---\ntype: concept\n${PAGE_FM}\n---\nBody linking [[pay-team]].\n`);
  writeFileSync(join(kb, 'wiki/entities/pay-core.md'), `---\ntype: entity\n${PAGE_FM}\n---\nBody linking [[pay-team]].\n`);
  const r = runScript('validate.mjs', ['--kb', kb]);
  assert.equal(r.code, 0, JSON.stringify(r.json.failures));
});
