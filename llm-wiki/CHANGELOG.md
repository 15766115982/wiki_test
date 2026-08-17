# Changelog — llm-wiki skill

## [1.2.0] - 2026-08-17

**Fold executor upstreamed + Tier 0.5 topic index implemented** (two spec promises that were agent-side-only / unimplemented, closed after the v1.1 real run).

- **`govern fold` — mechanical fold executor** (spec §1.4/§4.1 step 4). The fold runner that powered the v1.1 real run lived only inside one KB instance (`.kb/govern/fold-run.mjs`); it is now a govern subcommand, generalized beyond its openwiki-only origin: `node govern.mjs --kb <path> fold --page wiki/<syntheses|concepts|entities>/<slug>.md --folds <folds.json> [--title <t> --summary <s>]`. folds.json = `[{ref, paragraph, page?}]` in fold order (`source_version` ascending); composing it IS the semantic-check's structured evidence. The executor applies folds strictly serially, gates each on `validate --file` (incl. the retention guardrail), restores the last-good page and exits 1 naming the failing fold on a gate failure, and skips refs already in the page's `sources:` (resume-safe). Chain-break candidates stay agent-written (naming the colliding pair takes judgment).
- **Tier 0.5 topic index** (spec §7 scale envelope). Past 500 approved pages, `rebuild-index` now also writes `wiki/topics.md` — the topic → page map promised since v1.0 (source-page `related_topics` slug-normalized, registry-attached syntheses, unregistered syntheses under their own slug) — adds `topics_index` to stdout and a pointer line in `index.md`, and removes a stale `topics.md` when the KB drops back under the threshold. Unreadable `topic-registry.json` is fail-closed (`corrupt-topic-registry`), matching the other `.kb/govern` state files.
- **Fix**: `install.test.mjs` no longer hardcodes the skill version — assertions read `install.readVersion()`, so version bumps stop breaking the copy-mode drift test.
- Touched: `scripts/govern.mjs` (fold subcommand + topic index), `SKILL.md` (scripts table, ch. 4 happy path + step 4 executor block + step 5 stdout, ch. 8 scale envelope), `spec/spec.zh-CN.md` + `spec/spec.en.md` (§1.4 CLI, §4.1 step 4, §7), `tests/install.test.mjs`, new `tests/govern-fold.test.mjs` (7 tests). No contract change — `contract_version` stays 1.

## [1.1.0] - 2026-08-13

**Synthesis folding replaces truncation** (design change driven by first-run evidence: 7 of 9 clusters hit the ≤6-source cap and flooded the adjudication queue with "N sources not covered" forced candidates).

- **Incremental folding, strictly serial** — non-source pages (synthesis/concept/entity) are built one page at a time, one fold at a time, never parallel-drafted. Each fold: read the current page (merge base — skipping the read is a contract violation) → fold in the next source (`source_version` ascending) → union-merge → double gate (validate incl. retention guardrail + semantic-check structured evidence) before landing.
- **`max_sources_per_cluster` semantics changed**: from "cluster coverage cap" to **fold batch size** (default 1). Key name unchanged — no `contract_version` bump; existing kb.json files keep parsing, values >1 simply mean larger folds. There is no cluster-size cap anymore: cluster coverage is always full.
- **Truncation rule retired** — no more "未覆盖 N 篇 / does not cover N sources" forced candidates, no next-round priority queue. Resume is structural: the page's `sources:` frontmatter is the cursor; `cluster members − page.sources` is the next run's remaining work.
- **Risk red line amended** — a fold that only unions `sources`, passes the refusion-retention guardrail, and outputs explicit `no_conflict` counts as a **pure append** (auto-approve eligible). Chain breaks (contradiction / guardrail loss / no evidence) stop the chain at that fold: last-good page stands, offending fold → candidate naming the colliding source pair.
- **Sub-agent fan-out scoped to source pages** (step 3.10); non-source pages follow the serial folding discipline.
- **Fix**: `govern plan`'s `review_queue` glob no longer re-queues archived sidecars (`wiki/archive/*.candidate.md` excluded — archived candidates are frozen record, not pending adjudication).
- **Site fixes** (`templates/site.html`, verified by headless-browser screenshots):
  - Graph view: the hand-rolled layout's repulsion cutoff + per-iteration boundary clamping collapsed all nodes into unreadable corner piles (looked like "graph not rendering"). Replaced with a proper Fruchterman–Reingold layout (k = √(WH/N), temperature-cooled displacement cap, weak gravity); labels now show only on hub pages (synthesis/concept/entity) with hover tooltips on every node — no more text smear.
  - Browse view: added the missing **页型 (page-type) filter**; filters with zero values (e.g. issue_type in a KB with no Jira) no longer render as empty dropdowns.
  - Browse view: type groups are now collapsible `<details>` sections (default collapsed) with a 全部展开/收起 toggle; navigating to a page auto-expands its group.
  - Graph view is now a **live force simulation on canvas** (ported from knowledge-extension `ui/public/views/graph.js`, zero-dep): uniform-grid repulsion (~O(n)/tick), springs, weak centering, alpha cooling with reheat on interaction, 300-tick pre-warm before first paint, fitView camera, wheel zoom / pan / node drag, hover tooltips, isolate-node toggle, relayout button. Replaces the static one-shot SVG layout.
- Touched: `SKILL.md` (ch. 2 kb.json semantics, ch. 4 step 3.10 + step 4 + red lines, ch. 10 fail-closed table), `prompts/draft-synthesis.md` (fold-mode rewrite), `prompts/draft-concept.md`, `prompts/extract-entity.md`, `templates/wiki-synthesis.md`, `spec/spec.zh-CN.md` + `spec/spec.en.md` (§2.3 red lines, §2.6 kb.json, §4.1 steps 3–4), `CONTEXT.md` (簇 / 折叠 terms).

## [1.0.0] - 2026-08-13

Initial release. Implements spec v1.0 (`spec/spec.zh-CN.md` / `spec.en.md`). KB `contract_version: 1`.

**Capabilities**

- **Acquire** — self-contained connectors: Jira/Confluence Server/DC (PAT via env vars; URL/issue-key/JQL/CQL selectors with sniffing; detect-first incremental; two-strike `removed_upstream`; attachments with hash dedupe; XHTML→Markdown / ADF→text minimal conversion with `[macro: name]` degradation) and OpenWiki local repos (path flattening, deletion handling, subset pulls). Manual paste fallback per SKILL.md.
- **Govern** — `sweep` / `plan` (six lists) / `rebuild-index` / `record-decision` with run locking, git-baseline change detection, conflict-pair detection, and the adjudication-memory trio (tombstones / dismissals / decisions.jsonl).
- **Validate** — fail-closed govern + distill check sets, including the re-fusion retention guardrail and global slug uniqueness.
- **Render** — adjudication report (single-file HTML, five actions, reply-text contract) and four-view static site (browse / graph / history / overview); all §6 HTML safety hard requirements.
- **Agentic retrieval & chat distillation** — fully specified in SKILL.md + prompts/ (six-rule retrieval protocol, dual-appendix distillation with fail-closed validation).

**Scripts** (`scripts/`, zero-dependency Node ≥20 .mjs, JSON stdout): `acquire`, `validate`, `govern`, `render`, `install`.

**Known boundaries**

- Jira/Confluence **Cloud** not supported (Server/DC PAT only); Zephyr Scale test-step pull deferred to a connector phase 2.
- Distillation appendices are transcribed by the host agent; fidelity rests on validate's internal-consistency checks + agent discipline (declared in SKILL.md and §5).
- Retrieval protocol designed for ≤500-page KBs; larger scale uses the documented index sectioning / 深研 fallbacks.
