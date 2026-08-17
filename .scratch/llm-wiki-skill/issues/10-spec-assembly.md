# 汇总决策,撰写双语 spec

Type: task
Status: resolved
Blocked by: 03, 04, 05, 06, 07, 08, 09, 11

## Question

所有决策票关闭后,把地图上的 Decisions-so-far 汇总成最终交付物:双语(中英)spec,覆盖五大能力、目录契约、SKILL.md 结构与提示词模板、连接器规范、agentic search 协议、蒸馏流程、静态可视化与裁决 HTML 规范、初始化/使用流程。spec 详细到实现者无需追问;落盘位置与章节结构在本票确定。这是终点票:它关闭时本地图完成。

**撰写前需先拍板的四个收尾小决策**(原雾区,已可具体化):
1. **init 引导流程**:建 KB 目录、git init、写 kb.json、验 PAT 的步骤形态(agent 引导式对话 vs 脚本)。
2. **多 KB 支持**:v1 是否支持多 KB 切换(建议:v1 单 KB,路径由用户指定;多 KB 留扩展)。
3. **分发与升级**:skill 版本号约定、模板更新策略(建议:语义化版本 + CHANGELOG,KB 契约增量兼容)。
4. **spec 验收标准**:判定"够详细可交付"的 checklist(如:实现者能不追问地写出四个脚本和 SKILL.md)。

## Answer

**四个收尾决策(用户拍板)**:init = agent 引导式(SKILL.md init 章逐步带:建目录/git init/kb.json/验 PAT);v1 单 KB,多 KB 留扩展;语义化版本 + CHANGELOG + KB 契约增量兼容;checklist 验收。

**交付物(终点达成)**:
- 中文主版:[spec/spec.zh-CN.md](../../spec/spec.zh-CN.md)
- 英文镜像:[spec/spec.en.md](../../spec/spec.en.md)

十章结构:概述 / 运行时架构 / KB 目录契约 / 连接器规范 / 治理工作流 / 对话蒸馏 / 可视化 / init 流程 / 目录结构与分发 / 验收 checklist。全部九张决策票的决议已汇总入内;原型 adjudication-report.html 作为裁决 HTML 章的形态基线引用。
