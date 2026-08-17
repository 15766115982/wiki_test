---
type: source
status: approved
title: Example Source Page Title
summary: One-line description of this source page.
created_at: 2026-01-01T00:00:00Z
updated_at: 2026-01-01T00:00:00Z
source_ref: jira/PROJ-123
related_topics: [example-topic]
---

<!--
wiki-source.md — template for wiki/sources/<slug>.md (spec §2.3). 1:1 with one raw doc.

- type: source (fixed). status: approved for a page file; candidates use the sidecar
  form described below.
- title / summary: written at draft time; summary is single-line and feeds index.md
  lines and site listings (index rebuild never regenerates it).
- created_at / updated_at: ISO 8601; created_at never changes after first approval.
- source_ref: <source>/<source_id> of the backing raw doc — exactly 1:1, no raw: prefix.
- related_topics: clustering hooks for synthesis (§4.1 step 4); reuse normalized topic
  names from .kb/govern/topic-registry.json, do not invent near-duplicates.
- Slug of the file: ^[a-z0-9][a-z0-9-]*$.
- Summary emphasis by issue_type (§3): Story → requirement points + acceptance criteria;
  Test → test scope; Task → technical approach.
-->

## Summary

<single-source summary of the raw document — no facts from other documents>

## Key Points

- <key point> (raw:jira/PROJ-123)
- <key point> (raw:jira/PROJ-123)

## Related

- [[example-concept]] — <why related>
- [[example-entity|Display Name]] — <why related>

<!--
Sidecar fields — when drafting a candidate, copy this page to wiki/sources/<slug>.candidate.md
with status: candidate and add:
  base: wiki/sources/example-slug.md    — target page path; null for a new page (key must exist)
  review_note: <why this is a candidate> — mandatory, the first thing reviewers see.
  Conflict candidates start review_note's FIRST line with:
  conflict: <kind> | parties: <a> vs <b>
-->
