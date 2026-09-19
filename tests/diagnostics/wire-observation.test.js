const test = require("node:test");
const assert = require("node:assert/strict");
const {createSemanticRequest} = require("../../src/planner/translation-semantic-runtime");
const {original14Markdown} = require("../fixtures/s8b-m0a-mixed-language-fixtures");

let observationModule = null;
let observationLoadError = null;
try {observationModule = require("../../src/diagnostics/wire-observation-producer");}
catch (error) {observationLoadError = error;}

function target(name) {
	assert.equal(observationLoadError, null,
		`W0 target module src/diagnostics/wire-observation-producer.js is not implemented: ${observationLoadError && observationLoadError.code}`);
	assert.equal(typeof observationModule[name], "function", `W0 target API ${name} is not implemented`);
	return observationModule[name];
}

function exactSemanticFixture() {
	const request = createSemanticRequest({
		engineKey: "oaicompat",
		source: original14Markdown,
		direction: "received",
		fieldPath: "body",
		inputLanguageId: "auto",
		targetLanguageId: "zh-CN"
	});
	assert.equal(request.enabled, true);
	const wire = JSON.parse(request.wire);
	return {request, wire};
}

function createExactObservation(createWireObservation) {
	const {request, wire} = exactSemanticFixture();
	const requestBody = JSON.stringify({
		model: "fixture-model",
		messages: [
			{role: "system", content: request.systemPrompt},
			{role: "user", content: request.wire}
		]
	});
	return createWireObservation({
		wireFamily: "typed-json",
		wireVersion: request.wireVersion,
		source: original14Markdown,
		wire: request.wire,
		providerVisibleTexts: [request.systemPrompt, request.wire],
		translateSegments: wire.segments.map(segment => segment.text),
		requestBody,
		itemCount: 1,
		contextIncluded: (wire.contexts || []).length > 0,
		contextText: JSON.stringify(wire.contexts || []),
		protectedMarkerText: "",
		prohibitedFieldCount: 0,
		danglingContextRefCount: 0,
		danglingContextRefBytes: 0
	});
}

test("W0 red harness freezes the current P1 exact fixture before calling a missing target API", () => {
	const {request, wire} = exactSemanticFixture();
	assert.equal(Buffer.byteLength(original14Markdown, "utf8"), 2167);
	// typed-compact-v1: short labels and no bookkeeping fields took the exact P1 wire from 14528 to 8250 bytes; explicit name permission now adds 21 bytes per segment.
	assert.equal(Buffer.byteLength(request.wire, "utf8"), 9531);
	assert.equal(Buffer.byteLength(request.systemPrompt, "utf8"), 1578);
	assert.equal(request.segmentOrder.length, 61);
	assert.equal(wire.segments.reduce((total, segment) => total + Buffer.byteLength(segment.text, "utf8"), 0), 1063);
});

test("W0 module exports the two agreed pure observation APIs", () => {
	target("createWireObservation");
	target("createProtectionLeakScanner");
});

test("W0 createWireObservation measures the exact P1 typed request in UTF-8 bytes", () => {
	const createWireObservation = target("createWireObservation");
	const observation = createExactObservation(createWireObservation);
	assert.equal(Object.isFrozen(observation), true);
	assert.equal(observation.schemaVersion, "w0-1");
	assert.equal(observation.wireFamily, "typed-json");
	assert.equal(observation.wireVersion, "typed-compact-v1");
	assert.equal(observation.sourceBytes, 2167);
	assert.equal(observation.translateBytes, 1063);
	assert.equal(observation.wireBytes, 9531);
	assert.equal(observation.promptBytes, 11109);
	assert.equal(observation.metadataBytes, 11109 - 1063);
	assert.equal(observation.segmentCount, 61);
	assert.equal(observation.itemCount, 1);
	assert.equal(observation.contextIncluded, true);
	assert.equal(observation.wireAmplification, 9531 / 2167);
	assert.equal(observation.requestBodyBytes > observation.promptBytes, true);
});

test("W0 byte accounting uses UTF-8 rather than JavaScript code units", () => {
	const createWireObservation = target("createWireObservation");
	const source = "A你好😀";
	const wire = JSON.stringify({x: ["A", "你", "😀"]});
	const system = "系统😀";
	const requestBody = JSON.stringify({system, wire});
	const observation = createWireObservation({
		wireFamily: "typed-json",
		wireVersion: "utf8-fixture",
		source,
		wire,
		providerVisibleTexts: [system, wire],
		translateSegments: ["A", "你", "😀"],
		requestBody,
		itemCount: 1,
		contextIncluded: false,
		contextText: "",
		protectedMarkerText: ""
	});
	assert.equal(observation.sourceBytes, Buffer.byteLength(source, "utf8"));
	assert.equal(observation.wireBytes, Buffer.byteLength(wire, "utf8"));
	assert.equal(observation.promptBytes, Buffer.byteLength(system, "utf8") + Buffer.byteLength(wire, "utf8"));
	assert.equal(observation.translateBytes, ["A", "你", "😀"].reduce((sum, value) => sum + Buffer.byteLength(value, "utf8"), 0));
	assert.equal(observation.requestBodyBytes, Buffer.byteLength(requestBody, "utf8"));
	assert.equal(observation.segmentCount, 3);
	assert.notEqual(observation.sourceBytes, source.length, "the fixture must distinguish UTF-8 bytes from UTF-16 code units");
});

test("W0 itemCount and segmentCount remain separate for historical batches", () => {
	const createWireObservation = target("createWireObservation");
	const wire = JSON.stringify({messages: [
		{id: "m1", x: ["one", "two"]},
		{id: "m2", x: ["three"]}
	]});
	const observation = createWireObservation({
		wireFamily: "typed-json",
		wireVersion: "batch-fixture",
		source: "one two\nthree",
		wire,
		providerVisibleTexts: [wire],
		translateSegments: ["one", "two", "three"],
		requestBody: JSON.stringify({input: wire}),
		itemCount: 2,
		contextIncluded: false,
		contextText: "",
		protectedMarkerText: ""
	});
	assert.equal(observation.itemCount, 2);
	assert.equal(observation.segmentCount, 3);
});

test("W0 protection scanner reports only counts for all six P1 leak classes", () => {
	const createProtectionLeakScanner = target("createProtectionLeakScanner");
	const secrets = Object.freeze({
		configuredTerms: ["W0_TERM_SENTINEL"],
		wrapperContents: ["W0 WRAPPED SENTINEL"],
		emails: ["w0-secret@example.invalid"],
		bareDomains: ["docs.w0-secret.invalid"],
		ipPorts: ["192.0.2.99:8443"],
		commands: ["/w0-secret-command"]
	});
	const scanner = createProtectionLeakScanner(secrets);
	assert.equal(typeof scanner.scan, "function");
	assert.equal(Object.isFrozen(scanner), true);
	const visible = [
		"system has W0_TERM_SENTINEL once",
		"user has W0_TERM_SENTINEL twice W0 WRAPPED SENTINEL",
		"w0-secret@example.invalid docs.w0-secret.invalid 192.0.2.99:8443 /w0-secret-command"
	];
	const counts = scanner.scan(visible);
	assert.deepEqual(counts, {
		configuredTermLeakCount: 2,
		wrapperContentLeakCount: 1,
		emailLeakCount: 1,
		bareDomainLeakCount: 1,
		ipPortLeakCount: 1,
		commandLeakCount: 1,
		protectedIntegrity: "fail"
	});
	assert.equal(Object.isFrozen(counts), true);
	const serialized = JSON.stringify(counts);
	for (const secret of Object.values(secrets).flat()) assert.doesNotMatch(serialized, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	for (const forbiddenKey of ["matches", "terms", "values", "offsets", "source", "wire"])
		assert.equal(Object.prototype.hasOwnProperty.call(counts, forbiddenKey), false);
});

test("W0 protection scanner counts every physical retry and repair without logical deduplication", () => {
	const createProtectionLeakScanner = target("createProtectionLeakScanner");
	const scanner = createProtectionLeakScanner({
		configuredTerms: ["PHYSICAL-LEAK"], wrapperContents: [], emails: [], bareDomains: [], ipPorts: [], commands: []
	});
	const aggregate = {configuredTermLeakCount: 0};
	for (const physicalWire of ["PHYSICAL-LEAK primary", "PHYSICAL-LEAK retry", "PHYSICAL-LEAK repair"])
		aggregate.configuredTermLeakCount += scanner.scan([physicalWire]).configuredTermLeakCount;
	assert.equal(aggregate.configuredTermLeakCount, 3);
});

test("W0 clean P1 provider-visible payload reports zero leaks and never retains sensitive extras", () => {
	const createProtectionLeakScanner = target("createProtectionLeakScanner");
	const createWireObservation = target("createWireObservation");
	const secrets = {
		configuredTerms: ["Longma"],
		wrapperContents: ["KEEP THIS"],
		emails: ["john.doe@example.com"],
		bareDomains: ["docs.example.org"],
		ipPorts: ["192.168.1.5:8443"],
		commands: ["/translate-now"]
	};
	const scanner = createProtectionLeakScanner(secrets);
	const leakCounts = scanner.scan(["Translate protected local markers only: ⟦0⟧ ⟦1⟧ ⟦2⟧ ⟦3⟧ ⟦4⟧ ⟦5⟧"]);
	assert.deepEqual(leakCounts, {
		configuredTermLeakCount: 0,
		wrapperContentLeakCount: 0,
		emailLeakCount: 0,
		bareDomainLeakCount: 0,
		ipPortLeakCount: 0,
		commandLeakCount: 0,
		protectedIntegrity: "pass"
	});
	const observation = createWireObservation({
		wireFamily: "typed-json",
		wireVersion: "s8b-p2-v1",
		source: Object.values(secrets).flat().join(" "),
		wire: "{\"x\":[\"Translate markers ⟦0⟧ ⟦1⟧\"]}",
		providerVisibleTexts: ["system", "{\"x\":[\"Translate markers ⟦0⟧ ⟦1⟧\"]}"],
		translateSegments: ["Translate markers ⟦0⟧ ⟦1⟧"],
		requestBody: "{\"fixture\":true}",
		itemCount: 1,
		contextIncluded: false,
		contextText: "",
		protectedMarkerText: "⟦0⟧⟦1⟧",
		leakCounts,
		endpoint: "https://W0-ENDPOINT-SENTINEL.invalid",
		key: "W0-KEY-SENTINEL",
		rawResponse: "W0-RAW-SENTINEL"
	});
	const serialized = JSON.stringify(observation);
	for (const secret of Object.values(secrets).flat().concat(["W0-ENDPOINT", "W0-KEY", "W0-RAW"]))
		assert.doesNotMatch(serialized, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.ok(Buffer.byteLength(serialized, "utf8") < 16 * 1024);
});

test("W0 provider-visible extraction covers Responses Gemini Anthropic Ollama and classic form text fields", () => {
	const {providerVisibleTextsFromBody} = require("../../src/diagnostics/wire-observation-producer");
	const bodies = [
		[{instructions: "responses-system", input: "responses-user"}, ["responses-system", "responses-user"]],
		[{system_instruction: {parts: [{text: "gemini-system"}]}, contents: [{parts: [{text: "gemini-user"}]}]}, ["gemini-user", "gemini-system"]],
		[{system: "anthropic-system", messages: [{content: "anthropic-user"}]}, ["anthropic-system", "anthropic-user"]],
		[{messages: [{content: "ollama-user"}]}, ["ollama-user"]],
		[{q: "classic-q"}, ["classic-q"]],
		[[{Text: "microsoft-text"}], ["microsoft-text"]],
		[{text: ["deepl-text"]}, ["deepl-text"]]
	];
	for (const [body, expected] of bodies) assert.deepEqual(providerVisibleTextsFromBody(JSON.stringify(body)), expected);
});

test("W0 batch probe deduplicates shared protection values and counts the outer metadata once", () => {
	const {createWireObservationProbe, combineWireObservationProbes} = require("../../src/diagnostics/wire-observation-producer");
	const create = source => createWireObservationProbe({source, wire: source, wireFamily: "legacy-batch", protectedSegments: {0: "Longma"}, configuredTerms: ["Longma"]});
	const wire = JSON.stringify({schemaVersion: "semantic-batch-v1", messages: [{id: "a", text: "Longma"}, {id: "b", text: "Longma"}]});
	const batch = combineWireObservationProbes([create("Longma one"), create("Longma two")], {wireFamily: "legacy-batch", wireVersion: "legacy", wire, itemCount: 2});
	const body = JSON.stringify({messages: [{role: "user", content: wire}]});
	const observation = batch.observe(body);
	assert.equal(observation.configuredTermLeakCount, 2, "two visible occurrences are counted once each, not once per message probe");
	assert.equal(observation.prohibitedFieldCount >= 3, true, "outer schema and message ids are counted in the physical batch wire");
});

test("W0 configured-term scanner uses the same word boundaries as P1 protection", () => {
	const {createWireObservationProbe} = require("../../src/diagnostics/wire-observation-producer");
	const probe = createWireObservationProbe({source: "Review Longman today", wire: "Review Longman today", configuredTerms: ["Longma"], protectedSegments: {}});
	const observation = probe.observe(JSON.stringify({messages: [{role: "user", content: "Review Longman today"}]}));
	assert.equal(observation.configuredTermLeakCount, 0);
	assert.equal(observation.protectedIntegrity, "pass");
});

test("W0 no-dispatch target-language plan keeps a complete local anonymous sample", () => {
	const {createWireObservationProbe} = require("../../src/diagnostics/wire-observation-producer");
	const {createProviderLatencyStore} = require("../../src/diagnostics/provider-latency-store");
	const source = "这是一条无需发送给翻译服务的中文消息。";
	const request = createSemanticRequest({engineKey: "oaicompat", source, inputLanguageId: "auto", targetLanguageId: "zh-CN"});
	assert.equal(request.enabled, true);
	assert.equal(request.segmentOrder.length, 0);
	const probe = createWireObservationProbe({source, request, protectedSegments: {}});
	const store = createProviderLatencyStore(), token = store.beginLatencyRequest({kind: "live", lane: "auto-single"});
	store.recordWireObservationEvent({token, wireObservation: probe.local()});
	const snapshot = store.getWireObservationSnapshot();
	assert.equal(snapshot.attemptCount, 0);
	assert.equal(snapshot.localSampleCount, 1);
	assert.equal(snapshot.latestLocal.sourceBytes, Buffer.byteLength(source, "utf8"));
	assert.equal(snapshot.latestLocal.segmentCount, 0);
	assert.equal(snapshot.latestLocal.promptBytes, 0, "no-dispatch samples never claim hypothetical Provider-visible prompt bytes");
	assert.equal(snapshot.latestLocal.requestBodyBytes, null);
});
