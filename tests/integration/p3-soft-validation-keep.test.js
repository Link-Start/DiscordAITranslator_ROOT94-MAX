const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {createPluginInstance} = require("../helpers/createPluginInstance");
const {P3_FIXTURES, fixtureById} = require("../fixtures/p3-soft-validation-fixtures");
const {SOFT_REASONS} = require("../../src/planner/translation-soft-validation");

const BUNDLE = process.env.DTA_PLUGIN_PATH ? path.resolve(process.env.DTA_PLUGIN_PATH) : path.resolve(__dirname, "../../DiscordAITranslator.plugin.js");
const ENGINE = "custom-p3keep";
const CHANNEL_ID = "p3-soft-validation";
const tokensOf = text => (String(text).match(/⟦(?:DTA)?\d+⟧|⟦C\d+⟧/g) || []).join("");
const translated = (segment, index) => `译${index}${tokensOf(segment.text)}`;
const response = content => JSON.stringify({choices: [{message: {content}, finish_reason: "stop"}], usage: {prompt_tokens: 11, completion_tokens: 7}});

// `responder(plan, call)` returns the rows the fake provider answers with for one request.
function createHarness(responder) {
	const requests = [], stored = [], skips = [];
	const request = (url, options, callback) => {
		const body = String(options && options.body || "");
		const outer = JSON.parse(body), plan = JSON.parse(String(outer.messages[outer.messages.length - 1].content));
		requests.push({systemPrompt: outer.messages.find(message => message.role === "system").content, bytes: Buffer.byteLength(body), segmentIds: plan.segments.map(segment => segment.id), segmentTexts: plan.segments.map(segment => segment.text)});
		const rows = responder(plan, requests.length);
		queueMicrotask(() => callback(null, {statusCode: 200, headers: {}}, response(JSON.stringify({segments: rows}))));
		return {abort() {}};
	};
	const plugin = createPluginInstance({
		pluginPath: BUNDLE,
		callSetLanguages: false,
		bdfdb: {LibraryRequires: {request}},
		settings: {engines: {translator: ENGINE, backup: "----", customProviders: [{id: ENGINE, name: "Fixture"}]}, performance: {historicalConcurrency: "4", historicalSafetyDownshift: false, liveConcurrency: "1", liveStreaming: false, compactWireShadow: "off"}, filters: {receivedAutoTranslateScope: "loaded_messages", skipMixedReceivedMessages: false, useLocalLanguagePrecheck: false, minimumAutoTranslateLength: 1, autoTranslateDecisionMode: "ai"}, choices: {received: {input: "en", output: "zh-CN"}, sent: {input: "en", output: "zh-CN"}}, exceptions: {wordStart: ["!"], protectedTerms: [], wrapperPairs: [], protectedTermsForReceived: true, wrapperPairsForReceived: true}},
		defaults: {choices: {received: {value: {input: "en", output: "zh-CN"}}, sent: {value: {input: "en", output: "zh-CN"}}}}
	});
	try {plugin.onLoad();} catch {}
	plugin.settings.engines.translator = ENGINE; plugin.settings.engines.backup = "----"; plugin.settings.engines.customProviders = [{id: ENGINE, name: "Fixture"}];
	try {plugin.setLanguages();} catch {}
	plugin.ensureSettingsStore().replaceAuthKeys({[ENGINE]: {key: "fixture-key", endpoint: "https://p3.fixture/v1/chat/completions", model: "fixture-model", interfaceFormat: "openai_chat", reasoningMode: "off", reasoningProfile: "openai"}});
	plugin.getLanguageChoice = (type, place) => plugin.settings.choices[place] && plugin.settings.choices[place][type];
	plugin.getEffectivePrimaryEngine = () => ENGINE; plugin.getEffectiveBackupEngine = () => "----";
	plugin.getHistoricalAiBatchEngineKey = () => ENGINE; plugin.getHistoricalPrimaryEngineKey = () => ENGINE;
	plugin.isEngineConfiguredForRuntime = () => true; plugin.validTranslator = () => true;
	plugin.isTranslationEnabled = () => true; plugin.isMessageWithinLoadedRange = () => true; plugin.isOwnMessage = () => false; plugin.shouldAutoTranslateReceivedMessage = () => true;
	plugin.getCachedReceivedTranslation = () => null; plugin.getCachedReceivedSkipDecision = () => null;
	// Production-shaped judges: Chinese means target language; an identical echo is fully similar.
	plugin.isTranslationLikelyInTargetLanguage = value => /[\p{Script=Han}]/u.test(String(value || ""));
	plugin.getTextSimilarityScore = (a, b) => String(a).trim() === String(b).trim() ? 1 : 0;
	plugin.getAutoTranslatedResultRejectReason = () => null; plugin.isTranslationResultTooSimilar = () => false; plugin.shouldKeepAutoTranslatedResult = () => true;
	plugin.persistReceivedSkipDecision = (id, _signature, reason) => {skips.push({id: String(id), reason});};
	plugin.persistTranslationCacheEntry = (id, _signature, translation) => {stored.push({id: String(id), translation});};
	plugin.applyStoredTranslationToMessage = () => {}; plugin.scheduleReceivedDisplayFlush = () => {};
	plugin.commitReceivedDisplayResult = result => Promise.resolve({committedIds: [String(result.messageId)], confirmedIds: [String(result.messageId)], deferredIds: []});
	plugin.scheduleHistoricalTranslationJobStart = () => {}; plugin.waitForHistoricalTranslationCommit = () => Promise.resolve();
	return {plugin, requests, stored, skips};
}

function message(fixture) {
	const embeds = (fixture.embeds || []).map((embed, index) => ({id: `embed-${index}`, title: embed.title, description: embed.description, fields: (embed.fields || []).map(field => ({name: field.name, value: field.value})), footer: embed.footerText ? {text: embed.footerText} : undefined}));
	return {message: {id: fixture.id, channel_id: CHANNEL_ID, content: fixture.content, embeds, attachments: [], author: {id: "fixture-user"}}, originalContentData: {content: fixture.content, embeds: (fixture.embeds || []).map(embed => ({title: embed.title, description: embed.description, fields: (embed.fields || []).map(field => ({name: field.name, value: field.value})), footerText: embed.footerText}))}};
}

function echoResponder(echoed) {
	const set = new Set(echoed);
	return plan => plan.segments.map((segment, index) => ({id: segment.id, translation: set.has(segment.text.trim()) ? segment.text : translated(segment, index)}));
}

// Embedded messages go through the manual entry like the M3d embed test (the live registry marks
// a bare fixture embed message stale before request); plain text goes through the auto entry.
async function translateAuto(harness, fixture) {
	const {message: item, originalContentData} = message(fixture);
	const mode = fixture.embeds && fixture.embeds.length ? {manual: true} : {auto: true};
	
	const result = await harness.plugin.translateMessage(item, {id: CHANNEL_ID}, Object.assign(mode, {silent: true, trackBusy: false, originalContentData}));
	const route = harness.plugin.getTranslationTerminalLedgerSnapshot().recent.slice(-1)[0];
	return {result, route};
}

async function stop(harness) {try {await Promise.resolve(harness.plugin.onStop());} catch {}}

test("confirmed release labels and HTTP operation traces do not add provider calls", async () => {
	for (const content of ["📦 **mirasim v0.0.228** · 2026-08-25\n\nMirasim v0.0.228\n\nPlease restart the app.", "HTTP https://example.invalid/mcp > initialize\nPlease restart the app."]) {
		const harness = createHarness(plan => plan.segments.map(segment => ({id: segment.id, translation: segment.text.includes("Please restart") ? "请重启应用。" : segment.text})));
		try {
			const {result, route} = await translateAuto(harness, {id: "confirmed-label", content});
			assert.equal(result, true);
			assert.equal(harness.requests.length, 1);
			assert.equal(route.providerDispatchCount, 1);
			assert.ok(route.keptSegmentCount > 0);
			assert.equal(harness.stored[0].translation.translatedContent, content.replace("Please restart the app.", "请重启应用。"));
		} finally {await stop(harness);}
	}
});

for (const mode of ["translated-first", "repaired", "still-echoed"]) test(`short prose through the plugin: ${mode} uses the existing request budget`, async () => {
	const fixture = {id: `short-prose-${mode}`, content: "Do not publish this.", embeds: []};
	const harness = createHarness((plan, call) => plan.segments.map(segment => ({id: segment.id, translation: mode === "translated-first" || mode === "repaired" && call === 2 ? "不要发布这个。" : segment.text})));
	try {
		const {result, route} = await translateAuto(harness, fixture);
		assert.equal(result, mode !== "still-echoed");
		assert.equal(harness.requests.length, mode === "translated-first" ? 1 : mode === "repaired" ? 2 : 3);
		assert.equal(route.keptSegmentCount, 0);
		if (mode === "still-echoed") assert.equal(harness.stored.length, 0);
		else assert.equal(harness.stored[0].translation.translatedContent, "不要发布这个。");
		if (mode !== "translated-first") {
			assert.deepEqual(route.providerRoles, {primary: 1, repair: mode === "still-echoed" ? 2 : 1});
			assert.deepEqual(harness.requests[1].segmentTexts, [fixture.content]);
		}
	}
	finally {await stop(harness);}
});

test("P3 f14: forwarded embed whose title parts and footer come back untranslated commits with those segments kept, zero repairs", async () => {
	const fixture = fixtureById("f14-forward-embed-title-footer");
	const harness = createHarness(echoResponder(fixture.echoed));
	try {
		const {result, route} = await translateAuto(harness, fixture);
		assert.equal(result, true);
		assert.equal(harness.requests.length, 1, "name-like soft failures never trigger a repair");
		assert.equal(harness.stored.length, 1, "the message is cached like any translated message");
		const translation = harness.stored[0].translation, embed = translation.embeds["embed-0"];
		assert.equal(embed.title, "ECHOES OF TOMORROW | Higgsfield Community", "kept title is the source text");
		assert.match(embed.description, /^译\d+$/, "the description was translated");
		assert.equal(embed.footerText, "Higgsfield Community", "kept footer is the source text");
		assert.ok(translation.translatedContent.includes("https://higgsfield.invalid/showcase/echoes"), "the protected link is byte-conserved");
		assert.equal(route.outcome, "translated");
		assert.equal(route.reason, "committed-with-kept");
		assert.equal(route.providerDispatchCount, 1);
		assert.equal(route.keptSegmentCount, 3);
		assert.deepEqual(route.keptReasons, {"wrong-language": 3});
		assert.equal(route.validatorFamily, "segment-validator-v3");
		assert.equal(harness.skips.length, 0);
	}
	finally {await stop(harness);}
});

test("P3 f15: a channel-name line echoed next to a link and a translated sentence is kept without repair", async () => {
	const fixture = fixtureById("f15-channel-name-line-with-link");
	const harness = createHarness(echoResponder(fixture.echoed));
	try {
		const {result, route} = await translateAuto(harness, fixture);
		assert.equal(result, true);
		assert.equal(harness.requests.length, 1);
		const content = harness.stored[0].translation.translatedContent;
		assert.ok(content.startsWith("Atomic Gains"), content);
		assert.ok(content.includes("https://www.youtube.invalid/watch?v=p3fixture"), content);
		assert.match(content, /译\d+/, "the plain sentence was translated");
		assert.equal(route.reason, "committed-with-kept");
		assert.equal(route.keptSegmentCount, 1);
		assert.equal(route.providerDispatchCount, 1);
	}
	finally {await stop(harness);}
});

test("a plain sentence that keeps echoing exhausts the existing budget without a commit", async () => {
	const fixture = fixtureById("f16-plain-sentence-echoed");
	const harness = createHarness(plan => plan.segments.map(segment => ({id: segment.id, translation: segment.text})));
	try {
		const {result, route} = await translateAuto(harness, fixture);
		assert.equal(result, false);
		assert.equal(harness.requests.length, 3, "primary plus the existing two bounded repairs");
		assert.deepEqual(harness.requests[1].segmentIds, harness.requests[0].segmentIds, "the repair re-sends the one failed segment");
		assert.equal(harness.stored.length, 0, "failed output must not enter the paid success cache");
		assert.equal(route.outcome, "failed");
		assert.notEqual(route.reason, "committed-with-kept");
		assert.equal(route.providerDispatchCount, 3);
		assert.deepEqual(route.providerRoles, {primary: 1, repair: 2});
		assert.equal(route.keptSegmentCount, 0);
		assert.deepEqual(route.keptReasons, {});
	}
	finally {await stop(harness);}
});

test("P3 f17: a hard failure (missing segment) keeps the P2 policy: repairs until the attempt budget, then the message fails", async () => {
	const fixture = fixtureById("f17-missing-segment-hard-failure");
	const harness = createHarness(plan => plan.segments.slice(0, plan.segments.length - 1).map((segment, index) => ({id: segment.id, translation: translated(segment, index)})));
	try {
		const {result, route} = await translateAuto(harness, fixture);
		assert.equal(result, false);
		assert.equal(harness.requests.length, 3, "primary + two repairs, exactly as before P3");
		assert.equal(harness.stored.length, 0);
		assert.equal(route.outcome, "failed");
		assert.equal(route.providerDispatchCount, 3);
		assert.equal(route.keptSegmentCount, 0);
		assert.deepEqual(route.keptReasons, {});
		assert.notEqual(route.reason, "committed-with-kept");
	}
	finally {await stop(harness);}
});

test("P3 f18: a reply preview with nothing translatable is skipped (all_protected), never dispatched, never counted as failed", async () => {
	const fixture = fixtureById("f18-all-protected-reply");
	const harness = createHarness(() => {throw new Error("no request expected");});
	try {
		const translation = await new Promise(resolve => harness.plugin.translateText(fixture.content, "received", value => resolve(value), null, {channelId: CHANNEL_ID, showToast: false, showFailureToast: false, trackBusy: false}));
		assert.equal(translation || "", "");
		assert.equal(harness.requests.length, 0);
		const reply = harness.plugin.getTranslationTerminalLedgerSnapshot().recent.slice(-1)[0];
		assert.equal(reply.lane, "reply");
		assert.deepEqual([reply.outcome, reply.stage, reply.reason], ["skipped", "protection", "all_protected"]);
		assert.equal(reply.providerDispatchCount, 0);
		// Scope: only the reply lane changes; a manual click on the same text still reports failed/all_protected.
		await new Promise(resolve => harness.plugin.translateText(fixture.content, "received", value => resolve(value), null, {channelId: CHANNEL_ID, showToast: false, showFailureToast: false, trackBusy: false, terminalLane: "manual", terminalEntry: "manual-click"}));
		const manual = harness.plugin.getTranslationTerminalLedgerSnapshot().recent.slice(-1)[0];
		assert.deepEqual([manual.lane, manual.outcome, manual.reason], ["manual", "failed", "all_protected"]);
		const snapshot = harness.plugin.getTranslationTerminalLedgerSnapshot();
		assert.equal(snapshot.outcomes.skipped >= 1, true);
	}
	finally {await stop(harness);}
});

test("P3 ledger routes carry numeric kept fields and closed reason labels, and the diagnostics copy carries no text", async () => {
	const fixture = fixtureById("f14-forward-embed-title-footer");
	const harness = createHarness(echoResponder(fixture.echoed));
	try {
		await translateAuto(harness, fixture);
		const snapshot = harness.plugin.getTranslationTerminalLedgerSnapshot();
		for (const route of snapshot.recent) {
			assert.equal(typeof route.keptSegmentCount, "number");
			assert.ok(Number.isInteger(route.keptSegmentCount) && route.keptSegmentCount >= 0);
			assert.equal(typeof route.keptReasons, "object");
			for (const [reason, count] of Object.entries(route.keptReasons)) {assert.ok(SOFT_REASONS.includes(reason), reason); assert.ok(Number.isInteger(count) && count > 0);}
		}
		assert.equal(snapshot.reasons["committed-with-kept"], 1);
		assert.doesNotMatch(JSON.stringify(snapshot), /ECHOES|Higgsfield|higgsfield\.invalid|generative tools/, "the ledger never carries message text");
		assert.equal(P3_FIXTURES.length, 7);
	}
	finally {await stop(harness);}
});

for (const content of ["明天nova 4.1来不来", "免费的orion 100%路由了", "atlas cloud？", "支持 Atlas Code、Nova Code 和 Atlas/Nova 协议"]) test(`confirmed unchanged finishes normally without repair: ${content}`, async () => {
	const harness = createHarness(plan => plan.segments.map(row => ({id: row.id, translation: "__KEEP_NAME__"})));
	try {
		const {result, route} = await translateAuto(harness, {id: "confirmed-name", content});
		assert.equal(result, true);
		assert.equal(route.outcome, "skipped");
		assert.equal(harness.requests.length, 1);
		assert.equal(harness.stored.length, 0);
		assert.deepEqual(harness.skips, [{id: "confirmed-name", reason: "ai_skip_signal"}]);
	} finally {await stop(harness);}
});

 test("a burst requeue carries repair feedback into its existing single request without changing its budget", async () => {
	const harness = createHarness(plan => plan.segments.map(row => ({id: row.id, translation: "__KEEP_NAME__"})));
	try {
		const {message: item, originalContentData} = message({id: "burst-requeued-name", content: "明天nova 4.1来不来"});
		const result = await harness.plugin.translateMessage(item, {id: CHANNEL_ID}, {auto: true, silent: true, trackBusy: false, originalContentData, liveSingleSource: "burst-requeue"});
		assert.equal(result, true);
		assert.equal(harness.requests.length, 1);
		assert.match(harness.requests[0].systemPrompt, /Repair pass:/);
		assert.equal(harness.skips.length, 1);
		assert.equal(harness.stored.length, 0);
	} finally {await stop(harness);}
});
