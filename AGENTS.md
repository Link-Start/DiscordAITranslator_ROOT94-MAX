# 项目协作指引

DiscordAITranslator 从模块化源码生成一份可安装的 BetterDiscord 插件。先读[文档入口](docs/README.md)，再按本次任务阅读相关文档。

- 在 `src/` 中修改运行时代码，用 `npm run build` 重新生成 `DiscordAITranslator.plugin.js`。
- 保持频道隔离、Discord 原始记录不可变、有界重试、实时消息优先和用户滚动意图优先。模块职责见[架构说明](docs/architecture.zh-CN.md)。
- 行为变化先跑针对性测试，再跑 `npm run verify`。涉及 Discord 渲染或生命周期的改动还需客户端冒烟验证。
- 排查 Discord 客户端时，按需阅读 [Discord MCP 调试手册](docs/cookbook/discord-mcp.zh-CN.md)：发现当前工具、核验实际目标，再按任务授权收集必要证据。
- 当前行为维护在其所属文档中，长期设计理由记录在[设计与经验笔记（Agent Notes）](.agents/notes/README.md)。不要向当前入口追加会话流水账或旧测试总数。
- 使用合成测试数据。凭证、私人聊天、原始跟踪、截图、本机路径和部署备份留在 Git 外，具体见[脱敏与发布指南](docs/publication.md)。
- `AGENTS.local.md` 已被忽略，可存放个人指令；本文件只保存项目共享规则。
