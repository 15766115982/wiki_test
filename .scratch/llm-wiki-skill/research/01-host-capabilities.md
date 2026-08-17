# 跨宿主 Skill 目录能力调研（Claude Code / GitHub Copilot / .agent 生态）

> 调研日期：2026-08-12。本领域 2025 Q4 – 2026 期间变化极快，文中对每项声明标注了来源与时效性。
> 调研方法说明：本次环境中 WebFetch 被网络策略全量拦截（所有域名均返回 "Unable to verify if domain is safe"），因此一手信息来自 WebSearch 返回的官方页面摘要与链接；少数只能从训练数据获得的细节已明确标注「⚠️ 未经在线核实」。

---

## 0. 能力矩阵（host × capability）

| 能力 | Claude Code | GitHub Copilot（VS Code agent mode / CLI / coding agent） | AGENTS.md / `.agents` 生态宿主（Codex、Cursor、Amp、Jules 等） |
|---|---|---|---|
| 项目级 skill 目录 | `.claude/skills/`（仅此一个） | `.github/skills/`、`.claude/skills/`、`.agents/skills/` 三个都读 | 多数读 `.agents/skills/`；Cursor 还读 `.claude/skills/`、`.codex/skills/` |
| 个人级 skill 目录 | `~/.claude/skills/` | `~/.copilot/skills/`、`~/.agents/skills/`（Visual Studio 还读 `~/.claude/skills/`） | 多为 `~/.agents/skills/` |
| SKILL.md + YAML frontmatter | ✅ 原生格式（规范的源头） | ✅ 官方支持（2025-12-18 宣布） | ✅ 多数宿主支持（开放规范 agentskills.io） |
| frontmatter 必需字段 | `name`、`description` | `name`、`description` | `name`、`description` |
| `allowed-tools`（skill 级工具白名单） | ✅（另有 `disallowed-tools` 等扩展字段） | ⚠️ 官方文档未列入支持字段；二手资料称被忽略（见 §2.4） | 因宿主而异 |
| skill 内携带脚本/参考文件/资源 | ✅（`scripts/`、`references/`、`assets/` 官方惯例） | ✅（官方定义即「instructions, scripts, and resources」） | ✅ 规范层面允许 |
| 脚本自动执行 | ❌ 不自动执行；由模型经 Bash 工具按 SKILL.md 指示运行，受权限审批约束 | ❌ 不自动执行；由 agent 经 terminal 工具运行，受工具审批策略约束 | 因宿主而异（多数 agent 有 shell 工具时可执行） |
| skill 内调 subagent | ✅（`context: fork` + `agent` 字段；Task 工具） | 无等价 frontmatter；custom agent（`.agent.md`）的 `handoffs` 是另一套机制 | 因宿主而异 |
| 纯 Markdown 指令（不含脚本）可用 | ✅ | ✅ | ✅ |

**矩阵速读**：三方唯一交集 = 「一个含 `SKILL.md`（仅 `name` + `description` frontmatter）+ Markdown 正文」的目录。脚本可携带但**不能假设会被执行**。详见 §4。

---

## 1. Claude Code Agent Skills

### 1.1 目录约定

- 项目级：`.claude/skills/<skill-name>/SKILL.md`（入仓库、团队共享）
- 个人级：`~/.claude/skills/<skill-name>/SKILL.md`（跨项目）
- 插件级：插件内 `skills/<skill-name>/SKILL.md`，以 `plugin-name:skill-name` 命名空间调用
- ⚠️ 未经在线核实（来自 claude-code-guide 训练数据）：name 冲突时项目级覆盖个人级。

来源（官方文档，本次未能直接抓取，URL 为规范入口）：
- https://code.claude.com/docs/en/skills
- https://docs.anthropic.com/en/docs/claude-code/skills （镜像）

### 1.2 SKILL.md frontmatter 规范

必需字段：
- `name`：小写字母/数字/连字符，**≤ 64 字符**，必须与目录名一致（⚠️ 限制值来自训练数据，未经在线核实）
- `description`：**≤ 1024 字符**，需同时说明「做什么」和「何时用」——它是模型决定是否触发 skill 的唯一依据（⚠️ 同上）

可选字段（官方文档列举，训练数据版本，2026 年可能有新增）：
- `allowed-tools`：skill 激活期间生效的工具白名单（如 `Read, Grep, Bash`）
- `disallowed-tools`：反向黑名单（见社区整理 https://agentpatterns.ai/tools/claude/skill-disallowed-tools/）
- `model`、`argument-hint`、`license`、`metadata`
- `disable-model-invocation: true`：只允许用户手动 `/skill-name` 触发
- `user-invocable: false`：从 `/` 菜单隐藏，仅模型可调用
- `context: fork` + `agent`：在 fork 出的 subagent 上下文中运行（见 §1.4）

旁证（官方 repo issue，证明这些字段真实存在且语义在演进）：
- https://github.com/anthropics/claude-code/issues/24975 （IDE 校验器不识别 `allowed-tools`）
- https://github.com/anthropics/claude-code/issues/37683 （`allowed-tools` 未真正限制工具访问的 bug 报告）
- https://github.com/anthropics/claude-code/issues/83981 （自定义 skills 与插件 skills 的 frontmatter schema 差异）

### 1.3 skill 可携带的其他文件与脚本执行机制

- 官方惯例（非强制 schema）：`scripts/`（可执行代码）、`references/`（按需读入上下文的文档）、`assets/`（用于输出的模板/图片，不进上下文）。
- **脚本不会自动执行**。SKILL.md 正文指示 Claude 通过 **Bash 工具**运行（如 `python scripts/validate.py`），受 Claude Code 常规工具权限/审批流程约束，无额外的 skill 级信任机制。
- 渐进式披露（progressive disclosure）三层模型：① 启动时只加载每个 skill 的 `name`+`description`（约 100 tokens）；② 触发时加载 SKILL.md 全文（官方建议 < 500 行 / ~5000 tokens）；③ 捆绑文件仅在指令要求时读取或执行。

来源（Anthropic 官方工程博客，2025-10-16，Barry Zhang / Keith Lazuka / Mahesh Murag）：
- https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills

### 1.4 skill 内 subagent 可用性

- `context: fork` 使 skill 在 fork 出的隔离上下文中运行，`agent` 字段指定 subagent 类型；结果汇总回主对话。
- 未加 fork 时，skill 指令在主对话上下文中展开；此时 Task 工具是否可用取决于 `allowed-tools` 是否放行。
- ⚠️ 以上字段语义来自训练数据 + VS Code 侧文档对同名字段的支持（见 §2.3），未经在线核实 Claude Code 原文。

### 1.5 开放规范

- Anthropic 已将 Agent Skills 作为开放格式发布（规范站 **agentskills.io**），定位类似 MCP 的开放化路线。
- 二手佐证（跨九家 agent 的 SKILL.md 对比）：https://thinkingtokens.ai/2026/03/the-skill.md-wild-west/

---

## 2. GitHub Copilot（VS Code / CLI / coding agent / Visual Studio）

### 2.1 是否有 "skills" 概念？—— 有，且官方兼容 Agent Skills 格式

**是的。** 2025-12-18 GitHub 官方 changelog 宣布 Copilot 支持 Agent Skills，并且**已有的 `.claude/skills` 目录会被自动识别**：
- https://github.blog/changelog/2025-12-18-github-copilot-now-supports-agent-skills/

VS Code 侧随 **v1.108（2025 年 12 月）** 以实验特性落地：
- https://code.visualstudio.com/updates/v1_108
- 新闻报道佐证（实验性）：https://www.infoworld.com/article/4115115/visual-studio-code-adds-support-for-agent-skills.html

### 2.2 skills 存放位置（官方文档）

GitHub Docs「About agent skills」给出的位置表：

| 类型 | 位置 |
|---|---|
| 项目级（随仓库） | `.github/skills`、**`.claude/skills`**、`.agents/skills` |
| 个人级（home 目录，跨项目） | `~/.copilot/skills`、`~/.agents/skills` |

并说明 skills 可用于：Copilot cloud agent（coding agent）、Copilot code review、GitHub Copilot CLI、Copilot app、VS Code 与 JetBrains 的 agent mode。

来源：
- https://docs.github.com/en/copilot/concepts/agents/about-agent-skills

Visual Studio 2026（18.5+）额外读取 `~/.claude/skills`：
- https://learn.microsoft.com/en-us/visualstudio/ide/copilot-agent-skills?view=visualstudio

管理工具：`gh skill`（GitHub CLI v2.90.0+，2026-04-16 public preview），可按宿主自动选择安装目录：
- https://github.blog/changelog/2026-04-16-manage-agent-skills-with-github-cli/

### 2.3 VS Code 对 SKILL.md 的支持细节

官方文档「Use Agent Skills in VS Code」要点：
- skills 在 chat 中以 **slash command** 形式可手动调用（`/`）
- 支持的 frontmatter 控制字段明确列出 **`user-invocable`** 和 **`disable-model-invocation`**（控制「Copilot 自动加载」vs「仅按需手动触发」）
- 目录位置同 §2.2

来源：
- https://code.visualstudio.com/docs/agent-customization/agent-skills
- 教学版：https://code.visualstudio.com/learn/customizations/3-skills

**注意**：VS Code 官方文档列出的 frontmatter 字段中**没有 `allowed-tools`**。

### 2.4 Copilot skill 能否携带并执行脚本？

- 官方定义层面：skills 是「folders of **instructions, scripts, and resources**」（GitHub Docs，见 §2.2 来源）——**携带脚本是官方设计的一部分**。
- 执行机制：skill 自身不运行代码；由 agent 通过终端工具执行脚本。实际约束：
  - agent mode 的终端命令执行受 VS Code 工具审批/auto-approve 策略约束；
  - 已知工程问题：终端「Press any key to continue」会阻塞 agent 自主执行（https://github.com/microsoft/vscode/issues/275605）；
  - 存在工具调用次数上限（255 次）的社区报告（https://developercommunity.visualstudio.com/t/Add-Agent-Skills-for-Copilot/11038989）。
- `allowed-tools`：**二手资料**（SAP 官方 samples 仓库的迁移 skill README）称 Copilot **忽略**该字段；另一篇二手文章称其映射为工具预批准。无官方文档定论，应以「不依赖该字段」为设计前提。
  - https://github.com/SAP-samples/btp-neo-java-app-migration/blob/main/ai-migration/README.md （二手）
  - https://www.spyglassmtg.com/blog/agents-vs.-skills-teaching-your-ai-coding-assistant-to-be-consistently-great （二手）

### 2.5 Copilot 的其他定制文件（与 skills 平行的机制）

- **`.github/copilot-instructions.md`**：仓库级「永远在线」指令，附加到每次请求。
- **`.instructions.md`**（`.github/instructions/`）：可复用指令文件，frontmatter `applyTo`（glob，如 `"**/*.py"`）按文件自动挂载。
- **`.prompt.md`**（`.github/prompts/`）：可复用 prompt 模板，以 `/` 命令调用，支持 `${file}`、`${selection}`、`#codebase` 变量及 mode/model 指定。
- **`.agent.md`**（`.github/agents/`）：custom agent 定义，frontmatter 含 `name`、`description`、`tools`（工具白名单）、`model`、`handoffs`（完成后交接到另一个 agent 的按钮式工作流）；前身为 `.chatmode.md`。
  - ⚠️ 字段清单来自训练数据 + 社区共识；官方文档入口（2026 年站点改版后路径）：https://code.visualstudio.com/docs/agent-customization/ （旧路径 /docs/copilot/customization/custom-agents）

与 skills 的分工（VS Code 官方文档明确对比）：copilot-instructions 是 always-on 的仓库级规范；skills 是**按需加载、跨工具可移植**的任务级能力包。
- https://code.visualstudio.com/docs/agent-customization/agent-skills

---

## 3. ".agent" / agents.md 生态

「.agent 风格宿主」实际包含三个相关但不同的约定：

### 3.1 AGENTS.md（agents.md 标准）

- 定位：「**README for agents**」——仓库根部的单一 Markdown 文件，给 coding agent 提供构建/测试/规范等指引。
- 2025 年 8 月由 OpenAI 牵头（联合 Sourcegraph Amp、Factory 等）发布，规范站为 **agents.md**。
- 采用方（训练数据 + 社区资料，2026 年中仍在扩张）：OpenAI Codex、Amp、Factory Droid、Google Jules、Gemini CLI、Cursor、Aider、Zed 等；GitHub Copilot coding agent 亦支持 AGENTS.md。
- 它是「单文件 always-on 指令」路线，与 SKILL.md 的「目录 + 按需加载」路线互补，不是同一种东西。
- ⚠️ agents.md 站点本次未能直接抓取，以上发布方信息来自训练数据。

### 3.2 `.agents/skills/`（vendor-neutral skill 目录）

- 开放 Agent Skills 生态约定出的**厂商中立**位置：`.agents/skills/<name>/SKILL.md`（项目级）、`~/.agents/skills/<name>/SKILL.md`（个人级）。
- 官方一手证据：GitHub Docs 把 `.agents/skills` 列为 Copilot 项目级读取位置之一，`~/.agents/skills` 列为个人级位置（§2.2 来源）。
- Cursor 官方文档显示其读取 `.cursor/skills/` 并兼容 `.claude/skills/`、`.codex/skills/`、`.agents/skills/`：https://cursor.com/docs/skills
- **Claude Code 不原生读取 `.agents/skills/`**——需要 symlink 或在 CLAUDE.md 中 shim。

### 3.3 `.github/agents/*.agent.md`（Copilot custom agents）

见 §2.5。这是 Copilot 系的「agent 定义」目录，与 skill 目录平行：`.agent.md` 定义「谁在什么工具约束下工作」，`SKILL.md` 定义「按需加载的任务知识」。加载机制：VS Code 扫描 `.github/agents/` 下的 `.agent.md`，出现在 chat 的 agent 选择器中。

（对照：Claude Code 的 subagent 定义在 `.claude/agents/*.md`，机制类似但文件格式不同。）

---

## 4. 交集：一个目录走三家，共同子集是什么？

### 4.1 可以放进行李箱的东西（共同子集）

1. **目录结构**：`<skill-name>/SKILL.md` + 任意附属文件。三家都容忍目录里存在自己不用的文件。
2. **frontmatter 交集 = `name` + `description`**。其余字段（`allowed-tools`、`user-invocable`、`context: fork` 等）都是宿主私有扩展；YAML 容错性好，不认识的字段被忽略，可以写上但**不能把行为押在上面**。
3. **Markdown 正文指令**：纯文本 procedural knowledge 是唯一在所有宿主中都确定生效的内容。
4. **携带脚本/模板/参考文件**：规范与各家官方文档都允许携带；被读取（Read）也基本可行。

### 4.2 不能假设的东西

- **脚本执行不可假设**。没有任何宿主会「自动运行」skill 里的脚本；执行总是经过宿主的 shell/terminal 工具 + 各自的审批策略。无 shell 工具的宿主（或受限审批模式）下脚本就是死重。
- **skill 级工具白名单不可假设**（Copilot 对 `allowed-tools` 无官方承诺）。
- **subagent / 上下文隔离不可假设**（`context: fork` 是 Claude Code 私有；`.agent.md` 的 handoffs 是 Copilot 私有）。
- **目录位置没有真正的三方统一路径**：
  - 项目级最优点位是 **`.claude/skills/`**——Claude Code 原生读取，且 Copilot 全家族（VS Code、CLI、coding agent、Visual Studio）官方承诺自动识别；但 AGENTS.md 系宿主（Codex、Amp 等）不读它。
  - `.agents/skills/` 覆盖 Copilot + Cursor + 多数中立宿主，但 Claude Code 不读。
  - 实操方案：仓库内放 `.claude/skills/` 为唯一真源，用 symlink（或 `gh skill install` / `npx skills add` 等安装器）向 `.agents/skills/` 投影；个人级同理（`~/.claude/skills` ↔ `~/.agents/skills`）。

### 4.3 优雅降级（graceful degradation）模式

1. **SKILL.md 正文自包含**：把脚本能做的事同时用自然语言步骤写全，脚本只作为「如果可执行则更快/更确定」的加速器。推荐写法：「优先运行 `scripts/xx.py`；若当前环境无法执行脚本，按以下步骤手动完成：…」。
2. **脚本双形态**：同时提供 `.sh` 与 `.ps1`（或纯 Python，尽量无第三方依赖），因为 Copilot coding agent 跑在 GitHub-hosted Ubuntu runner，而本地 Windows 宿主默认 PowerShell。
3. **确定性内容放 `references/` 而非 `scripts/`**：查表、模板、检查清单用 Markdown 表达，任何宿主都能 Read。
4. **frontmatter 只写交集字段 + 注释**：`name`、`description` 必写；其余字段以注释或附带文档说明「在 Claude Code 下还会启用 allowed-tools」。
5. **description 即触发器**：三家都靠 description 做自动触发决策，把它当作跨宿主唯一可靠的「路由入口」来写（做什么 + 何时用）。

### 4.4 时效性备忘

- Copilot 的 skills 支持 2025-12 以实验特性起步（VS Code 1.108），2026 年上半年快速演进（`gh skill` 2026-04 public preview）；`allowed-tools` 语义、读取目录清单随时可能扩大，落地前应复查 docs.github.com 与 code.visualstudio.com 当前版本。
- Claude Code 的 SKILL.md 字段（`context: fork`、`disallowed-tools` 等）2026 年仍在增加，且自定义 skills 与插件 skills 存在 schema 差异（anthropics/claude-code#83981）。

---

## 附：主要引用来源清单

一手 / 官方：
- https://code.claude.com/docs/en/skills （未能抓取，官方入口）
- https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills
- https://github.blog/changelog/2025-12-18-github-copilot-now-supports-agent-skills/
- https://github.blog/changelog/2026-04-16-manage-agent-skills-with-github-cli/
- https://docs.github.com/en/copilot/concepts/agents/about-agent-skills
- https://code.visualstudio.com/docs/agent-customization/agent-skills
- https://code.visualstudio.com/learn/customizations/3-skills
- https://code.visualstudio.com/updates/v1_108
- https://learn.microsoft.com/en-us/visualstudio/ide/copilot-agent-skills?view=visualstudio
- https://learn.microsoft.com/en-us/training/modules/github-copilot-code-agent/2-security-risks-limitations-copilot-code-agent/
- https://cursor.com/docs/skills
- https://github.com/anthropics/claude-code/issues/24975 、/issues/37683 、/issues/83981
- https://github.com/microsoft/vscode/issues/275605

二手（仅作佐证，文中已标注）：
- https://thinkingtokens.ai/2026/03/the-skill.md-wild-west/
- https://github.com/SAP-samples/btp-neo-java-app-migration/blob/main/ai-migration/README.md
- https://www.spyglassmtg.com/blog/agents-vs.-skills-teaching-your-ai-coding-assistant-to-be-consistently-great
- https://agentpatterns.ai/tools/claude/skill-disallowed-tools/
