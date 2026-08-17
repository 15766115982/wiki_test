# Agentic search 检索协议设计

Type: grilling
Status: resolved
Blocked by: 04

## Question

设计纯 agentic 迭代检索的完整协议(用户已定不走关键词搜索引擎):宿主 agent 从 wiki/index.md 进入后的每一步行为——如何选页、何时读全文、如何沿 wikilink 扩展、何时停止、如何引用来源、多轮迭代的上限。产出可直接写进 SKILL.md 的检索指令文本,以及对 index.md/页面 frontmatter 为支持该协议所需的字段要求(反馈进契约)。参考 Weft 的 search-smart 与图扩展机制,但执行者是宿主 agent 而非外部服务。

## Answer

**协议定稿(六条,写进 SKILL.md 检索章):**
0. 只搜 approved 页,不读 archive/(结构性可见性)。
1. **index 先行**:任何检索先读 wiki/index.md。
2. **多路召回**:关键词变体(同义/中英互扩;CJK 1-2 字用 bigram 滑动)+ frontmatter 字段过滤(时间优先取 source_version);**禁 HyDE,只许 CSQE**(从命中提取新词再查)。
3. **图扩展**:wikilink 出链 + sources 溯源各扩一跳,fan-out ≤20,标注 via:link / via:provenance 分开权衡。
4. **迭代深挖**:按 heading 分节读控制上下文;≤3 轮;已读页清单防重。
5. **作答纪律**:只基于已读页,逐条 claim 挂 [[wikilink]];零命中明说"KB 无此内容";读了未引用附清单兜底。

**两个用户拍板:**
- **单档自适应 + 「深研」口令**:agent 按问题复杂度自定轮数(上限 3);用户喊"深研"强制拉满。
- **透明度:答案 + 末尾检索说明**(查了哪些路、读了哪几页),便于判断可信度。
