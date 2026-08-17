# 治理裁决 HTML 报告原型

Type: prototype
Status: resolved
Blocked by: 04

## Question

为"治理中需人类裁决的点"制作一个便宜、粗糙但具体的静态 HTML 原型,供人反应与拍板:裁决点的清单(重复合并、事实冲突、候选批准、归档)如何布局,每个裁决点展示什么(双栏 diff?来源链?建议操作?),人如何回传决定(纯阅读后口头/对话回复,还是 HTML 内生成可复制指令)。原型链接作为资产挂到本票。

## Answer

**原型资产**:[prototypes/adjudication-report.html](../prototypes/adjudication-report.html)(单文件零依赖,模拟支付域三案例)。**用户已确认形态**,作为 spec 裁决 HTML 章的基线:

- 顶栏 run 概览(自动生效数/待裁决数/人类清单仅告知);左侧待裁决队列带冲突类型标签。
- 信息层级:① review_note 红底高亮永远最先 → ② diff vs 当前生效版 → ③ 冲突组双方陈列、**显式选败方无默认**(不选则下轮再问)→ ④ 溯源证据折叠块 → ⑤ 该页历史决策(decisions.jsonl 先例)。
- 底部五动作 + 理由框(human 必填);**点动作生成回复文本,粘贴回对话完成裁决**(HTML 只读不回写)。
- 演示了 fail-closed 边界:符合先例但触及冲突组 → 保守转 candidate。
