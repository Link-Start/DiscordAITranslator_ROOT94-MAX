"use strict";

// W3 zero-equivalence: drives one built bundle through every typed-json production lane
// (manual, auto, embed, reply, history batch, the 13 W2 fixtures) against a fixture provider
// and records only byte counts and SHA-256 digests of the physical request bodies. Running it
// on two bundles, or on one bundle with the compact-wire shadow off and on, must give the same
// rows: the shadow may compile the D candidate but never changes a byte that leaves the plugin.

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const {createPluginInstance} = require("../tests/helpers/createPluginInstance");
const {original14Markdown} = require("../tests/fixtures/s8b-m0a-mixed-language-fixtures");
const {W2_ALL_FIXTURES} = require("../src/diagnostics/w2-wire-benchmark-fixtures");
const {fixtureById: p3FixtureById} = require("../tests/fixtures/p3-soft-validation-fixtures");

const ENGINE = "custom-w3shadow";
const CHANNEL_ID = "w3-zero-equivalence";
const sha256 = value => crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex").toUpperCase();
const tokensOf = text => (String(text).match(/⟦(?:DTA)?\d+⟧|⟦C\d+⟧|⟦\/?F\d+⟧/g) || []).join("").replace(/⟦F\d+⟧/g, "$&格式文字");
const translatedRows = plan => (plan.segments || []).map((segment, index) => ({id: segment.id, translation: `译${index}${tokensOf(segment.text)}`}));
const message = (id, content, extra = {}) => Object.assign({id: String(id), channel_id: CHANNEL_ID, content, embeds: [], attachments: [], author: {id: "fixture-user"}}, extra);
const response = content => JSON.stringify({choices: [{message: {content}, finish_reason: "stop"}], usage: {prompt_tokens: 11, completion_tokens: 7}});

function replyFor(body) {
	const parsed = JSON.parse(body), userText = String(parsed.messages && parsed.messages[parsed.messages.length - 1] && parsed.messages[parsed.messages.length - 1].content || "");
	let payload = null;
	try {payload = JSON.parse(userText);}
	catch {return "译文";}
	if (payload && payload.schemaVersion === "semantic-batch-v1") return JSON.stringify({messages: payload.messages.map(item => ({id: item.id, segments: translatedRows(item.plan)}))});
	if (payload && Array.isArray(payload.segments)) return JSON.stringify({segments: translatedRows(payload)});
	return "译文";
}

function scenarios() {
	const rows = [
		["manual-original14", "manual", original14Markdown, {}],
		["auto-original14", "auto", original14Markdown, {}],
		["embed", "manual", "Financial Aid body", {embeds: [{id: "embed-1", title: "Application Title", description: "Application Description", fields: [{name: "Requirement", value: "Dependent status"}], footer: {text: "Deadline"}}], originalContentData: {content: "Financial Aid body", embeds: [{title: "Application Title", description: "Application Description", fields: [{name: "Requirement", value: "Dependent status"}], footerText: "Deadline"}]}}],
		["reply", "manual", "Quoted line stays here\nThanks, the second paragraph answers the quoted line.", {referenced_message: {id: "ref-1", content: "Quoted line stays here", author: {id: "someone-else"}}}]
	];
	for (const fixture of W2_ALL_FIXTURES) rows.push([`w2-${fixture.id}`, "manual", fixture.source, {targetLanguageId: fixture.targetLanguageId}]);
	return rows;
}

// P3 evidence: the hard-failure path (a segment missing from every answer) must produce the same
// request sequence and the same failed outcome on the pre-P3 and P3 bundles.
function hardFailureReply(body) {
	const parsed = JSON.parse(body), userText = String(parsed.messages && parsed.messages[parsed.messages.length - 1] && parsed.messages[parsed.messages.length - 1].content || "");
	let payload = null;
	try {payload = JSON.parse(userText);}
	catch {return "译文";}
	if (payload && Array.isArray(payload.segments)) return JSON.stringify({segments: translatedRows(payload).slice(0, Math.max(0, payload.segments.length - 1))});
	return "译文";
}

// P3-b evidence: live-burst hard failures. Burst A answers the typed batch with a container the
// typed parser cannot use (legacy-shaped rows), so the client falls back to the legacy batch; the
// legacy answer omits one message (missing_id) and drops the placeholder of another
// (placeholder_missing). Burst B answers the typed batch but omits one segment of one message
// (missing-id). Every hard failure must take the same requeue_single path with the same request
// bytes on both bundles; no name-like echo is in play.
const P3B_BURSTS = Object.freeze([
	{scenario: "p3b-hard-legacy", rows: [
		{id: "p3b-a-1", content: "The committee will publish the revised financial aid requirements before the end of the month."},
		{id: "p3b-a-2", content: "Please review the updated schedule before the meeting tomorrow morning and reply."},
		{id: "p3b-a-3", content: "The recording is available at https://example.invalid/recording/42 for two weeks."}
	]},
	{scenario: "p3b-hard-typed", rows: [
		{id: "p3b-b-1", content: "Hello world.\nFinancial aid requirements changed again this week."},
		{id: "p3b-b-2", content: "The new episode explains how creatine loading works for beginners."}
	]}
]);
function burstHardReply(body, scenario) {
	const parsed = JSON.parse(body), userText = String(parsed.messages && parsed.messages[parsed.messages.length - 1] && parsed.messages[parsed.messages.length - 1].content || "");
	let payload = null;
	try {payload = JSON.parse(userText);}
	catch {}
	if (payload && payload.schemaVersion === "semantic-batch-v1") {
		if (scenario === "p3b-hard-legacy") return JSON.stringify(payload.messages.map(row => ({id: row.id, translation: "译文"})));
		return JSON.stringify({messages: payload.messages.map((row, index) => ({id: row.id, segments: translatedRows(row.plan).slice(0, index === 0 ? row.plan.segments.length - 1 : row.plan.segments.length)}))});
	}
	if (payload && Array.isArray(payload.segments)) return JSON.stringify({segments: translatedRows(payload)});
	const marker = "Messages JSON:\n", start = userText.indexOf(marker);
	if (start < 0) return "译文";
	const items = JSON.parse(userText.slice(start + marker.length));
	return JSON.stringify(items.filter(item => item.id !== "p3b-a-2").map(item => ({id: item.id, translation: item.id === "p3b-a-3" ? "译文（占位符丢失）" : `译文 ${item.id}`})));
}
async function runLiveBurstHard(plugin, setScenario) {
	const singles = [], commits = [];
	plugin.getReceivedDisplayCommitGeneration = () => 1; plugin.markReceivedDisplayPending = () => null; plugin.releaseReceivedDisplayPending = () => null;
	plugin.ensureMessageViewportStore = () => ({preserveHistoryOnLiveMessage: () => {}}); plugin.ensureReceivedDisplayRuntime = () => ({pruneChannel: () => {}, peekSourceArchive: () => null, clearPreview: () => {}});
	plugin.getReceivedAutoTranslateScope = () => "loaded_messages"; plugin.extractOriginalContentData = item => ({content: item.content, embeds: []});
	plugin.createReceivedDisplayCommitResult = (item, channelId, result) => Object.assign({messageId: String(item.id), channelId}, result);
	plugin.commitReceivedDisplayResult = result => {commits.push(`${result.messageId}|${result.status}|${sha256(JSON.stringify(result.translation ? {translatedContent: result.translation.translatedContent, content: result.translation.content} : null))}`); return Promise.resolve({committedIds: [String(result.messageId)], confirmedIds: [String(result.messageId)], deferredIds: []});};
	plugin.translateMessage = item => {singles.push(String(item && item.id)); return Promise.resolve(null);};
	const queue = plugin.ensureLiveTranslationQueue(), routes = [];
	for (const burst of P3B_BURSTS) {
		setScenario(burst.scenario);
		const before = plugin.getTranslationTerminalLedgerSnapshot().recent.length;
		queue.setBusyTranslating(true);
		for (const row of burst.rows) plugin.queueAutoTranslateMessage(message(row.id, row.content), {id: CHANNEL_ID}, {content: row.content, embeds: []});
		queue.setBusyTranslating(false);
		queue.processQueue();
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline && (queue.isLiveAutoTranslating() || plugin.getTranslationTerminalLedgerSnapshot().recent.length < before + burst.rows.length)) await new Promise(resolve => setTimeout(resolve, 5));
		for (const route of plugin.getTranslationTerminalLedgerSnapshot().recent.slice(before)) routes.push(`${burst.scenario}|${route.lane}|${route.outcome}|${route.stage}|${route.reason}|dispatch=${route.providerDispatchCount}|roles=${JSON.stringify(route.providerRoles || {})}|kept=${route.keptSegmentCount || 0}`);
	}
	return {singles, commits, routes};
}

async function capture(bundlePath, {shadow = "off", closeSettings = false, mode = "standard"} = {}) {
	const wire = [], results = [], sideEffects = {cacheWrites: 0, skipWrites: 0, displayApplies: 0}, commitDigests = [];
	let scenario = "none", snapshot = null, afterSettingsClosed = null, afterStop = null;
	// liveStreaming is off, so every lane dispatches through the BDFDB request transport.
	const request = (url, options, callback) => {
		const body = String(options && options.body || "");
		wire.push({scenario, url: String(url), bodyBytes: Buffer.byteLength(body), bodySha256: sha256(body)});
		queueMicrotask(() => callback(null, {statusCode: 200, headers: {}}, response(mode === "p3-hard" ? hardFailureReply(body) : mode === "p3b-hard" ? burstHardReply(body, scenario) : replyFor(body))));
		return {abort() {}};
	};
	const plugin = createPluginInstance({
		pluginPath: bundlePath,
		callSetLanguages: false,
		bdfdb: {LibraryRequires: {request}},
		settings: {engines: {translator: ENGINE, backup: "----", customProviders: [{id: ENGINE, name: "Fixture"}]}, performance: {historicalConcurrency: "4", historicalSafetyDownshift: false, liveConcurrency: "1", liveStreaming: false, compactWireShadow: shadow}, filters: {receivedAutoTranslateScope: "loaded_messages", skipMixedReceivedMessages: false, useLocalLanguagePrecheck: false, minimumAutoTranslateLength: 1, autoTranslateDecisionMode: "ai"}, choices: {received: {input: "en", output: "zh-CN"}, sent: {input: "en", output: "zh-CN"}}, exceptions: {wordStart: ["!"], protectedTerms: ["Longma"], wrapperPairs: ['"|"', "`|`"], protectedTermsForReceived: true, wrapperPairsForReceived: true}},
		defaults: {choices: {received: {value: {input: "en", output: "zh-CN"}}, sent: {value: {input: "en", output: "zh-CN"}}}}
	});
	try {plugin.onLoad();} catch {}
	plugin.settings.engines.translator = ENGINE; plugin.settings.engines.backup = "----"; plugin.settings.engines.customProviders = [{id: ENGINE, name: "Fixture"}];
	plugin.settings.performance.compactWireShadow = shadow;
	try {plugin.setLanguages();} catch {}
	// The live queue only runs after onStart, which reloads the settings store; auth follows it.
	if (mode === "p3b-hard") try {plugin.onStart();} catch {}
	plugin.ensureSettingsStore().replaceAuthKeys({[ENGINE]: {key: "fixture-key", endpoint: "https://w3.fixture/v1/chat/completions", model: "fixture-model", interfaceFormat: "openai_chat", reasoningMode: "off", reasoningProfile: "openai"}});
	plugin.getLanguageChoice = (type, place) => plugin.settings.choices[place] && plugin.settings.choices[place][type];
	plugin.getEffectivePrimaryEngine = () => ENGINE; plugin.getEffectiveBackupEngine = () => "----";
	plugin.getHistoricalAiBatchEngineKey = () => ENGINE; plugin.getHistoricalPrimaryEngineKey = () => ENGINE;
	plugin.isEngineConfiguredForRuntime = () => true; plugin.validTranslator = () => true;
	plugin.isTranslationEnabled = () => true; plugin.isMessageWithinLoadedRange = () => true; plugin.isOwnMessage = () => false; plugin.shouldAutoTranslateReceivedMessage = () => true;
	plugin.getCachedReceivedTranslation = () => null; plugin.getCachedReceivedSkipDecision = () => null;
	plugin.isTranslationLikelyInTargetLanguage = value => /译|[㐀-鿿]/.test(String(value || "")); plugin.getTextSimilarityScore = (a, b) => String(a) === String(b) ? 1 : 0;
	plugin.getAutoTranslatedResultRejectReason = () => null; plugin.isTranslationResultTooSimilar = () => false; plugin.shouldKeepAutoTranslatedResult = () => true;
	// Committed translations are recorded as digests only: same digest on two bundles means the
	// same bytes reached the cache and the display.
	plugin.persistReceivedSkipDecision = () => {sideEffects.skipWrites++;}; plugin.persistTranslationCacheEntry = (id, _signature, translation) => {sideEffects.cacheWrites++; commitDigests.push(`${scenario}|${sha256(JSON.stringify({translatedContent: translation && translation.translatedContent, content: translation && translation.content, embeds: translation && translation.embeds}))}`);}; plugin.applyStoredTranslationToMessage = () => {sideEffects.displayApplies++;}; plugin.scheduleReceivedDisplayFlush = () => {};
	plugin.commitReceivedDisplayResult = result => Promise.resolve({committedIds: [String(result.messageId)], confirmedIds: [String(result.messageId)], deferredIds: []});
	plugin.scheduleHistoricalTranslationJobStart = () => {}; plugin.waitForHistoricalTranslationCommit = () => Promise.resolve();
	try {
		if (mode === "p3b-hard") {
			const burst = await runLiveBurstHard(plugin, value => {scenario = value;});
			results.push(["p3b-hard-singles", burst.singles], ["p3b-hard-commits", burst.commits]);
			return {wire, results, sideEffects, commitDigests, routes: burst.routes, shadow: null, shadowSnapshot: null, afterSettingsClosed: null, afterStop: null, netUsed: !!(global.BdApi && global.BdApi.Net)};
		}
		if (mode === "p3-hard") {
			const fixture = p3FixtureById("f17-missing-segment-hard-failure");
			for (const entry of ["auto", "manual"]) {
				scenario = `p3-hard-${entry}`;
				results.push([scenario, await plugin.translateMessage(message(`${fixture.id}-${entry}`, fixture.content), {id: CHANNEL_ID}, Object.assign(entry === "auto" ? {auto: true} : {manual: true}, {silent: true, trackBusy: false}))]);
			}
			const routes = plugin.getTranslationTerminalLedgerSnapshot().recent.map(route => `${route.lane}|${route.outcome}|${route.stage}|${route.reason}|dispatch=${route.providerDispatchCount}`);
			return {wire, results, sideEffects, commitDigests, routes, shadow: null, shadowSnapshot: null, afterSettingsClosed: null, afterStop: null, netUsed: !!(global.BdApi && global.BdApi.Net)};
		}
		for (const [id, entryMode, content, extra] of scenarios()) {
			scenario = id;
			plugin.settings.choices.received.output = extra.targetLanguageId || "zh-CN";
			const options = Object.assign(entryMode === "auto" ? {auto: true} : {manual: true}, {silent: true, trackBusy: false});
			if (extra.originalContentData) options.originalContentData = extra.originalContentData;
			const item = message(id, content, extra.referenced_message ? {referenced_message: extra.referenced_message} : extra.embeds ? {embeds: extra.embeds} : {});
			results.push([id, await plugin.translateMessage(item, {id: CHANNEL_ID}, options)]);
		}
		plugin.settings.choices.received.output = "zh-CN";
		scenario = "history-batch";
		const prepared = Array.from({length: 3}, (_, index) => plugin.prepareHistoricalAiBatchQueueItem({message: message(`history-${index}`, `Financial Aid requirement ${index} for an international application with "quoted" terms.`), channel: {id: CHANNEL_ID}, originalContentData: {content: `Financial Aid requirement ${index} for an international application with "quoted" terms.`, embeds: []}}, CHANNEL_ID, {id: "en", name: "English"}, {id: "zh-CN", name: "Chinese"}));
		const client = plugin.ensureProviderClient(), token = client.beginLatencyRequest({kind: "historical", lane: "history-primary", messageCount: prepared.length});
		const outcome = await client.requestAiBatchTranslationDetailed(ENGINE, prepared, {token, role: "primary", engineKey: ENGINE, engineFamily: "custom", lane: "history-primary", messageCount: prepared.length, historicalBatch: true});
		results.push(["history-batch", !!(outcome && outcome.translations)]);
		// Read before onStop: stopping the plugin clears the shadow window by design.
		const read = () => {try {return plugin.ensureProviderClient().getLatencySnapshot().compactWireShadow || null;} catch {return null;}};
		snapshot = read();
		if (closeSettings) {try {plugin.onSettingsClosed();} catch {} afterSettingsClosed = read();}
	}
	finally {try {await Promise.resolve(plugin.onStop());} catch {} try {afterStop = plugin.ensureProviderClient().getLatencySnapshot().compactWireShadow || null;} catch {afterStop = null;}}
	const brief = value => value ? {schemaVersion: value.schemaVersion, count: value.count, batchCount: value.batches && value.batches.count} : null;
	return {wire, results, sideEffects, commitDigests, shadow: brief(snapshot), shadowSnapshot: snapshot, afterSettingsClosed: brief(afterSettingsClosed), afterStop: brief(afterStop), netUsed: !!(global.BdApi && global.BdApi.Net)};
}

function summarize(run) {
	return {requestCount: run.wire.length, rows: run.wire.map(row => `${row.scenario}|${row.bodyBytes}|${row.bodySha256}`), results: run.results, sideEffects: run.sideEffects, commitDigests: run.commitDigests || [], routes: run.routes || null};
}

async function verify(baselinePath, modifiedPath) {
	const baseline = await capture(baselinePath, {shadow: "off"});
	const modifiedOff = await capture(modifiedPath, {shadow: "off"});
	const modifiedOn = await capture(modifiedPath, {shadow: "shadow"});
	assert.deepEqual(summarize(modifiedOff), summarize(baseline), "flag off must reproduce the baseline request bytes");
	assert.deepEqual(summarize(modifiedOn), summarize(baseline), "flag on must reproduce the baseline request bytes");
	// P3: the hard-failure path (missing segment on every answer) must be byte-identical too.
	const hardBaseline = await capture(baselinePath, {shadow: "off", mode: "p3-hard"}), hardModified = await capture(modifiedPath, {shadow: "off", mode: "p3-hard"});
	assert.deepEqual(summarize(hardModified), summarize(hardBaseline), "the hard-failure repair sequence must reproduce the baseline request bytes and outcomes");
	// P3-b: live-burst hard failures (legacy fallback and typed) must requeue identically too.
	const burstBaseline = await capture(baselinePath, {shadow: "off", mode: "p3b-hard"}), burstModified = await capture(modifiedPath, {shadow: "off", mode: "p3b-hard"});
	assert.deepEqual(summarize(burstModified), summarize(burstBaseline), "the live-burst hard-failure sequence must reproduce the baseline request bytes, routes and commits");
	return {equivalent: true, hardFailure: {equivalent: true, requestCount: hardBaseline.wire.length, rows: hardBaseline.wire.map(row => `${row.scenario}|${row.bodyBytes}|${row.bodySha256}`), routes: hardBaseline.routes}, liveBurstHardFailure: {equivalent: true, requestCount: burstBaseline.wire.length, rows: burstBaseline.wire.map(row => `${row.scenario}|${row.bodyBytes}|${row.bodySha256}`), routes: burstBaseline.routes, results: burstBaseline.results}, commitDigests: baseline.commitDigests, requestCount: baseline.wire.length, scenarios: baseline.wire.map(row => ({scenario: row.scenario, bodyBytes: row.bodyBytes, bodySha256: row.bodySha256})), results: baseline.results, shadowOff: modifiedOff.shadow, shadowOn: modifiedOn.shadow};
}

if (require.main === module) {
	const [baselinePath, modifiedPath] = process.argv.slice(2);
	const run = modifiedPath ? verify(path.resolve(baselinePath), path.resolve(modifiedPath)) : capture(path.resolve(baselinePath), {shadow: process.env.W3_SHADOW || "off"}).then(result => Object.assign(summarize(result), {shadow: result.shadow}));
	run.then(result => {process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); process.exit(0);}, error => {console.error(error && error.stack || error); process.exit(1);});
}
module.exports = {capture, verify, summarize, scenarios};
