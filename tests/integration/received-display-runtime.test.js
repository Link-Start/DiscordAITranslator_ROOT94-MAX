const test = require("node:test");
const assert = require("node:assert/strict");
const {createHarness, sourceSnapshot, translatedResult} = require("../helpers/createReceivedDisplayHarness");

test("Messages and MessageContent read the same translated revision", async () => {
	const harness = createHarness();
	try {
		const {plugin} = harness;
		plugin.captureReceivedMessageSource(sourceSnapshot());
		await plugin.commitReceivedDisplayResult(translatedResult());
		const view = plugin.getReceivedDisplayView("message-1");
		const stream = {content: {id: "message-1", channel_id: "channel-1", content: "Original", embeds: []}};
		plugin.applyReceivedDisplayViewToStream(stream, view);
		const event = {instance: {props: {message: stream.content}}, returnvalue: {props: {children: [], className: "message", style: {}}}};
		plugin.applyReceivedDisplayViewToContent(event, view);

		assert.equal(stream.content.content, "译文");
		assert.equal(event.returnvalue.props["data-translator-revision"], String(view.revision));
		assert.match(event.returnvalue.props.className, /translator-translated-message/);
		assert.equal(event.returnvalue.props.style["--translator-text-color"], "#12a594");
		assert.equal(event.returnvalue.props.children.some(child => child && child.key === "translator-translated-watermark"), true);
	}
	finally {harness.restore();}
});

test("a translated result cannot produce text without translated decoration", async () => {
	const harness = createHarness();
	try {
		const {plugin} = harness;
		plugin.captureReceivedMessageSource(sourceSnapshot());
		await plugin.commitReceivedDisplayResult(translatedResult());
		const view = plugin.getReceivedDisplayView("message-1");
		const stream = {content: {id: "message-1", channel_id: "channel-1", content: "Original", embeds: []}};
		const event = {instance: {props: {message: stream.content}}, returnvalue: {props: {children: [], className: "", style: {}}}};

		plugin.applyReceivedDisplayViewToStream(stream, view);
		plugin.applyReceivedDisplayViewToContent(event, view);

		assert.equal(stream.content.content === "译文", event.returnvalue.props.className.includes("translator-translated-message"));
		assert.equal(event.returnvalue.props["data-translator-revision"], String(view.revision));
	}
	finally {harness.restore();}
});

test("render acknowledgement failure keeps the record inspectable", async () => {
	const harness = createHarness({confirmDirectly: false, confirmAfterFallback: false});
	try {
		const {plugin} = harness;
		plugin.captureReceivedMessageSource(sourceSnapshot());
		await plugin.commitReceivedDisplayResult(translatedResult());

		const view = plugin.getReceivedDisplayView("message-1");
		assert.equal(view.renderStatus, "unconfirmed");
		assert.equal(view.renderReason, "render-unconfirmed");
	}
	finally {harness.restore();}
});

test("a confirmed render acknowledgement marks the committed revision confirmed", async () => {
	const harness = createHarness();
	try {
		const {plugin, calls} = harness;
		plugin.captureReceivedMessageSource(sourceSnapshot());
		const outcome = await plugin.commitReceivedDisplayResult(translatedResult());

		assert.deepEqual(outcome, {confirmedIds: ["message-1"], missingIds: [], fallbackUsed: false});
		assert.equal(calls.forceUpdate, 1);
		assert.equal(calls.rerenderAll, 0);
		assert.equal(plugin.getReceivedDisplayView("message-1").renderStatus, "confirmed");
	}
	finally {harness.restore();}
});

test("a pending view renders one loading indicator without translated decoration", async () => {
	const harness = createHarness();
	try {
		const {plugin} = harness;
		plugin.captureReceivedMessageSource(sourceSnapshot());
		await plugin.markReceivedDisplayPending({messageId: "message-1", channelId: "channel-1", generation: 1, origin: "automatic", requestIdentity: "request-1"}, {refresh: false});
		const view = plugin.getReceivedDisplayView("message-1");
		const event = {instance: {props: {message: {id: "message-1", channel_id: "channel-1", content: "Original", embeds: []}}}, returnvalue: {props: {children: [], className: "", style: {}}}};

		plugin.applyReceivedDisplayViewToContent(event, view);

		assert.equal(view.showLoading, true);
		assert.equal(event.returnvalue.props.children.filter(child => child && child.key === "translator-translation-loading").length, 1);
		assert.doesNotMatch(event.returnvalue.props.className, /translator-translated-message/);
	}
	finally {harness.restore();}
});

test("checkMessage captures the received source into the display store", () => {
	const harness = createHarness();
	try {
		const {plugin} = harness;
		const message = {id: "message-1", channel_id: "channel-1", content: "Original", embeds: [], attachments: [], author: {id: "other-user"}};
		const stream = {content: message};
		plugin.captureSentOriginalMessage = () => {};
		plugin.isTranslationEnabled = () => false;

		plugin.checkMessage(stream, message, {id: "channel-1"});

		const view = plugin.getReceivedDisplayView("message-1");
		assert.ok(view);
		assert.equal(view.status, "idle");
		assert.equal(view.channelId, "channel-1");
		assert.equal(view.content, "Original");
		assert.equal(view.translated, false);
		assert.equal(plugin.getReceivedDisplayGeneration("channel-1"), 1);
	}
	finally {harness.restore();}
});
