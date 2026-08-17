---
source: jira
source_id: PROJ-55
source_url: https://jira.example.com/browse/PROJ-55
source_version: 2026-08-08T11:24:00Z
pulled_at: 2026-08-10T09:12:00Z
issue_type: Task
content_hash: sha256:ab7cf00dbd245217e6a9a6c4c220ac232b7819781d6281c771bcf21007bf8a08
---

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
