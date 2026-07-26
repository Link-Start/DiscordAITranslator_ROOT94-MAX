const test = require("node:test");
const assert = require("node:assert/strict");
const {createMessageStateStore} = require("../../src/display/message-state-store");
const {createDisplayView, createTranslationDisplayController} = require("../../src/display/translation-display-controller");
const {createDisplayTransitionJournal} = require("../../src/diagnostics/display-transition-journal");

function capture(store, messageId) {
	store.captureSource({messageId, channelId: "c1", generation: 1, sourceSignature: messageId, source: {content: `${messageId} source`, embeds: []}});
}

test("pending skipped failed and render-unconfirmed records expose stable reason codes", () => {
	const store = createMessageStateStore();
	for (const messageId of ["pending", "skipped", "failed", "unconfirmed"]) capture(store, messageId);
	store.markPending({messageId: "pending", channelId: "c1", generation: 1, origin: "automatic", requestIdentity: "request-1"});
	store.commitResult({messageId: "skipped", channelId: "c1", generation: 1, sourceSignature: "skipped", origin: "automatic", status: "skipped", reason: "same-language"});
	store.commitResult({messageId: "failed", channelId: "c1", generation: 1, sourceSignature: "failed", origin: "automatic", status: "failed", reason: "provider-timeout"});
	store.commitResult({messageId: "unconfirmed", channelId: "c1", generation: 1, sourceSignature: "unconfirmed", origin: "automatic", status: "translated", translation: {content: "translated"}});
	store.markRenderOutcome({confirmedIds: [], missingIds: ["unconfirmed"]});

	assert.equal(createDisplayView(store.getDisplayState("pending")).showLoading, true);
	assert.equal(createDisplayView(store.getDisplayState("skipped")).reason, "same-language");
	assert.equal(createDisplayView(store.getDisplayState("failed")).reason, "provider-timeout");
	assert.equal(createDisplayView(store.getDisplayState("unconfirmed")).renderReason, "render-unconfirmed");
});

test("the debug journal is bounded and keyed by channel and message", () => {
	const journal = createDisplayTransitionJournal({enabled: true, limit: 2, now: () => 123});
	journal.append({channelId: "c1", messageId: "m1", transition: "captured"});
	journal.append({channelId: "c1", messageId: "m2", transition: "pending"});
	journal.append({channelId: "c2", messageId: "m3", transition: "state-committed"});

	assert.deepEqual(journal.list().map(entry => entry.messageId), ["m2", "m3"]);
	assert.deepEqual(journal.list({channelId: "c1"}).map(entry => entry.messageId), ["m2"]);
	assert.deepEqual(journal.list({messageId: "m3"})[0], {channelId: "c2", messageId: "m3", transition: "state-committed", timestamp: 123});
});

test("a disabled journal records nothing and clear empties the buffer", () => {
	const disabled = createDisplayTransitionJournal({enabled: false, now: () => 1});
	disabled.append({channelId: "c1", messageId: "m1", transition: "captured"});
	assert.deepEqual(disabled.list(), []);

	const journal = createDisplayTransitionJournal({enabled: true, now: () => 1});
	journal.append({channelId: "c1", messageId: "m1", transition: "captured"});
	journal.clear();
	assert.deepEqual(journal.list(), []);
});

test("store and controller record display transitions in an injected journal", async () => {
	const journal = createDisplayTransitionJournal({enabled: true, now: () => 7});
	const store = createMessageStateStore({journal});
	const controller = createTranslationDisplayController({
		store,
		journal,
		renderAdapter: {
			async refreshMessages(request) {
				return {confirmedIds: request.messageIds, missingIds: [], fallbackUsed: false};
			}
		}
	});
	capture(store, "m1");
	store.markPending({messageId: "m1", channelId: "c1", generation: 1, origin: "automatic", requestIdentity: "request-1"});
	await controller.commitMessageResult({messageId: "m1", channelId: "c1", generation: 1, sourceSignature: "m1", requestIdentity: "request-1", origin: "automatic", status: "translated", translation: {content: "译文"}});
	store.restoreChannel("c1");

	const transitions = journal.list({messageId: "m1"}).map(entry => entry.transition);
	assert.deepEqual(transitions, ["captured", "pending", "state-committed", "render-requested", "render-confirmed", "restored"]);
	assert.equal(journal.list({messageId: "m1"}).every(entry => entry.channelId === "c1" && typeof entry.revision === "number"), true);
});

test("the release bundle removes the debug journal implementation", async () => {
	const {createPluginBundle} = await import("../../scripts/build-plugin.mjs");
	const releaseBundle = await createPluginBundle({debug: false});
	const debugBundle = await createPluginBundle({debug: true});

	assert.doesNotMatch(releaseBundle, /TRANSLATOR_DISPLAY_DEBUG_JOURNAL/);
	assert.match(debugBundle, /TRANSLATOR_DISPLAY_DEBUG_JOURNAL/);
});
