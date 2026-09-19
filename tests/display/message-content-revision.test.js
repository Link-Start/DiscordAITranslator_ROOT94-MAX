const test = require("node:test");
const assert = require("node:assert/strict");
const {createMessageContentRevisionGuard, installMessageContentRevisionGuard} = require("../../src/display/message-content-revision");

test("same-text memoization must release a body when translation or loading revision changes", () => {
	let revision = 1;
	const guard = createMessageContentRevisionGuard({getView: () => ({revision})});
	const props = () => ({message: {id: "m", content: "Higgsfield Genjutsu"}});
	const first = props(), second = props();
	assert.equal(guard(first, second, true), false, "first observation establishes the translated render");
	const stable = props();
	assert.equal(guard(second, stable, true), true, "unchanged revision preserves Discord memoization");
	revision = 2;
	const translated = props();
	assert.equal(guard(stable, translated, true), false, "same text with a new watermark must render");
	revision = 3;
	const cancelled = props();
	assert.equal(guard(translated, cancelled, true), false, "same text with loading removed must render");
	assert.equal(guard(cancelled, props(), true), true);
});

test("unrelated rows and reply previews retain their original comparator result", () => {
	const guard = createMessageContentRevisionGuard({getView: id => id === "translated" ? {revision: 1} : null});
	const plain = {message: {id: "other"}};
	assert.equal(guard(plain, {...plain}, true), true);
	assert.equal(guard(plain, {...plain}, false), false);
	const reply = {message: {id: "translated", __DiscordAITranslatorReplyPreview: true}};
	assert.equal(guard(reply, {...reply}, true), true);
});

test("removed display state invalidates a previously translated body", () => {
	let view = {revision: 7};
	const guard = createMessageContentRevisionGuard({getView: () => view});
	const before = {message: {id: "m"}}, translated = {...before};
	guard(before, translated, true);
	view = null;
	const restored = {...before};
	assert.equal(guard(translated, restored, true), false);
	assert.equal(guard(restored, {...before}, true), true);
});

test("forwarded body revision crosses the accessories update gate without rebuilding ordinary accessories", () => {
	let revision = 1;
	class Accessories {
		shouldComponentUpdate() {return this.codedLinks !== this.giftCodes && !!this.attachments;}
		renderForwardedMessage() {}
	}
	let hook;
	installMessageContentRevisionGuard({
		plugin: {getReceivedDisplayRuntimeView: () => ({revision})},
		Webpack: {getModule: filter => filter(Accessories) ? Accessories : null},
		BDFDB: {PatchUtils: {patch: (_plugin, target, method, patches) => {
			assert.equal(target, Accessories.prototype);
			assert.equal(method, "shouldComponentUpdate");
			hook = patches.after;
		}}}
	});
	assert.equal(typeof hook, "function");
	const props = () => ({message: {id: "m", content: "", messageSnapshots: [{message: {content: "source"}}]}});
	const previous = props(), next = props();
	const run = (before, after, native = false) => {
		const event = {instance: {props: before}, methodArguments: [after, {}], returnValue: native};
		hook(event);
		return event.returnValue;
	};
	assert.equal(run(previous, next), true);
	const stable = props();
	assert.equal(run(next, stable), false);
	revision++;
	assert.equal(run(stable, props()), true);
	assert.equal(run({message: {id: "m"}}, {message: {id: "m"}}), false);
});
