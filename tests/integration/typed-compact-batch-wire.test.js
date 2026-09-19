const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {createPluginInstance} = require("../helpers/createPluginInstance");

// History batches on the built bundle: message ids travel as m1..mN, each embedded plan
// carries only labelled segments, and the parser maps labels back before validation.
// The answer reader is tolerant: mirrored request nesting, legacy-shaped rows and other
// envelopes are read on the typed path and counted by shape; an answer nothing can read
// still falls back to the legacy batch wire and is counted as malformed.
const BUNDLE = process.env.DTA_PLUGIN_PATH ? path.resolve(process.env.DTA_PLUGIN_PATH) : path.resolve(__dirname, "../../DiscordAITranslator.plugin.js");
const ENGINE = "custom-compactwire";
const CHANNEL = "compact-wire";
const LEGACY_MARKER = "Messages JSON:\n";
const response = content => ({status: 200, headers: {get: () => "application/json"}, text: () => Promise.resolve(JSON.stringify({choices: [{message: {content}, finish_reason: "stop"}]}))});

function createFixture(fetch) {
	const commits = [], views = new Map(), skips = [];
	const request = (url, options, callback) => {let cancelled = false; Promise.resolve(fetch(url, options)).then(async result => {if (cancelled) return; callback(null, {statusCode: result.status, headers: {}}, await result.text());}, error => {if (!cancelled) callback(error);}); return {abort: () => {cancelled = true;}};};
	const plugin = createPluginInstance({pluginPath: BUNDLE, callSetLanguages: false, bdfdb: {LibraryRequires: {request}}, settings: {engines: {translator: ENGINE, backup: "----", customProviders: [{id: ENGINE, name: "Fixture"}]}, performance: {historicalConcurrency: "4", historicalSafetyDownshift: false, liveConcurrency: "1", liveStreaming: true}, filters: {receivedAutoTranslateScope: "loaded_messages", skipMixedReceivedMessages: false, useLocalLanguagePrecheck: false, minimumAutoTranslateLength: 1, autoTranslateDecisionMode: "ai"}, choices: {received: {input: "en", output: "zh-CN"}, sent: {input: "en", output: "zh-CN"}}, exceptions: {wrapperPairs: [], protectedTerms: []}}, defaults: {choices: {received: {value: {input: "en", output: "zh-CN"}}, sent: {value: {input: "en", output: "zh-CN"}}}}});
	global.BdApi.Net = {fetch};
	try {plugin.onLoad();} catch {}
	plugin.settings.engines.translator = ENGINE; plugin.settings.engines.backup = "----"; plugin.settings.engines.customProviders = [{id: ENGINE, name: "Fixture"}];
	try {plugin.setLanguages();} catch {}
	plugin.ensureSettingsStore().replaceAuthKeys({[ENGINE]: {key: "fixture-key", endpoint: "https://compact.fixture/v1/chat/completions", model: "fixture-model", interfaceFormat: "openai_chat", reasoningMode: "off", reasoningProfile: "openai"}});
	plugin.getLanguageChoice = (type, place) => plugin.settings.choices[place] && plugin.settings.choices[place][type];
	plugin.isTranslationEnabled = () => true; plugin.isMessageWithinLoadedRange = () => true; plugin.isOwnMessage = () => false; plugin.shouldAutoTranslateReceivedMessage = () => true;
	plugin.getCachedReceivedTranslation = () => null; plugin.getCachedReceivedSkipDecision = () => null;
	plugin.isTranslationLikelyInTargetLanguage = value => /译|[㐀-鿿]/.test(String(value || "")); plugin.getTextSimilarityScore = (a, b) => String(a) === String(b) ? 1 : 0;
	plugin.getAutoTranslatedResultRejectReason = () => null; plugin.isTranslationResultTooSimilar = () => false; plugin.shouldKeepAutoTranslatedResult = () => true;
	plugin.persistReceivedSkipDecision = (id, signature, reason) => {skips.push({id: String(id), reason});}; plugin.persistTranslationCacheEntry = () => {};
	plugin.getReceivedDisplayRuntimeView = id => views.get(String(id)) || null;
	plugin.commitHistoricalReceivedDisplayBatch = results => {for (const result of results) views.set(String(result.messageId), Object.assign({}, result, {translated: result.status === "translated", showLoading: false})); commits.push(results); const ids = results.map(result => String(result.messageId)); return Promise.resolve({committedIds: ids, confirmedIds: ids, deferredIds: [], missingIds: [], retryIds: [], rejectedIds: [], staleIds: []});};
	plugin.setHistoricalBatchExperimentConcurrency(4);
	return {plugin, commits, views, skips};
}

const MESSAGES = Object.freeze([
	["901", "The deploy finished ten minutes ago."],
	["902", "Please review the schedule before tomorrow's meeting."],
	["903", "I might be a bit late, sorry."]
]);
const rows = plan => plan.segments.map((segment, index) => ({id: segment.id, translation: `译${index}`}));
const legacyRows = items => JSON.stringify(items.map(item => ({id: item.id, translation: `旧译 ${item.id}`})));

// answerFor(payload) answers a typed wire (batch or single); answerLegacy(items) answers the
// legacy batch wire the client falls back to when the typed answer cannot be read.
async function runBatch(answerFor, answerLegacy = null, {preferencesEnabled = true, messages = MESSAGES, beforeStart = () => {}} = {}) {
	const prompts = [], families = [], systemPrompts = [], requestBodies = [];
	const fixture = createFixture(async (_url, options) => {
		const requestBody = JSON.parse(options.body);
		requestBodies.push(requestBody);
		systemPrompts.push(requestBody.messages.find(message => message.role === "system").content);
		const userText = String(requestBody.messages.at(-1).content);
		let payload = null;
		try {payload = JSON.parse(userText);} catch {}
		if (payload) {families.push(Array.isArray(payload.messages) ? "typed-batch" : "typed-single"); prompts.push(payload); return response(answerFor(payload));}
		const start = userText.indexOf(LEGACY_MARKER);
		assert.ok(start >= 0 && answerLegacy, "unexpected wire family in the fake transport");
		families.push("legacy-batch");
		return response(answerLegacy(JSON.parse(userText.slice(start + LEGACY_MARKER.length))));
	});
	try {
		fixture.plugin.settings.filters.aiPromptPreferencesEnabled = preferencesEnabled;
		for (const [id, content, embeds = []] of messages) {
			const message = {id, channel_id: CHANNEL, content, embeds, attachments: [], author: {id: "other-user"}};
			fixture.plugin.queueAutoTranslateMessage(message, {id: CHANNEL}, fixture.plugin.extractOriginalContentData(message), {historicalLoad: true, deferHistoricalSnapshotStart: true});
		}
		beforeStart(fixture);
		await fixture.plugin.startCollectedHistoricalTranslationJobs(CHANNEL);
		const wire = fixture.plugin.ensureProviderClient().getWireObservationSnapshot();
		return {prompts, families, systemPrompts, requestBodies, commits: fixture.commits, views: fixture.views, skips: fixture.skips, failed: fixture.plugin.getFailedHistoricalTranslationCount(CHANNEL), wire, performance: fixture.plugin.getHistoricalBatchPerformanceSnapshot()};
	}
	finally {delete global.BdApi.Net; try {await fixture.plugin.onStop();} catch {}}
}

const allTranslated = commits => assert.deepEqual(commits.flat().map(result => [String(result.messageId), result.status]).sort(), [["901", "translated"], ["902", "translated"], ["903", "translated"]]);

test("complementary message rows commit in one request with protected code unchanged", async () => {
	const source = "Please check the error.\n```js\nconst label = 'unchanged';\n```\nPlease try the update.";
	const {families, commits, performance, wire} = await runBatch(payload => JSON.stringify({messages: payload.messages.flatMap(message => message.plan.segments.map(segment => ({id: message.id, segments: [{id: segment.id, translation: `译${(segment.text.match(/⟦[^⟧]+⟧/g) || []).join("")}`}]}))).reverse()}), null, {messages: [["901", source]]});
	assert.deepEqual(families, ["typed-batch"], JSON.stringify({wire, performance}));
	assert.equal(commits.flat()[0].status, "translated");
	assert.match(commits.flat()[0].translation.translatedContent, /```js\nconst label = 'unchanged';\n```/);
	assert.equal(performance.latestRun.repairBatchRequests + performance.latestRun.repairItemRequests, 0);
	assert.equal(wire.recentBatchAnswers[0].duplicateMessageRowCount, 1);
});

test("conflicting message rows repair the affected message without legacy fallback", async () => {
	let call = 0;
	const {families, prompts, commits} = await runBatch(payload => {
		if (payload.segments) return JSON.stringify({segments: rows(payload)});
		const messages = payload.messages.map(message => ({id: message.id, segments: rows(message.plan)}));
		if (++call === 1) messages.push({id: messages[0].id, segments: [{id: "s1", translation: "冲突内容"}]});
		return JSON.stringify({messages});
	});
	assert.deepEqual(families, ["typed-batch", "typed-single"]);
	assert.equal(prompts[1].segments.length, 1);
	allTranslated(commits);
});

test("typed OpenAI Chat batches request JSON objects while legacy fallback keeps its array contract", async () => {
	const {families, requestBodies, commits} = await runBatch(() => "Unreadable batch answer", legacyRows);
	assert.deepEqual(families, ["typed-batch", "legacy-batch"], "JSON mode does not add a capability probe or retry");
	assert.deepEqual(requestBodies[0].response_format, {type: "json_object"});
	assert.equal(Object.hasOwn(requestBodies[1], "response_format"), false, "the legacy answer is a JSON array, not an object");
	allTranslated(commits);
});

for (const broken of ["premature-close", "trailing-comma"]) test(`${broken} keeps complete message objects on one typed request without fallback or repair`, async () => {
	const {families, wire, commits, performance} = await runBatch(payload => {
		const messages = payload.messages.map(message => ({id: message.id, segments: rows(message.plan)}));
		return broken === "premature-close"
			? JSON.stringify({messages: messages.slice(0, 1)}) + "," + messages.slice(1).map(message => JSON.stringify(message)).join(",") + "]}"
			: `{"messages":[${messages.map(message => JSON.stringify(message)).join(",")},]}`;
	}, legacyRows);
	assert.deepEqual(families, ["typed-batch"]);
	allTranslated(commits);
	assert.equal(wire.batchShapeCounts["message-objects"], 1);
	assert.equal(wire.recentBatchAnswers[0].jsonSource, "fragment");
	assert.equal(wire.recentBatchAnswers[0].fallbackStarted, false);
	assert.equal(performance.latestRun.repairBatchRequests + performance.latestRun.repairItemRequests, 0);
});

test("typed batch output characters measure the actual translations without extra requests", async () => {
	const translations = {m1: "译🚀", m2: "两字", m3: "第三条"};
	const {performance, families, wire, commits} = await runBatch(payload => JSON.stringify({messages: payload.messages.slice().reverse().map(message => ({id: message.id, segments: [{id: "s1", translation: translations[message.id]}]}))}));
	assert.deepEqual(families, ["typed-batch"]);
	allTranslated(commits);
	assert.equal(performance.latestRun.h1.attempts[0].outputChars, 8, "outputChars counts UTF-16 characters in translations, not stringified objects");
	assert.equal(performance.latestRun.h1.outputChars, 8);
	assert.equal(wire.batchAnswerCount, 1);
});

test("a history batch that yields to live displays reports why no display commit was made", async () => {
	const {performance, families, commits} = await runBatch(payload => JSON.stringify({messages: payload.messages.map(message => ({id: message.id, segments: rows(message.plan)}))}), null, {
		beforeStart: ({views}) => {for (const [id] of MESSAGES) views.set(id, {showLoading: true, translated: false});}
	});
	assert.deepEqual(families, ["typed-batch"]);
	assert.equal(commits.length, 0, "live ownership must still prevent historical overwrites");
	const run = performance.latestRun;
	assert.equal(run.translatedCount, 3);
	assert.equal(run.atomicCommitCount, 0);
	assert.equal(run.h1.conservation.passed, false, "diagnostics cannot invent an atomic commit");
	assert.ok(run.commitPreparation.displayOwnedCount >= 3, "each filtered commit candidate has a reason; progress and final checks may inspect it again");
	assert.equal(run.commitPreparation.submittedCount, 0);
});

test("output measurement includes content and embed segments in a singleton batch", async () => {
	const {performance, families, prompts, commits} = await runBatch(payload => JSON.stringify({segments: payload.messages[0].plan.segments.map((segment, index) => ({id: segment.id, translatedText: index ? "卡片译" : "正文译🚀"}))}), null, {
		messages: [["901", "Please review this report.", [{id: "embed-1", title: "", description: "The second paragraph is inside the card."}]]]
	});
	assert.equal(prompts[0].messages[0].plan.segments.length, 2);
	assert.deepEqual(families, ["typed-batch"]);
	assert.equal(performance.latestRun.h1.attempts[0].outputChars, 8);
	assert.deepEqual(commits.flat().map(result => result.status), ["translated"]);
});

test("changed source content is counted without overwriting it or dispatching another request", async () => {
	const {performance, families, commits} = await runBatch(payload => JSON.stringify({messages: payload.messages.map(message => ({id: message.id, segments: rows(message.plan)}))}), null, {
		beforeStart: ({plugin}) => {
			const extract = plugin.extractOriginalContentData.bind(plugin);
			plugin.extractOriginalContentData = message => message.id === "902" ? {content: "Edited while translation was in flight.", embeds: []} : extract(message);
		}
	});
	assert.deepEqual(families, ["typed-batch"]);
	assert.deepEqual(commits.flat().map(result => String(result.messageId)).sort(), ["901", "903"]);
	assert.ok(performance.latestRun.commitPreparation.sourceChangedCount >= 1);
	assert.equal(performance.latestRun.commitPreparation.displayOwnedCount, 0);
	assert.equal(performance.latestRun.commitPreparation.submittedCount, 2);
});

test("history completion still waits for the existing display acknowledgement", async () => {
	const {performance, families} = await runBatch(payload => JSON.stringify({messages: payload.messages.map(message => ({id: message.id, segments: rows(message.plan)}))}), null, {
		beforeStart: ({plugin}) => {
			const commit = plugin.commitHistoricalReceivedDisplayBatch.bind(plugin);
			plugin.commitHistoricalReceivedDisplayBatch = async results => {
				assert.equal(plugin.getHistoricalBatchPerformanceSnapshot().latestRun, null);
				await new Promise(resolve => setImmediate(resolve));
				assert.equal(plugin.getHistoricalBatchPerformanceSnapshot().latestRun, null);
				return commit(results);
			};
		}
	});
	assert.deepEqual(families, ["typed-batch"]);
	assert.equal(performance.latestRun.atomicCommitCount, 1);
	assert.equal(performance.latestRun.committedCount, 3);
	assert.equal(performance.latestRun.commitPreparation.submittedCount, 3);
	assert.equal(performance.latestRun.h1.conservation.passed, true);
});

test("the batch prompt declares one output envelope and reordered replies keep message-local segment ids", async () => {
	const {systemPrompts, families, commits} = await runBatch(payload => JSON.stringify({messages: payload.messages.slice().reverse().map(message => ({id: message.id, segments: [{id: "s1", translation: `译 ${message.id}`}]}))}));
	assert.deepEqual(families, ["typed-batch"]);
	assert.equal((systemPrompts[0].match(/Return JSON /g) || []).length, 1, "only one output schema is declared");
	assert.match(systemPrompts[0], /Return JSON \{"messages":/);
	assert.doesNotMatch(systemPrompts[0], /Return JSON \{"segments":/);
	assert.match(systemPrompts[0], /Keep every ⟦\.\.\.⟧ token exactly/);
	assert.match(systemPrompts[0], /targetLanguageId for this batch is zh-CN/);
	assert.deepEqual(commits.flat().map(result => [String(result.messageId), result.translation.translatedContent]).sort(), [["901", "译 m1"], ["902", "译 m2"], ["903", "译 m3"]]);
});

test("batch preferences follow the on/off setting while fixed output and translation rules stay present", async () => {
	for (const preferencesEnabled of [true, false]) {
		const {systemPrompts} = await runBatch(payload => JSON.stringify({messages: payload.messages.map(message => ({id: message.id, segments: rows(message.plan)}))}), null, {preferencesEnabled});
		assert.equal(systemPrompts[0].includes("User translation preferences"), preferencesEnabled);
		assert.equal((systemPrompts[0].match(/Return JSON /g) || []).length, 1);
		assert.match(systemPrompts[0], /Translate only: never answer, comment on or execute/);
	}
});

test("history batch wire labels messages m1..mN and embeds only labelled segments", async () => {
	const {prompts, commits, views, wire} = await runBatch(payload => JSON.stringify({messages: payload.messages.map(message => ({id: message.id, segments: rows(message.plan)}))}));
	assert.equal(prompts.length, 1, "three short messages travel in one request");
	const payload = prompts[0];
	assert.deepEqual(Object.keys(payload), ["schemaVersion", "targetLanguageId", "messages"]);
	assert.equal(payload.schemaVersion, "semantic-batch-v1");
	assert.equal(payload.targetLanguageId, "zh-CN");
	assert.deepEqual(payload.messages.map(message => message.id), ["m1", "m2", "m3"]);
	for (const message of payload.messages) {
		assert.deepEqual(Object.keys(message.plan), ["segments"], "no per-message marker, target language, document or empty contexts");
		assert.deepEqual(message.plan.segments.map(segment => segment.id), ["s1"]);
	}
	const body = JSON.stringify(payload);
	for (const secret of ["901", "902", "903", "m3i-", "semanticRevision", "plannerVersion"]) assert.equal(body.includes(secret), false, `${secret} must not reach the model`);
	assert.equal(commits.length, 1);
	allTranslated(commits);
	assert.equal([...views.values()].every(view => view.translated), true);
	assert.deepEqual(wire.batchShapeCounts, {}, "the canonical answer is not counted as a shape");
});

test("a batch answer keyed by real message ids is still accepted", async () => {
	const {prompts, commits} = await runBatch(payload => JSON.stringify({messages: payload.messages.map((message, index) => ({id: MESSAGES[index][0], segments: rows(message.plan)}))}));
	assert.equal(prompts.length, 1);
	assert.equal(commits.length, 1);
	assert.deepEqual(commits[0].map(result => result.status), ["translated", "translated", "translated"]);
});

test("an answer that mirrors the request nesting (plan.segments) is read on the typed path and counted", async () => {
	const {families, commits, wire} = await runBatch(payload => JSON.stringify({messages: payload.messages.map(message => ({id: message.id, plan: {segments: rows(message.plan)}}))}));
	assert.deepEqual(families, ["typed-batch"], "no repair, no legacy fallback");
	allTranslated(commits);
	assert.deepEqual(wire.batchShapeCounts, {"plan-nested": 1});
	assert.deepEqual(wire.fallbackReasonCounts, {});
});

test("legacy-shaped rows ({id, translation}) in a bare array are read on the typed path and counted", async () => {
	const {families, commits, wire} = await runBatch(payload => JSON.stringify(payload.messages.map(message => ({id: message.id, translation: `译 ${message.id}`}))));
	assert.deepEqual(families, ["typed-batch"]);
	allTranslated(commits);
	assert.deepEqual(wire.batchShapeCounts, {"bare-array": 1, "translation-string": 1});
	const shown = commits.flat().map(result => result.translation && result.translation.translatedContent).sort();
	assert.deepEqual(shown, ["译 m1", "译 m2", "译 m3"]);
});

test("an answer nothing can read still falls back to the legacy batch wire, counted as malformed", async () => {
	const {families, commits, wire, performance} = await runBatch(() => "I translated everything for you!", legacyRows);
	assert.deepEqual(families, ["typed-batch", "legacy-batch"]);
	allTranslated(commits);
	assert.deepEqual(wire.batchShapeCounts, {"malformed-not-json": 1});
	assert.equal(wire.fallbackReasonCounts["root-malformed"], 1);
	assert.equal(wire.repairReasonCounts.malformed, 1);
	assert.deepEqual(performance.latestRun.h1.attempts.map(attempt => attempt.outputChars), [0, 18]);
});

test("malformed batch envelopes retain precise structure diagnostics through one compatibility fallback", async () => {
	for (const [answer, reason] of [
		[{messages: []}, "malformed-empty-list"],
		[{messages: [{translation: "甲"}]}, "malformed-missing-id-fields"],
		[{segments: [{id: "s1", translation: "甲"}]}, "malformed-segment-root"],
		[{messages: [{id: "m99", segments: [{id: "s1", translation: "甲"}]}]}, "malformed-unknown-ids"]
	]) {
		const {families, commits, wire} = await runBatch(() => JSON.stringify(answer), legacyRows);
		assert.deepEqual(families, ["typed-batch", "legacy-batch"]);
		allTranslated(commits);
		assert.deepEqual(wire.batchShapeCounts, {[reason]: 1});
		assert.equal(wire.batchAnswerCount, 1, "measurement parsing must not double-count the response");
		assert.equal(wire.recentBatchAnswers.length, 1);
		assert.equal(wire.recentBatchAnswers[0].malformed, reason);
		assert.equal(wire.recentBatchAnswers[0].expectedMessageCount, 3);
		assert.equal(wire.recentBatchAnswers[0].fallbackStarted, true);
		assert.equal(wire.recentBatchAnswers[0].promptVersion, "typed-batch-v4");
		if (reason === "malformed-segment-root") {
			assert.equal(wire.recentBatchAnswers[0].rootRowCount, 1);
			assert.equal(wire.recentBatchAnswers[0].rootMessageIdRowCount, 0);
			assert.equal(wire.recentBatchAnswers[0].rootSegmentIdRowCount, 1);
		}
	}
});

test("a batch answer that drops one message re-sends only that message as a single labelled request", async () => {
	const {prompts, systemPrompts, requestBodies, commits, wire} = await runBatch(payload => {
		if (Array.isArray(payload.messages)) return JSON.stringify({messages: payload.messages.filter(message => message.id !== "m2").map(message => ({id: message.id, segments: rows(message.plan)}))});
		return JSON.stringify({segments: rows(payload)});
	});
	assert.equal(prompts.length, 2, "one primary batch and one item repair");
	assert.deepEqual(requestBodies[0].response_format, {type: "json_object"});
	assert.equal(Object.hasOwn(requestBodies[1], "response_format"), false, "single-message repair keeps its current request contract");
	assert.equal(Array.isArray(prompts[1].messages), false, "the item repair is a single typed request");
	assert.deepEqual(prompts[1].segments.map(segment => segment.id), ["s1"], "whose labels start over");
	assert.equal(prompts[1].segments[0].text, MESSAGES[1][1], "and which carries exactly the dropped message");
	assert.equal(prompts[1].targetLanguageId, "zh-CN");
	assert.equal((systemPrompts[1].match(/Return JSON /g) || []).length, 1);
	assert.match(systemPrompts[1], /Return JSON \{"segments":/);
	assert.doesNotMatch(systemPrompts[1], /Return JSON \{"messages":/);
	assert.equal(wire.recentBatchAnswers[0].missingMessageCount, 1);
	assert.equal(wire.recentBatchAnswers[0].unreadableMessageCount, 0);
	assert.equal(wire.recentBatchAnswers[0].fallbackStarted, false);
	// The two answered messages display first; the repaired one follows in its own commit.
	allTranslated(commits);
	assert.equal(wire.repairReasonCounts["missing-id"] >= 1, true, "the S8 missing_id reason reaches the wire counters under its hyphenated name");
	assert.equal(wire.repairReasonCounts.unknown, undefined);
});

test("a batch containing one message still accepts its direct segment envelope", async () => {
	const {families, commits, wire} = await runBatch(payload => JSON.stringify({segments: rows(payload.messages[0].plan)}), null, {messages: MESSAGES.slice(0, 1)});
	assert.deepEqual(families, ["typed-batch"]);
	assert.deepEqual(commits.flat().map(result => [String(result.messageId), result.status]), [["901", "translated"]]);
	assert.equal(wire.batchAnswerCount, 1);
	assert.equal(wire.recentBatchAnswers[0].envelope, "segment-root");
	assert.equal(wire.recentBatchAnswers[0].malformed, null);
	assert.equal(wire.recentBatchAnswers[0].missingMessageCount, 0);
});

test("canonical one-message batch answers keep their actual messages envelope in diagnostics", async () => {
	const {wire, families} = await runBatch(payload => JSON.stringify({messages: payload.messages.map(message => ({id: message.id, segments: rows(message.plan)}))}), null, {messages: MESSAGES.slice(0, 1)});
	assert.deepEqual(families, ["typed-batch"]);
	assert.equal(wire.recentBatchAnswers[0].envelope, "messages");
	assert.equal(wire.recentBatchAnswers[0].parsedMessageCount, 1);
	assert.equal(wire.recentBatchAnswers[0].missingMessageCount, 0);
});

test("malformed direct segments in a one-message batch still reach item validation and repair", async () => {
	const {families, commits, wire} = await runBatch(payload => JSON.stringify({segments: Array.isArray(payload.messages) ? [{text: "译文缺少段落编号"}] : rows(payload)}), legacyRows, {messages: MESSAGES.slice(0, 1)});
	assert.deepEqual(families, ["typed-batch", "typed-single"], "diagnostic inspection must not turn a segment validation failure into a whole-batch compatibility fallback");
	assert.deepEqual(commits.flat().map(result => [String(result.messageId), result.status]), [["901", "translated"]]);
	assert.equal(wire.recentBatchAnswers[0].missingSegmentCount, 1);
	assert.equal(wire.recentBatchAnswers[0].fallbackStarted, false);
});

for (const repaired of [false, true]) test(`confirmed unchanged history clears previous failures and settles without display: repair=${repaired}`, async () => {
	let call = 0;
	const messages = [["901", "明天nova 4.1来不来"], ["902", "atlas cloud？"], ["903", "请先 Open The App 再继续"]];
	const answer = plan => plan.segments.map(segment => ({id: segment.id, translation: segment.text.includes("Open The App") ? "打开应用 " : repaired && call === 1 ? segment.text : "__KEEP_NAME__"}));
	const result = await runBatch(payload => {
		call++;
		return JSON.stringify(payload.messages ? {messages: payload.messages.map(message => ({id: message.id, segments: answer(message.plan)}))} : {segments: answer(payload)});
	}, null, {messages, beforeStart({plugin}) {
		plugin.ensureHistoricalJobRegistry().setFailedSnapshot(CHANNEL, {channelId: CHANNEL, items: messages.map(([id, content]) => ({message: {id, channel_id: CHANNEL, content}, reason: "wrong-language"}))});
	}});
	assert.deepEqual(result.commits.flat().map(item => [String(item.messageId), item.status]).sort(), [["901", "skipped"], ["902", "skipped"], ["903", "translated"]]);
	assert.equal(result.failed, 0, "successful skips clear the old retry ledger");
	assert.deepEqual(result.skips.map(item => item.id).sort(), ["901", "902"]);
	assert.ok(result.skips.every(item => item.reason === "ai_skip_signal"));
	assert.ok([...result.views.values()].every(view => view.showLoading === false));
	assert.equal(result.views.get("901").translated, false);
	assert.equal(result.views.get("902").translated, false);
	assert.equal(result.families.length, repaired ? 2 : 1);
	assert.ok(result.systemPrompts.every(prompt => prompt.includes("allowNameKeep")));
	assert.doesNotMatch(result.systemPrompts[0], /Repair pass:/);
	if (repaired) assert.match(result.systemPrompts[1], /Repair pass:/);
});
