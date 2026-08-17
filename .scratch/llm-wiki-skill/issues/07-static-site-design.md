# Wiki 静态可视化站点设计

Type: grilling
Status: resolved
Blocked by: 03

## Question

设计需求 5 的静态 HTML 站点(用户已定静态、无常驻进程):包含哪些视图(页面目录、wikilink 图谱、时间线/来源分布?)、由谁生成(agent 现场生成 vs 脚本)、生成时机(治理后自动?手动触发?)、技术形态(单文件 HTML?无依赖图谱渲染?)、与裁决 HTML 报告是同一站点还是分开。

## Answer

**用户拍板:站点与裁决报告分开为两个产物** —— 裁决报告 = 治理 run 末生成的独立单文件 HTML;站点 = 纯 wiki 可视化。

**站点形态**:生成到 `<kb>/.kb/site/`(派生物、可重建、gitignore),双击 index.html 即开,零常驻。

**四视图(用户调整:去掉裁决视图,换成历史记录)**:
- **浏览** — wiki 页按页型分组,可按 issue_type/tag/来源筛选;单页看渲染正文+frontmatter+溯源链。
- **图谱** — wikilink 关系图;零依赖手写 SVG+力学布局(500 节点内流畅,超出降级邻接列表);数据 JSON 嵌 HTML 单文件可拷走;**index.md 万能链接不进图**(防星形退化),语义边从 sources: frontmatter 派生。
- **历史记录** — decisions.jsonl + log.md 的时间线:每次裁决/治理动作(谁、何时、对哪页、什么动作、理由)。
- **概览** — 页型统计、run 历史、孤立页/悬空链健康指标。

**生成**:render 脚本一次生成全站;手动触发("生成站点")为主,治理 run 末 agent 提醒可一键生成。无脚本降级 = agent 按模板生成浏览+历史记录两个核心视图,图谱跳过。
