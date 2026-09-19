const test = require("node:test");
const assert = require("node:assert/strict");
const {createPluginInstance} = require("../helpers/createPluginInstance");
const {renderSettingsPanel, cancelW2SettingsBenchmark} = require("../../src/ui/settings-panel");
const {createW2WireBenchmark} = require("../../src/diagnostics/w2-wire-benchmark");

function findByProp(node, name, value, out = []) {
	if (!node) return out;
	if (Array.isArray(node)) {for (const child of node) findByProp(child, name, value, out); return out;}
	if (typeof node !== "object") return out;
	const props = node.props || {};
	if (Object.prototype.hasOwnProperty.call(props, name) && (value === undefined || props[name] === value)) out.push(node);
	findByProp(props.children, name, value, out);
	return out;
}

function findByClass(node, className, out = []) {
	if (!node) return out;
	if (Array.isArray(node)) {for (const child of node) findByClass(child, className, out); return out;}
	if (typeof node !== "object") return out;
	const props = node.props || {};
	if (String(props.className || "").split(/\s+/).includes(className)) out.push(node);
	findByClass(props.children, className, out);
	return out;
}

function createUiFixture() {
	let copied = "", runCount = 0, confirmCount = 0;
	const plugin = createPluginInstance({callSetLanguages: false, settings: {engines: {translator: "oaicompat", backup: "----", customProviders: []}}, bdfdb: {
		PluginUtils: {createSettingsPanel: (_plugin, config) => typeof config.children === "function" ? config.children() : config.children, refreshSettingsPanel: () => {}},
		LibraryModules: {WindowUtils: {copy: value => {copied = value;}}},
		NotificationUtils: {toast: () => {}}
	}});
	try {plugin.onLoad();} catch {}
	plugin.settings.engines = {translator: "oaicompat", backup: "----", customProviders: []};
	plugin.settings.prefixes = plugin.settings.prefixes || {translationPrefixData: []};
	plugin.settings.performance = plugin.settings.performance || {historicalConcurrency: "auto", historicalSafetyDownshift: true, liveConcurrency: "1", liveStreaming: true};
	plugin.settingsUiState = {activeTab: "diagnostics"};
	const real = plugin.ensureProviderClient();
	const client = Object.assign({}, real, {
		getWireExperimentCapability: () => ({ok: true, engineKey: "oaicompat", protocolFamily: "openai_chat", configDigest: "w2c1:fixture"}),
		getW2Snapshot: () => ({status: "idle"})
	});
	const owner = {
		prepare: () => ({ok: true}),
		confirm: () => {confirmCount++;},
		run: () => {runCount++;}
	};
	plugin.ensureProviderClient = () => client;
	plugin.settingsUiState.w2WireBenchmark = {owner, providerClient: client, engineKey: "oaicompat", preview: null, progress: null, running: false};
	global.document = global.document || {querySelector: () => null, querySelectorAll: () => [], body: {}, documentElement: {}, createElement: () => ({style: {}, click() {}, remove() {}})};
	global.requestAnimationFrame = global.requestAnimationFrame || (fn => fn());
	global.BdApi = {React: {Component: class Component {}}, UI: {}};
	const render = () => renderSettingsPanel(plugin, {}, {BDFDB: plugin._testBdfdb});
	return {plugin, client, owner, render, get copied() {return copied;}, get runCount() {return runCount;}, get confirmCount() {return confirmCount;}};
}

test("published diagnostics keeps daily observability without preparing or exposing the historical W2 experiment", () => {
	const fixture = createUiFixture();
	let prepareCount = 0;
	fixture.owner.prepare = () => {prepareCount++; return {ok: true};};
	fixture.plugin.settingsUiState.w2WireBenchmark.preview = null;
	const panel = fixture.render();
	assert.equal(findByProp(panel, "data-w2-benchmark").length, 0, "the old three-arm paid experiment is not a published diagnostics action");
	assert.equal(findByProp(panel, "data-w2-action").length, 0);
	assert.equal(prepareCount, 0, "rendering ordinary settings never prepares a historical benchmark");
	assert.equal(fixture.confirmCount, 0);
	assert.equal(fixture.runCount, 0);
	assert.equal(findByClass(panel, "translator-ai-performance-table").length, 1);
	const copy = findByClass(panel, "translator-copy-diagnostics");
	assert.equal(copy.length, 1);
	copy[0].props.onClick();
	assert.equal(typeof JSON.parse(fixture.copied).build, "string");
});
test("W2 settings lifecycle cancels the real owner, aborts its physical session, and invalidates late UI closures", async () => {
	let release = null, sessionCancelReason = null, sessionSignal = null;
	const providerClient = {
		getWireExperimentCapability: () => ({ok: true, engineKey: "fixture", protocolFamily: "openai_chat", configDigest: "w2c1:lifecycle"}),
		createWireExperimentSession: (_engineKey, options) => {
			sessionSignal = options.signal;
			return {
				capability: {ok: true},
				dispatch: () => new Promise(resolve => {release = resolve;}),
				cancel: reason => {sessionCancelReason = reason; if (release) release({ok: false, reason: "cancelled"});},
				drain: () => Promise.resolve()
			};
		}
	};
	const owner = createW2WireBenchmark({providerClient});
	const prepared = owner.prepare("fixture");
	const token = owner.confirm(prepared.previewId);
	const running = owner.run(token);
	while (!release) await new Promise(resolve => setImmediate(resolve));
	const state = {owner, providerClient, preview: prepared, progress: {completed: 0}, running: true};
	const plugin = {settingsUiState: {w2WireBenchmark: state}};

	assert.equal(cancelW2SettingsBenchmark(plugin, "settings-closed"), true);
	assert.equal(sessionSignal.aborted, true, "owner controller is synchronously aborted");
	assert.equal(sessionCancelReason, "settings-closed", "the physical experiment session receives the lifecycle reason");
	assert.equal(state.owner, null, "late confirmation closures lose their owner");
	assert.equal(state.providerClient, null);
	assert.equal(state.preview, null);
	assert.equal(state.progress, null);
	assert.equal(state.running, false);
	assert.equal((await running).status, "cancelled");
});


test("opening every published tab leaves a fresh historical experiment entirely uninitialized", () => {
	const fixture = createUiFixture();
	delete fixture.plugin.settingsUiState.w2WireBenchmark;
	let capabilityChecks = 0, experimentSessions = 0;
	fixture.client.getWireExperimentCapability = () => {capabilityChecks++; return {ok: true};};
	fixture.client.createWireExperimentSession = () => {experimentSessions++; throw new Error("unexpected historical experiment");};
	for (const activeTab of ["providers", "strategy", "general", "advanced", "diagnostics"]) {
		fixture.plugin.settingsUiState.activeTab = activeTab;
		const panel = fixture.render();
		assert.equal(findByProp(panel, "data-w2-action").length, 0, activeTab);
		assert.equal(fixture.plugin.settingsUiState.w2WireBenchmark, undefined, activeTab + " must not create an owner");
	}
	assert.equal(capabilityChecks, 0);
	assert.equal(experimentSessions, 0);
});
