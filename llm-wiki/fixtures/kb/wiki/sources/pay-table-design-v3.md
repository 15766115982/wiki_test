---
type: source
status: approved
title: Pay Table Design v3
summary: Confluence design of the 7-table payment schema; still documents 5 callback retries
created_at: 2026-08-10T09:20:00Z
updated_at: 2026-08-10T09:21:00Z
source_ref: confluence/102
sources: [raw:confluence/102]
related_topics: [payment]
---

Pay table design v3 (Confluence 102) defines the 7-table payment schema and documents a
callback retry policy of 5 attempts at fixed 30s intervals — a figure that predates
[[payment-callback-retry|PROJ-55]] and is pending update. Feeds the [[payment]] synthesis.
