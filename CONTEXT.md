# CONTEXT — LLM Wiki Skill 术语表

本文件只收术语(ubiquitous language),不收实现决策。决策见 `.scratch/llm-wiki-skill/` 地图与各票。

## 核心概念

- **KB(知识库)** — 独立全局的知识库目录(可独立 git 仓库),skill 的全部读写对象。与任何代码仓库解耦。
- **raw 文档** — 从外部来源(Jira/Confluence/对话蒸馏/OpenWiki 仓库 wiki)归一化后的 Markdown,1:1 对应一篇源文档,带 frontmatter(来源类型、原始 ID、URL、拉取时间、内容 hash)。存放于 KB 的 `raw/`。
- **openwiki 来源** — OpenWiki 在代码仓库生成的 wiki 页(`<repo>/openwiki/`,OKF v0.1)接入 raw 层的来源类型(`raw/openwiki/`)。本地文件系统连接器,无认证;页面相对路径扁平化为 source_id(`/` → `--`);detect 显式处理上游删除。定位为证据 ingest(接受"对摘要再摘要"的损耗,换统一检索入口与跨源 synthesis);镜像/联邦等替代接入方案曾评估,v1 维持 raw ingest,待实际效果验证后再优化。
- **蒸馏文档** — 对话蒸馏成的 raw 文档(`raw/chat/conv-<hash12>.md`)。正文每要点带引用标记:`[T-n]` 指同文件附录 A 的对话转录,`[R-n]` 指附录 B 的引用资料(出处+相关节录)。validate 对两类引用 fail-closed 校验;手动触发;落 raw 即完成、等下一治理 run 消化。
- **wiki 页面** — 经治理消化后的策展页面,存放于 KB 的 `wiki/`,主语言默认英文(kb.json 可配)。页型四种:**source**(单源摘要页,与 raw 1:1)、**synthesis**(跨源主题叙事,每条 claim 有 sources 背书)、**concept**(跨文档共享抽象的权威定义页,如"订单状态机")、**entity**(命名实体 + 类型化关系,如团队/系统)。
- **治理(governance)** — 把 raw 文档消化进 wiki 的过程。
- **治理运行(govern run)** — 一次完整的治理流程(一 "run"),骨架:sweep → plan → 逐文档处理 → synthesis 聚类与折叠 → rebuild index → 汇报裁决。一 run 只处理当时 raw/ 里新增/变更的文档。
- **簇(cluster)** — synthesis 聚类时,共享同一 topic 的 source 页分组;一簇产出一篇 synthesis 页。≥2 篇不同 raw 共享 topic(或同名 synthesis 已存在)才成簇,每 run ≤10 簇(kb.json 可调);topic 经 `.kb/govern/topic-registry.json` 规范化(slug 化后相等才算同 topic)。**簇不设大小上限,覆盖总是全量**(见"折叠";v1.0 的截断规则已退役)。
- **折叠(fold / folding)** — 非 source 页(synthesis/concept/entity)的增量构建方式,严格串行:一次一页、一次一折、每折默认折入 1 源(`max_sources_per_cluster` 语义 = 每折批大小)。每折:先读当前页(merge base,缺读即违约)→ 按 source_version 升序读下一源 → union-merge → 双闸门(validate 含重融护栏 + semantic-check 结构化证据)通过才落盘。折满足 sources 只并 + 护栏过 + no_conflict 视同纯追加可 auto-approve;矛盾/护栏破损/无证据则**断链**:最后好页保持,问题折落 candidate 点名相撞源对,剩余源下轮续折。续跑靠结构(页 sources 即游标),无游标文件。
- **union-merge 更新** — 非 source 页(concept/entity/synthesis)身份 = slug;新文档涉及时先查存,存在则更新:sources 取并集、created_at 保留、正文重新融合;矛盾则强制 candidate。查不到才新建。
- **候选状态机(candidate state machine)** — wiki 页面生命周期。**候选 = sidecar 版本提案**:`wiki/<type>/<slug>.candidate.md` 与目标页同目录,approved 页文件永不被覆盖(消除"候选覆盖 approved 导致检索真空");approve = sidecar 原子替换目标页(新建=改名落位),reject = sidecar 移 archive/(status rejected,下轮 sweep 翻 archived),`approved → archived`(人裁决)。低风险操作可自动 approved;矛盾、重复、合并、归档已批准页必须 candidate。
- **裁决记忆** — KB 的 `.kb/govern/` 目录,三件:`source-tombstones.json`(败方墓碑)、`conflict-dismissals.json`(平行文档对)、`decisions.jsonl`(裁决历史,human 必填理由)。对抗宿主 agent 跨会话无记忆;同时是治理判断的 few-shot 先例源。另有 `slug-registry.json`/`topic-registry.json` 两个机械查存注册表与 `runs.jsonl` run 元数据。
- **reject-and-restore(已退役)** — sidecar 模型前的旧设计(拒绝覆盖候选时从 git 历史恢复 approved 版);sidecar 下 approved 原页从未被触碰,reject 即归档 sidecar,无需恢复。
- **wiki/index.md** — wiki 的入口目录文件,agentic search 的起点;每次治理运行末尾重建。
- **wikilink** — 页面间的显式链接,织成页面图;检索时沿它扩展(各扩一跳)。

## 执行架构

- **宿主(host)** — 运行 skill 的 agent 环境:Claude Code 或 GitHub Copilot。宿主 agent 本身就是全部判断性工作的 LLM。
- **渐进增强脚本** — skill 携带的四个 Node 零依赖单文件脚本(`acquire` / `validate` / `govern` / `render`),宿主能跑就跑;SKILL.md 提示词是唯一规范路径。
- **手动降级路径** — 每个脚本在 SKILL.md 中附带的"无脚本"步骤说明,写到 agent 可照做的粒度。
- **fail-closed** — 检查跑不了 = 检查不通过 → 强制进候选交人审。宁可误伤,不可放过。
- **agentic search(迭代检索)** — 纯由宿主 agent 执行的检索协议:index.md 先行 → 多路召回(Grep/Glob/Read,禁 HyDE 只许 CSQE)→ 图扩展(wikilink+sources 各扩一跳)→ 按 heading 分节读、≤3 轮迭代 → 逐条 [[wikilink]] 引用作答,零命中明示。单档自适应;**「深研」口令** = 用户强制拉满多轮迭代。答案末尾附检索说明(查了哪些路、读了哪几页)。
- **CSQE** — 从已命中页的内容提取新关键词再查的改写方式;唯一允许的查询改写。对立面是 **HyDE**(编造假想文档当查询),禁用。

## 交付与分发

- **skill 目录** — 单一交付物,真实位置 `.claude/skills/<name>/`(Claude Code 原生、Copilot 自动检测),用 symlink/安装器投影到 `.agents/skills/` 供中性宿主。
- **spec** — 本地图的终点:双语(中英)设计规范,详细到实现者无需追问。

## 文档同步约定

- **docs/ 教学目录** — `D:\claude\kb-skill\docs\` 是给人读的教学文档(使用者之旅 + 开发者之旅),对应 skill v1.1。**修改 spec、SKILL.md 或在 CHANGELOG 新增版本时,必须检查 docs/ 是否受影响并同步更新**;docs/ 不是契约权威,契约细节以 spec/SKILL.md 为准。
