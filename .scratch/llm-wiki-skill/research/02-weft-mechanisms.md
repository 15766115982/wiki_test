# Weft 机制盘点 — 可迁移到 portable skill 形态的资产清单

> 调研对象:`D:\claude\knowledge-extension`(Weft,自治理知识库系统)。
> 目标场景:把 Weft 重表达为一个 portable **skill**(目录 = SKILL.md + prompts + 可选 scripts),
> 由宿主 LLM agent(Claude Code / Copilot 等)直接执行 —— 无常驻服务、无独立 Python agent 服务。
> 每条机制:名称 → Weft 中的位置 → 一段摘要 → 迁移建议(ADOPT 原样 / TRIM 裁剪 / REDESIGN 重做)。
>
> 关键背景:Weft 在 ADR-0012 中刚刚把"Claude Code skill 形态"退役、迁往 Python LangGraph
> agent 服务(`docs/adr/0012-declaude-llm-layer-to-langgraph-agent-service.md`),原因是部署内网
> 没有 claude CLI。因此本调研本质上是一次"反向迁移":把它搬走之前的 skill 形态拿回来,并借
> ADR-0012 的教训(graph-constrained 骨架、CLI 写盘咽喉)把 skill 形态做得更好。

---

## 1. Contract 层(schema/contract.md、schema/governance.md、CONTEXT.md)

### 1.1 纯文件系统契约 + 编排上移给 LLM
- **位置**:`docs/adr/0001-filesystem-contract-llm-orchestration.md`;`CONTEXT.md` "Inter-layer contract: pure filesystem";`schema/contract.md` 开头。
- **摘要**:各服务之间零代码依赖、零进程间调用,唯一契约是目录结构 + frontmatter 规范;运行顺序和流程编排由 LLM 会话承担,不存在于任何一层代码里。索引等派生物随时可从 Markdown 重建。
- **建议**:**ADOPT**。这正是 skill 形态的天然架构 —— skill 里的 SKILL.md 就是"编排逻辑",宿主 agent 就是编排者。契约文档本身应压缩成 skill 内的 `schema.md` 或 SKILL.md 的一节,不必保留"四方合同"的体量(四方在 skill 里坍缩成"宿主 agent + 少量脚本")。

### 1.2 两区数据模型(raw/ + wiki/)+ 规则层
- **位置**:`docs/adr/0002-two-zones-candidate-state-machine.md`;`schema/contract.md` §1;`CONTEXT.md` "KB structure"。
- **摘要**:KB 只有两个持久数据区:`raw/`(采集层独占写,规范化 Markdown,原始格式丢弃)和 `wiki/`(治理层独占写,检索唯一索引目标)。所谓"第三层"是 schema 规则层而不是数据层。KB 目录本身是独立 Git 仓库,历史由 Git 承载,不做目录内快照。
- **建议**:**ADOPT**。两区模型是整套系统的骨架,skill 化后照样成立(raw/ 暂存证据、wiki/ 是生效知识)。`.kb/` 派生物目录大幅 TRIM:只保留 `.kb/govern/`(裁决记忆),`index.sqlite`、`candidates/`、`acquire_runs.jsonl`、`govern_runs.jsonl`、`ui/` 全部砍掉(没有搜索引擎和门户就不需要它们;运行记录可以直接写进 log.md)。

### 1.3 写权限矩阵(单目录单写者)
- **位置**:`schema/contract.md` §1 "Write Permission Matrix"。
- **摘要**:每个目录恰好一个写者(acquisition 写 raw/、governance 写 wiki/、retrieval 写索引、viewer 只能翻 status……),任何层不得写其他层的独占路径;portal 的写被限制在显式白名单并走串行写队列。
- **建议**:**TRIM(大幅)**。矩阵是多进程多服务世界的产物。skill 场景里宿主 agent 是唯一执行者,"单写者"退化为一条纪律:**所有写操作都走 skill 定义的少数几个动作**(写 raw、apply 页面、flip status、archive),写进 SKILL.md 的红线即可。串行写队列、per-startup token、Origin/Host 检查等门户防护全部删除。

### 1.4 身份五元组 + content_hash 增量
- **位置**:`schema/contract.md` §2;`CONTEXT.md` "Document identity and versioning";`acquisition/scripts/lib/rawdoc.mjs`(upsertRawDoc)。
- **摘要**:raw 文档 frontmatter 必带 `source / source_id / source_url / source_version / pulled_at + content_hash`;增量规则是"拉前先读目标文件,content_hash 相同即跳过";对版本在内容之外的源(如 Jira),连接器把全精度版本嵌进被 hash 的正文,使"纯 hash 比较 ≡ 版本+hash 比较",无日期粒度盲区。
- **建议**:**ADOPT**,五元组是跨源去重和 staleness 检测的根基,成本极低。`pulled_at`、`connector` 版本号可保留但非关键。"版本嵌入 hash 正文"这一技巧值得写进 skill 的采集规范。

### 1.5 确定性文件名 + 字符白名单(防路径注入)
- **位置**:`schema/contract.md` §2 "Character constraints"、§3.1 slug 规则;`governance/scripts/lib/govern.mjs` 的 `SAFE_ID`/`SAFE_SLUG`(`govern.mjs:163-164`)。
- **摘要**:`source`/`source_id` 只允许 `/^[A-Za-z0-9][A-Za-z0-9_-]*$/`,slug 只允许小写 kebab-case `/^[a-z0-9][a-z0-9-]*$/` —— 因为它们会被拼进 wiki 页面路径,不合规的外部 ID 必须转义、hash 映射或 fail-closed 拒绝。文件名由 `source + source_id` 确定生成,重拉即覆盖,Git 承载历史。
- **建议**:**ADOPT**。对 skill 同样关键:LLM 会生成文件名,必须有机械白名单兜底。skill 里放一个小校验脚本或用 SKILL.md 规则 + 宿主 agent 自检均可,但 regex 本身直接抄。

### 1.6 wiki 页面 frontmatter + candidate 状态机
- **位置**:`schema/contract.md` §3.1、§4;`docs/adr/0002`、`docs/adr/0005`。
- **摘要**:所有 wiki 页面带 `type / status / title / created_at / updated_at`;status 状态机为 `candidate → approved | rejected →(sweep)→ archived`,candidate 是 frontmatter 上的**状态**而不是单独目录;检索只索引 `approved`,"只有当前生效版本可检索"由结构保证。低风险操作(新建、追加不矛盾信息)直接 approved;高风险(矛盾、合并、归档 approved 页)强制 candidate。
- **建议**:**ADOPT**。这是整个人机协同的核心,且对 skill 零成本 —— 就是一个枚举字段加几条规则。`rejected` 瞬态可以简化(见 §2.5 sweep),但四态枚举保留。

### 1.7 四种页面类型(source / entity / concept / synthesis)
- **位置**:`schema/contract.md` §3.2–3.5;`docs/adr/0009-llm-service-decision-log-governance-and-four-page-types.md`;`CONTEXT.md` "wiki/ internal structure"。
- **摘要**:v2 把页面类型从 `source | topic` 扩为四类 —— source(与 raw 1:1 的摘要页)、entity(命名实体,可带 `kind` 和 typed `relations`)、concept(共享抽象)、synthesis(跨源叙事,允许得出单一来源没有的结论但每条 claim 须有 sources 背书)。非 source 页共享 slug 身份、`sources:` 溯源、union-merge 更新语义。
- **建议**:**TRIM**。skill 场景建议先只保留 **source + synthesis( topic)两类**:ADR-0009 自己记录了 v1 就是 `source | topic` 两类,四类是为"FAA 是哪个团队开发的"这类结构化问答升级的,代价是 classify-page / extract-entity / draft-concept 三个额外 prompt(`templates/prompts/`)和实体关系维护负担。entity/concept 可作为 SKILL.md 里的可选扩展段落,用户 KB 上量后再启用。union-merge 语义(`sources` 并集、created_at 保留、aliases/tags 省略即保留)无论几类都必须 ADOPT。

### 1.8 wiki/index.md —— 检索入口契约(Tier 0)
- **位置**:`schema/contract.md` §3.6;`governance/scripts/lib/govern.mjs` `rebuildIndex()`(机械重建,`govern.mjs:672-710`)。
- **摘要**:每次治理运行后必须重建;按类型分组,每页一行 = `[[wikilink]] — 一句话摘要(关键元数据)`;被检索服务和 Claude 直接阅读导航,是 index-first 检索的 Tier 0。
- **建议**:**ADOPT,且权重比在 Weft 里更高**。没有搜索引擎的 skill 场景里,index.md 就是 agent 的主导航结构。重建逻辑极其简单(扫 frontmatter 拼文本),既可以是 10 行脚本,也可以直接让宿主 agent 按格式重写 —— 建议配一个小脚本保证格式稳定。

### 1.9 wikilink 互联 + [[slug|display]] 形式
- **位置**:`schema/contract.md` §3.1;`schema/governance.md` §2;`governance/scripts/lib/govern.mjs` `mergePages` 的 backlink 重写。
- **摘要**:正文互联用 `[[wikilink]]`,管道别名形式 `[[slug|display name]]` 保证 Obsidian 兼容和改名稳定;merge 时机械重写全库 backlink(保留 display 与 anchor),不留悬空链接,archive/ 是冻结记录不重写。
- **建议**:**ADOPT**。纯文本约定,零成本;合并时的 backlink 重写在 skill 里由宿主 agent 用 Grep+Edit 完成即可,但"merge 必须重写 backlink、archive 不重写"这条纪律要写进 SKILL.md。

### 1.10 log.md 治理日志(append-only,grep 友好)
- **位置**:`schema/contract.md` §5。
- **摘要**:统一前缀 `## [<ISO8601>] <actor> | <action> | <object path> | <note>`,actor ∈ govern/review/acquire/portal/agent,action 词表受控;是人类可读的审计脊柱,也是 sweep 对账和"unlogged flip 守卫"的数据源。
- **建议**:**ADOPT**。单行 append 的日志格式是 skill 里最便宜的审计机制,宿主 agent 写一行即可。portal actor 删除。注意:sweep 对账依赖它,若 skill 简化掉 sweep(见 §2.5),log.md 仍作为纯审计保留。

### 1.11 kb.json + secrets 仅走环境变量
- **位置**:`schema/contract.md` §6;`CONTEXT.md` "Configuration resolution"。
- **摘要**:非敏感配置(连接器范围 JQL/CQL/inbox 路径、embedding 端点)入 kb.json(check-in);kb.json 最多存环境变量名(`*_env`),secrets 绝不入库(KB 是 Git 仓库)。
- **建议**:**ADOPT**(裁剪后)。skill 场景连接器配置需求大减,但"配置入 kb.json、密钥只存 env 变量名"这一纪律直接照搬。

### 1.12 语言约定(KB 主语言统一,raw 保留源语言)
- **位置**:`schema/governance.md` §1。
- **摘要**:raw/ 保留源语言(证据层,as-is 即公正);wiki/ 内一切产物用 KB 主语言;专有名词/系统名/错误码保留原形(检索锚点);混语言会撕裂召回(同一概念两种语言的页面互相检索不到)。
- **建议**:**ADOPT**。对 skill 是纯 prompt 规则,写进 distill/summarize 的 prompt 模板即可。注意 Weft 选定英文是因其语料 99% 英文,skill 应把"主语言"做成 kb.json 的一项配置。

---

## 2. Governance(governance/scripts/、agent/weft_agent/govern_graph.py、templates/prompts/)

### 2.1 治理风险分级:"增量可逆自动生效,破坏性/需裁决进 candidate"
- **位置**:`CONTEXT.md` "Governance risk tiers and triggering";`schema/governance.md` §2;`schema/contract.md` §4。
- **摘要**:自动生效 = 创建/更新 source 页(1:1 机械映射)、更新 index.md、新建 entity/concept/synthesis 页、向现有页追加**不矛盾**信息;必须 candidate = 与现有页矛盾、疑似跨源重复、合并已 approved 页、归档/删除已 approved 页、多版本取舍。划线原则:incremental+reversible 自动,destructive+需业务裁决的进队列。
- **建议**:**ADOPT**。这是 skill 提示词的核心规则段,直接改写为 SKILL.md 的"governance rules"一节。

### 2.2 plan():六清单工作扫描
- **位置**:`governance/scripts/lib/govern.mjs` `plan()`(`govern.mjs:206-355`)。
- **摘要**:一次扫描产出 pending(new/stale)、anomalies(hash 变版本不变 = 高危信号)、errors(缺契约字段)、review_queue(全部 candidate)、orphaned_pages(source_ref 指向已消失 raw)、dangling_links、conflicts、suppressed(墓碑)。人拥有的清单(orphans、conflicts、dangling 等)只报告,永不自动裁决。
- **建议**:**ADOPT(轻量脚本化)**。plan 是纯确定性的 diff 扫描,正是 skill 里"值得保留的少数脚本"的典型 —— 让 LLM 每次重新扫描全库既慢又不可靠。建议迁移为一个 `plan.mjs`(或宿主 agent 的一轮 Glob+读 frontmatter,KB 小时可行)。清单分类和"人类清单只报告"原则照搬。

### 2.3 冲突检测三范畴(ADR-0008)
- **位置**:`docs/adr/0008-governance-conflict-detection-and-loser-archive.md`;`governance/scripts/lib/similarity.mjs`;`govern.mjs` 中 forced-candidate 逻辑(`govern.mjs:564-606`)。
- **摘要**:三类跨文档冲突在全 KB 范围检测 —— ① exact duplicate(content_hash 相同,仅当双边都带 hash;零误报,自动去重不落盘);② similar version(标题/文件名预过滤 + CJK 感知的正文 Jaccard 相似度确认,阈值 0.5 由 fixture 标定;桶上限 400 防 O(n²) 退化)→ apply 时 fail-closed 强制 candidate;③ factual conflict(语义层,无法机械检测)→ 由 `semantic_check_required` 输出契约提示治理 LLM 必做自查,冲突点写入 review_note。设计要点:正确性必须是结构的而不是 agent 自律(bug 0001 的教训 —— advisory-only 方案被明确否决)。
- **建议**:**分层处理**。① hash 去重:**ADOPT**(一行脚本逻辑,确定性)。② similar version:**REDESIGN** —— Weft 需要机械相似度是因为治理 LLM 是外部服务、fail-closed 必须埋在工具层;skill 里宿主 agent 本身就是 LLM,可以在 plan 阶段对"标题/token 重叠的候选对"直接做语义判断,机械 Jaccard 预过滤可保留为便宜的召回手段(CJK shingle tokenize 那 60 行值得抄),但 0.5 阈值标定、bucket cap 等工程细节不必迁移。③ factual conflict:**ADOPT** `semantic-check` prompt(`templates/prompts/semantic-check.md`)原样可用。ADR-0008 的核心教训要继承:**宁可 fail-closed 成 candidate,不可静默 approved**。

### 2.4 裁决记忆 .kb/govern/(tombstones / dismissals / conflicts / decisions)
- **位置**:`governance/scripts/lib/govern.mjs:30-124`(三个状态文件 + 指纹);`governance/scripts/lib/decisions.mjs`;`CONTEXT.md` "Adjudication memory"。
- **摘要**:四个不可重建的裁决记忆 —— ① `source-tombstones.json`:被裁决败方的 raw 墓碑,plan 不再列入 pending、apply-source 无 `--force` 拒绝复活;② `conflict-dismissals.json`:"平行文档"对被持久化,不再每次运行重复标记;③ `conflicts.json`:plan 写的冲突旁路,带 raw 集新鲜度指纹,apply 时验证指纹、过期则降级为 in-topic 检查;④ `decisions/<id>.json`:每次变更 wiki/ 的决策记录,human 必填 reason,LLM 记录 model_version + 引用的先例 ID,先例矛盾时 fail-closed 成 candidate。
- **建议**:**ADOPT(裁剪版)**。tombstones 和 dismissals 是两个极小的 JSON 文件,直接照搬 —— 它们解决的是"裁决结果跨会话持久"这个 skill 最痛的问题(宿主 agent 没有记忆,每次会话重开,没有墓碑机制同样的问题会反复出现)。conflicts.json 的指纹机制可砍(skill 里冲突判断由 agent 当场做)。decisions 日志 **ADOPT**:它是 govern-decide prompt 的 few-shot 来源(见 §2.6),也是 skill 场景下唯一能让 agent"沿着人类先例裁决"的机制;记录格式可精简为 jsonl 单文件追加而不是每决策一个文件。

### 2.5 sweep 对账 + unlogged-flip 守卫
- **位置**:`docs/adr/0005-rejected-transient-status-and-sweep.md`;`govern.mjs` `sweep()`(`govern.mjs:804-838`)、`assertNoUnloggedFlip`(`govern.mjs:473-480`)。
- **摘要**:viewer 只能翻 frontmatter status、不能写 log.md,所以每次治理运行先跑 sweep:diff log.md 与当前页面状态,回填缺失的 `review |` 日志行,并把 rejected 页移入 archive/ 翻成 archived。工具层守卫:最后一条日志是 `candidate:*` 但状态已变的页面携带"未登记翻转",apply/merge/archive 全部拒绝触碰直到 sweep 固化记录。
- **建议**:**REDESIGN(大部分砍掉)**。sweep 的存在理由是多写者世界(viewer 写了状态但没写日志)。skill 里宿主 agent 翻状态时**当场同时写 log.md**,对账需求消失。sweep 仅保留一个退化形态:"把 rejected 页归档"这一步机械动作(可并入 govern run 的第一步,或让 agent 按规则执行)。unlogged-flip 守卫整体删除。

### 2.6 govern-decide:先例 few-shot 决策 prompt
- **位置**:`templates/prompts/govern-decide.md`;`agent/weft_agent/decisions.py`、`tasks/govern_decide.py`;`decisions.mjs` `findPrecedents`。
- **摘要**:把同类型历史决策(最近 N 条)作为先例喂给模型,要求输出 `{decision: approved|rejected|candidate, reason, referenced_decisions}`;先例矛盾时 fail-closed 到 candidate 并解释。这是 ADR-0009 否决"硬编码自动化等级 L0-L3"后选定的机制 —— 静态等级无法表达"LLM 应学习人类在类似情况下怎么判"。
- **建议**:**ADOPT as-is**(几乎是纯 prompt,天然适合 skill)。这是整个决策日志机制的消费端,与 §2.4 的 decisions 日志成套迁移。

### 2.7 reject-and-restore(拒绝即恢复上一 approved 版)
- **位置**:`govern.mjs` `rejectPage()`(`govern.mjs:738-771`);ADR-0008 "reject-and-restore"。
- **摘要**:拒绝一个覆盖了 approved 页的 candidate 时,从 Git 历史找回最后一个 status:approved 的版本恢复,并同步写日志(防止 sweep 回填误记为批准);非 Git KB 或历史无 approved 版则降级为普通 reject + 警告。
- **建议**:**ADOPT**。依赖 KB 是 Git 仓库(契约本来就要求),skill 里宿主 agent 用 `git log`/`git show` 即可完成,不需要专门脚本。这是"破坏性操作可恢复"原则的样板。

### 2.8 merge 纪律(仅 approved 双方、机械重写 backlink、并集溯源)
- **位置**:`govern.mjs` `mergePages()`(`govern.mjs:847-897`);`schema/governance.md` §3。
- **摘要**:合并仅限同类、双方必须 approved(有 candidate 先评审);人类决定哪个 slug 存活,工具机械重写全库 backlink、并集 sources、归档败方并记日志。merged body 由 LLM 事后用 apply 写回(有矛盾带 --candidate)。
- **建议**:**TRIM**。规则(仅 approved、人类选定存活方、并集溯源、重写 backlink)写进 SKILL.md;机械重写由宿主 agent 的 Grep+Edit 完成,不需要专门脚本。

### 2.9 graph-constrained govern run(固定骨架,LLM 只做节点内判断)
- **位置**:`docs/adr/0012` §4;`agent/weft_agent/govern_graph.py`。
- **摘要**:治理 run 的骨架固定为 sweep → plan → 逐文档处理 → synthesis 聚类 → rebuild-index,由图节点代码调 `govern.mjs` 子命令 —— **治理 CLI 是唯一写盘咽喉,agent 无任何直接写盘工具**;LLM 只在节点内产出结构化判断(govern-source-page / govern-synthesis / semantic-check)。每节点 checkpoint 可断点续跑。human-owned 清单只报告不裁决。synthesis 聚类规则:source 页 `related_topics` hook,≥2 个不同 raw 共享同一 topic(或同名 synthesis 已存在)才起草;每 run 上限 10 簇,每簇最多喂 6 篇 source 页正文、每篇 2500 字符。
- **建议**:**REDESIGN(骨架变成 SKILL.md 的 runbook)**。LangGraph 骨架在 skill 里就是一份**编了号的检查清单**:sweep(归档 rejected)→ plan(读清单)→ 逐文档 distill + 写 source 页 → 按 related_topics 聚类起草 synthesis(带 ≥2 raw、cap 规则)→ 重建 index.md → 汇报人类清单。checkpoint/断点续跑砍掉(宿主会话即生命周期)。"agent 无直接写盘工具"在 skill 里无法机械强制,替代方案是 SKILL.md 红线 + 可选的 apply 脚本(frontmatter 合并、状态机守卫这些确定性逻辑做成脚本仍然值得 —— 这恰好回应了 ADR-0008 "正确性必须结构化"的教训)。govern-source-page、govern-synthesis 两个 prompt(`templates/prompts/`)**ADOPT as-is**(含 `{{brief}}` 注入点)。

### 2.10 GOVERNANCE.md standing brief(用户治理简报注入)
- **位置**:`schema/contract.md` §1 白名单⑥;`govern_graph.py` 的 `brief` 参数;`templates/prompts/govern-source-page.md` / `govern-synthesis.md` 的 `{{brief}}` 占位。
- **摘要**:KB 根下一个用户拥有的 GOVERNANCE.md,作为约束性指令注入每个治理 prompt("Standing guidance from the KB operator (binding, may be empty)")。
- **建议**:**ADOPT**。skill 场景等价物天然存在:KB 根放一个 `GOVERNANCE.md`,SKILL.md 规定"每次治理运行先读它"。零成本高价值 —— 这是 per-KB 定制化的入口。

---

## 3. Retrieval(retrieval/scripts/、agent/weft_agent/research.py、ADR-0003/0007/0010)

### 3.1 "检索是接口设计问题":有界候选空间契约
- **位置**:`docs/adr/0003-retrieval-as-interface-design.md`;`retrieval/scripts/lib/query.mjs` §5;`retrieval/scripts/kb_search.mjs` CLI 头注释。
- **摘要**:不给 LLM "top-k snippet 定生死"的传统 RAG 接口,而是返回**有界、可反复挖掘的候选空间**:top-10 preview + 完整 top-K 落盘 + `--within` 限定范围迭代深挖 + `read <page>#<anchor>` 取整节;每页 ≤2 条 snippet 控制上下文成本;输出自带 hint("use read … narrow the scope with --within")。分工:逻辑查询定义候选集,BM25 只负责排序;rerank/改写/全文阅读归 LLM。
- **建议**:**REDESIGN 实现、ADOPT 协议**。没有 SQLite/FTS5 的 skill 里,宿主 agent 用 Grep/Glob/Read 充当召回层;要继承的是**协议要素**:① 先给 preview(少量、带 anchor),再给深挖手段;② 每页 snippet 限量;③ `--within` 的等价物 = "在这些页面/目录里再搜";④ read #anchor 的等价物 = 按 heading 读 section;⑤ 返回结果里给 agent 下一步提示。这些写成 SKILL.md 的 search protocol 一节。候选空间落盘(`.kb/candidates/`)可砍 —— 会话上下文即候选空间。

### 3.2 index-first 检索:wiki/index.md 是 Tier 0
- **位置**:`schema/contract.md` §3.6;`CONTEXT.md` 检索服务段("for broad questions first read index.md")。
- **摘要**:宽泛问题先读 index.md 建立全局图,再构造结构化查询;index.md 是给检索服务和 Claude 双方阅读的入口契约。
- **建议**:**ADOPT**。无搜索引擎场景下这就是 skill 检索的第一步,写进 SKILL.md:"任何检索先读 wiki/index.md"。

### 3.3 结构化查询(type:/source:/tag:/after:/before:)
- **位置**:`retrieval/scripts/lib/query.mjs` `parseQuery`(`query.mjs:17-28`);CONTEXT.md 检索段。
- **摘要**:frontmatter 字段精确过滤(type/source/tag)+ 按"文档自身更新时间"的 after:/before:(source 页优先取源系统 source_version,索引时归一 UTC 使字典序=时序);裸词 AND、"phrase" 短语。由 agent 构造查询 —— 分工是"逻辑查询定候选集,BM25 定排序"。
- **建议**:**TRIM**。字段过滤的思想保留(agent 可以先按 frontmatter 字段过滤文件集再搜正文);具体语法引擎砍掉。"时间过滤取源系统时间优先"这条语义值得保留进 SKILL.md。

### 3.4 双 FTS5 表 + per-term 路由(latin porter / CJK trigram / 短词 LIKE)
- **位置**:`CONTEXT.md` 检索段;`query.mjs` `routeTerm`(`query.mjs:34-39`)。
- **摘要**:英文词干(porter)走 fts_latin,CJK ≥3 字走 trigram,<3 字走 LIKE(trigram 物理盲区);查询统一双引号包裹消毒(防 FTS5 把连字符当 NOT)。
- **建议**:**DROP**。纯搜索引擎实现细节。宿主 Grep(ripgrep)已覆盖大部分能力;唯一值得留下的知识是"CJK 1-2 字短查询是盲区,需要 bigram 滑动"这一经验,可作为 SKILL.md 的一条检索提示。

### 3.5 图扩展:outlink 邻居 + 溯源邻居(ADR-0007)
- **位置**:`docs/adr/0007-semantic-graph-navigation-tree.md`;`query.mjs` §4(`query.mjs:160-196`)。
- **摘要**:top-10 命中页的出链邻居并入候选(标注 `via:link`);topic 命中拉入其 `sources:`(via:provenance,正向),source 命中拉入覆盖它的 topic(反向,读时计算永不落盘);每页每方向 fan-out 上限 20;派生邻居与 authored 链接分开标注供 LLM 分别权衡。
- **建议**:**ADOPT(作为 agent 行为规则)**。skill 里无需索引支持:agent 读到命中页后,按规则"沿 [[wikilink]] 和 sources: 各扩一跳、每页上限 N、标注 via"即可。这是纯 prompt 化的图扩展,也是"无离线图管线(GraphRAG 不建)"决策的延伸 —— CONTEXT.md 明确说 wiki backlink + index.md 已构成显式结构,agentic 迭代检索足够。

### 3.6 search-smart:fallback 阶梯 + LLM 改写 + RRF 融合 + 可选 rerank
- **位置**:`docs/adr/0010-retrieval-optimization-route.md`;`agent/weft_agent/research.py` `search_with_fallback` / `search_smart`;`templates/prompts/query-rewrite.md`、`rerank.md`。
- **摘要**:口语化中文提问会打败跨表 AND(疑问词变 trigram 无页命中),于是:① 原查询 → ② 剥疑问停用词 → ③ 逐词/bigram 分路检索按频次合并;命中不足时一次 LLM 改写生成 2-3 个关键词查询(中英同义扩展),各路结果 RRF(1/(60+rank))融合;deep 级可选 listwise LLM rerank(top-20→top-k)。明确**禁止 HyDE**(臆测扩展),只允许 CSQE(从命中 snippet 提取关键词改写再查)。
- **建议**:**TRIM**。skill 里宿主 LLM 原生就会查询改写和多路检索,query-rewrite prompt 可 ADOPT 为参考模板;RRF 融合退化为"多路结果按页去重合并,agent 自行权衡"(RRF 是给无判断力的管线用的,宿主 agent 有判断力);停用词表(`research.py:28-32`)值得抄进 SKILL.md 作为改写提示。**"禁 HyDE、只许 CSQE"这条规则必须 ADOPT** —— 防止 agent 编造看似合理的关键词污染召回。

### 3.7 deep-research 多轮循环
- **位置**:`agent/weft_agent/research.py` `run_research_loop`(`research.py:149-214`);`templates/prompts/deep-research.md`;ADR-0011(忠实度守门 + uncited_reads 兜底)。
- **摘要**:多轮研究循环 —— 第 1 轮搜原问题,第 2+ 轮搜改写变体;每轮读 top 页全文、维护 seen-pages 防重、累积 citations;轮次封顶;只用 approved 页,每条 claim 用 [[wikilink]] 引用;答完后 judge-faithfulness 守门(<0.8 以更严指令重生成一次);非拒答但零引用且有命中时附 uncited_reads 兜底,不伪造引用。
- **建议**:**REDESIGN 为 prompt 循环**。整套循环就是一段 SKILL.md 流程描述:"搜索 → 读 top-3 全文 → 从命中提取新关键词 → 再搜(≤3 轮)→ 仅基于已读页作答,逐条 [[wikilink]] 引用 → 引用为空则明示 KB 无此内容"。faithfulness judge 简化为一条自检指令;rerank/judge 三件套 prompt(judge-context-precision / judge-faithfulness / judge-relevance)属于 eval 基础设施,skill 不迁移。

### 3.8 approved-only 可见性(结构性保证)
- **位置**:`schema/contract.md` §4 末条;`retrieval/scripts/lib/store.mjs` `indexDoc`;`kb_search.mjs` read 的 gates(inside wiki/ + not archive + approved)。
- **摘要**:检索只索引 status:approved 的页;read 命令在 wiki/ 内、非 archive、approved 三重 gate。candidate/archived 对检索结构性不可见。
- **建议**:**ADOPT**。skill 里变成检索协议第一条:"只搜 approved 页,不读 wiki/archive/"。写进 SKILL.md 即可,若配 plan/检索脚本则在脚本里机械执行。

---

## 4. Chat 蒸馏(ADR-0013、agent/weft_agent/tasks/distill_chat.py、acquisition/scripts/connectors/chat.mjs、ui/lib/distill.mjs)

### 4.1 蒸馏文档形态:正文 [T-n] 标记 + 同文件机械转录附录
- **位置**:`docs/adr/0013-chat-distillation-to-raw.md`;`templates/prompts/distill-chat.md`;`agent/weft_agent/tasks/distill_chat.py`。
- **摘要**:LLM 把对话蒸馏为结构化文档,**每个蒸馏点必须带 `[T-n]` 引用标记**指向转录条目;转录附录(逐条消息,角色/时间戳)由代码机械追加在同一文件末尾 —— 模型永不写附录,附录保真是结构性的;引用在同文件内解析,转录计入 content_hash,证据与蒸馏稿原子共存;正文用对话自身语言(raw 保留源语言);超长(30000 字符)显式报错,绝不静默截断(截断会无声断开证据链)。
- **建议**:**ADOPT as-is**。这是整套系统里最适合 skill 化的机制 —— 已经是"一个 prompt + 一段机械拼接"。`distill-chat.md` prompt 直接进 skill 的 prompts/ 目录;附录拼接逻辑约 20 行,做成小脚本或让 agent 按模板执行均可(脚本更稳,因为附录保真是卖点)。

### 4.2 双层 fail-closed 引用校验
- **位置**:`ui/lib/distill.mjs` `validateDistilled`(层 1);`acquisition/scripts/connectors/chat.mjs` `parseDistillationDoc`(层 2)。注释明确"deliberate duplication, keep in sync by hand"。
- **摘要**:两处独立验证:正文每个 [T-n] 可解析到附录条目、附录编号连续无断裂、附录条数=转录条数、body 无 frontmatter;任一失败 → 不写任何文件,显式报错;LLM 失败不留半成品。
- **建议**:**TRIM 为一层**。双层校验是门户/连接器两个写者各防一手;skill 单写者,一层足够。正则(`ENTRY_RE`/`REF_RE`)直接抄进一个 `validate-distill` 小脚本(fail-closed 校验是典型的"正确性必须结构化",不该交给 agent 自律)。

### 4.3 身份规则:conv-<hash8>,幂等重蒸馏
- **位置**:ADR-0013 §3;`chat.mjs:82-93`。
- **摘要**:`source_id = conv-<转录hash8>`(hash 的是附录部分),同一对话重复整理 = 覆盖同一篇(契约"重拉即覆盖");`source_url = weft://chat/<source_id>`;`source_version` = 末条消息时间;不支持框选子集(子集会破坏幂等语义);蒸馏成功文案明确"下次治理运行后进入 wiki 可检索" —— 不挂立即治理链。
- **建议**:**ADOPT**。规则全部可移植;"落 raw 即完成、治理等下一轮"这一节奏裁决也照搬(用户已裁决过,ADR-0013 §5)。

### 4.4 暂存区编排(inbox-chat/ → 连接器落盘)
- **位置**:`ui/lib/distill.mjs` `distillJob`;ADR-0013 §2。
- **摘要**:门户把蒸馏结果写 `inbox-chat/` 暂存(local 连接器 inbox/ 的兄弟目录 —— 放进 inbox/ 会被递归扫描重复采集),再 spawn `acquire chat` 连接器落盘;门户全程不写 raw/,写权限矩阵零改动。
- **建议**:**REDESIGN(删除)**。暂存区舞蹈的唯一目的是维护"raw/ 由 acquisition 独占写"的矩阵;skill 里宿主 agent 就是唯一写者,蒸馏 → 校验 → 直接写 `raw/chat/conv-<hash8>.md` 一步完成。

---

## 5. 裁决 UI(governance/viewer/、ui/public/views/queue.js)

### 5.1 薄 viewer:候选队列 + 状态翻转唯一写操作
- **位置**:`docs/adr/0004-thin-viewer-three-red-lines.md`;`governance/viewer/public/app.js`。
- **摘要**:三条红线 —— 按需启动非常驻、无用户体系、dumb consumer 零治理逻辑(唯一写操作 = 翻 frontmatter status,带乐观并发,409 显式冲突)。页面视图的信息层级值得注意:**review_note(候选原因)是最重要的一条评审上下文**,单独高亮;candidate 页提供"Diff vs Git baseline"(LCS 行 diff,折叠展示);`source_ref`/`sources` 每条是可点击的"Source evidence"折叠块,按需加载 raw 原文。
- **建议**:**REDESIGN 为 agent 的呈现规范**。skill 里没有浏览器 UI,"viewer"变成宿主 agent 在会话里的输出格式。要继承的是**信息层级**:① 候选队列清单(标题+类型+更新时间);② 单页评审时 review_note 永远最先展示;③ diff vs 上一 approved 版(git diff);④ 溯源证据可展开(列出 sources,需要时读 raw)。写成 SKILL.md 的"review 呈现格式"一节。乐观并发/409 删除(单操作者)。

### 5.2 门户评审队列:五动作裁决条
- **位置**:`ui/public/views/queue.js` `renderReview`(queue.js:97-267)。
- **摘要**:五动作 —— ✓批准 / ✗拒绝并恢复(reject-and-restore)/ ✎编辑(保存即降级 candidate 再批)/ 🗄归档来源(**先在来源行点选败方,无默认目标**,再执行)/ ◫保留两者(dismiss,平行文档不再标记)。每个动作强制填理由(对应 decisions 日志的 human-reason 必填)。冲突组渲染为裁决 CTA(冲突类别+相似度+raw 清单,"必须裁决");来源已被 loser-archive 的 candidate 显示"先编辑去除旧内容再批准"的提醒;页底附该页最近决策记录;另有批量批准/批量两段武装拒绝、j/k 热键。
- **建议**:**ADOPT(作为决策菜单)**。五动作就是 skill 的 `review` 命令集,映射为:approve / reject(自动尝试 restore)/ edit-then-approve / archive-loser(必须显式指定败方)/ keep-both。最需要可视化的决策点(即 SKILL.md 里 agent 必须主动呈现的信息):**① 候选原因 review_note;② 与上一版的 diff;③ 冲突组全貌(谁和谁、哪类冲突、相似度)并要求显式选败方;④ 该页历史决策记录**。批量操作和热键属于 UI 效率层,skill 不需要(agent 可以批量处理但要在日志里逐条记录)。

### 5.3 门户其他视图的取舍
- **位置**:`ui/public/views/`(dashboard / browse / graph / search / acquire / upstream / settings / govern / chat / raw)。
- **摘要**:graph 视图(导航树 + 语义图双 tab,ADR-0007)、搜索视图、采集控制台、上游变更检测、设置页(models.json/prompts 编辑)、治理 run 直播(NDJSON→SSE)等,都是常驻门户的产品面。
- **建议**:**DROP(整体)**。门户是团队服务器形态,与 skill 的"宿主会话即界面"互斥。唯一值得留意的是 graph 视图的教训(ADR-0007):**index.md 万能链接会让图退化成星形,语义边要从 frontmatter `sources:` 派生** —— 这条知识已沉淀在检索的 provenance 扩展(§3.5)里,skill 继承那一份即可。

---

## 附:整体裁剪建议汇总

**ADOPT(核心价值,直接迁移)**:两区数据模型、身份五元组、字符白名单、candidate 状态机、index.md 入口契约、wikilink 规范、log.md、风险分级原则、裁决记忆(tombstones/dismissals/decisions)、govern-decide 先例 prompt、reject-and-restore、distill-chat 全套(prompt+附录+校验+幂等身份)、GOVERNANCE.md 注入点、govern-source-page / govern-synthesis / semantic-check / query-rewrite prompts、CSQE-only 规则、approved-only 可见性、图扩展规则、评审信息层级。

**TRIM(保留思想,砍掉工程)**:写权限矩阵(→SKILL.md 红线)、四种页面类型(→先 source+synthesis 两类)、plan 六清单(→一个轻脚本或 agent 流程)、结构化查询(→字段过滤思想)、search-smart(→改写+去重合并)、fail-closed 校验双层(→单层脚本)、merge 机械重写(→agent Grep+Edit)、决策日志格式(→jsonl)。

**REDESIGN(形态根本变化)**:graph-constrained govern run(→SKILL.md 编号 runbook + 可选 apply 脚本)、sweep(→"治理运行先归档 rejected"一步)、kb_search 候选空间(→Grep/Glob/Read 上的检索协议)、deep-research 循环(→prompt 循环)、viewer/门户(→会话内呈现规范 + 五动作决策菜单)、暂存区编排(→直写 raw/chat/)。

**DROP(属于已放弃的形态)**:双 FTS5/向量检索、SQLite 索引与 `.kb/` 大部分内容、串行写队列、NDJSON/SSE 流式、checkpoint 断点续跑、门户全部视图、auth/token、LangGraph/Python agent 服务本身、eval judge 三件套。

**最重要的三条元教训**(来自 ADR 记录的真实事故):
1. **正确性必须结构化,不能靠 agent 自律**(ADR-0008 否决 advisory-only;bug 0001):fail-closed 的守卫(hash 去重、蒸馏校验、candidate 强制)要留在脚本里,哪怕 skill 里只剩两三个脚本也值得。
2. **裁决记忆是 agent 无记忆性的解药**(`.kb/govern/`):tombstones/dismissals/decisions 让跨会话的 agent 不重复犯已裁决的问题,且能通过 decisions few-shot 学习人类判例。
3. **固定骨架 + 节点内 LLM 判断**(ADR-0012 graph-constrained)恰好就是 SKILL.md 的最佳写法:流程编号写死,LLM 只在每步内做结构化产出 —— 这降低了 skill 对宿主 agent 能力的假设。
