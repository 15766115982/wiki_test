---
type: source
status: approved
title: Payment Callback Retry (PROJ-55)
summary: Jira task raising the callback retry budget to 8 attempts with exponential backoff
created_at: 2026-08-10T09:20:00Z
updated_at: 2026-08-10T09:20:00Z
source_ref: jira/PROJ-55
sources: [raw:jira/PROJ-55]
related_topics: [payment]
---

PROJ-55 (Task) raises the payment callback retry budget to 8 attempts with exponential
backoff (base 5s, factor 2, cap 10 min) plus jitter; the attempt counter lives in
pay_callback_attempts. Part of the [[payment]] domain; backoff is observable via
[[order-state-machine]] metrics.
