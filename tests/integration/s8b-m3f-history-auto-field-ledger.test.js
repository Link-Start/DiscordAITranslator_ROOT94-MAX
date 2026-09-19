const test = require("node:test");
const assert = require("node:assert/strict");
const {createPluginInstance} = require("../helpers/createPluginInstance");
const {original14Markdown, targetBodyForeignTitle} = require("../fixtures/s8b-m0a-mixed-language-fixtures");

function fixture() {
	const plugin = createPluginInstance({callSetLanguages: false, settings: {
		engines: {translator: "custom-m3f", backup: "----", customProviders: [{id: "custom-m3f", name: "Fixture"}]},
		filters: {receivedAutoTranslateScope: "loaded_messages", skipMixedReceivedMessages: false, useLocalLanguagePrecheck: false, minimumAutoTranslateLength: 1},
		choices: {received: {input: "en", output: "zh-CN"}, sent: {input: "en", output: "zh-CN"}},
		exceptions: {wrapperPairs: ['"|"', '`|`'], protectedTerms: []},
		defaults: {choices: {received: {value: {input: "en", output: "zh-CN"}}, sent: {value: {input: "en", output: "zh-CN"}}}}
	}});
	try {plugin.onLoad();} catch {}
	plugin.settings.engines.translator = "custom-m3f";
	plugin.settings.engines.customProviders = [{id: "custom-m3f", name: "Fixture"}];
	try {plugin.setLanguages();} catch {}
	plugin.ensureSettingsStore().replaceAuthKeys({"custom-m3f": {key: "fixture", endpoint: "https://m3f.fixture/v1/chat/completions", model: "fixture", interfaceFormat: "openai_chat", reasoningMode: "off"}});
	plugin.isTranslationEnabled = () => true;
	plugin.isOwnMessage = () => false;
	plugin.isMessageDisplayTranslated = () => false;
	plugin.ensureReceivedDisplayRuntime().isSuppressed = () => false;
	plugin.ensureLiveTranslationQueue().isMessageQueued = () => false;
	return plugin;
}

function received(id, content = original14Markdown) {
	return {id: String(id), channel_id: "history-field", content, embeds: [], attachments: [], author: {id: "other"}};
}

test("M3f exact received history eligibility owns one anonymous route before collection", async () => {
	const plugin = fixture(), message = received("target-message"), source = plugin.extractOriginalContentData(message);
	try {
		const observed = plugin.observeHistoricalAutoEligibility(message, {id: "history-field"}, source, {origin: "history-render", ignoreQueued: true});
		assert.equal(observed.eligible, true);
		assert.match(observed.routeId, /^rt1:/);
		assert.match(observed.messageIdentity, /^mi1:[a-f0-9]{16}$/);
		assert.match(observed.sourceIdentity, /^si1:[a-f0-9]{16}$/);
		plugin.recordHistoricalAutoCheckpoint(observed.routeId, "collector", "accepted");
		plugin.finishTranslationTerminalRoute(observed.routeId, {outcome: "translated", stage: "display-currentness", reason: "committed", historyCheckpoint: {stage: "display-currentness", reason: "confirmed"}});
		const terminal = plugin.getTranslationTerminalLedgerSnapshot().recent.at(-1);
		assert.equal(terminal.messageIdentity, observed.messageIdentity);
		assert.equal(terminal.sourceIdentity, observed.sourceIdentity);
		assert.deepEqual(terminal.historyPath, ["eligibility:plan_translate", "collector:accepted", "display-currentness:confirmed"]);
		assert.equal(JSON.stringify(terminal).includes("target-message"), false);
		assert.equal(JSON.stringify(terminal).includes("Degree of Interest"), false);
	}
	finally {try {await plugin.onStop();} catch {}}
});

test("M3f semantic-capable received eligibility is decided by the shared plan instead of legacy whole-message majority", async () => {
	const plugin = fixture(), message = received("foreign-title", targetBodyForeignTitle), source = plugin.extractOriginalContentData(message);
	try {
		plugin.settings.engines.translator = "googleapi";
		assert.deepEqual(plugin.getReceivedAutoTranslateEligibility(message, {id: "history-field"}, source, true), {eligible: true, reason: "plan_translate"});
		plugin.settings.engines.translator = "custom-m3f";
		const eligibility = plugin.getReceivedAutoTranslateEligibility(message, {id: "history-field"}, source, true);
		assert.deepEqual(eligibility, {eligible: true, reason: "plan_translate"});
		assert.equal(plugin.shouldSkipReceivedTranslationBeforeRequest(source, "history-field"), false);
		const request = plugin.createAtomicSemanticRevisionContract(plugin.buildTranslationRequestText(source), {place: "received", channelId: "history-field", engineKey: "custom-m3f", inputLanguageId: "en", targetLanguageId: "zh-CN", fieldPath: "body"});
		assert.equal(request.enabled, true);
		assert.ok(request.segmentOrder.length > 0);
	}
	finally {try {await plugin.onStop();} catch {}}
});

test("M3g shared plan skips true no-translate content while unverified providers keep legacy wire only", async () => {
	const plugin = fixture(), protectedMessage = received("protected", "你好世界"), protectedSource = plugin.extractOriginalContentData(protectedMessage);
	try {
		assert.deepEqual(plugin.getReceivedAutoTranslateEligibility(protectedMessage, {id: "history-field"}, protectedSource, true), {eligible: false, reason: "plan_no_translate"});
		plugin.settings.engines.translator = "googleapi";
		const legacyMessage = received("legacy-title", targetBodyForeignTitle), legacySource = plugin.extractOriginalContentData(legacyMessage);
		assert.deepEqual(plugin.getReceivedAutoTranslateEligibility(legacyMessage, {id: "history-field"}, legacySource, true), {eligible: true, reason: "plan_translate"});
		const production = plugin.createAtomicSemanticRevisionContract(plugin.buildTranslationRequestText(legacySource), {place: "received", channelId: "history-field", engineKey: "googleapi", inputLanguageId: "en", targetLanguageId: "zh-CN", fieldPath: "body"});
		assert.equal(production.enabled, false);
		assert.equal(production.fallbackReason, "capability-unverified");
	}
	finally {try {await plugin.onStop();} catch {}}
});

test("M3i exact Google history invalidates the v2 skip then enters the classic marked plan wire", async () => {
	const plugin = fixture(), message = received("field-exact-skip", original14Markdown), source = plugin.extractOriginalContentData(message), channel = {id: "history-field"};
	plugin.settings.engines.translator = "googleapi";
	try {
		const signature = plugin.createReceivedTranslationSignature(message, channel.id, source);
		plugin.persistReceivedSkipDecision(message.id, signature, "too_similar", "old preview");
		plugin.getPersistedTranslationCacheEntry(message.id).skipped.policyVersion = 2;
		const observed = plugin.observeHistoricalAutoEligibility(message, channel, source, {origin: "history-render", ignoreQueued: true});
		assert.equal(observed.eligible, true);
		assert.equal(observed.reason, "plan_translate");
		assert.equal(plugin.getPersistedTranslationCacheEntry(message.id), null);
		const input = plugin.ensureSettingsStore().getLanguage("en"), output = plugin.ensureSettingsStore().getLanguage("zh-CN"), queueItem = {message, channel, originalContentData: source, terminalRouteId: observed.routeId};
		const prepared = plugin.prepareHistoricalAiBatchQueueItem(queueItem, channel.id, input, output);
		assert.equal(prepared.skipped, undefined);
		assert.equal(prepared.semanticRequest.enabled, true);
		assert.equal(prepared.semanticRequest.adapter, "classic-marked");
		assert.equal(prepared.semanticRequest.plan.plannerVersion, "m3i-v2");
		assert.ok(typeof prepared.protectedText === "string" && prepared.protectedText.length > 0);
		assert.ok(Object.keys(prepared.exceptions).length > 0);
		assert.equal(prepared.semanticRequest.plan.nodes.some(node => node.classification === "protected" && node.raw.includes("4-3")), true);
		assert.doesNotMatch(prepared.protectedText, /可以。|```text|4-3/);
		for (const term of ["Spouse/Dependent", "GED", "Non-Degree", "In-state", "Out-of-state", "Self-Pay"]) assert.match(prepared.protectedText, new RegExp(term.replace(/[/-]/g, "\\$&")));
		plugin.finishTranslationTerminalRoute(observed.routeId, {outcome: "cancelled", stage: "display-currentness", reason: "test_cleanup"});
	}
	finally {try {await plugin.onStop();} catch {}}
});

test("M3f filtered received history produces a unique terminal precheck route without provider dispatch", async () => {
	const plugin = fixture(), message = received("self-message", "Hello world"), source = plugin.extractOriginalContentData(message);
	plugin.isOwnMessage = () => true;
	try {
		const observed = plugin.observeHistoricalAutoEligibility(message, {id: "history-field"}, source, {origin: "history-source", ignoreQueued: true});
		assert.equal(observed.eligible, false);
		assert.equal(observed.reason, "self_authored");
		assert.equal(observed.routeId, null);
		const terminal = plugin.getTranslationTerminalLedgerSnapshot().recent.at(-1);
		assert.equal(terminal.outcome, "skipped");
		assert.equal(terminal.stage, "precheck");
		assert.equal(terminal.reason, "self_authored");
		assert.equal(terminal.providerDispatchCount, 0);
		assert.deepEqual(terminal.historyPath, ["eligibility:self_authored"]);
		assert.match(terminal.messageIdentity, /^mi1:/);
	}
	finally {try {await plugin.onStop();} catch {}}
});
