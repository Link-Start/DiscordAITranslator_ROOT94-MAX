# 开发与贡献指南

本文说明怎样修改模块化源码、验证插件和交付变更。安装与使用请看[产品介绍](README.md)。

<a id="requirements"></a>

## 环境要求

- Node.js 20 或更新版本
- 已安装 BetterDiscord 的 Discord 或 DiscordPTB
- BetterDiscord 中已安装 BDFDB Library

<a id="development-workflow"></a>

## 日常开发流程

每次任务沿用同一个小循环。修改者负责代码、针对性证据和文档更新；审查者检查最终差异及尚未验证的范围。

1. **定位：** 阅读[文档入口](docs/README.md)、相关源码和对应的有效[设计笔记](.agents/notes/README.md)。只读本次任务所需主题；搜索隐藏的笔记目录时使用 `rg --hidden`。
2. **修改：** 运行时缺陷先用针对性回归复现；新功能先写清可以观察的验收结果。一次处理明确范围的变化。测试若加载生成插件，应先构建，避免旧产物掩盖结果。
3. **验证：** 先运行针对性检查，再运行 `npm run verify`。涉及 Discord 渲染或生命周期时，按授权收集客户端证据；可选的 [Discord MCP 手册](docs/cookbook/discord-mcp.zh-CN.md)说明工具发现、连接检查及前后对比。缺少现场观察必须明确说明；验证失败后回到这一步处理，不增加一层流程文档。
4. **记录：** 更新受影响的所属文档和相关决策笔记。检查差异、独有理由、隐私及回滚限制，将验证后的修改提交到工作分支。合并、发布或部署遵循用户当前授权。

| 变更类型 | 需要更新什么文档 |
| --- | --- |
| 错别字、机械调整或不改变约定的局部修改 | 修正所属文字或代码，无需新笔记 |
| 缺陷修复 | 增加针对性回归并更新行为说明；形成长期决策时更新或新增笔记，事故有可复用原因和证据时才写复盘 |
| 功能、行为、兼容性、架构、工具或测试策略变化 | 更新相关笔记；未确定的方案写 proposed，落实后以 implemented 记录实际决策 |
| 简化 | 提议删除前先核对生产调用者、配置/数据/兼容边界和测试，保留仍需维持的行为及理由 |

这里采用 DSH 的命名和职责划分原则，无需额外运行时或必装命令套件。使用仓库自己的 Node.js 检查和模板；不要每轮都新增技能、自动化、双语笔记副本或额外审批。只有具体问题反复发生时才调整规则。

<a id="commands"></a>

## 常用命令

```powershell
npm run build        # 从 src/ 重新生成 DiscordAITranslator.plugin.js
npm run build:check  # 确认已提交插件与重新构建的结果一致
npm run check        # 检查生成插件的语法
npm test             # 检查源码与产物一致性，再执行全量测试
npm run test:node    # 局部源码修改后直接运行 Node 测试
npm run check:notes  # 检查笔记结构、有效链接、冻结归档和 Git 基线
npm run verify       # 公开文件、笔记、构建、语法和全量测试
```

运行单个测试文件：

```powershell
npm run build:check
npm run test:node -- tests/channel-primary-engine-regression.test.js
```

`npm test` 会在测试加载生成插件前检查确定性构建是否一致。只修改源码时，可用 `npm run test:node -- tests/<file>.test.js` 做局部失败/通过验证；如果测试实例化 `DiscordAITranslator.plugin.js`，必须先重新构建。

<a id="documentation-and-agent-notes"></a>

## 文档与设计笔记

根 README 是面向 GitHub 读者的完整产品介绍，依据版本实际的安装和使用方式编写。保持中英文一致，示例使用合成内容。详细当前行为放在所属文档；[设计与经验笔记](.agents/notes/README.md)解释决策理由。两者都不收录会话记录或原始私人证据。

非平凡的行为、架构、验证或流程变化，需要更新相关有效笔记或提出 proposed 笔记。只有决策实际成立后才转为 implemented，以实际影响替换执行计划。普通编辑可在 PR 中说明无需笔记。归档前先把独有的当前约束保留到后继文档，更新有效入站链接；冻结历史及其既有哈希之后不能再改写。

复核已提交分支时，将 `AGENT_NOTE_ARCHIVE_BASE_REF` 设为变更前提交。本地未提交修改默认对照 HEAD；CI 使用 PR 基线或 push 前提交。不能用新 HEAD 证明它自己的归档变化没有问题。

代码简化需要生产调用证据和保留行为的测试。默认关闭、旧名称或一次静态搜索无命中，都不足以删除兼容分支或实验边界。文档维护本身不授权部署插件或合并分支。

<a id="release-metadata"></a>

## 发布元数据

`src/plugin/metadata.json` 是 BetterDiscord 文件头元数据（含 `@version`）的唯一来源，构建时复制到 `DiscordAITranslator.plugin.js`。`package.json`、`package-lock.json` 根条目、两份 README、`CHANGELOG.md` 和发布契约测试中的版本应与其一致。打标签或上传版本前重新构建，再核验产物的 `@version`、`@buildId` 和 SHA-256。

分发插件的元数据描述使用英文，并通过 `@authorLink`、`@website` 或 `@source` 包含项目仓库链接。

<a id="deployment"></a>

## 部署到本机客户端

开发时安装的插件通常位于：

```text
%AppData%\BetterDiscord\plugins\DiscordAITranslator.plugin.js
```

替换之前：

1. 将已安装文件复制到仓库外的备份位置。
2. 把验证过的运行产物复制到 BetterDiscord 插件目录。
3. 比较 SHA-256 哈希。
4. 在 DiscordPTB 中确认版本和基本行为。

不要把部署备份提交到仓库。

<a id="publication"></a>

## 公开发布

发布前阅读[脱敏与发布指南](docs/publication.md)。原始证据留在 Git 外。`npm run check:publication` 检查公开文件类型、文档链接和常见隐私风险；独立的隐私工作流使用 Gitleaks 扫描完整可达 Git 历史。新增一次清理提交无法消除祖先提交中的私人数据。
