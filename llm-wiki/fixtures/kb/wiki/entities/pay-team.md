---
type: entity
status: approved
title: Pay Team
summary: Team owning the payment callback pipeline and order-state-machine metrics
created_at: 2026-08-10T09:20:00Z
updated_at: 2026-08-10T09:25:00Z
sources: [raw:jira/PROJ-55]
kind: team
aliases: [payments team, pay core team]
relations: [{target: order-state-machine, type: owns}, {target: payment, type: maintains}]
---

The pay team owns the callback retry pipeline (PROJ-55 dead-letter alarms route to its
on-call) and the [[order-state-machine]] metrics. Maintains the [[payment]] domain docs.
