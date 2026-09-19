# Agent Note: 从模块化源码生成单个可安装插件

Status: implemented

## Problem

原 ADR-0002 于 2026-07-13 记录时，手工维护的插件约 10,700 行、618 KB。翻译策略、传输、队列、设置、持久化、Discord 补丁、显示状态和清理挤在同一文件中，不利于明确职责、可靠构建检查和安全移除已替代代码。

[早期稳定性决策](../../archived/architecture/2026-07-12-keep-single-file-runtime.md)曾推迟构建系统变化，避免把架构回归与分发故障混在一起。反复出现的显示回归，以及局部调整供应商/队列/设置的需要，推动项目改用模块化源码，同时保留原安装方式。

## Decision

在 `src/` 中维护可读源码，通过 esbuild 确定性生成根目录的 `DiscordAITranslator.plugin.js`。BetterDiscord 用户只安装该产物，无需安装源码模块或运行时依赖。

构建保留元数据和兼容的 CommonJS 输出。发布产物排除测试、本机诊断、源码映射、凭证和开发配置。同样的源码及锁文件输入应产生相同字节；已提交产物过期时，验证必须失败。

## Alternatives considered

继续手工维护单一分发文件会保留职责耦合。改变面向用户的运行时包装方式，会破坏直接下载安装的约定；此前推迟构建改造也说明，包装和运行行为需要分别验证。历史记录没有记载其他打包器的对比，不补造比较结论。

## Consequences

开发者修改源码而非打包产物，模块接口成为可独立测试的边界。每次迁移仍产生一个可安装文件；源码提取逐步进行，替代产物通过自动检查及相关 DiscordPTB 观察前，不删除被替代的运行时代码。构建依赖和锁文件需要持续审查与维护。

## References

- [模块架构说明](../../../../docs/architecture.zh-CN.md)
- [构建实现](../../../../scripts/build-plugin.mjs)
- [源码与产物测试入口](../../../../tests/test-entry-contract.test.js)
- [开发、构建和交付命令](../../../../CONTRIBUTING.md)
