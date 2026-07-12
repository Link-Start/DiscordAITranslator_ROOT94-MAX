const test = require("node:test");
const assert = require("node:assert/strict");
const {createPluginInstance} = require("./helpers/createPluginInstance");

test("obsolete button and global auto-default settings are absent from plugin defaults", () => {
	const plugin = createPluginInstance({
		callSetLanguages: false,
		bdfdb: {
			dotCN: new Proxy({}, {get: () => ""}),
			dotCNS: new Proxy({}, {get: () => ""})
		}
	});
	plugin.onLoad();

	assert.equal(Object.prototype.hasOwnProperty.call(plugin.defaults.general, "addTranslateButton"), false);
	assert.equal(Object.prototype.hasOwnProperty.call(plugin.defaults.general, "addQuickTranslateButton"), false);
	assert.equal(Object.prototype.hasOwnProperty.call(plugin.defaults.general, "usePerChatTranslation"), false);
});

test("input-box translator button remains visible when obsolete stored setting is false", () => {
	const plugin = createPluginInstance({
		callSetLanguages: false,
		settings: {
			general: {addTranslateButton: false}
		},
		bdfdb: {
			DiscordConstants: {
				ChannelTextAreaTypes: {NORMAL: "NORMAL", SIDEBAR: "SIDEBAR"}
			},
			ReactUtils: {
				createElement: (type, props) => ({type, props})
			},
			disCN: new Proxy({}, {get: () => "x"}),
			dotCN: new Proxy({}, {get: () => ""}),
			dotCNS: new Proxy({}, {get: () => ""})
		}
	});
	plugin.onLoad();
	const event = {
		instance: {
			props: {
				disabled: false,
				type: "NORMAL",
				channel: {id: "channel-1", guild_id: "guild-1"}
			}
		},
		returnvalue: {props: {children: []}}
	};

	plugin.processChannelTextAreaButtons(event);

	assert.equal(event.returnvalue.props.children.length, 1);
});

test("message action translator button remains visible when obsolete stored setting is false", () => {
	const actionChildren = [];
	const plugin = createPluginInstance({
		callSetLanguages: false,
		settings: {
			general: {addQuickTranslateButton: false}
		},
		bdfdb: {
			ReactUtils: {
				createElement: (type, props) => ({type, props}),
				findParent: () => [actionChildren, 0]
			},
			LibraryComponents: {
				TooltipContainer: "TooltipContainer",
				SvgIcon: "SvgIcon"
			},
			disCN: new Proxy({}, {get: () => "x"}),
			disCNS: new Proxy({}, {get: () => "x"}),
			dotCN: new Proxy({}, {get: () => ""}),
			dotCNS: new Proxy({}, {get: () => ""})
		}
	});
	plugin.onLoad();

	plugin.processMessageButtons({
		instance: {
			props: {
				message: {id: "message-1", content: "hello"},
				channel: {id: "channel-1"}
			}
		},
		returnvalue: {}
	});

	assert.equal(actionChildren.length, 1);
});
