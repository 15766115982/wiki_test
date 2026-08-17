---
type: synthesis
status: approved
title: Example Synthesis Title
summary: One-line description of this cross-source topic.
created_at: 2026-01-01T00:00:00Z
updated_at: 2026-01-01T00:00:00Z
sources: [raw:jira/PROJ-123, raw:confluence/102]
---

<!--
wiki-synthesis.md — template for wiki/syntheses/<slug>.md (spec §2.3). Cross-source
topic narrative produced by clustering (§4.1 step 4).

- type: synthesis (fixed). sources: union list of backing raw refs, entry form
  raw:<source>/<source_id> — required for every non-source page; union-merge semantics.
- Every claim in the body carries a (raw:<source>/<source_id>) backing tag; an untagged
  claim is a defect. A synthesis may state conclusions no single source states — but
  only as conclusions FROM the tagged sources.
- Trust tiering (§5): a transcript-class source (evidence_class: transcript) MUST NOT
  solely support a claim; such orphan claims force the page to candidate.
- Folding (§4.1 step 4): syntheses are built by strictly serial incremental folds —
  one source per fold, current page as merge base, double gate (validate + semantic-check)
  per fold. A chain-breaking fold (contradiction / guardrail loss / no structured
  evidence) → sidecar candidate naming the colliding source pair; remaining sources
  resume next run (resume is structural: cluster members − page.sources).
-->

## Narrative

<topic narrative; every claim tagged, e.g.:> The payment service retries on HTTP 502
(raw:jira/PROJ-123) and the retry cap is 5 (raw:confluence/102).

## Open Questions

- <point the sources leave unresolved, with the tags of the disagreeing sources>

## Sources

- raw:jira/PROJ-123 — [[example-source-page]]
- raw:confluence/102 — [[another-source-page]]

<!--
Sidecar fields — when drafting a candidate, copy this page to wiki/syntheses/<slug>.candidate.md
with status: candidate and add:
  base: wiki/syntheses/example-slug.md  — target page path; null for a new page (key must exist)
  review_note: <why this is a candidate> — mandatory, the first thing reviewers see.
  Conflict candidates start review_note's FIRST line with:
  conflict: <kind> | parties: <a> vs <b>
-->
