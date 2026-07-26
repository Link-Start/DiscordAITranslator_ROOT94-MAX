const test = require("node:test");
const assert = require("node:assert/strict");
const {
	MESSAGE_STATUSES,
	RENDER_STATUSES,
	createMessageStateStore
} = require("../../src/display/message-state-store");

function snapshot(messageId, channelId, content, generation = 1) {
	return {
		messageId,
		channelId,
		generation,
		sourceSignature: `${channelId}:${messageId}:${content}`,
		source: {content, embeds: [{description: `${content} embed`}]}
	};
}

function translated(messageId, channelId, sourceContent, content, generation = 1, origin = "automatic", requestIdentity) {
	return {
		messageId,
		channelId,
		generation,
		sourceSignature: `${channelId}:${messageId}:${sourceContent}`,
		origin,
		requestIdentity,
		status: "translated",
		translation: {content}
	};
}

function unsupportedRequestIdentities() {
	return [
		["object", () => ({toString() {throw new Error("structured identities must not be coerced");}})],
		["array", () => ["request"]],
		["function", () => function requestIdentity() {}],
		["symbol", () => Symbol("request")]
	];
}

test("exports the complete message and render status vocabularies", () => {
	assert.deepEqual(MESSAGE_STATUSES, {
		IDLE: "idle",
		PENDING: "pending",
		TRANSLATING: "translating",
		TRANSLATED: "translated",
		SKIPPED: "skipped",
		FAILED: "failed",
		CANCELLED: "cancelled"
	});
	assert.deepEqual(RENDER_STATUSES, {
		IDLE: "idle",
		PENDING: "pending",
		CONFIRMED: "confirmed",
		UNCONFIRMED: "unconfirmed"
	});
	assert.equal(Object.isFrozen(MESSAGE_STATUSES), true);
	assert.equal(Object.isFrozen(RENDER_STATUSES), true);
});

test("translation commits never overwrite the immutable source", () => {
	const store = createMessageStateStore();
	const source = snapshot("m1", "c1", "Hello");
	const translation = {content: "你好", metadata: {language: "zh-CN"}};
	store.captureSource(source);
	store.commitResult({...translated("m1", "c1", "Hello", translation.content), translation});

	source.source.content = "mutated outside";
	source.source.embeds[0].description = "mutated embed";
	translation.content = "mutated translation";
	translation.metadata.language = "mutated language";

	const state = store.getDisplayState("m1");
	assert.equal(state.source.content, "Hello");
	assert.equal(state.source.embeds[0].description, "Hello embed");
	assert.equal(state.translation.content, "你好");
	assert.equal(state.translation.metadata.language, "zh-CN");
	assert.equal(state.status, "translated");
	assert.equal(Object.isFrozen(state), true);
	assert.equal(Object.isFrozen(state.source), true);
	assert.equal(Object.isFrozen(state.source.embeds), true);
	assert.equal(Object.isFrozen(state.source.embeds[0]), true);
	assert.equal(Object.isFrozen(state.translation), true);
	assert.equal(Object.isFrozen(state.translation.metadata), true);
});

test("an edited source replaces stale display state", () => {
	const store = createMessageStateStore();
	store.captureSource(snapshot("m1", "c1", "Before edit"));
	store.markPending({messageId: "m1", channelId: "c1", generation: 1, origin: "automatic", requestIdentity: "request-1"});
	store.commitResult(translated("m1", "c1", "Before edit", "旧译文", 1, "automatic", "request-1"));
	const translatedRevision = store.getDisplayState("m1").revision;

	store.captureSource(snapshot("m1", "c1", "After edit"));

	const state = store.getDisplayState("m1");
	assert.equal(state.sourceSignature, "c1:m1:After edit");
	assert.equal(state.source.content, "After edit");
	assert.equal(state.translation, null);
	assert.equal(state.status, "idle");
	assert.equal(state.reason, null);
	assert.equal(state.origin, null);
	assert.equal(state.requestIdentity, null);
	assert.equal(state.renderStatus, "idle");
	assert.equal(state.renderReason, null);
	assert.equal(state.revision > translatedRevision, true);
});

test("a late result for an edited source cannot replace the newer request state", () => {
	const store = createMessageStateStore();
	store.captureSource(snapshot("m1", "c1", "Version one"));
	store.markPending({messageId: "m1", channelId: "c1", generation: 1, origin: "automatic", requestIdentity: "request-A"});
	store.captureSource(snapshot("m1", "c1", "Version two"));
	const requestB = store.markPending({messageId: "m1", channelId: "c1", generation: 1, origin: "automatic", requestIdentity: "request-B"});

	const committed = store.commitResult(translated("m1", "c1", "Version one", "late result A", 1, "automatic", "request-A"));

	assert.equal(committed, null);
	assert.equal(store.getDisplayState("m1"), requestB);
	assert.equal(requestB.source.content, "Version two");
	assert.equal(requestB.status, "pending");
	assert.equal(requestB.requestIdentity, "request-B");
	assert.equal(requestB.translation, null);
});

test("a superseded request cannot commit against an unchanged source", () => {
	const store = createMessageStateStore();
	store.captureSource(snapshot("m1", "c1", "Same source"));
	store.markPending({messageId: "m1", channelId: "c1", generation: 1, origin: "automatic", requestIdentity: "request-A"});
	const requestB = store.markPending({messageId: "m1", channelId: "c1", generation: 1, origin: "automatic", requestIdentity: "request-B"});

	assert.equal(store.commitResult(translated("m1", "c1", "Same source", "missing identity")), null);
	assert.equal(store.getDisplayState("m1"), requestB);
	assert.equal(store.commitResult(translated("m1", "c1", "Same source", "late result A", 1, "automatic", "request-A")), null);
	assert.equal(store.getDisplayState("m1"), requestB);
});

test("capturing the same source snapshot is idempotent", () => {
	const store = createMessageStateStore();
	const first = store.captureSource(snapshot("m1", "c1", "Hello"));
	const second = store.captureSource(snapshot("m1", "c1", "Hello"));

	assert.equal(second, first);
	assert.equal(second.revision, first.revision);
	assert.deepEqual(store.listChannel("c1"), [first]);
	assert.equal("records" in store, false);
	assert.equal("channelMessageIds" in store, false);
});

test("channel generations reject stale captures and commits", () => {
	const store = createMessageStateStore();
	store.captureSource(snapshot("m1", "c1", "Hello"));
	assert.equal(store.getChannelGeneration("c1"), 1);

	store.setChannelGeneration("c1", 2);

	assert.equal(store.getChannelGeneration("c1"), 2);
	assert.equal(store.captureSource(snapshot("m2", "c1", "Stale", 1)), null);
	assert.equal(store.commitResult(translated("m1", "c1", "Hello", "stale")), null);
	assert.equal(store.getDisplayState("m1").status, "idle");
	assert.equal(store.getDisplayState("m2"), null);
});

test("pending and translating transitions update request metadata and revision", () => {
	const store = createMessageStateStore();
	const captured = store.captureSource(snapshot("m1", "c1", "Hello"));
	const pending = store.markPending({
		messageId: "m1",
		channelId: "c1",
		generation: 1,
		status: "pending",
		origin: "manual",
		requestIdentity: "pending-request"
	});

	assert.equal(pending.status, "pending");
	assert.equal(pending.origin, "manual");
	assert.equal(pending.requestIdentity, "pending-request");
	assert.equal(pending.renderStatus, "pending");
	assert.equal(pending.revision > captured.revision, true);

	const translating = store.markTranslating({
		messageId: "m1",
		channelId: "c1",
		generation: 1,
		status: "translating",
		origin: "automatic",
		requestIdentity: "translating-request"
	});

	assert.equal(translating.status, "translating");
	assert.equal(translating.origin, "automatic");
	assert.equal(translating.requestIdentity, "translating-request");
	assert.equal(translating.renderStatus, "pending");
	assert.equal(translating.revision > pending.revision, true);

	store.setChannelGeneration("c1", 2);
	assert.equal(store.markPending({messageId: "m1", channelId: "c1", generation: 1, status: "pending"}), null);
	assert.equal(store.markTranslating({messageId: "m1", channelId: "c2", generation: 1, status: "translating"}), null);
	assert.equal(store.getDisplayState("m1"), translating);
});

test("markPending rejects unsupported request identities without mutating state", () => {
	for (const [label, createIdentity] of unsupportedRequestIdentities()) {
		const store = createMessageStateStore();
		const messageId = `pending-${label}`;
		const captured = store.captureSource(snapshot(messageId, "c1", "Hello"));

		const result = store.markPending({messageId, channelId: "c1", generation: 1, origin: "automatic", requestIdentity: createIdentity()});

		assert.equal(result, null, label);
		assert.equal(store.getDisplayState(messageId), captured, label);
	}
});

test("explicit markTranslating rejects unsupported request identities without mutating state", () => {
	for (const [label, createIdentity] of unsupportedRequestIdentities()) {
		const store = createMessageStateStore();
		const messageId = `translating-${label}`;
		store.captureSource(snapshot(messageId, "c1", "Hello"));
		const pending = store.markPending({messageId, channelId: "c1", generation: 1, origin: "automatic", requestIdentity: "request-A"});

		const result = store.markTranslating({messageId, channelId: "c1", generation: 1, origin: "automatic", requestIdentity: createIdentity()});

		assert.equal(result, null, label);
		assert.equal(store.getDisplayState(messageId), pending, label);
	}
});

test("terminal results reject unsupported request identities without mutating state", () => {
	for (const [label, createIdentity] of unsupportedRequestIdentities()) {
		const store = createMessageStateStore();
		const messageId = `terminal-${label}`;
		const captured = store.captureSource(snapshot(messageId, "c1", "Hello"));

		const result = store.commitResult(translated(messageId, "c1", "Hello", "你好", 1, "automatic", createIdentity()));

		assert.equal(result, null, label);
		assert.equal(store.getDisplayState(messageId), captured, label);
	}
});

test("primitive request identities normalize consistently across transitions and results", () => {
	const cases = [
		["number-to-string", 42, "42", "42"],
		["string-to-number", "7", 7, "7"],
		["bigint-to-string", 8n, "8", "8"],
		["boolean-to-string", true, "true", "true"]
	];

	for (const [label, pendingIdentity, resultIdentity, normalizedIdentity] of cases) {
		const store = createMessageStateStore();
		store.captureSource(snapshot(label, "c1", "Hello"));
		const pending = store.markPending({messageId: label, channelId: "c1", generation: 1, origin: "automatic", requestIdentity: pendingIdentity});

		assert.equal(pending.requestIdentity, normalizedIdentity, label);
		const translating = store.markTranslating({messageId: label, channelId: "c1", generation: 1, origin: "automatic"});
		assert.equal(translating.requestIdentity, normalizedIdentity, label);
		const committed = store.commitResult(translated(label, "c1", "Hello", "你好", 1, "automatic", resultIdentity));
		assert.equal(committed.status, "translated", label);
		assert.equal(committed.requestIdentity, null, label);
	}
});

test("nullish translating identities preserve active correlation", () => {
	for (const [label, requestIdentity] of [["null", null], ["undefined", undefined]]) {
		const deferredStore = createMessageStateStore();
		const deferredMessageId = `deferred-${label}`;
		deferredStore.captureSource(snapshot(deferredMessageId, "c1", "Hello"));
		const deferred = deferredStore.markPending({messageId: deferredMessageId, channelId: "c1", generation: 1, origin: "automatic", requestIdentity});
		assert.equal(deferred.requestIdentity, null, label);
		assert.equal(deferredStore.commitResult(translated(deferredMessageId, "c1", "Hello", "你好", 1, "automatic", requestIdentity)).status, "translated", label);

		const store = createMessageStateStore();
		store.captureSource(snapshot(label, "c1", "Hello"));
		store.markPending({messageId: label, channelId: "c1", generation: 1, origin: "automatic", requestIdentity: "request-A"});

		const translating = store.markTranslating({messageId: label, channelId: "c1", generation: 1, origin: "automatic", requestIdentity});

		assert.equal(translating.requestIdentity, "request-A", label);
		assert.equal(store.commitResult(translated(label, "c1", "Hello", "stale", 1, "automatic", requestIdentity)), null, label);
		assert.equal(store.getDisplayState(label), translating, label);
		assert.equal(store.commitResult(translated(label, "c1", "Hello", "你好", 1, "automatic", "request-A")).status, "translated", label);
	}
});

test("commitResult accepts only valid terminal results", () => {
	const store = createMessageStateStore();
	for (const messageId of ["translated", "skipped", "failed", "cancelled", "pending", "invalid-translation", "stale-source"]) {
		store.captureSource(snapshot(messageId, "c1", `${messageId} source`));
	}

	assert.equal(store.commitResult(translated("translated", "c1", "translated source", "译文")).status, "translated");
	assert.equal(store.commitResult({messageId: "skipped", channelId: "c1", generation: 1, sourceSignature: "c1:skipped:skipped source", origin: "automatic", status: "skipped", reason: "same-language"}).reason, "same-language");
	assert.equal(store.commitResult({messageId: "failed", channelId: "c1", generation: 1, sourceSignature: "c1:failed:failed source", origin: "automatic", status: "failed"}).reason, "failed");
	assert.equal(store.commitResult({messageId: "cancelled", channelId: "c1", generation: 1, sourceSignature: "c1:cancelled:cancelled source", origin: "automatic", status: "cancelled", reason: "queue-cancelled"}).reason, "queue-cancelled");
	assert.equal(store.commitResult({messageId: "pending", channelId: "c1", generation: 1, sourceSignature: "c1:pending:pending source", origin: "automatic", status: "pending"}), null);
	assert.equal(store.commitResult({messageId: "invalid-translation", channelId: "c1", generation: 1, sourceSignature: "c1:invalid-translation:invalid-translation source", origin: "automatic", status: "translated", translation: {content: 42}}), null);
	assert.equal(store.commitResult(translated("stale-source", "c1", "older source", "stale translation")), null);
	assert.equal(store.getDisplayState("pending").status, "idle");
	assert.equal(store.getDisplayState("invalid-translation").status, "idle");
	assert.equal(store.getDisplayState("stale-source").status, "idle");
});

test("restoreChannel changes only automatic non-cancelled records in that channel", () => {
	const store = createMessageStateStore();
	for (const [messageId, channelId, origin] of [["auto-a", "c1", "automatic"], ["manual-a", "c1", "manual"], ["auto-b", "c2", "automatic"]]) {
		store.captureSource(snapshot(messageId, channelId, `${messageId} source`));
		store.commitResult(translated(messageId, channelId, `${messageId} source`, `${messageId} translated`, 1, origin));
	}
	store.captureSource(snapshot("cancelled-a", "c1", "cancelled source"));
	store.commitResult({messageId: "cancelled-a", channelId: "c1", generation: 1, sourceSignature: "c1:cancelled-a:cancelled source", origin: "automatic", status: "cancelled", reason: "already-cancelled"});
	const cancelledRevision = store.getDisplayState("cancelled-a").revision;

	const restored = store.restoreChannel("c1");

	assert.deepEqual(restored.map(record => record.messageId), ["auto-a"]);
	assert.equal(store.getDisplayState("auto-a").status, "cancelled");
	assert.equal(store.getDisplayState("auto-a").translation, null);
	assert.equal(store.getDisplayState("auto-a").reason, "channel-disabled");
	assert.equal(store.getDisplayState("auto-a").renderStatus, "pending");
	assert.equal(store.getDisplayState("manual-a").translation.content, "manual-a translated");
	assert.equal(store.getDisplayState("auto-b").translation.content, "auto-b translated");
	assert.equal(store.getDisplayState("cancelled-a").reason, "already-cancelled");
	assert.equal(store.getDisplayState("cancelled-a").revision, cancelledRevision);
});

test("restoreAll changes only automatic non-cancelled records", () => {
	const store = createMessageStateStore();
	store.captureSource(snapshot("translated-auto", "c1", "One"));
	store.commitResult(translated("translated-auto", "c1", "One", "一"));
	store.captureSource(snapshot("pending-auto", "c2", "Two"));
	store.markPending({messageId: "pending-auto", channelId: "c2", generation: 1, origin: "automatic", requestIdentity: "request-2"});
	store.captureSource(snapshot("translated-manual", "c2", "Three"));
	store.commitResult(translated("translated-manual", "c2", "Three", "三", 1, "manual"));
	store.captureSource(snapshot("cancelled-auto", "c3", "Four"));
	store.commitResult({messageId: "cancelled-auto", channelId: "c3", generation: 1, sourceSignature: "c3:cancelled-auto:Four", origin: "automatic", status: "cancelled", reason: "already-cancelled"});
	const cancelledRevision = store.getDisplayState("cancelled-auto").revision;

	const restored = store.restoreAll("plugin-stopped");

	assert.deepEqual(restored.map(record => record.messageId), ["translated-auto", "pending-auto"]);
	for (const messageId of ["translated-auto", "pending-auto"]) {
		const state = store.getDisplayState(messageId);
		assert.equal(state.status, "cancelled");
		assert.equal(state.translation, null);
		assert.equal(state.reason, "plugin-stopped");
		assert.equal(state.renderStatus, "pending");
	}
	assert.equal(store.getDisplayState("translated-manual").translation.content, "三");
	assert.equal(store.getDisplayState("cancelled-auto").revision, cancelledRevision);
});

test("commitBatch is all-or-nothing when one result is stale", () => {
	const store = createMessageStateStore();
	store.captureSource(snapshot("m1", "c1", "One"));
	store.captureSource(snapshot("m2", "c1", "Two"));
	const revisions = [store.getDisplayState("m1").revision, store.getDisplayState("m2").revision];

	const outcome = store.commitBatch([
		translated("m1", "c1", "One", "一"),
		translated("m2", "c1", "Two", "二", 0)
	]);

	assert.deepEqual(outcome.committed, []);
	assert.deepEqual(outcome.rejected.map(result => result.messageId), ["m2"]);
	assert.equal(store.getDisplayState("m1").status, "idle");
	assert.equal(store.getDisplayState("m2").status, "idle");
	assert.deepEqual([store.getDisplayState("m1").revision, store.getDisplayState("m2").revision], revisions);
});

test("commitBatch rejects a stale request without applying valid sibling results", () => {
	const store = createMessageStateStore();
	store.captureSource(snapshot("m1", "c1", "One"));
	store.captureSource(snapshot("m2", "c1", "Two"));
	const requestB = store.markPending({messageId: "m2", channelId: "c1", generation: 1, origin: "automatic", requestIdentity: "request-B"});
	const m1Revision = store.getDisplayState("m1").revision;

	const outcome = store.commitBatch([
		translated("m1", "c1", "One", "一"),
		translated("m2", "c1", "Two", "late result A", 1, "automatic", "request-A")
	]);

	assert.deepEqual(outcome.committed, []);
	assert.deepEqual(outcome.rejected.map(result => result.messageId), ["m2"]);
	assert.equal(store.getDisplayState("m1").status, "idle");
	assert.equal(store.getDisplayState("m1").revision, m1Revision);
	assert.equal(store.getDisplayState("m2"), requestB);
});

test("commitBatch rejects mixed-channel input without committing any result", () => {
	const store = createMessageStateStore();
	store.captureSource(snapshot("m1", "c1", "One"));
	store.captureSource(snapshot("m2", "c2", "Two"));
	const results = [translated("m1", "c1", "One", "一"), translated("m2", "c2", "Two", "二")];

	const outcome = store.commitBatch(results);

	assert.deepEqual(outcome.committed, []);
	assert.deepEqual(outcome.rejected, results);
	assert.equal(store.getDisplayState("m1").status, "idle");
	assert.equal(store.getDisplayState("m2").status, "idle");
});

test("commitBatch accepts one valid channel and treats empty input as a no-op", () => {
	const store = createMessageStateStore();
	store.captureSource(snapshot("m1", "c1", "One"));
	store.captureSource(snapshot("m2", "c1", "Two"));
	const revisionBeforeEmpty = store.getDisplayState("m2").revision;

	assert.deepEqual(store.commitBatch([]), {committed: [], rejected: []});
	assert.equal(store.getDisplayState("m2").revision, revisionBeforeEmpty);

	const outcome = store.commitBatch([translated("m1", "c1", "One", "一"), translated("m2", "c1", "Two", "二")]);
	assert.deepEqual(outcome.rejected, []);
	assert.deepEqual(outcome.committed.map(record => record.messageId), ["m1", "m2"]);
	assert.equal(store.getDisplayState("m1").translation.content, "一");
	assert.equal(store.getDisplayState("m2").translation.content, "二");
});

test("render acknowledgement does not create a new display revision", () => {
	const store = createMessageStateStore();
	store.captureSource(snapshot("m1", "c1", "Hello"));
	store.commitResult(translated("m1", "c1", "Hello", "你好"));
	const revision = store.getDisplayState("m1").revision;

	store.markRenderOutcome({confirmedIds: [], missingIds: ["m1"]});
	assert.equal(store.getDisplayState("m1").revision, revision);
	assert.equal(store.getDisplayState("m1").renderStatus, "unconfirmed");
	assert.equal(store.getDisplayState("m1").renderReason, "render-unconfirmed");

	store.markRenderOutcome({confirmedIds: ["m1"], missingIds: []});
	assert.equal(store.getDisplayState("m1").revision, revision);
	assert.equal(store.getDisplayState("m1").renderStatus, "confirmed");
	assert.equal(store.getDisplayState("m1").renderReason, null);
});

test("a message identity cannot be silently moved to another channel", () => {
	const store = createMessageStateStore();
	const original = store.captureSource(snapshot("m1", "c1", "Channel one"));

	assert.equal(store.captureSource(snapshot("m1", "c2", "Channel two")), null);
	assert.equal(store.getDisplayState("m1"), original);
	assert.deepEqual(store.listChannel("c1"), [original]);
	assert.deepEqual(store.listChannel("c2"), []);
	assert.equal(store.getChannelGeneration("c2"), undefined);

	store.setChannelGeneration("c2", 1);
	assert.equal(store.commitResult(translated("m1", "c2", "Channel two", "wrong channel")), null);
	assert.equal(store.getDisplayState("m1"), original);
});

test("releasePending returns a matching pending request to idle without display change", () => {
	const store = createMessageStateStore();
	store.captureSource(snapshot("m1", "c1", "Hello"));
	store.markPending({messageId: "m1", channelId: "c1", generation: 1, origin: "automatic", requestIdentity: "request-1"});

	const released = store.releasePending({messageId: "m1", channelId: "c1", requestIdentity: "request-1"});

	assert.equal(released.status, "idle");
	assert.equal(released.requestIdentity, null);
	assert.equal(released.translation, null);
	assert.equal(store.getDisplayState("m1").status, "idle");
});

test("releasePending ignores mismatched identities and terminal records", () => {
	const store = createMessageStateStore();
	store.captureSource(snapshot("m1", "c1", "Hello"));
	store.markPending({messageId: "m1", channelId: "c1", generation: 1, origin: "automatic", requestIdentity: "request-1"});

	assert.equal(store.releasePending({messageId: "m1", channelId: "c1", requestIdentity: "request-other"}), null);
	assert.equal(store.getDisplayState("m1").status, "pending");

	store.commitResult({messageId: "m1", channelId: "c1", generation: 1, sourceSignature: "c1:m1:Hello", requestIdentity: "request-1", origin: "automatic", status: "translated", translation: {content: "你好"}});
	assert.equal(store.releasePending({messageId: "m1", channelId: "c1", requestIdentity: "request-1"}), null);
	assert.equal(store.getDisplayState("m1").status, "translated");
});

test("restoreMessage cancels one automatic record and leaves manual-origin records alone", () => {
	const store = createMessageStateStore();
	store.captureSource(snapshot("m1", "c1", "Hello"));
	store.commitResult({messageId: "m1", channelId: "c1", generation: 1, sourceSignature: "c1:m1:Hello", origin: "automatic", status: "translated", translation: {content: "你好"}});

	const restored = store.restoreMessage("m1");

	assert.equal(restored.length, 1);
	assert.equal(store.getDisplayState("m1").status, "cancelled");
	assert.equal(store.getDisplayState("m1").reason, "manual-untranslate");
	assert.equal(store.getDisplayState("m1").translation, null);
	assert.deepEqual(store.restoreMessage("missing"), []);
	assert.deepEqual(store.restoreMessage("m1"), []);
});
