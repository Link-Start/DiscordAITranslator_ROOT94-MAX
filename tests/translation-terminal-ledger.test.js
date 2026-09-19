const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {performance} = require("node:perf_hooks");
const {createPluginInstance} = require("./helpers/createPluginInstance");
const {receivedMessageFilterRuntime} = require("../src/received/received-translation-runtime");
const {textSimilarityRuntime} = require("../src/language/language-heuristics");
const {createTranslationTerminalLedger, summarizeProtectionRules} = require("../src/diagnostics/translation-terminal-ledger");
const {original14Markdown, targetBodyForeignTitle, targetBodyTranslatedTitle, allEnglishProtected, currentBehaviorGolden, desiredBehaviorGolden, fixtureSha256} = require("./fixtures/s8b-m0a-mixed-language-fixtures");

function fixturePlugin() {
	const plugin = createPluginInstance({callSetLanguages: false, settings: {filters: {receivedAutoTranslateScope: "loaded_messages", skipMixedReceivedMessages: false, useLocalLanguagePrecheck: false, minimumAutoTranslateLength: 1}, choices: {received: {input: "auto", output: "zh-CN"}, sent: {input: "auto", output: "en"}}}, defaults: {choices: {received: {value: {input: "auto", output: "zh-CN"}}, sent: {value: {input: "auto", output: "en"}}}}});
	try {plugin.onLoad();} catch {}
	plugin.getLanguageChoice = (type, place) => plugin.settings.choices[place] && plugin.settings.choices[place][type];
	plugin.getReceivedTranslationPlanEligibility = () => ({enabled: false});
	plugin.isTranslationEnabled = () => true; plugin.isMessageWithinLoadedRange = () => true; plugin.isOwnMessage = () => false;
	return plugin;
}

function currentResult(plugin, text, id) {
	const data = {content: text, embeds: []}, [masked, segments, hasTranslatableContent] = plugin.removeExceptions(text, "received");
	const hardSkip = plugin.shouldSkipReceivedTranslationBeforeRequest(data, "fixture-channel");
	const message = {id, channel_id: "fixture-channel", content: text, embeds: [], attachments: [], author: {id: "u"}};
	const autoEligible = plugin.shouldAutoTranslateReceivedMessage(message, {id: "fixture-channel"}, data, true);
	return Object.assign({hardSkip, autoEligible, hasTranslatableContent, masked}, summarizeProtectionRules(segments));
}

test("S8b M0a freezes the exact original fixture and separates current from desired golden", () => {
	const plugin = fixturePlugin();
	const original = currentResult(plugin, original14Markdown, "original");
	const protectedOnly = currentResult(plugin, allEnglishProtected, "protected");
	const title = currentResult(plugin, targetBodyForeignTitle, "title");
	const score = textSimilarityRuntime.getTextSimilarityScore(plugin, targetBodyForeignTitle, targetBodyTranslatedTitle);
	assert.equal(crypto.createHash("sha256").update(original14Markdown, "utf8").digest("hex").toUpperCase(), fixtureSha256.original14Markdown);
	assert.equal(crypto.createHash("sha256").update(targetBodyForeignTitle, "utf8").digest("hex").toUpperCase(), fixtureSha256.targetBodyForeignTitle);
	assert.equal(crypto.createHash("sha256").update(allEnglishProtected, "utf8").digest("hex").toUpperCase(), fixtureSha256.allEnglishProtected);
	assert.deepEqual({placeholderOccurrences: original.placeholderOccurrences, hardSkip: original.hardSkip, autoEligible: original.autoEligible}, currentBehaviorGolden.original14Markdown);
	assert.deepEqual({placeholderOccurrences: protectedOnly.placeholderOccurrences, hardSkip: protectedOnly.hardSkip, autoEligible: protectedOnly.autoEligible}, currentBehaviorGolden.allEnglishProtected);
	assert.equal(title.hardSkip, currentBehaviorGolden.targetBodyForeignTitle.hardSkip);
	assert.equal(title.autoEligible, currentBehaviorGolden.targetBodyForeignTitle.autoEligible);
	assert.ok(score > 0.92);
	assert.equal(original.ruleCounts["fenced-code"], 1);
	assert.equal(original.ruleCounts["auto-slash-token"], 1);
	assert.equal(original.ruleCounts["auto-uppercase-token"], undefined, "the all-caps acronym guess is retired");
	assert.equal(original.ruleCounts["auto-hyphen-token"], 6);
	assert.equal(Object.isFrozen(desiredBehaviorGolden), true);
	assert.equal(desiredBehaviorGolden.original14Markdown.completeForeignHeadingsAndOptionsTranslate, true);
	assert.notDeepEqual(currentBehaviorGolden.original14Markdown, desiredBehaviorGolden.original14Markdown);
});

test("S8b M0a ledger freezes every shared lane and terminal stage label", () => {
	const ledger = createTranslationTerminalLedger(); ledger.start();
	const lanes = ["manual", "auto-single", "history-primary", "batch-repair", "item-repair", "live-burst", "reply", "embed-forward", "sent", "cache-hit"];
	const stages = ["precheck", "protection", "cache", "provider", "parse", "placeholder", "target-language", "similarity", "repair", "display-currentness"];
	for (let index = 0; index < lanes.length; index++) {const route = ledger.begin({lane: lanes[index]}); ledger.terminal(route, {outcome: index % 2 ? "skipped" : "translated", stage: stages[index], reason: `fixture_${index}`});}
	const snapshot = ledger.getSnapshot();
	assert.deepEqual(snapshot.recent.map(item => item.lane), lanes);
	assert.deepEqual(snapshot.recent.map(item => item.stage), stages);
	assert.equal(snapshot.routeCount, 10); assert.equal(snapshot.activeRouteCount, 0);
});

test("S8b M0a ledger keeps one terminal per anonymous route and separate outcome stage reason", () => {
	const ledger = createTranslationTerminalLedger(); ledger.start();
	const route = ledger.begin({lane: "manual", shape: "embed-forward"});
	ledger.stage(route, "protection", "rules_applied", {placeholderOccurrences: 8, ruleCounts: {"fenced-code": 1, "auto-hyphen-token": 6}});
	ledger.stage(route, "provider", "http_200", {engineFamily: "custom", decisionApplied: false, promptFamily: "single-manual", validatorFamily: "manual-received"});
	assert.equal(ledger.terminal(route, {outcome: "skipped", stage: "similarity", reason: "too_similar"}), true);
	assert.equal(ledger.terminal(route, {outcome: "failed", stage: "provider", reason: "empty"}), false);
	const snapshot = ledger.getSnapshot(), item = snapshot.recent[0];
	assert.equal(item.routeId.startsWith("rt1:"), true);
	assert.equal(item.outcome, "skipped"); assert.equal(item.stage, "similarity"); assert.equal(item.reason, "too_similar");
	assert.equal(snapshot.duplicateTerminalCount, 1); assert.equal(snapshot.outcomes.skipped, 1); assert.equal(snapshot.stages.similarity, 1);
});

test("M3e ledger persists semantic revision, replaces legacy rule counts, counts repair dispatch and preserves parse stage", () => {
	const ledger = createTranslationTerminalLedger(); ledger.start();
	const route = ledger.begin({lane: "manual", validatorFamily: "manual-received", requestFamily: "single-text"});
	ledger.stage(route, "protection", "rules_applied", {placeholderOccurrences: 8, ruleCounts: {"auto-hyphen-token": 6}});
	ledger.stage(route, "protection", "semantic_plan", {placeholderOccurrences: 0, replaceRuleCounts: true, ruleCounts: {}, validatorFamily: "segment-validator-v2", semanticRevision: "s8b-m3e-v1", requestFamily: "typed-json"});
	ledger.stage(route, "provider", "dispatch", {providerRole: "primary", requestFamily: "typed-json"});
	ledger.stage(route, "parse", "malformed", {semanticRevision: "s8b-m3e-v1"});
	ledger.stage(route, "repair", "legacy_compatibility_fallback", {providerDispatch: true, providerRole: "fallback", requestFamily: "legacy-single-fallback"});
	ledger.stage(route, "parse", "malformed");
	ledger.terminal(route, {outcome: "failed", stage: "provider", reason: "malformed"});
	const item = ledger.getSnapshot().recent[0];
	assert.equal(item.semanticRevision, "s8b-m3e-v1");
	assert.equal(item.placeholderOccurrences, 0);
	assert.deepEqual(item.ruleCounts, {});
	assert.equal(item.providerDispatchCount, 2);
	assert.deepEqual(item.providerRoles, {primary: 1, fallback: 1});
	assert.equal(item.requestFamily, "legacy-single-fallback");
	assert.equal(item.stage, "parse");
});

test("M3f history-auto ledger keeps anonymous message/source identities and an ordered bounded path", () => {
	const ledger = createTranslationTerminalLedger({setTimer: () => ({unref() {}}), clearTimer: () => {}});
	ledger.start();
	const route = ledger.begin({
		lane: "history-primary",
		entry: "history-render",
		eligibility: "eligible",
		messageIdentity: "mi1:0123456789abcdef",
		sourceIdentity: "si1:fedcba9876543210",
		historyCheckpoint: {stage: "eligibility", reason: "eligible"}
	});
	ledger.update(route, {historyCheckpoint: {stage: "collector", reason: "accepted"}});
	ledger.update(route, {historyCheckpoint: {stage: "collector", reason: "accepted"}});
	ledger.stage(route, "provider", "dispatch", {providerDispatch: true, providerRole: "primary", historyCheckpoint: {stage: "primary", reason: "dispatch"}});
	ledger.update(route, {historyCheckpoint: {stage: "primary", reason: "settled"}});
	ledger.update(route, {historyCheckpoint: {stage: "atomic-commit", reason: "committed"}});
	ledger.terminal(route, {outcome: "translated", stage: "display-currentness", reason: "committed", historyCheckpoint: {stage: "display-currentness", reason: "confirmed"}});
	const item = ledger.getSnapshot().recent.at(-1);
	assert.equal(item.messageIdentity, "mi1:0123456789abcdef");
	assert.equal(item.sourceIdentity, "si1:fedcba9876543210");
	assert.deepEqual(item.historyPath, [
		"eligibility:eligible",
		"collector:accepted",
		"primary:dispatch",
		"primary:settled",
		"atomic-commit:committed",
		"display-currentness:confirmed"
	]);
	assert.equal(JSON.stringify(item).includes("original"), false);
});

test("S8b M0a ledger persists bounded private metadata and survives load reset stop cycles", () => {
	let saved = null;
	const create = () => createTranslationTerminalLedger({capacity: 3, load: () => saved, save: value => {saved = JSON.parse(JSON.stringify(value));}});
	let ledger = create(); ledger.start();
	for (let i = 0; i < 4; i++) {const route = ledger.begin({lane: i % 2 ? "auto-single" : "history-primary"}); ledger.update(route, {engineFamily: "custom", promptFamily: "batch-json", validatorFamily: "history-batch", cacheRead: "miss", cacheWrite: "none"}); ledger.terminal(route, {outcome: "translated", stage: "display-currentness", reason: "committed"});}
	ledger.flush(); assert.equal(saved.routes.length, 3); assert.equal(saved.evictedCount, 1);
	const serialized = JSON.stringify(saved); assert.doesNotMatch(serialized, /fixture|prompt body|https?:|endpoint|model|authorization|message content/i); assert.ok(Buffer.byteLength(serialized) < 1024 * 1024);
	for (let cycle = 0; cycle < 100; cycle++) {
		for (const [outcome, stage, reason] of [["translated", "display-currentness", "committed"], ["failed", "provider", "timeout"], ["cancelled", "display-currentness", "cancelled"]]) {const route = ledger.begin({lane: "manual", engineFamily: original14Markdown, promptFamily: targetBodyForeignTitle}); ledger.terminal(route, {outcome, stage, reason});}
		ledger.flush(); ledger.stop(); ledger = create(); ledger.start(); ledger.reset(); assert.deepEqual(ledger.getSnapshot().resources, {active: 0, pendingSave: false});
	}
	assert.doesNotMatch(JSON.stringify(saved), /Degree of Interest|Financial Aid Application Requirements/);
});

test("S8b M0a ledger event P95 stays below 0.5ms", () => {
	const ledger = createTranslationTerminalLedger(); ledger.start(); const timings = [];
	for (let i = 0; i < 1000; i++) {const start = performance.now(), route = ledger.begin({lane: "live-burst"}); ledger.stage(route, "provider", "http_200", {placeholderOccurrences: i % 10, engineFamily: "custom", decisionApplied: false, promptFamily: "batch-json", validatorFamily: "history-batch"}); ledger.terminal(route, {outcome: "translated", stage: "display-currentness", reason: "committed"}); timings.push(performance.now() - start);}
	timings.sort((a, b) => a - b); const snapshot = ledger.getSnapshot(); assert.ok(timings[Math.floor(timings.length * 0.95)] < 0.5); assert.equal(snapshot.routeCount, 128); assert.ok(snapshot.persistedBytes < 1024 * 1024);
});
