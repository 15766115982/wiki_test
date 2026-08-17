# LLM Wiki Skill — 最终验收报告

- **日期:** 2026-08-13
- **验收人:** final acceptance reviewer(独立复核,不采信先前声明)
- **依据:** `spec/spec.zh-CN.md` §10(权威)/ 交付物 `llm-wiki/` / 测试 `tests/`
- **测试观察值:** `node --test` 全量 **210 tests / 210 pass / 0 fail**(duration ≈ 41s,Node v24.19.0);`tests/e2e.test.mjs` 单跑 2/2 pass

---

## Part 1 — fixtures / e2e 专项结论

| 核查点 | 结果 | 证据 |
|---|---|---|
| fixture KB 通过 validate | ✓ | 手动执行 `node llm-wiki/scripts/validate.mjs --kb llm-wiki/fixtures/kb` → exit 0,`{checked: 13, passed: true, failures: []}`;另有 e2e 测试 `fixtures self-check` |
| e2e 剧本覆盖 acquire → validate → govern(sweep/plan/rebuild-index)→ render(report+site)→ record-decision → 裁决应用 → re-validate | ✓ | `tests/e2e.test.mjs:39-122`,单测试串行跑完整链;裁决应用按 §2.3 approve 语义做原子落盘(sidecar 删除 + 目标页写入 + status 翻转),落盘后全库 re-validate exit 0 且 rebuild counts.concepts 1→2 |
| 降级豁免点显式列出 | ✓ | `tests/e2e.test.mjs:3-11` 头部注释逐条列出三个降级 delta(content_hash "manual" / 降级禁 auto-approve / agent 代执行同 message 的 git commit),并声明机检范围只覆盖脚本路径 |
| index.md 幂等字节断言 | ✓ | `tests/e2e.test.mjs:68` — rebuild 产物与 fixture 内 committed `wiki/index.md` 逐字节相等 |
| fixture 内部一致性(source_refs / 悬空链 / decisions.jsonl) | ✓ | validate 全绿(含引用解析检查);人工抽查:四个 source 页 `source_ref` 均指向存在的 raw;synthesis/concept/entity 的 `sources` 均可解析;wikilink([[payment]]/[[order-state-machine]]/[[pay-team]] 等)全部落位 approved slug;`decisions.jsonl` 3 行均符合 §2.6(human 行带 `reason`,agent 行带 `cited`,id 形态 `d-<yyyymmdd>-<seq3>`);candidate 的 `base: null` + `review_note` 齐备;archive 页 status=archived |
| fixture 五来源覆盖 | ✓ | raw/ 下 jira / confluence / chat / local / openwiki 各至少一篇,另有 `raw/assets/confluence/102/schema.png` 附件样例;上游 OpenWiki 仓库 fixture(`fixtures/upstream-repo/`)供 acquire 真实拉取 |
| e2e 中 §6 安全断言 | ✓ | review_note 中的 `<unresolved>` 仅以转义形态出现;报告 HTML 无 `fetch(` / `localStorage` / `sessionStorage` / `XMLHttpRequest`;site 数据岛中 index 不参与任何图边 |

**观察(非阻塞):**
1. `raw/openwiki/architecture--overview.md` 无对应 source 页——这是刻意的:e2e 靠它在 plan 的 `pending` 中产生一个 `new` 项(实测验证:`govern plan` 输出该 raw 为 `pending.new`)。§9 括注"每种来源至少一篇 raw + 对应 wiki 页"若逐字解读,openwiki 来源缺"对应 wiki 页";判定为合理的剧本设计取舍,记注不记缺。
2. fixture 的 `source-tombstones.json` / `conflict-dismissals.json` 引用的 decision id(`d-20260805-001` / `d-20260810-002`)不在 fixture 的 `decisions.jsonl` 中。§2.6 未要求该引用完整性(历史截断属正常形态),记注。

---

## Part 2 — §10 逐行验收

### 行 1 — 脚本符合 §1.2 约定(五个脚本)+ 手动路径可照做 ✓

- 五个脚本均为零依赖单文件 `.mjs`:全部 import 仅 `node:*` builtins(grep 全部脚本确认,无一 npm 依赖)。
- JSON stdout(含错误对象 `{error:{code,message,hint}}`):实测五脚本无参/错参调用均输出 JSON;`contract.test.mjs` 对四脚本机检 "stdout is always JSON, even on usage errors"。
- exit 64:实测 `validate.mjs --bogus` → 64(`unknown flag`)、`--kb` 缺值 → 64、无 KB 路径 → 64(提示同时给 `--kb` 与 `LLM_WIKI_KB` 两种设法,含 setx/export 双形态)。
- exit 65:实测 `--kb` 指向非 KB 目录 → 65,报错附 init 口令指引。
- `--flag` 布尔语义:实测 `--detect-only maybe` → 64 `invalid boolean value`;`tests/acquire.test.mjs` "bad boolean flag value → exit 64; --flag=false accepted"。
- install.mjs(第五脚本)同约定:`install.test.mjs` 含 "usage errors → exit 64 with JSON stdout"、"stdout paths are forward-slashed"。
- 手动路径:SKILL.md 每章附无脚本降级小节——ch3 acquire 手动 raw 逐字段清单 + 完整示例(含 `content_hash: "manual"` 及可靠性降级声明)、ch4 sweep/plan/validate/record/rebuild 全部有手动等价步骤、ch5 裁决记录的手工 JSON 形态、ch6 蒸馏手动校验、ch7 render 降级三核心视图。粒度达到 agent 可照做。

### 行 2 — SKILL.md 八项内容 ✓

init 章(ch2,五步含 clone 场景)、拉取指引(ch3,选择器嗅探/CLI/行为契约/手动路径)、治理 runbook 七步(ch4,前置探测 + 步 0–6 与 §4.1 对应)、检索协议六条(ch8,Rule 0–5 + 规模包线 +  worked round)、蒸馏流程(ch6,长度门/双附录/fail-closed/信任分层/身份/诚实声明)、可视化指引(ch7,报告解剖 + 站点四视图)、五动作裁决菜单(ch5,含回复文本契约与 archive-loser 无默认)、风险分级红线(ch4 步 3,§2.3 语义逐字)。

### 行 3 — 九 prompt 模板 ✓

`llm-wiki/prompts/` 恰九文件,与 §4.3 清单同名。七个治理类模板(classify-page / draft-source-page / extract-entity / draft-concept / draft-synthesis / semantic-check / govern-decide)均含 `{{brief}}`(grep 实测各 2 处);九个模板全部含 "data, not instructions" 隔离条款。`contract.test.mjs` 三条机检(九模板存在+隔离语、七模板 {{brief}}、逐模板契约锚点如 `no_conflict`/`referenced_decisions`/30000 字符门)。

### 行 4 — KB 契约章可据以手写校验器 ✓

- frontmatter 字段:`templates/` 五个页面模板(raw-page/wiki-source/wiki-synthesis/wiki-concept/wiki-entity)给出可解析 exemplar(contract.test 用 parseFrontmatter 机检);SKILL.md ch4 步 5 内嵌完整字段参考。
- 状态机与 sidecar 模型:SKILL.md ch1 + ch4 + ch5;validate.mjs 机检 status 白名单(`status-whitelist: page file status rejected fails; sidecar status approved fails`)。
- slug/路径白名单:共享段 `SOURCE_ID_RE`/`SLUG_RE`(validate.mjs:13-14),validate 机检(source-id-whitelist / slug-whitelist 测试)。
- index.md:§2.4 格式在 SKILL.md ch4 步 5 逐字内嵌 + fixture 实例 + rebuild-index 测试(分组/排序/行格式/排除 candidate 与 archive)。
- log.md:受控词表在 SKILL.md ch5;fixture log.md 9 行实例。
- 裁决三件套:decisions.jsonl / source-tombstones.json / conflict-dismissals.json 的格式在 SKILL.md ch5 给出 JSON 示例,fixture 三件均为合法实例;record-decision 机械强制 human `reason` / agent `cited`(govern.test 机检)。

### 行 5 — 连接器章覆盖 ✓

- 四选择器 + 嗅探优先级:`acquire.test.mjs` "selector sniffing: url > issue key > query > error"、"explicit --selector-type wins"、"jql/cql 错配 exit 64"、"unsniffable → 64 列出四形态"。
- detect 增量:"JQL classifies new/changed/unchanged; --detect-only pulls and writes nothing"、"second identical run → unchanged, no full pull"(jira/confluence/openwiki 各有)。
- removed_upstream 两击:"two-strike — first missing keeps raw + warning + state; second deletes + logs"(jira+confluence 各一)、"reappearing clears first-strike state"、"CQL results missing a local raw → same two-strike";openwiki 直接删除路径("upstream deletion removes raw, counts removed_upstream, logs")。
- 附件下载:"attachment downloaded to raw/assets/jira/<KEY>/ and body reference rewritten"、"CQL … downloads attachments, rewrites ac:image"、"bad attachment filenames and failing downloads degrade to warnings; page raw still written"。
- 转换降级占位符:"unknown macro degrades to [macro: name] placeholder (never dropped)"、"unknown node type falls back to concatenated child text"。
- §3.1 归一化/扁平化/删除:"flatten / → --, strip .md, collision gets hash suffix, skip-list applied"、"source_url = <remote>#<repo-relpath>" / "file:// fallback"、"source_version = last commit / mtime fallback"、"--subdir pulls only that subtree; deletion scoped" 系列 4 条、"OKF frontmatter preserved verbatim"、"content_hash byte-consistent with validate"。

### 行 6 — 裁决 HTML + 站点(§6)✓

- 原型形态基线:`templates/adjudication-report.html` 收编原型的设计令牌与结构(顶栏统计 / 左侧候选队列 + 冲突 chip / 主区卡片层级 / 底部五动作 + 理由框);render.test "reply contract strings present in template JS"、"conflict parties present in data island"、"candidate whose page is in last-plan conflict-pair gets a conflict block"。
- 图谱防星形退化:render.mjs:546 注释 + 实现(index.md 永不成为图节点),e2e:92-93 字节级断言每条边 `a/b !== 'index'`;render.test "no index.md participant, dedup"。500 节点降级:"graphMode adjacency when >500 pages" / "force at ≤500"。
- HTML 安全硬要求逐条:
  1. 实体转义:render.mjs:271-274 `escapeHtml` 五实体;render.test "all dynamic content entity-escaped"、"escapeHtml: all five entities"。
  2. href 白名单 http/https/file:render.mjs:220 `LINK_SCHEME_RE`,非白名单 scheme 保留为转义纯文本(:330);render.test "link scheme whitelist … others plain text"。
  3. Markdown 不允许内联原始 HTML:escape-first 渲染管线(render.mjs:317-336,先转义再插自有标签);render.test "escape-first — raw HTML never passes through"。
  4. 构建期内嵌数据:render.mjs:275-277 `jsonIsland`(`<` → `<`,防闭合 script);e2e:81 + render.test "no forbidden strings"(无 fetch/XHR)。
  5. 无 localStorage 等持久化:e2e:81 正则断言 report 无 localStorage/sessionStorage;render.test site "no forbidden strings"。

### 行 7 — fixtures + e2e ✓

见 Part 1,全部核查点通过,e2e 由本人实跑复现(2/2)。

### 行 8 — fail-closed 显式清单 ✓

SKILL.md ch10 表 12 行,逐行核对为真实行为(抽查对照代码/测试):

| 清单行 | 实证 |
|---|---|
| validate govern 检查失败 exit 1 | validate.test 全套;"refusion-retention e2e: … exits 1" |
| 重融保持性护栏 | validate.mjs:361-382(wikilink/sources 保留 + >20% 关键事实行消失);三条专项测试 |
| semantic-check 无证据 = 未检查 = 强制 candidate | SKILL.md ch4 步 7;prompts/semantic-check.md 输出契约 |
| frontmatter 不可解析 | govern.test "plan errors: unparseable frontmatter…";validate.test 同名检查 |
| 拉取中 401/403 中止 | acquire.mjs ConnectorAbort(:321,:349);"401 mid-run aborts … sentinel PAT nowhere in output" ×2 |
| 两击 removed_upstream | acquire.test 两击系列 ×3 |
| 降级禁 auto-approve | SKILL.md ch4 pre-flight(显式 fail-closed 补偿) |
| 先例矛盾 → candidate | prompts/govern-decide.md:18(强制规则) |
| 蒸馏校验失败不写任何文件 | SKILL.md ch6 步 3;validate distill 系列测试 |
| 转录 >30000 字符 | distill-chat.md(prompt 契约锚点 contract.test 机检) |
| 墓碑/registry 不可读 → 拒绝运行 | acquire.test "corrupt source-tombstones.json → fail-closed exit 1";govern.test "corrupt tombstone file fails closed" |

### 行 9 — 口令表与 description ✓

- SKILL.md ch9 口令表与 §8.1 七行逐条一致(本人逐行比对文本相同,含"有候选时一份裁决 HTML""下次治理后可检索"等预期列)。
- description 与 §9 草案逐字一致:contract.test.mjs:71-81 机检(frontmatter 恰为 name+description,description 字符串等值断言);§9 要求的中英触发词与否定边界均在。

---

## 跨切项(plan errata / self-review 声明)复核

| 声明 | 结果 | 证据 |
|---|---|---|
| 共享段五脚本逐字节一致(含机检) | ✓ | contract.test.mjs:103-116 从 SEG_BEGIN/SEG_END 标记切片并跨五文件断言相等;五脚本均含标记 |
| 脚本永不输出 PAT | ✓ | acquire.mjs:598-599/756-757 错误只命名环境变量;测试以 `SECRET-SENTINEL` 哨兵 PAT 断言不出现在 stdout(:822 等) |
| acquire/govern git 暂存 scoped | ✓ | acquire.mjs:568 `git add -A -- raw log.md`;govern.mjs:660 `git add -A -- wiki log.md`;两脚本各有"nested in a larger repo stages only …"测试 |
| checkKb 自愈 `.kb/` 派生物 | ✓ | validate.mjs:46-47(共享段)mkdir -p 三个派生目录;contract.test "self-heals … fresh clone" + 对照 "missing wiki/sources → exit 65"(用户内容仍严格) |
| validate 重融保持 + slug-dup 检查 | ✓ | validate.mjs:279/337(slug-dup 跨目录冲突)、:361-382(refusion-retention);validate.test 各 3+ 条专项,含边界(恰好 20% 通过、base null 跳过、sidecar 自同名不算冲突) |

---

## 发现的缺口

无 ✗ 行。两条非阻塞观察记于 Part 1(openwiki raw 无对应 wiki 页属剧本设计;fixture 墓碑/dismissal 引用的历史 decision id 不在文件内,spec 未要求)。

## 最终判定

**PASS** — §10 九行全部 ✓,跨切实现声明全部属实,210/210 测试由本人实跑复现全绿。
