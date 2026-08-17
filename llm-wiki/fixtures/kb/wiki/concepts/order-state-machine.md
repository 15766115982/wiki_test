---
type: concept
status: approved
title: Order State Machine
summary: "Authoritative definition of the order lifecycle: created → paid → settling → settled | refunded | closed"
created_at: 2026-07-01T09:00:00Z
updated_at: 2026-08-10T09:24:00Z
sources: [raw:jira/PROJ-55, raw:confluence/102]
---

# Order State Machine

The order lifecycle shared across payment docs: created → paid → settling → settled, with
refunded and closed as terminal branches (raw:confluence/102). Retry scheduling hooks into
the settling state and is exported as metrics (raw:jira/PROJ-55). Part of [[payment]].
