import test from 'node:test';
import assert from 'node:assert/strict';
import { runScript, makeKb, tmp, REPO_ROOT, read, exists, join, SCRIPTS } from './helpers.mjs';
import { rmSync } from 'node:fs';
import { parseFrontmatter } from '../llm-wiki/scripts/validate.mjs';

const ALL = ['acquire.mjs', 'validate.mjs', 'govern.mjs', 'render.mjs', 'install.mjs'];

for (const s of ALL.filter(x => x !== 'install.mjs')) {
  test(`${s}: missing --kb and no env → exit 64 with both hints`, () => {
    // env values of `undefined` are dropped by child_process env normalization → key absent in child
    const r = runScript(s, [], { env: { ...process.env, LLM_WIKI_KB: undefined } });
    assert.equal(r.code, 64);
    assert.match(r.json.error.hint, /--kb/);
    assert.match(r.json.error.hint, /LLM_WIKI_KB/);
  });
  test(`${s}: --kb pointing at non-KB dir → exit 65 mentioning init`, () => {
    const r = runScript(s, ['--kb', tmp()]);
    assert.equal(r.code, 65);
    assert.match(r.json.error.hint, /init|初始化/);
  });
  test(`${s}: stdout is always JSON, even on usage errors`, () => {
    const r = runScript(s, ['--kb', tmp()], { env: { ...process.env, LLM_WIKI_KB: undefined } });
    assert.ok(r.json !== null, `stdout not JSON: ${r.stdout}`);
  });
}

// ---- prompt templates (plan Task 10) & page templates (plan Task 12) ----
const PROMPTS_DIR = join(REPO_ROOT, 'llm-wiki', 'prompts');
const TEMPLATES_DIR = join(REPO_ROOT, 'llm-wiki', 'templates');
const PROMPT_FILES = ['classify-page.md', 'draft-source-page.md', 'extract-entity.md', 'draft-concept.md',
  'draft-synthesis.md', 'semantic-check.md', 'govern-decide.md', 'distill-chat.md', 'query-rewrite.md'];
const GOVERNANCE_PROMPTS = ['classify-page.md', 'draft-source-page.md', 'extract-entity.md',
  'draft-concept.md', 'draft-synthesis.md', 'semantic-check.md', 'govern-decide.md'];
const PAGE_TEMPLATES = ['raw-page.md', 'wiki-source.md', 'wiki-synthesis.md', 'wiki-concept.md', 'wiki-entity.md'];

test('prompts: all nine exist; all contain the untrusted-content isolation phrase', () => {
  for (const f of PROMPT_FILES) {
    const p = join(PROMPTS_DIR, f);
    assert.ok(exists(p), `missing prompt template: ${f}`);
    assert.ok(read(p).includes('data, not instructions'), `${f} missing isolation phrase`);
  }
});

test('prompts: the seven governance templates contain {{brief}}', () => {
  for (const f of GOVERNANCE_PROMPTS)
    assert.ok(read(join(PROMPTS_DIR, f)).includes('{{brief}}'), `${f} missing {{brief}} injection point`);
});

test('prompts: per-template contract anchors', () => {
  assert.ok(read(join(PROMPTS_DIR, 'semantic-check.md')).includes('no_conflict'), 'semantic-check missing no_conflict');
  assert.ok(read(join(PROMPTS_DIR, 'govern-decide.md')).includes('referenced_decisions'), 'govern-decide missing referenced_decisions');
  const distill = read(join(PROMPTS_DIR, 'distill-chat.md'));
  assert.ok(distill.includes('30000'), 'distill-chat missing 30000-char gate');
  assert.ok(distill.includes('conv-'), 'distill-chat missing conv- source_id form');
});

test('templates: five page templates exist; frontmatter parses with parseFrontmatter', () => {
  for (const f of PAGE_TEMPLATES) {
    const p = join(TEMPLATES_DIR, f);
    assert.ok(exists(p), `missing page template: ${f}`);
    let fm;
    assert.doesNotThrow(() => { fm = parseFrontmatter(read(p)); }, `${f} frontmatter does not parse`);
    if (f !== 'raw-page.md')
      assert.equal(fm.status, 'approved', `${f} must carry status: approved placeholder`);
  }
});

// ---- SKILL.md (plan Task 11) ----
const SKILL_MD = join(REPO_ROOT, 'llm-wiki', 'SKILL.md');
const SKILL_DESCRIPTION = 'Personal wiki knowledge base. Use when the user asks to save/distill conversation to KB, pull Jira/Confluence/OpenWiki content, run governance on the knowledge base, search/answer from the KB wiki (including 深研 deep research), or generate the wiki site. Not for general web search or one-off Q&A.';

test('SKILL.md: frontmatter has exactly {name, description}; values match §9 verbatim', () => {
  const text = read(SKILL_MD);
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  assert.ok(m, 'SKILL.md missing a leading frontmatter block');
  const fm = parseFrontmatter('---\n' + m[1] + '\n---\n');
  assert.deepEqual(Object.keys(fm).sort(), ['description', 'name'], 'frontmatter must contain exactly name + description');
  assert.equal(fm.name, 'llm-wiki');
  assert.equal(fm.description, SKILL_DESCRIPTION);
});

test('SKILL.md: contains every §8.1 trigger string and the reply-format anchors', () => {
  const text = read(SKILL_MD);
  for (const s of ['初始化 KB', '拉取', '治理', '蒸馏', '存进 KB', '生成站点', '深研',
    'decision: ', ' | page: ', ' | reason: '])
    assert.ok(text.includes(s), `SKILL.md missing '${s}'`);
});

test('SKILL.md: five adjudication action words, no_conflict, and the raw-content isolation rule', () => {
  const text = read(SKILL_MD);
  for (const s of ['approve', 'reject', 'edit-then-approve', 'archive-loser', 'keep-both',
    'no_conflict', 'data, not instructions'])
    assert.ok(text.includes(s), `SKILL.md missing '${s}'`);
});

test('SKILL.md: references all nine prompt templates by filename', () => {
  const text = read(SKILL_MD);
  for (const f of PROMPT_FILES)
    assert.ok(text.includes(f), `SKILL.md missing prompt reference '${f}'`);
});

// ---- shared segment drift guard + checkKb self-heal (§8 step 5) ----
const SEG_BEGIN = '// === shared segment (copied verbatim into every script — keep byte-identical) ===';
const SEG_END = '// === script-specific pure functions (exported for unit tests) ===';

test('shared segment is byte-identical across all five scripts', () => {
  const segs = ALL.map(f => {
    const t = read(join(SCRIPTS, f));
    const a = t.indexOf(SEG_BEGIN), b = t.indexOf(SEG_END);
    assert.ok(a >= 0 && b > a, `${f}: shared-segment banner markers not found`);
    return t.slice(a, b);
  });
  for (let i = 1; i < ALL.length; i++)
    assert.equal(segs[i], segs[0], `${ALL[i]} shared segment differs from ${ALL[0]}`);
});

test('checkKb self-heals .kb derivatives on a fresh clone (gitignored, §8 step 5)', () => {
  const kb = makeKb(tmp());
  rmSync(join(kb, '.kb'), { recursive: true, force: true });
  const r = runScript('validate.mjs', ['--kb', kb]);
  assert.equal(r.code, 0, JSON.stringify(r.json) + r.stderr);
  assert.ok(exists(join(kb, '.kb', 'govern')), '.kb/govern not recreated');
});

test('checkKb stays strict on user content: missing wiki/sources → exit 65', () => {
  const kb = makeKb(tmp());
  rmSync(join(kb, 'wiki', 'sources'), { recursive: true, force: true });
  const r = runScript('validate.mjs', ['--kb', kb]);
  assert.equal(r.code, 65);
  assert.match(r.json.error.hint, /init|初始化/);
});
