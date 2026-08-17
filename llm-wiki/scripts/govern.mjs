#!/usr/bin/env node
// === imports (node builtins only) ===
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, appendFileSync, readdirSync, existsSync, unlinkSync, renameSync, openSync, closeSync, mkdirSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { hostname } from 'node:os';

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

const USAGE = 'Usage: node govern.mjs --kb <path> <sweep|plan|rebuild-index>\n' +
  '       node govern.mjs --kb <path> record-decision --actor human|agent --action <a> --page <path> [--reason <text>] [--cited <id,id,...>]\n' +
  '       node govern.mjs --kb <path> fold --page wiki/<syntheses|concepts|entities>/<slug>.md --folds <folds.json> [--title <t> --summary <s>]';
const SUBCOMMANDS = ['sweep', 'plan', 'rebuild-index', 'record-decision', 'fold'];
const RAW_REQUIRED = ['source', 'source_id', 'source_url', 'source_version', 'pulled_at', 'content_hash'];
const WIKILINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g; // [[slug]], [[slug#anchor]], [[slug|display]]
const LOCK_STALE_MS = 2 * 3600e3; // §1.4: >2h → stale, reclaimable
const LOCK_HOST = hostname(); // machine identity: pid liveness is only meaningful for same-host locks
const CONFLICT_PAIR_CAP = 50;
const HAND_EDIT_CAP = 50;
const CONFLICT_PAIR_MIN_SIMILARITY = 0.5;
const TOPIC_INDEX_THRESHOLD = 500; // §7 scale envelope: above this, rebuild-index also emits wiki/topics.md (Tier 0.5)

class GovernAbort extends Error { // fatal for the subcommand; carries typed code + hint (acquire's ConnectorAbort pattern)
  constructor(code, message, hint) { super(message); this.code = code; this.hint = hint; }
}

function parseArgs(argv) {
  const args = { cmd: null, kb: undefined, actor: undefined, action: undefined, page: undefined, reason: undefined, cited: undefined,
    folds: undefined, title: undefined, summary: undefined };
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
      case '--actor': args.actor = need(); break;
      case '--action': args.action = need(); break;
      case '--page': args.page = need(); break;
      case '--reason': args.reason = need(); break;
      case '--folds': args.folds = need(); break;
      case '--title': args.title = need(); break;
      case '--summary': args.summary = need(); break;
      case '--cited': { // flag PRESENCE is what matters (§2.6); value may be empty → []
        if (v !== undefined) args.cited = parseCited(v);
        else { const n = argv[i + 1]; if (n !== undefined && !n.startsWith('--')) { i++; args.cited = parseCited(n); } else args.cited = []; }
        break;
      }
      default:
        if (a.startsWith('--')) throw new Error(`unknown flag '${a}'`);
        if (args.cmd !== null) throw new Error(`unexpected argument '${a}'`);
        args.cmd = a;
    }
  }
  return args;
}
function parseCited(v) { return v === '' ? [] : String(v).split(',').map(s => s.trim()).filter(s => s !== ''); }

// ---- git helpers (acquire's pattern: every git call is best-effort, failure → null) ----
// -c core.quotepath=false on EVERY call: git's default octal-escapes non-ASCII path bytes
// ("raw/local/\344\270\255...md"), which would silently break filesystem-path comparisons (CJK ids).
const GIT_GLOBAL = ['-c', 'core.quotepath=false'];
function gitOut(dir, args) { // → trimmed stdout; NOTE: conflates failure with empty output (both → null) — callers must not need to distinguish
  try {
    const s = execFileSync('git', [...GIT_GLOBAL, '-C', dir, ...args], { encoding: 'utf8' }).trim();
    return s === '' ? null : s;
  } catch { return null; }
}
function gitRaw(dir, args) { // → untrimmed stdout, or null on any failure (porcelain needs exact columns)
  try { return execFileSync('git', [...GIT_GLOBAL, '-C', dir, ...args], { encoding: 'utf8' }); }
  catch { return null; }
}
function isGitRepo(kbDir) { return gitOut(kbDir, ['rev-parse', '--git-dir']) !== null; }

// baseline = newest commit whose subject starts with 'govern: run' (§2.8 commit discipline)
function findBaseline(kbDir) {
  const log = gitOut(kbDir, ['log', '--format=%H%x00%s']);
  if (!log) return null;
  for (const line of log.split('\n')) {
    const i = line.indexOf('\0');
    if (i > 0 && line.slice(i + 1).startsWith('govern: run')) return line.slice(0, i);
  }
  return null;
}
function cUnescapePath(p) { // defensive: decode git's C-style quoted-path escapes ("..." already stripped)
  if (!p.includes('\\')) return p;
  const bytes = [];
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '\\' && i + 1 < p.length) {
      const n = p[i + 1];
      if (n === '"') { bytes.push(0x22); i++; continue; }
      if (n === '\\') { bytes.push(0x5c); i++; continue; }
      const oct = p.slice(i + 1, i + 4); // \NNN octal byte (non-ASCII path bytes)
      if (/^[0-7]{3}$/.test(oct)) { bytes.push(parseInt(oct, 8)); i += 3; continue; }
    }
    bytes.push(...Buffer.from(p[i], 'utf8'));
  }
  return Buffer.from(bytes).toString('utf8');
}
function porcelainPaths(outText) { // 'XY path' lines → paths (rename → new path, quotes stripped, escapes decoded)
  const paths = [];
  for (const l of outText.split('\n')) {
    const m = l.replace(/\r$/, '').match(/^(.{2}) (.+)$/);
    if (!m) continue;
    let p = m[2];
    const arrow = p.indexOf(' -> ');
    if (arrow >= 0) p = p.slice(arrow + 4);
    if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
    paths.push(cUnescapePath(p));
  }
  return paths;
}

// ---- run.lock (§1.4) ----
// Stale = ts older than 2h, OR (same-host lock AND pid not alive). The pid liveness check is
// gated on host === LOCK_HOST because pids are meaningless across hosts (a KB may live on a
// shared/synced drive); a fresh foreign-host lock is honored purely by its timestamp.
function acquireLock(kbDir) {
  const lockPath = join(kbDir, '.kb', 'govern', 'run.lock');
  const tryCreate = () => {
    let fd;
    try { fd = openSync(lockPath, 'wx'); } // atomic create; EEXIST → locked
    catch (e) { if (e && e.code === 'EEXIST') return false; throw e; }
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: new Date().toISOString(), host: LOCK_HOST })); }
    finally { closeSync(fd); }
    return true;
  };
  if (tryCreate()) return { lockPath };
  let stale = false;
  try {
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    const age = Date.now() - new Date(lock.ts).getTime();
    if (!Number.isFinite(age) || age > LOCK_STALE_MS) stale = true;
    else if (lock.host === LOCK_HOST && Number.isInteger(lock.pid)) {
      try { process.kill(lock.pid, 0); }
      catch (e) { if (e && e.code === 'ESRCH') stale = true; }
    }
  } catch { stale = true; } // unparseable lock file → reclaim
  if (stale) {
    try { unlinkSync(lockPath); } catch { /* raced with another process → retry below fails cleanly */ }
    if (tryCreate()) return { lockPath };
  }
  return { error: { message: 'another run in progress',
    hint: 'Another govern run holds .kb/govern/run.lock. If the previous run crashed, the lock goes stale after 2h and is reclaimed automatically; you may also delete .kb/govern/run.lock manually.' } };
}
function releaseLock(lock) { try { unlinkSync(lock.lockPath); } catch { /* already gone — fine */ } }

// ---- small IO helpers (writeJsonAtomic replicated from acquire.mjs — the shared segment stays untouched) ----
function writeJsonAtomic(path, obj) { // temp file + rename: never leave a half-written state file
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  renameSync(tmp, path);
}
function writeFileAtomic(path, text) { // temp + rename for wiki page writes (sweep / index rebuild)
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}
function writeLinesAtomic(path, lines) { // decisions.jsonl: full read + append + temp+rename (append-only, small per §2.6)
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  renameSync(tmp, path);
}

function parseFile(kbDir, rel) { // → { ok, data, body }; never throws
  let text;
  try { text = readFileSync(join(kbDir, rel), 'utf8'); }
  catch (e) { return { ok: false, error: e, data: null, body: null }; }
  try { const { data, body } = splitFrontmatter(text); return { ok: true, data, body }; }
  catch (e) { return { ok: false, error: e, data: null, body: null }; }
}

// tombstones are fail-closed (same semantics as acquire.mjs readTombstones)
function readTombstones(kbDir) {
  const p = join(kbDir, '.kb', 'govern', 'source-tombstones.json');
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, 'utf8')); }
  catch {
    throw new GovernAbort('corrupt-tombstones', '.kb/govern/source-tombstones.json exists but is not valid JSON',
      'Fix or delete .kb/govern/source-tombstones.json — tombstone suppression is fail-closed; govern refuses to plan while it is unreadable.');
  }
}

// topic registry: fail-closed like the other .kb/govern state files (spec ch. 10 inventory row)
function readTopicRegistry(kbDir) {
  const p = join(kbDir, '.kb', 'govern', 'topic-registry.json');
  if (!existsSync(p)) return { topics: [] };
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    return { topics: Array.isArray(j && j.topics) ? j.topics : [] };
  } catch {
    throw new GovernAbort('corrupt-topic-registry', '.kb/govern/topic-registry.json exists but is not valid JSON',
      'Fix or delete .kb/govern/topic-registry.json — registry state is fail-closed; govern refuses to build the topic index while it is unreadable.');
  }
}
// §4.1 step 4: topics count as the same topic only when equal after slug normalization
function normalizeTopic(t) {
  return String(t).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// ==== sweep (§4.1 step 1) ====
function runSweep(kbDir) {
  const archived = [];
  const dir = join(kbDir, 'wiki', 'archive');
  if (!existsSync(dir)) return { archived };
  for (const rel0 of walkFiles(dir, p => p.endsWith('.md'))) {
    const rel = 'wiki/archive/' + rel0;
    const p = parseFile(kbDir, rel);
    if (!p.ok || !p.data || p.data.status !== 'rejected') continue; // already archived / unparseable → untouched
    p.data.status = 'archived';
    writeFileAtomic(join(kbDir, rel), serializeFrontmatter(p.data, p.body));
    appendLog(kbDir, 'govern', 'sweep', rel, 'rejected → archived');
    archived.push(rel);
  }
  return { archived };
}

// ==== plan (§4.1 step 2) ====
function tokenize(body) { // lowercase ASCII words + CJK bigrams
  const tokens = new Set();
  const s = String(body);
  for (const m of s.toLowerCase().matchAll(/[a-z0-9]+/g)) tokens.add(m[0]);
  for (const m of s.matchAll(/[㐀-䶿一-鿿]+/g)) {
    const run = m[0];
    if (run.length === 1) { tokens.add(run); continue; }
    for (let i = 0; i + 1 < run.length; i++) tokens.add(run.slice(i, i + 2));
  }
  return tokens;
}
function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]; // iterate the smaller set
  let inter = 0;
  for (const t of small) if (large.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

function collectWiki(kbDir) { // → { approved, sourcePageByRef } over wiki/ (archive/, index.md, *.candidate.md excluded)
  const approved = [];
  const sourcePageByRef = new Map(); // '<source>/<source_id>' → page rel path
  const wikiDir = join(kbDir, 'wiki');
  if (!existsSync(wikiDir)) return { approved, sourcePageByRef };
  for (const rel0 of walkFiles(wikiDir, p => p.endsWith('.md') && p !== 'index.md' && !p.startsWith('archive/') && !p.endsWith('.candidate.md'))) {
    const rel = 'wiki/' + rel0;
    const p = parseFile(kbDir, rel);
    if (!p.ok || !p.data || p.data.status !== 'approved') continue;
    const page = { rel, slug: basename(rel, '.md'), data: p.data, body: p.body };
    approved.push(page);
    if (rel.startsWith('wiki/sources/') && p.data.source_ref !== undefined && p.data.source_ref !== null)
      sourcePageByRef.set(String(p.data.source_ref), rel);
  }
  return { approved, sourcePageByRef };
}

function planRawLists(kbDir, result, tombstones, sourcePageByRef) {
  const rawDir = join(kbDir, 'raw');
  const allRaws = existsSync(rawDir)
    ? walkFiles(rawDir, p => p.endsWith('.md') && !p.startsWith('assets/')).map(p => 'raw/' + p)
    : [];
  const valid = []; // { rel, data } — contract-valid raws only
  for (const rel of allRaws) {
    const p = parseFile(kbDir, rel);
    if (!p.ok || !p.data) { result.errors.push({ file: rel, kind: 'unparseable' }); continue; }
    const src = p.data.source ?? rel.split('/')[1];
    const required = src === 'jira' ? [...RAW_REQUIRED, 'issue_type'] : RAW_REQUIRED;
    const missing = required.filter(k => p.data[k] === undefined || p.data[k] === null);
    if (missing.length) { result.errors.push({ file: rel, kind: 'missing-fields', missing }); continue; }
    valid.push({ rel, data: p.data });
  }

  const baseline = findBaseline(kbDir);
  const changed = new Set();
  if (baseline) {
    const diff = gitOut(kbDir, ['diff', '--name-only', baseline, '--', 'raw/']); // baseline → working tree (tracked)
    if (diff) for (const p of diff.split('\n')) changed.add(p.trim());
    const porc = gitRaw(kbDir, ['status', '--porcelain', 'raw/']); // untracked + staged
    if (porc) for (const p of porcelainPaths(porc)) changed.add(p);
  }

  for (const { rel, data } of valid) {
    const key = `raw:${data.source}/${data.source_id}`;
    if (key in tombstones) {
      const t = tombstones[key];
      result.suppressed.push({ raw: rel, tombstone: { reason: t && t.reason !== undefined ? t.reason : null, decision: t && t.decision !== undefined ? t.decision : null } });
      continue; // §2.6: tombstoned raws are never listed elsewhere
    }
    const page = sourcePageByRef.get(`${data.source}/${data.source_id}`) ?? null;
    if (!baseline) { // no baseline → conservative: no page → new, page → stale; no anomalies
      result.pending.push({ raw: rel, status: page ? 'stale' : 'new' });
      continue;
    }
    const isChanged = changed.has(rel);
    if (!page) result.pending.push({ raw: rel, status: 'new' });
    else if (isChanged) result.pending.push({ raw: rel, status: 'stale' });
    // anomaly: changed since baseline AND old hash ≠ new hash AND old source_version == new source_version (§2.2: manual exempt)
    if (isChanged) {
      const oldText = gitOut(kbDir, ['show', `${baseline}:${rel}`]);
      if (oldText !== null) {
        let oldData = null;
        try { oldData = splitFrontmatter(oldText).data; } catch { oldData = null; }
        if (oldData) {
          const [oh, nh] = [oldData.content_hash, data.content_hash];
          const [ov, nv] = [oldData.source_version, data.source_version];
          if (oh !== undefined && oh !== null && nh !== undefined && nh !== null && oh !== 'manual' && nh !== 'manual'
              && String(oh) !== String(nh) && String(ov ?? '') === String(nv ?? ''))
            result.anomalies.push({ raw: rel, page, kind: 'hash-changed-version-unchanged' });
        }
      }
    }
  }
  return baseline;
}

function planReviewQueue(kbDir, result) {
  const wikiDir = join(kbDir, 'wiki');
  if (!existsSync(wikiDir)) return;
  for (const rel0 of walkFiles(wikiDir, p => p.endsWith('.candidate.md') && !p.startsWith('archive/'))) {
    const rel = 'wiki/' + rel0;
    let base = null, note = '(missing review_note)';
    const p = parseFile(kbDir, rel);
    if (p.ok && p.data) {
      if ('base' in p.data) base = p.data.base;
      if (p.data.review_note !== undefined && p.data.review_note !== null) note = String(p.data.review_note);
    }
    result.review_queue.push({ candidate: rel, base, review_note: note });
  }
}

function planHumanLists(kbDir, result, approved, baseline) {
  const hl = result.human_lists;
  const approvedSlugs = new Set(approved.map(p => p.slug));

  // orphan: approved page with zero inbound wikilinks from OTHER approved pages
  const inbound = new Set();
  for (const p of approved)
    for (const m of p.body.matchAll(WIKILINK_RE)) {
      const t = m[1].trim();
      if (t !== p.slug && approvedSlugs.has(t)) inbound.add(t);
    }
  for (const p of approved)
    if (!inbound.has(p.slug)) hl.push({ kind: 'orphan', page: p.rel });

  // dangling-link: approved page links a slug no approved page has (one entry per page+target)
  for (const p of approved) {
    const seen = new Set();
    for (const m of p.body.matchAll(WIKILINK_RE)) {
      const t = m[1].trim();
      if (!approvedSlugs.has(t) && !seen.has(t)) { seen.add(t); hl.push({ kind: 'dangling-link', page: p.rel, target: t }); }
    }
  }

  // conflict-pair: pairwise over approved SOURCE pages, body-token Jaccard ≥ 0.5, dismissals suppressed
  const sourcePages = approved.filter(p => p.data.type === 'source');
  const rawRefOf = new Map(); // page rel → 'raw:<source_ref>'
  for (const p of sourcePages)
    if (p.data.source_ref !== undefined && p.data.source_ref !== null) rawRefOf.set(p.rel, 'raw:' + String(p.data.source_ref));
  const dismissalsPath = join(kbDir, '.kb', 'govern', 'conflict-dismissals.json');
  const dismissals = existsSync(dismissalsPath) ? readJsonSafe(dismissalsPath, []) : [];
  const normEl = (el) => { const s = String(el ?? ''); return s.startsWith('raw:') ? s : (rawRefOf.get(s) ?? s); };
  const dismissed = new Set();
  if (Array.isArray(dismissals))
    for (const d of dismissals)
      if (d && typeof d === 'object') dismissed.add([normEl(d.a), normEl(d.b)].sort().join(' '));
  const pairs = [];
  const tokenSets = sourcePages.map(p => tokenize(p.body));
  for (let i = 0; i < sourcePages.length; i++) {
    for (let j = i + 1; j < sourcePages.length; j++) {
      const sim = jaccard(tokenSets[i], tokenSets[j]);
      if (sim < CONFLICT_PAIR_MIN_SIMILARITY) continue;
      const [a, b] = [sourcePages[i].rel, sourcePages[j].rel].sort();
      const key = [rawRefOf.get(sourcePages[i].rel) ?? sourcePages[i].rel, rawRefOf.get(sourcePages[j].rel) ?? sourcePages[j].rel].sort().join(' ');
      if (dismissed.has(key)) continue;
      pairs.push({ kind: 'conflict-pair', a, b, similarity: Math.round(sim * 100) / 100 });
    }
  }
  if (pairs.length > CONFLICT_PAIR_CAP) {
    warn(`warning: ${pairs.length} conflict pairs exceed the ${CONFLICT_PAIR_CAP}-pair cap; list truncated`);
    pairs.length = CONFLICT_PAIR_CAP;
  }
  hl.push(...pairs);

  // hand-edit: since baseline, non-govern/review/acquire commits touching wiki/ + working-tree modifications
  if (isGitRepo(kbDir)) {
    const handEdits = [];
    const range = baseline ? [`${baseline}..HEAD`] : [];
    const log = gitOut(kbDir, ['log', '--format=%H%x00%s', ...range, '--', 'wiki/']);
    if (log) {
      for (const line of log.split('\n')) {
        const i = line.indexOf('\0');
        if (i < 0) continue;
        const [sha, subj] = [line.slice(0, i), line.slice(i + 1)];
        if (subj.startsWith('govern:') || subj.startsWith('review:') || subj.startsWith('acquire:')) continue;
        const files = gitOut(kbDir, ['diff-tree', '--no-commit-id', '--name-only', '-r', sha, '--', 'wiki/']);
        if (files) for (const f of files.split('\n')) handEdits.push({ kind: 'hand-edit', page: f.trim(), commit: sha });
      }
    }
    const porc = gitRaw(kbDir, ['status', '--porcelain', 'wiki/']);
    if (porc) for (const p of porcelainPaths(porc)) handEdits.push({ kind: 'hand-edit', page: p, commit: '(working-tree)' });
    if (handEdits.length > HAND_EDIT_CAP) {
      warn(`warning: ${handEdits.length} hand-edit entries exceed the ${HAND_EDIT_CAP}-entry cap; list truncated`);
      handEdits.length = HAND_EDIT_CAP;
    }
    hl.push(...handEdits);
  }

  // missing-raw (approved extension): source page whose source_ref raw file no longer exists
  for (const p of sourcePages) {
    const ref = p.data.source_ref;
    if (ref === undefined || ref === null) continue;
    const m = String(ref).match(/^([A-Za-z0-9_-]+)\/([A-Za-z0-9][A-Za-z0-9_-]*)$/);
    if (m && !existsSync(join(kbDir, 'raw', m[1], m[2] + '.md')))
      hl.push({ kind: 'missing-raw', page: p.rel, source_ref: String(ref) });
  }
}

function runPlan(kbDir) {
  const result = { pending: [], anomalies: [], errors: [], review_queue: [], human_lists: [], suppressed: [] };
  const tombstones = readTombstones(kbDir); // fail-closed
  const { approved, sourcePageByRef } = collectWiki(kbDir);
  const baseline = planRawLists(kbDir, result, tombstones, sourcePageByRef);
  planReviewQueue(kbDir, result);
  planHumanLists(kbDir, result, approved, baseline);
  writeJsonAtomic(join(kbDir, '.kb', 'govern', 'last-plan.json'), { ...result, ts: new Date().toISOString() });
  return result;
}

// ==== rebuild-index (§2.4) ====
function runRebuildIndex(kbDir) {
  const groups = { sources: [], syntheses: [], concepts: [], entities: [] };
  for (const g of Object.keys(groups)) {
    const dir = join(kbDir, 'wiki', g);
    if (!existsSync(dir)) continue;
    for (const rel0 of walkFiles(dir, p => p.endsWith('.md') && !p.endsWith('.candidate.md'))) {
      const rel = `wiki/${g}/` + rel0;
      const p = parseFile(kbDir, rel);
      if (!p.ok) { warn(`warning: skipping ${rel}: unparseable frontmatter (${p.error.message})`); continue; }
      if (!p.data || p.data.status !== 'approved') continue;
      groups[g].push({ slug: basename(rel, '.md'), fm: p.data });
    }
  }
  const dateOf = (fm) => String(fm.updated_at ?? '').slice(0, 10);
  const lineOf = (g, { slug, fm }) => {
    const head = `- [[${slug}|${fm.title ?? slug}]] — ${fm.summary ?? ''}`;
    if (g === 'sources') return `${head} (${fm.source_ref ?? ''}, updated ${dateOf(fm)})`;
    if (g === 'syntheses') return `${head} (${Array.isArray(fm.sources) ? fm.sources.length : 0} sources, updated ${dateOf(fm)})`;
    if (g === 'entities' && fm.kind !== undefined && fm.kind !== null) return `${head} (${fm.kind}, updated ${dateOf(fm)})`;
    return `${head} (updated ${dateOf(fm)})`;
  };

  // §7 scale envelope: past TOPIC_INDEX_THRESHOLD approved pages, also emit wiki/topics.md —
  // the Tier 0.5 topic → page map the retrieval protocol reads instead of the whole index.md.
  const total = Object.values(groups).reduce((n, g) => n + g.length, 0);
  const topicsPath = join(kbDir, 'wiki', 'topics.md');
  let topicsWritten = false, topicsRemoved = false;
  if (total > TOPIC_INDEX_THRESHOLD) {
    const registry = readTopicRegistry(kbDir); // fail-closed
    const byTopic = new Map(); // topic → Map(slug → line) (map dedups a page hooked to the same topic twice)
    const SINGULAR = { sources: 'source', syntheses: 'synthesis', concepts: 'concept', entities: 'entity' };
    const add = (topic, g, it) => {
      if (topic === '') return;
      if (!byTopic.has(topic)) byTopic.set(topic, new Map());
      byTopic.get(topic).set(it.slug, `- [[${it.slug}|${it.fm.title ?? it.slug}]] — ${it.fm.summary ?? ''} (${SINGULAR[g]}, updated ${dateOf(it.fm)})`);
    };
    for (const it of groups.sources)
      for (const t of Array.isArray(it.fm.related_topics) ? it.fm.related_topics : []) add(normalizeTopic(t), 'sources', it);
    const synthBySlug = new Map(groups.syntheses.map(it => [it.slug, it]));
    for (const entry of registry.topics) { // registry is the topic → synthesis authority
      const slug = typeof entry.synthesis === 'string' ? basename(entry.synthesis, '.md') : normalizeTopic(entry.topic ?? '');
      const it = synthBySlug.get(slug);
      if (it) add(normalizeTopic(entry.topic ?? slug), 'syntheses', it);
    }
    for (const it of groups.syntheses) add(it.slug, 'syntheses', it); // unregistered syntheses still map under their own slug
    let tText = '# Topic Index\n\n> Mechanical derivative of a govern run — do not hand-edit (§2.8). Tier 0.5 topic → page map (§7 scale envelope); read this instead of the whole index.md past 500 pages.\n';
    for (const topic of [...byTopic.keys()].sort()) {
      tText += `\n## ${topic}\n`;
      for (const slug of [...byTopic.get(topic).keys()].sort()) tText += byTopic.get(topic).get(slug) + '\n';
    }
    writeFileAtomic(topicsPath, tText);
    topicsWritten = true;
  } else if (existsSync(topicsPath)) {
    unlinkSync(topicsPath); // stale derivative: back under the threshold → remove
    topicsRemoved = true;
  }

  let text = '# Wiki Index\n\n> Mechanical derivative of a govern run — do not hand-edit (§2.8).\n';
  if (topicsWritten) text += '> 500+ pages: use the topic → page map at wiki/topics.md as Tier 0.5 (§7); read this file by section.\n';
  const counts = {};
  for (const g of Object.keys(groups)) {
    const items = groups[g].sort((a, b) => a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);
    counts[g] = items.length;
    text += `\n## ${g}\n`;
    for (const it of items) text += lineOf(g, it) + '\n';
  }
  writeFileAtomic(join(kbDir, 'wiki', 'index.md'), text);

  appendFileSync(join(kbDir, '.kb', 'govern', 'runs.jsonl'),
    JSON.stringify({ ts: new Date().toISOString(), status: 'completed', stats: { ...counts } }) + '\n');

  // §2.8: best-effort commit 'govern: run <ISO8601>' — failure → warnings, exit stays 0 (acquire's commitKbBatch pattern).
  // Staging is scoped to what govern owns (wiki/ + log.md): the KB may be NESTED in a larger repo, and an
  // unscoped `git add -A` would commit unrelated user work at the enclosing root. .kb/ is gitignored per §2.1.
  const warnings = [];
  try {
    const env = { ...process.env,
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || 'llm-wiki-govern',
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || 'llm-wiki@localhost',
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || 'llm-wiki-govern',
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || 'llm-wiki@localhost' };
    execFileSync('git', [...GIT_GLOBAL, '-C', kbDir, 'add', '-A', '--', 'wiki', 'log.md'], { encoding: 'utf8', env });
    const dirty = execFileSync('git', [...GIT_GLOBAL, '-C', kbDir, 'status', '--porcelain', '--', 'wiki', 'log.md'], { encoding: 'utf8', env }).trim();
    if (dirty !== '') execFileSync('git', [...GIT_GLOBAL, '-C', kbDir, 'commit', '-m', `govern: run ${new Date().toISOString()}`], { encoding: 'utf8', env });
  } catch (e) {
    warnings.push(`git commit failed: ${String(e && e.message || e).split('\n')[0]}`);
  }

  const result = { written: 'wiki/index.md', counts };
  if (topicsWritten) result.topics_index = 'wiki/topics.md';
  if (topicsRemoved) result.topics_index_removed = true;
  if (warnings.length) result.warnings = warnings;
  return result;
}

// ==== fold (§4.1 step 4) — mechanical serial fold executor ====
// The agent composes folds.json (one entry per source, in fold order = source_version ascending);
// composing IS the semantic-check — the file is the structured evidence. This executor applies the
// folds STRICTLY SERIALLY, gating each on validate --file (incl. the refusion-retention guardrail).
// A failed fold restores the last-good page and stops the chain; the agent turns the offending fold
// into a sidecar candidate (chain-break semantics stay agent-side: the colliding-pair review_note
// needs judgment this script does not have).
const FOLD_PAGE_RE = /^wiki\/(syntheses|concepts|entities)\/([a-z0-9][a-z0-9-]*)\.md$/;
const FOLD_REF_RE = /^raw:(jira|confluence|chat|local|openwiki)\/([A-Za-z0-9][A-Za-z0-9_-]*)$/;

function runFold(kbDir, args) {
  const m = typeof args.page === 'string' ? args.page.match(FOLD_PAGE_RE) : null;
  if (!m) throw new GovernAbort('usage',
    `fold --page must match wiki/<syntheses|concepts|entities>/<slug>.md, got '${args.page}'`, USAGE);
  const typeDir = m[1], slug = m[2];
  const type = { syntheses: 'synthesis', concepts: 'concept', entities: 'entity' }[typeDir];
  if (args.folds === undefined) throw new GovernAbort('usage', 'fold requires --folds <folds.json>', USAGE);

  let folds;
  try { folds = JSON.parse(readFileSync(args.folds, 'utf8')); }
  catch (e) {
    throw new GovernAbort('folds-unreadable', `cannot read/parse folds file '${args.folds}': ${String(e && e.message || e).split('\n')[0]}`,
      'folds.json is an array of { "ref": "raw:<source>/<source_id>", "paragraph": "<tagged narrative>", "page": "<source page slug, optional>" } in fold order (source_version ascending).');
  }
  if (!Array.isArray(folds)) throw new GovernAbort('folds-unreadable', 'folds.json must be a JSON array', USAGE);
  for (let k = 0; k < folds.length; k++) {
    const f = folds[k];
    if (!f || typeof f.ref !== 'string' || !FOLD_REF_RE.test(f.ref) || typeof f.paragraph !== 'string' || f.paragraph.trim() === '')
      throw new GovernAbort('folds-unreadable', `folds.json entry ${k + 1} needs a "ref" of form raw:<source>/<source_id> and a non-empty "paragraph"`, USAGE);
    if (f.page !== undefined && (typeof f.page !== 'string' || !SLUG_RE.test(f.page)))
      throw new GovernAbort('folds-unreadable', `folds.json entry ${k + 1} has an invalid "page" slug '${f.page}'`, USAGE);
  }

  const pageAbs = join(kbDir, args.page);
  const exists = existsSync(pageAbs);
  if (!exists && (args.title === undefined || args.summary === undefined))
    throw new GovernAbort('usage', `page '${args.page}' does not exist; creating it requires --title and --summary`, USAGE);

  const validatePath = fileURLToPath(new URL('validate.mjs', import.meta.url)); // sibling script
  const srcLine = (f) => `- ${f.ref} — [[${f.page ?? f.ref.match(FOLD_REF_RE)[2]}]]`;

  const folded = [], skipped = [];
  for (let k = 0; k < folds.length; k++) {
    const f = folds[k];
    const now = new Date().toISOString();
    const prev = existsSync(pageAbs) ? readFileSync(pageAbs, 'utf8') : null;
    let content;
    if (prev === null) { // first fold creates the page (fold 1 of a new page has no merge base)
      content = `---\ntype: ${type}\nstatus: approved\ntitle: ${args.title}\nsummary: ${args.summary}\ncreated_at: ${now}\nupdated_at: ${now}\nsources: [${f.ref}]\n---\n\n## Narrative\n\n${f.paragraph}\n\n## Open Questions\n\nNone surfaced this run.\n\n## Sources\n\n${srcLine(f)}\n`;
    } else {
      let p;
      try { p = splitFrontmatter(prev); }
      catch (e) { // unparseable frontmatter: never guessed or auto-repaired (fail-closed inventory)
        throw new GovernAbort('page-unparseable', `cannot parse frontmatter of '${args.page}': ${String(e && e.message || e).split('\n')[0]}`,
          'Fix the page frontmatter by hand, then re-run the fold.');
      }
      const cur = Array.isArray(p.data.sources) ? p.data.sources.map(String) : [];
      if (cur.includes(f.ref)) { skipped.push(f.ref); continue; } // resume by structure: already folded
      p.data.updated_at = now;
      p.data.sources = [...cur, f.ref];
      let body = p.body;
      if (/\n## Open Questions/.test(body)) body = body.replace(/\n## Open Questions/, `\n${f.paragraph}\n\n## Open Questions`);
      else body = body.replace(/\s*$/, '') + `\n\n${f.paragraph}\n`; // no Open Questions anchor (concept/entity) → append
      if (/\n## Sources\n/.test(body)) body = body.replace(/\s*$/, '') + `\n${srcLine(f)}\n`;
      else body = body.replace(/\s*$/, '') + `\n\n## Sources\n\n${srcLine(f)}\n`;
      content = serializeFrontmatter(p.data, body);
    }
    writeFileAtomic(pageAbs, content);
    const v = spawnSync(process.execPath, [validatePath, '--kb', kbDir, '--file', args.page], { encoding: 'utf8' });
    let passed = false;
    try { passed = JSON.parse(v.stdout).passed === true; } catch { /* unparseable validator output = not passed (fail-closed) */ }
    if (v.status !== 0 || !passed) {
      if (prev === null) { try { unlinkSync(pageAbs); } catch { /* best effort */ } }
      else writeFileAtomic(pageAbs, prev); // last-good page stands
      throw new GovernAbort('fold-gate',
        `fold ${k + 1}/${folds.length} (${f.ref}) failed validate — chain stops; last-good page restored. validate stdout: ${String(v.stdout).replace(/\s+/g, ' ').slice(0, 500)}`,
        'Fix the fold or turn it into a sidecar candidate (review_note first line: conflict: <kind> | parties: <a> vs <b>); the remaining sources resume next run (cluster members − page.sources).');
    }
    folded.push(f.ref);
    appendLog(kbDir, 'govern', 'auto:apply', args.page, `fold ${folded.length + skipped.length}/${folds.length}: +${f.ref}`);
  }
  return { page: args.page, folded, skipped };
}

// ==== record-decision (§2.6) ====
function runRecordDecision(kbDir, args) {
  const path = join(kbDir, '.kb', 'govern', 'decisions.jsonl');
  const decisions = [];
  if (existsSync(path)) {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      try { decisions.push(JSON.parse(line)); }
      catch { warn(`warning: skipping unparseable decisions.jsonl line: ${line.slice(0, 80)}`); } // §2.6 读容错
    }
  }
  const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  const idRe = new RegExp(`^d-${day}-(\\d+)$`);
  let maxSeq = 0;
  for (const d of decisions) {
    const m = typeof d.id === 'string' ? d.id.match(idRe) : null;
    if (m) maxSeq = Math.max(maxSeq, Number(m[1]));
  }
  const decision = { id: `d-${day}-${String(maxSeq + 1).padStart(3, '0')}`, ts: new Date().toISOString(),
    actor: args.actor, action: args.action, page: args.page };
  if (args.reason !== undefined) decision.reason = args.reason; // human
  if (args.cited !== undefined) decision.cited = args.cited; // agent
  decisions.push(decision);
  writeLinesAtomic(path, decisions);
  // §2.5 mapping: human → review actor; agent automatic action → govern | auto:<action>
  if (args.actor === 'human') appendLog(kbDir, 'review', args.action, args.page, args.reason);
  else appendLog(kbDir, 'govern', `auto:${args.action}`, args.page, `cited=[${(args.cited ?? []).join(',')}]`);
  return decision;
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
  if (!SUBCOMMANDS.includes(args.cmd)) return fail(64, `unknown subcommand '${args.cmd}'`, USAGE);
  if (args.cmd !== 'record-decision'
      && (args.actor !== undefined || args.action !== undefined || args.reason !== undefined || args.cited !== undefined))
    return fail(64, '--actor/--action/--reason/--cited only apply to record-decision', USAGE);
  if (args.cmd !== 'fold'
      && (args.folds !== undefined || args.title !== undefined || args.summary !== undefined))
    return fail(64, '--folds/--title/--summary only apply to fold', USAGE);
  if (args.cmd !== 'record-decision' && args.cmd !== 'fold' && args.page !== undefined)
    return fail(64, '--page only applies to record-decision and fold', USAGE);
  if (args.cmd === 'record-decision') {
    if (args.actor !== 'human' && args.actor !== 'agent')
      return fail(64, `--actor must be human or agent, got '${args.actor}'`, USAGE);
    if (!DECISION_ACTIONS.includes(args.action))
      return fail(64, `--action must be one of: ${DECISION_ACTIONS.join(', ')}`, USAGE);
    if (args.page === undefined) return fail(64, 'missing --page', USAGE);
    if (args.actor === 'human' && (args.reason === undefined || args.reason.trim() === ''))
      return fail(64, '--actor human requires a non-empty --reason', USAGE);
    if (args.actor === 'agent' && args.cited === undefined)
      return fail(64, '--actor agent requires the --cited flag (the value may be empty, e.g. --cited "")', USAGE);
  }

  let lock;
  try { lock = acquireLock(r.kb); }
  catch (e) { return fail(1, 'internal error', String(e && e.message || e)); }
  if (lock.error) return fail(1, lock.error.message, lock.error.hint);
  try {
    let result;
    if (args.cmd === 'sweep') result = runSweep(r.kb);
    else if (args.cmd === 'plan') result = runPlan(r.kb);
    else if (args.cmd === 'rebuild-index') result = runRebuildIndex(r.kb);
    else if (args.cmd === 'fold') result = runFold(r.kb, args);
    else result = runRecordDecision(r.kb, args);
    out(result);
    return EXIT.OK;
  } catch (e) {
    if (e instanceof GovernAbort) { out({ error: { code: e.code, message: e.message, hint: e.hint } }); return e.code === 'usage' ? EXIT.USAGE : EXIT.FAIL; }
    return fail(1, 'internal error', String(e && e.message || e));
  } finally {
    releaseLock(lock);
  }
}

export { EXIT, CONTRACT_VERSION, SOURCE_ID_RE, SLUG_RE, RAW_SOURCES, PAGE_TYPES, PAGE_STATUSES, DECISION_ACTIONS,
  out, warn, fail, resolveKb, checkKb, splitFrontmatter, parseFrontmatter, serializeFrontmatter, contentHash,
  appendLog, walkFiles, readJsonSafe, parseBoolFlag,
  parseArgs, parseCited, acquireLock, releaseLock, findBaseline, tokenize, jaccard,
  runSweep, runPlan, runRebuildIndex, runFold, runRecordDecision, main };

// robust isMain: fileURLToPath comparison survives '#', '?', '%' in script paths (URL-building does not)
// exitCode (not process.exit): natural exit lets any pending handles drain (acquire.mjs pattern)
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) { process.exitCode = await main(process.argv.slice(2)); }
