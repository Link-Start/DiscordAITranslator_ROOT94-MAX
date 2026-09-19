const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {createPluginInstance} = require("../helpers/createPluginInstance");

// P3-b: the live-burst lane validates a batch answer per message. When the typed batch parses,
// each message goes through the P3 segment validator already. When the typed batch container is
// unusable (root-malformed) the provider client re-sends the batch on the legacy wire, and the
// legacy answer is judged whole-message by classifyHistoricalBatchValidation; before P3-b that
// judge failed every echoed name-like message and the queue re-sent each one alone
// (requeue_single). These tests drive the real queue, provider client and validators over a fake
// transport; only translateMessage (the single re-send) is counted instead of executed.

const BUNDLE = process.env.DTA_PLUGIN_PATH ? path.resolve(process.env.DTA_PLUGIN_PATH) : path.resolve(__dirname, "../../DiscordAITranslator.plugin.js");
const ENGINE = "custom-p3b";
const CHANNEL_ID = "p3b-live-burst";
const MESSAGES = Object.freeze([
	{id: "p3b-name-1", content: "Atomic Gains", nameLike: true},
	{id: "p3b-prose", content: "please review the updated schedule before the meeting tomorrow morning", nameLike: false},
	{id: "p3b-name-2", content: "ECHOES OF TOMORROW | Higgsfield Community", nameLike: true}
]);
const byId = Object.fromEntries(MESSAGES.map(row => [row.id, row]));
// Typed batch wires carry m1..mN labels instead of message ids, so typed fakes recognise a
// message by the text of its segments.
const isNameLikeTypedRow = row => MESSAGES.some(message => message.nameLike && (row.plan && row.plan.segments || []).some(segment => String(segment.text).trim() && message.content.includes(String(segment.text).trim())));
const tokensOf = text => (String(text).match(/⟦(?:DTA)?\d+⟧|⟦C\d+⟧/g) || []).join("");
const translatedSegment = (segment, index) => `译${index}${tokensOf(segment.text)}`;
const translatedMessage = id => `已翻译：${id}`;
const response = content => JSON.stringify({choices: [{message: {content}, finish_reason: "stop"}], usage: {prompt_tokens: 11, completion_tokens: 7}});
const LEGACY_MARKER = "Messages JSON:\n";

// The provider script decides one reply per wire family. `semantic(payload)` answers the typed
// batch, `legacy(items)` answers the legacy batch the client falls back to.
function createHarness(script) {
	const requests = [], cacheWrites = [], commits = [], singles = [], skips = [];
	const request = (url, options, callback) => {
		const body = String(options && options.body || "");
		const outer = JSON.parse(body), userText = String(outer.messages[outer.messages.length - 1].content || "");
		let payload = null;
		try {payload = JSON.parse(userText);} catch {}
		let family, content;
		if (payload && payload.schemaVersion === "semantic-batch-v1") {family = "typed-batch"; content = script.semantic(payload);}
		else if (payload && Array.isArray(payload.segments)) {family = "typed-single"; content = script.single ? script.single(payload) : JSON.stringify({segments: payload.segments.map(translatedSegment)});}
		else {
			const start = userText.indexOf(LEGACY_MARKER);
			assert.ok(start >= 0, "unknown wire family in the fake transport");
			family = "legacy-batch"; content = script.legacy(JSON.parse(userText.slice(start + LEGACY_MARKER.length)));
		}
		requests.push({family, bytes: Buffer.byteLength(body)});
		queueMicrotask(() => callback(null, {statusCode: 200, headers: {}}, response(content)));
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
	// onStart marks the runtime active and reloads the settings store, so auth is installed after it.
	try {plugin.onStart();} catch {}
	plugin.ensureSettingsStore().replaceAuthKeys({[ENGINE]: {key: "fixture-key", endpoint: "https://p3b.fixture/v1/chat/completions", model: "fixture-model", interfaceFormat: "openai_chat", reasoningMode: "off", reasoningProfile: "openai"}});
	plugin.getLanguageChoice = (type, place) => plugin.settings.choices[place] && plugin.settings.choices[place][type];
	plugin.getEffectivePrimaryEngine = () => ENGINE; plugin.getEffectiveBackupEngine = () => "----";
	plugin.getHistoricalAiBatchEngineKey = () => ENGINE; plugin.getHistoricalPrimaryEngineKey = () => ENGINE;
	plugin.isEngineConfiguredForRuntime = () => true; plugin.validTranslator = () => true;
	plugin.isTranslationEnabled = () => true; plugin.isMessageWithinLoadedRange = () => true; plugin.isOwnMessage = () => false; plugin.shouldAutoTranslateReceivedMessage = () => true;
	plugin.getCachedReceivedTranslation = () => null; plugin.getCachedReceivedSkipDecision = () => null;
	// Production-shaped judges: Chinese means target language; an identical echo is fully
	// similar. The whole-message echo guards (isTranslationResultTooSimilar and the keep policy)
	// stay real so the kept copy is proven to survive them.
	plugin.isTranslationLikelyInTargetLanguage = value => /[\p{Script=Han}]/u.test(String(value || ""));
	plugin.getTextSimilarityScore = (a, b) => String(a).trim() === String(b).trim() ? 1 : 0;
	plugin.persistReceivedSkipDecision = (id, signature, reason) => skips.push({id, reason});
	plugin.persistTranslationCacheEntry = (id, _signature, translation) => {cacheWrites.push({id: String(id), translation});};
	plugin.applyStoredTranslationToMessage = () => {}; plugin.scheduleReceivedDisplayFlush = () => {};
	plugin.scheduleHistoricalTranslationJobStart = () => {}; plugin.waitForHistoricalTranslationCommit = () => Promise.resolve();
	plugin.getReceivedDisplayCommitGeneration = () => 1;
	plugin.markReceivedDisplayPending = () => null; plugin.releaseReceivedDisplayPending = () => null;
	plugin.ensureMessageViewportStore = () => ({preserveHistoryOnLiveMessage: () => {}});
	plugin.ensureReceivedDisplayRuntime = () => ({pruneChannel: () => {}, peekSourceArchive: () => null, clearPreview: () => {}});
	plugin.getReceivedAutoTranslateScope = () => "loaded_messages";
	plugin.extractOriginalContentData = message => ({content: message.content, embeds: []});
	plugin.createReceivedDisplayCommitResult = (message, channelId, result) => Object.assign({messageId: String(message.id), channelId}, result);
	plugin.commitReceivedDisplayResult = result => {commits.push(result); return Promise.resolve({committedIds: [String(result.messageId)], confirmedIds: [String(result.messageId)], deferredIds: []});};
	// The burst's only retry: the single re-send. Counted, never executed.
	plugin.translateMessage = message => {singles.push(String(message && message.id)); return Promise.resolve(null);};
	return {plugin, requests, cacheWrites, commits, singles, skips};
}

async function waitFor(predicate, timeoutMs = 3000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {if (predicate()) return true; await new Promise(resolve => setTimeout(resolve, 5));}
	return predicate();
}

async function runBurst(harness, rows = MESSAGES) {
	const queue = harness.plugin.ensureLiveTranslationQueue();
	queue.setBusyTranslating(true);
	for (const row of rows) {
		const message = {id: row.id, channel_id: CHANNEL_ID, content: row.content, embeds: [], attachments: [], author: {id: "other-user"}};
		assert.equal(harness.plugin.queueAutoTranslateMessage(message, {id: CHANNEL_ID}, {content: row.content, embeds: []}), true);
	}
	queue.setBusyTranslating(false);
	queue.processQueue();
	const routes = () => harness.plugin.getTranslationTerminalLedgerSnapshot().recent.filter(route => route.lane === "live-burst");
	assert.equal(await waitFor(() => routes().length === rows.length && !queue.isLiveAutoTranslating()), true, "every burst item must reach a terminal route");
	assert.equal(queue.getQueueLength(), 0);
	return Object.fromEntries(routes().map(route => [route.routeId, route]));
}

async function stop(harness) {try {await Promise.resolve(harness.plugin.onStop());} catch {}}

// The provider answers the typed batch with prose around a JSON object that has no rows: a
// container nothing can read (root-malformed), so the client falls back to the legacy batch
// wire. Legacy-shaped rows ({id, translation}) used to be this trigger; since the tolerant
// batch reader they are read on the typed path (see the test below).
const unusableTypedBatch = () => "Here you go: " + JSON.stringify({status: "done", count: 3});
const legacyShapedTypedBatch = payload => JSON.stringify(payload.messages.map(row => ({id: row.id, translation: isNameLikeTypedRow(row) ? row.plan.segments.map(segment => segment.text).join("") : translatedMessage(row.id)})));
const legacyEcho = items => JSON.stringify(items.map(item => ({id: item.id, translation: byId[item.id] && byId[item.id].nameLike ? item.text : translatedMessage(item.id)})));

test("P3-b red (22:40:01 form): root-malformed typed batch, legacy fallback echoes the name-like messages; the batch commits with kept messages, 0 re-sends", async () => {
	const harness = createHarness({semantic: unusableTypedBatch, legacy: legacyEcho});
	try {
		const routes = await runBurst(harness);
		assert.deepEqual(harness.requests.map(row => row.family), ["typed-batch", "legacy-batch"], "one typed batch, one legacy fallback batch, nothing else");
		assert.deepEqual(harness.singles, [], "no requeue_single: the echoed names are kept inside the batch");
		assert.equal(harness.commits.length, 3);
		for (const route of Object.values(routes)) {
			assert.equal(route.outcome, "translated", JSON.stringify(route));
			assert.deepEqual(route.providerRoles, {primary: 1, fallback: 1}, "the fallback request is the parser's answer to the malformed container and is unchanged");
			assert.equal(route.validatorFamily, "history-batch");
		}
		const kept = Object.values(routes).filter(route => route.reason === "committed-with-kept"), plain = Object.values(routes).filter(route => route.reason === "committed");
		assert.equal(kept.length, 2);
		assert.equal(plain.length, 1);
		for (const route of kept) {assert.equal(route.keptSegmentCount, 1); assert.deepEqual(route.keptReasons, {"wrong-language": 1});}
		assert.equal(plain[0].keptSegmentCount, 0);
		for (const row of MESSAGES) {
			const commit = harness.commits.find(item => item.messageId === row.id);
			assert.equal(commit.status, "translated");
			assert.equal(commit.translation.translatedContent, row.nameLike ? row.content : translatedMessage(row.id), row.id);
			if (row.nameLike) {
				assert.equal(commit.translation.keptSegmentCount, 1);
				// The display and cache echo guards must not undo the keep; without the marker the
				// same bytes would be dropped as an echo.
				assert.equal(harness.plugin.isTranslationResultTooSimilar(commit.translation), false);
				assert.equal(harness.plugin.isTranslationResultTooSimilar(Object.assign({}, commit.translation, {keptSegmentCount: 0})), true);
			}
		}
		assert.equal(harness.cacheWrites.length, 0, "compatibility-fallback results are never cached (unchanged)");
		const snapshot = harness.plugin.getTranslationTerminalLedgerSnapshot();
		assert.equal(snapshot.reasons["committed-with-kept"], 2);
		assert.equal(snapshot.reasons.requeue_single || 0, 0);
		assert.doesNotMatch(JSON.stringify(snapshot), /Atomic|Higgsfield|ECHOES|schedule/, "the ledger never carries message text");
	}
	finally {await stop(harness);}
});

test("legacy-shaped rows in a typed batch answer are read on the typed path: 0 fallback; a one-segment echo is kept, a two-segment message takes the existing single re-send", async () => {
	// "Atomic Gains" and the prose message are one segment each, so their translation strings
	// map onto that segment. "ECHOES OF TOMORROW | Higgsfield Community" is two segments; a lone
	// string cannot be placed, so the row is left for the burst's one existing retry instead of
	// dragging the whole batch onto the legacy wire.
	const harness = createHarness({semantic: legacyShapedTypedBatch, legacy: () => {throw new Error("the legacy wire must not be used");}});
	try {
		const routes = await runBurst(harness);
		assert.deepEqual(harness.requests.map(row => row.family), ["typed-batch"], "the old root-malformed trigger no longer costs a legacy request");
		assert.deepEqual(harness.singles, ["p3b-name-2"]);
		const byReason = Object.fromEntries(Object.values(routes).map(route => [route.reason, route]));
		assert.deepEqual(Object.keys(byReason).sort(), ["ai_skip_signal", "committed", "requeue_single"]);
		for (const reason of ["committed"]) {assert.equal(byReason[reason].outcome, "translated"); assert.deepEqual(byReason[reason].providerRoles, {primary: 1}); assert.equal(byReason[reason].validatorFamily, "segment-validator-v3");}
		assert.equal(byReason.ai_skip_signal.outcome, "skipped");
		assert.equal(harness.skips.length, 1);
		assert.deepEqual([byReason.requeue_single.outcome, byReason.requeue_single.stage], ["failed", "repair"]);
		assert.equal(harness.cacheWrites.length, 1);
		const wire = harness.plugin.ensureProviderClient().getWireObservationSnapshot();
		assert.equal(wire.batchShapeCounts["translation-string"], 1, "the recovered shape is counted once per answer");
		assert.equal(wire.batchShapeCounts["bare-array"], 1);
		assert.equal(wire.fallbackReasonCounts["root-malformed"], undefined);
	}
	finally {await stop(harness);}
});

test("a typed burst settles unchanged compatible names as skipped, without fallback or re-sends", async () => {
	const harness = createHarness({semantic: payload => JSON.stringify({messages: payload.messages.map(row => ({id: row.id, segments: row.plan.segments.map((segment, index) => ({id: segment.id, translation: isNameLikeTypedRow(row) ? segment.text : translatedSegment(segment, index)}))}))}), legacy: () => {throw new Error("no legacy fallback expected");}});
	try {
		const routes = await runBurst(harness);
		assert.deepEqual(harness.requests.map(row => row.family), ["typed-batch"]);
		assert.deepEqual(harness.singles, []);
		const reasons = Object.values(routes).map(route => route.reason).sort();
		assert.deepEqual(reasons, ["ai_skip_signal", "ai_skip_signal", "committed"]);
		for (const route of Object.values(routes)) {assert.equal(route.outcome, route.reason === "ai_skip_signal" ? "skipped" : "translated"); assert.deepEqual(route.providerRoles, {primary: 1}); assert.equal(route.validatorFamily, "segment-validator-v3");}
		assert.equal(harness.cacheWrites.length, 1);
		assert.equal(harness.skips.length, 2);
	}
	finally {await stop(harness);}
});

test("P3-b hard failure in the legacy fallback: a message missing from the answer is still re-sent alone, the rest commit", async () => {
	const harness = createHarness({semantic: unusableTypedBatch, legacy: items => legacyEcho(items.filter(item => item.id !== "p3b-prose"))});
	try {
		const routes = await runBurst(harness);
		assert.deepEqual(harness.requests.map(row => row.family), ["typed-batch", "legacy-batch"]);
		assert.deepEqual(harness.singles, ["p3b-prose"], "the hard failure takes the existing requeue_single path");
		const failed = Object.values(routes).filter(route => route.outcome === "failed");
		assert.equal(failed.length, 1);
		assert.deepEqual([failed[0].stage, failed[0].reason, failed[0].keptSegmentCount], ["repair", "requeue_single", 0]);
		assert.equal(Object.values(routes).filter(route => route.reason === "committed-with-kept").length, 2);
		assert.equal(harness.commits.length, 2);
	}
	finally {await stop(harness);}
});

test("P3-b: a prose message echoed by the legacy fallback is not name-like and takes the burst's one existing retry (requeue_single), no new request type", async () => {
	const harness = createHarness({semantic: unusableTypedBatch, legacy: items => JSON.stringify(items.map(item => ({id: item.id, translation: item.text})))});
	try {
		const routes = await runBurst(harness);
		assert.deepEqual(harness.requests.map(row => row.family), ["typed-batch", "legacy-batch"]);
		assert.deepEqual(harness.singles, ["p3b-prose"]);
		const failed = Object.values(routes).filter(route => route.outcome === "failed");
		assert.equal(failed.length, 1);
		assert.deepEqual([failed[0].stage, failed[0].reason], ["repair", "requeue_single"]);
		assert.equal(Object.values(routes).filter(route => route.reason === "committed-with-kept").length, 2, "the two name-like echoes are kept in the same batch");
	}
	finally {await stop(harness);}
});

 test("explicit compound names settle in the live burst without requeueing singles", async () => {
	const harness = createHarness({semantic: payload => JSON.stringify({messages: payload.messages.map(row => ({id: row.id, segments: row.plan.segments.map(segment => ({id: segment.id, translation: "__KEEP_NAME__"}))}))}), legacy: () => {throw new Error("no fallback expected");}});
	try {
		const routes = await runBurst(harness, [{id: "name-version", content: "明天nova 4.1来不来"}, {id: "name-percent", content: "免费的orion 100%路由了"}, {id: "name-alone", content: "atlas cloud？"}]);
		assert.deepEqual(harness.requests.map(row => row.family), ["typed-batch"]);
		assert.deepEqual(harness.singles, []);
		assert.equal(harness.cacheWrites.length, 0);
		assert.equal(harness.skips.length, 3);
		assert.equal(harness.commits.length, 3);
		assert.ok(harness.commits.every(item => item.status === "skipped"));
		assert.ok(Object.values(routes).every(route => route.outcome === "skipped"));
	} finally {await stop(harness);}
});
