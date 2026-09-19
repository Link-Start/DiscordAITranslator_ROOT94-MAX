# 文档入口：按问题查找

[产品介绍与安装（中文）](../README.md) | [Product introduction (English)](../README.en.md)

## 按问题定位

常用说明以中文为主。英文文件名用于保持链接稳定，下面的中文名称说明每份文档的用途。

| 你想了解什么 | 应该看哪份文档 |
| --- | --- |
| 插件有什么功能，怎样安装和开始使用 | [产品介绍与安装](../README.md) / [English](../README.en.md) |
| 开关频道、实时翻译、历史翻译应该怎样工作 | [功能与行为说明](product.md) |
| 全局与频道设置分别管什么，旧配置怎样迁移 | [设置说明与配置迁移](settings.md) |
| 翻译服务怎样接入，请求和响应有什么要求 | [翻译服务接口约定](providers.md) |
| 项目有哪些模块，修改应放在哪个模块 | [模块架构说明](architecture.zh-CN.md) / [English](architecture.md) |
| 怎样确认构建版本、复现并定位问题 | [故障排查指南](cookbook/debugging.zh-CN.md) / [English](cookbook/debugging.md) |
| 怎样用 MCP 检查 Discord、排查连接、验证修复 | [Discord MCP 调试与复现](cookbook/discord-mcp.zh-CN.md)（可选开发工具） |
| 以前为什么会出现重绘和输入框问题 | [重绘与输入框问题复盘](postmortem/translation-repaint-and-composer.md) |
| 还有什么需要验证，哪些工作暂缓 | [已知限制与待验证事项](recovery-plan.md) |
| 为什么这样设计，哪些方案曾被否决 | [设计与经验笔记（Agent Notes）](../.agents/notes/README.md) |
| 怎样修改源码、构建、测试和交付 | [开发与贡献指南](../CONTRIBUTING.md) |
| 上传 GitHub 前怎样脱敏和检查历史 | [脱敏与发布指南](publication.md) |
| 发现安全漏洞后怎样私下反馈 | [安全问题反馈](../SECURITY.md) |
| 提交问题和参与讨论时遵循什么规则 | [社区行为准则](../CODE_OF_CONDUCT.md) |
| 各版本新增、修复或移除了什么 | [版本更新记录](../CHANGELOG.md) |

日常使用先看产品介绍；修改代码再看相关功能、架构和开发指南；遇到问题再打开排查文档。无需每次通读全部文档。

## 维护边界

每个事实只在所属文档维护，其他入口用链接引用。操作方法进入调试手册；具体事故进入复盘，说明证据来源和局限；长期决策进入设计与经验笔记。目录只在存在真实内容时创建，短文无需再拆层级。

根 README 保持完整产品说明。当前文档不堆叠阶段完成记录、历史构建号、测试计数或机器安装记录；版本和构建以源码元数据、产物和实际客户端分别核验。源码树身份不等于客户端正在运行的身份。

原始日志、响应、真实聊天截图和私有工作记录保存在仓库外。唯一保留的 `artifacts/ui-redesign-draft.html` 是设置样式测试使用的合成原型。

编辑遵循[文档维护规则](AGENTS.md)，笔记遵循[笔记维护规则](../.agents/notes/AGENTS.md)。根 AGENTS.md 上限 80 行，本文上限 100 行；其他技术 Markdown 上限 400 行、32,000 字符。超限先按问题拆分，不按配额删除独有约束。

`npm run verify` 集中运行公开文件、笔记、构建和测试检查。结构检查不能证明语义正确或现场验收通过。
