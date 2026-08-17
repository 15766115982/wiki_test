# 13 — skill 本体实现(v1.0.0)

**状态:已完成(2026-08-13)。** spec 的终点是设计,本票记录实现工程的落点与决策增量。

## 交付物

`llm-wiki/`(仓库根):SKILL.md(501 行,十一章)+ prompts/ ×9 + scripts/ ×5(acquire/validate/govern/render/install,零依赖单文件 .mjs,共享段五脚本逐字节一致,contract.test 机检)+ templates/ ×7(5 页面模板 + 2 HTML 模板,裁决报告原型收编)+ fixtures/(示例 KB + 假 OpenWiki 上游仓)+ CHANGELOG.md。测试在仓库根 `tests/`(非交付物),**211/211 绿**(`node --test`,Node 24.19)。

实现计划与执行勘误:`.scratch/llm-wiki-skill/implementation-plan.md`。验收报告(§10 逐行证据):`.scratch/llm-wiki-skill/acceptance-report.md` — 结论 PASS。

## 实现期决策增量(spec 未明言处,实现时已锁定)

- **pending 基线**:govern plan 的 new/stale 以最后一个 `govern: run` commit 为基线(git diff + porcelain);无基线 → 有页 stale/无页 new(保守)。
- **last-plan.json**:`govern plan` 写 `.kb/govern/last-plan.json`(六清单 + ts),render report 与 agent 步 3 消费;缺失时 render 退化为 glob sidecar。
- **record-decision 子命令**:§2.6「脚本强制 human reason」的运行时落点;id `d-<yyyymmdd>-<seq3>` 按日递增;同步写 log.md(human→`review`,agent→`govern | auto:<action>`)。
- **human_lists 扩展 kind `missing-raw`**:source_ref 指向已删 raw 的 source 页(removed_upstream 后续)进人类清单。spec §1.4 枚举为开放列表。
- **冲突候选协议**:review_note 首行 `conflict: <kind> | parties: <a> vs <b>` → render 机械解析为冲突组区块(显式选败方无默认);回复文本扩展 `| loser: <id>` **置于 reason 之前**(自由文本 reason 永远最后,防管道符污染)。
- **acquire 状态文件** `.kb/acquire-state.json`:两击 removed_upstream 的 firstMissingAt 记忆;损坏 → 警告 + 重置(保守方向)。
- **两击规则扩展到 Confluence**(spec 字面只给 Jira):同样的删除/权限不可区分性 + CQL 子集语义,Confluence 复用同一机制。
- **checkKb 自愈 `.kb/`**:`.kb/` 被 gitignore,fresh clone 合法缺 `.kb/govern`;kb.json+内容树合法时自动补建派生目录,raw//wiki/ 缺失仍 exit 65。
- **git 纪律实现细节**:全部 git 调用带 `-c core.quotepath=false`(CJK 文件名);staging 限各脚本自有路径(acquire `-- raw log.md`,govern `-- wiki log.md`),防 KB 嵌套大仓误提交。
- **validate 新增机检**:`refusion-retention`(§2.3 重融护栏:候选 sidecar vs base 的 wikilink/sources 保留 + 关键事实行消失 >20% → failure)与 `slug-dup`(跨页型 slug 全局唯一)。
- **isMain 判定**:`fileURLToPath(import.meta.url) === resolve(process.argv[1])`(URL 拼接形式遇 `#`/`?`/`%` 静默失灵)。
- **contract_version 单向门槛**(spec §2.7 逐字):skill > KB → exit 65;KB 比 skill 新 = §9 增量兼容设计情形,放行。
- **词表统一**:log.md 词表的 `edit-approve` 与 §2.6/§4.2 的 `edit-then-approve` 漂移 → 统一为 `edit-then-approve`(spec 双语 §2.5 已同步修订)。

## 降级豁免点(脚本路径 vs 手动路径的显式差异)

手动降级路径:e2e 头部注释列三点 —— content_hash 写 `"manual"`(hash 类检查跳过)、禁用自动 approved(一切落 sidecar)、render 图谱视图跳过。

## 后续(出范围)

- Zephyr Scale 测试步骤拉取(连接器二期)。
- Jira/Confluence Cloud 支持。
- 实际部署:`node llm-wiki/scripts/install.mjs`(投影到 `~/.agents/skills/`)。
