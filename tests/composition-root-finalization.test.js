const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const runtime = fs.readFileSync(path.join(root, "src", "legacy", "runtime.js"), "utf8");

function getEnsureBlocks(source) {
	const lines = source.split("\n");
	const blocks = [];
	for (let index = 0; index < lines.length; index++) {
		const match = lines[index].match(/^\t\t\t(ensure[A-Z][A-Za-z0-9_]*)\s*\([^)]*\)\s*\{/);
		if (!match) continue;
		let depth = 0;
		let end = index;
		for (let cursor = index; cursor < lines.length; cursor++) {
			for (const character of lines[cursor]) {
				if (character === "{") depth++;
				else if (character === "}") depth--;
			}
			end = cursor;
			if (depth === 0) break;
		}
		blocks.push({name: match[1], lines: lines.slice(index, end + 1)});
	}
	return blocks;
}

const EXPECTED_LAZY_SINGLETONS = [
	"ensureComposerWiring",
	"ensureContextMenuWiring",
	"ensureDiscordMarkupRenderer",
	"ensureHistoricalJobRegistry",
	"ensureHistoricalSnapshotCadence",
	"ensureHistoricalSourceRuntime",
	"ensureLiveTranslationQueue",
	"ensureLoadedStatusCapsuleController",
	"ensureMessageDeletionLifecycle",
	"ensureMessageViewportStore",
	"ensureProviderClient",
	"ensureReceivedDisplayRepaintScheduler",
	"ensureReceivedDisplayRuntime",
	"ensureReplyPreviewQueue",
	"ensureSentTranslationStore",
	"ensureSettingsStore",
	"ensureSpecialCaseCodecs",
	"ensureTranslationCacheStore",
	"ensureTranslationPipeline"
].sort();

test("the final composition root keeps an explicit compact lazy-singleton inventory", () => {
	const singletonBlocks = getEnsureBlocks(runtime).filter(block => /Instance/.test(block.lines.join("\n")) && /\bcreate[A-Z]/.test(block.lines.join("\n")));
	assert.deepEqual(singletonBlocks.map(block => block.name).sort(), EXPECTED_LAZY_SINGLETONS);
	for (const block of singletonBlocks) {
		assert.ok(block.lines.length <= 8, `${block.name} grew to ${block.lines.length} lines; move host fan-out into its owning wiring module`);
	}
});

test("the decision owner closes extraction while current docs retain separate render observations", () => {
	const recovery = fs.readFileSync(path.join(root, "docs", "recovery-plan.md"), "utf8");
	const architecture = fs.readFileSync(path.join(root, "docs", "architecture.md"), "utf8");
	const fieldGuide = fs.readFileSync(path.join(root, "docs", "cookbook", "debugging.md"), "utf8");
	const decision = fs.readFileSync(path.join(root, ".agents", "notes", "implemented", "architecture", "2026-09-17-composition-root-boundary.md"), "utf8");
	assert.match(decision, /Slice 5d 模块组装入口（composition root）提取已完成/);
	assert.match(decision, /提取完成不代表独立的渲染/);
	assert.doesNotMatch(recovery, /## Next Executable Slice: Architecture/);
	assert.match(recovery, /生命周期与取消/);
	assert.match(recovery, /实际显示是否完成/);
	assert.match(architecture, /\.agents\/notes\/implemented\/architecture\/2026-09-17-composition-root-boundary\.md/);
	assert.doesNotMatch(architecture, /Slice 5d/);
	assert.doesNotMatch(fieldGuide, /Slice 5d is not finished/);
	assert.match(fieldGuide, /composer\/input can still refresh/);
});
