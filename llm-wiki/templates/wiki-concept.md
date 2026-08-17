---
type: concept
status: approved
title: Example Concept Name
summary: One-line authoritative gloss of this concept.
created_at: 2026-01-01T00:00:00Z
updated_at: 2026-01-01T00:00:00Z
sources: [raw:jira/PROJ-123, raw:confluence/102]
aliases: [Example Alt Name]
---

<!--
wiki-concept.md — template for wiki/concepts/<slug>.md (spec §2.3). Authoritative
definition of an abstraction shared across documents.

- type: concept (fixed). sources: union of raw refs that discuss the concept (required).
- aliases: other names for the same concept; slug-registry lookup (canonical + aliases)
  decides merge vs new slug BEFORE drafting — an alias hit is a definite merge.
- Union-merge update: sources union, created_at preserved, body re-fused.
  Retention guardrail (machine-checked): keep ALL prior [[wikilinks]] and sources
  entries; losing >20% of key-fact lines (identifiers/numbers/error codes) forces a
  candidate whose review_note explains the loss. Prefer append-per-source sections
  over wholesale rewrites.
-->

## Definition

<authoritative definition of the concept, fused across sources>

## Per-Source Detail

### raw:jira/PROJ-123

<what this source says about the concept; append new sources as new sections>

### raw:confluence/102

<what this source adds or how its framing differs>

## Related

- [[example-entity]] — <relation>

<!--
Sidecar fields — when drafting a candidate, copy this page to wiki/concepts/<slug>.candidate.md
with status: candidate and add:
  base: wiki/concepts/example-slug.md   — target page path; null for a new page (key must exist)
  review_note: <why this is a candidate> — mandatory, the first thing reviewers see.
  Conflict candidates start review_note's FIRST line with:
  conflict: <kind> | parties: <a> vs <b>
-->
