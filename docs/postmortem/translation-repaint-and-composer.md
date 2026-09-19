# 重绘与输入框问题复盘

<a id="scope-and-evidence"></a>

## 范围与证据来源

本文整理已有源码注释和调试指南中的历史经验，没有新增客户端观察。[渲染适配器](../../src/display/discord-render-adapter.js)记录了 2026-08-13 和 2026-08-16 的观察。原始客户端采集文件保存在 Git 外；这些记录不能证明更新后的客户端版本仍然兼容。

<a id="observed-failure"></a>

## 当时观察到的问题

翻译结果可能未及时显示；当恢复范围扩大到重建整个聊天区时，又可能干扰输入框和阅读位置。拿到一个合成组件句柄，并不足以证明 React 能更新实际挂载的消息行。

<a id="established-causes-and-rejected-routes"></a>

## 已确认原因与被否决的路线

适配器 2026-08-13 的注释记录：消息行使用函数组件或 memo 化组件，在频道消息流附近测得的候选句柄无法产生有效更新。没有 updater 的合成句柄不能作为可靠的重绘入口。重建整个聊天区会跨越输入框和虚拟列表的边界，影响被翻译消息以外的界面。

2026-08-16 的注释记录了另一个识别问题：精确的 `data-list-item-id` 选择器漏掉了合法的已挂载消息行结构，使这些行被误判为虚拟化状态。必须区分“为屏外消息保存结果”与“确认可见消息已经显示”。

<a id="correction-and-remaining-limits"></a>

## 修正方法与剩余限制

当前适配器通过 Store 定向重绘消息，分别确认普通正文和回复预览的修订，并进行有界重试。虚拟化消息挂载后读取已存储状态；滚动恢复服从用户最新意图。当前约定由[显示架构](../architecture.zh-CN.md)及[相关决策笔记](../../.agents/notes/implemented/architecture/2026-09-17-display-and-readiness-boundaries.md)维护。

插件生命周期和全局设置重新初始化仍有各自的宿主刷新。此次事故经验或单元测试通过，都不能证明这些操作永远不会刷新输入框。Discord 内部实现变化后，应重新观察，再接受新的渲染结论。

<a id="verification-and-reuse"></a>

## 验证与经验复用

[适配器回归测试](../../tests/display/discord-render-adapter.test.js)检查定向结果和重试行为；[输入框隔离契约](../../tests/composition-root-finalization.test.js)保留生命周期相关限制。通过[故障排查步骤](../cookbook/debugging.zh-CN.md)区分 HTTP、校验、存储与实际显示证据。不能仅凭模拟更新调用通过，就重新启用已被否决的全局重绘方案。
