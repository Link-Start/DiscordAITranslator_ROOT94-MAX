const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {createPluginInstance} = require("../helpers/createPluginInstance");
const {
	SEMANTIC_REVISION,
	PROTECTION_VERSION,
	createSemanticWorkloadKey
} = require("../../src/planner/translation-semantic-revision");
const {
	TRANSLATION_PROTECTION_SIGNATURE_VERSION
} = require("../../src/protection/protection-logic");

const CURRENT = process.env.DTA_PLUGIN_PATH
	? path.resolve(process.env.DTA_PLUGIN_PATH)
	: path.resolve(__dirname, "../../DiscordAITranslator.plugin.js");
const CHANNEL_ID = "p1-semantic-protection";
const CUSTOM_ENGINE = "custom-p1semantic";
const SOURCE = "Contact john.doe@example.com at https://api.example.com/path or docs.example.org and 192.168.1.5:8443 about Longma using \"KEEP THIS\". GED and Non-Degree remain translatable.";
const HARD_PROTECTED = Object.freeze([
	"john.doe@example.com",
	"https://api.example.com/path",
	"docs.example.org",
	"192.168.1.5:8443"
]);
const USER_PROTECTED = Object.freeze(["Longma", "\"KEEP THIS\""]);
const ALL_PROTECTED = Object.freeze(HARD_PROTECTED.concat(USER_PROTECTED));

function openAiResponse(content) {
	return {
		status: 200,
		headers: {get: () => "application/json"},
		text: () => Promise.resolve(JSON.stringify({
			choices: [{message: {content}, finish_reason: "stop"}],
			usage: {prompt_tokens: 30, completion_tokens: 12}
		}))
	};
}

// P2 merged ranges carry their protection placeholders inside the segment text; a valid
// translation echoes every ⟦...⟧ token, as the system prompt instructs the provider.
function translatedRows(plan, prefix = "译文") {
	return plan.segments.map((segment, index) => ({id: segment.id, translation: `${prefix}${index}${(String(segment.text).match(/⟦(?:DTA)?\d+⟧|⟦C\d+⟧/g) || []).join("")}`}));
}

function createFixture({engine = "oaicompat", exceptionOverrides = {}} = {}) {
	const requests = [];
	const fetch = async (_url, options) => {
		const outer = JSON.parse(options.body);
		const wire = String(outer.messages.at(-1).content);
		const plan = JSON.parse(wire);
		requests.push({outer, wire, plan});
		return openAiResponse(JSON.stringify({segments: translatedRows(plan)}));
	};
	const request = (url, options, callback) => {
		let cancelled = false;
		Promise.resolve(fetch(url, options)).then(async result => {
			if (cancelled) return;
			const body = result && typeof result.text === "function" ? await result.text() : "";
			callback(null, {statusCode: result && result.status || 200, headers: {}}, body);
		}, error => {if (!cancelled) callback(error);});
		return {abort: () => {cancelled = true;}};
	};
	const plugin = createPluginInstance({
		pluginPath: CURRENT,
		callSetLanguages: false,
		bdfdb: {LibraryRequires: {request}},
		settings: {
			engines: {
				translator: engine,
				backup: "----",
				customProviders: engine.startsWith("custom-") ? [{id: engine, name: "P1 fixture"}] : []
			},
			performance: {
				historicalConcurrency: "4",
				historicalSafetyDownshift: false,
				liveConcurrency: "1",
				liveStreaming: true
			},
			filters: {
				receivedAutoTranslateScope: "loaded_messages",
				skipMixedReceivedMessages: false,
				useLocalLanguagePrecheck: false,
				minimumAutoTranslateLength: 1,
				autoTranslateDecisionMode: "ai"
			},
			choices: {
				received: {input: "en", output: "zh-CN"},
				sent: {input: "en", output: "zh-CN"}
			},
			exceptions: Object.assign({
				wordStart: ["!"],
				protectedTerms: ["Longma"],
				wrapperPairs: ['"|"'],
				protectedTermsForReceived: true,
				protectedTermsForSent: true,
				wrapperPairsForReceived: true,
				wrapperPairsForSent: true
			}, exceptionOverrides)
		},
		defaults: {
			choices: {
				received: {value: {input: "en", output: "zh-CN"}},
				sent: {value: {input: "en", output: "zh-CN"}}
			}
		}
	});
	// Provider-client captures the host fetch seam during onLoad. Install it before
	// composing the runtime rather than only before the first request.
	global.BdApi.Net = {fetch};
	try {plugin.onLoad();}
	catch {}
	plugin.settings.engines.translator = engine;
	plugin.settings.engines.backup = "----";
	plugin.settings.exceptions = Object.assign({}, plugin.settings.exceptions || {}, {
		wordStart: ["!"],
		protectedTerms: ["Longma"],
		wrapperPairs: ['"|"'],
		protectedTermsForReceived: true,
		protectedTermsForSent: true,
		wrapperPairsForReceived: true,
		wrapperPairsForSent: true
	}, exceptionOverrides);
	if (engine.startsWith("custom-")) plugin.settings.engines.customProviders = [{id: engine, name: "P1 fixture"}];
	try {plugin.setLanguages();}
	catch {}
	plugin.ensureSettingsStore().replaceAuthKeys({
		[engine]: {
			key: "fixture-key",
			endpoint: "https://p1.fixture/v1/chat/completions",
			model: "fixture-model",
			interfaceFormat: "openai_chat",
			reasoningMode: "off",
			reasoningProfile: "openai"
		}
	});
	plugin.getLanguageChoice = (type, place) => plugin.settings.choices[place] && plugin.settings.choices[place][type];
	plugin.getEffectivePrimaryEngine = () => engine;
	plugin.getEffectiveBackupEngine = () => "----";
	plugin.getHistoricalAiBatchEngineKey = () => engine;
	plugin.getHistoricalPrimaryEngineKey = () => engine;
	plugin.isEngineConfiguredForRuntime = () => true;
	plugin.validTranslator = () => true;
	plugin.isTranslationEnabled = () => true;
	plugin.isMessageWithinLoadedRange = () => true;
	plugin.isOwnMessage = () => false;
	plugin.shouldAutoTranslateReceivedMessage = () => true;
	plugin.getCachedReceivedTranslation = () => null;
	plugin.getCachedReceivedSkipDecision = () => null;
	plugin.isTranslationLikelyInTargetLanguage = () => true;
	plugin.getTextSimilarityScore = () => 0;
	plugin.getAutoTranslatedResultRejectReason = () => null;
	plugin.isTranslationResultTooSimilar = () => false;
	plugin.shouldKeepAutoTranslatedResult = () => true;
	plugin.persistReceivedSkipDecision = () => {};
	plugin.persistTranslationCacheEntry = () => {};
	plugin.applyStoredTranslationToMessage = () => {};
	plugin.scheduleReceivedDisplayFlush = () => {};
	plugin.commitReceivedDisplayResult = result => Promise.resolve({
		committedIds: [String(result.messageId)],
		confirmedIds: [String(result.messageId)],
		deferredIds: []
	});
	plugin.scheduleHistoricalTranslationJobStart = () => {};
	plugin.waitForHistoricalTranslationCommit = () => Promise.resolve();
	return {plugin, requests};
}

async function stopFixture(fixture) {
	delete global.BdApi.Net;
	try {await Promise.resolve(fixture.plugin.onStop());}
	catch {}
}

// P2 changed the typed wire: a merged range keeps its P1 placeholders as bare protocol tokens
// inside the segment text, so the wire may carry `⟦N⟧` but never a protected value, a
// spaced marker variant, or a local `⟦Cn⟧` for these sources (they have no inline leaves).
function assertProtectedValuesAbsentFromWire(wire, values = ALL_PROTECTED) {
	for (const value of values) assert.equal(wire.includes(value), false, `protected value leaked to provider wire: ${value}`);
	for (const marker of wire.match(/⟦[^⟧\r\n]*⟧/g) || []) assert.match(marker, /^⟦\d+⟧$/, `unexpected marker on provider wire: ${marker}`);
}

function assertNaturalAdmissionsTermsRemainTranslatable(wire) {
	assert.match(wire, /GED/, "GED remains natural language for the AI");
	assert.match(wire, /Non-Degree/, "Non-Degree remains natural language for the AI");
}

function assertExactProtectionReplay(translation) {
	for (const value of ALL_PROTECTED) {
		assert.equal(String(translation).split(value).length - 1, 1, `protected value must be restored exactly once: ${value}`);
	}
	assert.doesNotMatch(String(translation), /⟦\s*(?:DTA\s*)?\d+\s*⟧/);
}

function runTranslateText(plugin, source = SOURCE, options = {}) {
	return new Promise(resolve => plugin.translateText(source, "received", (translation, input, output, meta) => resolve({translation, input, output, meta}), null, Object.assign({
		channelId: CHANNEL_ID,
		showToast: false,
		showFailureToast: false,
		trackBusy: false
	}, options)));
}

function createQueueItem(id, source = SOURCE) {
	const message = {id: String(id), channel_id: CHANNEL_ID, content: source, embeds: [], attachments: [], author: {id: "other-user"}};
	return {
		message,
		channel: {id: CHANNEL_ID},
		originalContentData: {content: source, embeds: []}
	};
}

function prepareReceivedBatchItem(plugin, id, source = SOURCE) {
	return plugin.prepareHistoricalAiBatchQueueItem(createQueueItem(id, source), CHANNEL_ID, {id: "en", name: "English"}, {id: "zh-CN", name: "Chinese"});
}

function semanticRows(request) {
	return translatedRows(JSON.parse(request.wire));
}

for (const engine of [CUSTOM_ENGINE, "oaicompat"]) {
	test(`P1 ${engine} received semantic wire hides deterministic/user protection and restores it exactly`, async () => {
		const fixture = createFixture({engine});
		try {
			const outcome = await runTranslateText(fixture.plugin);
			assert.equal(fixture.requests.length, 1);
			const request = fixture.requests[0];
			assert.equal(request.plan.schemaVersion, "segment-json-v2");
			assertProtectedValuesAbsentFromWire(request.wire);
			assertNaturalAdmissionsTermsRemainTranslatable(request.wire);
			assertExactProtectionReplay(outcome.translation);
			assert.equal(outcome.meta.semanticRevision, "s8b-p2-v1");
			assert.equal(outcome.meta.failed, false);
		}
		finally {await stopFixture(fixture);}
	});
}

test("P1 received exception scope switches gate only configured terms and wrapper pairs", async () => {
	const configuredOnly = createFixture({exceptionOverrides: {protectedTermsForReceived: true, wrapperPairsForReceived: false}});
	try {
		await runTranslateText(configuredOnly.plugin);
		const wire = configuredOnly.requests[0].wire;
		assert.equal(wire.includes("Longma"), false);
		assert.match(wire, /KEEP THIS/);
		assertProtectedValuesAbsentFromWire(wire, HARD_PROTECTED);
		assertNaturalAdmissionsTermsRemainTranslatable(wire);
	}
	finally {await stopFixture(configuredOnly);}

	const wrappersOnly = createFixture({exceptionOverrides: {protectedTermsForReceived: false, wrapperPairsForReceived: true}});
	try {
		await runTranslateText(wrappersOnly.plugin);
		const wire = wrappersOnly.requests[0].wire;
		assert.match(wire, /Longma/);
		assert.equal(wire.includes("KEEP THIS"), false);
		assertProtectedValuesAbsentFromWire(wire, HARD_PROTECTED);
		assertNaturalAdmissionsTermsRemainTranslatable(wire);
	}
	finally {await stopFixture(wrappersOnly);}

	const bothOff = createFixture({exceptionOverrides: {protectedTermsForReceived: false, wrapperPairsForReceived: false, protectedTermsForSent: true, wrapperPairsForSent: true}});
	try {
		await runTranslateText(bothOff.plugin);
		const wire = bothOff.requests[0].wire;
		assert.match(wire, /Longma/);
		assert.match(wire, /KEEP THIS/);
		assertProtectedValuesAbsentFromWire(wire, HARD_PROTECTED);
		assertNaturalAdmissionsTermsRemainTranslatable(wire);
	}
	finally {await stopFixture(bothOff);}
});

test("P1 history preparation and validation use the same protected semantic source and exact replay", async () => {
	const fixture = createFixture();
	try {
		const prepared = prepareReceivedBatchItem(fixture.plugin, "history");
		assert.ok(prepared && prepared.semanticRequest && prepared.semanticRequest.enabled);
		assertProtectedValuesAbsentFromWire(prepared.semanticRequest.wire);
		assertNaturalAdmissionsTermsRemainTranslatable(prepared.semanticRequest.wire);
		assert.deepEqual(new Set(Object.values(prepared.exceptions || {})), new Set(ALL_PROTECTED));
		const result = fixture.plugin.validateHistoricalTranslationJobResult(prepared, {semanticSegments: semanticRows(prepared.semanticRequest)}, {id: "p1-history-job", channelId: CHANNEL_ID});
		assert.equal(result.ok, true, JSON.stringify(result));
		assertExactProtectionReplay(result.translation.translatedContent);
		assert.equal(result.translation.semanticRevision, "s8b-p2-v1");
	}
	finally {await stopFixture(fixture);}
});

test("P1 manual auto history and live-burst production seams all converge on protected semantic requests", async () => {
	const fixture = createFixture({engine: CUSTOM_ENGINE});
	try {
		const manual = await runTranslateText(fixture.plugin, SOURCE, {terminalLane: "manual", terminalEntry: "manual-click"});
		const automatic = await runTranslateText(fixture.plugin, SOURCE, {auto: true, terminalLane: "auto-single", terminalEntry: "received-auto"});
		assertExactProtectionReplay(manual.translation);
		assertExactProtectionReplay(automatic.translation);
		assert.equal(fixture.requests.length, 2);
		for (const request of fixture.requests) assertProtectedValuesAbsentFromWire(request.wire);

		const history = prepareReceivedBatchItem(fixture.plugin, "history-seam");
		const liveBurst = prepareReceivedBatchItem(fixture.plugin, "live-burst-seam");
		assertProtectedValuesAbsentFromWire(history.semanticRequest.wire);
		assertProtectedValuesAbsentFromWire(liveBurst.semanticRequest.wire);
		assert.deepEqual(history.semanticRequest.segmentOrder, liveBurst.semanticRequest.segmentOrder);

		const liveWiring = fs.readFileSync(path.resolve(__dirname, "../../src/orchestrator/live-translation-queue-wiring.js"), "utf8");
		assert.match(liveWiring, /prepareBurstItem:[\s\S]*prepareHistoricalAiBatchQueueItem\(queueItem, channelId, context\.input, context\.output\)/);
	}
	finally {await stopFixture(fixture);}
});

test("P1 bumps every cache/protection identity that changes semantic masking", () => {
	assert.equal(SEMANTIC_REVISION, "s8b-p2-v1");
	assert.equal(PROTECTION_VERSION, "planner-protection-v3");
	assert.equal(TRANSLATION_PROTECTION_SIGNATURE_VERSION, "2026-08-29-semantic-protect-v12");
	const workload = createSemanticWorkloadKey({
		plannerVersion: "m3i-v2",
		languagePair: "en:zh-CN",
		providerSemanticRevision: SEMANTIC_REVISION
	});
	assert.equal(workload.fields.semanticRevision, "s8b-p2-v1");
	assert.equal(workload.fields.providerSemanticRevision, "s8b-p2-v1");
	assert.equal(workload.fields.protectionVersion, "planner-protection-v3");

	const fixture = createFixture();
	try {
		const configuration = fixture.plugin.getReceivedTranslationRequestConfigurationData(CHANNEL_ID);
		assert.equal(configuration.protectionVersion, "2026-08-29-semantic-protect-v12");
		assert.equal(configuration.providerSemanticRevision, "s8b-p2-v1");
		const signature = JSON.parse(fixture.plugin.createReceivedTranslationSignature(
			{id: "signature", content: SOURCE, embeds: []},
			CHANNEL_ID,
			{content: SOURCE, embeds: []}
		));
		assert.equal(signature.protectionVersion, "2026-08-29-semantic-protect-v12");
		assert.equal(signature.providerSemanticRevision, "s8b-p2-v1");
	}
	finally {
		delete global.BdApi.Net;
		try {fixture.plugin.onStop();}
		catch {}
	}
});

test("P1 raw cache identity differs when only a protected value changes", async () => {
	const fixture = createFixture();
	try {
		fixture.plugin.settings.exceptions.protectedTerms = ["Longma", "OpenAI"];
		const first = fixture.plugin.createAtomicSemanticRevisionContract("Contact Longma before Friday.", {place: "received", channelId: CHANNEL_ID, engineKey: "oaicompat", inputLanguageId: "en", targetLanguageId: "zh-CN", fieldPath: "body"});
		const second = fixture.plugin.createAtomicSemanticRevisionContract("Contact OpenAI before Friday.", {place: "received", channelId: CHANNEL_ID, engineKey: "oaicompat", inputLanguageId: "en", targetLanguageId: "zh-CN", fieldPath: "body"});
		assert.equal(first.plan.sourceHash, second.plan.sourceHash, "masked plans intentionally share one skeleton");
		assert.notEqual(fixture.plugin.getAtomicSemanticPlanHash(first), fixture.plugin.getAtomicSemanticPlanHash(second), "paid dual-read identity must retain the raw protected value");
	}
	finally {await stopFixture(fixture);}
});

test("P1 semantic exact restore preserves source placeholder lookalikes and word-start terms", async () => {
	const fixture = createFixture();
	try {
		fixture.plugin.settings.exceptions.protectedTerms = ["!Longma"];
		fixture.plugin.settings.exceptions.wordStart = ["!"];
		const source = "Keep ⟦0⟧, ⟦DTA0⟧, [0], 【0】 and {{0}} beside !Longma.";
		const request = fixture.plugin.createAtomicSemanticRevisionContract(source, {place: "received", channelId: CHANNEL_ID, engineKey: "oaicompat", inputLanguageId: "en", targetLanguageId: "zh-CN", fieldPath: "body"});
		const state = fixture.plugin.getAtomicSemanticLocalState(request);
		assert.equal(Object.values(state.protectedSegments).includes("!Longma"), true);
		assert.equal(Object.prototype.hasOwnProperty.call(state.protectedSegments, "0"), false, "generated ids start after an existing exact source marker");
		const outcome = fixture.plugin.validateAtomicSemanticResponse(request, {segments: semanticRows(request)}, {likelyTarget: () => true, similarity: () => 0});
		assert.equal(outcome.ok, true);
		for (const literal of ["⟦0⟧", "⟦DTA0⟧", "[0]", "【0】", "{{0}}", "!Longma"]) assert.equal(outcome.translation.includes(literal), true, literal);
	}
	finally {await stopFixture(fixture);}
});

test("P1 placeholder allocation stays exact beside MAX_SAFE source lookalikes", async () => {
	const fixture = createFixture();
	try {
		const literals = ["⟦9007199254740991⟧", "⟦9007199254740990⟧", "Longma", '"X"'];
		const source = `Keep ${literals.join(" and ")}.`;
		const request = fixture.plugin.createAtomicSemanticRevisionContract(source, {place: "received", channelId: CHANNEL_ID, engineKey: "oaicompat", inputLanguageId: "en", targetLanguageId: "zh-CN", fieldPath: "body"});
		const state = fixture.plugin.getAtomicSemanticLocalState(request);
		assert.equal(new Set(Object.keys(state.protectedSegments)).size, Object.keys(state.protectedSegments).length, "every protected span owns a distinct safe key");
		const outcome = fixture.plugin.validateAtomicSemanticResponse(request, {segments: semanticRows(request)}, {likelyTarget: () => true, similarity: () => 0});
		assert.equal(outcome.ok, true);
		for (const literal of literals) assert.equal(String(outcome.translation).split(literal).length - 1, 1, literal);
	}
	finally {await stopFixture(fixture);}
});

test("P1 preserves balanced-parenthesis URLs and one-letter slash commands byte-for-byte", async () => {
	const fixture = createFixture();
	try {
		const literals = [
			"https://en.wikipedia.org/wiki/Function_(mathematics)",
			"https://example.com/a?x=(y)",
			"example.com?x=(y)",
			"www.example.com:8/a#part",
			"192.168.1.1:8",
			"/x"
		];
		const source = `See ${literals.slice(0, -1).join(" and ")}, then run ${literals.at(-1)} now.`;
		const request = fixture.plugin.createAtomicSemanticRevisionContract(source, {place: "received", channelId: CHANNEL_ID, engineKey: "oaicompat", inputLanguageId: "en", targetLanguageId: "zh-CN", fieldPath: "body"});
		for (const literal of literals) assert.equal(request.wire.includes(literal), false, `hard protection leaked: ${literal}`);
		const outcome = fixture.plugin.validateAtomicSemanticResponse(request, {segments: semanticRows(request)}, {likelyTarget: () => true, similarity: () => 0});
		assert.equal(outcome.ok, true);
		for (const literal of literals) assert.equal(String(outcome.translation).split(literal).length - 1, 1, literal);
	}
	finally {await stopFixture(fixture);}
});

test("P1 configured terms cannot dismantle placeholders emitted by earlier hard protection", async () => {
	const fixture = createFixture();
	try {
		fixture.plugin.settings.exceptions.protectedTerms = ["0", "⟦", "Longma"];
		const literals = ["name@example.com", "Longma"];
		const request = fixture.plugin.createAtomicSemanticRevisionContract(`Email ${literals[0]} about ${literals[1]}.`, {place: "received", channelId: CHANNEL_ID, engineKey: "oaicompat", inputLanguageId: "en", targetLanguageId: "zh-CN", fieldPath: "body"});
		assert.equal(request.wire.includes("name@example.com"), false);
		const outcome = fixture.plugin.validateAtomicSemanticResponse(request, {segments: semanticRows(request)}, {likelyTarget: () => true, similarity: () => 0});
		assert.equal(outcome.ok, true);
		for (const literal of literals) assert.equal(String(outcome.translation).split(literal).length - 1, 1, literal);
	}
	finally {await stopFixture(fixture);}
});

test("P1 shields fenced code before configured terms can dismantle Markdown structure", async () => {
	const fixture = createFixture();
	try {
		fixture.plugin.settings.exceptions.protectedTerms = ["```", "Longma"];
		const source = "```js\nconst contact = 'john.doe@example.com Longma';\n```\nGED and Longma need review.";
		const request = fixture.plugin.createAtomicSemanticRevisionContract(source, {place: "received", channelId: CHANNEL_ID, engineKey: "oaicompat", inputLanguageId: "en", targetLanguageId: "zh-CN", fieldPath: "body"});
		assert.equal(request.wire.includes("const contact"), false);
		assert.equal(request.wire.includes("john.doe@example.com"), false);
		assert.equal(request.wire.includes("Longma"), false);
		assert.match(request.wire, /GED/);
		const outcome = fixture.plugin.validateAtomicSemanticResponse(request, {segments: semanticRows(request)}, {likelyTarget: () => true, similarity: () => 0});
		assert.equal(outcome.ok, true);
		assert.equal(outcome.translation.includes("```js\nconst contact = 'john.doe@example.com Longma';\n```"), true);
		assert.equal(outcome.translation.includes("Longma"), true);
	}
	finally {await stopFixture(fixture);}
});

test("P1 semantic repair inherits the local protection map and restores once", async () => {
	const fixture = createFixture();
	try {
		const request = fixture.plugin.createAtomicSemanticRevisionContract("Alpha Longma Beta Gamma.", {place: "received", channelId: CHANNEL_ID, engineKey: "oaicompat", inputLanguageId: "en", targetLanguageId: "zh-CN", fieldPath: "body", attempt: 1, maxAttempts: 3});
		const missing = fixture.plugin.validateAtomicSemanticResponse(request, {segments: []}, {likelyTarget: () => true, similarity: () => 0});
		const repair = fixture.plugin.planAtomicSemanticRepair(request, missing, {parentSettled: true});
		assert.equal(repair.dispatchable, true);
		assert.equal(repair.requests.length, 1);
		const next = repair.requests[0];
		assert.deepEqual(fixture.plugin.getAtomicSemanticLocalState(next), fixture.plugin.getAtomicSemanticLocalState(request));
		const outcome = fixture.plugin.validateAtomicSemanticResponse(next, {segments: semanticRows(next)}, {priorValid: missing.valid, likelyTarget: () => true, similarity: () => 0});
		assert.equal(outcome.ok, true);
		assert.equal(String(outcome.translation).split("Longma").length - 1, 1);
	}
	finally {await stopFixture(fixture);}
});

test("P1 google classic-marked history contract shares semantic protection and replay", async () => {
	const fixture = createFixture();
	try {
		const request = fixture.plugin.createProtectedSemanticRequest(SOURCE, {place: "received", engineKey: "googleapi", inputLanguageId: "en", targetLanguageId: "zh-CN", fieldPath: "body", forceClassic: "marked"});
		assert.equal(request.adapter, "classic-marked");
		assertProtectedValuesAbsentFromWire(request.wire);
		const body = request.segmentOrder.map((_id, index) => `⟦${index}⟧\n译文${index}\n`).join("") + `⟦${request.segmentOrder.length}⟧`;
		const outcome = fixture.plugin.validateAtomicSemanticResponse(request, body, {likelyTarget: () => true, similarity: () => 0});
		assert.equal(outcome.ok, true);
		assertExactProtectionReplay(outcome.translation);
	}
	finally {await stopFixture(fixture);}
});

test("P1 fully protected received content dispatches no provider request", async () => {
	const fixture = createFixture();
	try {
		const outcome = await runTranslateText(fixture.plugin, "Longma");
		assert.equal(fixture.requests.length, 0);
		assert.equal(outcome.translation == null || outcome.translation === "", true);
	}
	finally {await stopFixture(fixture);}
});
