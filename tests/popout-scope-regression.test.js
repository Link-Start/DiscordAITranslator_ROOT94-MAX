const test = require("node:test");
const assert = require("node:assert/strict");
const {createPluginInstance} = require("./helpers/createPluginInstance");

function mergeRecords(base, override) {
	const result = Array.isArray(base) ? base.slice() : Object.assign({}, base || {});
	for (const key in override || {}) {
		const value = override[key];
		if (value && typeof value == "object" && !Array.isArray(value) && result[key] && typeof result[key] == "object" && !Array.isArray(result[key])) result[key] = mergeRecords(result[key], value);
		else result[key] = value;
	}
	return result;
}

function createRenderTestBdfdb(onOpenModal) {
	return {
		ArrayUtils: {
			is: Array.isArray,
			remove: () => {}
		},
		ObjectUtils: {
			isEmpty: object => !object || !Object.keys(object).length,
			deepAssign: (...objects) => Object.assign({}, ...objects.filter(Boolean)),
			filter: (object, predicate) => Object.fromEntries(Object.entries(object || {}).filter(([, value]) => predicate(value))),
			sort: object => object,
			map: (object, mapper) => Object.fromEntries(Object.entries(object || {}).map(([key, value]) => [key, mapper(value, key)])),
			toArray: object => Object.values(object || {})
		},
		ReactUtils: {
			createElement: (type, props = {}) => ({type, props}),
			forceUpdate: () => {}
		},
		ModalUtils: {
			open: (_plugin, config) => {
				onOpenModal(config);
			}
		},
		LanguageUtils: {
			languages: {
				"en": {id: "en", name: "English"},
				"zh-CN": {id: "zh-CN", name: "Chinese"}
			},
			LanguageStrings: {
				SETTINGS: "Settings"
			},
			LibraryStrings: {
				please_wait: "Please wait"
			},
			getName: language => language && (language.name || language.id),
			getLanguage: () => ({id: "en"})
		},
		LibraryComponents: {
			ChannelTextAreaButton: "ChannelTextAreaButton",
			TextInput: "TextInput",
			Button: Object.assign("Button", {
				Sizes: {
					SMALL: "SMALL"
				}
			}),
			Flex: Object.assign("Flex", {
				Align: {
					CENTER: "CENTER"
				},
				Child: "FlexChild"
			}),
			SettingsLabel: "SettingsLabel",
			FormDivider: "FormDivider",
			FormItem: "FormItem",
			Select: "Select",
			Clickable: "Clickable",
			TooltipContainer: "TooltipContainer",
			FavButton: "FavButton",
			SvgIcon: {
				Names: {
					LOCK_CLOSED: "LOCK_CLOSED",
					LOCK_OPEN: "LOCK_OPEN",
					WARNING: "WARNING"
				}
			}
		},
		LibraryStores: {
			ChannelStore: {
				getChannel: channelId => ({id: channelId, guild_id: "guild-1"})
			},
			SelectedChannelStore: {
				getChannelId: () => "channel-1"
			}
		},
		DOMUtils: {
			formatClassName: (...parts) => parts.filter(Boolean).join(" ")
		},
		DiscordConstants: {
			ChannelTextAreaTypes: {
				NORMAL: "NORMAL",
				SIDEBAR: "SIDEBAR"
			}
		},
		disCN: new Proxy({}, {get: () => "x"}),
		dotCN: new Proxy({}, {get: () => ""}),
		dotCNS: new Proxy({}, {get: () => ""})
	};
}

function collectNodesDeep(nodes) {
	const allNodes = [];
	for (const node of [].concat(nodes || [])) {
		if (!node) continue;
		if (Array.isArray(node)) {
			allNodes.push(...collectNodesDeep(node));
			continue;
		}
		allNodes.push(node);
		if (node.props && node.props.children) allNodes.push(...collectNodesDeep(node.props.children));
	}
	return allNodes;
}

test("left-click popout keeps channel engine, language detector, and current-channel language controls", () => {
	let modalConfig = null;
	const plugin = createPluginInstance({
		callSetLanguages: false,
		bdfdb: createRenderTestBdfdb(config => {
			modalConfig = config;
		}),
		mutatePlugin(instance) {
			instance.getCustomText = key => key;
			instance.labels = mergeRecords(instance.labels, {
				exception_text: 'Words starting with {{var0}} will be ignored',
				language_choice_input_received: "Input Language in received Messages",
				language_choice_output_received: "Output Language in received Messages",
				language_choice_input_sent: "Input Language in your sent Messages",
				language_choice_output_sent: "Output Language in your sent Messages",
				language_selection_channel: "Channel",
				language_selection_server: "Server",
				language_selection_global: "Global",
				backup_engine_warning: "Backup engine"
			});
		}
	});
	global.window = Object.assign({}, global.window, {innerHeight: 900});
	global.document = {body: {}};
	plugin.onLoad();
	assert.equal(plugin.defaults.general.sendOriginalMessage.popout, false);
	assert.equal(plugin.defaults.general.showOriginalMessage.popout, false);
	plugin.settings = mergeRecords(plugin.settings, {
		general: {
			addTranslateButton: true
		},
		exceptions: {
			wordStart: ["!"]
		}
	});
	plugin.refreshChannelPrimaryEngineRuntime = () => {};

	const event = {
		instance: {
			props: {
				disabled: false,
				type: "NORMAL",
				channel: {
					id: "channel-1",
					guild_id: "guild-1"
				}
			}
		},
		returnvalue: {
			props: {
				children: []
			}
		}
	};

	plugin.processChannelTextAreaButtons(event);
	const buttonElement = event.returnvalue.props.children[0];
	const buttonInstance = new buttonElement.type(buttonElement.props);
	buttonInstance.props = buttonElement.props;
	const renderedButton = buttonInstance.render();
	renderedButton.props.onClick();

	assert.ok(modalConfig);
	const popoutElement = modalConfig.children;
	const popoutInstance = new popoutElement.type(popoutElement.props);
	popoutInstance.props = popoutElement.props;
	const renderedNodes = collectNodesDeep(popoutInstance.render());
	const formTitles = renderedNodes.filter(node => node.type == "FormItem").map(node => node.props.title);

	assert.deepEqual(formTitles, [
		"channel_primary_engine_title",
		"Input Language in received Messages: ",
		"Output Language in received Messages: ",
		"Input Language in your sent Messages: ",
		"Output Language in your sent Messages: "
	]);
	assert.equal(renderedNodes.some(node => node.type == "SettingsLabel"), false);
	assert.equal(renderedNodes.some(node => node.props && node.props.className == "translator-detector-panel"), true);
	const channelEngineSelect = renderedNodes.find(node => node.type == "Select" && node.props.value == "googleapi");
	assert.ok(channelEngineSelect);
	assert.equal(channelEngineSelect.props.options.some(option => option.value == "deepseek"), true);

	channelEngineSelect.props.onChange("deepl");
	const overriddenNodes = collectNodesDeep(popoutInstance.render());
	const overriddenEngineSelect = overriddenNodes.find(node => node.type == "Select" && node.props.value == "deepl");
	assert.ok(overriddenEngineSelect);
	const languageSelects = overriddenNodes.filter(node => node.type == "Select" && node !== overriddenEngineSelect);
	assert.equal(languageSelects.some(node => node.props.options.some(option => option.value == "zh-CN" && option.disabled)), true);
	const restoreButton = overriddenNodes.find(node => node.type == "Button" && node.props.children == "channel_primary_engine_restore");
	assert.ok(restoreButton);

	restoreButton.props.onClick();
	const restoredNodes = collectNodesDeep(popoutInstance.render());
	assert.ok(restoredNodes.find(node => node.type == "Select" && node.props.value == "googleapi"));
});
