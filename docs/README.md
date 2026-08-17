# llm-wiki 教学目录

> **📖 阅读体验版：双击打开 [`index.html`](index.html)——全部内容已汇成单文件 HTML 手册（目录导航/双轨选读/阅读进度）。**

> **本文档对应 skill v1.2 / KB contract_version 1(2026-08)。**
> 若 CHANGELOG 出现了更高版本而本文未更新，请以 `llm-wiki/SKILL.md` 与 `spec/spec.zh-CN.md` 为准，并提醒维护者同步本目录。

## 30 秒看懂这是什么

**llm-wiki 是一个 Claude Code / Copilot skill，把散落在各处的知识——对话、Jira、Confluence、仓库 wiki——治理成一个可检索、可裁决、可演化的个人 wiki 知识库（KB)。**

它解决的核心问题：LLM 会话是健忘的。今天讨论清楚的设计决策，下周的新会话就忘了；Jira 和 Confluence 里的口径互相矛盾，没人记得以哪个为准。llm-wiki 的做法：

1. **拉进来**——对话蒸馏、连接器拉取，统一成带完整来源元数据的 raw 文档；
2. **治理成页面**——自动消化成四类 wiki 页面，有风险的改动不静默落盘，而是变成"候选"等你裁决；
3. **读出来**——纯 agent 迭代检索（无搜索引擎），每个结论带引用，每个引用机器校验。

整个系统的信任哲学一句话：**自动化优先，但拿不准的一定停下来问你（fail-closed)**。

## 你是谁 → 走哪条轨

| 你的情况 | 路径 |
|---|---|
| 我想**用**这个 skill 管自己的知识 | 👉 [使用者之旅](user-journey/01-这是什么.md)(6 章，主线约 15 分钟读完，每章末尾有"动手试试") |
| 我想**改/维护/扩展**这个 skill | 👉 [开发者之旅](dev-journey/01-架构总览.md)(6 章，建议先快速翻过使用者之旅 01/04 章建立直觉） |
| 我只是路过想看看 | 读 [使用者之旅 01-这是什么](user-journey/01-这是什么.md) 即可 |

## 目录地图

```
docs/
├── README.md                  ← 你在这里
├── user-journey/              使用者之旅
│   ├── 01-这是什么.md          问题、方案、全流程一张图
│   ├── 02-装起来.md            安装 skill、初始化 KB、环境变量
│   ├── 03-第一次使用.md        蒸馏一段对话 → 第一篇 wiki 页面诞生
│   ├── 04-日常循环.md          拉取 → 治理 → 裁决的日常节奏
│   ├── 05-读出来.md            静态站点 + 检索/深研
│   └── 06-路线图.md            Jira/Confluence:spec 已定义、尚未实战
└── dev-journey/               开发者之旅
    ├── 01-架构总览.md          SKILL.md 路由 + scripts/prompts/templates 代码地图
    ├── 02-KB契约导读.md        spec 的阅读顺序与页面类型全景
    ├── 03-fold机制.md          v1.1 核心设计:增量折叠为什么取代截断
    ├── 04-治理与候选状态机.md   裁决回环、sidecar 候选、.kb/govern/ 裁决记忆
    ├── 05-实战故事.md          一次真实的 ADR 编号冲突治理(Weft 项目,脱敏)
    └── 06-测试与扩展.md        测试地图、已知问题、如何加 connector/prompt
```

## 项目内其他文档的分工

| 文档 | 读者 | 作用 |
|---|---|---|
| `docs/`(本目录） | 人 | 教学：为什么、怎么上手、怎么读代码 |
| `llm-wiki/SKILL.md` | LLM(agent) | 运行时规范：skill 被触发后 agent 照做的唯一权威路径 |
| `spec/spec.zh-CN.md` / `spec.en.md` | 实现者 | 设计契约：字段表、规则编号，详细到实现者无需追问 |
| `llm-wiki/CHANGELOG.md` | 所有人 | 版本历史与破坏性变更迁移说明 |
| `CONTEXT.md` | Claude 会话 | 项目术语表（ubiquitous language) |

本目录**不复述契约细节**——凡涉及字段定义、规则编号处，一律链接 spec 对应小节，spec 是唯一权威来源。
