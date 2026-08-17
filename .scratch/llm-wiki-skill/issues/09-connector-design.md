# Jira/Confluence 自带连接器设计

Type: grilling
Status: resolved
Blocked by: 03

## Question

设计自带连接器的形态(用户已定不依赖宿主 MCP):认证(PAT 环境变量名、配置位置)、API 范围(指定页面/空间/JQL 拉取?增量还是全量?)、附件与图片处理、归一化到 raw/ 的映射(身份字段、正文转换:Confluence storage format / Jira wiki markup → Markdown)、错误处理。执行载体依赖运行时架构决策(脚本还是 agent+fetch)。参考 Weft acquisition 的 jira/confluence 连接器。

## Answer

**载体**:acquire 脚本(Node 零依赖 .mjs,运行时架构票已定),Weft 连接器代码可裁剪搬运;降级路径=用户粘贴内容 agent 手动归一化。

**用户拍板:**
- **只支持 Server/DC**(PAT Bearer 认证);Cloud(email+API token)不支持,后续再加。
- **拉取范围由用户调用时指定**:单页 URL / Jira issue key / JQL / CQL 四种选择器都接受;kb.json 只存 base_url + pat_env(PAT 永不落盘)。不设预配置批量范围。
- **附件/图片下载到本地**:`raw/assets/<source>/<source_id>/<filename>`,确定性路径 + hash 去重;raw 正文用相对路径引用。接受 KB git 仓库变大的代价。
- **评论**:Jira 保留最近 ≤10 条;Confluence 不拉评论。

**继承 Weft 实现要点**:detect 先行(轻扫描分类 new/changed/unchanged/removed_upstream,只对 new+changed 拉全文);content_hash 相同即跳过;Confluence storage XHTML→Markdown 最小手写转换(未知宏降级 `[macro: name]` 占位不静默丢弃);Jira ADF 最小转文本;issue_type 等元数据入 frontmatter(类型不进路径,契约票已定);source_id 白名单校验,不合规 ID 跳过报错不转义;日期归一 ISO 8601,不可解析值原样保留不臆造。

**挂起**:Zephyr Scale 测试步骤拉取 → 雾区(二期)。
