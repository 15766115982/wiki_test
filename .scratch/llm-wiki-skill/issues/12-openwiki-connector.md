# OpenWiki 仓库 wiki 作为 raw 来源(本地连接器)

Type: grilling
Status: resolved
Blocked by: 04, 09

## Question

能否把 openwiki 在代码仓库生成的 wiki(`<repo>/openwiki/` 下的 OKF v0.1 Markdown 页面)作为 raw 文档来源接入 KB?需要定:概念定位(当 raw 证据层 ingest,还是当外部只读 KB 联邦检索)、source_id 与路径映射(openwiki 页面路径带层级,与 source_id 白名单冲突)、增量与删除语义、拉取选择器(全量还是子集)、连接器载体(无 API,纯本地文件系统)。

## Answer

**概念定位:当 raw ingest(用户拍板)。** openwiki 产物本身已是策展 wiki,接入 raw 层意味着"对摘要再摘要"(双层消化,有信息损耗且 KB 内会出现与原 wiki 高度重复的 source 页);替代方案"联邦检索"(agentic search 时顺路检索目标仓库 openwiki/index.md,不落 raw)被否决——它破坏 raw→wiki 单向数据流,且 synthesis 无法跨"代码知识 × Jira/Confluence 需求知识"融合,而后者正是接入的核心价值(如"订单状态机"的实现页与需求页聚成一簇)。接受双层消化,换统一检索入口与跨源 synthesis。

**连接器形态:本地文件系统连接器,无认证。** acquire 增加 `openwiki` source:选择器 = 本地仓库路径(+可选子目录子集),读取 `<repo>/openwiki/` 下 Markdown,拷贝并打 frontmatter。无需 PAT/网络,kb.json 无需新增配置(路径调用时指定,与四选择器风格一致)。`source_url` 用仓库 remote URL + 页面相对路径(无 remote 则用 `file://` 绝对路径);`source_version` 取该文件最后 commit 时间(非 git 仓库降级为 mtime,不臆造)。降级路径同样成立:用户手动复制页面,agent 按 §2.2 模板写 raw。

**source_id 映射:确定性扁平化。** 页面相对路径(如 `architecture/overview.md`)→ `architecture--overview`(`/` → `--`,去 `.md`),冲突时追加 hash8 后缀。这是对 spec §2.2 白名单(`^[A-Za-z0-9][A-Za-z0-9_-]*$`)的不变式兼容——不放宽白名单,映射规则进 §3 连接器章。幂等由"路径稳定 + 机械映射"保证,与契约票"路径=source+source_id 必须稳定"一致。

**增量与删除:** content_hash 增量原样继承(hash 相同即跳过,多数 openwiki 页面在仓库未变更时天然免处理)。**删除必须显式处理**:detect 阶段对比 openwiki 页面清单与 `raw/openwiki/` 现存文件,上游消失的页删除对应 raw(并在 log.md 记 `pull` + note `removed_upstream`),随后治理 run 按既有流程消化(source 页归档走 candidate,人裁决)——不能静默残留死知识。

**拉取选择器支持子集。** 仓库 wiki 体量几十到上百页,多仓库 × 定期更新会放大治理 run 处理量。acquire 支持按子目录/页面清单拉取(推荐默认跳过 `log.md`、source maps 类低价值页);`max_clusters_per_run` 兜底不变。openwiki 页面间是标准 Markdown 相对链接(非 wikilink),raw 层无需改写;治理 agent 读 raw 时可顺链接发现同仓库其他 raw 页,属免费召回增强。

**spec 实改清单(已落实,2026-08-12):**
- §2.2:source 枚举加 `openwiki`;目录树加 `raw/openwiki/<flattened-id>.md`。✅
- §3.1:本地文件系统连接器小节(选择器、扁平化映射、detect 删除处理、source_version 降级链 commit-time → mtime)。✅
- §2.2 白名单不变;扁平化规则只出现在 §3.1。✅
- §0 能力清单同步提及 openwiki 连接器。✅
- 中英两份 spec 均已更新。

**挂起**:openwiki 页面 OKF frontmatter(`type` 等)是否映射为 raw frontmatter 扩展字段供治理选摘要模板 —— 实现期视治理 prompt 需要再定,默认原样保留在 raw 正文头部即可。
