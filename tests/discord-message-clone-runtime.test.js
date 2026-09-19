const test = require("node:test");
const assert = require("node:assert/strict");

const runtimePath = require.resolve("../src/legacy/runtime");

function loadRuntimePlugin(BDFDB) {
	class BasePlugin {}
	global.BdApi = {React: {Component: class Component {}}};
	global.window = {
		BDFDB_Global: {
			loaded: true,
			started: true,
			PluginUtils: {buildPlugin: () => [BasePlugin, BDFDB]}
		}
	};
	delete require.cache[runtimePath];
	const PluginClass = require(runtimePath);
	return new PluginClass();
}

test("cloneHistoricalSourceMessage keeps a detached retry snapshot without a usable BDFDB constructor", () => {
	class SourceMessage {
		recordMethod() {return "source-record";}
	}
	const source = Object.assign(new SourceMessage(), {
		id: "m1",
		channel_id: "c1",
		content: "historical original",
		embeds: [{id: "e1", fields: [{name: "field", value: "value"}], footer: {text: "footer"}}],
		attachments: [{id: "a1", filename: "file.txt"}],
		author: {id: "u1", username: "author"},
		messageSnapshots: [{message: {content: "forwarded original"}}],
		messageReference: {message_id: "source-1"}
	});
	const fixtures = [
		{DiscordObjects: {}},
		{DiscordObjects: {Message: class Message {constructor() {throw new Error("changed constructor");}}}}
	];

	try {
		for (const BDFDB of fixtures) {
			const plugin = loadRuntimePlugin(BDFDB);
			const clone = plugin.cloneHistoricalSourceMessage(source);

			assert.notEqual(clone, source);
			assert.ok(clone instanceof SourceMessage);
			assert.equal(clone.recordMethod(), "source-record");
			assert.equal(clone.id, "m1");
			assert.equal(clone.channel_id, "c1");
			assert.equal(clone.messageSnapshots, source.messageSnapshots);
			assert.equal(clone.messageReference, source.messageReference);
			assert.notEqual(clone.embeds, source.embeds);
			assert.notEqual(clone.embeds[0], source.embeds[0]);
			assert.notEqual(clone.embeds[0].fields[0], source.embeds[0].fields[0]);
			assert.notEqual(clone.embeds[0].footer, source.embeds[0].footer);
			assert.notEqual(clone.attachments[0], source.attachments[0]);
			assert.notEqual(clone.author, source.author);

			clone.content = "changed clone";
			clone.embeds[0].fields[0].value = "changed field";
			clone.attachments[0].filename = "changed.txt";
			clone.author.username = "changed author";
			assert.equal(source.content, "historical original");
			assert.equal(source.embeds[0].fields[0].value, "value");
			assert.equal(source.attachments[0].filename, "file.txt");
			assert.equal(source.author.username, "author");
		}
	}
	finally {
		delete require.cache[runtimePath];
		delete global.window;
		delete global.BdApi;
	}
});

