---
source: openwiki
source_id: architecture--overview
source_url: "https://example.com/repo.git#openwiki/architecture/overview.md"
source_version: 2026-08-05T08:00:00Z
pulled_at: 2026-08-10T09:15:00Z
content_hash: sha256:d8e1c5fabd1b848a38b0ab472509c5aba76f148ac36d48aad55627c666a4d9bc
---
---
okf: "0.1"
title: Architecture Overview
generated_by: openwiki
---

# Architecture Overview

The payment-service repository is split into three modules:

- payments-core — order state machine and retry scheduling
- payments-api — REST callbacks and webhook ingress
- payments-store — pay tables (see Confluence page 102)

See [the index](./index.md) for the full repository map.
