const test = require("node:test");
const assert = require("node:assert/strict");
const {createPluginInstance} = require("../helpers/createPluginInstance");

const CHANNEL = "terminal-quality-channel";
const SOURCE = "Please send the updated meeting notes tomorrow.";
const TARGET = "请明天发送更新后的会议记录。";
const messageOf = (content = SOURCE) => ({id: "620001", channel_id: CHANNEL, content, embeds: [], attachments: [], author: {id: "fixture-other"}});

// Real translation pipeline, validation, cache, display store and terminal ledger.
// Only external translation transport and host persistence/timers are replaced.
function createHarness() {
	const calls = [], disk = {}, timers = new Map(), messages = new Map();
	let timerId = 0;
	const plugin = createPluginInstance({
		pluginPath: process.env.DTA_PLUGIN_PATH || undefined,
		settings: {engines: {translator: "googleapi", backup: "----"}, filters: {minimumAutoTranslateLength: 1, useLocalLanguagePrecheck: false, skipMixedReceivedMessages: false}, choices: {received: {input: "en", output: "zh-CN"}}},
		bdfdb: {
			LibraryStores: {MessageStore: {getMessage: (channelId, messageId) => messages.get(channelId + ":" + messageId) || null}},
			TimeUtils: {interval: callback => {timers.set(++timerId, callback); return timerId;}, timeout: callback => {timers.set(++timerId, callback); return timerId;}, clear: id => timers.delete(id)},
			DataUtils: {load: (_owner, key) => disk[key] || {}, save: (value, _owner, key) => {disk[key] = JSON.parse(JSON.stringify(value));}}
		}
	});
	plugin.googleApiTranslate = (data, callback) => calls.push({data, callback});
	function capture(message) {
		const channelId = message.channel_id || CHANNEL;
		messages.set(channelId + ":" + message.id, message);
		const original = plugin.extractOriginalContentData(message), signature = plugin.createReceivedTranslationSignature(message, channelId, original);
		plugin.ensureReceivedDisplayRuntime().captureSource({messageId: message.id, channelId, generation: plugin.getReceivedDisplayCommitGeneration(channelId), sourceSignature: signature, source: original});
		return signature;
	}
	return {plugin, calls, disk, messages, capture, async stop() {await Promise.resolve(plugin.onStop());}, async close() {await Promise.resolve(plugin.onStop()); for (const call of calls) call.callback(""); assert.equal(timers.size, 0, "all host-managed timers are retired after transport settles");}};
}

test("3 terminal gate: a current automatic response commits the real display, cache and translated terminal", async () => {
	const h = createHarness(), message = messageOf();
	try {
		h.capture(message);
		const pending = h.plugin.translateMessage(message, {id: CHANNEL}, {auto: true, silent: true, trackBusy: false});
		assert.equal(h.calls.length, 1);
		h.calls[0].callback(TARGET);
		assert.equal(await pending, true);
		assert.equal(h.plugin.getReceivedDisplayRuntimeView(message.id).translation.translatedContent, TARGET);
		assert.equal(h.plugin.getCachedReceivedTranslation(message, CHANNEL, h.plugin.extractOriginalContentData(message)).translatedContent, TARGET);
		const ledger = h.plugin.getTranslationTerminalLedgerSnapshot();
		assert.equal(ledger.activeRouteCount, 0);
		assert.deepEqual(ledger.recent.map(route => [route.outcome, route.reason]), [["translated", "committed"]]);
	}
	finally {await h.close();}
});


test("3 terminal gate: an edited source rejects its late automatic response without cache or translated terminal", async () => {
	const h = createHarness(), message = messageOf();
	try {
		h.capture(message);
		const pending = h.plugin.translateMessage(message, {id: CHANNEL}, {auto: true, silent: true, trackBusy: false});
		assert.equal(h.calls.length, 1);
		const edited = messageOf("Please send the final budget next week.");
		const editedSignature = h.capture(edited);
		assert.equal(h.plugin.invalidateLiveTranslationMessage(message.id, CHANNEL, editedSignature), true);
		h.calls[0].callback(TARGET);
		assert.equal(await pending, false);
		const view = h.plugin.getReceivedDisplayRuntimeView(message.id);
		assert.equal(view.translated, false);
		assert.equal(view.content, edited.content);
		assert.equal(h.plugin.hasCachedTranslationEntry(message.id), false);
		const ledger = h.plugin.getTranslationTerminalLedgerSnapshot();
		assert.equal(ledger.activeRouteCount, 0);
		assert.deepEqual(ledger.recent.map(route => [route.outcome, route.reason]), [["stale", "stale_after_provider"]]);
	}
	finally {await h.close();}
});


test("3 terminal gate: an edited source rejects its late manual response without cache or translated terminal", async () => {
	const h = createHarness(), message = messageOf();
	try {
		h.capture(message);
		const pending = h.plugin.translateMessage(message, {id: CHANNEL}, {manual: true, silent: true, trackBusy: false});
		assert.equal(h.calls.length, 1);
		const edited = messageOf("Please send the final budget next week.");
		h.plugin.invalidateLiveTranslationMessage(message.id, CHANNEL, h.capture(edited));
		h.messages.set(CHANNEL + ":" + message.id, message); // Display has the edit before MessageStore catches up.
		h.calls[0].callback(TARGET);
		assert.equal(await pending, false, "an obsolete manual response is not a completed translation");
		const view = h.plugin.getReceivedDisplayRuntimeView(message.id);
		assert.equal(view.translated, false);
		assert.equal(view.content, edited.content);
		assert.equal(h.plugin.hasCachedTranslationEntry(message.id), false);
		const ledger = h.plugin.getTranslationTerminalLedgerSnapshot();
		assert.equal(ledger.activeRouteCount, 0);
		assert.equal(ledger.recent.length, 1);
		assert.ok(["stale", "cancelled"].includes(ledger.recent[0].outcome));
		assert.notEqual(ledger.recent[0].cacheWrite, "translation");
	}
	finally {await h.close();}
});


for (const mode of ["auto", "manual"]) test("3 terminal gate: deletion retires a pending " + mode + " response and does not resurrect display or cache", async () => {
	const h = createHarness(), message = messageOf();
	try {
		h.capture(message);
		const pending = h.plugin.translateMessage(message, {id: CHANNEL}, {[mode]: true, silent: true, trackBusy: false});
		assert.equal(h.calls.length, 1);
		h.messages.delete(CHANNEL + ":" + message.id);
		await h.plugin.handleMessageDeletionAction({type: "MESSAGE_DELETE", channelId: CHANNEL, id: message.id});
		assert.equal(h.plugin.getReceivedDisplayRuntimeView(message.id), null);
		h.calls[0].callback(TARGET);
		const completed = await pending;
		const ledger = h.plugin.getTranslationTerminalLedgerSnapshot();
		assert.deepEqual({completed, view: h.plugin.getReceivedDisplayRuntimeView(message.id), cached: h.plugin.hasCachedTranslationEntry(message.id), translatedRoutes: ledger.recent.filter(route => route.outcome === "translated").length}, {completed: false, view: null, cached: false, translatedRoutes: 0});
		assert.equal(ledger.activeRouteCount, 0);
		assert.equal(ledger.recent.length, 1);
		assert.ok(["stale", "cancelled"].includes(ledger.recent[0].outcome));
	}
	finally {await h.close();}
});


test("3 terminal gate: a superseded automatic success cannot replace the newer committed translation", async () => {
	const h = createHarness(), original = messageOf(), edited = messageOf("Please send the final budget next week.");
	const newerTarget = "请下周发送最终预算。";
	try {
		h.capture(original);
		const older = h.plugin.translateMessage(original, {id: CHANNEL}, {auto: true, silent: true, trackBusy: false});
		h.capture(edited);
		const newer = h.plugin.translateMessage(edited, {id: CHANNEL}, {auto: true, silent: true, trackBusy: false});
		assert.equal(h.calls.length, 2);
		h.calls[1].callback(newerTarget);
		assert.equal(await newer, true);
		h.calls[0].callback(TARGET);
		h.calls[0].callback(TARGET);
		assert.equal(await older, false);
		assert.equal(h.plugin.getReceivedDisplayRuntimeView(edited.id).translation.translatedContent, newerTarget);
		assert.equal(h.plugin.getCachedReceivedTranslation(edited, CHANNEL, h.plugin.extractOriginalContentData(edited)).translatedContent, newerTarget);
		const ledger = h.plugin.getTranslationTerminalLedgerSnapshot();
		assert.equal(ledger.activeRouteCount, 0);
		assert.equal(ledger.recent.length, 2, "duplicate provider callbacks do not add terminals");
		assert.deepEqual(ledger.recent.map(route => route.outcome).sort(), ["stale", "translated"]);
	}
	finally {await h.close();}
});


for (const mutation of ["store-replacement", "in-place-edit"]) test("3 terminal gate: manual " + mutation + " is rejected before rendering catches up", async () => {
	const h = createHarness(), message = messageOf();
	try {
		h.capture(message);
		const pending = h.plugin.translateMessage(message, {id: CHANNEL}, {manual: true, silent: true, trackBusy: false});
		assert.equal(h.calls.length, 1);
		if (mutation === "store-replacement") h.messages.set(CHANNEL + ":" + message.id, messageOf("Please send the final budget next week."));
		else message.content = "Please send the final budget next week.";
		h.calls[0].callback(TARGET);
		assert.equal(await pending, false);
		assert.equal(h.plugin.getReceivedDisplayRuntimeView(message.id).translated, false);
		assert.equal(h.plugin.hasCachedTranslationEntry(message.id), false);
		const ledger = h.plugin.getTranslationTerminalLedgerSnapshot();
		assert.equal(ledger.activeRouteCount, 0);
		assert.equal(ledger.recent.length, 1);
		assert.ok(["stale", "cancelled"].includes(ledger.recent[0].outcome));
	}
	finally {await h.close();}
});

test("3 terminal gate: deletion also retires a manual request with no previously captured display row", async () => {
	const h = createHarness(), message = messageOf();
	try {
		h.messages.set(CHANNEL + ":" + message.id, message);
		assert.equal(h.plugin.getReceivedDisplayRuntimeView(message.id), null);
		const pending = h.plugin.translateMessage(message, {id: CHANNEL}, {manual: true, silent: true, trackBusy: false});
		assert.equal(h.calls.length, 1);
		h.messages.delete(CHANNEL + ":" + message.id);
		await h.plugin.handleMessageDeletionAction({type: "MESSAGE_DELETE", channelId: CHANNEL, id: message.id});
		h.calls[0].callback(TARGET);
		assert.equal(await pending, false);
		assert.equal(h.plugin.getReceivedDisplayRuntimeView(message.id), null);
		assert.equal(h.plugin.hasCachedTranslationEntry(message.id), false);
		const ledger = h.plugin.getTranslationTerminalLedgerSnapshot();
		assert.equal(ledger.activeRouteCount, 0);
		assert.equal(ledger.recent.length, 1);
		assert.ok(["stale", "cancelled"].includes(ledger.recent[0].outcome));
	}
	finally {await h.close();}
});


test("3 terminal gate: deleting one manual request does not cancel the same message id in another channel", async () => {
	const h = createHarness(), first = messageOf(), otherChannel = "terminal-quality-other-channel";
	const second = Object.assign(messageOf(), {channel_id: otherChannel});
	try {
		h.messages.set(CHANNEL + ":" + first.id, first);
		h.messages.set(otherChannel + ":" + second.id, second);
		const older = h.plugin.translateMessage(first, {id: CHANNEL}, {manual: true, silent: true, trackBusy: false});
		const other = h.plugin.translateMessage(second, {id: otherChannel}, {manual: true, silent: true, trackBusy: false});
		assert.equal(h.calls.length, 2);
		h.messages.delete(CHANNEL + ":" + first.id);
		await h.plugin.handleMessageDeletionAction({type: "MESSAGE_DELETE", channelId: CHANNEL, id: first.id});
		h.calls[0].callback(TARGET);
		assert.equal(await older, false);
		const store = h.plugin.ensureSentTranslationStore();
		assert.equal(store.hasManualRequest(store.createManualRequestKey(otherChannel, second.id)), true, "releasing the old channel receipt leaves the other request active");
		h.calls[1].callback(TARGET);
		assert.equal(await other, true);
		const view = h.plugin.getReceivedDisplayRuntimeView(second.id);
		assert.equal(view.channelId, otherChannel);
		assert.equal(view.translation.translatedContent, TARGET);
		const ledger = h.plugin.getTranslationTerminalLedgerSnapshot();
		assert.equal(ledger.activeRouteCount, 0);
		assert.equal(ledger.recent.length, 2);
		assert.equal(ledger.recent.filter(route => route.outcome === "translated").length, 1);
	}
	finally {await h.close();}
});

for (const mode of ["auto", "manual"]) test("3 terminal gate: plugin stop cancels " + mode + " work before a late and duplicate response", async () => {
	const h = createHarness(), message = messageOf();
	try {
		h.capture(message);
		const pending = h.plugin.translateMessage(message, {id: CHANNEL}, {[mode]: true, silent: true, trackBusy: false});
		assert.equal(h.calls.length, 1);
		await h.stop();
		h.calls[0].callback(TARGET);
		h.calls[0].callback(TARGET);
		assert.equal(await pending, false);
		const view = h.plugin.getReceivedDisplayRuntimeView(message.id);
		assert.ok(!view || !view.translated);
		assert.equal(h.plugin.hasCachedTranslationEntry(message.id), false);
		const ledger = h.plugin.getTranslationTerminalLedgerSnapshot();
		assert.equal(ledger.activeRouteCount, 0);
		assert.equal(ledger.recent.length, 1);
		assert.equal(ledger.recent.filter(route => route.outcome === "translated").length, 0);
	}
	finally {await h.close();}
});


test("3 terminal gate: a current manual click without a mounted row still succeeds while automatic translation is disabled", async () => {
	const h = createHarness(), message = messageOf();
	try {
		h.plugin.isTranslationEnabled = () => false;
		const pending = h.plugin.translateMessage(message, {id: CHANNEL}, {manual: true, independentOfTextAreaSwitch: true, silent: true, trackBusy: false});
		assert.equal(h.calls.length, 1);
		h.calls[0].callback(TARGET);
		assert.equal(await pending, true);
		assert.equal(h.plugin.getReceivedDisplayRuntimeView(message.id).translation.translatedContent, TARGET);
		assert.equal(h.plugin.getCachedReceivedTranslation(message, CHANNEL, h.plugin.extractOriginalContentData(message)).translatedContent, TARGET);
		const ledger = h.plugin.getTranslationTerminalLedgerSnapshot();
		assert.equal(ledger.activeRouteCount, 0);
		assert.deepEqual(ledger.recent.map(route => [route.outcome, route.reason]), [["translated", "manual_applied"]]);
	}
	finally {await h.close();}
});

test("3 terminal gate: a retired manual receipt cannot release its newer request under the same key", async () => {
	const h = createHarness(), original = messageOf(), replacement = messageOf("Please send the final budget next week.");
	const nextTarget = "请下周发送最终预算。";
	try {
		h.capture(original);
		const older = h.plugin.translateMessage(original, {id: CHANNEL}, {manual: true, silent: true, trackBusy: false});
		h.messages.delete(CHANNEL + ":" + original.id);
		await h.plugin.handleMessageDeletionAction({type: "MESSAGE_DELETE", channelId: CHANNEL, id: original.id});
		// A fresh local row/request under the same key exercises receipt identity reuse.
		// It is not an assertion that Discord reuses deleted snowflakes.
		h.capture(replacement);
		const newer = h.plugin.translateMessage(replacement, {id: CHANNEL}, {manual: true, silent: true, trackBusy: false});
		assert.equal(h.calls.length, 2);
		h.calls[0].callback(TARGET);
		assert.equal(await older, false);
		const store = h.plugin.ensureSentTranslationStore(), key = store.createManualRequestKey(CHANNEL, replacement.id);
		assert.equal(store.hasManualRequest(key), true);
		h.calls[1].callback(nextTarget);
		assert.equal(await newer, true);
		assert.equal(store.hasManualRequest(key), false);
		assert.equal(h.plugin.getReceivedDisplayRuntimeView(replacement.id).translation.translatedContent, nextTarget);
		assert.equal(h.plugin.getCachedReceivedTranslation(replacement, CHANNEL, h.plugin.extractOriginalContentData(replacement)).translatedContent, nextTarget);
		const ledger = h.plugin.getTranslationTerminalLedgerSnapshot();
		assert.equal(ledger.activeRouteCount, 0);
		assert.equal(ledger.recent.length, 2);
		assert.equal(ledger.recent.filter(route => route.outcome === "translated").length, 1);
	}
	finally {await h.close();}
});


test("3 terminal gate: an older display snapshot present before a fresh manual click does not reject its current source", async () => {
	const h = createHarness(), stale = messageOf(), current = messageOf("Please send the final budget next week.");
	const currentTarget = "请下周发送最终预算。";
	try {
		h.capture(stale);
		h.messages.set(CHANNEL + ":" + current.id, current);
		const pending = h.plugin.translateMessage(current, {id: CHANNEL}, {manual: true, silent: true, trackBusy: false});
		assert.equal(h.calls.length, 1);
		h.calls[0].callback(currentTarget);
		assert.equal(await pending, true, "the display lag predates this request and is not an in-flight edit");
		assert.equal(h.plugin.getReceivedDisplayRuntimeView(current.id).translation.translatedContent, currentTarget);
		assert.equal(h.plugin.getCachedReceivedTranslation(current, CHANNEL, h.plugin.extractOriginalContentData(current)).translatedContent, currentTarget);
		const ledger = h.plugin.getTranslationTerminalLedgerSnapshot();
		assert.equal(ledger.activeRouteCount, 0);
		assert.deepEqual(ledger.recent.map(route => [route.outcome, route.reason]), [["translated", "manual_applied"]]);
	}
	finally {await h.close();}
});

test("3 terminal gate: editing the request object is rejected even while MessageStore retains an independent original copy", async () => {
	const h = createHarness(), message = messageOf();
	try {
		h.capture(message);
		h.messages.set(CHANNEL + ":" + message.id, messageOf());
		const pending = h.plugin.translateMessage(message, {id: CHANNEL}, {manual: true, silent: true, trackBusy: false});
		assert.equal(h.calls.length, 1);
		message.content = "Please send the final budget next week.";
		h.calls[0].callback(TARGET);
		assert.equal(await pending, false);
		assert.equal(h.plugin.getReceivedDisplayRuntimeView(message.id).translated, false);
		assert.equal(h.plugin.hasCachedTranslationEntry(message.id), false);
		const ledger = h.plugin.getTranslationTerminalLedgerSnapshot();
		assert.equal(ledger.activeRouteCount, 0);
		assert.equal(ledger.recent.length, 1);
		assert.ok(["stale", "cancelled"].includes(ledger.recent[0].outcome));
	}
	finally {await h.close();}
});
