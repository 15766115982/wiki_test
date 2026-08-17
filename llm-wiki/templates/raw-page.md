---
source: jira
source_id: PROJ-123
source_url: https://jira.example.com/browse/PROJ-123
source_version: 2026-01-01T00:00:00Z
pulled_at: 2026-01-01T00:00:00Z
content_hash: sha256:0000000000000000000000000000000000000000000000000000000000000000
---

<!--
raw-page.md — template for raw/<source>/<source_id>.md (spec §2.2)

Frontmatter = identity quintuple + hash. Field notes (all placeholders above are legal values):

- source: one of jira | confluence | chat | local | openwiki.
- source_id: whitelist ^[A-Za-z0-9][A-Za-z0-9_-]*$ — NEVER escape or sanitize a
  non-matching id; skip the document and report an error instead. The file path is
  mechanically raw/<source>/<source_id>.md (re-pull overwrites; git carries history).
- source_url: original URL; for chat use llmwiki://chat/<source_id>.
- source_version: source-system version / last-modified time, full precision.
  Unparseable values are kept verbatim — never fabricate.
- pulled_at: ISO 8601 pull timestamp.
- content_hash: "sha256:" + 64 hex over (source_version + "\n" + body), body newlines
  normalized to LF, trailing whitespace untouched. Manual degraded path exemption:
  write content_hash: "manual" — validate skips hash checks for it (and increments
  degrade to full overwrite with a notice).

Optional fields (add when applicable):
- issue_type: Story        — Jira ONLY (Task|Story|Test|...); may change, never enters the path.
- evidence_class: transcript — chat distillations only (§5 trust tiering).

Body: normalized document content (headings/lists/tables/code/links preserved; unknown
Confluence macros degrade to [macro: name] placeholders — never silently dropped).
Chat distillations: body points carry [T-n]/[R-n] tags with ## Appendix A / ## Appendix B —
see prompts/distill-chat.md.
-->

# <document title>

<normalized body>
