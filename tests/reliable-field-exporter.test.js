const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {ReliableFieldExporter, resolveActiveInstance} = require("../scripts/reliable-field-exporter.plugin.js");

test("plugin source loads through BetterDiscord's restricted remote require", () => {
	const sourcePath = path.join(__dirname, "..", "scripts", "reliable-field-exporter.plugin.js");
	const source = fs.readFileSync(sourcePath, "utf8");
	const pluginModule = {exports: {}};
	const supportedModules = {fs, path, process};
	const betterDiscordRequire = moduleId => {
		if (Object.prototype.hasOwnProperty.call(supportedModules, moduleId)) return supportedModules[moduleId];
		throw new Error(`Cannot find module ${moduleId}`);
	};
	const load = new Function("require", "module", "exports", "__filename", "__dirname", source);
	assert.doesNotThrow(() => load(betterDiscordRequire, pluginModule, pluginModule.exports, "F0MetricsExporter.plugin.js", path.dirname(sourcePath)));
	const plugin = new pluginModule.exports();
	assert.equal(typeof plugin.start, "function");
	assert.equal(typeof plugin.stop, "function");
});

function createFakeTimers() {
	let next = 0;
	const active = new Map();
	return {
		setTimeout(callback, delay) {
			const id = ++next;
			active.set(id, {callback, delay});
			return id;
		},
		clearTimeout(id) { active.delete(id); },
		count() { return active.size; },
		runOne() {
			const entry = active.entries().next().value;
			assert.ok(entry, "a poll timer is armed");
			const [id, timer] = entry;
			active.delete(id);
			timer.callback();
			return timer.delay;
		}
	};
}

function snapshot({burstRequestCount = 0, dispatchedBurstMessageCount = 0, batchRequestCount = 0, batchMessageCount = 0, enqueuedCount = 12, attemptTotalCount = 0, scheduled = 2, queueSampleCount = 4, sensitive = false, engineKey, trace: traceOverrides = {}, latency: latencyOverrides = {}, diagnostics: diagnosticsOverrides = {}} = {}) {
	return {
		trace: Object.assign({
			burstRequestCount,
			dispatchedBurstMessageCount,
			enqueuedCount,
			queueWait: {count: queueSampleCount, sufficient: queueSampleCount > 0, p50Ms: queueSampleCount > 0 ? 10 : null, p95Ms: queueSampleCount > 0 ? 20 : null},
			channelId: sensitive ? "CHANNEL-SENTINEL" : undefined,
			messageId: sensitive ? "MESSAGE-SENTINEL" : undefined,
			text: sensitive ? "TEXT-SENTINEL" : undefined
		}, traceOverrides),
		latency: Object.assign({
			batchRequestCount,
			batchMessageCount,
			attemptTotalCount,
			engineKey: engineKey || (sensitive ? "custom-ENGINE-ID-SENTINEL" : "custom-main"),
			endpoint: sensitive ? "ENDPOINT-SENTINEL" : undefined,
			apiKey: sensitive ? "KEY-SENTINEL" : undefined,
			model: sensitive ? "MODEL-SENTINEL" : undefined,
			latestAttempt: sensitive ? {rawResponse: "RAW-SENTINEL", channelId: "CHANNEL-SENTINEL"} : null
		}, latencyOverrides),
		diagnostics: Object.assign({fullRepaints: 0, scheduled, messageId: sensitive ? "MESSAGE-SENTINEL" : undefined}, diagnosticsOverrides)
	};
}

function createActiveInstance(state) {
	return {
		ensureLiveTranslationQueue() { return {performanceTrace: {getSnapshot: () => state.current.trace}}; },
		ensureProviderClient() { return {getLatencySnapshot: () => state.current.latency}; },
		ensureReceivedDisplayRepaintScheduler() { return {getDiagnostics: () => state.current.diagnostics}; }
	};
}

function createHarness({shape = "bdfdb-wrapper", initial = snapshot(), maxPolls = 3, fileSystem} = {}) {
	const state = {current: initial};
	const active = createActiveInstance(state);
	let constructorCalls = 0;
	function TranslatorConstructor() { constructorCalls++; throw new Error("must not instantiate"); }
	const metadata = {name: "DiscordAITranslator", version: "0.0.0", constructor: TranslatorConstructor};
	const globals = {
		BDFDB: shape === "bdfdb-wrapper" ? {BDUtils: {getPlugin: () => ({instance: active, ...metadata})}} : undefined,
		BdApi: shape === "bdapi-direct" ? {Plugins: {get: () => active}} : {Plugins: {get: () => metadata}},
		toasts: [],
		showToast(message, type) { this.toasts.push({message, type}); }
	};
	const timers = createFakeTimers();
	const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "reliable-field-exporter-"));
	const outputPath = path.join(outputDir, "DiscordAITranslator-f05-field-sample.json");
	const exporter = new ReliableFieldExporter({
		globals,
		outputPath,
		setTimeout: timers.setTimeout,
		clearTimeout: timers.clearTimeout,
		pollDelayMs: 1,
		maxPolls,
		fileSystem
	});
	return {state, active, metadata, globals, timers, outputPath, exporter, constructorCalls: () => constructorCalls, cleanup: () => fs.rmSync(outputDir, {recursive: true, force: true})};
}

function readOutput(harness) { return JSON.parse(fs.readFileSync(harness.outputPath, "utf8")); }

test("resolves wrapper instance and direct active instance without instantiating constructor or metadata lookalikes", () => {
	const wrapper = createHarness({shape: "bdfdb-wrapper"});
	assert.equal(resolveActiveInstance(wrapper.globals), wrapper.active);
	assert.equal(wrapper.constructorCalls(), 0);
	wrapper.cleanup();

	const direct = createHarness({shape: "bdapi-direct"});
	assert.equal(resolveActiveInstance(direct.globals), direct.active);
	assert.equal(direct.constructorCalls(), 0);
	direct.cleanup();
});

test("prefers a non-burst active instance over a fresh zero-metric wrapper lookalike", () => {
	const zeroState = {current: snapshot({enqueuedCount: 0, scheduled: 0, queueSampleCount: 0})};
	const liveState = {current: snapshot({enqueuedCount: 3, attemptTotalCount: 1, scheduled: 1, queueSampleCount: 1})};
	const zeroLookalike = createActiveInstance(zeroState);
	const live = createActiveInstance(liveState);
	const globals = {
		BDFDB: {BDUtils: {getPlugin: () => ({instance: zeroLookalike})}},
		BdApi: {Plugins: {get: () => ({instance: live})}}
	};
	assert.equal(resolveActiveInstance(globals), live);
});

test("every sanitized aggregate activity field outranks a zero-metric lookalike", () => {
	const zero = () => createActiveInstance({current: snapshot({enqueuedCount: 0, scheduled: 0, queueSampleCount: 0})});
	const cases = [
		["trace guardDropCount", {trace: {guardDropCount: 1}}],
		["trace requeuedCount", {trace: {requeuedCount: 1}}],
		["trace queueWait p50Ms", {trace: {queueWait: {count: 0, p50Ms: 1, p95Ms: null, sufficient: false}}}],
		["trace queueWait p95Ms", {trace: {queueWait: {count: 0, p50Ms: null, p95Ms: 1, sufficient: false}}}],
		["trace queueWait sufficient", {trace: {queueWait: {count: 0, p50Ms: null, p95Ms: null, sufficient: true}}}],
		["trace enqueueToDom p50Ms", {trace: {enqueueToDom: {count: 0, p50Ms: 1, p95Ms: null, sufficient: false}}}],
		["trace enqueueToDom p95Ms", {trace: {enqueueToDom: {count: 0, p50Ms: null, p95Ms: 1, sufficient: false}}}],
		["trace enqueueToDom sufficient", {trace: {enqueueToDom: {count: 0, p50Ms: null, p95Ms: null, sufficient: true}}}],
		["latency p50Ms", {latency: {p50Ms: 1}}],
		["latency p95Ms", {latency: {p95Ms: 1}}],
		["latency queueP50Ms", {latency: {queueP50Ms: 1}}],
		["latency queueP95Ms", {latency: {queueP95Ms: 1}}],
		["latency liveP50Ms", {latency: {liveP50Ms: 1}}],
		["latency liveP95Ms", {latency: {liveP95Ms: 1}}],
		["latency failoverCount", {latency: {failoverCount: 1}}],
		["latency timeoutCount", {latency: {timeoutCount: 1}}],
		["latency rateLimitCount", {latency: {rateLimitCount: 1}}],
		["latency queueWaitMs", {latency: {queueWaitMs: 1}}],
		["latency attemptsCount", {latency: {attemptsCount: 1}}],
		["latency sufficient", {latency: {sufficient: true}}],
		["latency queueSufficient", {latency: {queueSufficient: true}}],
		["latency liveSufficient", {latency: {liveSufficient: true}}],
		["diagnostics fullRepaints", {diagnostics: {fullRepaints: 1}}],
		["diagnostics deferred", {diagnostics: {deferred: 1}}],
		["diagnostics retries", {diagnostics: {retries: 1}}],
		["diagnostics exhausted", {diagnostics: {exhausted: 1}}],
		["resources queuedChannels", {diagnostics: {resources: {queuedChannels: 1}}}],
		["resources queuedMessages", {diagnostics: {resources: {queuedMessages: 1}}}],
		["resources activeChannels", {diagnostics: {resources: {activeChannels: 1}}}],
		["resources activeMessages", {diagnostics: {resources: {activeMessages: 1}}}],
		["resources coalesceTimerArmed", {diagnostics: {resources: {coalesceTimerArmed: true}}}],
		["resources fullRepaintTimerArmed", {diagnostics: {resources: {fullRepaintTimerArmed: true}}}],
		["resources settingsRetryTimerArmed", {diagnostics: {resources: {settingsRetryTimerArmed: true}}}],
		["resources textAreaRetryTimerArmed", {diagnostics: {resources: {textAreaRetryTimerArmed: true}}}],
		["resources deferredFullRepaintPending", {diagnostics: {resources: {deferredFullRepaintPending: true}}}]
	];
	for (const [label, overrides] of cases) {
		const live = createActiveInstance({current: snapshot(Object.assign({enqueuedCount: 0, scheduled: 0, queueSampleCount: 0}, overrides))});
		const globals = {
			BDFDB: {BDUtils: {getPlugin: () => ({instance: zero()})}},
			BdApi: {Plugins: {get: () => ({instance: live})}}
		};
		assert.equal(resolveActiveInstance(globals), live, label);
	}
});

test("export strips supplied endpoint key model text channel message and exact engine id", () => {
	const harness = createHarness({initial: snapshot({burstRequestCount: 1, dispatchedBurstMessageCount: 2, batchRequestCount: 1, batchMessageCount: 2, sensitive: true})});
	harness.exporter.start();
	const serialized = JSON.stringify(readOutput(harness));
	for (const sentinel of ["ENDPOINT-SENTINEL", "KEY-SENTINEL", "MODEL-SENTINEL", "TEXT-SENTINEL", "CHANNEL-SENTINEL", "MESSAGE-SENTINEL", "ENGINE-ID-SENTINEL", "RAW-SENTINEL"]) assert.equal(serialized.includes(sentinel), false, sentinel);
	assert.equal(readOutput(harness).effectiveEngineClass, "custom");
	harness.cleanup();
});

test("all-zero snapshot never produces a successful export", () => {
	const harness = createHarness({initial: snapshot({enqueuedCount: 0, attemptTotalCount: 0, scheduled: 0, queueSampleCount: 0}), maxPolls: 1});
	harness.exporter.start();
	assert.equal(fs.existsSync(harness.outputPath), false);
	assert.equal(harness.timers.count(), 1);
	harness.timers.runOne();
	const output = readOutput(harness);
	assert.equal(output.ok, false);
	assert.equal(output.reason, "insufficient_nonzero_metrics");
	assert.equal(output.trace.enqueuedCount, 0);
	assert.equal(output.trace.queueWait.count, 0);
	assert.equal(output.diagnostics.scheduled, 0);
	harness.cleanup();
});

test("a pre-existing non-custom burst waits instead of exporting success", () => {
	const harness = createHarness({initial: snapshot({burstRequestCount: 1, dispatchedBurstMessageCount: 2, batchRequestCount: 1, batchMessageCount: 2, engineKey: "openai-main"})});
	harness.exporter.start();
	assert.equal(fs.existsSync(harness.outputPath), false);
	assert.equal(harness.timers.count(), 1);
	harness.cleanup();
});

test("pre-existing custom burst exports immediately", () => {
	const harness = createHarness({initial: snapshot({burstRequestCount: 1, dispatchedBurstMessageCount: 2, batchRequestCount: 1, batchMessageCount: 2})});
	harness.exporter.start();
	const output = readOutput(harness);
	assert.equal(output.ok, true);
	assert.equal(output.mode, "preexisting_burst");
	assert.equal(harness.timers.count(), 0);
	harness.cleanup();
});

test("baseline waits until every burst predicate increased and then exports once", () => {
	const harness = createHarness({initial: snapshot({burstRequestCount: 1, dispatchedBurstMessageCount: 2, batchRequestCount: 1, batchMessageCount: 2}), maxPolls: 3});
	harness.exporter.start();
	assert.equal(fs.existsSync(harness.outputPath), true, "preexisting qualified burst is immediate");
	harness.cleanup();

	const waiting = createHarness({initial: snapshot({burstRequestCount: 0, dispatchedBurstMessageCount: 0, batchRequestCount: 0, batchMessageCount: 0}), maxPolls: 3});
	waiting.exporter.start();
	assert.equal(waiting.timers.count(), 1);
	waiting.state.current = snapshot({burstRequestCount: 1, dispatchedBurstMessageCount: 2, batchRequestCount: 1, batchMessageCount: 1});
	waiting.timers.runOne();
	assert.equal(fs.existsSync(waiting.outputPath), false, "partial burst stays pending");
	waiting.state.current = snapshot({burstRequestCount: 2, dispatchedBurstMessageCount: 3, batchRequestCount: 2, batchMessageCount: 3});
	waiting.timers.runOne();
	assert.equal(readOutput(waiting).ok, true);
	assert.equal(readOutput(waiting).mode, "observed_burst");
	assert.equal(waiting.timers.count(), 0);
	waiting.cleanup();
});

test("an observed non-custom burst remains waiting until a custom burst arrives", () => {
	const harness = createHarness({initial: snapshot({enqueuedCount: 0, scheduled: 0, queueSampleCount: 0}), maxPolls: 3});
	harness.exporter.start();
	harness.state.current = snapshot({burstRequestCount: 1, dispatchedBurstMessageCount: 2, batchRequestCount: 1, batchMessageCount: 2, engineKey: "machine-main"});
	harness.timers.runOne();
	assert.equal(fs.existsSync(harness.outputPath), false);
	assert.equal(harness.timers.count(), 1);
	harness.state.current = snapshot({burstRequestCount: 2, dispatchedBurstMessageCount: 3, batchRequestCount: 2, batchMessageCount: 3, engineKey: "custom-main"});
	harness.timers.runOne();
	assert.equal(readOutput(harness).ok, true);
	assert.equal(readOutput(harness).effectiveEngineClass, "custom");
	harness.cleanup();
});

test("an atomic export replaces an existing destination", () => {
	const harness = createHarness({initial: snapshot({burstRequestCount: 1, dispatchedBurstMessageCount: 2, batchRequestCount: 1, batchMessageCount: 2})});
	fs.writeFileSync(harness.outputPath, '{"old":true}\n', "utf8");
	harness.exporter.start();
	assert.equal(readOutput(harness).ok, true);
	assert.equal(readOutput(harness).old, undefined);
	assert.equal(fs.readdirSync(path.dirname(harness.outputPath)).some(name => name.endsWith(".tmp")), false);
	harness.cleanup();
});

test("write and rename failures finalize once without throwing or orphaning a temp file", () => {
	for (const failingOperation of ["write", "rename"]) {
		const fileSystem = {
			mkdirSync: fs.mkdirSync,
			writeFileSync(...args) {
				if (failingOperation === "write") throw new Error("injected write failure");
				return fs.writeFileSync(...args);
			},
			renameSync(...args) {
				if (failingOperation === "rename") throw new Error("injected rename failure");
				return fs.renameSync(...args);
			},
			unlinkSync: fs.unlinkSync
		};
		const harness = createHarness({initial: snapshot({burstRequestCount: 1, dispatchedBurstMessageCount: 2, batchRequestCount: 1, batchMessageCount: 2}), fileSystem});
		assert.doesNotThrow(() => harness.exporter.start(), failingOperation);
		assert.equal(harness.exporter.finished, true);
		assert.equal(harness.exporter.failed, true);
		assert.equal(harness.timers.count(), 0);
		assert.equal(fs.existsSync(harness.outputPath), false);
		assert.equal(fs.readdirSync(path.dirname(harness.outputPath)).some(name => name.endsWith(".tmp")), false);
		assert.equal(harness.globals.toasts.filter(toast => toast.type === "error").length, 1);
		harness.exporter.stop();
		assert.equal(harness.globals.toasts.filter(toast => toast.type === "error").length, 1);
		harness.cleanup();
	}
});

test("stop and timeout clear the bounded timer and finalization happens once", () => {
	const stopped = createHarness({initial: snapshot(), maxPolls: 2});
	stopped.exporter.start();
	stopped.exporter.stop();
	assert.equal(stopped.timers.count(), 0);
	assert.equal(fs.existsSync(stopped.outputPath), false);
	stopped.cleanup();

	const timedOut = createHarness({initial: snapshot(), maxPolls: 1});
	timedOut.exporter.start();
	timedOut.timers.runOne();
	const first = fs.readFileSync(timedOut.outputPath, "utf8");
	timedOut.exporter.stop();
	assert.equal(timedOut.timers.count(), 0);
	assert.equal(fs.readFileSync(timedOut.outputPath, "utf8"), first, "a finished exporter does not finalize again");
	timedOut.cleanup();
});
