const test = require("node:test");
const assert = require("node:assert/strict");
const {
	createPluginInstance: createBasePluginInstance,
	createTypingDuringTranslationPluginInstance: createPluginInstance
} = require("./helpers/createPluginInstance");

test("channel text area editor is not disabled while translations are running", () => {
	const plugin = createPluginInstance();
	const props = {
		channel: {id: "channel-1"},
		disabled: false
	};

	plugin.processChannelTextAreaEditor({
		instance: {props}
	});

	assert.equal(props.disabled, false);
});

test("normal and prefixed sent translations keep the submitted channel id", async () => {
	let submitPatch = null;
	const translateCalls = [];
	const plugin = createBasePluginInstance({
		callSetLanguages: false,
		settings: {
			prefixes: {
				translationPrefixData: [{prefix: "$fr", language: "fr"}]
			}
		},
		bdfdb: {
			DiscordConstants: {
				ChannelTextAreaTypes: {
					NORMAL: "NORMAL",
					SIDEBAR: "SIDEBAR"
				}
			},
			PatchUtils: {
				forceAllUpdates: () => {},
				patch: (_plugin, _target, _method, config) => {
					submitPatch = config.instead;
				}
			}
		},
		isTranslationEnabled: () => true
	});
	plugin.shouldAutoTranslateSentMessage = (_text, _channelId, callback) => callback(true);
	plugin.translateText = (text, place, callback, forcedOutputLanguage, options) => {
		translateCalls.push({text, place, forcedOutputLanguage, channelId: options && options.channelId});
		callback("translated", {id: "en"}, {id: forcedOutputLanguage || "zh-CN"});
	};
	plugin.buildSentTranslationMessageValue = () => "translated";

	plugin.processChannelTextAreaContainer({
		instance: {
			props: {
				type: "NORMAL",
				channel: {id: "channel-submit"},
				onSubmit: () => {}
			}
		}
	});
	assert.equal(typeof submitPatch, "function");

	const invokeSubmit = value => submitPatch({
		methodArguments: [{value}],
		stopOriginalMethodCall: () => {},
		originalMethod: () => Promise.resolve(),
		callOriginalMethodAfterwards: () => Promise.resolve()
	});
	await invokeSubmit("hello");
	await invokeSubmit("$fr bonjour");

	assert.deepEqual(translateCalls, [
		{text: "hello", place: "sent", forcedOutputLanguage: null, channelId: "channel-submit"},
		{text: "bonjour", place: "sent", forcedOutputLanguage: "fr", channelId: "channel-submit"}
	]);
});
