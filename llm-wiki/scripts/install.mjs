#!/usr/bin/env node
// === imports (node builtins only) ===
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, appendFileSync, readdirSync, existsSync, lstatSync, symlinkSync, readlinkSync, cpSync, rmSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
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

// install.mjs projects the skill dir (parent of this script's dir) to <target>/llm-wiki (§9).
// Unlike the other four scripts it needs no KB: the exit-64/65 KB contract does not apply here.
const USAGE = 'Usage: node install.mjs [update] [--target <dir>]  (default target: ~/.agents/skills)';
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = dirname(SCRIPT_DIR); // the skill directory being projected (contains SKILL.md, CHANGELOG.md, ...)
const STAMP_FILE = '.install-source.json'; // written into copy-mode destinations: {source, version, installed_at}
const DEFAULT_TARGET = '~/.agents/skills';

const fwd = (p) => String(p).replace(/\\/g, '/'); // §1.4: stdout paths are always forward-slashed

function expandHome(p) { // '~' → homedir; '~/<rest>' (or '~\<rest>') → homedir/<rest>; anything else passes through
  const s = String(p);
  if (s === '~') return homedir();
  if (s.startsWith('~/') || s.startsWith('~\\')) return join(homedir(), s.slice(2));
  return s;
}
function resolveTarget(targetArg) { // → absolute <target> dir; the skill lands in <target>/llm-wiki
  return resolve(expandHome(targetArg || DEFAULT_TARGET));
}

function readVersion() { // first '## [x.y.z]' heading in ../CHANGELOG.md; unparseable → '0.0.0' + stderr warning
  try {
    const m = readFileSync(join(SKILL_DIR, 'CHANGELOG.md'), 'utf8').match(/^## \[(\d+\.\d+\.\d+)\]/m);
    if (m) return m[1];
  } catch { /* fall through to the warning */ }
  warn('warning: cannot parse a version from CHANGELOG.md; using 0.0.0');
  return '0.0.0';
}

function parseArgs(argv) {
  const opts = { update: false };
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
      case '--target': opts.target = need(); break;
      case 'update':
        if (v !== undefined || opts.update) throw new Error(`unexpected argument '${argv[i]}'`);
        opts.update = true; break;
      default: throw new Error(a.startsWith('--') ? `unknown flag '${a}'` : `unexpected argument '${a}'`);
    }
  }
  return opts;
}

function isLink(p) {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; } // covers broken links (existsSync misses them)
}
function linkPointsTo(dest) { // absolute path the link resolves to; null if unreadable
  try {
    const t = readlinkSync(dest);
    return isAbsolute(t) ? resolve(t) : resolve(dirname(dest), t);
  } catch { return null; }
}
function samePath(a, b) { // tolerate Windows \\?\ prefixes and case-insensitive filesystems
  const n = (p) => resolve(String(p).replace(/^\\\\\?\\/, ''));
  return process.platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
}

function readStamp(dest) { // valid stamp = parseable JSON with string source+version; anything else → null
  try {
    const j = JSON.parse(readFileSync(join(dest, STAMP_FILE), 'utf8'));
    if (j && typeof j.source === 'string' && typeof j.version === 'string') return j;
  } catch { /* missing or corrupt stamp */ }
  return null;
}
function writeStamp(dest, version) {
  writeFileSync(join(dest, STAMP_FILE), JSON.stringify({ source: fwd(resolve(SKILL_DIR)), version, installed_at: new Date().toISOString() }, null, 2) + '\n');
}

function tryLink(dest) { // → 'junction' | 'symlink' | null (null → caller falls back to copy)
  // LLM_WIKI_INSTALL_FORCE=copy: test/debug hook that skips the link attempt and forces the copy path.
  if (process.env.LLM_WIKI_INSTALL_FORCE === 'copy') return null;
  try {
    if (process.platform === 'win32') { symlinkSync(resolve(SKILL_DIR), dest, 'junction'); return 'junction'; }
    symlinkSync(resolve(SKILL_DIR), dest, 'dir'); return 'symlink';
  } catch (e) {
    warn(`warning: link failed (${(e && e.code) || e}); falling back to full copy`);
    return null;
  }
}
function copyIn(dest, version) { // recursive whole-dir copy + version stamp (§9 fallback semantics)
  cpSync(resolve(SKILL_DIR), dest, { recursive: true });
  writeStamp(dest, version);
  return 'copy';
}

// → { target, mode, version, warnings } on success, or { error, message, hint } on refusal
function project({ target, update = false } = {}) {
  const version = readVersion();
  const warnings = [];
  const dest = join(target, 'llm-wiki');
  const srcFwd = fwd(resolve(SKILL_DIR));
  mkdirSync(target, { recursive: true });

  let mode;
  if (isLink(dest)) {
    // existing symlink/junction
    const pointedAt = linkPointsTo(dest);
    const good = pointedAt !== null && samePath(pointedAt, SKILL_DIR);
    if (update && good) {
      mode = process.platform === 'win32' ? 'junction' : 'symlink'; // verified: still resolves to the current source — leave untouched
    } else {
      if (update && !good) warnings.push(`target drifted: link pointed at ${pointedAt === null ? '<unreadable>' : fwd(pointedAt)}, rebuilt to ${srcFwd}`);
      rmSync(dest, { recursive: true, force: true }); // rm never follows the link — only the link itself is removed
      mode = tryLink(dest) || copyIn(dest, version);
    }
  } else if (existsSync(dest)) {
    // existing real directory (or file): only proceed with a valid stamp — never clobber foreign content
    const stamp = readStamp(dest);
    if (!stamp) return { error: 'target exists and was not installed by this tool; remove it manually or pick another --target', hint: `'${fwd(dest)}' exists but is neither a link nor a directory with a valid ${STAMP_FILE} stamp.` };
    if (update && (stamp.source !== srcFwd || stamp.version !== version))
      warnings.push(`target drifted: installed ${stamp.version} from ${stamp.source}, now ${version} from ${srcFwd}`);
    rmSync(dest, { recursive: true, force: true });
    mode = copyIn(dest, version); // a stamped dir stays copy-mode: delete old copy, re-copy, rewrite stamp
  } else {
    mode = tryLink(dest) || copyIn(dest, version); // fresh projection: link first, copy fallback
  }
  return { target: fwd(dest), mode, version, warnings };
}

// === main(argv) ===
async function main(argv) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { return fail(64, e.message, USAGE); }
  let res;
  try { res = project({ target: resolveTarget(opts.target), update: opts.update }); }
  catch (e) { return fail(1, 'internal error', String(e && e.message || e)); }
  if (res.error) return fail(1, res.error, res.hint);
  out(res);
  return EXIT.OK;
}

export { EXIT, CONTRACT_VERSION, SOURCE_ID_RE, SLUG_RE, RAW_SOURCES, PAGE_TYPES, PAGE_STATUSES, DECISION_ACTIONS,
  out, warn, fail, resolveKb, checkKb, splitFrontmatter, parseFrontmatter, serializeFrontmatter, contentHash,
  appendLog, walkFiles, readJsonSafe, parseBoolFlag, USAGE, SKILL_DIR, STAMP_FILE,
  expandHome, resolveTarget, readVersion, parseArgs, isLink, linkPointsTo, samePath, readStamp, project, main };

// robust isMain: fileURLToPath comparison survives '#', '?', '%' in script paths (URL-building does not)
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) { const code = await main(process.argv.slice(2)); process.exit(code); }
