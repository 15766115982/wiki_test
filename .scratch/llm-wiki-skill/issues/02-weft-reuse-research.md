# Weft 可复用机制调研

Type: research
Status: resolved
Blocked by:

## Question

深入 `D:\claude\knowledge-extension`(Weft),提炼对 skill 化有价值的机制,并标注裁剪建议:

1. **契约层**:`schema/contract.md` 的目录结构、frontmatter 规范(身份五元组、状态机)、四种页型(ADR-0009)——哪些是 skill 场景的核心,哪些过重?
2. **治理机制**:候选状态机、冲突检测(ADR-0008)、裁决记忆、govern run 的图编排(ADR-0012)——在"宿主 agent 即 LLM"的场景下如何重新表达(提示词模板替代 Python agent)?
3. **检索机制**:retrieval 的 index.md 契约、图扩展、以及 agentic search 相关实现(`search-smart` 等)——纯 agentic 迭代检索可借鉴的协议要素。
4. **对话蒸馏**:`distill-chat` 的提示词与归一化流程。
5. **治理可视化**:viewer 与 portal 中人类裁决 UI 的形态,哪些裁决点最需要可视化。

输出:机制清单(机制 → Weft 实现位置 → skill 化建议:照搬/裁剪/重设计),写入 `.scratch/llm-wiki-skill/research/02-weft-mechanisms.md`。

## Answer

完整报告:[research/02-weft-mechanisms.md](../research/02-weft-mechanisms.md)。要点:

1. **契约层全部 ADOPT**:raw/wiki 两区模型 + frontmatter 身份五元组 + candidate 状态机 + wiki/index.md 入口契约——天然契合 skill 形态(纯文件系统契约,编排上移给 LLM)。
2. **治理风险分级原则**(增量可逆自动生效、破坏性/矛盾进 candidate)直接改写成 SKILL.md 规则段。
3. **fail-closed 守卫保留为少数脚本**:hash 去重、强制 candidate、蒸馏引用校验——正确性靠结构不靠 agent 自律(ADR-0008 的教训)。
4. **裁决记忆 `.kb/govern/` 是最关键迁移项**:宿主 agent 跨会话无记忆,没有它会重复已裁决问题;decisions 日志同时是 govern 判断的 few-shot 先例源。
5. **govern run 重设计为编号 runbook**:sweep→plan→逐文档→synthesis 聚类→rebuild-index,LLM 只做节点内结构化判断(替代 LangGraph 骨架)。
6. **检索:搜索引擎全部 DROP**;保留协议要素——index.md 先行、有界候选+迭代深挖+按 anchor 读节、图扩展(wikilink+sources 各扩一跳)、CSQE-only 禁 HyDE。
7. **页型 TRIM 为 source+synthesis 两类起步**,entity/concept 留作可选扩展。
8. **chat 蒸馏(ADR-0013)几乎原样搬**:一个 prompt + 机械转录附录 + fail-closed 校验。
9. sweep/写权限矩阵/门户属多写者世界,REDESIGN 或 DROP;viewer 的价值在其**评审信息层级**(review_note 优先、diff vs baseline、冲突组显式选败方、决策历史),迁移为会话内呈现规范 + 五动作决策菜单。
10. 三条元教训:fail-closed 守卫留脚本;裁决记忆对抗 agent 无记忆;固定骨架+节点内判断恰好是 SKILL.md 最佳写法。
