#!/usr/bin/env node
// === imports (node builtins only) ===
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, appendFileSync, readdirSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

// === shared segment (copied verbatim into every script — keep byte-identical) ===

// ---- shared: constants ----
const EXIT = { OK: 0, FAIL: 1, USAGE: 64, CONTRACT: 65 };
const CONTRACT_VERSION = 1;
const SOURCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const RAW_SOURCES = ['jira', 'confluence', 'chat', 'local', 'openwiki'];
const PAGE_TYPES = ['source', 'synthesis', 'concept', 'entity'];
const PAGE_STATUSES = ['candidate', 'approved', 'rejected', 'archived'];
const DECISION_ACTIONS = ['approve', 'reject', 'edit-then-approve', 'archive-loser', 'keep-both', 'auto-approve'];

// ---- shared: stdout JSON / stderr human text ----
function out(obj) { process.stdout.write(JSON.stringify(obj, null, 2) + '\n'); }
function warn(msg) { process.stderr.write(String(msg) + '\n'); }
function fail(code, message, hint) { out({ error: { code, message, hint } }); return code === 64 ? EXIT.USAGE : code === 65 ? EXIT.CONTRACT : EXIT.FAIL; }

// ---- shared: KB path resolution & validation (§1.4) ----
function resolveKb(kbArg, env = process.env) {
  const kb = kbArg || env.LLM_WIKI_KB;
  if (!kb) return { error: 'no KB path given', hint: 'Pass --kb <path> or set the LLM_WIKI_KB environment variable. Windows: setx LLM_WIKI_KB "C:\\path\\to\\kb" — macOS/Linux: export LLM_WIKI_KB=~/kb' };
  return { kb: resolve(kb) };
}
function checkKb(kbDir) {
  const hint = (what) => `Not a valid KB at '${kbDir}': ${what}. Initialize a KB first — tell the agent "初始化 KB" (init).`;
  const kbJsonPath = join(kbDir, 'kb.json');
  if (!existsSync(kbJsonPath)) return { error: 'kb.json missing', hint: hint('kb.json is missing') };
  let kbJson;
  try { kbJson = JSON.parse(readFileSync(kbJsonPath, 'utf8')); }
  catch { return { error: 'kb.json unparseable', hint: hint('kb.json is not valid JSON') }; }
  if (!Number.isInteger(kbJson.contract_version)) return { error: 'contract_version invalid', hint: hint('kb.json lacks an integer contract_version') };
  // §2.7: skill CONTRACT_VERSION must be ≤ KB-declared version; a NEWER KB is the designed
  // forward-compatible case (§9: KB contract changes are incrementally compatible) — do NOT reject it.
  if (CONTRACT_VERSION > kbJson.contract_version) return { error: 'contract version mismatch', hint: `This skill implements KB contract v${CONTRACT_VERSION}, but the KB declares v${kbJson.contract_version}. Migrate the KB per the CHANGELOG migration notes (破坏性变更迁移说明).` };
  if (kbJson.language !== undefined && !['en', 'zh'].includes(kbJson.language)) return { error: 'invalid language', hint: hint('kb.json language must be "en" or "zh"') };
  const required = ['raw', 'wiki/sources', 'wiki/syntheses', 'wiki/concepts', 'wiki/entities', 'wiki/archive'];
  const missing = required.filter(d => !existsSync(join(kbDir, d)));
  if (missing.length) return { error: 'missing directories', hint: hint(`missing directories: ${missing.join(', ')}`) };
  // .kb/* are gitignored derivatives — self-heal on clone (§8 step 5)
  for (const d of ['.kb/govern', '.kb/govern/reports', '.kb/site']) mkdirSync(join(kbDir, d), { recursive: true });
  return { kbJson };
}

// ---- shared: frontmatter (canonical subset of YAML) ----
function splitTopLevel(s) { // split on top-level commas, respecting quotes and {}[] nesting
  const parts = []; let cur = ''; let depth = 0; let inQ = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) { cur += c; if (c === '\\') { cur += s[i + 1] ?? ''; i++; } else if (c === '"') inQ = false; continue; }
    if (c === '"') inQ = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    else if (c === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  return parts;
}
function parseQuoted(s) { // double-quoted string; only \" and \\ escapes
  let res = '';
  for (let i = 1; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      const n = s[i + 1];
      if (n === '"') { res += '"'; i++; }
      else if (n === '\\') { res += '\\'; i++; }
      else throw new Error(`unsupported escape \\${n ?? ''}`);
    } else if (c === '"') {
      if (i !== s.length - 1) throw new Error('trailing characters after closing quote');
      return res;
    } else res += c;
  }
  throw new Error('unterminated quoted string');
}
function parseScalar(s) {
  if (s === 'null') return null;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (s.startsWith('"')) return parseQuoted(s);
  if (s[0] === '|' || s[0] === '>') throw new Error('multi-line strings not supported');
  if (s[0] === '{' || s[0] === '[') throw new Error('unexpected flow collection here');
  return s;
}
function parseInlineMap(s) {
  if (!s.endsWith('}')) throw new Error('unterminated inline map');
  const inner = s.slice(1, -1).trim();
  if (inner === '') return {};
  const obj = {};
  for (const part of splitTopLevel(inner)) {
    const m = part.trim().match(/^([A-Za-z0-9_-]+): (.*)$/);
    if (!m) throw new Error(`unsupported inline map entry: ${part.trim()}`);
    obj[m[1]] = parseScalar(m[2].trim());
  }
  return obj;
}
function parseValue(s) {
  if (s.startsWith('[')) {
    if (!s.endsWith(']')) throw new Error('unterminated inline array');
    const inner = s.slice(1, -1).trim();
    if (inner === '') return [];
    return splitTopLevel(inner).map(item => {
      const t = item.trim();
      return t.startsWith('{') ? parseInlineMap(t) : parseScalar(t);
    });
  }
  return parseScalar(s);
}
function parseFrontmatter(text) { // throws Error on anything outside the subset
  const lines = String(text).split('\n');
  if (lines[0] !== '---' && lines[0] !== '---\r') throw new Error('missing opening ---');
  const data = {};
  let pending = null; // key awaiting block-array items (or implicit null)
  for (let i = 1; i < lines.length; i++) {
    let line = lines[i];
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line === '---') {
      if (pending !== null && !(pending in data)) data[pending] = null;
      return data;
    }
    if (line === '') continue;
    if (line.startsWith('- ')) {
      if (pending === null) throw new Error(`block array item without a key: ${line}`);
      if (!Array.isArray(data[pending])) data[pending] = [];
      data[pending].push(parseScalar(line.slice(2)));
      continue;
    }
    if (/^\s/.test(line)) throw new Error(`indented content not supported (nested block maps / multi-line strings): ${line}`);
    const m = line.match(/^([A-Za-z0-9_-]+):(?: (.*))?$/);
    if (!m) throw new Error(`unsupported frontmatter line: ${line}`);
    if (pending !== null && !(pending in data)) data[pending] = null;
    if (m[2] === undefined) { pending = m[1]; }
    else { data[m[1]] = parseValue(m[2]); pending = null; }
  }
  throw new Error('missing closing ---');
}
function needsQuote(s) {
  return s === '' || s !== s.trim() || s.includes(': ') || s.includes('#') || s.includes('"') || s.includes('\\')
    || s === 'null' || /^-?\d+$/.test(s) || s.startsWith('- ') || /^[\[\]{}|>@&*!,%`'?]/.test(s);
}
function serializeScalar(v) {
  if (v === null) return 'null';
  if (typeof v === 'number') return String(v);
  const s = String(v);
  return needsQuote(s) ? '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"' : s;
}
function serializeFrontmatter(data, body) { // canonical emit; round-trips with parse
  let s = '---\n';
  for (const [k, v] of Object.entries(data)) {
    if (Array.isArray(v)) {
      if (v.length === 0) s += `${k}: []\n`;
      else if (v.every(x => x === null || typeof x !== 'object')) s += `${k}: [${v.map(serializeScalar).join(', ')}]\n`;
      else if (v.every(x => x && typeof x === 'object' && !Array.isArray(x)))
        s += `${k}: [${v.map(m => '{' + Object.entries(m).map(([mk, mv]) => `${mk}: ${serializeScalar(mv)}`).join(', ') + '}').join(', ')}]\n`;
      else throw new Error(`unsupported array value for key '${k}'`);
    } else if (v !== null && typeof v === 'object') throw new Error(`unsupported object value for key '${k}'`);
    else s += `${k}: ${serializeScalar(v)}\n`;
  }
  return s + '---\n' + (body ?? '');
}
function splitFrontmatter(text) { // → { data, body, raw }; data=null when no leading --- block
  const lines = String(text).split('\n');
  const isFence = l => l === '---' || l === '---\r';
  if (!isFence(lines[0])) return { data: null, body: text, raw: null };
  for (let j = 1; j < lines.length; j++) {
    if (isFence(lines[j])) {
      const raw = lines.slice(0, j + 1).join('\n');
      return { data: parseFrontmatter(raw), body: lines.slice(j + 1).join('\n'), raw };
    }
  }
  throw new Error('missing closing ---');
}
function contentHash(sourceVersion, body) {
  // §2.2: input = sourceVersion + "\n" + body; body newlines normalized to LF; trailing whitespace untouched
  const norm = String(body).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const input = String(sourceVersion) + '\n' + norm;
  return 'sha256:' + createHash('sha256').update(Buffer.from(input, 'utf8')).digest('hex');
}

// ---- shared: misc ----
function appendLog(kbDir, actor, action, object, note) { // append-only audit line (§2.5)
  appendFileSync(join(kbDir, 'log.md'), `## [${new Date().toISOString()}] ${actor} | ${action} | ${object} | ${note}\n`);
}
function walkFiles(dir, predicate) { // recursive relative-path listing, forward-slash paths
  const outList = [];
  const rec = (d, rel) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const rp = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) rec(join(d, e.name), rp);
      else if (!predicate || predicate(rp)) outList.push(rp);
    }
  };
  rec(dir, '');
  return outList;
}
function readJsonSafe(path, fallback) { // missing or corrupt JSON → fallback + warn()
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { warn(`warning: cannot read JSON at ${path}; using fallback`); return fallback; }
}
function parseBoolFlag(value) { // §1.2: only --flag / --flag true|false
  if (value === undefined) return true;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`invalid boolean value '${value}'; use --flag, --flag true, or --flag false`);
}

// === script-specific pure functions (exported for unit tests) ===

const USAGE = 'Usage: node render.mjs --kb <path> <report|site>';
const TEMPLATES = fileURLToPath(new URL('../templates/', import.meta.url));
const WIKILINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g; // [[slug]], [[slug#anchor]], [[slug|display]]
const DIFF_LINE_CAP = 2000; // §6.1: either side above → "diff too large" fallback
const EXCERPT_LEN = 500;    // provenance raw excerpt length
const CONFLICT_NOTE_RE = /^conflict:\s*([^|\n]+)\|\s*parties:\s*(.+)$/m; // 起草协议:review_note 首行机械解析
const LINK_SCHEME_RE = /^(https?|file):/i; // §6 href 白名单

function parseArgs(argv) {
  const args = { cmd: null, kb: undefined };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i], v;
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq > 0) { v = a.slice(eq + 1); a = a.slice(0, eq); }
    const need = () => {
      if (v !== undefined) { if (v === '') throw new Error(`flag ${a} requires a non-empty value`); return v; }
      const n = argv[i + 1];
      if (n === undefined || n.startsWith('--')) throw new Error(`flag ${a} requires a value`);
      i++; return n;
    };
    switch (a) {
      case '--kb': args.kb = need(); break;
      default:
        if (a.startsWith('--')) throw new Error(`unknown flag '${a}'`);
        if (args.cmd !== null) throw new Error(`unexpected argument '${a}'`);
        args.cmd = a;
    }
  }
  return args;
}

// ---- IO helpers (writeFileAtomic replicated from govern.mjs — the shared segment stays untouched) ----
function writeFileAtomic(path, text) { // temp + rename: never leave a half-written artifact
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}
function parseFile(kbDir, rel) { // → { ok, data, body }; never throws (govern.mjs pattern)
  let text;
  try { text = readFileSync(join(kbDir, rel), 'utf8'); }
  catch (e) { return { ok: false, error: e, data: null, body: null }; }
  try { const { data, body } = splitFrontmatter(text); return { ok: true, data, body }; }
  catch (e) { return { ok: false, error: e, data: null, body: null }; }
}
function readDecisions(kbDir) { // decisions.jsonl, §2.6 读容错: corrupt lines skipped + warn
  const p = join(kbDir, '.kb', 'govern', 'decisions.jsonl');
  const list = [];
  if (!existsSync(p)) return list;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try { list.push(JSON.parse(line)); }
    catch { warn(`warning: skipping unparseable decisions.jsonl line: ${line.slice(0, 80)}`); }
  }
  return list;
}

// ---- HTML safety (§6) ----
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function jsonIsland(obj) { // XSS-safe JSON embed: '<' can never close the script tag
  return JSON.stringify(obj).replace(/</g, '\\u003c');
}
function fillTemplate(name, data) {
  const tpl = readFileSync(join(TEMPLATES, name), 'utf8');
  return tpl.split('{{DATA}}').join(jsonIsland(data)); // split/join: no $-pattern surprises
}

// ---- line diff: LCS DP, model [['h'|'ctx'|'del'|'add', text]] (§6.1 prototype model) ----
function diffLines(s) {
  const ls = String(s).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (ls.length && ls[ls.length - 1] === '') ls.pop(); // trailing newline is not a line
  return ls;
}
function lineDiff(baseText, candText, header) {
  const a = diffLines(baseText ?? ''), b = diffLines(candText ?? '');
  const out = [];
  if (header !== undefined) out.push(['h', header]);
  if (a.length > DIFF_LINE_CAP || b.length > DIFF_LINE_CAP) {
    out.push(['h', `diff too large (base ${a.length} lines, candidate ${b.length} lines) — showing first/last 20 lines of the candidate`]);
    for (const l of b.slice(0, 20)) out.push(['ctx', ' ' + l]);
    out.push(['h', '…']);
    for (const l of b.slice(-20)) out.push(['ctx', ' ' + l]);
    return out;
  }
  // classic O(n·m) LCS DP — fine at KB scale
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push(['ctx', ' ' + a[i]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push(['del', '- ' + a[i]]); i++; }
    else { out.push(['add', '+ ' + b[j]]); j++; }
  }
  while (i < n) { out.push(['del', '- ' + a[i]]); i++; }
  while (j < m) { out.push(['add', '+ ' + b[j]]); j++; }
  return out;
}

// ---- minimal markdown renderer (§6: escape FIRST, no inline raw HTML ever) ----
function renderInline(escaped) { // input already HTML-escaped; only our own tags are inserted
  // Known limitation (do NOT "fix" by pre-parsing raw markdown): emphasis does not nest
  // (`**a *b* c**` renders flat). Escape-first is the security invariant — any smarter
  // inline grammar must keep escaping as step one.
  const codes = [];
  let t = escaped.replace(/`([^`]+)`/g, (m0, c) => { codes.push(c); return '\x00' + (codes.length - 1) + '\x00'; });
  t = t.replace(/\[\[([^\]|#]*)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (m0, slug, disp) => { // #anchor stripped (graph edges do the same)
    const s = slug.trim();
    return '<a href="#/page/' + s + '">' + (disp || s) + '</a>';
  });
  t = t.replace(/\[([^\]]*)\]\(([^)\s]*)\)/g, (m0, txt, href) => {
    if (LINK_SCHEME_RE.test(href)) return '<a href="' + href + '" rel="noopener">' + txt + '</a>';
    return m0; // non-whitelisted scheme → stays plain (escaped) text
  });
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  t = t.replace(/\x00(\d+)\x00/g, (m0, k) => '<code>' + codes[Number(k)] + '</code>');
  return t;
}
function renderMarkdown(md) {
  const lines = String(md).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const html = [];
  let i = 0, list = null, para = [];
  const closeList = () => { if (list) { html.push('</' + list + '>'); list = null; } };
  const flush = () => { closeList(); if (para.length) { html.push('<p>' + renderInline(escapeHtml(para.join('\n'))) + '</p>'); para = []; } };
  const splitRow = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      flush();
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) { buf.push(lines[i]); i++; }
      if (i < lines.length) i++; // consume closing fence; at EOF the fence was never closed
      else if (buf.length && buf[buf.length - 1] === '') buf.pop(); // drop trailing-newline split artifact
      html.push('<pre><code>' + escapeHtml(buf.join('\n')) + '</code></pre>');
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { flush(); html.push('<h' + h[1].length + '>' + renderInline(escapeHtml(h[2])) + '</h' + h[1].length + '>'); i++; continue; }
    // pipe table: header needs ≥2 columns (a '|' beyond the leading one) and the
    // separator row must itself contain a '|' — otherwise '| foo' + '---' is NOT a table
    if (line.trim().startsWith('|') && line.trim().replace(/^\|/, '').includes('|')
        && i + 1 < lines.length && lines[i + 1].includes('|') && lines[i + 1].includes('-')
        && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
      flush();
      const head = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) { rows.push(splitRow(lines[i])); i++; }
      let t = '<table><thead><tr>' + head.map(c => '<th>' + renderInline(escapeHtml(c)) + '</th>').join('') + '</tr></thead><tbody>';
      for (const r of rows) t += '<tr>' + r.map(c => '<td>' + renderInline(escapeHtml(c)) + '</td>').join('') + '</tr>';
      html.push(t + '</tbody></table>');
      continue;
    }
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    if (ul) {
      if (para.length) flush();
      if (list !== 'ul') { closeList(); html.push('<ul>'); list = 'ul'; }
      html.push('<li>' + renderInline(escapeHtml(ul[1])) + '</li>'); i++; continue;
    }
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ol) {
      if (para.length) flush();
      if (list !== 'ol') { closeList(); html.push('<ol>'); list = 'ol'; }
      html.push('<li>' + renderInline(escapeHtml(ol[1])) + '</li>'); i++; continue;
    }
    if (line.trim() === '') { flush(); i++; continue; }
    para.push(line); i++;
  }
  flush();
  return html.join('\n');
}

// ---- conflict group extraction (§6.1 / review_note 起草协议) ----
function parseConflictNote(note) { // 'conflict: <kind> | parties: <id1> vs <id2>' → conflict block, else null
  const m = String(note ?? '').match(CONFLICT_NOTE_RE);
  if (!m) return null;
  const parties = m[2].split(/\s+vs\s+/).map(s => s.trim()).filter(s => s !== '');
  if (parties.length < 2) return null;
  return { kind: m[1].trim(), sim: null, parties: parties.map(id => ({ id, label: id })),
    ask: '选择采信哪一方(败方内容将被标注;也可选「保留两者」让矛盾显式共存):' };
}
function conflictFromPlan(plan, base, targetPath) { // last-plan human_lists conflict-pair hit
  if (!plan || !Array.isArray(plan.human_lists)) return null;
  for (const e of plan.human_lists) {
    if (!e || e.kind !== 'conflict-pair') continue;
    if (e.a !== base && e.b !== base && e.a !== targetPath && e.b !== targetPath) continue;
    return { kind: 'conflict-pair(疑似冲突对)', sim: e.similarity !== undefined ? String(e.similarity) : null,
      parties: [{ id: e.a, label: e.a }, { id: e.b, label: e.b }], ask: '合并必须显式选择,无默认:' };
  }
  return null;
}
function chipClass(conflict) {
  const k = String(conflict.kind);
  if (/conflict|冲突/i.test(k)) return 'conflict';
  if (/similar|pair|相似|重复|dup/i.test(k)) return 'dup';
  return 'syn';
}

// ---- report assembly (§6.1) ----
function rawExcerpt(kbDir, ref) { // ref = 'raw:<source>/<source_id>' → first EXCERPT_LEN chars of body
  const m = String(ref).match(/^raw:([A-Za-z0-9_-]+)\/([A-Za-z0-9][A-Za-z0-9_-]*)$/);
  if (!m) return { ref: String(ref), excerpt: '(not a raw reference)' };
  const p = parseFile(kbDir, `raw/${m[1]}/${m[2]}.md`);
  if (!p.ok) return { ref: String(ref), excerpt: '(raw file missing or unparseable)' };
  return { ref: String(ref), excerpt: p.body.slice(0, EXCERPT_LEN) };
}
function candidateRefs(data) { // source page → source_ref; others → sources list
  if (data.type === 'source' && data.source_ref !== undefined && data.source_ref !== null)
    return ['raw:' + String(data.source_ref)];
  const s = data.sources;
  return (Array.isArray(s) ? s : s == null ? [] : [s]).map(String);
}
function assembleReport(kbDir) {
  const planPath = join(kbDir, '.kb', 'govern', 'last-plan.json');
  const plan = existsSync(planPath) ? readJsonSafe(planPath, null) : null;
  let queue;
  if (plan && Array.isArray(plan.review_queue)) queue = plan.review_queue;
  else { // fallback: glob sidecars directly (govern.mjs planReviewQueue shape)
    queue = [];
    const wikiDir = join(kbDir, 'wiki');
    if (existsSync(wikiDir))
      for (const rel0 of walkFiles(wikiDir, p => p.endsWith('.candidate.md'))) {
        const rel = 'wiki/' + rel0;
        let base = null, note = '(missing review_note)';
        const p = parseFile(kbDir, rel);
        if (p.ok && p.data) {
          if ('base' in p.data) base = p.data.base;
          if (p.data.review_note !== undefined && p.data.review_note !== null) note = String(p.data.review_note);
        }
        queue.push({ candidate: rel, base, review_note: note });
      }
  }
  const decisions = readDecisions(kbDir);
  const cases = [];
  for (const item of queue) {
    const cand = String(item.candidate);
    const p = parseFile(kbDir, cand);
    const data = (p.ok && p.data) ? p.data : {};
    const base = item.base !== undefined ? item.base : (data.base ?? null);
    const baseParsed = base ? parseFile(kbDir, String(base)) : null;
    const baseBody = baseParsed && baseParsed.ok ? baseParsed.body : null;
    const candBody = p.ok ? p.body : '';
    const targetPath = cand.replace(/\.candidate\.md$/, '.md');
    const header = base
      ? `${base}(候选版 vs 当前 approved 版${baseBody === null ? ';base 文件缺失' : ''})`
      : `${cand}(新建候选 — base: null,以下全部为新增)`;
    const conflict = parseConflictNote(item.review_note ?? data.review_note)
      ?? conflictFromPlan(plan, base, targetPath);
    const short = cand.replace(/^wiki\//, '').replace(/\.candidate\.md$/, '');
    cases.push({
      path: cand,
      title: conflict ? `${short} — ${conflict.kind}` : `${short} — ${data.title ?? basename(targetPath, '.md')}`,
      note: String(item.review_note ?? data.review_note ?? '(missing review_note)'),
      diff: lineDiff(baseBody ?? '', candBody, header),
      conflict,
      chipClass: conflict ? chipClass(conflict) : null,
      sources: candidateRefs(data).map(r => rawExcerpt(kbDir, r)),
      hist: decisions
        .filter(d => d && (d.page === cand || (base && d.page === base) || d.page === targetPath))
        .map(d => `${d.ts ?? '?'} ${d.actor ?? '?'} ${d.action ?? '?'}${d.reason ? ' — ' + d.reason : ''}`),
    });
  }
  const autoApproved = plan && plan.ts
    ? decisions.filter(d => d && d.action === 'auto-approve' && typeof d.ts === 'string' && d.ts >= plan.ts).length
    : 0;
  const KIND_LABEL = { orphan: 'orphan', 'dangling-link': '悬空链', 'conflict-pair': '冲突对', 'hand-edit': 'hand-edit', 'missing-raw': 'missing-raw' };
  let humanSummary = '无';
  if (plan && Array.isArray(plan.human_lists) && plan.human_lists.length) {
    const counts = new Map();
    for (const e of plan.human_lists) {
      const k = KIND_LABEL[e && e.kind] ?? String(e && e.kind);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    humanSummary = [...counts.entries()].map(([k, n]) => `${k} ${n}`).join(' · ');
  }
  return {
    generatedAt: new Date().toISOString(),
    autoApproved,
    autoSummary: autoApproved > 0 ? `本 run 自动 approve ${autoApproved} 页(低风险,均无不矛盾增量),无需操作。` : '本 run 无自动生效页。',
    humanSummary,
    cases,
  };
}

// ---- site assembly (§6.2) ----
function assembleSite(kbDir) {
  const wikiDir = join(kbDir, 'wiki');
  const collected = [];
  if (existsSync(wikiDir)) {
    for (const rel0 of walkFiles(wikiDir, p => p.endsWith('.md') && p !== 'index.md' && !p.startsWith('archive/') && !p.endsWith('.candidate.md'))) {
      const rel = 'wiki/' + rel0;
      const p = parseFile(kbDir, rel);
      if (!p.ok || !p.data || p.data.status !== 'approved') continue;
      const fm = p.data;
      const slug = basename(rel, '.md');
      const rec = {
        slug,
        type: fm.type ?? null,
        title: fm.title ?? slug,
        summary: fm.summary ?? '',
        created_at: fm.created_at ?? null,
        updated_at: fm.updated_at ?? null,
        tags: Array.isArray(fm.tags) ? fm.tags.map(String) : [],
        aliases: Array.isArray(fm.aliases) ? fm.aliases.map(String) : [],
        kind: fm.kind ?? null,
        relations: Array.isArray(fm.relations) // §2.3 typed relations (entity)
          ? fm.relations.filter(r => r && typeof r === 'object').map(r => ({ target: String(r.target ?? ''), type: String(r.type ?? '') }))
          : [],
        related_topics: Array.isArray(fm.related_topics) ? fm.related_topics.map(String) : [],
        source_ref: fm.source_ref !== undefined && fm.source_ref !== null ? String(fm.source_ref) : undefined,
        sources: Array.isArray(fm.sources) ? fm.sources.map(String) : [],
        body_html: renderMarkdown(p.body),
        _body: p.body,
      };
      if (fm.source_version !== undefined && fm.source_version !== null) rec.source_version = String(fm.source_version);
      if (rec.type === 'source' && rec.source_ref) {
        rec.source = rec.source_ref.split('/')[0]; // originating raw source (browse filter)
        const rp = parseFile(kbDir, 'raw/' + rec.source_ref + '.md');
        if (rp.ok && rp.data && rp.data.issue_type !== undefined && rp.data.issue_type !== null)
          rec.issue_type = String(rp.data.issue_type);
      }
      collected.push(rec);
    }
  }
  collected.sort((a, b) => a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);

  // edges: wikilink (page↔page) + provenance (source page ↔ page listing its raw); index.md never a node (§6.2)
  const slugs = new Set(collected.map(p => p.slug));
  const edges = [];
  const seen = new Set();
  const addEdge = (a, b, kind) => {
    if (a === b) return;
    const k = a + ' ' + b + ' ' + kind;
    if (seen.has(k)) return;
    seen.add(k);
    edges.push({ a, b, kind });
  };
  const inbound = new Set();
  const dangling = [];
  for (const p of collected) {
    const seenTarget = new Set();
    for (const m of p._body.matchAll(WIKILINK_RE)) {
      const t = m[1].trim();
      if (slugs.has(t)) {
        addEdge(p.slug, t, 'link');
        if (t !== p.slug) inbound.add(t);
      } else if (!seenTarget.has(t)) {
        seenTarget.add(t);
        dangling.push({ page: p.slug, target: t });
      }
    }
  }
  const sourcePageByRef = new Map();
  for (const p of collected)
    if (p.type === 'source' && p.source_ref) sourcePageByRef.set(p.source_ref, p.slug);
  for (const p of collected) {
    if (p.type === 'source') continue;
    for (const s of p.sources) {
      const m = String(s).match(/^raw:(.+)$/);
      if (m && sourcePageByRef.has(m[1])) addEdge(sourcePageByRef.get(m[1]), p.slug, 'provenance');
    }
  }
  const orphans = collected.filter(p => !inbound.has(p.slug)).map(p => p.slug);

  // history + runs + log
  const decisions = readDecisions(kbDir);
  const logPath = join(kbDir, 'log.md');
  const log = existsSync(logPath)
    ? readFileSync(logPath, 'utf8').split('\n').map(l => l.replace(/\r$/, '')).filter(l => l.trim() !== '')
    : [];
  const runsPath = join(kbDir, '.kb', 'govern', 'runs.jsonl');
  const runs = [];
  if (existsSync(runsPath))
    for (const line of readFileSync(runsPath, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      try { runs.push(JSON.parse(line)); }
      catch { warn(`warning: skipping unparseable runs.jsonl line: ${line.slice(0, 80)}`); }
    }

  const data = {
    generatedAt: new Date().toISOString(),
    pages: collected.map(({ _body, ...rest }) => rest),
    edges,
    decisions,
    log,
    runs,
    health: { orphans, dangling },
    graphMode: collected.length > 500 ? 'adjacency' : 'force',
  };
  return data;
}

// ---- report/site paths ----
function reportPathFor(dir, now = new Date()) { // compact-ISO run-id; same-second re-render → -2, -3, … (never overwrite)
  const base = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, ''); // e.g. 20260812T142300
  let runId = base, n = 1;
  while (existsSync(join(dir, runId + '.html'))) { n++; runId = `${base}-${n}`; }
  return join(dir, runId + '.html');
}

// === main(argv) ===
async function main(argv) {
  let args;
  try { args = parseArgs(argv); } catch (e) { return fail(64, e.message, USAGE); }
  const r = resolveKb(args.kb);
  if (r.error) return fail(64, r.error, r.hint);
  const c = checkKb(r.kb);
  if (c.error) return fail(65, c.error, c.hint);
  if (args.cmd === null) return fail(64, 'missing subcommand', USAGE);
  if (args.cmd !== 'report' && args.cmd !== 'site') return fail(64, `unknown subcommand '${args.cmd}'`, USAGE);
  const fwd = (p) => p.replace(/\\/g, '/');
  try {
    if (args.cmd === 'report') {
      const data = assembleReport(r.kb);
      const html = fillTemplate('adjudication-report.html', data);
      const dir = join(r.kb, '.kb', 'govern', 'reports');
      mkdirSync(dir, { recursive: true });
      const file = reportPathFor(dir);
      writeFileAtomic(file, html);
      writeFileAtomic(join(dir, 'latest.html'), html);
      out({ written: fwd(file), candidates: data.cases.length });
      return EXIT.OK;
    }
    const data = assembleSite(r.kb);
    const html = fillTemplate('site.html', data);
    const dir = join(r.kb, '.kb', 'site');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'index.html');
    writeFileAtomic(file, html);
    out({ written: [fwd(file)], pages: data.pages.length, edges: data.edges.length });
    return EXIT.OK;
  } catch (e) {
    return fail(1, 'internal error', String(e && e.message || e));
  }
}

export { EXIT, CONTRACT_VERSION, SOURCE_ID_RE, SLUG_RE, RAW_SOURCES, PAGE_TYPES, PAGE_STATUSES, DECISION_ACTIONS,
  out, warn, fail, resolveKb, checkKb, splitFrontmatter, parseFrontmatter, serializeFrontmatter, contentHash,
  appendLog, walkFiles, readJsonSafe, parseBoolFlag,
  parseArgs, escapeHtml, jsonIsland, fillTemplate, lineDiff, renderMarkdown, renderInline,
  parseConflictNote, conflictFromPlan, rawExcerpt, assembleReport, assembleSite, readDecisions, reportPathFor, main };

// robust isMain: fileURLToPath comparison survives '#', '?', '%' in script paths (URL-building does not)
// exitCode (not process.exit): natural exit lets any pending handles drain (govern.mjs pattern)
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) { process.exitCode = await main(process.argv.slice(2)); }
