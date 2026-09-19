# 设计与经验笔记（Agent Notes）

这里是唯一的 Agent Notes 库，保留长期有用的设计理由、失败路线和验证边界。产品说明在[根 README](../../README.md)，当前事实按[文档入口](../../docs/README.md)导航。

采用 DSH 官方的目录、命名和核心格式，并保留适合本项目的轻量检查。无需安装 DSH、复制它的技能库或使用它的包管理器。有效笔记的主题和正文默认中文；不强制双语副本、翻译侧车文件、看板或集中逐篇索引。`References` 是本项目保留的证据链接小节。

## 何时记录

固定字段沿用 DSH 格式：`Status` 是状态；`Problem` 是问题；`Proposal` 是方案；`Decision` 是已作出的决策；`Alternatives considered` 是考虑过的其他方案；`Acceptance criteria` 是验收标准；`Risks` 是风险；`Consequences` 是实际影响；`References` 是依据与链接。字段下的正文用中文填写。

影响行为、模块边界、兼容约束、验证方法或协作流程的非平凡变化，先查找并更新相关笔记；有新决策时再新增。错别字、等价整理和普通维护不要求凑一篇笔记，在 PR 说明不需要的原因即可。不得把每次会话、测试轮次或进度都追加为长期文档。

## 目录与命名

`<状态>/<类别>/YYYY-MM-DD-short-topic.md`，主题和正文用中文，标题前缀和固定字段沿用模板。只创建实际用到的目录，不建立手工逐篇索引。

| 状态 | 用途 |
| --- | --- |
| `proposed` | 问题、证据、方案、验收与风险；尚未授权的代码方案明确保持提案状态 |
| `implemented` | 已成立的决策和代价；随实现修正事实，不堆叠未来任务 |
| `rejected` | 未采用的提案及拒绝理由，防止重复试错 |
| `archived` | 已退出当前约束的 implemented 历史快照，冻结字节和哈希 |

类别为 `feature`（功能）、`bug-fix`（缺陷修复）、`simplification`（简化）、`architecture`（架构）、`process`（流程）、`testing`（测试）。日期用可追溯的首次记录日期；无法确认时用首次整理日期，并注明历史来源和未知范围。日期不是伪造的上线证明。

| 模板 | 必需二级标题（Problem 置首，其余建议按模板顺序） |
| --- | --- |
| [提案模板（Proposed）](../templates/agent-note-proposed.md) | Problem、Proposal、Alternatives considered、Acceptance criteria、Risks、References |
| [已落实模板（Implemented）](../templates/agent-note-implemented.md) | Problem、Decision、Alternatives considered、Consequences、References |
| [未采用模板（Rejected）](../templates/agent-note-rejected.md) | Problem、Proposal、Alternatives considered、References；保留原提案的其他章节 |

首行 `# Agent Note: 主题`，空行，第三行 `Status: proposed`、`Status: implemented` 或 `Status: rejected — 简短拒绝原因`，空行后进入正文。每节有实质内容；References 使用可定位的文件或公开来源链接。未知的历史备选方案直接说明未记录，不补写假历史。

## 查找与流转

1. 从所属领域文档出发，再用 `rg --files --hidden .agents/notes` 和 `rg -n --hidden "主题词" .agents/notes/implemented` 查相关决策；阅读历史时再查 rejected/archived。无需每次读完整笔记库。
2. 新方案先写 proposed；明确范围和验收后按已有授权实施，不从文档模板推导额外审批。
3. 落实后移动到 implemented，修改 Status，将计划和验收清单改为实际 Decision、Consequences 与证据。放弃则移动到 rejected，在 Status 写原因，保留原提案。已作出的决策可以直接记录为 implemented。
4. 部分被替代时保留活动笔记并互相链接；反转决策另写新笔记。完全被替代时先核对独有理由已被保留，再归档。

## 冻结归档

只归档 implemented。先记录变更前的提交：`git rev-parse HEAD`。迁入 `archived/<类别>/` 时保留笔记日期、`Status: implemented` 和正文，在 Status 下一行增加 `Archived: YYYY-MM-DD`，再空一行。如需改写正文或补引用，在进入归档前完成。过时的 proposed 应转为 rejected；rejected 只在拒绝理由仍有价值时保留。

`archive-manifest.json` 的 `version` 为 1，`files` 用相对本目录的归档路径映射文件原始字节的 SHA-256 小写值。只为新归档追加项；现有文件、路径和哈希不变。使用仓库 LF 换行，避免操作系统转换字节。

`npm run check:notes` 本地默认对照 HEAD；提交后复核应设置 `AGENT_NOTE_ARCHIVE_BASE_REF` 为变更前提交。CI 对 PR 使用 base SHA、普通 push 使用 before SHA，显式历史不可用时失败。首次 push 使用已有根提交作为基线，不以新的 HEAD 自证归档未变。

归档仍接受隐私扫描、路径、元数据和哈希检查；正文保留封存时的格式，历史出站链接允许失效。活动文档指向归档的链接必须存在。归档不是当前行为的权威，也不是绕过脱敏的储藏室。确有隐私泄露需要改写历史时，另按[发布流程](../../docs/publication.md)处理。

从旧 `docs/adr/` 迁移时，已封存文件和清单原始字节保持不变。检查器同时读取变更前提交中的旧、新根目录，按相对归档路径延续冻结约束；目录改名不会重新建立空白基线。工作树只允许新目录存在。

## 去噪与复核

整理前列出重复事实和唯一信息，整理后逐项核对理由、限制、失败路线和未关闭事项的去向。当前事实只有一个维护位置；笔记说明为什么，其他文档链接过去。检查脚本不判断语义真假，审查要补上这一层。

代码简化提案必须区分生产调用者、仅测试/文档引用和动态行为未确认三类证据。默认关闭、名称含 legacy、一次静态搜索无命中都不足以删除兼容分支或实验边界。文档整理本身不授权运行时代码改动。

日常迭代流程和任务规模判断见[贡献指南](../../CONTRIBUTING.md#development-workflow)。优先更新已有说明，只有出现新的长期决策才增加文件；归档按内容失效触发，不设定期清理或删减数量指标。

## 参考来源

采用 DSH 的按需阅读、事实归属和笔记生命周期思想，按本仓库的 BetterDiscord 发布约束实现；没有引入额外笔记系统或运行时依赖。

- [DSH 官方文档规则（固定版本）](https://github.com/deepseek-ai/deepseek-harness/blob/0d1f50007f9bca3f52b06e1c3074fa14d5fb0720/docs/AGENTS.md)
- [DSH 官方 Agent Notes（固定版本）](https://github.com/deepseek-ai/deepseek-harness/blob/0d1f50007f9bca3f52b06e1c3074fa14d5fb0720/.agents/notes/README.md)
- [DSH 官方简化调查方法（固定版本）](https://github.com/deepseek-ai/deepseek-harness/blob/0d1f50007f9bca3f52b06e1c3074fa14d5fb0720/.agents/skills/dsh-find-simplifications/SKILL.md)
- [社区实践项目（固定版本）](https://github.com/czm15053/write-notes-like-deepseek/tree/2aef219faf608285f987a85d3f5f1109d6699725)：参考格式与归档校验思路，本仓库独立实现最小 Node.js 检查。
