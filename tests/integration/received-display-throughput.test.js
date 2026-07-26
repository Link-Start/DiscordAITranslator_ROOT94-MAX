const test = require("node:test");
const assert = require("node:assert/strict");
const {createPluginInstance} = require("../helpers/createPluginInstance");
const {createHarness, sourceSnapshot, translatedResult} = require("../helpers/createReceivedDisplayHarness");

function createScrollEchoHarness() {
	const realDocument = global.document;
	const realRequestAnimationFrame = global.requestAnimationFrame;
	const handlers = {};
	const channelId = "channel-scroll-echo";
	const scroller = {
		_scrollTop: 100,
		scrollHeight: 2000,
		clientHeight: 400,
		get scrollTop() {return this._scrollTop;},
		set scrollTop(value) {
			this._scrollTop = value;
			// A DOM scroller fires 'scroll' for programmatic writes too.
			if (handlers.scroll) handlers.scroll({type: "scroll"});
		},
		addEventListener: (name, handler) => {handlers[name] = handler;},
		removeEventListener: () => {},
		getBoundingClientRect: () => ({top: 0, bottom: 400, height: 400}),
		querySelectorAll: () => []
	};
	global.document = {
		querySelector: selector => selector == ".messages-scroller" ? scroller : null,
		getElementById: () => null
	};
	global.requestAnimationFrame = callback => callback();
	const plugin = createPluginInstance({
		callSetLanguages: false,
		bdfdb: {
			dotCN: {messagesscroller: ".messages-scroller"},
			LibraryStores: {SelectedChannelStore: {getChannelId: () => channelId}}
		}
	});
	return {
		plugin,
		channelId,
		scroller,
		handlers,
		restore() {
			global.document = realDocument;
			global.requestAnimationFrame = realRequestAnimationFrame;
		}
	};
}

test("a scroll echo from a programmatic restore does not open the user scroll window", async () => {
	const harness = createScrollEchoHarness();
	try {
		const {plugin, channelId, scroller, handlers} = harness;
		plugin.attachAutoTranslationScrollWatcher();

		handlers.wheel({type: "wheel"});
		plugin.restoreMessageScrollerState({scrollTop: 300, keepBottom: false, anchor: null, userScrollIntentSequence: 0});
		assert.equal(plugin.isUserActivelyScrollingMessages(channelId), false, "the restore echo must not be recorded as user scrolling");

		await new Promise(resolve => setTimeout(resolve, 170));
		handlers.wheel({type: "wheel"});
		scroller.scrollTop = 500;
		assert.equal(plugin.isUserActivelyScrollingMessages(channelId), true, "a real user scroll outside the grace window still opens the window");
		plugin.finishAutoTranslationScrollActivity(channelId);
	}
	finally {harness.restore();}
});

test("live automatic commits coalesce into one acknowledged display flush", async () => {
	const harness = createHarness();
	try {
		const {plugin, calls} = harness;
		const channelId = "channel-1";
		const messageIds = [];
		for (let index = 0; index < 5; index++) {
			const messageId = `message-${index + 1}`;
			messageIds.push(messageId);
			plugin.captureReceivedMessageSource({messageId, channelId, generation: 1, sourceSignature: `sig-${messageId}`, source: {content: `original ${index}`, embeds: []}});
			const outcome = await plugin.commitReceivedDisplayResult({messageId, channelId, generation: 1, sourceSignature: `sig-${messageId}`, origin: "automatic", status: "translated", translation: {content: `译文${index}`}}, {refresh: false});
			assert.deepEqual(outcome.deferredIds, [messageId]);
			plugin.scheduleReceivedDisplayFlush(channelId, messageId);
		}
		assert.equal(calls.forceUpdate, 0);

		await new Promise(resolve => setTimeout(resolve, 250));

		assert.equal(calls.forceUpdate, 1, "five commits must share one acknowledged refresh");
		assert.equal(messageIds.every(messageId => plugin.getReceivedDisplayView(messageId).renderStatus === "confirmed"), true);
	}
	finally {harness.restore();}
});

test("the historical snapshot seals while live commits keep restoring scroll", async () => {
	const echo = createScrollEchoHarness();
	try {
		const {plugin, channelId, handlers} = echo;
		plugin.settings.engines.translator = "deepseek";
		plugin.settings.filters.receivedAutoTranslateScope = "loaded_messages";
		plugin.settings.filters.receivedAutoTranslateLoadedLimit = "50";
		plugin.settings.filters.minimumAutoTranslateLength = 2;
		plugin.settings.choices.received = {input: "auto", output: "zh-CN"};
		if (typeof plugin.setLanguages == "function") plugin.setLanguages();
		const statusUpdates = [];
		plugin.updateLoadedAutoTranslationStatus = updates => {statusUpdates.push(Object.assign({}, updates));};
		plugin.requestAiBatchTranslation = (_engineKey, preparedItems) => Promise.resolve(Object.fromEntries(preparedItems.map(item => [String(item.message.id), `中文译文${item.message.id}`])));
		plugin.isEngineConfiguredForRuntime = () => true;
		plugin.captureSentOriginalMessage = () => {};

		const channel = {id: channelId};
		const messages = [];
		for (let index = 0; index < 8; index++) {
			messages.push({id: String(1000 + index), channel_id: channelId, content: `original english message number ${index} to translate`, embeds: [], attachments: [], author: {id: "other-user"}});
		}

		plugin.attachAutoTranslationScrollWatcher();
		handlers.wheel({type: "wheel"});
		handlers.scroll({type: "scroll"});

		plugin.processMessages({instance: {props: {channel, channelStream: messages.map(message => ({content: message}))}}});

		let liveIndex = 0;
		const liveTimer = setInterval(() => {
			liveIndex++;
			const messageId = `live-${liveIndex}`;
			plugin.captureReceivedMessageSource({messageId, channelId, generation: plugin.getReceivedDisplayCommitGeneration(channelId), sourceSignature: `sig-${messageId}`, source: {content: `live ${liveIndex}`, embeds: []}});
			const commit = plugin.commitReceivedDisplayResult({messageId, channelId, generation: plugin.getReceivedDisplayCommitGeneration(channelId), sourceSignature: `sig-${messageId}`, origin: "automatic", status: "translated", translation: {content: `实时${liveIndex}`}}, {refresh: false});
			if (commit && commit.catch) commit.catch(() => {});
			plugin.scheduleReceivedDisplayFlush(channelId, messageId);
		}, 120);

		const deadline = Date.now() + 2500;
		let finalStatus = null;
		while (Date.now() < deadline) {
			finalStatus = statusUpdates[statusUpdates.length - 1] || null;
			if (finalStatus && finalStatus.done && finalStatus.processed === 8) break;
			await new Promise(resolve => setTimeout(resolve, 50));
		}
		clearInterval(liveTimer);
		plugin.clearReceivedDisplayFlushQueue();

		assert.ok(finalStatus, "historical status must update");
		assert.equal(finalStatus.done, true, "the snapshot must seal and the job must finish despite continuous live scroll restores");
		assert.equal(finalStatus.processed, 8);
		assert.equal(finalStatus.displayed, 8);
	}
	finally {echo.restore();}
});
