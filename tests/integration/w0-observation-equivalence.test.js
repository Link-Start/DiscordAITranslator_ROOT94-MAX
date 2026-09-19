const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {createPluginInstance} = require("../helpers/createPluginInstance");
const {original14Markdown} = require("../fixtures/s8b-m0a-mixed-language-fixtures");
const {createWireObservation} = require("../../src/diagnostics/wire-observation-producer");
const {createAiLatencyDiagnosticsPayload, createDiagnosticsCopyPayload} = require("../../src/ui/settings-panel");

const CHANNEL_ID = "w0-observation-channel";
const ENDPOINT_SECRET = "https://w0-endpoint-sentinel.invalid/v1/chat/completions";
const KEY_SECRET = "W0-KEY-SENTINEL";
const MODEL_SECRET = "W0-MODEL-SENTINEL";
const SOURCE_SECRET = "Degree of Interest";
const RESPONSE_USAGE = Object.freeze({
	prompt_tokens: 301,
	completion_tokens: 97,
	completion_tokens_details: {reasoning_tokens: 11}
});
const WIRE_FIELDS = Object.freeze([
	"schemaVersion", "wireFamily", "wireVersion", "sourceBytes", "translateBytes",
	"wireBytes", "promptBytes", "metadataBytes", "requestBodyBytes",
	"wireAmplification", "segmentCount", "itemCount", "contextIncluded",
	"contextBytes", "protectedMarkerBytes", "prohibitedFieldCount",
	"danglingContextRefCount", "danglingContextRefBytes",
	"configuredTermLeakCount", "wrapperContentLeakCount", "emailLeakCount",
	"bareDomainLeakCount", "ipPortLeakCount", "commandLeakCount",
	"protectedIntegrity"
]);
const LEAK_FIELDS = Object.freeze([
	"configuredTermLeakCount", "wrapperContentLeakCount", "emailLeakCount",
	"bareDomainLeakCount", "ipPortLeakCount", "commandLeakCount"
]);

function sha256(value) {
	return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function translatedRows(plan, prefix = "译文") {
	return (plan && plan.segments || []).map((segment, index) => ({id: segment.id, translation: `${prefix}${index}`}));
}

function providerReplyFor(options) {
	const body = JSON.parse(String(options && options.body || "{}"));
	const userText = String(body.messages && body.messages.at(-1) && body.messages.at(-1).content || body.input || "");
	let payload = null;
	try {payload = JSON.parse(userText);}
	catch {}
	let content = "译文";
	if (payload && payload.schemaVersion === "semantic-batch-v1") {
		content = JSON.stringify({messages: payload.messages.map(message => ({
			id: message.id,
			segments: translatedRows(message.plan, `批量-${message.id}-`)
		}))});
	}
	else if (payload && Array.isArray(payload.segments)) content = JSON.stringify({segments: translatedRows(payload)});
	return JSON.stringify({
		choices: [{message: {content}, finish_reason: "stop"}],
		usage: RESPONSE_USAGE
	});
}

function createFixture({responseFactory = providerReplyFor} = {}) {
	const requests = [];
	const request = (url, options, callback) => {
		const record = {
			url: String(url),
			headers: Object.assign({}, options && options.headers || {}),
			body: String(options && options.body || ""),
			form: options && options.form ? Object.assign({}, options.form) : null
		};
		requests.push(record);
		const responseBody = responseFactory(options, record);
		queueMicrotask(() => callback(null, {statusCode: 200, headers: {}}, responseBody));
		return {abort() {}};
	};
	const plugin = createPluginInstance({
		callSetLanguages: false,
		bdfdb: {
			LibraryRequires: {request}
		},
		settings: {
			engines: {translator: "oaicompat", backup: "----", customProviders: []},
			performance: {historicalConcurrency: "4", historicalSafetyDownshift: false, liveConcurrency: "1", liveStreaming: false},
			filters: {
				receivedAutoTranslateScope: "loaded_messages",
				skipMixedReceivedMessages: false,
				useLocalLanguagePrecheck: false,
				minimumAutoTranslateLength: 1,
				autoTranslateDecisionMode: "ai"
			},
			choices: {received: {input: "en", output: "zh-CN"}, sent: {input: "en", output: "zh-CN"}},
			exceptions: {
				wordStart: ["!"],
				protectedTerms: [],
				wrapperPairs: ['"|"', '“|”', '`|`'],
				protectedTermsForReceived: true,
				wrapperPairsForReceived: true
			}
		},
		defaults: {
			choices: {
				received: {value: {input: "en", output: "zh-CN"}},
				sent: {value: {input: "en", output: "zh-CN"}}
			}
		}
	});
	try {plugin.onLoad();}
	catch {}
	plugin.settings.engines.translator = "oaicompat";
	plugin.settings.engines.backup = "----";
	try {plugin.setLanguages();}
	catch {}
	plugin.ensureSettingsStore().replaceAuthKeys({
		oaicompat: {
			key: KEY_SECRET,
			endpoint: ENDPOINT_SECRET,
			model: MODEL_SECRET,
			interfaceFormat: "openai_chat",
			reasoningMode: "off",
			reasoningProfile: "openai"
		}
	});
	plugin.getLanguageChoice = (type, place) => plugin.settings.choices[place] && plugin.settings.choices[place][type];
	plugin.getEffectivePrimaryEngine = () => "oaicompat";
	plugin.getEffectiveBackupEngine = () => "----";
	plugin.getHistoricalAiBatchEngineKey = () => "oaicompat";
	plugin.getHistoricalPrimaryEngineKey = () => "oaicompat";
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
	try {await Promise.resolve(fixture.plugin.onStop());}
	catch {}
}

function runTranslateText(plugin, source, options = {}) {
	return new Promise(resolve => plugin.translateText(source, "received", (translation, input, output, meta) => {
		resolve({translation, input, output, meta});
	}, null, Object.assign({
		channelId: CHANNEL_ID,
		showToast: false,
		showFailureToast: false,
		trackBusy: false,
		terminalLane: "manual",
		terminalEntry: "manual-click"
	}, options)));
}

function queueItem(id, source) {
	const message = {id: String(id), channel_id: CHANNEL_ID, content: source, embeds: [], attachments: [], author: {id: "other-user"}};
	return {message, channel: {id: CHANNEL_ID}, originalContentData: {content: source, embeds: []}};
}

function prepareItems(plugin, prefix, count = 3) {
	return Array.from({length: count}, (_, index) => {
		const source = `Financial Aid requirement ${prefix}-${index} for an international application.`;
		return plugin.prepareHistoricalAiBatchQueueItem(
			queueItem(`${prefix}-${index}`, source),
			CHANNEL_ID,
			{id: "en", name: "English"},
			{id: "zh-CN", name: "Chinese"}
		);
	});
}

test("W0 built manual exact P1 semantic attempt exports complete anonymous wire, usage and zero-leak fields", async () => {
	const fixture = createFixture();
	try {
		const result = await runTranslateText(fixture.plugin, original14Markdown);
		assert.equal(result.meta.failed, false, JSON.stringify(result.meta));
		assert.equal(result.meta.semanticRevision, "s8b-p2-v1");
		assert.equal(fixture.requests.length, 1);
		const captured = fixture.requests[0];
		const snapshot = fixture.plugin.ensureProviderClient().getLatencySnapshot();
		const attempt = snapshot.latestTranslation;
		assert.ok(attempt);
		for (const field of WIRE_FIELDS) assert.equal(Object.prototype.hasOwnProperty.call(attempt, field), true, field);
		assert.equal(attempt.kind, "manual");
		assert.equal(attempt.lane, "manual");
		assert.equal(attempt.wireFamily, "typed-json");
		assert.equal(attempt.wireVersion, "typed-compact-v1");
		assert.equal(attempt.sourceBytes, 2167);
		assert.equal(attempt.translateBytes, 1063);
		assert.equal(attempt.wireBytes, 9531);
		assert.equal(attempt.promptBytes, 11767);
		assert.equal(attempt.segmentCount, 61);
		assert.equal(attempt.itemCount, 1);
		assert.equal(attempt.requestBodyBytes, Buffer.byteLength(captured.body, "utf8"));
		assert.equal(attempt.promptTokens, 301);
		assert.equal(attempt.completionTokens, 97);
		assert.equal(attempt.reasoningTokens, 11);
		assert.equal(attempt.protectedIntegrity, "pass");
		for (const field of LEAK_FIELDS) assert.equal(attempt[field], 0, field);
		assert.ok(attempt.contextBytes > 0);
		assert.ok(attempt.prohibitedFieldCount > 0, "typed baseline reports its metadata overhead instead of hiding it");
		assert.equal(snapshot.wireObservation.attemptCount, 1);
		assert.deepEqual(snapshot.wireObservation.leakCounts, {
			configuredTerm: 0, wrapperContent: 0, email: 0, bareDomain: 0, ipPort: 0, command: 0
		});
		const serialized = JSON.stringify(snapshot);
		for (const secret of [ENDPOINT_SECRET, KEY_SECRET, MODEL_SECRET, SOURCE_SECRET, "Military Affiliation", "Non-Degree"])
			assert.doesNotMatch(serialized, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	}
	finally {await stopFixture(fixture);}
});

test("W0 disabled received protection scope does not label an intentionally visible term as a leak", async () => {
	const fixture = createFixture();
	try {
		fixture.plugin.settings.exceptions.protectedTerms = ["Longma"];
		fixture.plugin.settings.exceptions.protectedTermsForReceived = false;
		await runTranslateText(fixture.plugin, "Please review Longma today.");
		const attempt = fixture.plugin.ensureProviderClient().getLatencySnapshot().latestTranslation;
		assert.equal(attempt.configuredTermLeakCount, 0);
		assert.equal(attempt.protectedIntegrity, "pass");
		assert.match(fixture.requests[0].body, /Longma/);
	}
	finally {await stopFixture(fixture);}
});

test("W0 single native transport is classified as native before dispatch", async () => {
	const fixture = createFixture();
	try {
		fixture.plugin.ensureSettingsStore().replaceAuthKeys({oaicompat: {key: KEY_SECRET, endpoint: ENDPOINT_SECRET, model: MODEL_SECRET, interfaceFormat: "gemini_native", reasoningMode: "off", reasoningProfile: "gemini"}});
		let timing = null;
		fixture.plugin.openAiCompatibleTranslate = (data, callback) => {timing = data.timingContext; callback("");};
		await runTranslateText(fixture.plugin, "Native classification fixture.");
		assert.ok(timing);
		assert.equal(timing.engineFamily, "native");
	}
	finally {await stopFixture(fixture);}
});

test("W0 production sourceBytes retains leading and trailing input whitespace", async () => {
	const fixture = createFixture();
	try {
		const source = "  Whitespace fixture.  ";
		await runTranslateText(fixture.plugin, source);
		const attempt = fixture.plugin.ensureProviderClient().getLatencySnapshot().latestTranslation;
		assert.equal(attempt.sourceBytes, Buffer.byteLength(source, "utf8"));
		assert.equal(attempt.segmentCount >= 1, true);
		assert.equal(attempt.wireBytes > 0, true);
		assert.equal(attempt.promptBytes > attempt.translateBytes, true);
		assert.equal(attempt.requestBodyBytes > attempt.promptBytes, true);
	}
	finally {await stopFixture(fixture);}
});

test("W0 real translateMessage manual entry keeps the manual observation lane", async () => {
	const fixture = createFixture();
	try {
		const channel = {id: CHANNEL_ID};
		const message = {id: "real-manual-w0", channel_id: CHANNEL_ID, content: "Manual lane fixture.", embeds: [], attachments: [], author: {id: "other-user"}};
		await fixture.plugin.translateMessage(message, channel, {manual: true, silent: true, trackBusy: false});
		assert.equal(fixture.plugin.ensureProviderClient().getLatencySnapshot().latestTranslation.lane, "manual");
	}
	finally {await stopFixture(fixture);}
});

test("W0 production semantic repair is role repair while the successful siblings stay unreplayed", async () => {
	let call = 0;
	const fixture = createFixture({responseFactory: options => {
		const body = JSON.parse(options.body), plan = JSON.parse(body.messages.at(-1).content), rows = translatedRows(plan);
		return JSON.stringify({choices: [{message: {content: JSON.stringify({segments: call++ === 0 ? rows.slice(0, -1) : rows})}, finish_reason: "stop"}], usage: RESPONSE_USAGE});
	}});
	try {
		await runTranslateText(fixture.plugin, "First sentence needs translation. Second sentence also needs translation.");
		assert.equal(fixture.requests.length, 2);
		const snapshot = fixture.plugin.ensureProviderClient().getLatencySnapshot(), attempt = snapshot.latestTranslation;
		assert.equal(attempt.role, "repair");
		assert.equal(attempt.repairCount, 1);
		assert.equal(attempt.lane, "manual");
		assert.equal(snapshot.wireObservation.repairReasonCounts["missing-id"] >= 1, true);
	}
	finally {await stopFixture(fixture);}
});

test("W0 production malformed root records one fallback and the final failed outcome", async () => {
	let call = 0;
	const fixture = createFixture({responseFactory: () => JSON.stringify({choices: [{message: {content: call++ === 0 ? "not-json" : ""}, finish_reason: "stop"}], usage: RESPONSE_USAGE})});
	try {
		await runTranslateText(fixture.plugin, "Malformed root fallback fixture.");
		assert.equal(fixture.requests.length, 2);
		const snapshot = fixture.plugin.ensureProviderClient().getLatencySnapshot(), attempt = snapshot.latestTranslation;
		assert.equal(attempt.role, "fallback");
		assert.equal(attempt.fallbackCount, 1);
		assert.equal(attempt.outcome, "failed");
		assert.equal(snapshot.wireObservation.fallbackReasonCounts["root-malformed"], 1);
	}
	finally {await stopFixture(fixture);}
});

test("W0 built live-burst and historical batch retain distinct lanes and message versus segment counts", async () => {
	const fixture = createFixture();
	try {
		const client = fixture.plugin.ensureProviderClient();
		for (const scenario of [
			{kind: "live", lane: "live-burst", prefix: "live"},
			{kind: "historical", lane: "history-primary", prefix: "history"}
		]) {
			client.resetLatency();
			const prepared = prepareItems(fixture.plugin, scenario.prefix, 3);
			assert.equal(prepared.every(item => item && item.semanticRequest && item.semanticRequest.enabled), true);
			const expectedSegments = prepared.reduce((total, item) => total + item.semanticRequest.segmentOrder.length, 0);
			const token = client.beginLatencyRequest({kind: scenario.kind, lane: scenario.lane, messageCount: prepared.length});
			const outcome = await client.requestAiBatchTranslationDetailed("oaicompat", prepared, {
				token,
				role: "primary",
				engineKey: "oaicompat",
				engineFamily: "ai",
				lane: scenario.lane,
				messageCount: prepared.length,
				historicalBatch: scenario.kind === "historical"
			});
			assert.ok(outcome && outcome.translations, JSON.stringify(outcome));
			const attempt = client.getLatencySnapshot().latestTranslation;
			assert.equal(attempt.kind, scenario.kind);
			assert.equal(attempt.lane, scenario.lane);
			assert.equal(attempt.itemCount, 3);
			assert.equal(attempt.messageCount, 3);
			assert.equal(attempt.segmentCount, expectedSegments);
			assert.equal(attempt.wireFamily, "typed-json");
			assert.equal(attempt.promptTokens, 301);
			for (const field of LEAK_FIELDS) assert.equal(attempt[field], 0, `${scenario.lane}/${field}`);
		}
	}
	finally {await stopFixture(fixture);}
});

test("W0 Google classic-marked history observes the protected q field without claiming opaque form bytes", async () => {
	const fixture = createFixture({responseFactory: options => options && options.form ? JSON.stringify({src: "en", sentences: [{trans: String(options.form.q || "").replace(/[A-Za-z]+/g, "译文")} ]}) : providerReplyFor(options)});
	try {
		fixture.plugin.getHistoricalAiBatchEngineKey = () => null;
		fixture.plugin.getHistoricalPrimaryEngineKey = () => "googleapi";
		fixture.plugin.settings.exceptions.protectedTerms = ["Longma"];
		const prepared = fixture.plugin.prepareHistoricalAiBatchQueueItem(queueItem("google-w0", "Review Longma at docs.example.org with /x now."), CHANNEL_ID, {id: "en", name: "English"}, {id: "zh-CN", name: "Chinese"});
		assert.equal(prepared.semanticRequest.adapter, "classic-marked");
		const client = fixture.plugin.ensureProviderClient();
		const token = client.beginLatencyRequest({kind: "historical", lane: "history-primary", messageCount: 1});
		await new Promise(resolve => fixture.plugin.googleApiTranslate({input: prepared.input, output: prepared.output, text: prepared.semanticRequest.wire, timingContext: {token, role: "primary", engineKey: "googleapi", engineFamily: "classic", lane: "history-primary", messageCount: 1, wireObservationProbe: prepared.wireObservationProbe}, silent: true}, resolve));
		const attempt = client.getLatencySnapshot().latestTranslation;
		assert.equal(attempt.wireFamily, "classic-marked");
		assert.equal(attempt.engineFamily, "classic");
		assert.equal(attempt.promptBytes > 0, true);
		assert.equal(attempt.requestBodyBytes, null, "the request library owns form encoding, so W0 does not invent transport bytes");
		for (const field of LEAK_FIELDS) assert.equal(attempt[field], 0, field);
	}
	finally {await stopFixture(fixture);}
});

test("W0 Google multi-chunk attempts report each physical q slice instead of repeating full-document metrics", async () => {
	const fixture = createFixture({responseFactory: options => options && options.form ? JSON.stringify({src: "en", sentences: [{trans: String(options.form.q || "")} ]}) : providerReplyFor(options)});
	try {
		fixture.plugin.getHistoricalAiBatchEngineKey = () => null;
		fixture.plugin.getHistoricalPrimaryEngineKey = () => "googleapi";
		const prepared = fixture.plugin.prepareHistoricalAiBatchQueueItem(queueItem("google-long-w0", original14Markdown), CHANNEL_ID, {id: "en", name: "English"}, {id: "zh-CN", name: "Chinese"});
		assert.equal(prepared.semanticRequest.segmentOrder.length, 61);
		const fullWireBytes = Buffer.byteLength(prepared.semanticRequest.wire, "utf8");
		const client = fixture.plugin.ensureProviderClient();
		const token = client.beginLatencyRequest({kind: "historical", lane: "history-primary", messageCount: 1});
		await new Promise(resolve => fixture.plugin.googleApiTranslate({input: prepared.input, output: prepared.output, text: prepared.semanticRequest.wire, timingContext: {token, role: "primary", engineKey: "googleapi", engineFamily: "classic", lane: "history-primary", messageCount: 1, wireObservationProbe: prepared.wireObservationProbe}, silent: true}, resolve));
		const snapshot = client.getLatencySnapshot(), latest = snapshot.latestTranslation;
		assert.equal(snapshot.attemptsCount >= 2, true);
		assert.equal(latest.wireBytes < fullWireBytes, true);
		assert.equal(latest.segmentCount < prepared.semanticRequest.segmentOrder.length, true);
		assert.equal(latest.sourceBytes, Buffer.byteLength(original14Markdown, "utf8"));
		assert.equal(latest.requestBodyBytes, null);
		const physical = fixture.requests.filter(request => request.form).map(request => prepared.wireObservationProbe.observe(JSON.stringify(request.form)));
		assert.equal(physical.reduce((total, item) => total + item.segmentCount, 0), prepared.semanticRequest.segmentOrder.length);
		assert.equal(physical.reduce((total, item) => total + item.translateBytes, 0), 1063);
	}
	finally {await stopFixture(fixture);}
});

async function runProbeArm(mode) {
	const fixture = createFixture();
	try {
		const client = fixture.plugin.ensureProviderClient();
		const token = client.beginLatencyRequest({kind: "manual", lane: "manual", messageCount: 1});
		let observeCalls = 0;
		const wireObservationProbe = mode === "none" ? null : {
			observe(requestBody) {
				observeCalls++;
				if (mode === "throw") throw new Error("W0 probe sentinel throw");
				return createWireObservation({
					wireFamily: "legacy-single",
					wireVersion: "legacy",
					source: "Probe source",
					wire: "Probe source",
					providerVisibleTexts: ["Probe source"],
					translateSegments: ["Probe source"],
					requestBody,
					itemCount: 1,
					contextIncluded: false,
					contextText: "",
					protectedMarkerText: ""
				});
			}
		};
		const value = await new Promise(resolve => fixture.plugin.openAiCompatibleTranslate({
			input: {id: "en", name: "English"},
			output: {id: "zh-CN", name: "Chinese"},
			text: "Probe source",
			autoDecision: false,
			decisionPrompt: "",
			timingContext: {
				token,
				role: "primary",
				engineKey: "oaicompat",
				engineFamily: "ai",
				lane: "manual",
				messageCount: 1,
				wireObservationProbe
			}
		}, resolve));
		assert.equal(fixture.requests.length, 1);
		const request = fixture.requests[0];
		return {
			value,
			observeCalls,
			dispatchCount: fixture.requests.length,
			url: request.url,
			headers: request.headers,
			bodySha256: sha256(request.body)
		};
	}
	finally {await stopFixture(fixture);}
}

test("W0 built provider dispatch is byte-identical without a probe, with a probe and when the probe throws", async () => {
	const baseline = await runProbeArm("none");
	const observed = await runProbeArm("observe");
	const throwing = await runProbeArm("throw");
	assert.equal(baseline.observeCalls, 0);
	assert.equal(observed.observeCalls, 1);
	assert.equal(throwing.observeCalls, 1);
	for (const arm of [observed, throwing]) {
		assert.equal(arm.dispatchCount, baseline.dispatchCount);
		assert.equal(arm.url, baseline.url);
		assert.deepEqual(arm.headers, baseline.headers);
		assert.equal(arm.bodySha256, baseline.bodySha256);
		assert.equal(arm.value, baseline.value);
	}
});

test("W0 built snapshot through the copied-diagnostics serializer contains anonymous aggregates and no fixture secrets", async () => {
	const fixture = createFixture();
	try {
		await runTranslateText(fixture.plugin, original14Markdown);
		const client = fixture.plugin.ensureProviderClient();
		const aiPerformance = createAiLatencyDiagnosticsPayload(client.getLatencySnapshot(), client.getProviderAttemptSnapshot());
		const copied = JSON.stringify(createDiagnosticsCopyPayload({
			plugin: "W0 fixture",
			build: "fixture-build",
			providers: "oaicompat"
		}, aiPerformance));
		const payload = JSON.parse(copied);
		assert.equal(payload.wireObservation.schemaVersion, "w0-1");
		assert.equal(payload.wireObservation.attemptCount, 1);
		assert.deepEqual(payload.wireObservation.leakCounts, {
			configuredTerm: 0, wrapperContent: 0, email: 0, bareDomain: 0, ipPort: 0, command: 0
		});
		for (const secret of [ENDPOINT_SECRET, KEY_SECRET, MODEL_SECRET, SOURCE_SECRET, "Military Affiliation", "Non-Degree", "choices", "rawResponse"])
			assert.doesNotMatch(copied, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.ok(Buffer.byteLength(copied, "utf8") < 1024 * 1024);
	}
	finally {await stopFixture(fixture);}
});

test("W0 built live trace closes into provider owner and copied enqueueToDomMs without ids", async () => {
	const fixture = createFixture();
	try {
		const client = fixture.plugin.ensureProviderClient();
		const token = client.beginLatencyRequest({kind: "live", lane: "auto-single", messageCount: 1});
		client.recordLatencyEvent({token, engineKey: "oaicompat", engineFamily: "ai", status: "ok", wireObservation: createWireObservation({wireFamily: "typed-json", wireVersion: "s8b-p2-v1", source: "hello", wire: "hello", providerVisibleTexts: ["hello"], translateSegments: ["hello"], requestBody: "{}", itemCount: 1})});
		const trace = fixture.plugin.ensureLiveTranslationQueue().performanceTrace;
		trace.queueObserver.notify("enqueued", {channelId: "private-channel", messageId: "private-message", queueDepth: 1});
		trace.linkAttempt({channelId: "private-channel", messageId: "private-message", requestId: token.requestId, generation: token.generation});
		trace.onRenderOutcome({channelId: "private-channel", outcome: {confirmedIds: ["private-message"], deferredIds: []}});
		const snapshot = client.getLatencySnapshot();
		assert.equal(snapshot.latestTranslation.enqueueToDomMs != null, true);
		assert.equal(snapshot.wireObservation.display.confirmedCount, 1);
		const copied = createAiLatencyDiagnosticsPayload(snapshot, client.getProviderAttemptSnapshot());
		assert.equal(copied.latestTranslation.enqueueToDomMs, snapshot.latestTranslation.enqueueToDomMs);
		assert.doesNotMatch(JSON.stringify(copied), /private-channel|private-message/);
	}
	finally {await stopFixture(fixture);}
});
