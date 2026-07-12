const test = require("node:test");
const assert = require("node:assert/strict");
const {createPluginInstance} = require("./helpers/createPluginInstance");

function createThreadChannel(name = "hello thread") {
	return {
		id: "thread-channel-1",
		name,
		parent_id: "forum-channel-1",
		isThread: () => true
	};
}

test("enabled thread titles translate asynchronously without mutating the channel", async () => {
	const plugin = createPluginInstance();
	const channel = createThreadChannel();
	let rerenderCount = 0;
	plugin.translateText = (_text, _place, callback) => callback("你好帖子", {id: "en"}, {id: "zh-CN"}, {});
	plugin.forceUpdateChannelTitleComponents = () => {
		rerenderCount++;
	};

	assert.equal(plugin.queueChannelTitleTranslation(channel), true);
	await new Promise(resolve => setTimeout(resolve, 0));

	assert.equal(channel.name, "hello thread");
	assert.equal(plugin.getActiveChannelTitleTranslation(channel), "你好帖子");
	assert.equal(rerenderCount, 1);
});

test("edited thread title invalidates a stale late translation", async () => {
	const plugin = createPluginInstance();
	const channel = createThreadChannel("old title");
	const callbacks = [];
	plugin.translateText = (_text, _place, callback) => callbacks.push(callback);
	plugin.forceUpdateChannelTitleComponents = () => {};

	plugin.queueChannelTitleTranslation(channel);
	channel.name = "new title";
	plugin.queueChannelTitleTranslation(channel);
	callbacks[0]("旧译文", {id: "en"}, {id: "zh-CN"}, {});
	callbacks[1]("新译文", {id: "en"}, {id: "zh-CN"}, {});

	assert.equal(plugin.getActiveChannelTitleTranslation(channel), "新译文");
});

test("disabling a thread clears its title and ignores a late provider callback", () => {
	let enabled = true;
	const plugin = createPluginInstance({isTranslationEnabled: () => enabled});
	const channel = createThreadChannel();
	let finishTranslation = null;
	plugin.translateText = (_text, _place, callback) => {
		finishTranslation = callback;
	};
	plugin.forceUpdateChannelTitleComponents = () => {};

	plugin.queueChannelTitleTranslation(channel);
	enabled = false;
	plugin.clearChannelTitleTranslations(channel.id);
	finishTranslation("不应显示", {id: "en"}, {id: "zh-CN"}, {});

	assert.equal(plugin.getActiveChannelTitleTranslation(channel), null);
});

test("changing received protection rules invalidates an in-flight thread title translation", () => {
	const plugin = createPluginInstance();
	const channel = createThreadChannel("Discord support");
	let finishTranslation = null;
	plugin.translateText = (_text, _place, callback) => {
		finishTranslation = callback;
	};
	plugin.forceUpdateChannelTitleComponents = () => {};

	plugin.queueChannelTitleTranslation(channel);
	plugin.settings.exceptions.protectedTerms = ["Discord"];
	finishTranslation("迟到标题译文", {id: "en"}, {id: "zh-CN"}, {});

	assert.equal(plugin.getActiveChannelTitleTranslation(channel), null);
});

test("title render replacement changes only exact title text", () => {
	const plugin = createPluginInstance();
	const tree = {
		props: {
			children: [
				"hello thread",
				{props: {children: "unrelated hello thread text"}},
				{props: {children: "hello thread"}}
			]
		}
	};

	plugin.replaceChannelTitleInRenderTree(tree, "hello thread", "你好帖子");

	assert.equal(tree.props.children[0], "你好帖子");
	assert.equal(tree.props.children[1].props.children, "unrelated hello thread text");
	assert.equal(tree.props.children[2].props.children, "你好帖子");
});
