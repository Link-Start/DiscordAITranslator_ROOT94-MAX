const test = require("node:test");
const assert = require("node:assert/strict");
const {createHarness} = require("../helpers/createReceivedDisplayHarness");

function snapshot(messageId, channelId, content = `${messageId} original`) {
	return {messageId, channelId, generation: 1, sourceSignature: `${channelId}:${messageId}:${content}`, source: {content, embeds: []}};
}

function result(messageId, channelId, content = `${messageId} translated`, generation = 1, origin = "automatic") {
	return {
		messageId,
		channelId,
		generation,
		origin,
		sourceSignature: `${channelId}:${messageId}:${messageId} original`,
		status: "translated",
		translation: {content, auto: origin === "automatic"}
	};
}

function createDeferred() {
	let resolve;
	let reject;
	const promise = new Promise((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return {promise, resolve, reject};
}

test("disabling a channel restores automatic and manual originals in one targeted refresh", async () => {
	const harness = createHarness();
	try {
		const {plugin, calls} = harness;
		delete plugin.isTranslationEnabled;
		plugin.setChannelEnablementStateValue("channel-a", true);
		plugin.setChannelEnablementStateValue("channel-b", true);
		for (const [messageId, channelId, origin] of [["message-1", "channel-a", "automatic"], ["message-2", "channel-a", "manual"], ["message-3", "channel-b", "automatic"]]) {
			plugin.captureReceivedMessageSource(snapshot(messageId, channelId));
			await plugin.commitReceivedDisplayResult(result(messageId, channelId, `${messageId} translated`, 1, origin));
		}
		const runtime = plugin.ensureReceivedDisplayRuntime();
		runtime.suppress("message-1");
		runtime.suppress("message-3");
		const updatesBeforeDisable = calls.forceUpdate;

		await plugin.toggleTranslation("channel-a");

		assert.equal(plugin.getReceivedDisplayView("message-1").content, "message-1 original");
		assert.equal(plugin.getReceivedDisplayView("message-2").content, "message-2 original");
		assert.equal(plugin.getReceivedDisplayView("message-3").content, "message-3 translated");
		assert.equal(runtime.isSuppressed("message-1"), false);
		assert.equal(runtime.isSuppressed("message-3"), true);
		assert.equal(calls.forceUpdate, updatesBeforeDisable + 1);
		assert.deepEqual(calls.forceUpdateBatches.at(-1), ["message-1", "message-2"]);
		assert.equal(calls.rerenderAll, 0);
	}
	finally {harness.restore();}
});

test("disable restoration removes text and decoration under the same revision", async () => {
	const harness = createHarness();
	try {
		const {plugin} = harness;
		plugin.captureReceivedMessageSource(snapshot("message-1", "channel-a"));
		await plugin.commitReceivedDisplayResult(result("message-1", "channel-a"));
		await plugin.restoreReceivedDisplayChannel("channel-a");
		const view = plugin.getReceivedDisplayView("message-1");
		const stream = {content: {id: "message-1", channel_id: "channel-a", content: "message-1 translated", embeds: []}};
		const event = {instance: {props: {message: stream.content}}, returnvalue: {props: {children: [], className: "translator-translated-message", style: {"--translator-text-color": "#fff", "--translator-accent-color": "#fff"}}}};

		plugin.applyReceivedDisplayViewToStream(stream, view);
		plugin.applyReceivedDisplayViewToContent(event, view);

		assert.equal(stream.content.content, "message-1 original");
		assert.equal(event.returnvalue.props["data-translator-revision"], String(view.revision));
		assert.doesNotMatch(event.returnvalue.props.className, /translator-translated-message/);
		assert.equal(event.returnvalue.props.style["--translator-text-color"], undefined);
		assert.equal(event.returnvalue.props.style["--translator-accent-color"], undefined);
		assert.equal(event.returnvalue.props.children.some(child => child && child.key === "translator-translated-watermark"), false);
	}
	finally {harness.restore();}
});

test("disabling clears a preview-only translation by refreshing its replying host row", async () => {
	const harness = createHarness({mountedMessageIds: ["reply-message"]});
	try {
		const {plugin, calls} = harness;
		delete plugin.isTranslationEnabled;
		plugin.setChannelEnablementStateValue("channel-a", true);
		plugin.settings.general.showOriginalInReplyPreview = true;
		const runtime = plugin.ensureReceivedDisplayRuntime();
		runtime.capturePreviewSource({messageId: "referenced-message", channelId: "channel-a", sourceSignature: "preview-source", source: {content: "original preview", embeds: []}});
		runtime.commitPreviewResult({messageId: "referenced-message", channelId: "channel-a", signature: "preview-signature", translation: {content: "translated preview", translatedContent: "translated preview", originalContent: "original preview", channelId: "channel-a", auto: true}});
		const event = {instance: {props: {
			referencedMessage: {message: {id: "referenced-message", channel_id: "channel-a", content: "original preview"}},
			baseMessage: {id: "reply-message", channel_id: "channel-a", content: "reply"}
		}}};
		plugin.processMessageReply(event);
		assert.equal(event.instance.props.referencedMessage.message.content, "translated preview");
		const updatesBeforeDisable = calls.forceUpdate;

		await plugin.toggleTranslation("channel-a");
		plugin.processMessageReply(event);

		assert.equal(event.instance.props.referencedMessage.message.content, "original preview");
		assert.equal(runtime.getPreviewTranslation("referenced-message"), null);
		assert.equal(calls.forceUpdate, updatesBeforeDisable + 1, "preview cleanup must join the one disable refresh");
		assert.deepEqual(calls.forceUpdateBatches.at(-1), ["reply-message"], "the preview is painted by the replying row, not the referenced row");
	}
	finally {harness.restore();}
});

test("disabling restores an already-painted manual reply preview", async () => {
	const harness = createHarness({mountedMessageIds: ["reply-message"]});
	try {
		const {plugin} = harness;
		delete plugin.isTranslationEnabled;
		plugin.setChannelEnablementStateValue("channel-a", true);
		const referencedMessage = {id: "referenced-message", channel_id: "channel-a", content: "original preview", embeds: [], author: {id: "other-user"}};
		plugin.applyStoredTranslationToMessage(referencedMessage, {
			channelId: "channel-a",
			auto: false,
			manual: true,
			content: "手动预览译文",
			translatedContent: "手动预览译文",
			originalContent: "original preview",
			embeds: {}
		});
		const event = {instance: {props: {
			referencedMessage: {message: referencedMessage},
			baseMessage: {id: "reply-message", channel_id: "channel-a", content: "reply"}
		}}};
		plugin.processMessageReply(event);
		assert.equal(event.instance.props.referencedMessage.message.content, "手动预览译文");

		await plugin.toggleTranslation("channel-a");
		plugin.processMessageReply(event);

		assert.equal(event.instance.props.referencedMessage.message.content, "original preview");
	}
	finally {harness.restore();}
});

test("plugin stop restores automatic records before requesting the final rerender", async () => {
	const harness = createHarness();
	try {
		const {plugin} = harness;
		plugin.captureReceivedMessageSource(snapshot("message-1", "channel-a"));
		await plugin.commitReceivedDisplayResult(result("message-1", "channel-a"));
		const order = [];
		const restoreAll = plugin.restoreAllReceivedDisplay.bind(plugin);
		plugin.restoreAllReceivedDisplay = options => {order.push("restore"); return restoreAll(options);};
		plugin._testBdfdb.MessageUtils.rerenderAll = instant => {order.push(`rerender:${instant}`);};
		plugin.cancelHistoricalTranslationJobs = () => {};
		plugin.clearChannelTitleTranslations = () => {};
		plugin.detachAutoTranslationInputActivityWatcher = () => {};
		plugin.detachAutoTranslationScrollWatcher = () => {};
		plugin.clearDisplayedTranslations = () => {order.push("legacy-clear");};
		plugin.clearLoadedAutoTranslationStatus = () => {};
		plugin.forceUpdateAll = () => {throw new Error("onStop must not reload settings while restoring display");};

		plugin.onStop();

		assert.deepEqual(order.slice(0, 3), ["restore", "legacy-clear", "rerender:true"]);
		assert.equal(plugin.getReceivedDisplayView("message-1").content, "message-1 original");
	}
	finally {harness.restore();}
});

test("a late provider callback cannot recreate a restored automatic record", async () => {
	const harness = createHarness();
	try {
		const {plugin} = harness;
		plugin.captureReceivedMessageSource(snapshot("message-1", "channel-a"));
		plugin.setReceivedDisplayGeneration("channel-a", 2);
		await plugin.restoreReceivedDisplayChannel("channel-a");

		const outcome = await plugin.commitReceivedDisplayResult(result("message-1", "channel-a", "late translation", 1));

		assert.deepEqual(outcome.rejectedIds, ["message-1"]);
		assert.equal(plugin.getReceivedDisplayView("message-1").content, "message-1 original");
	}
	finally {harness.restore();}
});

test("channel disable rejects a late commit through the incremented generation", async () => {
	const harness = createHarness();
	try {
		const {plugin} = harness;
		delete plugin.isTranslationEnabled;
		plugin.setChannelEnablementStateValue("channel-a", true);
		plugin.captureReceivedMessageSource(snapshot("message-1", "channel-a"));

		await plugin.toggleTranslation("channel-a");
		const outcome = await plugin.commitReceivedDisplayResult(result("message-1", "channel-a", "late translation", 1));

		assert.deepEqual(outcome.rejectedIds, ["message-1"]);
		assert.equal(plugin.getReceivedDisplayGeneration("channel-a"), 2);
		assert.equal(plugin.getReceivedDisplayView("message-1").content, "message-1 original");
	}
	finally {harness.restore();}
});

test("plugin start replaces the stopped display runtime", async () => {
	const harness = createHarness();
	try {
		const {plugin} = harness;
		plugin.captureReceivedMessageSource(snapshot("message-1", "channel-a"));
		await plugin.commitReceivedDisplayResult(result("message-1", "channel-a"));
		let resetCount = 0;
		const reset = plugin.resetReceivedDisplayRuntime.bind(plugin);
		plugin.resetReceivedDisplayRuntime = () => {resetCount++; return reset();};
		plugin.attachAutoTranslationInputActivityWatcher = () => {};
		plugin.forceUpdateAll = () => {};

		plugin.onStart();

		assert.equal(resetCount, 1);
		assert.equal(plugin.getReceivedDisplayView("message-1"), null);
	}
	finally {harness.restore();}
});

test("a disabled channel repaint render keeps restored records confirmable", async () => {
	const harness = createHarness();
	try {
		const {plugin} = harness;
		delete plugin.isTranslationEnabled;
		plugin.setChannelEnablementStateValue("channel-a", true);
		plugin.captureReceivedMessageSource(snapshot("message-1", "channel-a"));
		await plugin.commitReceivedDisplayResult(result("message-1", "channel-a"));

		await plugin.toggleTranslation("channel-a");
		const restoredView = plugin.getReceivedDisplayView("message-1");
		assert.equal(restoredView.status, "cancelled");

		const message = {id: "message-1", channel_id: "channel-a", content: "message-1 original", embeds: [], attachments: [], author: {id: "other-user"}};
		plugin.captureSentOriginalMessage = () => {};
		plugin.checkMessage({content: message}, message, {id: "channel-a"});

		const viewAfterRender = plugin.getReceivedDisplayView("message-1");
		assert.equal(viewAfterRender.status, "cancelled");
		assert.equal(viewAfterRender.reason, "channel-disabled");
		assert.equal(viewAfterRender.revision, restoredView.revision);
	}
	finally {harness.restore();}
});

test("channel disable clears compatibility state even when the restore repaint fails", async () => {
	const harness = createHarness();
	try {
		const {plugin} = harness;
		delete plugin.isTranslationEnabled;
		plugin.setChannelEnablementStateValue("channel-a", true);
		const cleared = [];
		plugin.restoreReceivedDisplayChannel = async () => {throw new Error("render failed");};
		plugin.clearDisplayedAutoTranslations = channelId => {cleared.push(["display", channelId]);};
		plugin.scheduleTranslationRerender = () => {throw new Error("disable must not schedule a second broad repaint");};
		plugin.processAutoTranslationQueue = () => {cleared.push(["queue"]);};

		await assert.rejects(plugin.toggleTranslation("channel-a"), /render failed/);

		assert.deepEqual(cleared, [["display", "channel-a"], ["queue"]]);
		assert.equal(plugin.isTranslationEnabled("channel-a"), false);
	}
	finally {harness.restore();}
});

test("a stale disable transaction cannot clear a channel that was re-enabled while restore awaited", async () => {
	const harness = createHarness();
	try {
		const {plugin} = harness;
		delete plugin.isTranslationEnabled;
		plugin.setChannelEnablementStateValue("channel-a", true);
		const restore = createDeferred();
		const cleared = [];
		plugin.restoreReceivedDisplayChannel = () => restore.promise;
		plugin.clearDisplayedAutoTranslations = channelId => {cleared.push(channelId);};

		const disabling = plugin.toggleTranslation("channel-a");
		assert.equal(plugin.isTranslationEnabled("channel-a"), false);
		await plugin.toggleTranslation("channel-a");
		assert.equal(plugin.isTranslationEnabled("channel-a"), true);

		restore.resolve();
		await disabling;

		assert.deepEqual(cleared, [], "the obsolete disable cleanup must not erase the new enabled session");
		assert.equal(plugin.isTranslationEnabled("channel-a"), true);
	}
	finally {harness.restore();}
});

test("the real channel toggle restores its translated thread title", async () => {
	const harness = createHarness();
	try {
		const {plugin} = harness;
		delete plugin.isTranslationEnabled;
		plugin.setChannelEnablementStateValue("channel-a", true);
		const thread = {id: "channel-a", name: "Original title", parent_id: "forum-a", isThread: () => true};
		plugin.translateText = (_text, _place, callback) => callback("翻译标题", {id: "en"}, {id: "zh-CN"}, {});
		plugin.forceUpdateChannelTitleComponents = () => {};

		assert.equal(plugin.queueChannelTitleTranslation(thread), true);
		assert.equal(plugin.getActiveChannelTitleTranslation(thread), "翻译标题");

		await plugin.toggleTranslation(thread.id);

		assert.equal(plugin.getActiveChannelTitleTranslation(thread), null);
		assert.equal(thread.name, "Original title");
	}
	finally {harness.restore();}
});

test("channel disable keeps remembered sent-message originals editable", async () => {
	const harness = createHarness();
	try {
		const {plugin} = harness;
		delete plugin.isTranslationEnabled;
		plugin.setChannelEnablementStateValue("channel-a", true);
		plugin.isOwnMessage = () => true;
		plugin.trackPendingSentOriginal("channel-a", "what the user typed", "translated send");
		assert.equal(plugin.captureSentOriginalMessage({id: "sent-message", channel_id: "channel-a", content: "translated send"}), true);
		assert.equal(plugin.getEditableSentMessageText("sent-message", "translated send"), "what the user typed");

		await plugin.toggleTranslation("channel-a");

		assert.equal(plugin.getEditableSentMessageText("sent-message", "translated send"), "what the user typed");
	}
	finally {harness.restore();}
});
