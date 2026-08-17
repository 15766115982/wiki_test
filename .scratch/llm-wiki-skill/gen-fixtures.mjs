// One-off generator for llm-wiki/fixtures (scratch tool, NOT a deliverable).
// Writes the example KB + upstream repo using the script's own canonical
// serializeFrontmatter/contentHash so every frontmatter is subset-legal and every
// raw content_hash is real (§2.2). wiki/index.md is NOT written here — it is
// produced by running `govern rebuild-index` on a temp git-initialized copy
// (see the bottom of this script) so the committed fixture is byte-identical.
import { mkdirSync, writeFileSync, cpSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const { serializeFrontmatter, contentHash } = await import(pathToFileURL(resolve(REPO, 'llm-wiki/scripts/validate.mjs')).href);

const KB = join(REPO, 'llm-wiki', 'fixtures', 'kb');
const UPSTREAM = join(REPO, 'llm-wiki', 'fixtures', 'upstream-repo');

const w = (rel, text) => { const p = join(KB, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); };
const wBin = (rel, buf) => { const p = join(KB, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, buf); };
const wu = (rel, text) => { const p = join(UPSTREAM, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); };

/** Write a raw doc; content_hash computed for real unless fm.content_hash is preset ("manual"). */
function raw(source, sourceId, fm, body) {
  const data = { source, source_id: sourceId, ...fm };
  if (data.content_hash === undefined) data.content_hash = contentHash(data.source_version, body);
  w(`raw/${source}/${sourceId}.md`, serializeFrontmatter(data, body));
}
function wiki(rel, data, body) { w(`wiki/${rel}`, serializeFrontmatter(data, body)); }

// ---------- kb.json / GOVERNANCE.md / .gitignore / log.md ----------
w('kb.json', JSON.stringify({
  contract_version: 1,
  language: 'en',
  connectors: {
    jira: { base_url: 'https://jira.example.com', pat_env: 'JIRA_PAT' },
    confluence: { base_url: 'https://wiki.example.com', pat_env: 'CONFLUENCE_PAT' },
  },
  governance: { max_clusters_per_run: 10, max_sources_per_cluster: 6, max_chars_per_source: 2500 },
}, null, 2) + '\n');

w('GOVERNANCE.md', `# Governance Brief

- When Jira and Confluence disagree on payment behavior, prefer the Jira (implementation-side) reading until adjudicated.
- Keep glossary terms in English; localized UI labels belong in aliases, not in page bodies.
`);

w('.gitignore', '.kb/\n');

w('log.md', [
  '## [2026-08-10T09:12:00Z] acquire | pull | raw/jira/PROJ-55.md | created',
  '## [2026-08-10T09:12:30Z] acquire | pull | raw/confluence/102.md | created',
  '## [2026-08-10T09:13:00Z] acquire | pull | raw/local/payment-glossary.md | created',
  '## [2026-08-10T09:14:00Z] agent | distill | raw/chat/conv-a1b2c3d4e5f6.md | created',
  '## [2026-08-10T09:15:00Z] acquire | sync | raw/openwiki/architecture--overview.md | created',
  '## [2026-08-10T10:00:00Z] govern | sweep | wiki/archive/old-glossary.md | rejected → archived',
  '## [2026-08-10T10:30:00Z] govern | auto:auto-approve | wiki/sources/payment-glossary.md | cited=[]',
  '## [2026-08-11T15:00:00Z] review | approve | wiki/syntheses/payment.md | Adopt implementation-side retry count pending reconciliation',
  '## [2026-08-11T15:00:30Z] govern | rebuild | wiki/index.md | run completed',
  '',
].join('\n'));

// ---------- raw: five sources ----------
raw('jira', 'PROJ-55', {
  source_url: 'https://jira.example.com/browse/PROJ-55',
  source_version: '2026-08-08T11:24:00Z',
  pulled_at: '2026-08-10T09:12:00Z',
  issue_type: 'Task',
}, `
# PROJ-55 — Payment callback retry: raise max attempts to 8

Issue type: Task
Status: In Progress
Assignee: A. Rivera

## Technical approach

The payment callback worker today retries failed webhook deliveries 5 times.
Intermittent PSP timeouts during month-end settlement caused missed callbacks, so the
retry budget is raised to 8 attempts with exponential backoff (base 5s, factor 2,
cap 10 min) plus jitter. The attempt counter lives in the pay_callback_attempts table
(see the pay table design v3, Confluence page 102).

## Acceptance criteria

- The callback worker retries up to 8 times before dead-lettering.
- The backoff schedule is observable via order-state-machine metrics.

## Comments (latest 2)

- A. Rivera (2026-08-07): backoff base confirmed with SRE.
- K. Chen (2026-08-08): dead-letter alarm routed to the pay team on-call.
`);

raw('confluence', '102', {
  source_url: 'https://wiki.example.com/pages/viewpage.action?pageId=102',
  source_version: '3',
  pulled_at: '2026-08-10T09:12:30Z',
}, `
# Pay Table Design v3

Version 3 of the payment schema covers 7 tables: pay_order, pay_callback_attempts,
pay_refund, pay_settlement, pay_channel, pay_recon, pay_audit.

## Callback retry policy

Failed payment callbacks are retried 5 times at fixed 30s intervals, then moved to the
dead-letter table. This figure predates the PROJ-55 change and is pending update.

## Order states

Order lifecycle: created → paid → settling → settled | refunded | closed.

![schema](../assets/confluence/102/schema.png)
`);

raw('chat', 'conv-a1b2c3d4e5f6', {
  source_url: 'llmwiki://chat/conv-a1b2c3d4e5f6',
  source_version: '2026-08-09',
  pulled_at: '2026-08-10T09:14:00Z',
  content_hash: 'manual',
  evidence_class: 'transcript',
}, `
We reviewed the payment callback retry behavior. The Jira task PROJ-55 specifies 8 retries
with exponential backoff [T-1]. The Confluence pay table design v3 still documents 5 retries,
which conflicts and needs adjudication [T-2]. A blog post on retry best practices was
referenced for background [R-1].

## Appendix A — Transcript

### T-1 (user, 2026-08-09T10:02:00Z)
Look at PROJ-55: the payment callback retry task raises the budget to 8 retries with exponential backoff.

### T-2 (assistant, 2026-08-09T10:03:30Z)
Noted. The Confluence pay table design v3 (page 102) documents 5 retries — that conflicts with PROJ-55 and should go through adjudication.

## Appendix B — References

### R-1 (external, fetched 2026-08-09T10:01:00Z)
Source: https://blog.example.com/payment-retry-best-practices
Excerpt: Retry policies for payment callbacks should cap attempts and use exponential backoff with jitter.
`);

raw('local', 'payment-glossary', {
  source_url: 'file:///C:/docs/payment-glossary.md',
  source_version: '2026-08-01',
  pulled_at: '2026-08-10T09:13:00Z',
}, `
# Payment Glossary

- PSP — payment service provider; the external gateway that processes charges.
- callback — asynchronous webhook the PSP sends to report a payment result.
- dead-letter — final resting state for messages that exhausted all retries.
- reconciliation — matching internal pay tables against PSP settlement files.
- settlement — the periodic transfer of captured funds from PSP to merchant.
`);

// openwiki raw: body = the upstream page VERBATIM (OKF frontmatter preserved in body, §3.1)
const ARCH_PAGE = `---
okf: "0.1"
title: Architecture Overview
generated_by: openwiki
---

# Architecture Overview

The payment-service repository is split into three modules:

- payments-core — order state machine and retry scheduling
- payments-api — REST callbacks and webhook ingress
- payments-store — pay tables (see Confluence page 102)

See [the index](./index.md) for the full repository map.
`;
raw('openwiki', 'architecture--overview', {
  source_url: 'https://example.com/repo.git#openwiki/architecture/overview.md',
  source_version: '2026-08-05T08:00:00Z',
  pulled_at: '2026-08-10T09:15:00Z',
}, ARCH_PAGE);

// tiny placeholder PNG (magic bytes + a few more)
wBin('raw/assets/confluence/102/schema.png',
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]));

// ---------- wiki pages ----------
const CA = '2026-08-10T09:20:00Z';

wiki('sources/payment-callback-retry.md', {
  type: 'source', status: 'approved',
  title: 'Payment Callback Retry (PROJ-55)',
  summary: 'Jira task raising the callback retry budget to 8 attempts with exponential backoff',
  created_at: CA, updated_at: '2026-08-10T09:20:00Z',
  source_ref: 'jira/PROJ-55',
  sources: ['raw:jira/PROJ-55'],
  related_topics: ['payment'],
}, `
PROJ-55 (Task) raises the payment callback retry budget to 8 attempts with exponential
backoff (base 5s, factor 2, cap 10 min) plus jitter; the attempt counter lives in
pay_callback_attempts. Part of the [[payment]] domain; backoff is observable via
[[order-state-machine]] metrics.
`);

wiki('sources/pay-table-design-v3.md', {
  type: 'source', status: 'approved',
  title: 'Pay Table Design v3',
  summary: 'Confluence design of the 7-table payment schema; still documents 5 callback retries',
  created_at: CA, updated_at: '2026-08-10T09:21:00Z',
  source_ref: 'confluence/102',
  sources: ['raw:confluence/102'],
  related_topics: ['payment'],
}, `
Pay table design v3 (Confluence 102) defines the 7-table payment schema and documents a
callback retry policy of 5 attempts at fixed 30s intervals — a figure that predates
[[payment-callback-retry|PROJ-55]] and is pending update. Feeds the [[payment]] synthesis.
`);

wiki('sources/chat-payment-discussion.md', {
  type: 'source', status: 'approved',
  title: 'Chat: payment retry discrepancy',
  summary: 'Distilled conversation flagging the 8-vs-5 retry count conflict between Jira and Confluence',
  created_at: CA, updated_at: '2026-08-10T09:22:00Z',
  source_ref: 'chat/conv-a1b2c3d4e5f6',
  sources: ['raw:chat/conv-a1b2c3d4e5f6'],
  related_topics: ['payment'],
}, `
Distilled review conversation (transcript evidence class): participants noted that PROJ-55
specifies 8 retries while the pay table design v3 documents 5, and agreed the conflict needs
adjudication. Corroborates the [[payment]] synthesis; not a standalone basis for claims.
`);

wiki('sources/payment-glossary.md', {
  type: 'source', status: 'approved',
  title: 'Payment Glossary',
  summary: 'Local glossary of payment-domain terms (PSP, callback, dead-letter, settlement)',
  created_at: CA, updated_at: '2026-08-10T09:23:00Z',
  source_ref: 'local/payment-glossary',
  sources: ['raw:local/payment-glossary'],
  related_topics: ['payment'],
}, `
Local glossary defining PSP, callback, dead-letter, reconciliation, and settlement.
Terminology anchor for the [[payment]] domain.
`);

wiki('syntheses/payment.md', {
  type: 'synthesis', status: 'approved',
  title: 'Payment',
  summary: 'Cross-source narrative of the payment domain: requirements, storage, reliability',
  created_at: CA, updated_at: '2026-08-11T15:00:00Z',
  sources: ['raw:jira/PROJ-55', 'raw:confluence/102', 'raw:chat/conv-a1b2c3d4e5f6', 'raw:local/payment-glossary'],
}, `
# Payment

## Requirements

The payment callback retry budget is 8 attempts with exponential backoff (raw:jira/PROJ-55).
The pay table design v3 still documents 5 retries — a stale figure pending update
(raw:confluence/102); the discrepancy was flagged in review (raw:chat/conv-a1b2c3d4e5f6)
and adjudicated in favor of the implementation-side reading.

## Storage

The payment schema spans 7 tables including pay_order and pay_callback_attempts
(raw:confluence/102).

## Terminology

Domain terms are anchored in the [[payment-glossary|payment glossary]] (raw:local/payment-glossary).

See also: [[payment-callback-retry]], [[pay-table-design-v3]], [[chat-payment-discussion]],
[[order-state-machine]], [[pay-team]].
`);

wiki('concepts/order-state-machine.md', {
  type: 'concept', status: 'approved',
  title: 'Order State Machine',
  summary: 'Authoritative definition of the order lifecycle: created → paid → settling → settled | refunded | closed',
  created_at: '2026-07-01T09:00:00Z', updated_at: '2026-08-10T09:24:00Z',
  sources: ['raw:jira/PROJ-55', 'raw:confluence/102'],
}, `
# Order State Machine

The order lifecycle shared across payment docs: created → paid → settling → settled, with
refunded and closed as terminal branches (raw:confluence/102). Retry scheduling hooks into
the settling state and is exported as metrics (raw:jira/PROJ-55). Part of [[payment]].
`);

wiki('entities/pay-team.md', {
  type: 'entity', status: 'approved',
  title: 'Pay Team',
  summary: 'Team owning the payment callback pipeline and order-state-machine metrics',
  created_at: CA, updated_at: '2026-08-10T09:25:00Z',
  sources: ['raw:jira/PROJ-55'],
  kind: 'team',
  aliases: ['payments team', 'pay core team'],
  relations: [{ target: 'order-state-machine', type: 'owns' }, { target: 'payment', type: 'maintains' }],
}, `
The pay team owns the callback retry pipeline (PROJ-55 dead-letter alarms route to its
on-call) and the [[order-state-machine]] metrics. Maintains the [[payment]] domain docs.
`);

wiki('concepts/retry-policy.candidate.md', {
  type: 'concept', status: 'candidate',
  title: 'Retry Policy',
  summary: 'Proposed concept page for the payment callback retry policy',
  created_at: '2026-08-12T09:00:00Z', updated_at: '2026-08-12T09:00:00Z',
  sources: ['raw:jira/PROJ-55', 'raw:confluence/102'],
  base: null,
  review_note: 'New-page candidate: retry counts conflict across sources — Jira PROJ-55 says 8, Confluence 102 says 5; semantic-check outcome <unresolved>, needs human confirmation',
}, `
# Retry Policy

The payment callback retry policy: Jira PROJ-55 specifies 8 attempts with exponential
backoff (raw:jira/PROJ-55); Confluence page 102 documents 5 attempts (raw:confluence/102).
Belongs to [[payment]]; scheduling hooks into the [[order-state-machine]] settling state.
`);

wiki('archive/old-glossary.md', {
  type: 'concept', status: 'archived',
  title: 'Old Glossary',
  summary: 'Superseded glossary draft, archived after rejection',
  created_at: '2026-07-15T10:00:00Z', updated_at: '2026-08-10T10:00:00Z',
  sources: ['raw:local/payment-glossary'],
}, `
Superseded by the curated payment glossary. Archived record — links here are not rewritten.
`);

// ---------- .kb/govern pre-state ----------
w('.kb/govern/decisions.jsonl', [
  JSON.stringify({ id: 'd-20260701-001', ts: '2026-07-01T09:00:00Z', actor: 'human', action: 'approve', page: 'wiki/concepts/order-state-machine.md', reason: 'Initial concept page reviewed and accepted' }),
  JSON.stringify({ id: 'd-20260810-001', ts: '2026-08-10T10:30:00Z', actor: 'agent', action: 'auto-approve', page: 'wiki/sources/payment-glossary.md', cited: [] }),
  JSON.stringify({ id: 'd-20260811-001', ts: '2026-08-11T15:00:00Z', actor: 'human', action: 'approve', page: 'wiki/syntheses/payment.md', reason: 'Adopt implementation-side retry count pending reconciliation', cited: ['d-20260701-001'] }),
  '',
].join('\n'));

w('.kb/govern/source-tombstones.json', JSON.stringify({
  'raw:confluence/097': { ts: '2026-08-05T10:00:00Z', reason: 'archive-loser to wiki/syntheses/payment.md (superseded by page 102)', decision: 'd-20260805-001' },
}, null, 2) + '\n');

w('.kb/govern/conflict-dismissals.json', JSON.stringify([
  { a: 'raw:chat/conv-a1b2c3d4e5f6', b: 'raw:local/payment-glossary', ts: '2026-08-10T11:00:00Z', decision: 'd-20260810-002' },
], null, 2) + '\n');

w('.kb/govern/slug-registry.json', JSON.stringify({
  entries: [
    { slug: 'payment', canonical: 'Payment', aliases: ['payment domain'] },
    { slug: 'order-state-machine', canonical: 'Order State Machine', aliases: ['order lifecycle'] },
    { slug: 'pay-team', canonical: 'Pay Team', aliases: ['payments team', 'pay core team'] },
    { slug: 'retry-policy', canonical: 'Retry Policy', aliases: ['callback retry policy'] },
  ],
}, null, 2) + '\n');

w('.kb/govern/topic-registry.json', JSON.stringify({
  topics: [
    { topic: 'payment', registered_at: '2026-08-10T09:20:00Z', synthesis: 'wiki/syntheses/payment.md' },
  ],
}, null, 2) + '\n');

w('.kb/govern/runs.jsonl',
  JSON.stringify({ ts: '2026-08-11T15:00:30Z', status: 'completed', stats: { sources: 4, syntheses: 1, concepts: 1, entities: 1 } }) + '\n');

// ---------- upstream repo ----------
wu('openwiki/index.md', `---
okf: "0.1"
title: payment-service Wiki
generated_by: openwiki
---

# payment-service Wiki

Repository map for the payment-service codebase. Start at
[Architecture Overview](./architecture/overview.md).
`);
wu('openwiki/architecture/overview.md', ARCH_PAGE);
wu('openwiki/INSTRUCTIONS.md', `# Instructions

This file guides the upstream wiki generator. The KB connector skip-lists it (§3.1).
`);

// ---------- index.md: generate via rebuild-index on a temp git copy ----------
const tmpKb = mkdtempSync(join(tmpdir(), 'llmwiki-fixgen-'));
cpSync(KB, tmpKb, { recursive: true });
const git = (...a) => execFileSync('git', ['-C', tmpKb, ...a], {
  env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
git('init'); git('add', '-A'); git('commit', '-m', 'init');
execFileSync(process.execPath, [join(REPO, 'llm-wiki', 'scripts', 'govern.mjs'), '--kb', tmpKb, 'rebuild-index'], { stdio: 'inherit' });
writeFileSync(join(KB, 'wiki', 'index.md'), readFileSync(join(tmpKb, 'wiki', 'index.md')));
console.log('fixtures generated; index.md captured from rebuild-index');
