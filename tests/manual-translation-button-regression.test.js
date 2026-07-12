const test = require("node:test");
const assert = require("node:assert/strict");
const {createManualTranslationButtonPluginInstance: createPluginInstance} = require("./helpers/createPluginInstance");

test("manual message translate ignores hidden auto-translation state when master switch is off", async () => {
	const plugin = createPluginInstance();
	const channel = {id: "channel-1"};
	const message = {
		id: "message-1",
		channel_id: channel.id,
		content: "hola",
		embeds: [],
		author: {id: "other-user"}
	};

	plugin.applyStoredTranslationToMessage(message, {
		channelId: channel.id,
		auto: true,
		content: "hello\n> hola",
		translatedContent: "hello",
		originalContent: "hola"
	});

	assert.equal(plugin.getActiveMessageTranslation(message, channel.id), null);

	let translateCalls = 0;
	plugin.translateText = (_text, _place, callback) => {
		translateCalls++;
		callback("hello", {id: "es"}, {id: "en"}, {});
	};

	const result = await plugin.translateMessage(message, channel, {manual: true, independentOfTextAreaSwitch: true});
	assert.equal(result, true);
	assert.equal(translateCalls, 1);

	const activeTranslation = plugin.getActiveMessageTranslation(message, channel.id);
	assert.ok(activeTranslation);
	assert.equal(activeTranslation.translatedContent, "hello");
	assert.equal(activeTranslation.auto, false);
	assert.equal(activeTranslation.manual, true);
	assert.equal(activeTranslation.independentOfTextAreaSwitch, true);
});
