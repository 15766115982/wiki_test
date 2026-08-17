# 治理工作流细化:runbook、prompt 模板与裁决呈现

Type: grilling
Status: resolved
Blocked by:

## Question

把治理运行从"五步骨架"细化为可直接写进 SKILL.md 的完整工作流:

1. **runbook 逐步细化**:sweep(归档 rejected)→ plan(六清单:new/stale/anomalies/errors/review_queue/人类清单)→ 逐文档处理 → synthesis 聚类(≥2 raw 共享 topic、每 run 上限等阈值)→ rebuild index → 汇报。每步脚本做什么、agent 做什么。
2. **prompt 模板清单**:从 Weft 迁移哪些(govern-source-page / govern-synthesis / semantic-check / distill-chat / query-rewrite),skill 新增哪些;GOVERNANCE.md 注入点。
3. **裁决呈现规范**:会话内评审的信息层级(review_note 最先、diff vs 上一 approved、溯源证据可展开、历史决策记录)+ 五动作决策菜单(approve / reject-and-restore / edit-then-approve / archive-loser 显式选败方 / keep-both),以及何时改道生成裁决 HTML(与「治理裁决 HTML 报告原型」票衔接)。
4. **decisions.jsonl 记录格式**与先例 few-shot 的取用规则。

输入:「KB 目录契约」「运行时架构」决议 + Weft 调研 §2/§5。

## Answer

**runbook 定稿**(前置 `node --version` 探测):
0. agent 读 GOVERNANCE.md / kb.json / decisions.jsonl 先例 → 1. sweep(脚本;降级手动)→ 2. plan 六清单(脚本;降级手动)→ 3. 逐文档(classify→draft→entity/concept→validate 三道 fail-closed→风险分级→semantic-check,每步写 decisions.jsonl)→ 4. synthesis 聚类 → 5. rebuild index(脚本)→ 6. 汇报裁决。

**synthesis 聚类**:沿用 Weft 默认阈值,全部入 kb.json 可调 —— ≥2 篇不同 raw 共享 topic 成簇;每 run ≤10 簇;每簇 ≤6 篇 × ≤2500 字符。run = 一次完整治理运行;簇 = 同 topic source 页分组,一簇产一篇 synthesis。

**更新机制(用户追问澄清,写进 spec)**：非 source 页身份 = slug;起草前**先查存**(index.md + plan 疑似重复对 + entity 按 name/aliases 匹配),存在则 union-merge 更新(sources 并集、created_at 保留、正文重新融合),矛盾则强制 candidate;查不到才新建。无记忆 agent 靠 index.md + 裁决记忆 + decisions.jsonl 重建认知。

**裁决回环**:每 run 末 render 脚本生成**一份**汇总裁决 HTML(只读视图:review_note 最前、diff vs 上一 approved、溯源证据、历史决策);用户在对话回决定(可批量),agent 应用五动作(approve / reject-and-restore / edit-then-approve / archive-loser 显式选败方 / keep-both),逐条写 decisions.jsonl(human 必填理由)+ log.md。

**自动化原则(用户拍板,已入地图 Notes)**:自动化为主、非必要不裁决 —— 增量可逆全自动;矛盾/重复/合并/归档才裁决;先例 few-shot 让打扰递减;fail-closed 底线不破。

**并行**:宿主支持子代理时第 3 步 fan-out 并行起草,主会话统一校验落盘;否则顺序。

**prompt 清单(确认)**:distill-chat / classify-page / draft-source-page / extract-entity / draft-concept / draft-synthesis / semantic-check / govern-decide / query-rewrite。

**decisions.jsonl**(确认):每行 `{"ts","actor":"human|agent","action","page","reason"(human 必填),"cited":[]}`。
