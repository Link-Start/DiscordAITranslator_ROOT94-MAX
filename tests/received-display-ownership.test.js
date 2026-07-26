const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// These are source-text contracts on purpose. They guard against a specific class of
// regression that no behavioural test catches cheaply: a commit path quietly reaching for
// a whole-list repaint. A full remount reflows the chat while the user is reading it, and
// that is what "very laggy" looked like before the display store existed. The store's own
// behaviour is covered by tests/display/*; what these pin is that the legacy escape hatches
// stay out of the commit paths.
//
// The maps this file used to guard (translatedMessages, oldMessages) no longer exist
// anywhere in the tree, so asserting their absence proved nothing. The repaint contract is
// what survived.
const source = fs.readFileSync(path.resolve(__dirname, "..", "src", "legacy", "runtime.js"), "utf8");

// Named here so a rename cannot silently turn every assertion below into a tautology.
const FULL_LIST_REPAINT = /scheduleTranslationRerender|PatchUtils\.forceAllUpdates/;
const LEGACY_WHOLE_MESSAGE_WRITER = /applyStoredTranslationToMessage/;

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

test("the guarded identifiers still exist, so these contracts are not vacuous", () => {
	assert.match(source, FULL_LIST_REPAINT);
	assert.match(source, LEGACY_WHOLE_MESSAGE_WRITER);
});

test("commit paths repaint the messages they touched, never the whole list", () => {
	const commitMethods = [
		methodSlice("commitReceivedDisplayResult", "commitHistoricalReceivedDisplayBatch"),
		methodSlice("commitHistoricalReceivedDisplayBatch", "getReceivedDisplayView"),
		methodSlice("commitHistoricalTranslationJob", "rerenderHistoricalTranslationJob")
	];
	for (const method of commitMethods) {
		assert.doesNotMatch(method, FULL_LIST_REPAINT);
		assert.doesNotMatch(method, LEGACY_WHOLE_MESSAGE_WRITER);
	}
});

test("the received display commit path delegates to the display runtime", () => {
	assert.match(methodSlice("commitReceivedDisplayResult", "commitHistoricalReceivedDisplayBatch"), /ensureReceivedDisplayRuntime\(\)\.commitMessageResult/);
	assert.match(methodSlice("commitHistoricalReceivedDisplayBatch", "getReceivedDisplayView"), /ensureReceivedDisplayRuntime\(\)\.commitHistoricalBatch/);
});

test("automatic translation flows never fall back to the whole-list repaint", () => {
	const flowSlices = [
		methodSlice("commitCachedDisplayResult", "resolveCheckMessageDisplay"),
		methodSlice("resolveLoadedMessageContentTranslation", "prepareMessageContentDisplay")
	];
	for (const flow of flowSlices) {
		assert.doesNotMatch(flow, FULL_LIST_REPAINT);
		assert.doesNotMatch(flow, LEGACY_WHOLE_MESSAGE_WRITER);
	}
});

test("the extracted live queue cannot reach display state at all", () => {
	// Structural rather than textual: a module has no access to the plugin factory closure,
	// so the queue can only touch display state through the runtime it was handed.
	const queueSource = fs.readFileSync(path.resolve(__dirname, "..", "src", "orchestrator", "live-translation-queue.js"), "utf8");
	assert.doesNotMatch(queueSource, FULL_LIST_REPAINT);
	assert.doesNotMatch(queueSource, LEGACY_WHOLE_MESSAGE_WRITER);
});
