# Agent Note: Cloud Translation 模型直接配置

Status: implemented

## Problem

一个模型输入被单独放进高级折叠区，增加了标题与展开步骤。用户根据实际界面要求恢复直接编辑，卡片名称缩为 Cloud Translation。

## Decision

替代[日常设置与排障证据分层](2026-09-17-settings-diagnostics-and-cache.md)中关于该服务模型折叠的决定：复用普通模型输入与验证按钮所在行，默认行为说明放进问号提示，不保留额外折叠状态。当前名称、默认值和配置作用归属[供应商说明](../../../../docs/providers.md)。

## Alternatives considered

- 保留高级折叠：单个字段并未受益于增加一层操作，因此移除。
- 删除模型字段并强制默认值：会丢失用户已指定的模型，保留编辑与清空能力。

## Consequences

减少一层操作，默认值与已有覆盖值直接可见；只调整呈现，不修改供应商请求和凭证存储。复用已有合成回归检查默认值、编辑和清空。浏览器预览不能替代 Discord 内的主题与交互核验。

## References

- [设置界面](../../../../src/ui/settings-panel.js)
- [设置回归](../../../../tests/settings-panel-render.test.js)
