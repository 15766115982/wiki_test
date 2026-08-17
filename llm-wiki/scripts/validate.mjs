#!/usr/bin/env node
// === imports (node builtins only) ===
import { createHash } from 'node:crypto';
import { readFileSync, appendFileSync, readdirSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, basename } from 'node:path';
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

const USAGE = 'Usage: node validate.mjs --kb <path> [--file <path>] [--mode govern|distill]';
const RAW_REQUIRED = ['source', 'source_id', 'source_url', 'source_version', 'pulled_at', 'content_hash'];
const WIKI_REQUIRED = ['type', 'status', 'title', 'summary', 'created_at', 'updated_at'];
const WIKILINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
const MARKER_RE = /\[(T|R)-(\d+)\]/g;
// NOTE: entry headings are scanned across the whole body (not just after '## Appendix'); '### T-12x' parses as T-12 — known accepted heuristic.
const ENTRY_HEAD_RE = /^### (T|R)-(\d+)\b.*$/gm;
const KEY_FACT_RE = /[A-Z][A-Z0-9_]{2,}|\d|`[^`]+`/; // identifier-ish tokens: UPPER_SNAKE, digits, `code`
const RAW_PATH_RE = /raw\/[A-Za-z0-9_\/.-]+\.md/;

function parseArgs(argv) {
  const opts = {};
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
      case '--kb': opts.kb = need(); break;
      case '--file': opts.file = need(); break;
      case '--mode': {
        const m = need();
        if (m !== 'govern' && m !== 'distill') throw new Error(`--mode must be govern or distill, got '${m}'`);
        opts.mode = m; break;
      }
      default: throw new Error(a.startsWith('--') ? `unknown flag '${a}'` : `unexpected argument '${a}'`);
    }
  }
  return opts;
}

function validateKb(kbDir, { file, mode } = {}) {
  const failures = [];
  const add = (f, check, message) => failures.push({ file: f, check, message });

  const rawDir = join(kbDir, 'raw');
  const wikiDir = join(kbDir, 'wiki');
  const allRaws = walkFiles(rawDir, p => p.endsWith('.md') && !p.startsWith('assets/')).map(p => 'raw/' + p);
  const allWiki = walkFiles(wikiDir, p => p.endsWith('.md') && p !== 'index.md' && !p.startsWith('archive/')).map(p => 'wiki/' + p);

  const parseCache = new Map();
  const parseFile = (rel) => { // never throws: read/parse failures are captured as { ok:false, error, text }
    if (!parseCache.has(rel)) {
      let text = null;
      try { text = readFileSync(join(kbDir, rel), 'utf8'); }
      catch (e) { parseCache.set(rel, { ok: false, error: e, text: null }); return parseCache.get(rel); }
      try { parseCache.set(rel, { ok: true, text, ...splitFrontmatter(text) }); }
      catch (e) { parseCache.set(rel, { ok: false, error: e, text }); }
    }
    return parseCache.get(rel);
  };

  // approved wiki slugs (archive/ and *.candidate.md never count as resolution targets)
  const approvedSlugs = new Set();
  for (const rel of allWiki) {
    if (rel.endsWith('.candidate.md')) continue;
    const p = parseFile(rel);
    if (p.ok && p.data && p.data.status === 'approved') approvedSlugs.add(basename(rel, '.md'));
  }

  // slug → files map for slug-dup: wikilinks carry no type, so page slugs must be globally
  // unique across all four type dirs (the slug-registry is global, §2.3). A page and its own
  // *.candidate.md sidecar in the SAME directory legitimately share a slug (sidecar model);
  // only a collision across DIFFERENT directories is a failure.
  const slugMap = new Map(); // slug → [rel]
  for (const rel of allWiki) {
    const b = basename(rel);
    const slug = b.endsWith('.candidate.md') ? b.slice(0, -'.candidate.md'.length) : b.slice(0, -'.md'.length);
    if (!slugMap.has(slug)) slugMap.set(slug, []);
    slugMap.get(slug).push(rel);
  }

  // content_hash groups across all raws ("manual" exempt, §2.2)
  const hashMap = new Map();
  for (const rel of allRaws) {
    const p = parseFile(rel);
    if (!p.ok || !p.data) continue;
    const h = p.data.content_hash;
    if (h === undefined || h === null || h === 'manual') continue;
    const key = String(h);
    if (!hashMap.has(key)) hashMap.set(key, []);
    hashMap.get(key).push(rel);
  }

  // ---- govern: raw checks ----
  function checkGovernRaw(rel) {
    const p = parseFile(rel);
    if (!p.ok) { add(rel, 'frontmatter', `unparseable frontmatter: ${p.error.message}`); return; }
    const data = p.data;
    if (!data) { add(rel, 'frontmatter', `missing frontmatter; required fields: ${RAW_REQUIRED.join(', ')}`); return; }
    const src = data.source ?? rel.split('/')[1];
    const required = src === 'jira' ? [...RAW_REQUIRED, 'issue_type'] : RAW_REQUIRED;
    const missing = required.filter(k => data[k] === undefined || data[k] === null);
    if (missing.length) add(rel, 'frontmatter', `missing required fields: ${missing.join(', ')}`);
    if (data.source_id !== undefined && data.source_id !== null) {
      const sid = String(data.source_id);
      if (!SOURCE_ID_RE.test(sid)) add(rel, 'source-id-whitelist', `source_id '${sid}' does not match ${SOURCE_ID_RE}`);
      if (basename(rel) !== `${sid}.md`) add(rel, 'source-id-whitelist', `filename '${basename(rel)}' does not equal <source_id>.md ('${sid}.md')`);
    }
    const h = data.content_hash;
    if (h !== undefined && h !== null && h !== 'manual') {
      const group = hashMap.get(String(h)) || [];
      if (group.length > 1) add(rel, 'hash-dup', `duplicate content_hash shared with: ${group.filter(g => g !== rel).join(', ')}`);
    }
  }

  // ---- govern: wiki checks ----
  function checkWikiPage(rel) {
    const p = parseFile(rel);
    if (!p.ok) add(rel, 'wiki-frontmatter', `unparseable frontmatter: ${p.error.message}`);
    const data = p.ok ? p.data : null;
    const base = basename(rel);
    const isSidecar = base.endsWith('.candidate.md');
    const slug = isSidecar ? base.slice(0, -'.candidate.md'.length) : base.slice(0, -'.md'.length);
    if (!SLUG_RE.test(slug)) add(rel, 'slug-whitelist', `slug '${slug}' does not match ${SLUG_RE}`);
    const slugGroup = slugMap.get(slug) || [];
    const slugDirs = new Set(slugGroup.map(r => r.slice(0, r.lastIndexOf('/'))));
    if (slugDirs.size > 1)
      add(rel, 'slug-dup', `slug '${slug}' is not globally unique; collides across type dirs with: ${slugGroup.filter(g => g !== rel).join(', ')}`);
    if (p.ok && !data) add(rel, 'wiki-frontmatter', `missing frontmatter; required fields: ${WIKI_REQUIRED.join(', ')}`);
    if (data) {
      const missing = WIKI_REQUIRED.filter(k => data[k] === undefined || data[k] === null);
      if (missing.length) add(rel, 'wiki-frontmatter', `missing required fields: ${missing.join(', ')}`);
      if (data.type === 'source') {
        if (data.source_ref === undefined || data.source_ref === null) add(rel, 'wiki-frontmatter', 'source page missing source_ref');
      } else if (data.type !== undefined && data.type !== null) {
        if (data.sources === undefined || data.sources === null) add(rel, 'wiki-frontmatter', 'non-source page missing sources');
      }
      if (isSidecar) {
        if (data.status !== 'candidate') add(rel, 'status-whitelist', `sidecar status must be 'candidate', got '${data.status}'`);
        const miss = ['base', 'review_note'].filter(k => !(k in data));
        if (miss.length) add(rel, 'sidecar-fields', `sidecar missing required keys: ${miss.join(', ')} (base may be null but the key must exist)`);
      } else if (!['approved', 'archived'].includes(data.status)) {
        add(rel, 'status-whitelist', `page file status must be approved|archived, got '${data.status}'`);
      }
      const srcs = data.sources == null ? [] : (Array.isArray(data.sources) ? data.sources : [data.sources]);
      for (const e of srcs) {
        const s = String(e);
        const m = s.match(/^raw:([A-Za-z0-9_-]+)\/([A-Za-z0-9][A-Za-z0-9_-]*)$/);
        if (!m) { add(rel, 'refs', `malformed source ref '${s}' (expected raw:<source>/<source_id>)`); continue; }
        if (!existsSync(join(kbDir, 'raw', m[1], m[2] + '.md'))) add(rel, 'refs', `source ref '${s}' does not resolve to an existing raw file`);
      }
      // refusion-retention (§2.3 重融保持性护栏): overwrite proposals must retain the base page's
      // wikilinks, sources, and key-fact lines (>20% key-fact loss → failure). base null / missing → skip.
      if (isSidecar && data.base !== null && data.base !== undefined) {
        const baseRel = String(data.base);
        const baseAbs = join(kbDir, baseRel);
        const bp = existsSync(baseAbs) && statSync(baseAbs).isFile() ? parseFile(baseRel) : null;
        if (bp && bp.ok && bp.data) {
          const linksOf = (body) => [...body.matchAll(WIKILINK_RE)].map(m => m[1].trim());
          const sidecarLinks = new Set(linksOf(p.body));
          const lostLinks = [...new Set(linksOf(bp.body))].filter(s => !sidecarLinks.has(s));
          if (lostLinks.length) add(rel, 'refusion-retention', `re-fusion dropped base wikilink(s): ${lostLinks.map(s => `[[${s}]]`).join(', ')}`);
          const srcList = (d) => (d.sources == null ? [] : Array.isArray(d.sources) ? d.sources : [d.sources]).map(String);
          const sidecarSrcs = new Set(srcList(data));
          const lostSrcs = srcList(bp.data).filter(s => !sidecarSrcs.has(s));
          if (lostSrcs.length) add(rel, 'refusion-retention', `re-fusion dropped base sources: ${lostSrcs.join(', ')}`);
          const normLine = l => l.replace(/\s+/g, ' ').trim();
          const sidecarLines = new Set(p.body.split('\n').map(normLine));
          const baseKeyLines = [...new Set(bp.body.split('\n').map(normLine).filter(l => l && KEY_FACT_RE.test(l)))];
          if (baseKeyLines.length) {
            const lost = baseKeyLines.filter(l => !sidecarLines.has(l));
            const ratio = lost.length / baseKeyLines.length;
            if (ratio > 0.2) add(rel, 'refusion-retention', `key-fact line disappearance ratio ${ratio.toFixed(2)} (${lost.length}/${baseKeyLines.length}) > 0.2; lost: ${lost.map(l => JSON.stringify(l)).join(', ')}`);
          }
        }
      }
    }
    if (p.ok) {
      for (const m of p.body.matchAll(WIKILINK_RE)) {
        const target = m[1].trim();
        if (!approvedSlugs.has(target)) add(rel, 'refs', `unresolved wikilink [[${target}]] (no approved wiki page with that slug)`);
      }
    }
  }

  // ---- distill: raw/chat checks (§5) ----
  function checkDistill(rel) {
    const p = parseFile(rel);
    // normalize CRLF/CR → LF so fence/heading/marker detection works on CRLF chat files
    const body = (p.ok ? p.body : (p.text ?? '')).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const apx = body.search(/^##\s+Appendix/m);
    const pre = apx >= 0 ? body.slice(0, apx) : body;

    // appendix entries
    const heads = [];
    for (const m of body.matchAll(ENTRY_HEAD_RE)) heads.push({ kind: m[1], n: Number(m[2]), start: m.index, end: m.index + m[0].length });
    for (let i = 0; i < heads.length; i++) heads[i].block = body.slice(heads[i].end, i + 1 < heads.length ? heads[i + 1].start : body.length);

    // cite-resolve
    const seen = new Set();
    for (const m of pre.matchAll(MARKER_RE)) {
      const tag = `${m[1]}-${m[2]}`;
      if (seen.has(tag)) continue;
      seen.add(tag);
      if (!heads.some(h => h.kind === m[1] && h.n === Number(m[2]))) add(rel, 'cite-resolve', `citation [${tag}] has no appendix entry '### ${tag}'`);
    }

    // appendix-contiguous
    for (const kind of ['T', 'R']) {
      const nums = [...new Set(heads.filter(h => h.kind === kind).map(h => h.n))].sort((a, b) => a - b);
      if (!nums.length) continue;
      for (let n = 1; n <= nums[nums.length - 1]; n++)
        if (!nums.includes(n)) add(rel, 'appendix-contiguous', `appendix ${kind} numbering gap: missing ${kind}-${n}`);
    }

    // no-frontmatter-in-body
    const lines = body.split('\n');
    const fences = lines.map((l, i) => l === '---' ? i : -1).filter(i => i >= 0);
    for (let k = 0; k + 1 < fences.length; k++) {
      const inner = lines.slice(fences[k] + 1, fences[k + 1]).filter(l => l.trim() !== '');
      if (inner.length && inner.some(l => /^[A-Za-z0-9_-]+:/.test(l)) && inner.every(l => /^([A-Za-z0-9_-]+:( .*)?|- .*)$/.test(l))) {
        add(rel, 'no-frontmatter-in-body', 'a second frontmatter block appears in the body');
        break;
      }
    }

    // excerpt-substring (KB-local raw sources only; external URLs skipped)
    for (const h of heads.filter(h => h.kind === 'R')) {
      const blines = h.block.split('\n');
      const pi = blines.findIndex(l => RAW_PATH_RE.test(l));
      if (pi < 0) continue; // external source → trust boundary, skip
      const ref = blines[pi].match(RAW_PATH_RE)[0];
      const excerpt = blines.slice(pi + 1).join('\n').trim();
      if (!excerpt) continue;
      const abs = join(kbDir, ref);
      if (!existsSync(abs)) { add(rel, 'excerpt-substring', `[R-${h.n}] provenance '${ref}' does not exist in the KB`); continue; }
      const tp = parseFile(ref);
      const targetBody = (tp.ok ? tp.body : (tp.text ?? '')).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      if (!targetBody.includes(excerpt)) add(rel, 'excerpt-substring', `[R-${h.n}] excerpt is not a substring of '${ref}' body`);
    }
  }

  // ---- file selection & mode ----
  // Default: chat raws get distill checks PLUS the raw frontmatter contract + hash-dup (§2.2 applies to all raws).
  // Explicit --mode applies that mode's check set to every in-scope file:
  //   distill → distill set only (strict); govern → raw checks for raws (incl. chat), wiki checks for wiki pages.
  const defaultMode = (rel) => rel.startsWith('raw/chat/') ? 'distill' : 'govern';
  let checks; // [rel, mode, explicit]
  if (file) {
    const abs = isAbsolute(file) ? file : resolve(kbDir, file);
    if (!existsSync(abs)) return { error: 'file not found', hint: `'${file}' does not exist (relative to the KB or as an absolute path).` };
    if (!statSync(abs).isFile()) return { error: 'not a file', hint: `--file expects a single file, got a directory: '${file}'.` }; // usage error → exit 64
    const rel = relative(kbDir, abs).replace(/\\/g, '/');
    if (rel.startsWith('..') || isAbsolute(rel)) return { error: 'file outside KB', hint: `--file must point inside the KB: '${file}' escapes '${kbDir}'.` }; // usage error → exit 64
    checks = [[rel, mode || defaultMode(rel), !!mode]];
  } else {
    checks = [...allRaws, ...allWiki].map(f => [f, mode || defaultMode(f), !!mode]);
  }

  for (const [rel, m, explicit] of checks) {
    if (m === 'distill') {
      checkDistill(rel);
      if (!explicit && rel.startsWith('raw/chat/')) checkGovernRaw(rel);
    } else if (rel.startsWith('raw/')) checkGovernRaw(rel);
    else checkWikiPage(rel);
  }
  return { checked: checks.length, failures };
}

// === main(argv) ===
async function main(argv) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { return fail(64, e.message, USAGE); }
  const r = resolveKb(opts.kb);
  if (r.error) return fail(64, r.error, r.hint);
  const c = checkKb(r.kb);
  if (c.error) return fail(65, c.error, c.hint);
  let res;
  try { res = validateKb(r.kb, opts); }
  catch (e) { return fail(1, 'internal error', String(e && e.message || e)); }
  if (res.error) return fail(64, res.error, res.hint);
  out({ checked: res.checked, passed: res.failures.length === 0, failures: res.failures });
  return res.failures.length ? EXIT.FAIL : EXIT.OK;
}

export { EXIT, CONTRACT_VERSION, SOURCE_ID_RE, SLUG_RE, RAW_SOURCES, PAGE_TYPES, PAGE_STATUSES, DECISION_ACTIONS,
  out, warn, fail, resolveKb, checkKb, splitFrontmatter, parseFrontmatter, serializeFrontmatter, contentHash,
  appendLog, walkFiles, readJsonSafe, parseBoolFlag, parseArgs, validateKb, main };

// robust isMain: fileURLToPath comparison survives '#', '?', '%' in script paths (URL-building does not)
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) { const code = await main(process.argv.slice(2)); process.exit(code); }
