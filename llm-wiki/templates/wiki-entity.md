---
type: entity
status: approved
title: Example Entity Name
summary: One-line description of this entity.
created_at: 2026-01-01T00:00:00Z
updated_at: 2026-01-01T00:00:00Z
sources: [raw:jira/PROJ-123]
kind: system
aliases: [Example Alias]
tags: [example-tag]
relations: [{target: other-entity, type: depends-on}]
---

<!--
wiki-entity.md — template for wiki/entities/<slug>.md (spec §2.3). Named entity with
typed relations.

- type: entity (fixed). sources: union of raw refs (required).
- kind: entity type, e.g. team | system | service | component (optional but recommended).
- aliases: entity matching is case-insensitive + trim; an alias hit on the slug registry
  is a definite merge — reuse the existing slug.
- tags: free-form classification for site filtering.
- relations: typed edges [{target: <slug>, type: <relation name>}] — only relations a
  source states; no cross-document inference in the extraction step.
-->

## Description

<what this entity is, per the sources>

## Relations

- [[other-entity]] — depends-on (raw:jira/PROJ-123)

## Per-Source Detail

### raw:jira/PROJ-123

<what this source says about the entity>

<!--
Sidecar fields — when drafting a candidate, copy this page to wiki/entities/<slug>.candidate.md
with status: candidate and add:
  base: wiki/entities/example-slug.md   — target page path; null for a new page (key must exist)
  review_note: <why this is a candidate> — mandatory, the first thing reviewers see.
  Conflict candidates start review_note's FIRST line with:
  conflict: <kind> | parties: <a> vs <b>
-->
