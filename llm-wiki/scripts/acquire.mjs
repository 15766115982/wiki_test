#!/usr/bin/env node
// === imports (node builtins only) ===
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, appendFileSync, readdirSync, existsSync, statSync, mkdirSync, unlinkSync, renameSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

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

const USAGE = 'Usage: node acquire.mjs <jira|confluence> --kb <path> --selector <value> [--selector-type url|key|jql|cql] [--detect-only] [--force]\n' +
  '       node acquire.mjs openwiki --kb <path> --repo <path> [--subdir <dir>] [--detect-only]';
const SUBCOMMANDS = ['jira', 'confluence', 'openwiki'];
const SELECTOR_TYPES = ['url', 'key', 'jql', 'cql'];
const SELECTOR_HINT = 'Legal selector forms: (1) a page URL starting with http:// or https://; (2) an issue key like PROJ-123; (3) a JQL query (jira) / (4) a CQL query (confluence) — queries contain whitespace, "=", or ORDER BY. Or pass --selector-type url|key|jql|cql explicitly.';

// ---- §3.1 skip list: exact basenames plus source-map-ish files, matched on basename at any depth ----
const OPENWIKI_SKIP_EXACT = new Set(['INSTRUCTIONS.md', '.last-update.json', 'log.md']);
const OPENWIKI_SKIP_RE = /source-?maps?/i;

function sniffSelector(s) {
  // §1.4 priority: ^https?:// → 'url'; ^[A-Z][A-Z0-9]+-\d+$ → 'key';
  // whitespace or '=' or /ORDER\s+BY/i → 'query' (JQL or CQL depending on connector); else null
  const v = String(s);
  if (/^https?:\/\//.test(v)) return 'url';
  if (/^[A-Z][A-Z0-9]+-\d+$/.test(v)) return 'key';
  if (/\s/.test(v) || v.includes('=') || /ORDER\s+BY/i.test(v)) return 'query';
  return null;
}

function resolveSelectorType(cmd, selector, explicitType) {
  // explicit --selector-type always wins (§1.4), but jql↔jira / cql↔confluence must match
  if (explicitType !== undefined) {
    if (!SELECTOR_TYPES.includes(explicitType))
      return { error: `--selector-type must be one of ${SELECTOR_TYPES.join('|')}, got '${explicitType}'`, hint: USAGE };
    if (explicitType === 'jql' && cmd !== 'jira')
      return { error: `--selector-type jql only applies to the jira connector, not '${cmd}'`, hint: SELECTOR_HINT };
    if (explicitType === 'cql' && cmd !== 'confluence')
      return { error: `--selector-type cql only applies to the confluence connector, not '${cmd}'`, hint: SELECTOR_HINT };
    return { type: explicitType };
  }
  const sniffed = sniffSelector(selector);
  if (sniffed === null) return { error: `cannot recognize selector form: '${selector}'`, hint: SELECTOR_HINT };
  return { type: sniffed === 'query' ? (cmd === 'jira' ? 'jql' : 'cql') : sniffed };
}

function flattenPageId(relMd) { // §3.1: 'architecture/overview.md' → 'architecture--overview'
  return relMd.replace(/\.md$/i, '').split('/').join('--');
}
function collisionSuffix(repoRelPath) { // sha1 of the repo-relative page path, first 8 hex
  return createHash('sha1').update(repoRelPath, 'utf8').digest('hex').slice(0, 8);
}

function relpathFromSourceUrl(sourceUrl) { // recover 'openwiki/<rel>' from a raw's source_url; null if un-mappable
  const s = String(sourceUrl).replace(/\\/g, '/');
  const hash = s.lastIndexOf('#'); // remote form: '<remote>#openwiki/<rel>' (remote URLs don't contain '#')
  if (hash >= 0) {
    const rel = s.slice(hash + 1);
    return rel.startsWith('openwiki/') ? rel : null;
  }
  if (s.startsWith('file://')) { // fallback form: 'file://<abs path containing /openwiki/<rel>>'
    const i = s.lastIndexOf('/openwiki/'); // last: the repo path itself may contain an earlier /openwiki/ segment
    return i >= 0 ? s.slice(i + 1) : null;
  }
  return null;
}

function gitOut(dir, args) { // → trimmed stdout, or null on any failure / empty output
  try {
    const s = execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
    return s === '' ? null : s;
  } catch { return null; }
}

// ==== Jira / Confluence HTTP connectors (§3, Server/DC + PAT) ====

class ConnectorAbort extends Error { // fatal for the whole connector run; carries typed code + hint
  constructor(code, message, hint) { super(message); this.code = code; this.hint = hint; }
}

function connectorConfig(kbJson, cmd) {
  const cfg = kbJson.connectors && kbJson.connectors[cmd];
  if (!cfg || !cfg.base_url || !cfg.pat_env) {
    return { fatal: { code: 'connector-not-configured',
      message: `kb.json has no connectors.${cmd} with base_url and pat_env`,
      hint: `Add connectors.${cmd} to kb.json: "connectors": { "${cmd}": { "base_url": "https://<host>", "pat_env": "<ENV_VAR_NAME>" } } — the PAT itself goes into the environment variable, NEVER into kb.json (§2.7).` } };
  }
  return { base: String(cfg.base_url).replace(/\/+$/, ''), patEnv: String(cfg.pat_env) };
}

// fetch hardening: 30s timeout (env LLM_WIKI_FETCH_TIMEOUT_MS overrides, mainly for tests) and
// a 50MB response cap; §3 timeout hint — a timeout means network, not credentials.
const FETCH_TIMEOUT_MS = Number(process.env.LLM_WIKI_FETCH_TIMEOUT_MS) > 0 ? Number(process.env.LLM_WIKI_FETCH_TIMEOUT_MS) : 30_000;
const MAX_RESPONSE_BYTES = 50 * 1024 * 1024;

async function apiGetJson(cfg, pathAndQuery) {
  let res;
  try { res = await fetch(cfg.base + pathAndQuery, { headers: { Authorization: `Bearer ${cfg.pat}` }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }); }
  catch (e) {
    const why = e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? `timed out after ${FETCH_TIMEOUT_MS}ms` : `network error (${e && e.code || 'unreachable'})`;
    throw new ConnectorAbort('fetch-failed', `cannot reach ${cfg.base} — ${why}`,
      'Check network/VPN connectivity to the host (a timeout means network, not credentials).');
  }
  const pathOnly = pathAndQuery.split('?')[0];
  const declared = Number(res.headers.get('content-length'));
  if (declared > MAX_RESPONSE_BYTES)
    throw new ConnectorAbort('upstream-error', `response from ${cfg.base}${pathOnly} exceeds the 50MB cap (content-length ${declared})`,
      'The server returned an oversized response; narrow the selector/query and try again.');
  const text = await res.text();
  // cap enforcement when content-length is absent: read fully, then check length before parsing
  // (accepts the one-buffer memory risk — documented, bounded by the timeout above)
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES)
    throw new ConnectorAbort('upstream-error', `response from ${cfg.base}${pathOnly} exceeds the 50MB cap`,
      'The server returned an oversized response; narrow the selector/query and try again.');
  if (res.status === 401 || res.status === 403) {
    // §3: credential failure aborts the connector; the hint names the env var, NEVER the PAT.
    throw new ConnectorAbort('auth-failed', `HTTP ${res.status} from the server — the PAT was rejected`,
    `The PAT is expired/revoked (401) or lacks permission (403). Update the environment variable named by kb.json connectors.${cfg.cmd}.pat_env (${cfg.patEnv}) and retry — kb.json itself needs no change. If every URL 404s instead, check connectors.${cfg.cmd}.base_url.`);
  }
  if (res.status === 404) {
    if (pathAndQuery.startsWith('/rest/api/')) {
      const hint = `HTTP 404 for ${pathOnly} — if no single object is expected to be missing, check kb.json connectors.${cfg.cmd}.base_url (${cfg.base}) points at the Server/DC instance root.`;
      return { status: 404, data: null, hint };
    }
    return { status: 404, data: null };
  }
  if (!res.ok) throw new ConnectorAbort('upstream-error', `HTTP ${res.status} from ${cfg.base}${pathOnly}`,
    'The server returned an error; not retried automatically. Check the server and try again.');
  try { return { status: res.status, data: JSON.parse(text) }; }
  catch { throw new ConnectorAbort('upstream-error', `non-JSON response from ${cfg.base}${pathOnly}`,
    `Check kb.json connectors.${cfg.cmd}.base_url (expected a Jira/Confluence Server/DC REST endpoint).`); }
}

// → { buf } | { missing: true } (non-OK status, not fatal) | { tooBig: true } (over the 50MB cap, skip)
async function apiGetBytes(cfg, urlOrPath) {
  const url = urlOrPath.startsWith('http') ? urlOrPath : cfg.base + urlOrPath;
  let res;
  try { res = await fetch(url, { headers: { Authorization: `Bearer ${cfg.pat}` }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }); }
  catch (e) {
    const why = e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? `timed out after ${FETCH_TIMEOUT_MS}ms` : `network error (${e && e.code || 'unreachable'})`;
    throw new ConnectorAbort('fetch-failed', `cannot download attachment ${urlOrPath} — ${why}`,
      'Check network/VPN connectivity to the host.');
  }
  if (res.status === 401 || res.status === 403)
    throw new ConnectorAbort('auth-failed', `HTTP ${res.status} while downloading an attachment — the PAT was rejected`,
    `Update the environment variable named by kb.json connectors.${cfg.cmd}.pat_env (${cfg.patEnv}) and retry.`);
  if (!res.ok) return { missing: true }; // a missing attachment is not fatal for the page
  const declared = Number(res.headers.get('content-length'));
  if (declared > MAX_RESPONSE_BYTES) return { tooBig: true };
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_RESPONSE_BYTES) return { tooBig: true }; // content-length absent → post-read check (see apiGetJson)
  return { buf };
}

// ---- adfToText: minimal ADF (Cloud-style rich text) → text (§3; unknown nodes keep child text) ----
function adfToText(node) {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node; // Server wiki-markup descriptions pass through verbatim
  if (typeof node !== 'object') return String(node);
  const kids = Array.isArray(node.content) ? node.content : [];
  const inner = () => kids.map(adfToText).join('');
  const blocks = () => kids.map(adfToText).filter(s => s !== '').join('\n');
  switch (node.type) {
    case 'doc': return kids.map(adfToText).filter(s => s !== '').join('\n\n');
    case 'paragraph': return inner();
    case 'text': return String(node.text ?? '');
    case 'heading': { const l = Math.min(6, Math.max(1, node.attrs?.level ?? 1)); return '#'.repeat(l) + ' ' + inner(); }
    case 'bulletList': return blocks().split('\n').map(l => '- ' + l).join('\n');
    case 'orderedList': return blocks().split('\n').map((l, i) => `${i + 1}. ${l}`).join('\n');
    case 'listItem': return blocks();
    case 'codeBlock': { const lang = node.attrs?.language || ''; return '```' + lang + '\n' + inner() + '\n```'; }
    case 'hardBreak': return '\n';
    case 'mention': return '@' + String(node.attrs?.text ?? node.attrs?.id ?? '');
    case 'emoji': { const s = String(node.attrs?.shortName ?? ''); return s.startsWith(':') ? s : ':' + s + ':'; }
    default: return inner(); // unknown node → concatenate children's text, never silently drop
  }
}

// ---- xhtmlToMd: minimal Confluence storage XHTML → Markdown (§3; tag scanner, NOT a full parser) ----
function decodeEntities(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}
function xhtmlToMd(xhtml, pageId) {
  let s = String(xhtml ?? '');
  const store = [];
  const hold = (md) => { store.push(md); return `KBCDATA${store.length - 1}X`; };
  // Perf guard: every pass below pairs an opener regex with a lazy [\s\S]*? scan to its closer;
  // when the closer is absent entirely the scan rescans to end-of-input per opener (quadratic
  // on hostile pages) — so each pass is skipped unless its closer exists somewhere in s.
  // 1. extract CDATA sections to placeholders (their content is verbatim text)
  if (s.includes(']]>')) s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (m, inner) => hold(inner));
  // 2. ac:structured-macro: code specially, every other macro → [macro: name]; never recurse into nesting
  if (s.includes('</ac:structured-macro>')) s = s.replace(/<ac:structured-macro\b[^>]*>[\s\S]*?<\/ac:structured-macro>/g, (block) => {
    const name = block.match(/ac:name="([^"]*)"/)?.[1] ?? '';
    if (name === 'code') {
      const lang = block.match(/<ac:parameter\b[^>]*ac:name="language"[^>]*>([\s\S]*?)<\/ac:parameter>/)?.[1].trim() ?? '';
      const bodyM = block.match(/<ac:plain-text-body>([\s\S]*?)<\/ac:plain-text-body>/);
      const body = bodyM ? restoreHolds(bodyM[1]) : '';
      return '\n\n```' + lang + '\n' + body + '\n```\n\n';
    }
    return '\n\n[macro: ' + name + ']\n\n';
  });
  // self-closing macro form
  s = s.replace(/<ac:structured-macro\b[^>]*ac:name="([^"]*)"[^>]*\/>/g, (m, name) => '\n\n[macro: ' + name + ']\n\n');
  // 3. ac:image with attachment → page-relative asset path
  if (s.includes('</ac:image>')) s = s.replace(/<ac:image\b[^>]*>[\s\S]*?<\/ac:image>/g, (block) => {
    const fn = block.match(/<ri:attachment\b[^>]*ri:filename="([^"]*)"/)?.[1];
    return fn ? `![${fn}](../assets/confluence/${pageId}/${fn})` : '';
  });
  s = s.replace(/<ac:image\b[^>]*\/>/g, '');
  // 4. ac:link → its link-body text (page links degrade, §3)
  if (s.includes('</ac:link>')) s = s.replace(/<ac:link\b[^>]*>[\s\S]*?<\/ac:link>/g, (block) => {
    return block.match(/<ac:link-body>([\s\S]*?)<\/ac:link-body>/)?.[1] ?? '';
  });
  s = s.replace(/<ac:link\b[^>]*\/>/g, '');
  // 5. strip remaining ac:/ri: tags
  s = s.replace(/<\/?(?:ac|ri):[^>]*>/g, '');
  // 6. tables (before generic block handling; cell content still has inline tags → handled by step 7)
  if (s.includes('</table>')) s = s.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/g, (m, inner) => {
    const rows = [];
    const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/g;
    let rm;
    while ((rm = rowRe.exec(inner))) {
      const cells = [];
      const cellRe = /<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/g;
      let cm;
      while ((cm = cellRe.exec(rm[1]))) cells.push(cm[1].replace(/\s+/g, ' ').trim());
      rows.push(cells);
    }
    if (!rows.length) return '';
    const line = (cells) => '| ' + cells.join(' | ') + ' |';
    const outRows = [line(rows[0]), '| ' + rows[0].map(() => '---').join(' | ') + ' |'];
    for (const r of rows.slice(1)) outRows.push(line(r));
    return '\n\n' + outRows.join('\n') + '\n\n';
  });
  // 7. inline tags
  if (s.includes('</a>')) s = s.replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g, (m, href, t) => `[${t}](${href})`);
  if (s.includes('</strong>') || s.includes('</b>')) s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/g, '**$2**');
  if (s.includes('</em>') || s.includes('</i>')) s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/g, '*$2*');
  if (s.includes('</code>')) s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/g, '`$1`');
  if (s.includes('</pre>')) s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/g, (m, inner) => '\n\n```\n' + hold(restoreHolds(inner)) + '\n```\n\n');
  s = s.replace(/<br\s*\/?>/g, '\n');
  // 8. block tags
  if (/<\/h[1-6]>/.test(s)) s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/g, (m, lv, t) => '\n\n' + '#'.repeat(Number(lv)) + ' ' + t.trim() + '\n\n');
  if (s.includes('</ul>')) s = s.replace(/<ul\b[^>]*>([\s\S]*?)<\/ul>/g, (m, inner) =>
    '\n\n' + [...inner.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].map(x => '- ' + x[1].trim()).join('\n') + '\n\n');
  if (s.includes('</ol>')) s = s.replace(/<ol\b[^>]*>([\s\S]*?)<\/ol>/g, (m, inner) =>
    '\n\n' + [...inner.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].map((x, i) => `${i + 1}. ` + x[1].trim()).join('\n') + '\n\n');
  s = s.replace(/<\/(?:p|div)>/g, '\n\n');
  s = s.replace(/<(?:p|div)\b[^>]*>/g, '');
  // 9. strip any remaining tags, restore CDATA placeholders, unescape entities
  s = s.replace(/<[^>]+>/g, '');
  s = restoreHolds(s);
  s = decodeEntities(s);
  // 10. whitespace: collapse runs, block separation = exactly one blank line
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ');
  return s.trim();

  function restoreHolds(t) { return t.replace(/KBCDATA(\d+)X/g, (m, i) => store[Number(i)]); }
}

// ---- attachment download + body reference rewrite (§3) ----
// §3 paths are <source>/<source_id>/<filename>, so filenames must be single safe path segments:
// no separators, no . / .., no Windows-reserved chars, no trailing dot/space (unwritable on Windows).
function isUsableAttachmentName(fn) {
  return typeof fn === 'string' && fn !== '' && fn !== '.' && fn !== '..'
    && !/[\\/]/.test(fn) && !/[<>:"|?*]/.test(fn) && !/[. ]$/.test(fn);
}
async function downloadAttachments(cfg, attachments, assetDirAbs, assetDirRel, body, warnings) {
  if (!attachments.length) return body;
  mkdirSync(assetDirAbs, { recursive: true });
  for (const att of attachments) {
    // fault isolation: one bad attachment degrades to a warning, never aborts the batch/page
    try {
      const filename = att.filename;
      if (!isUsableAttachmentName(filename)) { warnings.push(`skipped attachment with unusable filename: ${JSON.stringify(filename)}`); continue; }
      const r = await apiGetBytes(cfg, att.url);
      if (r.missing) { warnings.push(`attachment not downloaded (upstream error): ${filename}`); continue; }
      if (r.tooBig) { warnings.push(`attachment skipped (exceeds the 50MB cap): ${filename}`); continue; }
      const buf = r.buf;
      const abs = join(assetDirAbs, filename);
      const newHash = createHash('sha256').update(buf).digest('hex');
      let note = null;
      if (existsSync(abs)) {
        const oldHash = createHash('sha256').update(readFileSync(abs)).digest('hex');
        if (oldHash === newHash) continue; // same filename + same bytes → unchanged, skip re-download write
        note = `attachment updated (same filename, new bytes): ${assetDirRel}/${filename}`;
      }
      writeFileSync(abs, buf);
      if (note) warnings.push(note);
    } catch (e) {
      if (e instanceof ConnectorAbort) throw e; // credential/network failures still abort the connector
      warnings.push(`attachment failed (${att.filename}): ${String(e && e.message || e).split('\n')[0]}`);
    }
  }
  // documented heuristic: plain filename mentions in the body text are rewritten to the
  // page-relative asset path; already-rewritten ../assets/ references are left alone.
  const names = [...new Set(attachments.map(a => a.filename).filter(isUsableAttachmentName))]
    .sort((a, b) => b.length - a.length)
    .map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!names.length) return body;
  return body.replace(new RegExp(`(?<!\\.\\./assets/[^\\s)]*/)(?<!!\\[)(?<![\\w.-])(${names.join('|')})(?![\\w.-])`, 'g'),
    `${assetDirRel}/$1`);
}

// ---- local raw helpers ----
function readLocalRawVersion(kbDir, source, id) { // → source_version string of the existing raw, or null
  const p = join(kbDir, 'raw', source, id + '.md');
  if (!existsSync(p)) return null;
  try {
    const d = splitFrontmatter(readFileSync(p, 'utf8')).data;
    return d && d.source_version != null ? String(d.source_version) : null;
  } catch { return null; }
}

function tombstonePath(kbDir) { return join(kbDir, '.kb', 'govern', 'source-tombstones.json'); }
function readTombstones(kbDir) {
  const p = tombstonePath(kbDir);
  if (!existsSync(p)) return {}; // missing file → no tombstones
  // fail-closed: an EXISTING but unparseable tombstone file must never silently disable suppression
  try { return JSON.parse(readFileSync(p, 'utf8')); }
  catch {
    throw new ConnectorAbort('corrupt-tombstones', '.kb/govern/source-tombstones.json exists but is not valid JSON',
      'Fix or delete .kb/govern/source-tombstones.json — tombstone suppression is fail-closed; acquire refuses to run while it is unreadable.');
  }
}

/**
 * §1.4/§2.6: tombstoned source_id without --force → suppressed (errors entry); with --force →
 * clear + log. --detect-only is side-effect-free by contract: no tombstone deletion, no log
 * write — the force/tombstone situation is only reported (warnings entry).
 */
function checkTombstone(kbDir, tombstones, source, id, force, summary, warnings, detectOnly) {
  const key = `raw:${source}/${id}`;
  if (!(key in tombstones)) return false;
  const target = `raw/${source}/${id}.md`;
  if (!force) {
    summary.errors.push({ target, code: 'tombstoned',
      message: `suppressed by tombstone (${tombstones[key].reason ?? 'no reason recorded'}); re-run with --force to pull anyway` });
    return true;
  }
  if (detectOnly) {
    warnings.push(`${target} is tombstoned; a non-detect run with --force would clear the tombstone and re-pull`);
    return true;
  }
  delete tombstones[key];
  writeJsonAtomic(tombstonePath(kbDir), tombstones);
  appendLog(kbDir, 'acquire', 'pull', target, 'force: tombstone cleared');
  return false;
}

function commitKbBatch(kbDir, cmd, summary, warnings) { // §2.8: one commit per batch, best-effort
  const changed = summary.created + summary.updated + summary.removed_upstream;
  if (changed <= 0) return;
  try {
    const env = { ...process.env,
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || 'llm-wiki-acquire',
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || 'llm-wiki@localhost',
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || 'llm-wiki-acquire',
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || 'llm-wiki@localhost' };
    // scope staging to what acquire owns (raw/ + log.md): the KB may be NESTED in a larger repo,
    // and an unscoped `git add -A` would commit unrelated user work at the enclosing root.
    execFileSync('git', ['-c', 'core.quotepath=false', '-C', kbDir, 'add', '-A', '--', 'raw', 'log.md'], { encoding: 'utf8', env });
    const dirty = execFileSync('git', ['-c', 'core.quotepath=false', '-C', kbDir, 'status', '--porcelain', '--', 'raw', 'log.md'], { encoding: 'utf8', env }).trim();
    if (dirty === '') return; // nothing acquire-owned to commit
    execFileSync('git', ['-c', 'core.quotepath=false', '-C', kbDir, 'commit', '-m',
      `acquire: ${cmd} (+${summary.created} ~${summary.updated} -${summary.removed_upstream})`], { encoding: 'utf8', env });
  } catch (e) {
    warnings.push(`git commit failed: ${String(e && e.message || e).split('\n')[0]}`);
  }
}

// ---- Jira (§3, Server/DC REST /rest/api/2) ----
const JIRA_DETECT_FIELDS = 'summary,updated';
const JIRA_FULL_FIELDS = 'summary,description,comment,attachment,issuetype,priority,labels,status,assignee,created,updated';
const JIRA_MAX_ISSUES = 500;

function jiraExtractKeys(selector, type) {
  if (type === 'jql') return { jql: selector };
  if (type === 'key') return { keys: [selector] };
  // url: <base>/browse/<KEY> (optionally trailing ?...)
  const m = String(selector).match(/\/browse\/([A-Z][A-Z0-9]+-\d+)(?:[/?#]|$)/);
  if (!m) return { error: `cannot extract an issue key from URL '${selector}'`,
    hint: `Expected a Jira browse URL like https://<host>/browse/PROJ-123. Or pass the issue key directly, or a JQL query. (§3)` };
  return { keys: [m[1]] };
}

async function runJira(kbDir, kbJson, { selector, selectorType, detectOnly = false, force = false } = {}) {
  const cc = connectorConfig(kbJson, 'jira');
  if (cc.fatal) return { fatal: cc.fatal };
  const cfg = { base: cc.base, patEnv: cc.patEnv, cmd: 'jira', pat: process.env[cc.patEnv] };
  if (!cfg.pat) return { fatal: { code: 'missing-pat',
    message: `environment variable '${cfg.patEnv}' (kb.json connectors.jira.pat_env) is not set`,
    hint: `Set the PAT in the environment variable '${cfg.patEnv}' (Windows: setx ${cfg.patEnv} "<pat>" — macOS/Linux: export ${cfg.patEnv}=<pat>), then retry. The PAT is read only from the environment and never printed.` } };

  const summary = { created: 0, updated: 0, unchanged: 0, removed_upstream: 0, errors: [] };
  const warnings = [];
  const sel = jiraExtractKeys(selector, selectorType);
  if (sel.error) return { fatal: { code: 'bad-selector', message: sel.error, hint: sel.hint } };

  // detect-first (§3): light scan classifies new/changed/unchanged before any full pull
  const detected = []; // { key, updated, status }
  if (sel.jql !== undefined) {
    let startAt = 0;
    for (;;) {
      const q = `/rest/api/2/search?jql=${encodeURIComponent(sel.jql)}&fields=${JIRA_DETECT_FIELDS}&maxResults=100&startAt=${startAt}`;
      const r = await apiGetJson(cfg, q);
      if (r.status !== 200) throw new ConnectorAbort('upstream-error', `JQL search failed (HTTP ${r.status})`, 'Check the JQL query and kb.json connectors.jira.base_url.');
      const issues = r.data.issues ?? [];
      for (const it of issues) {
        if (detected.length >= JIRA_MAX_ISSUES) break;
        detected.push({ key: it.key, updated: String(it.fields?.updated ?? '') });
      }
      if (detected.length >= JIRA_MAX_ISSUES && startAt + issues.length < (r.data.total ?? 0)) {
        warnings.push(`JQL matched more than ${JIRA_MAX_ISSUES} issues; stopped at the ${JIRA_MAX_ISSUES}-issue cap — narrow the JQL query to pull the rest.`);
        break;
      }
      if (issues.length === 0 || startAt + issues.length >= (r.data.total ?? 0)) break;
      startAt += issues.length;
    }
  } else {
    for (const key of sel.keys) {
      const r = await apiGetJson(cfg, `/rest/api/2/issue/${encodeURIComponent(key)}?fields=${JIRA_DETECT_FIELDS}`);
      detected.push({ key, updated: r.status === 200 ? String(r.data.fields?.updated ?? '') : null, missing: r.status === 404 });
    }
  }

  const state = readAcquireState(kbDir);
  let stateChanged = false;
  const tombstones = readTombstones(kbDir);
  const pulls = [];
  for (const d of detected) {
    const hasLocal = existsSync(join(kbDir, 'raw', 'jira', d.key + '.md'));
    if (d.missing && !hasLocal) {
      // a never-pulled key that 404s is a typo'd selector, not a disappearance — typed error,
      // no state entry, no count, no log (only previously-pulled keys enter the strike path)
      throw new ConnectorAbort('not-found', `no Jira issue ${d.key} (HTTP 404)`,
        'Check the issue key / browse URL (and kb.json connectors.jira.base_url). No local raw exists for this key.');
    }
    if ((d.missing || d.updated === null || d.updated === '') && hasLocal) {
      // §3 two-strike rule: Jira cannot distinguish "issue deleted" from "permission lost"
      const stateKey = `jira/${d.key}`;
      if (!state[stateKey]) {
        state[stateKey] = { firstMissingAt: new Date().toISOString() };
        stateChanged = true;
        warnings.push(`issue ${d.key} not found upstream (404) — Jira cannot distinguish deletion from permission loss; raw kept, will be removed if still missing on the next run (§3)`);
        summary.unchanged++;
      } else {
        delete state[stateKey];
        stateChanged = true;
        summary.removed_upstream++;
        if (!detectOnly) {
          const p = join(kbDir, 'raw', 'jira', d.key + '.md');
          if (existsSync(p)) unlinkSync(p);
          appendLog(kbDir, 'acquire', 'pull', `raw/jira/${d.key}.md`, 'removed_upstream');
        }
      }
      continue;
    }
    if (state[`jira/${d.key}`]) { delete state[`jira/${d.key}`]; stateChanged = true; } // reappeared → clear strike
    const local = readLocalRawVersion(kbDir, 'jira', d.key);
    d.status = local === null ? 'created' : (local === d.updated ? 'unchanged' : 'updated');
    if (d.status !== 'unchanged' && checkTombstone(kbDir, tombstones, 'jira', d.key, force, summary, warnings, detectOnly)) continue; // suppressed: skipped, not counted
    summary[d.status]++;
    if (d.status !== 'unchanged') pulls.push(d);
  }
  if (stateChanged && !detectOnly) writeAcquireState(kbDir, state);
  if (detectOnly) {
    const result = { ...summary };
    if (warnings.length) result.warnings = warnings;
    return { result };
  }

  // full pulls (new + changed only)
  const pulledAt = new Date().toISOString();
  for (const d of pulls) {
    const r = await apiGetJson(cfg, `/rest/api/2/issue/${encodeURIComponent(d.key)}?fields=${JIRA_FULL_FIELDS}`);
    if (r.status !== 200) { summary.errors.push({ target: `raw/jira/${d.key}.md`, code: 'pull-failed', message: `full pull returned HTTP ${r.status}; raw left as-is` }); continue; }
    const f = r.data.fields ?? {};
    let body = adfToText(f.description ?? '');
    const comments = Array.isArray(f.comment?.comments) ? f.comment.comments.slice(-10) : []; // latest ≤10 (§3)
    if (comments.length) {
      body += '\n\n## Comments\n';
      for (const c of comments) {
        body += `\n### ${c.author?.displayName ?? 'unknown'} — ${c.created ?? c.updated ?? ''}\n\n${adfToText(c.body ?? '')}\n`;
      }
    }
    const attachments = (Array.isArray(f.attachment) ? f.attachment : [])
      .map(a => ({ filename: a.filename, url: a.content }))
      .filter(a => a.filename && a.url);
    if (attachments.length) {
      body = await downloadAttachments(cfg, attachments,
        join(kbDir, 'raw', 'assets', 'jira', d.key), `../assets/jira/${d.key}`, body, warnings);
    }
    body = body.trim() + '\n';
    const fm = { source: 'jira', source_id: d.key, source_url: `${cfg.base}/browse/${d.key}`,
      source_version: String(f.updated ?? d.updated), pulled_at: pulledAt, content_hash: contentHash(String(f.updated ?? d.updated), body) };
    if (f.issuetype?.name) fm.issue_type = String(f.issuetype.name); // §2.2: type in frontmatter, never in path
    if (f.priority?.name) fm.priority = String(f.priority.name);
    if (Array.isArray(f.labels) && f.labels.length) fm.labels = f.labels.map(String);
    if (f.status?.name) fm.status = String(f.status.name);
    if (f.assignee?.displayName) fm.assignee = String(f.assignee.displayName);
    if (f.created) fm.created = String(f.created);
    mkdirSync(join(kbDir, 'raw', 'jira'), { recursive: true });
    writeFileSync(join(kbDir, 'raw', 'jira', d.key + '.md'), serializeFrontmatter(fm, body));
  }

  commitKbBatch(kbDir, 'jira', summary, warnings);
  const result = { ...summary };
  if (warnings.length) result.warnings = warnings;
  return { result };
}

// ---- Confluence (§3, Server/DC REST /rest/api/content) ----
const CONF_DETECT_EXPAND = 'version';
const CONF_FULL_EXPAND = 'body.storage,version,metadata.labels,children.attachment';
const CONF_MAX_PAGES = 500;

function confQuote(v) { return String(v).replace(/["\\]/g, ''); } // CQL string literal: strip, never invent
async function confluenceResolveIds(cfg, selector, selectorType) {
  if (selectorType === 'cql') return { cql: selector };
  const u = String(selector);
  let m = u.match(/[?&]pageId=(\d+)/);
  if (m) return { ids: [m[1]] };
  m = u.match(/\/display\/([^/?#]+)\/([^?#]+?)\/?(?:[?#]|$)/);
  if (m) {
    let space, title;
    try { // query-string semantics: '+' → space BEFORE percent-decoding
      space = decodeURIComponent(m[1]);
      title = decodeURIComponent(m[2].replace(/\+/g, ' '));
    } catch {
      return { error: `malformed percent-encoding in URL '${selector}'`, usage: true,
        hint: 'The /display/SPACE/Title URL is not valid percent-encoding. Fix the URL, or pass a CQL query instead. (§3)' };
    }
    // resolve via CQL search (Server/DC has no direct space+title REST lookup)
    const cql = `space = "${confQuote(space)}" AND title = "${confQuote(title)}"`;
    const r = await apiGetJson(cfg, `/rest/api/content/search?cql=${encodeURIComponent(cql)}&expand=${CONF_DETECT_EXPAND}&limit=1&start=0`);
    if (r.status !== 200) throw new ConnectorAbort('upstream-error', `page resolution failed (HTTP ${r.status})`, 'Check kb.json connectors.confluence.base_url.');
    if (!r.data.results?.length) throw new ConnectorAbort('not-found', `no Confluence page for space '${space}' title '${title}'`, 'Check the URL — space key and page title must match exactly.');
    return { ids: [String(r.data.results[0].id)] };
  }
  return { error: `cannot extract a page id from URL '${selector}'`,
    hint: `Expected a Confluence page URL like https://<host>/pages/viewpage.action?pageId=123 or https://<host>/display/SPACE/Page+Title. Or pass a CQL query. (§3)` };
}

async function runConfluence(kbDir, kbJson, { selector, selectorType, detectOnly = false, force = false } = {}) {
  const cc = connectorConfig(kbJson, 'confluence');
  if (cc.fatal) return { fatal: cc.fatal };
  const cfg = { base: cc.base, patEnv: cc.patEnv, cmd: 'confluence', pat: process.env[cc.patEnv] };
  if (!cfg.pat) return { fatal: { code: 'missing-pat',
    message: `environment variable '${cfg.patEnv}' (kb.json connectors.confluence.pat_env) is not set`,
    hint: `Set the PAT in the environment variable '${cfg.patEnv}' (Windows: setx ${cfg.patEnv} "<pat>" — macOS/Linux: export ${cfg.patEnv}=<pat>), then retry. The PAT is read only from the environment and never printed.` } };

  const summary = { created: 0, updated: 0, unchanged: 0, removed_upstream: 0, errors: [] };
  const warnings = [];
  const resolved = await confluenceResolveIds(cfg, selector, selectorType);
  if (resolved.error) return { fatal: { code: 'bad-selector', message: resolved.error, hint: resolved.hint, usage: resolved.usage === true } };

  // detect-first (§3): id + version.when per page, classify vs local raws
  const state = readAcquireState(kbDir);
  let stateChanged = false;
  const detected = [];
  const missing = []; // page ids previously pulled locally but not found upstream this run
  if (resolved.cql !== undefined) {
    let start = 0;
    for (;;) {
      const q = `/rest/api/content/search?cql=${encodeURIComponent(resolved.cql)}&expand=${CONF_DETECT_EXPAND}&limit=100&start=${start}`;
      const r = await apiGetJson(cfg, q);
      if (r.status !== 200) throw new ConnectorAbort('upstream-error', `CQL search failed (HTTP ${r.status})`, 'Check the CQL query and kb.json connectors.confluence.base_url.');
      const results = r.data.results ?? [];
      const totalSize = typeof r.data.totalSize === 'number' ? r.data.totalSize : null; // Server/DC search reports totalSize
      for (const it of results) {
        if (detected.length >= CONF_MAX_PAGES) break;
        detected.push({ id: String(it.id), version: it.version?.when ?? (it.version?.number != null ? String(it.version.number) : '') });
      }
      if (detected.length >= CONF_MAX_PAGES) {
        // warn only when matches actually remain (totalSize when present; full-page heuristic as fallback)
        const moreRemain = totalSize !== null ? start + results.length < totalSize : results.length === 100;
        if (moreRemain)
          warnings.push(`CQL matched more than ${CONF_MAX_PAGES} pages; stopped at the ${CONF_MAX_PAGES}-page cap — narrow the CQL query to pull the rest.`);
        break;
      }
      if (results.length < 100) break;
      start += results.length;
    }
    // CQL absence: local raws not in the result set are strikes (see the two-strike rule below)
    const present = new Set(detected.map(d => d.id));
    const rawDir = join(kbDir, 'raw', 'confluence');
    if (existsSync(rawDir)) {
      for (const f of readdirSync(rawDir).sort()) {
        if (!f.endsWith('.md')) continue;
        let sid = f.slice(0, -'.md'.length);
        try {
          const d = splitFrontmatter(readFileSync(join(rawDir, f), 'utf8')).data;
          if (d && d.source_id !== undefined && d.source_id !== null) sid = String(d.source_id);
        } catch { /* unparseable raw → fall back to filename */ }
        if (!present.has(sid)) missing.push(sid);
      }
    }
  } else {
    for (const id of resolved.ids) {
      const r = await apiGetJson(cfg, `/rest/api/content/${encodeURIComponent(id)}?expand=${CONF_DETECT_EXPAND}`);
      if (r.status === 404) {
        // previously pulled → two-strike path; never pulled locally → typed error
        if (existsSync(join(kbDir, 'raw', 'confluence', id + '.md'))) { missing.push(String(id)); continue; }
        throw new ConnectorAbort('not-found', `no Confluence page with id ${id} (HTTP 404)`, 'Check the URL (and kb.json connectors.confluence.base_url).');
      }
      if (r.status !== 200) throw new ConnectorAbort('upstream-error', `detect failed for page ${id} (HTTP ${r.status})`, 'Check kb.json connectors.confluence.base_url.');
      detected.push({ id: String(id), version: r.data.version?.when ?? (r.data.version?.number != null ? String(r.data.version.number) : '') });
    }
  }

  // §3 two-strike removed_upstream, extended from Jira to Confluence by controller decision:
  // Confluence has the same "page deleted vs permission lost" ambiguity, and CQL result sets
  // are subsets — so absence (single-page 404 / missing from CQL results) is only a STRIKE
  // (conservative retention), never an immediate delete; a second consecutive miss removes the raw.
  for (const id of missing) {
    const stateKey = `confluence/${id}`;
    if (!state[stateKey]) {
      state[stateKey] = { firstMissingAt: new Date().toISOString() };
      stateChanged = true;
      warnings.push(`page ${id} not found upstream (404/absent from CQL results) — Confluence cannot distinguish deletion from permission loss; raw kept, will be removed if still missing on the next run (§3)`);
      summary.unchanged++;
    } else {
      delete state[stateKey];
      stateChanged = true;
      summary.removed_upstream++;
      if (!detectOnly) {
        const p = join(kbDir, 'raw', 'confluence', id + '.md');
        if (existsSync(p)) unlinkSync(p);
        appendLog(kbDir, 'acquire', 'pull', `raw/confluence/${id}.md`, 'removed_upstream');
      }
    }
  }

  const tombstones = readTombstones(kbDir);
  const pulls = [];
  for (const d of detected) {
    if (state[`confluence/${d.id}`]) { delete state[`confluence/${d.id}`]; stateChanged = true; } // reappeared → clear strike
    const local = readLocalRawVersion(kbDir, 'confluence', d.id);
    d.status = local === null ? 'created' : (local === d.version ? 'unchanged' : 'updated');
    if (d.status !== 'unchanged' && checkTombstone(kbDir, tombstones, 'confluence', d.id, force, summary, warnings, detectOnly)) continue; // suppressed: skipped, not counted
    summary[d.status]++;
    if (d.status !== 'unchanged') pulls.push(d);
  }
  if (stateChanged && !detectOnly) writeAcquireState(kbDir, state);
  if (detectOnly) {
    const result = { ...summary };
    if (warnings.length) result.warnings = warnings;
    return { result };
  }

  // full pulls (new + changed only); §3: Confluence comments are NOT pulled
  const pulledAt = new Date().toISOString();
  for (const d of pulls) {
    const r = await apiGetJson(cfg, `/rest/api/content/${encodeURIComponent(d.id)}?expand=${CONF_FULL_EXPAND}`);
    if (r.status !== 200) { summary.errors.push({ target: `raw/confluence/${d.id}.md`, code: 'pull-failed', message: `full pull returned HTTP ${r.status}; raw left as-is` }); continue; }
    const page = r.data;
    let body = xhtmlToMd(page.body?.storage?.value ?? '', d.id);
    const attachments = (page.children?.attachment?.results ?? [])
      .map(a => ({ filename: a.title, url: a._links?.download }))
      .filter(a => a.filename && a.url);
    if (attachments.length) {
      body = await downloadAttachments(cfg, attachments,
        join(kbDir, 'raw', 'assets', 'confluence', d.id), `../assets/confluence/${d.id}`, body, warnings);
    }
    body = body.trim() + '\n';
    const sourceVersion = page.version?.when ?? (page.version?.number != null ? String(page.version.number) : d.version); // §3: unparseable values kept as-is
    const webui = page._links?.webui;
    const sourceUrl = webui ? cfg.base + webui : `${cfg.base}/pages/viewpage.action?pageId=${d.id}`;
    const fm = { source: 'confluence', source_id: d.id, source_url: sourceUrl,
      source_version: String(sourceVersion), pulled_at: pulledAt, content_hash: contentHash(String(sourceVersion), body) };
    const labels = (page.metadata?.labels?.results ?? []).map(l => l.name).filter(Boolean);
    if (labels.length) fm.labels = labels;
    mkdirSync(join(kbDir, 'raw', 'confluence'), { recursive: true });
    writeFileSync(join(kbDir, 'raw', 'confluence', d.id + '.md'), serializeFrontmatter(fm, body));
  }

  commitKbBatch(kbDir, 'confluence', summary, warnings);
  const result = { ...summary };
  if (warnings.length) result.warnings = warnings;
  return { result };
}


// ---- acquire state (§3, reserved for the Jira two-strike removed_upstream rule; lands with the Jira connector) ----
function acquireStatePath(kbDir) { return join(kbDir, '.kb', 'acquire-state.json'); }
function readAcquireState(kbDir) { // readJsonSafe-based; missing file → {} without warning
  const p = acquireStatePath(kbDir);
  return existsSync(p) ? readJsonSafe(p, {}) : {};
}
function writeJsonAtomic(path, obj) { // temp file + rename: never leave a half-written state file
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  renameSync(tmp, path);
}
function writeAcquireState(kbDir, state) {
  writeJsonAtomic(acquireStatePath(kbDir), state);
}

function parseArgs(argv) {
  const args = { cmd: null, kb: undefined, selector: undefined, selectorType: undefined,
    repo: undefined, subdir: undefined, detectOnly: false, force: false };
  let i = 0;
  if (argv.length && !argv[0].startsWith('--')) { args.cmd = argv[0]; i = 1; } // subcommand must come first
  for (; i < argv.length; i++) {
    let a = argv[i], v;
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq > 0) { v = a.slice(eq + 1); a = a.slice(0, eq); }
    const need = () => {
      if (v !== undefined) { if (v === '') throw new Error(`flag ${a} requires a non-empty value`); return v; }
      const n = argv[i + 1];
      if (n === undefined || n.startsWith('--')) throw new Error(`flag ${a} requires a value`);
      i++; return n;
    };
    const boolVal = () => { // §1.2: --flag / --flag true|false (also --flag=true|false)
      if (v !== undefined) return parseBoolFlag(v);
      const n = argv[i + 1];
      if (n !== undefined && !n.startsWith('--')) { i++; return parseBoolFlag(n); }
      return parseBoolFlag(undefined);
    };
    switch (a) {
      case '--kb': args.kb = need(); break;
      case '--selector': args.selector = need(); break;
      case '--selector-type': args.selectorType = need(); break;
      case '--repo': args.repo = need(); break;
      case '--subdir': args.subdir = need(); break;
      case '--detect-only': args.detectOnly = boolVal(); break;
      case '--force': args.force = boolVal(); break;
      default: throw new Error(a.startsWith('--') ? `unknown flag '${a}'` : `unexpected argument '${a}' (subcommand must come first)`);
    }
  }
  return args;
}

function normalizeSubdir(subdir) {
  const s = String(subdir).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (s === '') return { error: '--subdir must be a non-empty directory relative to openwiki/', hint: USAGE };
  if (s.split('/').some(seg => seg === '.' || seg === '..'))
    return { error: `--subdir must be a clean relative path, got '${subdir}'`, hint: USAGE };
  return { subdir: s };
}

function runOpenwiki(kbDir, { repo, subdir = null, detectOnly = false } = {}) {
  const summary = { created: 0, updated: 0, unchanged: 0, removed_upstream: 0, errors: [] };
  const warnings = [];
  const repoAbs = resolve(repo);
  const owDir = join(repoAbs, 'openwiki');
  if (!existsSync(owDir)) {
    return { fatal: { message: `no openwiki/ directory under repo '${repoAbs}'`,
      hint: 'Point --repo at a repository where OpenWiki has generated a top-level openwiki/ directory (OKF v0.1).' } };
  }

  // --subdir rule (§3.1 subset selector): the upstream page set is only the pages under
  // openwiki/<subdir>/. Upstream-deletion handling is scoped by each existing raw's UPSTREAM
  // RELPATH (recovered from its source_url frontmatter, see relpathFromSourceUrl) — NOT by
  // flattened-id prefix: flattening maps 'a/b.md' and top-level 'a--b.md' into the same id
  // namespace, so an id-prefix check would falsely delete alive out-of-scope raws. A raw whose
  // source_url cannot be mapped back to a relpath (e.g. hand-written manual raw per the §3.1
  // degraded path may carry any source_url) is treated as OUT of scope: never delete what we
  // cannot attribute.

  const remote = gitOut(repoAbs, ['config', '--get', 'remote.origin.url']);
  const pulledAt = new Date().toISOString();

  // upstream page set: skip-list → .md only → subdir scope → flatten → collision suffix,
  // in walkFiles' deterministic sorted order (a colliding LATER page gets the hash suffix)
  const upstream = new Map(); // flattened id → { rel, abs }
  for (const rel of walkFiles(owDir)) {
    const base = basename(rel);
    if (OPENWIKI_SKIP_EXACT.has(base) || OPENWIKI_SKIP_RE.test(base)) continue;
    if (!rel.toLowerCase().endsWith('.md')) continue;
    if (subdir !== null && !rel.startsWith(subdir + '/')) continue;
    const repoRel = 'openwiki/' + rel;
    let id = flattenPageId(rel);
    if (upstream.has(id)) id = `${id}-${collisionSuffix(repoRel)}`;
    if (upstream.has(id) || !SOURCE_ID_RE.test(id)) {
      summary.errors.push({ target: repoRel, code: 'invalid-source-id',
        message: `flattened source_id '${id}' is taken or does not match ${SOURCE_ID_RE}; page skipped without escaping (§2.2)` });
      continue;
    }
    upstream.set(id, { rel, abs: join(owDir, rel) });
  }

  const rawDir = join(kbDir, 'raw', 'openwiki');
  for (const [id, page] of upstream) {
    const repoRel = 'openwiki/' + page.rel;
    const sourceUrl = remote ? `${remote}#${repoRel}` : 'file://' + page.abs.replace(/\\/g, '/');
    const sourceVersion = gitOut(repoAbs, ['log', '-1', '--format=%cI', '--', repoRel])
      ?? statSync(page.abs).mtime.toISOString();
    const body = readFileSync(page.abs, 'utf8'); // verbatim, incl. the page's own OKF frontmatter
    const hash = contentHash(sourceVersion, body);
    const targetAbs = join(rawDir, id + '.md');
    let status = 'created';
    if (existsSync(targetAbs)) {
      let prev = null;
      try { prev = splitFrontmatter(readFileSync(targetAbs, 'utf8')).data?.content_hash ?? null; } catch { prev = null; }
      status = prev !== null && String(prev) === hash ? 'unchanged' : 'updated';
    }
    summary[status]++;
    if (detectOnly || status === 'unchanged') continue;
    mkdirSync(rawDir, { recursive: true });
    writeFileSync(targetAbs, serializeFrontmatter(
      { source: 'openwiki', source_id: id, source_url: sourceUrl, source_version: sourceVersion, pulled_at: pulledAt, content_hash: hash },
      body));
  }

  // upstream deletion handling (§3.1): raw files whose source_id is not in the upstream set are removed
  const deletions = [];
  if (existsSync(rawDir)) {
    for (const f of readdirSync(rawDir).sort()) {
      if (!f.endsWith('.md')) continue;
      let sid = f.slice(0, -'.md'.length);
      let sourceUrl = null;
      try {
        const d = splitFrontmatter(readFileSync(join(rawDir, f), 'utf8')).data;
        if (d && d.source_id !== undefined && d.source_id !== null) sid = String(d.source_id);
        if (d && d.source_url !== undefined && d.source_url !== null) sourceUrl = String(d.source_url);
      } catch { /* unparseable raw → fall back to filename; no source_url → un-mappable */ }
      if (subdir !== null) { // scoped deletion, see the --subdir rule above
        const rel = sourceUrl === null ? null : relpathFromSourceUrl(sourceUrl);
        if (rel === null || !rel.startsWith('openwiki/' + subdir + '/')) continue;
      }
      if (!upstream.has(sid)) deletions.push({ sid, file: f });
    }
  }
  summary.removed_upstream = deletions.length;
  if (!detectOnly) {
    for (const d of deletions) {
      unlinkSync(join(rawDir, d.file));
      appendLog(kbDir, 'acquire', 'pull', `raw/openwiki/${d.file}`, 'removed_upstream'); // §2.5
    }
  }

  // §2.8: one commit per batch — best-effort (KB not a git repo / git missing → warning, still exit 0)
  if (!detectOnly) commitKbBatch(kbDir, 'openwiki', summary, warnings);

  const result = { ...summary };
  if (warnings.length) result.warnings = warnings;
  return { result };
}

// === main(argv) ===
async function main(argv) {
  let args;
  try { args = parseArgs(argv); } catch (e) { return fail(64, e.message, USAGE); }
  const r = resolveKb(args.kb);
  if (r.error) return fail(64, r.error, r.hint);
  const c = checkKb(r.kb);
  if (c.error) return fail(65, c.error, c.hint);
  try {
    if (args.cmd === null) return fail(64, 'missing subcommand', USAGE);
    if (!SUBCOMMANDS.includes(args.cmd)) return fail(64, `unknown subcommand '${args.cmd}'`, USAGE);

    if (args.cmd === 'jira' || args.cmd === 'confluence') {
      if (args.repo !== undefined || args.subdir !== undefined)
        return fail(64, '--repo/--subdir only apply to the openwiki subcommand', USAGE);
      if (args.selector === undefined) return fail(64, `missing --selector for '${args.cmd}'`, USAGE);
      const st = resolveSelectorType(args.cmd, args.selector, args.selectorType);
      if (st.error) return fail(64, st.error, st.hint);
      try {
        const res = args.cmd === 'jira'
          ? await runJira(r.kb, c.kbJson, { selector: args.selector, selectorType: st.type, detectOnly: args.detectOnly, force: args.force })
          : await runConfluence(r.kb, c.kbJson, { selector: args.selector, selectorType: st.type, detectOnly: args.detectOnly, force: args.force });
        if (res.fatal) { out({ error: { code: res.fatal.code ?? 1, message: res.fatal.message, hint: res.fatal.hint } }); return res.fatal.usage ? EXIT.USAGE : EXIT.FAIL; }
        out(res.result);
        return EXIT.OK;
      } catch (e) {
        if (e instanceof ConnectorAbort) {
          out({ error: { code: e.code, message: e.message, hint: e.hint } });
          return EXIT.FAIL;
        }
        throw e;
      }
    }

    // openwiki
    if (args.selector !== undefined || args.selectorType !== undefined || args.force)
      return fail(64, '--selector/--selector-type/--force only apply to the jira/confluence subcommands', USAGE);
    if (args.repo === undefined) return fail(64, "missing --repo for 'openwiki'", USAGE);
    let subdir = null;
    if (args.subdir !== undefined) {
      const n = normalizeSubdir(args.subdir);
      if (n.error) return fail(64, n.error, n.hint);
      subdir = n.subdir;
    }
    const res = runOpenwiki(r.kb, { repo: args.repo, subdir, detectOnly: args.detectOnly });
    if (res.fatal) return fail(1, res.fatal.message, res.fatal.hint);
    out(res.result);
    return EXIT.OK;
  } catch (e) { return fail(1, 'internal error', String(e && e.message || e)); }
}

export { EXIT, CONTRACT_VERSION, SOURCE_ID_RE, SLUG_RE, RAW_SOURCES, PAGE_TYPES, PAGE_STATUSES, DECISION_ACTIONS,
  out, warn, fail, resolveKb, checkKb, splitFrontmatter, parseFrontmatter, serializeFrontmatter, contentHash,
  appendLog, walkFiles, readJsonSafe, parseBoolFlag,
  sniffSelector, resolveSelectorType, flattenPageId, relpathFromSourceUrl, parseArgs, readAcquireState, writeAcquireState, runOpenwiki,
  adfToText, xhtmlToMd, runJira, runConfluence, main };

// robust isMain: fileURLToPath comparison survives '#', '?', '%' in script paths (URL-building does not)
// exitCode (not process.exit): a hard exit while undici/fetch handles are closing crashes on Windows
// (libuv UV_HANDLE_CLOSING assertion → 0xC0000409); natural exit lets them drain.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) { process.exitCode = await main(process.argv.slice(2)); }
