# Wiki Index

> Mechanical derivative of a govern run — do not hand-edit (§2.8).

## sources
- [[chat-payment-discussion|Chat: payment retry discrepancy]] — Distilled conversation flagging the 8-vs-5 retry count conflict between Jira and Confluence (chat/conv-a1b2c3d4e5f6, updated 2026-08-10)
- [[pay-table-design-v3|Pay Table Design v3]] — Confluence design of the 7-table payment schema; still documents 5 callback retries (confluence/102, updated 2026-08-10)
- [[payment-callback-retry|Payment Callback Retry (PROJ-55)]] — Jira task raising the callback retry budget to 8 attempts with exponential backoff (jira/PROJ-55, updated 2026-08-10)
- [[payment-glossary|Payment Glossary]] — Local glossary of payment-domain terms (PSP, callback, dead-letter, settlement) (local/payment-glossary, updated 2026-08-10)

## syntheses
- [[payment|Payment]] — Cross-source narrative of the payment domain: requirements, storage, reliability (4 sources, updated 2026-08-11)

## concepts
- [[order-state-machine|Order State Machine]] — Authoritative definition of the order lifecycle: created → paid → settling → settled | refunded | closed (updated 2026-08-10)

## entities
- [[pay-team|Pay Team]] — Team owning the payment callback pipeline and order-state-machine metrics (team, updated 2026-08-10)
