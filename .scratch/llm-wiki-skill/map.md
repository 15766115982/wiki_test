# Map: LLM Wiki Skill(Weft 的 skill 化)

## Destination

一份**可交付的双语(中英)spec**:描述一个复制到 `.claude/skills/`、`.copilot/` 等目录即可使用的 LLM Wiki skill,覆盖五大能力(Jira/Confluence 拉取、raw→wiki 治理、agentic search 检索、对话蒸馏、本地可视化)。spec 详细到实现者无需再问问题即可构建。skill 本体不在本轮建设范围内。

## Notes

- 领域:知识管理 / LLM Wiki / agentic search / skill 工程。术语表见 `CONTEXT.md`(随决策建立)。
- 参考实现:**Weft**(`D:\claude\knowledge-extension`)——五服务解耦的知识库系统,spec 大量借鉴其契约与机制。
- 每个 session 应咨询的技能:`domain-modeling`(术语与 ADR)、`research`(research 票)、`prototype`(prototype 票)。
- **charting 阶段已定的输入约束**(用户拍板,非 ticket 产物):
  - KB 位置:**独立全局 KB**(可独立 git 仓库,服务多项目)。
  - 拉取通道:**自带连接器**(PAT 环境变量直连,不依赖宿主 MCP)。
  - 检索形态:**纯 agentic 迭代检索**(宿主 agent 读 index→选页→沿 wikilink 扩展,不建搜索引擎)。
  - 本地 UI:**静态 HTML 站点**(治理裁决报告 + wiki 可视化,无常驻进程)。
  - 对话蒸馏:当前对话当场蒸馏,且对话中引用到的文档知识一并纳入。
  - spec 语言:**双语**(中英关键章节)。
  - 治理需人类裁决处:**生成 HTML 可视化**,便于阅读裁决。
  - **自动化为主,非必要不裁决**:低风险自动生效,裁决批量进 HTML 一次处理;先例学习(decisions.jsonl few-shot)让打扰随使用递减。
  - 整体形态:单一 skill 目录,复制即用(目标路径含 `.claude/skills/`、`.copilot/`、`.agent/`——确切路径待调研)。
- 工作目录非 git 仓库:research 产物落盘 `.scratch/llm-wiki-skill/research/`,票内链接,不用分支。

## Decisions so far

<!-- 一行一条:够判断相关性即可,细节点链接进票 -->

- [Weft 可复用机制调研](issues/02-weft-reuse-research.md) — 契约层全搬;页型裁为 source+synthesis;fail-closed 守卫留脚本;裁决记忆 .kb/govern/ 必迁;govern run 改为编号 runbook;搜索引擎全弃、保留 agentic 协议要素;chat 蒸馏近乎原样搬。
- [宿主能力调研:Claude Code / Copilot / .agent 的 skill 机制](issues/01-host-capabilities-research.md) — Copilot 已官方采纳 SKILL.md 并自动读 `.claude/skills`;单一真实位置放 `.claude/skills/<name>/` 再投影到 `.agents/skills/`;frontmatter 公共子集只有 name+description;**脚本跨宿主不可假设,必须配手动降级路径**。
- [运行时架构:纯提示词 vs 提示词+脚本](issues/03-runtime-architecture.md) — 提示词为主+渐进增强脚本;四脚本(acquire/validate/govern/render)全带手动降级;Node 零依赖单文件 .mjs,最低 20 主攻 24;stdout JSON;`node --version` 探测决定整轮走脚本还是手动。
- [KB 目录契约:沿用 Weft 还是轻量重设计](issues/04-kb-contract.md) — 采用裁剪版 Weft 契约;四页型全保留(source/synthesis/concept/entity);issue_type 走 frontmatter 不进路径;.kb/govern/ 裁决记忆三件(tombstones/dismissals/decisions.jsonl);wiki 主语言默认英文可配;KB 必须是 git 仓库;身份五元组+content_hash、状态机、风险分级、reject-and-restore 原样继承。
- [治理工作流细化:runbook、prompt 模板与裁决呈现](issues/11-governance-workflow.md) — 七步 runbook 定稿;synthesis 阈值沿用 Weft 默认入 kb.json;非 source 页先查存再 union-merge;裁决=每 run 一份 HTML+对话回决定(可批量);自动化为主、fail-closed 兜底;子代理支持时并行;九 prompt 清单与 decisions.jsonl 格式确认。
- [Agentic search 检索协议设计](issues/05-agentic-search-protocol.md) — 六条协议:index 先行→多路召回(禁 HyDE 只许 CSQE)→图扩展各一跳→分节读≤3 轮→逐条 [[wikilink]] 引用+零命中明示;单档自适应+"深研"口令;答案末尾附检索说明。
- [Jira/Confluence 自带连接器设计](issues/09-connector-design.md) — 只支持 Server/DC PAT;范围调用时指定(URL/issue key/JQL/CQL 四选择器);附件下载 raw/assets/(确定性路径+hash 去重);Jira 评论 ≤10 条、Confluence 不拉;detect 先行增量、XHTML/ADF 最小转换照搬 Weft。
- [对话蒸馏 raw 文档格式](issues/08-chat-distillation-format.md) — 沿用 ADR-0013:[T-n] 引用+转录附录+fail-closed 校验+conv-hash8 幂等;引用文档走 [R-n] 双附录(出处+节录);手动触发可建议;超 3 万字符报错分次蒸馏;附录由 agent 转录的保真降级已声明。
- [治理裁决 HTML 报告原型](issues/06-adjudication-html-prototype.md) — 原型见 prototypes/adjudication-report.html,用户已确认形态:review_note 最先、diff、冲突组显式选败方无默认、溯源折叠、历史决策、五动作+生成回复文本粘贴回对话。
- [Wiki 静态可视化站点设计](issues/07-static-site-design.md) — 站点与裁决报告**分开两个产物**;站点四视图=浏览/图谱/历史记录/概览(裁决视图去除);生成到 .kb/site/ 双击即开;图谱零依赖 SVG+力学布局、index.md 万能链接不进图;手动触发为主+run 末提醒。
- [汇总决策,撰写双语 spec](issues/10-spec-assembly.md) — **终点达成**。init=agent 引导式;v1 单 KB;semver+增量兼容;checklist 验收。交付:spec/spec.zh-CN.md(主)+ spec/spec.en.md(镜像),十章,全部决议汇总。
- [OpenWiki 仓库 wiki 作为 raw 来源](issues/12-openwiki-connector.md) — 当 raw ingest(否决联邦检索);本地文件系统连接器无认证;路径 `/`→`--` 扁平化兼容白名单;detect 显式处理删除;支持子集拉取;spec §2.2/§3 小改。
- [skill 本体实现 v1.0.0](issues/13-implementation.md) — **已交付**。`llm-wiki/` 五脚本+SKILL.md+九 prompt+模板+fixtures,211 测试全绿,§10 验收 PASS(acceptance-report.md)。实现期决策增量(pending 基线/last-plan.json/record-decision/冲突协议/两击扩展 Confluence/checkKb 自愈/git quotepath+scoped staging/refusion-retention+slug-dup 机检/词表统一)见票。

## Not yet specified

(雾区已全部毕业:治理编排 → 票 11;图谱渲染选型 → 票 07 已决;init 流程/多 KB/分发升级/spec 验收 → 并入票 10 撰写前的收尾决策。剩余:Zephyr Scale 测试步骤拉取 —— 连接器二期,v1 跑通后再议。)

## Out of scope

- **构建 skill 本体**:本轮终点是 spec;实现是后续工程。
- **改动 Weft(knowledge-extension)本体**:它是只读参考。
- **hosted/web 平台、常驻服务、用户系统**:与 skill 形态相悖,明确排除。
