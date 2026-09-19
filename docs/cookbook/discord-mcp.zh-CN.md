# Discord MCP 调试与复现

这是维护者通过 MCP 检查 Discord 客户端的可选入口。已有接入名为 `discord-control`，底层使用 [Microsoft Playwright MCP](https://github.com/microsoft/playwright-mcp)；项目补充了本机配置、辅助脚本和复现方法。本仓库不安装或分发该服务，普通用户安装翻译插件无需配置 MCP。

## 接入约定与工具发现

| 项目 | 如何定位 |
| --- | --- |
| 已有服务名 | `discord-control`；在当前会话的工具清单中搜索，不假定所有机器均已注册 |
| 工具前缀 | `mcp__discord_control__`；服务器原始名称为 `browser_tabs`、`browser_evaluate` 等 |
| 底层依赖 | 已有工具环境固定 `@playwright/mcp@0.0.81`；迁移时以工具目录的 `package.json` / lockfile 为准，升级后重新核对 schema |
| 传输 | MCP 客户端通过 stdio 启动服务器，再通过 CDP 附加到已登录的 Discord / DiscordPTB |
| 启动参数 | 工具目录中的 `@playwright/mcp/cli.js`，配合 `--cdp-endpoint=http://127.0.0.1:<CDP_PORT>`、`--cdp-timeout=<TIMEOUT_MS>`、`--output-dir=<EVIDENCE_DIR>` |
| 本机辅助脚本 | `probe-mcp.cjs` / `mcp-call.cjs` 是仓库外的备用客户端；安装上游包不会生成这些脚本，也不是使用已注册工具的前提 |

占位符必须替换为本机真实值；可执行文件、工具目录、端口和证据目录留在个人配置中。迁移已有工具环境时在其目录运行 `npm ci`；从零安装按上游说明固定所需版本，并另行注册服务。不要把包加入翻译插件的运行时依赖，也不要复制整个个人配置或历史复现脚本到公开仓库。

先读取当前工具 schema，再调用 `browser_tabs({action:"list"})`。从返回的页面识别 Discord 主页面；只有需要时才使用刚读取的 `index` 选择，不能固定页索引。工具已可用时无需再启动备用控制客户端。页面列表也可能包含频道 URL，应仅在本地查看。

## 启动客户端与恢复连接

**MCP 服务启动成功，不代表 Discord 已开放调试连接。** 通过普通快捷方式、开机自启或更新器启动的 Discord 可能没有调试参数；此时 MCP 虽然能初始化，页面调用仍会报 `ECONNREFUSED`。重启 MCP、重载翻译插件都不能给已有客户端进程补开调试端口。

Windows 上按以下顺序操作：

1. 确认 MCP 的 `--cdp-endpoint`，记下它使用的端口。以下以 `9223` 为例；个人配置不同时同步替换。
2. 保存正在编辑的内容，从系统托盘菜单正常退出需要调试的 Discord / DiscordPTB。只关闭窗口可能仍在后台运行；在任务管理器确认该客户端已退出。代理代操作时遵循当前任务的重启授权，不为检查文档而重启或强杀客户端。
3. 找到当前安装版本实际使用的客户端可执行文件，用下列 PowerShell 命令启动。这里应选择 `Discord.exe` 或 `DiscordPTB.exe`，不是 `Update.exe`；普通快捷方式可能先调用更新器而没有传递调试参数。

```powershell
$discordExecutable = Read-Host '请输入当前版本 Discord.exe 或 DiscordPTB.exe 的完整路径'
$cdpPort = 9223
Start-Process -FilePath $discordExecutable -ArgumentList @(
    '--remote-debugging-address=127.0.0.1',
    "--remote-debugging-port=$cdpPort"
)
```

4. 等客户端启动后，在同一个 PowerShell 窗口检查监听与 CDP 响应：

```powershell
Get-NetTCPConnection -LocalPort $cdpPort -State Listen |
    Select-Object LocalAddress, LocalPort, OwningProcess
Invoke-RestMethod "http://127.0.0.1:$cdpPort/json/version" |
    Select-Object Browser, 'Protocol-Version'
```

监听必须局限在本机回环地址；不要为了连接方便开放到局域网或公网。没有监听时，先检查主进程启动参数、是否仍有旧进程和端口是否一致。HTTP 有响应也需确认监听进程属于目标客户端，避免连到其他浏览器。

5. 重新调用 MCP 的 `browser_tabs({action:"list"})`，确认能读取目标 Discord 主页面。仅在工具仍持有失效连接时重新连接 MCP；客户端本身没有监听时，反复重启 MCP 无效。

以后每次需要调试，都用带上述参数的启动入口。可以在本机维护专用调试快捷方式；客户端更新后核对它的可执行文件路径。再次使用普通快捷方式、开机自启或更新后的默认入口时，要重新检查端口，不能把上次连接成功当成本次已连接。实际安装路径和个人快捷方式留在仓库外。

## 分层检查连接

| 观察 | 下一步 | 能证明的范围 |
| --- | --- | --- |
| 找不到工具 | 核对该服务是否注册、启动成功，以及当前会话是否已载入工具 | 工具清单缺失不能证明插件故障 |
| 初始化成功，但页面调用失败 | 核对 `--cdp-endpoint` 与客户端实际监听地址、端口是否一致 | MCP 进程启动不等于 CDP 已连接 |
| `ECONNREFUSED` / 连接超时 | 检查客户端是否带调试参数启动、端口是否监听；超时还需检查目标是否卡住 | 连接失败时记录“未核验内存实例” |
| 页面可读，但找不到插件或方法 | 核对主页面、BetterDiscord 加载情况、插件启用及 API 版本 | 可读页面不等于目标插件已运行 |
| 插件可读，但翻译失败 | 按[现场指南](debugging.zh-CN.md)区分供应商、响应校验与显示问题 | MCP 端口与翻译服务商端口是两回事 |

启动参数与恢复步骤见[启动客户端与恢复连接](#启动客户端与恢复连接)。已有进程可能吞掉再次启动时的新参数，因此启动命令返回后仍需检查监听及实际页面调用。

断开工具会话不应调用 `browser_close` 或关闭标签页来清理真实客户端。工具可用也不自动授权发送消息、修改凭证、开关频道、清缓存或执行任意脚本。

## 最小运行状态快照

选择正确页面后，把以下函数作为 `browser_evaluate` 的 `function` 字符串。它仅调用状态读取方法，不发消息、翻译、导航或更改设置；只返回插件身份、开关、阶段和计数。频道 ID 只在页面内部用于查询，不出现在返回结果中。不要用完整插件对象、设置、Store 或页面正文替代这份白名单。

```javascript
() => {
  if (!/(^|\.)discord(?:app)?\.com$/.test(location.hostname)) {
    return {target: "not-discord"};
  }
  const readErrors = [];
  const read = (object, method, ...args) => {
    const fn = object?.[method];
    if (typeof fn !== "function") return null;
    try { return fn.apply(object, args) ?? null; }
    catch { readErrors.push(method); return null; }
  };
  const name = "DiscordAITranslator";
  const plugins = globalThis.BdApi?.Plugins;
  const wrapper = read(plugins, "get", name);
  const plugin = wrapper?.instance || wrapper;
  const enabled = read(plugins, "isEnabled", name);
  const active = enabled === true ? plugin : null;
  const channelId = location.pathname.match(/^\/channels\/[^/]+\/([^/]+)/)?.[1];
  const work = channelId ? read(active, "getLoadedHistoricalWorkStatus", channelId) : null;
  const perf = read(active, "getHistoricalBatchPerformanceSnapshot");
  return {
    observedAt: new Date().toISOString(),
    pluginFound: !!wrapper, pluginEnabled: enabled,
    version: read(plugin, "getVersion"), build: read(plugin, "getBuildId"),
    channelPage: !!channelId,
    channelEnabled: channelId ? read(active, "isTranslationEnabled", channelId) : null,
    capsulePresent: !!document.getElementById("DiscordAITranslator-loaded-status"),
    waitingIcons: document.querySelectorAll(".translator-translation-loading").length,
    work: work ? {
      phase: work.phase, active: work.active,
      pending: work.pendingMessageIds?.length ?? null,
      displayPending: work.displayPending, displayFailed: work.displayFailed
    } : null,
    historicalRequests: perf ? {
      primary: perf.primaryChunkRequestCount,
      repairBatches: perf.repairBatchRequestCount,
      repairItems: perf.repairItemRequestCount, activeRuns: perf.activeRunCount
    } : null,
    readErrors
  };
}
```

方法入口见 [runtime](../../src/legacy/runtime.js)，状态投影见 [historical status](../../src/status/historical-status-projection.js)。这些内部诊断方法随插件实现演进；先核对实际构建，不能据旧示例认定新版本损坏。

- 文件哈希、插件启用标志和内存实例身份分别核验。快照不包含磁盘哈希；按[构建身份检查](debugging.zh-CN.md)比较源码产物、安装文件和内存 build。
- 方法缺失、插件未启用或读取出错会得到 `null`；`readErrors` 只列方法名，不回传可能包含私有数据的异常正文。`work:null` 也可能是当前没有历史工作，不能直接解释为“0 个失败”。
- `work` 描述当前频道的历史状态投影，`historicalRequests` 来自历史批次性能统计，并不覆盖所有入口或所有网络请求。计数可能跨频道累计，应取同一实例、同一复现窗口的前后差值；重载会破坏比较基线。
- `waitingIcons` 仅统计挂载的 DOM，不能代表虚拟化历史的全部消息。胶囊未挂载时先检查频道开关和翻译范围；`new_only` 不显示历史胶囊。当前状态的解释以 [功能与行为说明](../product.md) 为准。

## 按问题补充证据

| 问题 | 工具与取证范围 | 对应检查 |
| --- | --- | --- |
| 胶囊、按钮或等待图标异常 | `browser_snapshot` / `browser_find`；先确认元素存在，优先局部 `target` | 对照上面的状态快照，区分 DOM 与运行状态 |
| 需要图像确认 | `browser_take_screenshot`；使用当前 schema 支持的局部目标 | 保存后检查实际像素，只有文件路径不算有效证据 |
| 客户端报错 | `browser_console_messages({level:"error"})` | 按本轮复现窗口筛选，分享前去除聊天和身份信息 |
| 怀疑服务商失败 | `browser_network_requests({static:false,filter:"<URL_PATTERN>"})`，必要时读取单条 `browser_network_request` | 避免默认导出认证头和请求/响应正文；结合插件 provider 诊断与请求计数 |
| 需要复现点击、切换或重试 | 从新快照取得目标，再使用相应 UI 工具 | 按任务授权操作，记录触发前后状态；切频道可能触发自动翻译 |

工具参数以当前 schema 为准，例如已有接入使用 `target`，不能照搬其他版本的 `ref`。`browser_evaluate` 与 `browser_run_code_unsafe` 均可执行代码；后者可在 Playwright 服务器环境执行任意代码，只在任务确实需要时审阅并限定执行内容。历史辅助脚本可能含固定频道、动作和旧假设，不能因文件名像“检查”就直接重放。

页面网络工具只能看到它捕获的流量。插件也可能经 BetterDiscord / Node 传输发请求；列表里没有翻译请求不能证明没有调用服务商。异常分类也不能代替原始响应证据，详细归因见[现场指南](debugging.zh-CN.md)。

截图失败时先检查主页面、窗口是否最小化以及是否发生并行切换；需要改变前台或窗口状态时遵循任务范围。白图、超时和未检查像素的截图都不能作为通过证据。

## 从复现到修复

1. 先记录构建身份与最小快照，明确预期和实际现象。使用专用测试频道、合成消息，每次只改变一个变量。
2. 根据[现场指南](debugging.zh-CN.md)定位连接、HTTP、解析/校验、显示中的失败边界，把现象转成对应的合成回归。MCP 提供客户端证据，源码和测试承担修复。
3. 修改后按[贡献流程](../../CONTRIBUTING.md#development-workflow)运行针对性检查和 `npm run verify`。需要安装到客户端时，先依已有授权执行备份、部署和身份复核；仅编辑或测试成功不等于客户端已更新。
4. 对同一场景取新的快照和必要 UI 证据，比较计数、显示和副作用；恢复本轮按约定改变的测试状态。连接不可用时如实保留待验证项，不用旧截图代替本次结果。
5. 当前用法更新本文；问题原因进入对应 postmortem，长期决策更新相关 [设计与经验笔记（Agent Notes）](../../.agents/notes/README.md)。单次日志、测试次数和截图不进入长期文档。

原始证据统一保存在仓库外。自动命名输出由 `--output-dir` 控制，但带相对 `filename` 的工具输出可能按工作区根目录解析；需要落盘时传仓库外的绝对路径，并为每轮使用唯一名称。不要假定配置了输出目录就能防止所有文件进入 Git。公开回归使用合成内容，移除账号、服务器、频道、消息、端点和机器身份；分享前按[发布边界](../publication.md)复核。
