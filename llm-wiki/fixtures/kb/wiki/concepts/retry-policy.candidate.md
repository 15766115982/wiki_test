---
type: concept
status: candidate
title: Retry Policy
summary: Proposed concept page for the payment callback retry policy
created_at: 2026-08-12T09:00:00Z
updated_at: 2026-08-12T09:00:00Z
sources: [raw:jira/PROJ-55, raw:confluence/102]
base: null
review_note: "New-page candidate: retry counts conflict across sources — Jira PROJ-55 says 8, Confluence 102 says 5; semantic-check outcome <unresolved>, needs human confirmation"
---

# Retry Policy

The payment callback retry policy: Jira PROJ-55 specifies 8 attempts with exponential
backoff (raw:jira/PROJ-55); Confluence page 102 documents 5 attempts (raw:confluence/102).
Belongs to [[payment]]; scheduling hooks into the [[order-state-machine]] settling state.
