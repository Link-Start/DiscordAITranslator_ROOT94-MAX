const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {createPluginInstance} = require("../helpers/createPluginInstance");
const {original14Markdown} = require("../fixtures/s8b-m0a-mixed-language-fixtures");
const {
	createSemanticRequest,
	validateSemanticResponse
} = require("../../src/planner/translation-semantic-runtime");
const {parseTypedPlanResponse} = require("../../src/planner/translation-plan-serializer");

const CURRENT = path.resolve(__dirname, "../../DiscordAITranslator.plugin.js");
// Reuse the production-runtime fixture id already exercised by the corrected M3d
// suite; arbitrary new custom ids can be lost when the test UI shim aborts onLoad.
const ENGINE = "custom-m3dcorrected";

function createExactRequest() {
	return createSemanticRequest({
		engineKey: ENGINE,
		source: original14Markdown,
		direction: "received",
		fieldPath: "request",
		inputLanguageId: "auto",
		targetLanguageId: "zh-CN"
	});
}

function idealRows(plan) {
	return plan.segments.map((segment, index) => ({id: segment.id, translation: `译${index}`}));
}

test("RED M3d single typed contract carries the exact target language in data and instructions", () => {
	const request = createExactRequest();
	const payload = JSON.parse(request.wire);
	const missing = [];
	if (payload.targetLanguageId !== "zh-CN") missing.push("payload.targetLanguageId");
	if (!/targetLanguageId/i.test(request.systemPrompt)) missing.push("systemPrompt targetLanguageId instruction");
	assert.deepEqual(missing, [], `single semantic target-language contract is incomplete: ${missing.join(", ")}`);
});

test("RED M3d typed parser accepts common JSON-only model wrappers without guessing ids", () => {
	const plan = JSON.parse(createExactRequest().wire);
	const rows = idealRows(plan);
	const variants = {
		rawArray: JSON.stringify(rows),
		fencedObject: `\`\`\`json\n${JSON.stringify({segments: rows})}\n\`\`\``,
		proseAndFence: `Translation result:\n\`\`\`json\n${JSON.stringify({segments: rows})}\n\`\`\``
	};
	const rejected = [];
	for (const [name, value] of Object.entries(variants)) {
		const parsed = parseTypedPlanResponse(value);
		if (!Array.isArray(parsed)) {rejected.push(name); continue;}
		assert.deepEqual(parsed.map(row => row.id), rows.map(row => row.id), `${name} changed or guessed ids`);
	}
	assert.deepEqual(rejected, [], `common wrappers rejected: ${rejected.join(", ")}`);
});

test("RED exact mixed fixture accepts natural structural-label echoes", () => {
	const request = createExactRequest();
	const plan = JSON.parse(request.wire);
	const rows = plan.segments.map((segment, index) => ({
		id: segment.id,
		// Real translators preserve list labels such as " E. " and " 6. ". They
		// translate lexical English, but do not invent Han text for pure structure.
		translation: /[A-Za-z]{2,}/.test(segment.text) ? `译${index}` : segment.text
	}));
	const outcome = validateSemanticResponse(request, {segments: rows}, {
		likelyTarget: value => /[\u3400-\u9fff]/.test(String(value || "")),
		similarity: (source, value) => String(source) === String(value) ? 1 : 0,
		maxSimilarity: 0.94
	});
	assert.equal(outcome.ok, true, JSON.stringify({reason: outcome.reason, invalid: outcome.validation && outcome.validation.invalid}));
});

function openAiResponse(content) {
	return {
		status: 200,
		headers: {get: () => "application/json"},
		text: () => Promise.resolve(JSON.stringify({choices: [{message: {content}, finish_reason: "stop"}]}))
	};
}

function createManualFixture(fetch) {
	const applied = [];
	const request = (url, options, callback) => {
		let cancelled = false;
		Promise.resolve(fetch(url, options)).then(async result => {
			if (!cancelled) callback(null, {statusCode: result.status, headers: {}}, await result.text());
		}, error => {if (!cancelled) callback(error);});
		return {abort: () => {cancelled = true;}};
	};
	const plugin = createPluginInstance({
		pluginPath: CURRENT,
		callSetLanguages: false,
		bdfdb: {LibraryRequires: {request}},
		settings: {
			engines: {translator: ENGINE, backup: "----", customProviders: [{id: ENGINE, name: "Fixture"}]},
			filters: {receivedAutoTranslateScope: "loaded_messages", skipMixedReceivedMessages: false, useLocalLanguagePrecheck: false, minimumAutoTranslateLength: 1, autoTranslateDecisionMode: "ai"},
			choices: {received: {input: "en", output: "zh-CN"}, sent: {input: "en", output: "zh-CN"}},
			exceptions: {wrapperPairs: ['"|"', '“|”', '`|`'], protectedTerms: []}
		},
		defaults: {choices: {received: {value: {input: "en", output: "zh-CN"}}, sent: {value: {input: "en", output: "zh-CN"}}}}
	});
	global.BdApi.Net = {fetch};
	try {plugin.onLoad();} catch {}
	plugin.settings.engines.translator = ENGINE;
	plugin.settings.engines.backup = "----";
	plugin.settings.engines.customProviders = [{id: ENGINE, name: "Fixture"}];
	try {plugin.setLanguages();} catch {}
	plugin.ensureSettingsStore().replaceAuthKeys({
		[ENGINE]: {key: "fixture", endpoint: "https://fixture.invalid/v1/chat/completions", model: "fixture-model", interfaceFormat: "openai_chat", reasoningMode: "off", reasoningProfile: "openai"}
	});
	plugin.getLanguageChoice = (type, place) => plugin.settings.choices[place][type];
	plugin.getCachedReceivedTranslation = () => null;
	plugin.getCachedReceivedSkipDecision = () => null;
	plugin.isTranslationLikelyInTargetLanguage = value => /[\u3400-\u9fff]/.test(String(value || ""));
	plugin.getTextSimilarityScore = (source, value) => String(source) === String(value) ? 1 : 0;
	plugin.getAutoTranslatedResultRejectReason = () => null;
	plugin.isTranslationResultTooSimilar = () => false;
	plugin.persistReceivedSkipDecision = () => {};
	plugin.persistTranslationCacheEntry = () => {};
	plugin.applyStoredTranslationToMessage = (_message, translation) => applied.push(translation);
	plugin.scheduleReceivedDisplayFlush = () => {};
	return {plugin, applied};
}

test("RED whole non-JSON response uses one bounded legacy-compatible fallback instead of typed repair loops", async () => {
	const requestFamilies = [];
	const fetch = async (_url, options) => {
		const outer = JSON.parse(options.body);
		const userPrompt = String(outer.messages.at(-1).content);
		const semantic = /"schemaVersion":"segment-json-v\d+"/.test(userPrompt);
		requestFamilies.push(semantic ? "typed" : "legacy");
		if (semantic) return openAiResponse("整条旧格式译文");
		const placeholders = [...new Set(userPrompt.match(/⟦(?:DTA)?\d+⟧/g) || [])];
		return openAiResponse(`兼容译文 ${placeholders.join(" ")}`);
	};
	const fixture = createManualFixture(fetch);
	try {
		const result = await fixture.plugin.translateMessage({
			id: "m3d-red-fallback",
			channel_id: "m3d-red",
			content: original14Markdown,
			embeds: [],
			attachments: [],
			author: {id: "other-user"}
		}, {id: "m3d-red"}, {manual: true, silent: true, trackBusy: false});
		assert.equal(result, true, JSON.stringify({requestFamilies, applied: fixture.applied.length}));
		assert.deepEqual(requestFamilies, ["typed", "legacy"]);
		assert.equal(fixture.applied.length, 1);
	}
	finally {
		delete global.BdApi.Net;
		try {await fixture.plugin.onStop();} catch {}
	}
});
