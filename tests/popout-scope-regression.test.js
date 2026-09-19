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

test("left-click channel dialog uses the shared BetterDiscord shell and keeps its language controls", () => {
	let legacyModalCalls = 0;
	let confirmationModal = null;
	let closedModalKey = null;
	const plugin = createPluginInstance({
		callSetLanguages: false,
		bdfdb: createRenderTestBdfdb(() => {legacyModalCalls++;}),
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
	global.BdApi.UI = {
		showConfirmationModal: (title, content, options) => {
			confirmationModal = {title, content, options};
			return "channel-modal-key";
		}
	};
	global.BdApi.Webpack = {
		Filters: {byStrings: () => () => true},
		getMangled: () => ({
			openModal: () => {},
			closeModal: key => {closedModalKey = key;}
		})
	};
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
	const channelChoices = {
		received: {input: "auto", output: "en"},
		sent: {input: "auto", output: "en"}
	};
	plugin.getLanguageChoice = (direction, place) => channelChoices[place][direction];
	plugin.saveLanguageChoice = (value, direction, place) => {channelChoices[place][direction] = value;};

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

	assert.equal(legacyModalCalls, 0, "the channel dialog must share the BetterDiscord modal host used by the sibling plugins");
	assert.ok(confirmationModal);
	assert.equal(confirmationModal.options.size, "translator-channel-confirm");
	assert.equal(confirmationModal.options.confirmText, null);
	assert.equal(confirmationModal.options.cancelText, null);
	const titleNodes = collectNodesDeep(confirmationModal.title);
	assert.equal(titleNodes.some(node => node.props && node.props.className == "translator-channel-confirm-header"), true);
	assert.equal(titleNodes.some(node => node.type == "span" && node.props.children == "channel_modal_title"), true, "the title stays the simple channel-settings title approved by the user");
	assert.equal(titleNodes.some(node => typeof (node.props && node.props.children) == "string" && /#|auto_translate/.test(node.props.children)), false, "no channel identity or auto-translate status is added to the header");
	const closeButton = titleNodes.find(node => node.type == "button" && node.props.className == "translator-channel-close");
	assert.ok(closeButton, "the shared shell keeps the same visible close affordance as the sibling plugins");
	closeButton.props.onClick();
	assert.equal(closedModalKey, "channel-modal-key");
	confirmationModal.options.onClose();
	assert.equal(buttonInstance.props.isActive, false, "closing the modal returns the composer button to its inactive state");

	const popoutElement = confirmationModal.content;
	const popoutInstance = new popoutElement.type(popoutElement.props);
	popoutInstance.props = popoutElement.props;
	const renderedNodes = collectNodesDeep(popoutInstance.render());
	assert.equal(renderedNodes.some(node => node.props && node.props.className == "translator-channel-settings translator-settings-ui"), true);
	// The modal header carries the identity, so the body has no heading block.
	assert.equal(renderedNodes.some(node => node.props && node.props.className == "translator-channel-heading"), false);
	assert.equal(renderedNodes.filter(node => node.props && node.props.className == "translator-channel-zone").length >= 2, true);
	assert.equal(renderedNodes.some(node => node.type == "SettingsLabel"), false);
	assert.equal(renderedNodes.some(node => node.props && node.props.className == "translator-detector-panel"), true);
	assert.equal(renderedNodes.some(node => node.props && /translator-channel-(enable|state)/.test(node.props.className || "")), false, "the dialog remains a configuration surface, not a second auto-translate switch");
	assert.equal(renderedNodes.some(node => node.props && node.props.className == "translator-channel-zone-note" && node.props.children == "language_detector_hint"), true, "the detector explains that it changes the sent target language");
	// Four language selects plus the channel engine select: every dropdown in the
	// popout is the self-drawn searchable select from the mk redesign.
	const languageSelects = renderedNodes.filter(node => typeof node.type == "function" && node.type.name == "SearchableSelect");
	assert.equal(languageSelects.length, 5);
	assert.equal(languageSelects.every(node => typeof node.props.ariaLabelledBy == "string" && node.props.ariaLabelledBy), true, "every provider/language combobox is associated with its visible label");
	assert.equal(languageSelects.every(node => node.props.disablePortal === true), true, "every channel-dialog search input stays inside the BetterDiscord modal focus trap");
	const directionSections = renderedNodes.filter(node => node.type == "section" && node.props && node.props.className == "translator-channel-zone").slice(0, 2);
	assert.equal(directionSections.length, 2);
	for (const section of directionSections) {
		const directChildren = [].concat(section.props.children || []);
		const header = directChildren.find(node => node && node.props && node.props.className == "translator-channel-zone-title");
		const targetRow = directChildren[2];
		assert.equal(collectNodesDeep(header).some(node => node.props && node.props.className == "translator-channel-scope-group"), true, "scope belongs to the whole direction and is shown in its header");
		assert.equal(collectNodesDeep(targetRow).some(node => node.props && node.props.className == "translator-channel-scope-group"), false, "scope is not misleadingly attached to only the target language");
	}
	const scopeGroups = renderedNodes.filter(node => node.props && node.props.className == "translator-channel-scope-group");
	assert.equal(scopeGroups.length, 2);
	assert.equal(scopeGroups.every(node => node.props.role == "radiogroup"), true);
	assert.equal(scopeGroups.every(node => node.props["data-scope"] == "global"), true, "the sliding indicator receives the active scope from the render tree");
	const scopeHelp = renderedNodes.filter(node => node.props && node.props.className == "translator-channel-scope-info translator-info-tip");
	assert.equal(scopeHelp.length, 2, "received and sent headings each explain their independent scope");
	const scopeTooltips = renderedNodes.filter(node => node.type == "TooltipContainer" && node.props && node.props.text == "channel_scope_help");
	assert.equal(scopeTooltips.length, 2);
	const scopeOptions = renderedNodes.filter(node => node.props && node.props.className == "translator-channel-scope-option");
	assert.equal(scopeOptions.length, 6, "each direction exposes Global, Server and Channel without another dropdown");
	assert.equal(scopeOptions.filter(node => node.props["data-scope"] == "global" && node.props["aria-checked"] === true).length, 2);
	assert.equal(scopeOptions.filter(node => node.props.tabIndex == 0).length, 2, "only the selected segment in each radio group joins the tab order");
	const chooseReceivedScope = scope => collectNodesDeep(popoutInstance.render()).find(node => node.props && node.props.className == "translator-channel-scope-option" && node.props["data-place"] == "received" && node.props["data-scope"] == scope);
	let prevented = 0;
	chooseReceivedScope("global").props.onKeyDown({key: "ArrowRight", preventDefault: () => {prevented++;}, currentTarget: {parentElement: null}});
	assert.equal(prevented, 1);
	assert.equal(chooseReceivedScope("guild").props["aria-checked"], true, "the explicit server segment becomes selected in one action");
	assert.equal(collectNodesDeep(popoutInstance.render()).find(node => node.props && node.props.className == "translator-channel-scope-group" && node.props["data-place"] == "received").props["data-scope"], "guild");
	chooseReceivedScope("channel").props.onClick();
	assert.equal(chooseReceivedScope("channel").props["aria-checked"], true, "the explicit channel segment becomes selected in one click");
	chooseReceivedScope("global").props.onClick();
	assert.equal(chooseReceivedScope("global").props["aria-checked"], true, "the explicit global segment becomes selected in one click");
	const isSearchableSelect = node => typeof node.type == "function" && node.type.name == "SearchableSelect";
	const channelEngineSelect = renderedNodes.find(node => isSearchableSelect(node) && node.props.value == "googleapi");
	assert.ok(channelEngineSelect);
	assert.equal(channelEngineSelect.props.options.some(option => option.value == "deepseek"), true);

	channelEngineSelect.props.onChange("deepl");
	const overriddenNodes = collectNodesDeep(popoutInstance.render());
	const overriddenEngineSelect = overriddenNodes.find(node => isSearchableSelect(node) && node.props.value == "deepl");
	assert.ok(overriddenEngineSelect);
	const overriddenLanguageSelects = overriddenNodes.filter(isSearchableSelect);
	assert.equal(overriddenLanguageSelects.some(node => node.props.options.some(option => option.value == "zh-CN" && option.disabled)), true);
	// The draft replaces the restore button with a "follow global" option that
	// leads the engine list; picking it clears the channel override.
	assert.equal(overriddenNodes.some(node => node.type == "button" && node.props.className == "translator-channel-restore"), false);
	assert.equal(overriddenEngineSelect.props.options[0].value, "__global__");

	overriddenEngineSelect.props.onChange("__global__");
	const restoredNodes = collectNodesDeep(popoutInstance.render());
	assert.ok(restoredNodes.find(node => isSearchableSelect(node) && node.props.value == "googleapi"));

	const initialSwap = renderedNodes.find(node => node.type == "button" && node.props.className == "translator-channel-swap");
	assert.equal(initialSwap.props.disabled, true, "automatic source detection cannot be swapped into a fabricated target language");
	assert.equal(initialSwap.props.title, "channel_swap_requires_source");
	const receivedSource = languageSelects.find(node => node.props.value == "auto" && /received-input/.test(node.props.ariaLabelledBy));
	assert.ok(receivedSource);
	receivedSource.props.onChange("zh-CN");
	const concreteNodes = collectNodesDeep(popoutInstance.render());
	const concreteSwap = concreteNodes.find(node => node.type == "button" && node.props.className == "translator-channel-swap");
	assert.equal(concreteSwap.props.disabled, false);
	concreteSwap.props.onClick();
	assert.equal(plugin.getLanguageChoice("input", "received", "channel-1"), "en");
	assert.equal(plugin.getLanguageChoice("output", "received", "channel-1"), "zh-CN", "a concrete swap uses only the two user-selected values");

	popoutInstance.state.detectedLanguageId = "en";
	const detectedNodes = collectNodesDeep(popoutInstance.render());
	const detectedStatus = detectedNodes.find(node => node.props && node.props.role == "status");
	assert.ok(detectedStatus);
	assert.equal(detectedStatus.props["aria-live"], "polite");
});
