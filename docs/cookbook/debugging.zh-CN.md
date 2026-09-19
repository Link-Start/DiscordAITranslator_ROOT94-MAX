# 调试操作指南

[English](debugging.md)

按本指南确定故障边界，并收集足以建立针对性回归的证据。当前行为以主题文档和实际构建为准；历史原因由[重绘问题复盘](../postmortem/translation-repaint-and-composer.md)维护，历史现场结论不能自动代表另一台客户端已经通过验证。

## 先确认身份与证据

1. 记录仓库提交、插件头部版本/build ID，以及构建文件和安装文件的 SHA-256；不要只比版本号。
2. 从客户端只读诊断确认插件启用及内存实例身份。文件一致不证明热重载成功；接入失败时明确记录“未核验内存实例”。
3. 先确定故障位于连接/HTTP、响应结构、内容校验、显示提交中的哪一层。缓存可见不能证明供应商可连接，外层 fallback 错误不能替代底层证据。
4. 固定原文、发送片段、原始返回、校验与最终结果的对应关系；公开回归使用合成样本。连接方式见 [MCP 指南](discord-mcp.zh-CN.md)。

源码版本以 [metadata](../../src/plugin/metadata.json) 为源，实际产物头部包含构建号。在仓库根目录执行：

```powershell
npm run build:check
Select-String -Path DiscordAITranslator.plugin.js -Pattern '@version|@buildId'
Get-FileHash DiscordAITranslator.plugin.js -Algorithm SHA256
```

另行比较安装文件，并在可接入时核验内存实例。版本或磁盘文件相同不证明已公开发布或成功加载；本次核验记录留在 Git 外，不在文档中积累构建号快照。

## 显示与 Composer 隔离

### 检查 Composer 隔离

翻译结果只刷新挂载消息和回复宿主的 Store revision，确认失败仍有界重试；频道或供应商切换只发一次带锚点投影。胶囊状态变化不能驱动聊天列表重绘。

先保留缓存检查热路径以隔离显示变量；获得清理缓存授权后，再只清 `translationCache` 验证冷路径，不能同时清设置、凭证和频道状态。插件启停和全局设置重初始化属于宿主生命周期，输入框仍可能短暂刷新，不能据此宣称翻译行刷新导致整区重建。

### 快速定位

| 现象 | 先核对 | 保持的边界 |
| --- | --- | --- |
| 译文出现时输入框闪烁 | 是否混入生命周期或整区重挂载 | 不恢复同步清空/重挂载，不强制更新无 updater 的合成实例 |
| 上滚时跳回底部 | 读者锚点、最新滚动意图、延迟显示门 | 用户新手势可否决恢复，禁止无条件延迟写偏移 |
| 胶囊完成但译文未出现 | 挂载行 revision、待显示状态、离屏结果能否挂载即显示 | 供应商完成不等于显示就绪 |
| 累计比例变成单批比例 | 频道/任务世代和唯一消息 ID | 重试去重；计数累计，计时只属于当前工作轮次 |
| 显示重试调用供应商 | 失败类型是否归错 | 显示失败只用已有译文做定向重绘；翻译失败走原翻译策略 |
| 关闭后还在转圈 | 当前任务终态与频道恢复事务 | 等待图标跟随任务；恢复也覆盖没有结果的历史等待行 |
| 转发消息为空或有两份原文 | 快照正文和显示所有者 | 快照感知提取、克隆、绘制和恢复共用路径，不改 Store 原对象 |
| new_only 翻译了旧消息 | 首次遍历前是否冻结频道消息边界 | 空流无边界时不结束初始化，不用历史胶囊掩盖分类错误 |

## 响应、校验与延迟

- `root-malformed` 是本地分类，不能仅凭汇总就断言模型返回了坏 JSON。对照实际响应与已发送 ID。
- 同一消息的多行只在已知、互不重叠、非空片段合并后完整时归并；未知、冲突或缺项保持修复，不按顺序猜编号。
- 版本标签和 HTTP 操作标识仅在有本地结构/保护证据时保留；普通英文、`tag`、短词不能因此一律通过。保留原文不等于翻译成功。
- 完整句意和强调位置一起检查。标记齐全或某个片段含中文，不证明语义正确。
- 先回放固定响应，再用同输入、模型、设置作接口比较。分别记录补译消息数、物理请求数与耗时；少补一条不一定少一个请求，少 token 不等于端到端更快。
- 保留 P3 软校验和默认关闭的实验策略，见 [校验边界](../../.agents/notes/implemented/architecture/2026-09-17-validation-and-repair-boundaries.md)和[实验授权](../../.agents/notes/implemented/architecture/2026-09-17-bounded-experiment-grants.md)。不要借排错启用归档的策略收紧或缓存迁移。
- 历史供应商恢复使用关联健康 key 的有界探针并保留有效 Retry-After；重试不能无条件清空全部健康状态。

## 回归入口

| 边界 | 测试 |
| --- | --- |
| 批量形状、ID、局部修复 | [parser](../../tests/planner/semantic-batch-answer.test.js)、[bundle integration](../../tests/integration/typed-compact-batch-wire.test.js) |
| 技术标签与漏译反例 | [soft validation](../../tests/planner/translation-soft-validation.test.js)、[integration](../../tests/integration/p3-soft-validation-keep.test.js) |
| 完整语义及格式 | [inline ranges](../../tests/planner/translation-inline-ranges.test.js)、[inline format](../../tests/planner/translation-inline-format.test.js) |
| 累计与计时 | [session](../../tests/capsule-session-regression.test.js)、[duration](../../tests/capsule-duration-visibility.test.js) |
| 关闭与等待图标 | [spinner recovery](../../tests/integration/historical-spinner-recovery.test.js) |

## 环境与隐私

替换安装文件使用复制覆盖，先把备份放到插件目录之外；删除后移动可能被宿主判定为卸载。客户端更新后的 BDFDB 依赖故障应先与本插件故障区分。查看诊断不打印配置对象、凭证、真实聊天或频道 ID。

原始截图、响应、HAR、日志和机器路径留在 Git 外。将真实问题转成合成回归；剩余观察项见 [已知限制与待验证事项](../recovery-plan.md)，公开流程见 [脱敏与发布指南](../publication.md)。

显示决策及被拒绝的重绘路线见[显示与就绪边界](../../.agents/notes/implemented/architecture/2026-09-17-display-and-readiness-boundaries.md)。
