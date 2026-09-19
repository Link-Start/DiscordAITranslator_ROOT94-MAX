const test = require("node:test");
const assert = require("node:assert/strict");
const {createPluginInstance} = require("../helpers/createPluginInstance");
const {renderSettingsPanel, createAiLatencyDiagnosticsPayload} = require("../../src/ui/settings-panel");
const {getCustomTextValue} = require("../../src/i18n/text");
const {createProviderLatencyStore} = require("../../src/diagnostics/provider-latency-store");
const {createTranslationTerminalLedger} = require("../../src/diagnostics/translation-terminal-ledger");

function byClass(node, className, result = []) {
	if (!node) return result;
	if (Array.isArray(node)) {for (const child of node) byClass(child, className, result); return result;}
	if (typeof node !== "object") return result;
	const props = node.props || {};
	if (String(props.className || "").split(/\s+/).includes(className)) result.push(node);
	byClass(props.children, className, result);
	return result;
}

function textOf(node) {
	if (node == null || typeof node === "boolean") return "";
	if (Array.isArray(node)) return node.map(textOf).join(" ");
	if (typeof node === "object") return textOf(node.props && node.props.children);
	return String(node);
}

function renderDiagnostics({snapshot = {}, ledger = {}, locale = "en"} = {}) {
	let copied = "";
	const plugin = createPluginInstance({callSetLanguages: false, bdfdb: {
		PluginUtils: {createSettingsPanel: (_plugin, config) => typeof config.children === "function" ? config.children() : config.children, refreshSettingsPanel() {}},
		LibraryModules: {WindowUtils: {copy: value => {copied = value;}}},
		NotificationUtils: {toast() {}}
	}});
	try {plugin.onLoad();} catch {}
	plugin.settings.engines = {translator: "googleapi", backup: "----", customProviders: []};
	plugin.settings.prefixes = {translationPrefixData: []};
	plugin.settingsUiState = {activeTab: "diagnostics"};
	plugin.isChineseUiLanguage = () => locale === "zh";
	plugin.isRussianUiLanguage = () => locale === "ru";
	plugin.getCustomText = key => getCustomTextValue(key, locale === "zh", locale === "ru");
	const client = Object.assign({}, plugin.ensureProviderClient(), {getLatencySnapshot: () => snapshot, getProviderAttemptSnapshot: () => ({active: 0})});
	plugin.ensureProviderClient = () => client;
	plugin.getTranslationTerminalLedgerSnapshot = () => ledger;
	global.document = global.document || {querySelector: () => null, querySelectorAll: () => [], body: {}, documentElement: {}, createElement: () => ({style: {}, click() {}, remove() {}})};
	global.requestAnimationFrame = global.requestAnimationFrame || (fn => fn());
	global.BdApi = {React: {Component: class Component {}}, UI: {}};
	const panel = renderSettingsPanel(plugin, {}, {BDFDB: plugin._testBdfdb});
	return {panel, copy() {const button = byClass(panel, "translator-copy-diagnostics")[0]; assert.ok(button); button.props.onClick(); return JSON.parse(copied);}};
}

test("copied diagnostics distinguish ten message participations from one settled batch attempt", () => {
	const store = createProviderLatencyStore({now: () => 1000});
	const ledger = createTranslationTerminalLedger({now: () => 1000, setTimer: () => null, clearTimer() {}, save() {}});
	// One batch contains ten messages. Its serialized input ["A😀"] has seven
	// UTF-16 code units and nine UTF-8 bytes; the source A😀 has two code points.
	const token = store.beginLatencyRequest({kind: "historical", lane: "history-primary", messageCount: 10, inputChars: 7});
	for (let index = 0; index < 10; index++) {
		const route = ledger.begin({lane: "history-primary"});
		ledger.stage(route, "provider", "dispatch");
		ledger.terminal(route, {outcome: "translated", stage: "display-currentness"});
	}
	store.recordLatencyEvent({token, engineKey: "oaicompat", status: "ok", httpStatus: 200, transportMs: 25, outputChars: 3});
	// A later cache hit contributes a route, but no new transport observation.
	const cached = ledger.begin({lane: "cache-hit"});
	ledger.terminal(cached, {outcome: "translated", stage: "cache"});
	const payload = renderDiagnostics({snapshot: store.getLatencySnapshot(), ledger: ledger.getSnapshot()}).copy();
	assert.equal(payload.performanceControls.terminalLedger.schemaVersion, 5);
	assert.equal(payload.performanceControls.terminalLedger.recent.reduce((n, route) => n + route.providerDispatchCount, 0), 10);
	assert.deepEqual(payload.aiPerformance.transportAttempts, {generation: 0, settledCount: 1, historicalSettledCount: 1, batchSettledCount: 1, batchMessageParticipations: 10});
	assert.equal(payload.aiPerformance.latestTranslation.inputChars, 7, "preserve the existing stored unit without conversion");
	assert.equal(payload.aiPerformance.latestTranslation.requestBodyBytes, null, "an unobserved byte count stays unknown");
	assert.equal(payload.metricDefinitions.providerDispatchCount, "Per-message route participation in provider dispatches; shared batches count once per participating message. Do not sum as HTTP requests.");
	assert.equal(payload.metricDefinitions.inputChars, "UTF-16 code units of the input string recorded by that route. Typed/history paths can include serialization and protection markers; this is not original-text characters, tokens, or request-body bytes.");
	assert.equal(payload.metricDefinitions.transportAttempts, "Existing provider-latency-store attempt outcomes since the last diagnostics reset, including failures and cancellations. Counts do not establish upstream receipt or billing.");
});

test("ordinary diagnostics keep packaged string sizes inside clearly labelled technical details", () => {
	const snapshot = {latestTranslation: {engineKey: "googleapi", status: "ok", transportMs: 25, inputChars: 7, outputChars: 3, messageCount: 10}, attemptTotalCount: 1, batchRequestCount: 1};
	for (const [locale, lengthLabel, attemptLabel, lengthValue, noteFragment] of [
		["zh", "输入 / 输出长度（UTF-16） / 批量", "已结算请求尝试", "7 / 3 / 10 条", "共享批次中的 10 条消息会记为 10 次参与"],
		["en", "Input / output length (UTF-16) / batch", "Settled request attempts", "7 / 3 / 10 msgs", "Ten messages in a shared batch count as ten participations"],
		["ru", "Длина ввода / вывода (UTF-16) / пакет", "Завершённые попытки запросов", "7 / 3 / 10 сообщ.", "Десять сообщений в общем пакете дают десять участий"]
	]) {
		const {panel} = renderDiagnostics({snapshot, locale});
		const ordinary = textOf(byClass(panel, "translator-ai-performance-table")[0]);
		const details = byClass(panel, "translator-diagnostic-technical")[0];
		assert.ok(details);
		assert.equal(details.props.open, undefined, "technical details start collapsed");
		assert.equal(ordinary.includes(lengthLabel), false, locale + " keeps packaged lengths out of the daily summary");
		assert.equal(ordinary.includes(lengthValue), false, locale + " does not relabel them as source characters");
		const technical = textOf(details);
		assert.ok(technical.includes(lengthLabel), locale);
		assert.ok(technical.includes(lengthValue), locale);
		assert.ok(technical.includes(attemptLabel), locale);
		assert.equal(technical.includes(noteFragment), false, locale + " keeps the long explanation out of the rows");
		assert.ok(byClass(details, "translator-info-tip").some(node => String(node.props["aria-label"]).includes(noteFragment)), locale + " preserves the units in accessible help");
	}
});

test("daily diagnostics show four actionable rows and keep build identity in technical details", () => {
	const {panel, copy} = renderDiagnostics({locale: "zh", snapshot: {sampleCount: 2, queueSampleCount: 0, timeoutCount: 1}});
	const summary = byClass(panel, "translator-ai-performance-table")[0];
	assert.equal(byClass(summary, "translator-diagnostic-row").length, 4);
	assert.doesNotMatch(textOf(summary), /P50|P95|样本|检测|测试/);
	assert.match(textOf(summary), /最近翻译/);
	const technical = byClass(panel, "translator-diagnostic-technical")[0];
	assert.match(textOf(technical), /P50/);
	assert.doesNotMatch(textOf(technical), /首段响应（技术指标）|流式资源观察/);
	assert.doesNotMatch(textOf(byClass(panel, "translator-about-card")[0]), /构建/);
	assert.match(textOf(technical), /构建/);
	assert.ok(copy().aiPerformance.ttftGate, "copy retains engineering evidence removed from the UI");
});

test("old snapshots retain unknown transport counts while reset snapshots report observed zero", () => {
	assert.deepEqual(createAiLatencyDiagnosticsPayload({}).transportAttempts, {generation: null, settledCount: null, historicalSettledCount: null, batchSettledCount: null, batchMessageParticipations: null});
	const store = createProviderLatencyStore();
	const token = store.beginLatencyRequest({kind: "historical", messageCount: 2});
	store.recordLatencyEvent({token, status: "timeout", errorClass: "timeout"});
	store.resetLatency();
	assert.equal(store.recordLatencyEvent({token, status: "ok"}), null, "late settlement from the old generation stays discarded");
	assert.deepEqual(createAiLatencyDiagnosticsPayload(store.getLatencySnapshot()).transportAttempts, {generation: 1, settledCount: 0, historicalSettledCount: 0, batchSettledCount: 0, batchMessageParticipations: 0});
});
