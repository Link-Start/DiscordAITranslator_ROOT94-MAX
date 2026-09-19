const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = relativePath => fs.readFileSync(path.join(root, relativePath), "utf8");
const readJson = relativePath => JSON.parse(read(relativePath));
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const RELEASE_VERSION = "1.0.0";

test("release metadata, README and changelog agree on v1.0.0", () => {
	const packageJson = readJson("package.json");
	const packageLock = readJson("package-lock.json");
	const metadata = readJson("src/plugin/metadata.json");
	const readmeZh = read("README.md");
	const readmeEn = read("README.en.md");
	const changelog = read("CHANGELOG.md");
	const plugin = read("DiscordAITranslator.plugin.js");

	assert.equal(packageJson.version, RELEASE_VERSION);
	assert.equal(packageLock.version, RELEASE_VERSION);
	assert.equal(packageLock.packages[""].version, RELEASE_VERSION);
	assert.equal(metadata.version, RELEASE_VERSION);
	assert.match(readmeZh, new RegExp(`Version-${escapeRegex(RELEASE_VERSION)}-`));
	assert.match(readmeZh, new RegExp(`当前版本：v${escapeRegex(RELEASE_VERSION)}`));
	assert.match(readmeEn, new RegExp(`Current version: v${escapeRegex(RELEASE_VERSION)}`));
	assert.match(changelog, new RegExp(`^## v${escapeRegex(RELEASE_VERSION)}$`, "m"));
	assert.match(plugin, new RegExp(`^ \\* @version ${escapeRegex(RELEASE_VERSION)}$`, "m"));
});

test("root README offers complete English and Simplified Chinese mirrors", () => {
	const chinese = read("README.md");
	const english = read("README.en.md");
	const languageSwitch = "[简体中文](README.md) | [English](README.en.md)";
	const latestDownload = "releases/latest/download/DiscordAITranslator.plugin.js";

	assert.match(english, new RegExp(escapeRegex(languageSwitch)));
	assert.match(chinese, new RegExp(escapeRegex(languageSwitch)));
	assert.match(english, new RegExp(escapeRegex(latestDownload)));
	assert.match(chinese, new RegExp(escapeRegex(latestDownload)));

	for (const heading of [
		"## Why This Plugin",
		"## Translation Example",
		"## Features",
		"## Supported Providers",
		"## Quick Start",
		"## Usage",
		"## Known Limitations",
		"## Development",
		"## Documentation",
		"## Credits",
		"## License"
	]) assert.match(english, new RegExp(`^${escapeRegex(heading)}$`, "m"));

	for (const heading of [
		"## 为什么使用它",
		"## 效果展示",
		"## 核心功能",
		"## 支持的翻译服务商",
		"## 快速安装",
		"## 使用方法",
		"## 已知限制",
		"## 开发与验证",
		"## 技术文档",
		"## 致谢",
		"## 开源协议"
	]) assert.match(chinese, new RegExp(`^${escapeRegex(heading)}$`, "m"));

	assert.doesNotMatch(english, /\bperfect\b|zero-jumping|\b100%\b/i);
	assert.doesNotMatch(chinese, /完美|彻底解决|100%/);

	assert.match(english, /synthetic examples/);
	assert.match(chinese, /合成示例/);
	for (const document of [english, chinese]) {
		assert.doesNotMatch(document, /\]\(images\//, "private screenshots are excluded from publication");
		assert.match(document, /Please review the update tomorrow\./, "both languages share the public example");
	}
	assert.equal(fs.existsSync(path.join(root, "README.zh-CN.md")), false, "the old duplicate Chinese filename is removed");

	const docsIndex = read("docs/README.md");
	assert.match(docsIndex, /\.\.\/README\.md/);
	assert.match(docsIndex, /\.\.\/README\.en\.md/);
});

test("public repository governance files are present and local assistant state stays untracked", () => {
	for (const relativePath of [
		"SECURITY.md",
		"CODE_OF_CONDUCT.md",
		".github/dependabot.yml",
		".github/pull_request_template.md",
		".github/ISSUE_TEMPLATE/bug_report.yml",
		".github/ISSUE_TEMPLATE/feature_request.yml",
		".github/ISSUE_TEMPLATE/config.yml"
	]) assert.equal(fs.existsSync(path.join(root, relativePath)), true, `${relativePath} must exist`);
	assert.match(read("AGENTS.md"), /docs\/README\.md/);
	assert.match(read(".gitignore"), /^AGENTS\.local\.md$/m);
	assert.match(read("SECURITY.md"), /security\/advisories\/new/);
});

test("architecture and debugging cookbook provide complete Chinese companion entry points", () => {
	const pairs = [
		["docs/architecture.md", "docs/architecture.zh-CN.md", "architecture.zh-CN.md", "architecture.md"],
		["docs/cookbook/debugging.md", "docs/cookbook/debugging.zh-CN.md", "debugging.zh-CN.md", "debugging.md"]
	];

	for (const [englishPath, chinesePath, chineseLink, englishLink] of pairs) {
		assert.equal(fs.existsSync(path.join(root, chinesePath)), true, `${chinesePath} must exist`);
		const english = read(englishPath);
		const chinese = read(chinesePath);
		assert.match(english, new RegExp(`\\(${escapeRegex(chineseLink)}\\)`), `${englishPath} links to Chinese`);
		assert.match(chinese, new RegExp(`\\(${escapeRegex(englishLink)}\\)`), `${chinesePath} links to English`);
		assert.match(chinese, /[\u4e00-\u9fff]{20}/, `${chinesePath} contains substantive Chinese text`);
	}

	const index = read("docs/README.md");
	assert.match(index, /architecture\.zh-CN\.md/);
	assert.match(index, /cookbook\/debugging\.zh-CN\.md/);
});

test("the bilingual cookbook preserves Composer isolation without stale deployment snapshots", () => {
	const english = read("docs/cookbook/debugging.md");
	const chinese = read("docs/cookbook/debugging.zh-CN.md");

	assert.match(english, /^### Verify composer isolation$/m);
	assert.match(chinese, /^### 检查 Composer 隔离$/m);
	for (const document of [english, chinese]) assert.match(document, /\.agents\/notes\/implemented\/architecture\/2026-09-17-display-and-readiness-boundaries\.md/);
	assert.match(english, /clear only `translationCache`/);
	assert.match(chinese, /只清 `translationCache`/);
	assert.doesNotMatch(english, /needs the final field gate/);
	assert.doesNotMatch(chinese, /等待最终现场门/);
});

test("recovery boundaries preserve unfinished observations and separate private history from publication", () => {
	assert.equal(fs.existsSync(path.join(root, "docs", "ui-redesign-plan.md")), false);
	const recovery = read("docs/recovery-plan.md");
	const headings = [
		"## 需要证据后再推进的事项",
		"## 暂缓的工作",
		"## 怎样收集证据"
	];
	for (const heading of headings) assert.match(recovery, new RegExp(`^${escapeRegex(heading)}$`, "m"));
	assert.match(recovery, /生命周期与取消/);
	assert.match(recovery, /实际显示是否完成/);
	assert.match(recovery, /自动连续读取多页历史的功能在此前回滚后继续暂缓/);
	assert.doesNotMatch(recovery, /Priority 0: Field Observation|Priority 1: Message Deletion Dispatcher|ACTIVE DEBUG|bulk-delete observation pending/);
	assert.match(recovery, /\.agents\/notes\/implemented\/architecture\/2026-09-17-composition-root-boundary\.md/);
	assert.doesNotMatch(recovery, /## Next Executable Slice: Architecture|Status: ACTIVE — Slice 5d composition root/);
	assert.ok(recovery.split("\n").length <= 140, "recovery-plan keeps only the executable active backlog");
	assert.ok(recovery.length <= 15000, "incident history belongs in postmortem, not recovery-plan");
	assert.doesNotMatch(recovery, /Σ47|Atomic rebuild RETIRED|codex\/display-unification|Shipped by v0\.3\.38/);
	assert.doesNotMatch(read("docs/cookbook/debugging.md"), /release identity\/changelog gates remain/);
	assert.doesNotMatch(read("docs/cookbook/debugging.zh-CN.md"), /发布身份\/CHANGELOG 门仍/);
	assert.match(read("docs/publication.md"), /脱敏开发分支仍继承私人历史/);
	assert.equal(fs.existsSync(path.join(root, "docs/current-state-and-stabilization.zh-CN.md")), false, "transient build snapshots are not current documentation");
	assert.equal(fs.existsSync(path.join(root, "docs/adr")), false, "Agent Notes have one owning root");
	assert.match(read("docs/cookbook/debugging.zh-CN.md"), /src\/plugin\/metadata\.json/);
	assert.match(read("docs/cookbook/debugging.zh-CN.md"), /@version\|@buildId/);
});
