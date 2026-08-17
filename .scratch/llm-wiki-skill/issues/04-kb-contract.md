# KB 目录契约:沿用 Weft 还是轻量重设计

Type: grilling
Status: resolved
Blocked by: 02, 03

## Question

设计 skill 场景下的 KB 目录契约:raw/ 与 wiki/ 的结构、frontmatter 字段(身份、状态)、页型(是否保留 entities/concepts/syntheses 四型)、候选状态机(哪些操作必须人类裁决)、wiki/index.md 作为检索入口的格式。在"沿用 Weft 契约"与"轻量重设计"之间抉择,给出完整契约草案(目录树 + frontmatter 规范 + 状态机)。输入:Weft 调研结论与运行时架构决策。

## Answer

**采用裁剪版 Weft 契约**(完整目录树见下),相比原契约的调整与定稿:

**目录树:**
```
<kb>/                              ← 必须是 git 仓库(init 含 git init)
├── kb.json                        # 非敏感配置;密钥只存环境变量名
├── GOVERNANCE.md                  # 用户治理简报,注入每个治理 prompt
├── raw/                           # 证据层,保留源语言
│   ├── jira/<issue-key>.md        # 扁平目录;issue_type 记 frontmatter(类型会变更,不进路径)
│   ├── confluence/<page-id>.md
│   ├── chat/conv-<hash8>.md
│   └── local/<slug>.md
├── wiki/                          # 策展层,主语言默认英文(kb.json 可配)
│   ├── index.md                   # 检索 Tier 0,每次治理运行末重建
│   ├── sources/<slug>.md
│   ├── syntheses/<slug>.md
│   ├── concepts/<slug>.md         # 用户拍板:四页型全保留
│   ├── entities/<slug>.md         # 含实体关系
│   └── archive/                   # 冻结记录,检索不可见
├── .kb/govern/                    # 裁决记忆
│   ├── source-tombstones.json
│   ├── conflict-dismissals.json
│   └── decisions.jsonl            # human 必填理由;agent 的先例 few-shot 源
└── log.md                         # append-only 审计日志
```

**继承的 Weft 规则(原样)**:身份五元组 + content_hash 增量(重拉 hash 相同即跳过;版本嵌入被 hash 正文);slug/文件名白名单正则;candidate 四态状态机 + 风险分级(增量可逆自动 approved,矛盾/重复/合并/归档强制 candidate);检索只见 approved;wikilink `[[slug|display]]`;merge 仅 approved 双方+机械重写 backlink;reject-and-restore(依赖 git)。

**相比 Weft 砍掉**:SQLite 索引、写权限矩阵(→SKILL.md 红线)、sweep 对账(→治理第一步归档 rejected)、门户一切、conflicts.json 指纹机制。

**关键决策记录:**
- 页型四型全保留(source/synthesis/concept/entity)——用户语料是概念密集型技术文档,entity 关系保留。
- Jira issue_type 放 frontmatter 而非路径:类型可变更,路径=source+source_id 必须稳定保证幂等;类型信息供治理选摘要模板、站点分组浏览。
- wiki 主语言默认英文(混语言削弱概念/实体合并质量),kb.json 可配。
- KB 必须是 git 仓库,不可降级。
