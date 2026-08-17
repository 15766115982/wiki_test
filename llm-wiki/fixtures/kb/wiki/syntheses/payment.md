---
type: synthesis
status: approved
title: Payment
summary: "Cross-source narrative of the payment domain: requirements, storage, reliability"
created_at: 2026-08-10T09:20:00Z
updated_at: 2026-08-11T15:00:00Z
sources: [raw:jira/PROJ-55, raw:confluence/102, raw:chat/conv-a1b2c3d4e5f6, raw:local/payment-glossary]
---

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
