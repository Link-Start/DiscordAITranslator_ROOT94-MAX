const test = require("node:test");
const assert = require("node:assert/strict");
const {createPluginInstance} = require("./helpers/createPluginInstance");

test("plugin start routes single and bulk message deletion actions through the lifecycle handler", () => {
	const dispatcher = {dispatch() {}};
	const patches = [];
	const plugin = createPluginInstance({
		callSetLanguages: false,
		bdfdb: {
			LibraryModules: {Dispatcher: dispatcher, MessageUtils: {}, MessageToolbarUtils: {}},
			PatchUtils: {
				patch: (_owner, target, method, options) => patches.push({target, method, options}),
				forceAllUpdates: () => {}
			}
		}
	});
	const actions = [];
	plugin.handleMessageDeletionAction = action => {actions.push(action); return Promise.resolve();};
	plugin.attachAutoTranslationInputActivityWatcher = () => {};
	plugin.forceUpdateAll = () => {};

	plugin.onStart();
	const dispatcherPatch = patches.find(patch => patch.target === dispatcher && patch.method === "dispatch");
	assert.ok(dispatcherPatch, "the lifecycle owns a dispatcher deletion hook");
	dispatcherPatch.options.before({methodArguments: [{type: "MESSAGE_DELETE", channelId: "c1", id: "m1"}]});
	dispatcherPatch.options.before({methodArguments: [{type: "MESSAGE_DELETE_BULK", channelId: "c1", ids: ["m2", "m3"]}]});
	dispatcherPatch.options.before({methodArguments: [{type: "MESSAGE_CREATE", channelId: "c1", id: "m4"}]});

	assert.deepEqual(actions, [
		{type: "MESSAGE_DELETE", channelId: "c1", id: "m1"},
		{type: "MESSAGE_DELETE_BULK", channelId: "c1", ids: ["m2", "m3"]}
	]);
});
