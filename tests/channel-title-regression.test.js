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

test("clearing a translated thread title immediately refreshes every title surface", () => {
	const plugin = createPluginInstance();
	const channel = createThreadChannel();
	let titleRefreshCount = 0;
	plugin.translateText = (_text, _place, callback) => callback("你好帖子", {id: "en"}, {id: "zh-CN"}, {});
	plugin.forceUpdateChannelTitleComponents = () => {
		titleRefreshCount++;
	};
	plugin.queueChannelTitleTranslation(channel);
	titleRefreshCount = 0;

	plugin.clearChannelTitleTranslations(channel.id);

	assert.equal(plugin.getActiveChannelTitleTranslation(channel), null);
	assert.equal(titleRefreshCount, 1);
});

test("stopping with a visible translated title does not queue another provider request", () => {
	const plugin = createPluginInstance();
	const channel = createThreadChannel();
	plugin.translateText = (_text, _place, callback) => callback("你好帖子", {id: "en"}, {id: "zh-CN"}, {});
	plugin.forceUpdateChannelTitleComponents = () => {};
	plugin.queueChannelTitleTranslation(channel);

	let providerRequestCount = 0;
	plugin.translateText = () => {
		providerRequestCount++;
	};
	plugin.forceUpdateChannelTitleComponents = () => {
		plugin.processThreadSidebar({
			instance: {props: {thread: channel}},
			returnvalue: {props: {threadName: channel.name}}
		});
	};
	plugin.forceUpdateAll = () => {};

	plugin.onStop();

	assert.equal(providerRequestCount, 0);
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

test("title render replacement covers Discord threadName and channelName props", () => {
	const plugin = createPluginInstance();
	const tree = {
		props: {
			threadName: "Welcome to Learning Hub!",
			channelName: "Welcome to Learning Hub!",
			children: {props: {threadName: "Welcome to Learning Hub!"}}
		}
	};

	plugin.replaceChannelTitleInRenderTree(tree, "Welcome to Learning Hub!", "欢迎来到学习中心！");

	assert.equal(tree.props.threadName, "欢迎来到学习中心！");
	assert.equal(tree.props.channelName, "欢迎来到学习中心！");
	assert.equal(tree.props.children.props.threadName, "欢迎来到学习中心！");
});

test("thread title event resolves threadId before a parent forum channel prop", () => {
	const thread = createThreadChannel("Welcome to Learning Hub!");
	const forumParent = {id: "forum-channel-1", name: "learning-hub"};
	const plugin = createPluginInstance({
		bdfdb: {
			LibraryStores: {
				ChannelStore: {
					getChannel: channelId => channelId == thread.id ? thread : channelId == forumParent.id ? forumParent : null
				}
			}
		}
	});

	const resolved = plugin.getChannelFromTitlePatchEvent({
		instance: {props: {channel: forumParent, threadId: thread.id}}
	});

	assert.equal(resolved, thread);
});

test("thread title event resolves a translatable channelId before a parent forum channel prop", () => {
	const thread = createThreadChannel("Welcome to Learning Hub!");
	const forumParent = {id: "forum-channel-1", name: "learning-hub"};
	const plugin = createPluginInstance({
		bdfdb: {
			LibraryStores: {
				ChannelStore: {
					getChannel: channelId => channelId == thread.id ? thread : channelId == forumParent.id ? forumParent : null
				}
			}
		}
	});

	const resolved = plugin.getChannelFromTitlePatchEvent({
		instance: {props: {channel: forumParent, channelId: thread.id}}
	});

	assert.equal(resolved, thread);
});

test("thread sidebar and forum card surfaces render the translated thread title", () => {
	const thread = createThreadChannel("Welcome to Learning Hub!");
	const forumParent = {id: "forum-channel-1", name: "learning-hub"};
	const plugin = createPluginInstance({
		bdfdb: {
			LibraryStores: {
				ChannelStore: {
					getChannel: channelId => channelId == thread.id ? thread : channelId == forumParent.id ? forumParent : null
				}
			}
		}
	});
	plugin.translateText = (_text, _place, callback) => callback("欢迎来到学习中心！", {id: "en"}, {id: "zh-CN"}, {});
	plugin.forceUpdateChannelTitleComponents = () => {};
	const sidebarEvent = {
		instance: {props: {channel: forumParent, threadId: thread.id}},
		returnvalue: {props: {threadName: thread.name, children: thread.name}}
	};
	const cardEvent = {
		instance: {props: {channel: forumParent, threadId: thread.id}},
		returnvalue: {props: {threadName: thread.name}}
	};

	plugin.processThreadSidebar(sidebarEvent);
	plugin.processThreadSidebar(sidebarEvent);
	plugin.processThreadCard(cardEvent);

	assert.equal(sidebarEvent.returnvalue.props.threadName, "欢迎来到学习中心！");
	assert.equal(sidebarEvent.returnvalue.props.children, "欢迎来到学习中心！");
	assert.equal(cardEvent.returnvalue.props.threadName, "欢迎来到学习中心！");
});

test("plugin registers ThreadSidebar as a translated title surface", () => {
	const plugin = createPluginInstance({
		callSetLanguages: false,
		bdfdb: {
			disCN: new Proxy({}, {get: () => "x"}),
			dotCN: new Proxy({}, {get: () => ""}),
			dotCNS: new Proxy({}, {get: () => ""})
		}
	});
	plugin.onLoad();

	assert.equal(plugin.modulePatches.after.includes("ThreadSidebar"), true);
});
