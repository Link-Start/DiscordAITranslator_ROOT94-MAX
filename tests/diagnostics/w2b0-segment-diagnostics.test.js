const test = require("node:test");
const assert = require("node:assert/strict");

const {W2_ARMS, W2_BALANCED_ORDERS, W2_MEASURED_FIXTURES} = require("../../src/diagnostics/w2-wire-benchmark-fixtures");
const {
	W2_MAX_REQUESTS,
	normalizeW2ScheduleOptions,
	createW2Schedule,
	compileW2FixtureArm,
	validateW2ArmResponse,
	diagnoseW2ArmResponse,
	createW2WireBenchmark
} = require("../../src/diagnostics/w2-wire-benchmark");
const {
	W2_SEGMENT_REASONS,
	MAX_SEGMENT_DIAGNOSTICS,
	sanitizeSegmentDiagnostics,
	sanitizeStructureDiagnostics,
	createW2WireBenchmarkStore
} = require("../../src/diagnostics/w2-wire-benchmark-store");

const SUBSET_FIXTURES = Object.freeze(["f01-exact-academic", "f05-protection-composite", "f06-markdown-structure", "f08-order-oracle", "f09-unicode-lines"]);
const SEGMENT_FIELDS = Object.freeze(["index", "reason", "sourceChars", "targetChars", "sourceHasCjk", "targetHasCjk", "sourceLineCount", "sourceWordCount", "isListItem", "isHeading"]);
const STRUCTURE_FIELDS = Object.freeze(["expectedItemCount", "receivedItemCount", "missingMarkerIndices", "duplicateMarkerIndices", "unknownMarkerCount", "wrappedInCodeFence", "leadingChars", "trailingChars", "orderPreserved", "terminalMarkerPresent", "terminalMarkerLast", "outsideMarkerChars", "closeMarkerEchoes", "strayMarkerChars", "windowed", "contextChars", "contextCoveragePermille", "firstPassValid", "repairRequested", "repairValid", "repairReason", "repairProviderMs", "repairPromptTokens", "repairCompletionTokens", "responseChars", "responseHasCjk"]);

function chineseFor(text, index) {
	if (/apple/i.test(text)) return "苹果是红色的。";
	if (/ocean/i.test(text)) return "海洋是蓝色的。";
	if (/bird/i.test(text)) return "鸟可以飞翔。";
	if (/moon/i.test(text)) return "月亮很明亮。";
	// P2 wire: protection tokens travel inside the segment text and a valid answer echoes them.
	const tokens = [...String(text).matchAll(/⟦(?:[CW])?\d+⟧|⟦\/?F\d+⟧/g)].map(match => match[0]).join("").replace(/⟦F\d+⟧/g, "$&格式文字");
	return `这是第${index + 1}项合成译文${tokens}。`;
}

function goodResponse(request, mutateValues = values => values) {
	const payload = JSON.parse(request.userPrompt);
	if (request.arm === "A") {
		const rows = mutateValues(payload.segments.map((row, index) => ({id: row.id, translation: chineseFor(row.text, index)})));
		return JSON.stringify({segments: rows});
	}
	const values = mutateValues(payload.x.map(chineseFor));
	if (request.arm === "Ba") return JSON.stringify(values);
	return values.map((value, index) => `⟦W${index}⟧${value}`).join("\n") + `\n⟦W${values.length}⟧`;
}

function fixture(id) {return W2_MEASURED_FIXTURES.find(row => row.id === id);}

function createProviderHarness(responder) {
	const calls = [];
	const providerClient = {
		getWireExperimentCapability() {return {ok: true, engineKey: "fixture-ai", protocolFamily: "openai_chat", configDigest: "w2c1:0123456789abcdefabcd"};},
		createWireExperimentSession() {
			return {
				capability: providerClient.getWireExperimentCapability(),
				async dispatch(request) {
					calls.push({arm: request.localRequest.arm, fixture: request.localRequest.sourceIdentity});
					return {ok: true, text: responder(request.localRequest), providerMs: 5, usage: {promptTokens: 11, completionTokens: 7, reasoningTokens: 0}};
				},
				cancel() {},
				async drain() {},
				snapshot() {return {};}
			};
		}
	};
	return {providerClient, calls};
}

test("W2b-0 schedule options default to the frozen 165-request W2 plan and accept arm/fixture/sample subsets", () => {
	const full = normalizeW2ScheduleOptions();
	assert.equal(full.ok, true);
	assert.deepEqual(full.arms, ["A", "Ba", "Bm"]);
	assert.equal(full.fixtureIds.length, 9);
	assert.equal(full.samplesPerFixture, 6);
	assert.equal(full.totalRequests, W2_MAX_REQUESTS);
	assert.deepEqual(full.orders, W2_BALANCED_ORDERS);
	assert.equal(createW2Schedule().length, 165);
	assert.deepEqual(createW2Schedule(), createW2Schedule(full));

	const subset = normalizeW2ScheduleOptions({arms: ["Bm", "A"], fixtureIds: SUBSET_FIXTURES.slice().reverse(), samplesPerFixture: 6});
	assert.equal(subset.ok, true);
	assert.deepEqual(subset.arms, ["A", "Bm"], "arms are canonicalized to the frozen W2 order");
	assert.deepEqual(subset.fixtureIds, SUBSET_FIXTURES, "fixtures are canonicalized to manifest order");
	assert.deepEqual(subset.orders, [["A", "Bm"], ["Bm", "A"]]);
	assert.equal(subset.warmupRequests, 2);
	assert.equal(subset.measuredRequests, 60);
	assert.equal(subset.totalRequests, 62);
	assert.equal(subset.samplesPerArm, 30);
	const schedule = createW2Schedule(subset);
	assert.equal(schedule.length, 62);
	assert.deepEqual(schedule.slice(0, 2).map(row => [row.arm, row.warmup]), [["A", true], ["Bm", true]]);
	const measured = schedule.filter(row => !row.warmup);
	for (const arm of ["A", "Bm"]) {
		const rows = measured.filter(row => row.arm === arm);
		assert.equal(rows.length, 30);
		assert.deepEqual([0, 1].map(position => rows.filter(row => row.position === position).length), [15, 15], `${arm} positions stay balanced`);
		for (const id of SUBSET_FIXTURES) assert.equal(rows.filter(row => row.fixtureId === id).length, 6);
	}
	assert.equal(measured.some(row => row.arm === "Ba"), false);
	assert.equal(new Set(schedule.map(row => row.trialId)).size, 62);

	const single = normalizeW2ScheduleOptions({arms: ["Ba"], fixtureIds: ["f01-exact-academic", "f05-protection-composite", "f07-academic-technical", "f09-unicode-lines"], samplesPerFixture: 6});
	assert.equal(single.ok, true);
	assert.equal(single.totalRequests, 25);
	assert.deepEqual(single.orders, [["Ba"]]);

	assert.equal(normalizeW2ScheduleOptions({arms: ["Z"]}).reason, "arm");
	assert.equal(normalizeW2ScheduleOptions({arms: []}).reason, "arm");
	assert.equal(normalizeW2ScheduleOptions({fixtureIds: ["nope"]}).reason, "fixture");
	assert.equal(normalizeW2ScheduleOptions({samplesPerFixture: 0}).reason, "samples");
	assert.equal(normalizeW2ScheduleOptions({samplesPerFixture: 7}).reason, "request-budget", "3 arms x 9 fixtures x 7 exceeds the 165 hard cap");
	assert.throws(() => createW2Schedule({arms: ["Z"]}), TypeError);
});

test("W2b-0 segment inventory is identical across arms and carries only numbers, booleans and finite reasons", () => {
	for (const item of W2_MEASURED_FIXTURES) {
		const inventories = [];
		for (const arm of W2_ARMS) {
			const request = compileW2FixtureArm(item, arm);
			const diagnostics = diagnoseW2ArmResponse(request, goodResponse(request));
			assert.equal(Array.isArray(diagnostics.segments), true);
			assert.ok(diagnostics.segments.length > 0, `${item.id}/${arm} has segments`);
			assert.equal(diagnostics.segments.every(row => row.reason === "ok"), true, `${item.id}/${arm} clean response is all ok`);
			assert.deepEqual(Object.keys(diagnostics.segments[0]).sort(), SEGMENT_FIELDS.slice().sort());
			assert.deepEqual(Object.keys(diagnostics.structure).sort(), STRUCTURE_FIELDS.slice().sort());
			assert.equal(diagnostics.structure.expectedItemCount, diagnostics.segments.length);
			assert.equal(diagnostics.structure.receivedItemCount, diagnostics.segments.length);
			assert.deepEqual(diagnostics.structure.missingMarkerIndices, []);
			assert.deepEqual(diagnostics.structure.duplicateMarkerIndices, []);
			assert.equal(diagnostics.structure.unknownMarkerCount, 0);
			assert.equal(diagnostics.structure.wrappedInCodeFence, false);
			assert.equal(diagnostics.structure.orderPreserved, true);
			assert.equal(diagnostics.structure.terminalMarkerPresent, arm === "Bm" ? true : null);
			assert.equal(diagnostics.structure.terminalMarkerLast, arm === "Bm" ? true : null);
			inventories.push(diagnostics.segments.map(row => [row.index, row.sourceChars, row.sourceHasCjk, row.sourceLineCount, row.sourceWordCount, row.isListItem, row.isHeading]));
		}
		// W2c: A is the production P2 plan, which merges the runs around inline protected nodes;
		// Ba/Bm still index the raw planner nodes. Inventories match wherever P2 merged nothing.
		assert.deepEqual(inventories[1], inventories[2], `${item.id}: Ba and Bm index the same segments`);
		if (item.id === "f05-protection-composite") {
			assert.equal(inventories[0].length, 3, "f05 on the production wire is three merged ranges");
			assert.equal(inventories[1].length, 12, "the raw planner still cuts f05 into twelve pieces");
		}
		else if (inventories[0].length === inventories[1].length) assert.deepEqual(inventories[0], inventories[1], `${item.id}: A and Ba index the same segments`);
		else assert.ok(inventories[0].length < inventories[1].length, `${item.id}: the P2 merge only ever reduces the segment count`);
	}
	const academic = compileW2FixtureArm(fixture("f01-exact-academic"), "A");
	const rows = diagnoseW2ArmResponse(academic, goodResponse(academic)).segments;
	assert.equal(rows.length, 61);
	assert.equal(rows[0].isHeading, true, "segment 0 sits in a ### heading line");
	assert.equal(rows[0].isListItem, true, "the heading label starts with a numeric marker");
	assert.equal(rows[1].isListItem, true, "Undergraduate is a - A. list item");
	assert.equal(rows[1].isHeading, false);
	assert.equal(rows[1].sourceChars, 13);
	assert.equal(rows[1].sourceWordCount, 1);
	assert.equal(rows[1].sourceHasCjk, false);
	assert.equal(rows[1].targetHasCjk, true);
	assert.equal(rows.filter(row => row.isHeading).length, 13, "13 heading segments carry the numbered section titles");
	assert.equal(rows.filter(row => row.isListItem && !row.isHeading).length, 48, "every non-heading segment is a - X. list item");
});

test("W2b-0 typed-json diagnostics attribute wrong-language, missing, duplicate and malformed outcomes per segment", () => {
	const request = compileW2FixtureArm(fixture("f01-exact-academic"), "A");
	const english = diagnoseW2ArmResponse(request, goodResponse(request, rows => rows.map((row, index) => index === 46 ? Object.assign({}, row, {translation: "GED"}) : row)));
	assert.equal(english.segments[46].reason, "wrong-language");
	assert.equal(english.segments[46].targetHasCjk, false);
	assert.equal(english.segments[46].targetChars, 3);
	assert.equal(english.segments.filter(row => row.reason !== "ok").length, 1);
	assert.equal(validateW2ArmResponse(request, goodResponse(request, rows => rows.map((row, index) => index === 46 ? Object.assign({}, row, {translation: "GED"}) : row))).reason, "wrong-language");

	const missing = diagnoseW2ArmResponse(request, goodResponse(request, rows => rows.filter((_, index) => index !== 9)));
	assert.equal(missing.segments[9].reason, "missing-id");
	assert.equal(missing.segments[9].targetChars, null);
	assert.equal(missing.segments[9].targetHasCjk, null);
	assert.deepEqual(missing.structure.missingMarkerIndices, [9]);
	assert.equal(missing.structure.receivedItemCount, 60);

	const duplicated = diagnoseW2ArmResponse(request, goodResponse(request, rows => [...rows, rows[3]]));
	assert.equal(duplicated.segments[3].reason, "duplicate-id");
	assert.deepEqual(duplicated.structure.duplicateMarkerIndices, [3]);

	const unknown = diagnoseW2ArmResponse(request, goodResponse(request, rows => [...rows, {id: "seg-not-in-plan", translation: "多余"}]));
	assert.equal(unknown.structure.unknownMarkerCount, 1);

	const malformed = diagnoseW2ArmResponse(request, "Sorry, I cannot help with that.");
	assert.equal(malformed.segments.length, 61);
	assert.equal(malformed.segments.every(row => row.reason === "malformed" && row.targetChars === null), true);
	assert.equal(malformed.structure.receivedItemCount, 0);
	assert.equal(malformed.structure.responseHasCjk, false);

	const fenced = diagnoseW2ArmResponse(request, "```json\n" + goodResponse(request) + "\n```");
	assert.equal(fenced.structure.wrappedInCodeFence, true);
	assert.equal(fenced.segments.every(row => row.reason === "ok"), true, "typed parser tolerates fences; the fence is still recorded");
});

test("W2b-0 marker diagnostics keep scanning after the parser stops and expose the marker structure", () => {
	const request = compileW2FixtureArm(fixture("f06-markdown-structure"), "Bm");
	const clean = goodResponse(request), expected = request.local.request.mapping.length;

	const noTerminal = diagnoseW2ArmResponse(request, clean.replace(new RegExp(`\\n⟦W${expected}⟧$`), ""));
	assert.equal(validateW2ArmResponse(request, clean.replace(new RegExp(`\\n⟦W${expected}⟧$`), "")).reason, "missing-terminal-marker");
	assert.equal(noTerminal.structure.terminalMarkerPresent, false);
	assert.equal(noTerminal.structure.terminalMarkerLast, false);
	assert.equal(noTerminal.structure.receivedItemCount, expected);
	assert.equal(noTerminal.segments.every(row => row.reason === "ok"), true, "every translated block is still judged on its own");

	// Terminal emitted before the final block: present, empty, but not last.
	const lines = clean.split("\n"), terminalLine = lines.pop(), lastBlock = lines.pop();
	const earlyTerminal = [...lines, terminalLine, lastBlock].join("\n");
	assert.equal(validateW2ArmResponse(request, earlyTerminal).reason, "missing-terminal-marker");
	const early = diagnoseW2ArmResponse(request, earlyTerminal);
	assert.equal(early.structure.terminalMarkerPresent, true);
	assert.equal(early.structure.terminalMarkerLast, false);
	assert.equal(early.structure.trailingChars, 0);
	assert.deepEqual(early.structure.missingMarkerIndices, []);
	assert.equal(early.structure.orderPreserved, true);
	assert.equal(early.segments.every(row => row.reason === "ok"), true);

	const punctuationAfterTerminal = diagnoseW2ArmResponse(request, clean + "。");
	assert.equal(validateW2ArmResponse(request, clean + "。").reason, "missing-terminal-marker");
	assert.equal(punctuationAfterTerminal.structure.terminalMarkerPresent, true);
	assert.equal(punctuationAfterTerminal.structure.terminalMarkerLast, true);
	assert.equal(punctuationAfterTerminal.structure.trailingChars, 1);

	const leading = diagnoseW2ArmResponse(request, "Here is the translation:\n" + clean);
	assert.equal(validateW2ArmResponse(request, "Here is the translation:\n" + clean).reason, "marker-schema");
	assert.equal(leading.structure.leadingChars, "Here is the translation:\n".length);
	assert.equal(leading.segments.every(row => row.reason === "ok"), true);

	const fenced = diagnoseW2ArmResponse(request, "```\n" + clean + "\n```");
	assert.equal(fenced.structure.wrappedInCodeFence, true);
	assert.equal(fenced.structure.terminalMarkerPresent, true);
	assert.equal(fenced.segments.every(row => row.reason === "ok"), true);

	const duplicated = diagnoseW2ArmResponse(request, clean.replace("⟦W2⟧", "⟦W1⟧"));
	assert.equal(validateW2ArmResponse(request, clean.replace("⟦W2⟧", "⟦W1⟧")).ok, false);
	assert.deepEqual(duplicated.structure.duplicateMarkerIndices, [1]);
	assert.deepEqual(duplicated.structure.missingMarkerIndices, [2]);
	assert.equal(duplicated.segments[1].reason, "duplicate-marker");
	assert.equal(duplicated.segments[2].reason, "missing-marker");
	assert.equal(duplicated.structure.orderPreserved, true);

	const unknown = diagnoseW2ArmResponse(request, clean.replace("⟦W3⟧", "⟦W99⟧"));
	assert.equal(unknown.structure.unknownMarkerCount, 1);
	assert.deepEqual(unknown.structure.missingMarkerIndices, [3]);

	const reordered = diagnoseW2ArmResponse(request, clean.replace("⟦W0⟧", "⟦WX⟧").replace("⟦W1⟧", "⟦W0⟧").replace("⟦WX⟧", "⟦W1⟧"));
	assert.equal(reordered.structure.orderPreserved, false);
	assert.equal(reordered.structure.missingMarkerIndices.length, 0);

	const untranslated = diagnoseW2ArmResponse(request, clean.replace(/⟦W1⟧[^\n]*/, `⟦W1⟧${request.local.request.mapping[1].text}`));
	assert.equal(["too-similar", "wrong-language"].includes(untranslated.segments[1].reason), true);
	assert.equal(untranslated.segments[1].targetHasCjk, false);

	const trailing = diagnoseW2ArmResponse(request, clean + "\nThat is all.");
	assert.equal(trailing.structure.trailingChars, "That is all.".length);
});

test("W2b-0 compact-array diagnostics align by index and keep short or fenced arrays measurable", () => {
	const request = compileW2FixtureArm(fixture("f08-order-oracle"), "Ba");
	const short = diagnoseW2ArmResponse(request, goodResponse(request, values => values.slice(0, -1)));
	assert.equal(validateW2ArmResponse(request, goodResponse(request, values => values.slice(0, -1))).reason, "item-count");
	assert.equal(short.structure.expectedItemCount, 6);
	assert.equal(short.structure.receivedItemCount, 5);
	assert.deepEqual(short.structure.missingMarkerIndices, [5]);
	assert.equal(short.segments[5].reason, "item-count");
	assert.equal(short.segments.slice(0, 5).every(row => row.reason === "ok"), true);

	const fenced = diagnoseW2ArmResponse(request, "```json\n" + goodResponse(request) + "\n```");
	assert.equal(validateW2ArmResponse(request, "```json\n" + goodResponse(request) + "\n```").reason, "markdown-fence");
	assert.equal(fenced.structure.wrappedInCodeFence, true);
	assert.equal(fenced.segments.every(row => row.reason === "ok"), true);

	const nonString = diagnoseW2ArmResponse(request, goodResponse(request, values => values.map((value, index) => index === 2 ? 42 : value)));
	assert.equal(nonString.segments[2].reason, "non-string-item");

	const object = diagnoseW2ArmResponse(request, JSON.stringify({x: ["苹果"]}));
	assert.equal(object.segments.every(row => row.reason === "unexpected-root"), true);
	assert.equal(object.structure.receivedItemCount, 0);
});

test("W2b-0 diagnostics never serialize fixture text, markers, ids or prompts", () => {
	const forbiddenText = new Set();
	for (const item of W2_MEASURED_FIXTURES) {
		for (const line of String(item.source).split(/\r\n|\r|\n/)) if (line.trim().length >= 3) forbiddenText.add(line.trim());
		for (const arm of W2_ARMS) {
			const request = compileW2FixtureArm(item, arm);
			for (const row of arm === "A" ? JSON.parse(request.userPrompt).segments : JSON.parse(request.userPrompt).x) forbiddenText.add(String(arm === "A" ? row.text : row));
			if (arm === "A") for (const row of JSON.parse(request.userPrompt).segments) forbiddenText.add(String(row.id));
			const responses = [
				goodResponse(request),
				"```json\n" + goodResponse(request) + "\n```",
				"not json at all",
				goodResponse(request, values => Array.isArray(values) ? values.slice(0, Math.max(0, values.length - 1)) : values)
			];
			for (const response of responses) {
				const diagnostics = diagnoseW2ArmResponse(request, response);
				const serialized = JSON.stringify(diagnostics);
				assert.equal(serialized.includes("⟦"), false);
				for (const text of forbiddenText) if (text.length >= 3) assert.equal(serialized.includes(text), false, `${item.id}/${arm} leaked ${JSON.stringify(text.slice(0, 24))}`);
				for (const segment of diagnostics.segments) for (const [key, value] of Object.entries(segment)) {
					if (key === "reason") assert.equal(W2_SEGMENT_REASONS.includes(value), true, `${key}=${value}`);
					else assert.equal(value === null || typeof value === "number" || typeof value === "boolean", true, `${key} must be number/boolean/null`);
				}
				for (const [key, value] of Object.entries(diagnostics.structure)) {
					if (Array.isArray(value)) assert.equal(value.every(Number.isInteger), true, key);
					else assert.equal(value === null || typeof value === "number" || typeof value === "boolean", true, `${key} must be number/boolean/null`);
				}
			}
		}
	}
});

test("W2b-0 store accepts planned arm subsets and sanitizes segment and structure diagnostics", () => {
	const store = createW2WireBenchmarkStore({now: () => 1000});
	assert.equal(store.beginW2Session({plannedArms: ["typed-json", "compact-marker"], plannedSamplesPerArm: 30, plannedWarmupCount: 2, plannedLogicalRequests: 61, plannedPhysicalRequests: 61}), null, "logical count below the planned arm total is rejected");
	assert.equal(store.beginW2Session({plannedArms: ["nope"], plannedSamplesPerArm: 1, plannedWarmupCount: 0, plannedLogicalRequests: 1, plannedPhysicalRequests: 1}), null);
	const token = store.beginW2Session({fixtureSetVersion: "w2-fixed-v1", fixtureCount: 5, plannedArms: ["compact-marker", "typed-json"], plannedSamplesPerArm: 30, plannedWarmupCount: 2, plannedLogicalRequests: 62, plannedPhysicalRequests: 62});
	assert.ok(token);
	assert.deepEqual(store.getW2Snapshot().plannedArms, ["typed-json", "compact-marker"]);

	const oversized = Array.from({length: MAX_SEGMENT_DIAGNOSTICS + 10}, (_, index) => ({index, reason: "ok", sourceChars: 5, targetChars: 6, sourceHasCjk: false, targetHasCjk: true, sourceLineCount: 1, sourceWordCount: 1, isListItem: false, isHeading: false}));
	const record = store.recordW2Trial(token, {
		trialId: 0, arm: "compact-marker", fixtureId: "f01-exact-academic", orderId: 7, position: 1, status: "failed", valid: false, reason: "missing-terminal-marker", providerMs: 10, usage: {promptTokens: 1, completionTokens: 1, reasoningTokens: 0},
		segmentDiagnostics: [
			{index: 0, reason: "wrong-language", sourceChars: 13, targetChars: 3, sourceHasCjk: false, targetHasCjk: false, sourceLineCount: 1, sourceWordCount: 1, isListItem: true, isHeading: false, text: "W2-SEGMENT-TEXT-SENTINEL", source: "W2-SOURCE-SENTINEL"},
			{index: 1, reason: "made-up-reason", sourceChars: -4, targetChars: "9", sourceHasCjk: "yes", targetHasCjk: null, sourceLineCount: 2.7, sourceWordCount: 3, isListItem: 1, isHeading: true}
		],
		structureDiagnostics: {expectedItemCount: 61, receivedItemCount: 60, missingMarkerIndices: [60, "x", 4.5], duplicateMarkerIndices: [], unknownMarkerCount: 0, wrappedInCodeFence: true, leadingChars: 0, trailingChars: 0, orderPreserved: true, terminalMarkerPresent: false, responseChars: 900, responseHasCjk: true, marker: "⟦W0⟧", response: "W2-RESPONSE-SENTINEL"}
	});
	assert.equal(record.orderId, 7, "subset schedules may exceed six balanced orders");
	assert.equal(record.segmentDiagnostics.length, 2);
	assert.deepEqual(record.segmentDiagnostics[0], {index: 0, reason: "wrong-language", sourceChars: 13, targetChars: 3, sourceHasCjk: false, targetHasCjk: false, sourceLineCount: 1, sourceWordCount: 1, isListItem: true, isHeading: false});
	assert.deepEqual(record.segmentDiagnostics[1], {index: 1, reason: "unknown", sourceChars: 0, targetChars: null, sourceHasCjk: false, targetHasCjk: null, sourceLineCount: 2, sourceWordCount: 3, isListItem: false, isHeading: true});
	assert.deepEqual(record.structureDiagnostics, {expectedItemCount: 61, receivedItemCount: 60, missingMarkerIndices: [60], duplicateMarkerIndices: [], unknownMarkerCount: 0, wrappedInCodeFence: true, leadingChars: 0, trailingChars: 0, orderPreserved: true, terminalMarkerPresent: false, terminalMarkerLast: null, outsideMarkerChars: null, closeMarkerEchoes: null, strayMarkerChars: null, windowed: null, contextChars: null, contextCoveragePermille: null, firstPassValid: null, repairRequested: false, repairValid: null, repairReason: null, repairProviderMs: null, repairPromptTokens: null, repairCompletionTokens: null, responseChars: 900, responseHasCjk: true});
	assert.equal(sanitizeSegmentDiagnostics(oversized).length, MAX_SEGMENT_DIAGNOSTICS);
	assert.deepEqual(sanitizeSegmentDiagnostics(null), []);
	assert.equal(sanitizeStructureDiagnostics(null), null);
	assert.equal(sanitizeStructureDiagnostics("text"), null);
	const plain = store.recordW2Trial(token, {trialId: 1, arm: "typed-json", status: "failed", valid: false, reason: "network"});
	assert.deepEqual(plain.segmentDiagnostics, []);
	assert.equal(plain.structureDiagnostics, null);
	const serialized = JSON.stringify(store.getW2Snapshot());
	for (const secret of ["SENTINEL", "⟦", "made-up-reason"]) assert.equal(serialized.includes(secret), false, secret);
});

test("W2b-0 store marks a planned subset complete without ever readying the three-arm gate", () => {
	const store = createW2WireBenchmarkStore();
	const token = store.beginW2Session({plannedArms: ["typed-json", "compact-marker"], plannedSamplesPerArm: 2, plannedWarmupCount: 2, plannedLogicalRequests: 6, plannedPhysicalRequests: 6});
	let id = 0;
	for (const arm of ["typed-json", "compact-marker"]) store.recordW2Trial(token, {trialId: id++, arm, warmup: true, status: "ok", valid: true, providerMs: 1, usage: {promptTokens: 1, completionTokens: 1, reasoningTokens: 0}});
	for (let sample = 0; sample < 2; sample++) for (const arm of ["typed-json", "compact-marker"]) store.recordW2Trial(token, {trialId: id++, arm, status: "ok", valid: true, protectedIntegrity: "pass", providerMs: 1, usage: {promptTokens: 1, completionTokens: 1, reasoningTokens: 0}});
	const finished = store.finishW2Session(token);
	assert.equal(finished.status, "complete");
	assert.equal(finished.planComplete, true);
	assert.equal(finished.arms["compact-order"].sampleCount, 0);
	assert.equal(finished.gate.ready, false);
	assert.equal(finished.gate.passed, false);
	assert.equal(finished.gate.reason, "not-ready");
});

test("W2b-0 orchestrator runs an arm/fixture subset serially and records diagnostics on every measured trial", async () => {
	const harness = createProviderHarness(request => request.arm === "Bm" && /f06|27A2D7B7/.test(request.sourceIdentity) ? goodResponse(request).replace(/\n⟦W\d+⟧$/, "") : goodResponse(request));
	const events = [];
	const benchmark = createW2WireBenchmark({providerClient: harness.providerClient, observationStore: {recordW2BenchmarkEvent: event => events.push(event)}});
	const preview = benchmark.prepare("fixture-ai", {arms: ["A", "Bm"], fixtureIds: SUBSET_FIXTURES, samplesPerFixture: 6});
	assert.equal(preview.ok, true);
	assert.deepEqual(preview.arms, ["A", "Bm"]);
	assert.deepEqual(preview.fixtureIds, SUBSET_FIXTURES);
	assert.equal(preview.samplesPerFixture, 6);
	assert.equal(preview.fixtureCount, 5);
	assert.equal(preview.warmupRequests, 2);
	assert.equal(preview.measuredRequests, 60);
	assert.equal(preview.samplesPerArm, 30);
	assert.equal(preview.maxRequests, 62);
	assert.equal(preview.maxPhysicalRequests, 62);
	assert.equal(preview.hardRequestCap, W2_MAX_REQUESTS);
	assert.equal(preview.hardOutputTokenCap, 62 * preview.maxOutputTokensPerRequest);
	const full = benchmark.prepare("fixture-ai");
	assert.notEqual(full.previewId, preview.previewId, "the subset changes the preview identity");
	assert.equal(full.maxRequests, 165);
	const again = benchmark.prepare("fixture-ai", {arms: ["A", "Bm"], fixtureIds: SUBSET_FIXTURES, samplesPerFixture: 6});
	const result = await benchmark.run(benchmark.confirm(again.previewId));
	assert.equal(result.status, "complete");
	assert.equal(result.completedRequests, 62);
	assert.equal(result.maxRequests, 62);
	assert.equal(harness.calls.length, 62);
	assert.equal(result.arms.A.planned, 30);
	assert.equal(result.arms.A.attempted, 30);
	assert.equal(result.arms.A.succeeded, 30);
	assert.equal(result.arms.Bm.planned, 30);
	assert.equal(result.arms.Bm.succeeded, 24);
	assert.equal(result.arms.Bm.failed, 6);
	assert.equal(result.arms.Ba.planned, 0);
	assert.equal(result.arms.Ba.attempted, 0);
	assert.equal(result.gateReady, false, "a subset never readies the frozen three-arm gate");
	assert.equal(events.length, 62);
	const measured = events.filter(event => !event.warmup);
	assert.equal(measured.every(event => Array.isArray(event.segmentDiagnostics) && event.segmentDiagnostics.length > 0), true);
	assert.equal(measured.every(event => event.structureDiagnostics && typeof event.structureDiagnostics.expectedItemCount === "number"), true);
	const broken = measured.filter(event => event.reason === "missing-terminal-marker");
	assert.equal(broken.length, 6);
	assert.equal(broken.every(event => event.structureDiagnostics.terminalMarkerPresent === false), true);
	const exported = JSON.stringify(events);
	for (const forbidden of ["⟦", "Undergraduate", "Longma", "systemPrompt", "userPrompt", "apple"]) assert.equal(exported.includes(forbidden), false, forbidden);
	assert.equal(benchmark.prepare("fixture-ai", {arms: ["Q"]}).reason, "arm");
	assert.equal(benchmark.prepare("fixture-ai", {samplesPerFixture: 7}).reason, "request-budget");
});
