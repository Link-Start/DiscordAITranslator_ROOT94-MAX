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
		translation: {content}
	};
}

test("disabling a channel restores visible originals without hover", async () => {
	const harness = createHarness();
	try {
		const {plugin, calls} = harness;
		delete plugin.isTranslationEnabled;
		plugin.setChannelEnablementStateValue("channel-a", true);
		plugin.setChannelEnablementStateValue("channel-b", true);
		for (const [messageId, channelId] of [["message-1", "channel-a"], ["message-2", "channel-a"], ["message-3", "channel-b"]]) {
			plugin.captureReceivedMessageSource(snapshot(messageId, channelId));
			await plugin.commitReceivedDisplayResult(result(messageId, channelId));
		}
		const updatesBeforeDisable = calls.forceUpdate;

		await plugin.toggleTranslation("channel-a");

		assert.equal(plugin.getReceivedDisplayView("message-1").content, "message-1 original");
		assert.equal(plugin.getReceivedDisplayView("message-2").content, "message-2 original");
		assert.equal(plugin.getReceivedDisplayView("message-3").content, "message-3 translated");
		assert.equal(calls.forceUpdate, updatesBeforeDisable + 1);
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
