# 宿主能力调研:Claude Code / Copilot / .agent 的 skill 机制

Type: research
Status: resolved
Blocked by:

## Question

调研三类宿主环境的 skill 机制,为运行时架构决策提供事实基础:

1. **Claude Code skills**:目录约定(`.claude/skills/`)、SKILL.md frontmatter 规范、允许携带的文件(脚本/模板/参考文档)、脚本如何被调用(Bash 工具?)、子代理(Task)可用性。
2. **GitHub Copilot(VS Code)skills / agents**:是否存在 `.copilot/skills/` 约定?copilot-instructions、`.agent.md`、prompt files 的现状;skill 能否携带脚本并被 agent 执行;与 Claude Code skill 格式的兼容性。
3. **`.agent/` 目录约定**:这是哪个工具/标准的约定(如 GitHub Copilot coding agent、agents.md 生态)?目录结构与加载机制。
4. **三方交集**:同一个 skill 目录要在三类宿主中可用,公共子集是什么(纯 Markdown 提示词?能否假设脚本执行能力?)。

输出:事实矩阵(宿主 × 能力),每条结论引用一手来源(官方文档/源码),写入 `.scratch/llm-wiki-skill/research/01-host-capabilities.md`。

## Answer

完整报告:[research/01-host-capabilities.md](../research/01-host-capabilities.md)。要点:

1. **GitHub Copilot 已于 2025-12-18 官方采纳 Agent Skills(SKILL.md)格式**,VS Code v1.108(2025-12)起实验性支持,且**自动读取已有 `.claude/skills` 目录**。
2. Copilot 的 skill 位置:项目级 `.github/skills`、`.claude/skills`、`.agents/skills`;个人级 `~/.copilot/skills`、`~/.agents/skills`。Claude Code 只读 `.claude/skills/`(项目)与 `~/.claude/skills/`(个人)。
3. **任何宿主都不会自动执行脚本**:Claude Code 经 Bash 工具、Copilot 经终端工具,都在各自审批模型下运行——**跨宿主不能假设脚本执行能力**,脚本可携带但必须有内联手动降级路径。
4. frontmatter 公共子集 = `name` + `description`;`allowed-tools` 无 Copilot 官方承诺(可能被忽略),VS Code 只认 `user-invocable` / `disable-model-invocation`。
5. ".agent" 生态实为三物:AGENTS.md(根单文件标准)、`.agents/skills/`(厂商中立目录,Copilot/Cursor 读、Claude Code 不读)、`.github/agents/*.agent.md`(Copilot 自定义 agent)。
6. **三方公共子集 = 一个目录 + SKILL.md(仅 name/description)+ 自包含 Markdown 指令**;脚本可捆绑但须配手动降级。
7. **仓库内最佳单一真实位置是 `.claude/skills/<name>/`**(Claude Code 原生,且被所有 Copilot 界面官方自动检测),再用 symlink/安装器(`gh skill`、`npx skills`)投影到 `.agents/skills/`。
8. ⚠️ 注意:调研期间 WebFetch 被网络阻断,引用来自 WebSearch 对官方页面的摘要(URL 已列在报告中);2026 年快速变动的特性(如 `gh skill` 预览、frontmatter 演进)**交付前应复核**。
