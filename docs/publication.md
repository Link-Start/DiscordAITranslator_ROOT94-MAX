# 脱敏与发布指南

本文说明哪些内容可以公开，以及从私人开发仓库安全准备 GitHub 发布的步骤。

<a id="public-contents"></a>

## 可以公开的内容

公开源码、可重复构建的插件、合成测试、当前文档及审查过的项目元数据。公开作者署名和 GitHub 项目链接是有意保留的信息。凭证填写在 BetterDiscord 设置中，不写入源码。

原始跟踪、供应商响应、真实聊天、截图、HAR、安装配置、部署备份和本机路径留在 Git 外。`.gitignore` 降低误暂存风险；公开文件检查也会拒绝被强制加入的禁用文件。唯一例外 `artifacts/ui-redesign-draft.html` 是测试需要的合成样式参考。

<a id="local-checks"></a>

## 本地检查

```powershell
npm ci
npm run verify
gitleaks dir --config .gitleaks.toml --redact=100 --ignore-gitleaks-allow .
gitleaks git --config .gitleaks.toml --redact=100 --ignore-gitleaks-allow --log-opts="--all" .
```

使用 Gitleaks 8.30.1，与 CI 固定且经过校验和验证的二进制版本一致。默认规则继续生效，额外增加个人路径和数字身份规则，并同样扫描历史。例外只覆盖一个 esbuild 函数名、一份合成脱敏测试数据及明确审查过的合成数字 ID；不得豁免整个测试文件、测试目录或生成插件。合成数字列在 [public-synthetic-identities.json](../scripts/public-synthetic-identities.json)，并同步到 Gitleaks 规则。报告和扫描输出保存在仓库外。

`check:publication` 检查已跟踪文件和未被忽略的新文件，包括文档篇幅、相对文件链接，以及所有文本文件（含测试）中的个人主目录路径和长数字 ID。它不扫描 Git 历史，也不能证明任意文字都不含个人信息。独立的 Gitleaks CI 任务扫描已获取的全部可达历史。新增公开媒体前，人工检查截图和附件。

<a id="first-publication-from-private-development"></a>

## 从私人开发仓库首次公开

在新提交中删除文件后，旧提交仍能读到它。脱敏开发分支仍继承私人历史，不能把它直接推送为公开仓库的起点。

1. 保留私人仓库及已验证的仓库外备份。
2. 验证脱敏后的文件树，再用 `git archive` 只导出已提交文件。不要复制 `.git`、本地配置、忽略文件或备份包。
3. 从导出内容初始化独立仓库。首个提交使用预期公开的作者名和 GitHub noreply 邮箱。绑定发布目标前，确认 `git rev-list --all --count` 为 `1`，且 `git remote -v` 为空。
4. 在独立仓库运行公开文件检查、确定性构建检查、全量测试，以及文件和完整历史的密钥扫描，同时审查导出清单、提交作者和提交说明。
5. 处理尚未完成的开发工作，在当前发布授权内确认目标分支，再添加远程或发布。以后也不要把旧私人分支或其标签合并进此仓库；只迁入经过审查的文件变化，不带入那段历史。

目标 GitHub 仓库若已存在，先检查其分支和历史，再决定迁移方式。干净的本地导出不会删除已经公开的内容，该流程也不授权强制推送覆盖现有仓库。真实凭证若已泄露，应先轮换，再处理删除；扫描器无法撤销密钥。

<a id="maintaining-documentation"></a>

## 文档维护

根代理指引保持简短，以[文档入口](README.md)导航。根 README 保持完整产品介绍。更新当前行为的所属文档，不追加平行计划。长期决策和考虑过的替代方案记录在[设计与经验笔记](../.agents/notes/README.md)，任务规模判断见[开发与贡献指南](../CONTRIBUTING.md)。会话流水账和测试轮次留在私人证据中。
