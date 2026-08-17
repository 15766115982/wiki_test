# 运行时架构:纯提示词 vs 提示词+脚本

Type: grilling
Status: resolved
Blocked by: 01

## Question

决定 skill 的执行架构:纯提示词(零安装,宿主 agent 执行一切)vs 提示词+Node 脚本(确定性工作走脚本)vs 混合分层。约束输入:拉取已定自带连接器(暗示需要脚本或宿主网络能力),检索已定纯 agentic(零依赖倾向),UI 已定静态 HTML(生成者待定)。决策需回答:每个能力(拉取/治理/检索/蒸馏/可视化)分别由谁执行;若带脚本,宿主如何调用、装不上怎么办(降级路径)。

## Answer

**形态:提示词为主 + 渐进增强脚本。** SKILL.md 提示词是唯一规范路径(零脚本全功能可用);四个脚本为"能跑就跑"的增强,每个都在提示词里写明手动降级路径。

**脚本清单(四个,全部入选):**

| 脚本 | 职责(确定性部分) | 手动降级路径 |
|---|---|---|
| `acquire` | Jira/Confluence 认证、分页、storage format→Markdown、写 raw/ + frontmatter(含内容 hash) | 用户复制页面内容,agent 按模板手动归一化 |
| `validate` | 三道 fail-closed 检查:hash 去重、frontmatter 校验、蒸馏引用逐字校验。跑不了=不通过=强制人审 | agent 按 runbook 手动逐步检查(显式接受可靠性下降) |
| `govern` | 治理运行骨架:sweep、plan(hash 对比产工作清单 JSON)、rebuild index.md。判断性工作(摘要/查冲突/起草)由 agent 逐项做 | agent 自己遍历目录、读文件比 hash(小 KB 可行) |
| `render` | 读 wiki/ 生成静态站点 + 裁决 HTML(目录、正文、wikilink 关系图、双栏 diff) | 小 KB 时 agent 按模板现场手写 HTML |

**语言与工程惯例(用户拍板):**
- **Node 零依赖单文件 `.mjs`;最低 Node 20,主要支持版本 Node 24。** 不假设 npm install。
- 脚本放 `<skill>/scripts/`,stdout 输出 JSON(沿用 Weft CLI 契约),usage 错误退出码 64。
- 治理运行开始先跑 `node --version` 检测:不可用 → 整轮转手动路径并明确告知用户。
- SKILL.md 每个脚本附「无脚本手动路径」小节,步骤写到 agent 可照做。
- 宿主通过自身终端能力调用脚本(Claude Code 的 Bash / Copilot 的终端工具),各自审批模型下运行——不假设自动执行。
