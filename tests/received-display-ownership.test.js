const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.resolve(__dirname, "..", "src", "legacy", "runtime.js"), "utf8");

function findMethodStart(name, fromIndex = 0) {
	const candidates = [`\n\t\t\t${name} (`, `\n\t\t\tasync ${name} (`, `\n\t\t\t${name}(`, `\n\t\t\tasync ${name}(`]
		.map(pattern => source.indexOf(pattern, fromIndex))
		.filter(index => index !== -1);
	return candidates.length ? Math.min(...candidates) : -1;
}

function methodSlice(name, nextName) {
	const start = findMethodStart(name);
	assert.notEqual(start, -1, `${name} method not found`);
	const end = findMethodStart(nextName, start + 1);
	assert.notEqual(end, -1, `${nextName} method not found after ${name}`);
	return source.slice(start, end);
}

test("replaced received display methods do not write legacy display ownership", () => {
	const automaticCommitMethods = [
		methodSlice("commitReceivedDisplayResult", "commitHistoricalReceivedDisplayBatch"),
		methodSlice("commitHistoricalReceivedDisplayBatch", "getReceivedDisplayView"),
		methodSlice("commitHistoricalTranslationJob", "rerenderHistoricalTranslationJob")
	];
	for (const method of automaticCommitMethods) {
		assert.doesNotMatch(method, /translatedMessages|oldMessages|applyStoredTranslationToMessage|scheduleTranslationRerender|PatchUtils\.forceAllUpdates/);
	}
});

test("the received display compatibility path delegates to the display runtime", () => {
	assert.match(methodSlice("commitReceivedDisplayResult", "commitHistoricalReceivedDisplayBatch"), /ensureReceivedDisplayRuntime\(\)\.commitMessageResult/);
	assert.match(methodSlice("commitHistoricalReceivedDisplayBatch", "getReceivedDisplayView"), /ensureReceivedDisplayRuntime\(\)\.commitHistoricalBatch/);
});

test("automatic received translation flows never call the legacy display writer", () => {
	const flowSlices = [
		methodSlice("commitCachedDisplayResult", "resolveCheckMessageDisplay"),
		methodSlice("resolveLoadedMessageContentTranslation", "prepareMessageContentDisplay")
	];
	for (const flow of flowSlices) {
		assert.doesNotMatch(flow, /applyStoredTranslationToMessage|scheduleTranslationRerender/);
	}
});

test("the extracted live queue cannot reach the legacy display maps at all", () => {
	// The queue moved out of runtime.js, so the contract is now structural rather
	// than textual: a module has no access to the factory closure that holds those
	// maps, and naming one would be a bug rather than a legacy call.
	const queueSource = fs.readFileSync(path.resolve(__dirname, "..", "src", "orchestrator", "live-translation-queue.js"), "utf8");
	assert.doesNotMatch(queueSource, /translatedMessages|oldMessages|applyStoredTranslationToMessage|scheduleTranslationRerender/);
});
