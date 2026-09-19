const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const {createProtectionLogic, MESSAGE_PLACES} = require("../../src/protection/protection-logic");
const {planReceivedMarkdown} = require("../../src/planner/received-markdown-lossless-planner");
const {buildSafeContext} = require("../../src/planner/translation-compact-wire");
const {compileTypedPlan} = require("../../src/planner/translation-plan-serializer");
const {W2_MEASURED_FIXTURES, W2B_EXTRA_FIXTURES, W2B_FIXTURE_REVISION, W2B_FIXTURE_MANIFEST_SHA256, W2_ALL_FIXTURES} = require("../../src/diagnostics/w2-wire-benchmark-fixtures");
const {
	WHOLE_MARKER_VERSION,
	WHOLE_MARKER_PROMPT_VERSION,
	WHOLE_MARKER_CONTRACT_REVISION,
	WHOLE_MARKER_REASONS,
	REPAIRABLE_REASONS,
	WINDOW_MIN_SOURCE_CHARS,
	WINDOW_MAX_COVERAGE,
	WINDOW_NEIGHBOR_MAX_CHARS,
	buildWholeMarkerRequest,
	buildWholeMarkerRepairRequest,
	parseWholeMarkerResponse,
	mergeWholeMarkerRepair,
	reassembleWholeMarkerResponse
} = require("../../src/planner/translation-whole-marker-wire");

const OPEN = /⟪(\d+)⟫/g;
const ANY_MARKER_CHAR = /[⟪⟫]/;
const TOKEN = /⟦(?:[CW])?\d+⟧/g;
const NEWLINES = /\r\n|\r|\n/g;

function likelyTarget(value) {return /[\p{Script=Han}\p{Script=Bopomofo}]/u.test(String(value || ""));}
function similarity(source, target) {return String(source || "").trim() === String(target || "").trim() ? 1 : 0;}
const VALIDATE = {likelyTarget, similarity, maxSimilarity: 0.94};

function prepare(fixture) {
	const settings = {wordStart: ["!"], protectedTerms: [...(fixture.protectedTerms || [])], wrapperPairs: [...(fixture.wrapperPairs || [])], protectedTermsForReceived: true, wrapperPairsForReceived: true};
	const plugin = {settings: {exceptions: settings}, getProtectedWrapperRules() {return settings.wrapperPairs.map(value => {const [left, right] = String(value).split("|"); return {left, right};}).filter(row => row.left && row.right);}};
	const logic = createProtectionLogic();
	const protectedSource = logic.prepareSemanticSource(plugin, fixture.source, MESSAGE_PLACES.RECEIVED);
	const plan = planReceivedMarkdown(protectedSource.source, {direction: "received", fieldPath: "body", targetLanguageId: fixture.targetLanguageId});
	return {plugin, logic, protectedSource, plan, protectedSegments: protectedSource.protectedSegments || {}};
}

function chineseFor(range, index) {
	const text = range.text;
	if (/apple/i.test(text)) return "苹果是红色的。";
	if (/ocean/i.test(text)) return "海洋是蓝色的。";
	if (/bird/i.test(text)) return "鸟可以飞翔。";
	if (/moon/i.test(text)) return "月亮很明亮。";
	const tokens = range.tokens.length ? ` ${range.tokens.join("")}` : "";
	return `这是第${index + 1}段合成译文${tokens}。`;
}

function goodLines(request) {return request.ranges.map((range, index) => `⟪${range.ordinal}⟫${chineseFor(range, index)}`);}
function goodResponse(request, mutate = null) {
	const lines = goodLines(request);
	return typeof mutate === "function" ? mutate(lines, request).join("\n") : lines.join("\n");
}

function seededRandom(seed) {
	let state = seed >>> 0 || 1;
	return () => {state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296;};
}

function restore(prepared, request, valid) {
	return prepared.logic.addSemanticExceptions(prepared.plugin, reassembleWholeMarkerResponse(request, valid), prepared.protectedSegments);
}

test("W2c D compiles every fixture with open markers only and keeps the safe-context text", () => {
	assert.equal(WHOLE_MARKER_VERSION, "whole-marker-v2");
	assert.equal(W2_ALL_FIXTURES.length, 13);
	for (const fixture of W2_ALL_FIXTURES) {
		const prepared = prepare(fixture);
		const request = buildWholeMarkerRequest(prepared.plan, prepared.protectedSegments, {targetLanguageId: fixture.targetLanguageId});
		assert.equal(request.ok, true, `${fixture.id}: ${request.reason}`);
		assert.equal(request.wireFamily, "whole-marker");
		assert.equal(request.adapter, WHOLE_MARKER_VERSION);
		assert.ok(request.ranges.length > 0, `${fixture.id} has ranges`);
		assert.equal(request.segmentCount, request.ranges.length);
		assert.equal(request.totalRangeCount, request.ranges.length);
		assert.deepEqual(request.ranges.map(row => row.ordinal), request.ranges.map((_, index) => index + 1), "ordinals are 1..N in document order");
		const opens = [...request.wire.matchAll(OPEN)].map(match => Number(match[1]));
		assert.deepEqual(opens, request.ranges.map(row => row.ordinal), `${fixture.id} opens once each`);
		assert.doesNotMatch(request.wire, /⟪\//, `${fixture.id}: no close markers on the wire`);
		assert.equal(request.wire.replace(OPEN, "").split("").filter(char => ANY_MARKER_CHAR.test(char)).length, 0, "no marker character outside the open markers");
		const safe = buildSafeContext(prepared.plan, prepared.protectedSegments, {rawSourceBytes: Buffer.byteLength(fixture.source)});
		assert.equal(safe.ok, true);
		if (!request.windowed) {
			// Inserted line breaks after mid-line range ends are the only difference to the W1 safe context.
			assert.equal(request.wire.replace(OPEN, "").replace(NEWLINES, ""), safe.value.replace(NEWLINES, ""), `${fixture.id}: the D document is the safe context plus markers`);
			assert.equal(request.contextChars, request.fullWireChars);
			assert.equal(request.contextCoverage, 1);
		}
		for (const range of request.ranges) {
			assert.equal(range.text.trim(), range.text, "ranges carry no edge whitespace");
			assert.doesNotMatch(range.text, /^\s*(?:\d{1,3}|[A-Za-z])[.)]\s/, "label prefixes stay outside the marker");
			assert.match(range.text.replace(TOKEN, ""), /\p{L}/u, "every range still has natural language after tokens are removed");
			const slice = prepared.plan.source.slice(range.sourceStart, range.sourceEnd);
			let rebuilt = "", cursor = 0;
			for (const token of range.tokens) {
				const marker = request.contextMarkers.find(row => row.token === token);
				if (!marker) continue;
				const at = slice.indexOf(marker.raw, cursor);
				assert.ok(at >= 0, `${fixture.id} range ${range.ordinal} lost the leaf behind ${token}`);
				rebuilt += slice.slice(cursor, at) + token;
				cursor = at + marker.raw.length;
			}
			rebuilt += slice.slice(cursor);
			assert.equal(rebuilt, range.text, `${fixture.id} range ${range.ordinal} maps back onto its source span`);
			assert.deepEqual(range.tokens, [...range.text.matchAll(TOKEN)].map(match => match[0]));
			// A range runs from its marker to the next marker or the end of its wire line.
			const at = request.wire.indexOf(`⟪${range.ordinal}⟫`) + `⟪${range.ordinal}⟫`.length;
			const rest = request.wire.slice(at), stop = rest.search(/⟪\d+⟫|\r\n|\r|\n/), lineText = stop < 0 ? rest : rest.slice(0, stop);
			assert.equal(lineText.trim(), range.text, `${fixture.id} range ${range.ordinal} occupies its wire line up to the next marker`);
		}
		const protectedValues = [...Object.values(prepared.protectedSegments), ...request.contextMarkers.map(row => row.raw)];
		for (const value of protectedValues) assert.equal(request.wire.includes(value), false, `${fixture.id} leaks ${JSON.stringify(value).slice(0, 30)}`);
		assert.doesNotMatch(request.wire, /m3i-v\d|\|received\|/, "no planner ids leave the machine");
		assert.doesNotMatch(request.systemPrompt, /m3i|schema|segments|contexts|⟪\//i);
		assert.ok(request.systemPromptBytes <= 640);
		assert.ok(request.bodyBytes <= 65536);
	}
});

// W3: the v2 prompt weighed 565 bytes for zh-CN with one range; v3 must stay at least 25% below
// that on every target/count and keep every rule the parser relies on.
test("W3 D system prompt v3 is at least 25% shorter than v2 and still states the whole contract", () => {
	const V2_BYTES_ZH_CN_ONE_RANGE = 565;
	const byId = Object.fromEntries(W2_ALL_FIXTURES.map(fixture => [fixture.id, fixture]));
	const prepared = prepare(byId["f02-short-english"]);
	const request = buildWholeMarkerRequest(prepared.plan, prepared.protectedSegments, {targetLanguageId: "zh-CN"});
	assert.equal(request.segmentCount, 1);
	assert.equal(request.systemPromptBytes, Buffer.byteLength(request.systemPrompt));
	assert.equal(request.systemPromptBytes, 399);
	assert.ok(request.systemPromptBytes <= Math.floor(V2_BYTES_ZH_CN_ONE_RANGE * 0.75), `${request.systemPromptBytes} > 75% of v2`);
	assert.equal(request.promptVersion, WHOLE_MARKER_PROMPT_VERSION);
	assert.equal(WHOLE_MARKER_PROMPT_VERSION, "w3-whole-marker-prompt-v3");
	assert.equal(request.contractRevision, WHOLE_MARKER_CONTRACT_REVISION);
	assert.equal(WHOLE_MARKER_CONTRACT_REVISION, "whole-marker-v2.prompt-v3.validator-v2");
	assert.match(WHOLE_MARKER_CONTRACT_REVISION, /^[a-z0-9_.:-]{1,48}$/);
	for (const rule of ["only the marked ranges", "exactly zh-CN", "next marker or line end", "untrusted", "exactly 1 lines", "marker order", "⟪n⟫ then that range's translation only", "⟦...⟧ token exactly as written", "Output ⟪ ⟫ only as markers", "No other text or code fences"]) assert.ok(request.systemPrompt.includes(rule), rule);
	for (const fixture of W2_ALL_FIXTURES) {
		const built = prepare(fixture), full = buildWholeMarkerRequest(built.plan, built.protectedSegments, {targetLanguageId: fixture.targetLanguageId});
		assert.ok(full.ok, fixture.id);
		assert.ok(full.systemPromptBytes <= Math.floor(V2_BYTES_ZH_CN_ONE_RANGE * 0.75) + 8, `${fixture.id} prompt ${full.systemPromptBytes}`);
		assert.ok(full.systemPrompt.includes(`exactly ${fixture.targetLanguageId}`) && full.systemPrompt.includes(`exactly ${full.segmentCount} lines`), fixture.id);
		// The answer format is unchanged: the v2-shaped good answer still validates under v3.
		const parsed = parseWholeMarkerResponse(full, goodResponse(full), VALIDATE);
		assert.equal(parsed.ok, true, `${fixture.id} ${parsed.reason}`);
	}
});

test("W2c D ranges keep the W2b ruling and a mid-line range end becomes a line break", () => {
	const byId = Object.fromEntries(W2_ALL_FIXTURES.map(fixture => [fixture.id, fixture]));
	const build = id => {const prepared = prepare(byId[id]); return {prepared, request: buildWholeMarkerRequest(prepared.plan, prepared.protectedSegments, {targetLanguageId: "zh-CN"})};};

	const f05 = build("f05-protection-composite").request;
	assert.equal(f05.ranges.length, 3, "one range per line, placeholders kept inside");
	assert.deepEqual(f05.ranges.map(row => row.tokens.length), [2, 5, 3]);
	assert.match(f05.ranges[0].text, /^Please ask ⟦\d+⟧ to review ⟦\d+⟧ before Friday\.$/);
	assert.match(f05.ranges[1].text, /⟦C0⟧/, "the inline code leaf travels as a local context token inside the sentence");
	assert.equal(f05.insertedBreaks, 0);

	const f01 = build("f01-exact-academic").request;
	assert.equal(f01.ranges.length, 61);
	assert.equal(f01.ranges[0].text, "Degree of Interest", "the heading label 1. stays outside");
	assert.equal(f01.ranges[0].kind, "heading");
	assert.equal(f01.ranges[1].text, "Undergraduate");
	assert.equal(f01.ranges[1].kind, "list");
	assert.match(f01.wire, /### 1\. ⟪1⟫Degree of Interest\n/);
	assert.match(f01.wire, /- A\. ⟪2⟫Undergraduate\n/);
	assert.match(f01.wire, /### 5\. ⟪\d+⟫Mailing Address\n 是否为 ⟪\d+⟫Permanent Address\n/, "Chinese text after a range moves to the next wire line so the range ends at its line");
	assert.doesNotMatch(f01.wire, /⟪\d+⟫[^⟪\n]*其他/, "Chinese list items are not marked");
	assert.match(f01.wire, /### 6\. ⟦C0⟧问题\n/, "a Chinese heading with a protected leaf is left unmarked");
	assert.equal(f01.windowed, false, "57% coverage stays whole");

	const f06 = build("f06-markdown-structure").request;
	assert.equal(f06.ranges.length, 11);
	assert.match(f06.wire, /^## ⟪1⟫Synthetic release notes\n\n> ⟪2⟫Translate the explanation but keep the structure\.\n\n- ⟪3⟫First checklist item\n- ⟪4⟫Second checklist item with\n \|\|⟪5⟫spoiler text\n\|\|/);
	assert.match(f06.wire, /\| ⟪6⟫Field\n \| ⟪7⟫Value\n \|\n\| --- \| --- \|\n/);
	assert.match(f06.wire, /\[⟪10⟫Read the synthetic guide\n\]\(⟦1⟧\)\n\n⟦0⟧\n\n⟪11⟫The fenced code/);
	assert.equal(f06.ranges[1].kind, "quote");
	assert.equal(f06.ranges[5].kind, "table");

	const f07 = build("f07-academic-technical").request;
	assert.equal(f07.ranges.length, 2);
	assert.equal(f07.ranges[1].tokens.length, 5);

	const f09 = build("f09-unicode-lines").request;
	assert.equal(f09.ranges.length, 3);
	assert.match(f09.wire, /⟪1⟫First synthetic line uses ⟦1⟧ and emoji ⟦C0⟧\.\r\n⟪2⟫/);

	const f10 = build("f10-markdown-protected-mixed").request;
	assert.match(f10.wire, /^### 3\. ⟪1⟫Deployment Notes for ⟦\d+⟧\n> ⟪2⟫Ask ⟦\d+⟧ to run ⟦\d+⟧ before 18:00 and keep ⟦\d+⟧ unchanged\.\n- A\. ⟪3⟫Send the report to ⟦\d+⟧ today\.\n- B\. 请勿修改 ⟦\d+⟧ 链接。\n- C\. ⟪4⟫Connect to ⟦\d+⟧ first, then open the dashboard\.\n报名前请注意：⟪5⟫Read the FAQ first\. ⟪6⟫Then submit the form\.\n 谢谢配合。\n\*\*⟪7⟫Important\n\*\*⟪8⟫: the ⟦C0⟧ script must stay unchanged\.$/);
	assert.equal(f10.ranges.length, 8);
	assert.equal(f10.insertedBreaks, 2);

	const f11 = build("f11-inline-placeholders-tail").request;
	assert.equal(f11.ranges.length, 2, "a sentence with three placeholders and a short tail stays one range");
	assert.equal(f11.ranges[0].tokens.length, 3);

	const f12 = build("f12-trailing-punctuation-emoji").request;
	assert.equal(f12.ranges.length, 3);
	assert.match(f12.wire, /⟪1⟫Release is ready!!!\n\n\n⟪2⟫Thanks to everyone ⟦C0⟧⟦C1⟧\n⟪3⟫See you tomorrow\.\.\.   \n$/, "each emoji is its own protected leaf and both travel inside the range");

	const typed = compileTypedPlan(build("f01-exact-academic").prepared.plan);
	assert.ok(f01.bodyBytes < typed.bodyBytes / 2, `D body ${f01.bodyBytes} must be far below typed ${typed.bodyBytes}`);
});

test("W2c D windows the context when ranges cover little of a long message", () => {
	assert.equal(WINDOW_MIN_SOURCE_CHARS, 600);
	assert.equal(WINDOW_MAX_COVERAGE, 0.4);
	const byId = Object.fromEntries(W2_ALL_FIXTURES.map(fixture => [fixture.id, fixture]));
	const build = id => {const prepared = prepare(byId[id]); return {prepared, request: buildWholeMarkerRequest(prepared.plan, prepared.protectedSegments, {targetLanguageId: "zh-CN"})};};

	const f04 = build("f04-target-body-title");
	assert.equal(f04.request.windowed, true, "1131 chars, one 38-char title range");
	assert.ok(f04.request.translateCoverage < WINDOW_MAX_COVERAGE);
	assert.ok(f04.request.sourceChars > WINDOW_MIN_SOURCE_CHARS);
	const f04Lines = f04.request.wire.split("\n");
	assert.equal(f04Lines.length, 2, "one clipped neighbour line and the range line");
	assert.match(f04Lines[1], /^⟪1⟫Financial Aid Application Requirements$/, "the range line is kept whole");
	assert.equal(f04Lines[0].startsWith("…"), true, "the long Chinese paragraph before it is clipped at its tail");
	assert.ok(Array.from(f04Lines[0]).length <= WINDOW_NEIGHBOR_MAX_CHARS + 1);
	assert.ok(f04.request.contextChars < f04.request.fullWireChars * 0.3, `f04 sends ${f04.request.contextChars} of ${f04.request.fullWireChars} chars`);
	assert.ok(f04.request.contextCoverage < 0.3);
	const f04Restored = restore(f04.prepared, f04.request, {1: "合成标题译文"});
	assert.equal(f04Restored, byId["f04-target-body-title"].source.replace(f04.request.ranges[0].text, "合成标题译文"), "windowing changes the wire only; reassembly still uses the whole source");

	const f13 = build("f13-long-chinese-one-english");
	assert.equal(f13.request.ranges.length, 1);
	assert.equal(f13.request.ranges[0].text, "Please confirm the shipping address before Friday.");
	assert.equal(f13.request.windowed, true);
	assert.deepEqual(f13.request.wire.split("\n"), ["…", "", "⟪1⟫Please confirm the shipping address before Friday.", "", "…"], "the range line, its empty neighbours and one ellipsis per omitted stretch");
	assert.ok(f13.request.contextChars < 60);
	assert.ok(f13.request.bodyBytes < 200);
	for (const literal of byId["f13-long-chinese-one-english"].preserveLiterals) assert.equal(f13.request.wire.includes(literal), false, `${literal} stays home`);
	const restored = restore(f13.prepared, f13.request, {1: "请在周五前确认收货地址。"});
	for (const literal of byId["f13-long-chinese-one-english"].preserveLiterals) assert.equal(restored.includes(literal), true, literal);
	assert.equal(restored.includes("请在周五前确认收货地址。"), true);
	assert.equal(restored.split("\n").length, 13);

	for (const id of ["f01-exact-academic", "f02-short-english", "f03-long-english", "f05-protection-composite", "f06-markdown-structure", "f07-academic-technical", "f08-order-oracle", "f09-unicode-lines", "f10-markdown-protected-mixed", "f11-inline-placeholders-tail", "f12-trailing-punctuation-emoji"]) {
		const request = build(id).request;
		assert.equal(request.windowed, false, `${id} stays whole`);
		assert.equal(request.wire.includes("\n…"), false);
	}
	// Merged windows: two marked lines two lines apart share one window without an inner ellipsis.
	const twoRanges = planReceivedMarkdown(`${"中文段落。".repeat(70)}\nFirst English sentence here.\n中文一行。\nSecond English sentence here.\n${"更多中文。".repeat(70)}`, {direction: "received", fieldPath: "body", targetLanguageId: "zh-CN"});
	const merged = buildWholeMarkerRequest(twoRanges, {}, {targetLanguageId: "zh-CN"});
	assert.equal(merged.ok, true);
	assert.equal(merged.windowed, true);
	const mergedLines = merged.wire.split("\n");
	assert.equal(mergedLines.filter(line => line === "…").length, 0, "neighbour lines cover the whole message here");
	assert.equal(mergedLines.length, 5);
	assert.equal(mergedLines[0].startsWith("…"), true, "the long first paragraph is clipped at its tail");
	assert.equal(mergedLines[4].endsWith("…"), true, "the long last paragraph is clipped at its head");
	assert.equal(mergedLines[1], "⟪1⟫First English sentence here.");
	assert.equal(mergedLines[2], "中文一行。");
	assert.equal(mergedLines[3], "⟪2⟫Second English sentence here.");
});

test("W2c D compile fails closed on marker collisions, lookalikes and budgets", () => {
	const collide = planReceivedMarkdown("Hello ⟪1⟫ world", {direction: "received", fieldPath: "body", targetLanguageId: "zh-CN"});
	assert.equal(buildWholeMarkerRequest(collide, {}).reason, "marker-collision");
	const lookalike = planReceivedMarkdown("Hello ⟦C0⟧ world", {direction: "received", fieldPath: "body", targetLanguageId: "zh-CN"});
	assert.equal(buildWholeMarkerRequest(lookalike, {}).reason, "marker-collision");
	const closeLookalike = planReceivedMarkdown("Hello ⟪/3⟫ world", {direction: "received", fieldPath: "body", targetLanguageId: "zh-CN"});
	assert.equal(buildWholeMarkerRequest(closeLookalike, {}).reason, "marker-collision");
	const strayChar = planReceivedMarkdown("Hello ⟫ world", {direction: "received", fieldPath: "body", targetLanguageId: "zh-CN"});
	assert.equal(buildWholeMarkerRequest(strayChar, {}).reason, "marker-collision", "a lone marker character in the source still fails closed, so stray characters in an answer are never source text");
	const chinese = planReceivedMarkdown("这里只有中文。", {direction: "received", fieldPath: "body", targetLanguageId: "zh-CN"});
	assert.equal(buildWholeMarkerRequest(chinese, {}).reason, "no-segments");
	const long = planReceivedMarkdown("Translate me. ".repeat(6000), {direction: "received", fieldPath: "body", targetLanguageId: "zh-CN"});
	assert.equal(buildWholeMarkerRequest(long, {}, {maxBodyBytes: 65536}).reason, "body-budget");
	assert.equal(buildWholeMarkerRequest(null, {}).reason, "invalid-plan");
});

test("W2c D parser strips marker noise, keeps fail-closed structure rules and marks repairable failures", () => {
	const fixture = W2_ALL_FIXTURES.find(row => row.id === "f05-protection-composite");
	const prepared = prepare(fixture);
	const request = buildWholeMarkerRequest(prepared.plan, prepared.protectedSegments, {targetLanguageId: "zh-CN"});
	const clean = goodResponse(request);
	const parsed = parseWholeMarkerResponse(request, clean, VALIDATE);
	assert.equal(parsed.ok, true, parsed.reason);
	assert.equal(parsed.rows.length, 3);
	assert.equal(parsed.repairable, false);
	assert.deepEqual(parsed.repairOrdinals, []);
	assert.equal(parsed.structure.expectedItemCount, 3);
	assert.equal(parsed.structure.receivedItemCount, 3);
	assert.equal(parsed.structure.orderPreserved, true);
	assert.equal(parsed.structure.trailingChars, 0);
	assert.equal(parsed.structure.outsideMarkerChars, 0);
	assert.equal(parsed.structure.strayMarkerChars, 0);
	assert.equal(parsed.structure.closeMarkerEchoes, 0);
	const masked = reassembleWholeMarkerResponse(request, parsed.valid);
	assert.doesNotMatch(masked, /⟪|⟦C\d+⟧/, "context tokens are restored locally");
	assert.match(masked, /`const flag = true;`/);
	const restored = prepared.logic.addSemanticExceptions(prepared.plugin, masked, prepared.protectedSegments);
	for (const literal of fixture.preserveLiterals) assert.equal(restored.includes(literal), true, literal);
	assert.equal(restored.split(/\r\n|\r|\n/).length, 3, "line structure survives");

	const expect = (response, reason, extra = null) => {
		const result = parseWholeMarkerResponse(request, response, VALIDATE);
		assert.equal(result.ok, false, `${reason}: unexpectedly ok`);
		assert.equal(result.reason, reason);
		assert.equal(WHOLE_MARKER_REASONS.includes(result.reason), true);
		if (extra) extra(result);
		return result;
	};
	// Repairable: the envelope was sound, ranges are missing or judged invalid.
	const missing = expect(goodResponse(request, lines => lines.slice(0, 2)), "missing-marker", result => assert.deepEqual(result.structure.missingMarkerIndices, [3]));
	assert.equal(missing.rootMalformed, false);
	assert.equal(missing.repairable, true);
	assert.deepEqual(missing.repairOrdinals, [3]);
	assert.deepEqual(Object.keys(missing.valid).map(Number), [1, 2], "the present ranges keep their translations");
	const mismatch = expect(goodResponse(request, lines => lines.map((line, index) => index === 1 ? line.replace(/⟦\d+⟧/, "") : line)), "placeholder-mismatch", result => assert.equal(result.invalid[0].ordinal, 2));
	assert.equal(mismatch.repairable, true);
	assert.deepEqual(mismatch.repairOrdinals, [2]);
	expect(goodResponse(request, lines => lines.map((line, index) => index === 2 ? `${line}⟦0⟧` : line)), "placeholder-mismatch");
	const english = expect(goodResponse(request, lines => lines.map((line, index) => index === 0 ? `⟪1⟫Please ask ${request.ranges[0].tokens.join(" to review ")} before Friday.` : line)), "wrong-language", result => assert.deepEqual(result.invalid.map(row => row.ordinal), [1]));
	assert.equal(english.repairable, true);
	expect(goodResponse(request, lines => lines.map((line, index) => index === 0 ? "⟪1⟫" : line)), "empty", result => assert.equal(result.repairable, true));
	const missingAndBad = expect(goodResponse(request, lines => [lines[0], lines[1].replace(/⟦\d+⟧/, "")]), "missing-marker");
	assert.deepEqual(missingAndBad.repairOrdinals, [2, 3]);
	// Fail-closed: unknown, duplicate, out of order, fence, leading text, unmarked text between blocks.
	for (const [response, reason, check] of [
		[goodResponse(request, lines => [...lines, lines[1]]), "duplicate-marker", result => assert.deepEqual(result.structure.duplicateMarkerIndices, [2])],
		[goodResponse(request, lines => [lines[1], lines[0], lines[2]]), "marker-order", result => assert.equal(result.structure.orderPreserved, false)],
		[goodResponse(request, lines => [...lines, "⟪9⟫多余"]), "unknown-marker", result => assert.equal(result.structure.unknownMarkerCount, 1)],
		["Here you go:\n" + clean, "marker-schema", result => assert.equal(result.structure.leadingChars, 13)],
		["```\n" + clean + "\n```", "markdown-fence", result => assert.equal(result.structure.wrappedInCodeFence, true)],
		[clean + "\nThat is all.", "unsafe-structure", result => assert.equal(result.structure.trailingChars, 12)],
		[clean + "\n。。。。", "unsafe-structure", result => assert.equal(result.structure.trailingChars, 4)],
		[goodResponse(request, lines => [lines[0], lines[1] + "\nextra unmarked line", lines[2]]), "unsafe-structure", result => assert.equal(result.structure.outsideMarkerChars, 19)],
		["", "marker-schema", null],
		["   \n", "marker-schema", null]
	]) {
		const result = expect(response, reason, check);
		assert.equal(result.rootMalformed, true, `${reason} is fail-closed`);
		assert.equal(result.repairable, false, `${reason} is not repairable`);
	}
	assert.equal(parseWholeMarkerResponse(request, 42, VALIDATE).reason, "unexpected-root");
	assert.equal(parseWholeMarkerResponse(request, "x".repeat(70000), VALIDATE).reason, "response-budget");

	const tolerated = parseWholeMarkerResponse(request, clean + "\n。", VALIDATE);
	assert.equal(tolerated.ok, true, "up to three trailing punctuation characters are allowed");
	assert.equal(tolerated.structure.trailingChars, 1);
	// Ruling 1: close-marker echoes and stray marker characters are noise, stripped and counted.
	const echoed = parseWholeMarkerResponse(request, goodResponse(request, lines => lines.map((line, index) => `${line}⟪/${index + 1}⟫`)), VALIDATE);
	assert.equal(echoed.ok, true, "a close marker echo is stripped, not punished");
	assert.equal(echoed.structure.closeMarkerEchoes, 3);
	assert.equal(echoed.structure.strayMarkerChars, 0);
	assert.deepEqual(Object.values(echoed.valid).map(value => value.includes("⟪")), [false, false, false]);
	const wrongEcho = parseWholeMarkerResponse(request, goodResponse(request, lines => lines.map((line, index) => `${line}⟪/${index + 2}⟫`)), VALIDATE);
	assert.equal(wrongEcho.ok, true, "a mismatched close marker is still just noise");
	assert.equal(wrongEcho.structure.closeMarkerEchoes, 3);
	const stray = parseWholeMarkerResponse(request, goodResponse(request, lines => lines.map((line, index) => index === 1 ? line.replace("。", "⟫。⟪") : line)), VALIDATE);
	assert.equal(stray.ok, true, "stray marker characters inside a translation are stripped");
	assert.equal(stray.structure.strayMarkerChars, 2);
	assert.equal(stray.valid[2].includes("⟫"), false);
	assert.equal(stray.valid[2].includes("⟪"), false);
	assert.equal(stray.valid[2].endsWith("。"), true);
	const crlf = parseWholeMarkerResponse(request, goodResponse(request).replace(/\n/g, "\r\n"), VALIDATE);
	assert.equal(crlf.ok, true, "CRLF responses are accepted");
	assert.deepEqual(REPAIRABLE_REASONS, ["missing-marker", "item-count", "empty", "placeholder-mismatch", "wrong-language", "too-similar"]);
});

test("W2c D builds one repair request for the failed ranges and merges its answer over the first", () => {
	const fixture = W2_ALL_FIXTURES.find(row => row.id === "f10-markdown-protected-mixed");
	const prepared = prepare(fixture);
	const request = buildWholeMarkerRequest(prepared.plan, prepared.protectedSegments, {targetLanguageId: "zh-CN"});
	assert.equal(request.ranges.length, 8);
	const first = parseWholeMarkerResponse(request, goodResponse(request, lines => lines.filter((_, index) => index !== 2 && index !== 5).map((line, index) => index === 2 ? line.replace(/⟦\d+⟧/, "") : line)), VALIDATE);
	assert.equal(first.ok, false);
	assert.equal(first.repairable, true);
	assert.deepEqual(first.repairOrdinals, [3, 4, 6], "two missing ranges and one placeholder mismatch on range 4");

	const repairRequest = buildWholeMarkerRepairRequest(request, first.repairOrdinals);
	assert.equal(repairRequest.ok, true, repairRequest.reason);
	assert.equal(repairRequest.adapter, WHOLE_MARKER_VERSION);
	assert.deepEqual(repairRequest.ranges.map(range => range.ordinal), [3, 4, 6], "only the failed ranges are marked, with their original ordinals");
	assert.deepEqual(repairRequest.repairOf.ordinals, [3, 4, 6]);
	assert.deepEqual([...repairRequest.wire.matchAll(OPEN)].map(match => Number(match[1])), [3, 4, 6]);
	assert.equal(repairRequest.windowed, request.windowed, "same window mode as the first request");
	assert.equal(repairRequest.wire.includes("Send the report to"), true, "unmarked ranges stay as plain context");
	assert.equal(repairRequest.wire.includes("⟪1⟫"), false);
	assert.match(repairRequest.systemPrompt, /exactly 3 lines/);
	for (const value of [...Object.values(prepared.protectedSegments), ...request.contextMarkers.map(row => row.raw)]) assert.equal(repairRequest.wire.includes(value), false);

	const repair = parseWholeMarkerResponse(repairRequest, goodResponse(repairRequest), VALIDATE);
	assert.equal(repair.ok, true, repair.reason);
	const merged = mergeWholeMarkerRepair(request, first, repairRequest, repair);
	assert.equal(merged.ok, true, merged.reason);
	assert.deepEqual(merged.repairedOrdinals, [3, 4, 6]);
	assert.deepEqual(Object.keys(merged.valid).map(Number).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8]);
	const restored = restore(prepared, request, merged.valid);
	for (const literal of fixture.preserveLiterals) assert.equal(restored.includes(literal), true, literal);
	assert.doesNotMatch(restored, /⟪|⟦(?:[CW])?\d+⟧/);
	assert.equal(restored.split("\n").length, fixture.source.split("\n").length);

	// A repair answer with an unknown ordinal is fail-closed; the merge keeps the first answer's valid ranges only.
	const badRepair = parseWholeMarkerResponse(repairRequest, `⟪1⟫错误的序号
${goodResponse(repairRequest)}`, VALIDATE);
	assert.equal(badRepair.rootMalformed, true);
	const badMerge = mergeWholeMarkerRepair(request, first, repairRequest, badRepair);
	assert.equal(badMerge.ok, false);
	assert.equal(badMerge.repairRootMalformed, true);
	assert.deepEqual(badMerge.invalid.map(row => row.ordinal), [3, 4, 6]);
	// A partial repair fills what it can; the rest stays invalid with the repair's verdict.
	const partial = parseWholeMarkerResponse(repairRequest, goodResponse(repairRequest, lines => lines.slice(0, 2)), VALIDATE);
	const partialMerge = mergeWholeMarkerRepair(request, first, repairRequest, partial);
	assert.equal(partialMerge.ok, false);
	assert.deepEqual(partialMerge.invalid, [{ordinal: 6, reason: "missing-marker"}]);
	assert.deepEqual(partialMerge.repairedOrdinals, [3, 4]);
	// The repair may not answer for ranges it was not built for.
	const overreach = parseWholeMarkerResponse(repairRequest, goodResponse(repairRequest), VALIDATE);
	const spoofed = Object.assign({}, overreach, {valid: Object.assign({}, overreach.valid, {1: "篡改"})});
	const guarded = mergeWholeMarkerRepair(request, first, repairRequest, spoofed);
	assert.equal(guarded.valid[1], first.valid[1]);

	assert.equal(buildWholeMarkerRepairRequest(request, [99]).reason, "invalid-request");
	assert.equal(buildWholeMarkerRepairRequest(request, []).reason, "invalid-request");
	assert.equal(buildWholeMarkerRepairRequest(null, [1]).reason, "invalid-request");

	// Windowed repair keeps the window mode.
	const f13 = W2_ALL_FIXTURES.find(row => row.id === "f13-long-chinese-one-english");
	const prepared13 = prepare(f13);
	const request13 = buildWholeMarkerRequest(prepared13.plan, prepared13.protectedSegments, {targetLanguageId: "zh-CN"});
	const repair13 = buildWholeMarkerRepairRequest(request13, [1]);
	assert.equal(repair13.windowed, true);
	assert.equal(repair13.wire, request13.wire);
});

test("W2c D fuzz: 10000 mutated responses never throw, never pass with a defect, and one repair recovers every repairable failure", () => {
	const random = seededRandom(20260903);
	const compiled = W2_ALL_FIXTURES.map(fixture => {const prepared = prepare(fixture); return {fixture, prepared, request: buildWholeMarkerRequest(prepared.plan, prepared.protectedSegments, {targetLanguageId: "zh-CN"})};});
	for (const row of compiled) assert.equal(row.request.ok, true, row.fixture.id);
	const pick = list => list[Math.floor(random() * list.length)];
	const mutations = ["none", "none", "drop", "duplicate", "swap", "unknown", "fence", "leading", "trailing-long", "trailing-short", "unmarked-line", "drop-token", "extra-token", "english", "renumber", "blank-lines", "crlf", "close-echo", "wrong-echo", "stray-chars"];
	const counts = {};
	let cleanOk = 0, repaired = 0;
	for (let iteration = 0; iteration < 10000; iteration++) {
		const {fixture, prepared, request} = pick(compiled);
		const mutation = pick(mutations);
		const lines = goodLines(request);
		const index = Math.floor(random() * lines.length);
		let response;
		switch (mutation) {
			case "drop": lines.splice(index, 1); response = lines.join("\n"); break;
			case "duplicate": lines.splice(index, 0, lines[index]); response = lines.join("\n"); break;
			case "swap": if (lines.length > 1) {const other = (index + 1) % lines.length; [lines[index], lines[other]] = [lines[other], lines[index]];} response = lines.join("\n"); break;
			case "unknown": lines.push(`⟪${lines.length + 1 + Math.floor(random() * 5)}⟫额外`); response = lines.join("\n"); break;
			case "fence": response = "```\n" + lines.join("\n") + "\n```"; break;
			case "leading": response = "Translation:\n" + lines.join("\n"); break;
			case "trailing-long": response = lines.join("\n") + "\n" + pick(["Done.", "。。。。", "----", "注：以上为译文"]); break;
			case "trailing-short": response = lines.join("\n") + pick(["\n", "\n。", " \n…", "\n.."]); break;
			case "unmarked-line": lines.splice(index + 1, 0, "这一行没有标记"); response = lines.join("\n"); break;
			case "drop-token": response = lines.map((line, at) => at === index ? line.replace(TOKEN, "") : line).join("\n"); break;
			case "extra-token": response = lines.map((line, at) => at === index ? `${line}⟦${Math.floor(random() * 9)}⟧` : line).join("\n"); break;
			case "english": response = lines.map((line, at) => at === index ? `⟪${request.ranges[at].ordinal}⟫${request.ranges[at].text}` : line).join("\n"); break;
			case "renumber": response = lines.map((line, at) => at === index ? line.replace(/^⟪\d+⟫/, `⟪${request.ranges[at].ordinal + 1}⟫`) : line).join("\n"); break;
			case "blank-lines": response = lines.join("\n\n"); break;
			case "crlf": response = lines.join("\r\n"); break;
			case "close-echo": response = lines.map((line, at) => `${line}⟪/${request.ranges[at].ordinal}⟫`).join("\n"); break;
			case "wrong-echo": response = lines.map((line, at) => `${line}⟪/${request.ranges[at].ordinal + 1}⟫`).join("\n"); break;
			case "stray-chars": response = lines.map((line, at) => at === index ? `${line.slice(0, -1)}${pick(["⟪", "⟫", "⟫⟪"])}${line.slice(-1)}` : line).join("\n"); break;
			default: response = lines.join("\n");
		}
		let result;
		assert.doesNotThrow(() => {result = parseWholeMarkerResponse(request, response, VALIDATE);}, `${fixture.id}/${mutation}`);
		assert.equal(Object.isFrozen(result), true);
		assert.equal(WHOLE_MARKER_REASONS.includes(result.reason) || result.reason === null, true, `${mutation}: ${result.reason}`);
		counts[mutation] = (counts[mutation] || 0) + 1;
		const selectedHasTokens = request.ranges[index].tokens.length > 0;
		const mustFail = ["drop", "duplicate", "unknown", "fence", "leading", "trailing-long", "unmarked-line", "english", "renumber"].includes(mutation)
			|| (mutation === "swap" && lines.length > 1)
			|| (mutation === "drop-token" && selectedHasTokens)
			|| mutation === "extra-token";
		const mustPass = ["none", "blank-lines", "crlf", "close-echo", "wrong-echo", "stray-chars", "trailing-short"].includes(mutation) || (mutation === "drop-token" && !selectedHasTokens);
		const repairable = (mutation === "drop" && lines.length > 0) || mutation === "english" || (mutation === "drop-token" && selectedHasTokens) || mutation === "extra-token";
		if (mustFail) {
			assert.equal(result.ok, false, `${fixture.id}/${mutation} must fail`);
			assert.equal(result.repairable, repairable, `${fixture.id}/${mutation}: repairable=${result.repairable}`);
			if (repairable) {
				const repairRequest = buildWholeMarkerRepairRequest(request, result.repairOrdinals);
				assert.equal(repairRequest.ok, true, `${fixture.id}/${mutation}: ${repairRequest.reason}`);
				assert.deepEqual(repairRequest.ranges.map(range => range.ordinal), result.repairOrdinals);
				const repair = parseWholeMarkerResponse(repairRequest, goodResponse(repairRequest), VALIDATE);
				const merged = mergeWholeMarkerRepair(request, result, repairRequest, repair);
				assert.equal(merged.ok, true, `${fixture.id}/${mutation}: repair must recover (${merged.reason})`);
				const restored = restore(prepared, request, merged.valid);
				for (const literal of fixture.preserveLiterals || []) assert.equal(restored.includes(literal), true, `${fixture.id}/${mutation} lost ${literal} after repair`);
				assert.doesNotMatch(restored, /⟪|⟦(?:[CW])?\d+⟧/);
				repaired++;
			}
		}
		if (mustPass) {
			assert.equal(result.ok, true, `${fixture.id}/${mutation} must pass: ${result.reason}`);
			if (mutation === "stray-chars") assert.ok(result.structure.strayMarkerChars >= 1, "stray characters are counted");
			if (mutation === "close-echo" || mutation === "wrong-echo") assert.equal(result.structure.closeMarkerEchoes, lines.length);
			const restored = restore(prepared, request, result.valid);
			for (const literal of fixture.preserveLiterals || []) assert.equal(restored.includes(literal), true, `${fixture.id}/${mutation} lost ${literal}`);
			assert.doesNotMatch(restored, /⟪|⟦(?:[CW])?\d+⟧/);
			assert.equal(restored.split(/\r\n|\r|\n/).length, fixture.source.split(/\r\n|\r|\n/).length, `${fixture.id}/${mutation}: line count survives reassembly and P1 restore`);
			cleanOk++;
		}
	}
	assert.ok(cleanOk > 2500, `enough clean iterations (${cleanOk})`);
	assert.ok(repaired > 1200, `enough repaired iterations (${repaired})`);
	assert.equal(Object.keys(counts).length, mutations.length - 1, "every mutation kind was exercised");
});

test("W2c D fixture manifest freezes f10-f13 next to the untouched nine", () => {
	const sha256 = value => crypto.createHash("sha256").update(String(value)).digest("hex").toUpperCase();
	assert.equal(W2_MEASURED_FIXTURES.length, 9);
	assert.equal(W2B_FIXTURE_REVISION, "w2c-fixed-v1");
	assert.deepEqual(W2B_EXTRA_FIXTURES.map(row => row.id), ["f10-markdown-protected-mixed", "f11-inline-placeholders-tail", "f12-trailing-punctuation-emoji", "f13-long-chinese-one-english"]);
	for (const fixture of W2B_EXTRA_FIXTURES) {
		assert.equal(fixture.synthetic, true);
		assert.equal(sha256(fixture.source), fixture.sha256, fixture.id);
		assert.equal(fixture.targetLanguageId, "zh-CN");
		assert.doesNotMatch(fixture.source, /⟪|⟫|⟦/);
	}
	const f13 = W2B_EXTRA_FIXTURES[3];
	assert.equal(f13.sha256, "54DE9CD426E79771F982EE801FE812991CB0780C5FFD256EA1462951910FDDAF");
	assert.ok(Array.from(f13.source).length > 600, "f13 is longer than the windowing threshold");
	assert.equal((f13.source.match(/[A-Za-z][^\n]*/g) || []).length, 1, "f13 carries exactly one English line");
	assert.ok(f13.source.match(/[A-Za-z][^\n]*/)[0].length <= 60);
	assert.equal(sha256(JSON.stringify([W2B_FIXTURE_REVISION, ...W2B_EXTRA_FIXTURES.map(row => [row.id, row.sha256, row.targetLanguageId])])), W2B_FIXTURE_MANIFEST_SHA256);
	assert.deepEqual(W2_ALL_FIXTURES.slice(0, 9), W2_MEASURED_FIXTURES);
});

test("W4 source spoiler echo is an opt-in local contract and never changes wire or prompt bytes", () => {
	const prepared = prepare({source: "Public introduction.\n||Secret apple sentence.||\nPublic ending.", targetLanguageId: "zh-CN"});
	const legacy = buildWholeMarkerRequest(prepared.plan, prepared.protectedSegments, {targetLanguageId: "zh-CN"});
	const request = buildWholeMarkerRequest(prepared.plan, prepared.protectedSegments, {targetLanguageId: "zh-CN", allowSourceSpoilerEcho: true});
	assert.equal(request.ok, true, request.reason);
	assert.deepEqual(request.sourceSpoilerEchoOrdinals, [2]);
	assert.equal(request.validatorVersion, "w4-whole-marker-spoiler-validator-v1");
	assert.equal(request.contractRevision, `${WHOLE_MARKER_CONTRACT_REVISION}.source-spoiler-v1`);
	assert.equal(Object.hasOwn(legacy, "sourceSpoilerEchoOrdinals"), false);
	assert.equal(legacy.validatorVersion, "w2c-whole-marker-validator-v2");
	assert.equal(legacy.contractRevision, WHOLE_MARKER_CONTRACT_REVISION);
	for (const key of ["wire", "userPrompt", "systemPrompt", "bodyBytes", "wireBytes", "systemPromptBytes", "promptVersion"]) assert.equal(request[key], legacy[key], key);
	assert.deepEqual(request.ranges, legacy.ranges);
	assert.doesNotMatch(request.wire + request.systemPrompt, /sourceSpoilerEchoOrdinals|source-spoiler-v1|allowSourceSpoilerEcho/);
});

function prepareSourceSpoiler(source = "Public introduction.\n||Secret apple sentence.||\nPublic ending.", extraFixture = {}) {
	const prepared = prepare(Object.assign({source, targetLanguageId: "zh-CN"}, extraFixture));
	const request = buildWholeMarkerRequest(prepared.plan, prepared.protectedSegments, {targetLanguageId: "zh-CN", allowSourceSpoilerEcho: true});
	assert.equal(request.ok, true, request.reason);
	return {prepared, request};
}

const SPOILER_CLEAN = "⟪1⟫公开介绍。\n⟪2⟫秘密句子。\n⟪3⟫公开结尾。";
const SPOILER_RESTORED = "公开介绍。\n||秘密句子。||\n公开结尾。";

for (const [name, raw] of [
	["inline", "⟪1⟫公开介绍。\n⟪2⟫||秘密句子。||\n⟪3⟫公开结尾。"],
	["outside", "⟪1⟫公开介绍。\n||⟪2⟫秘密句子。\n||\n⟪3⟫公开结尾。"],
	["outside CRLF", "⟪1⟫公开介绍。\r\n||⟪2⟫秘密句子。\r\n||\r\n⟪3⟫公开结尾。"],
	["no echo", SPOILER_CLEAN]
]) test("W4 source spoiler echo normalizes " + name + " without moving or duplicating the source pair", () => {
	const {prepared, request} = prepareSourceSpoiler();
	const result = parseWholeMarkerResponse(request, raw, VALIDATE);
	assert.equal(result.ok, true, result.reason);
	assert.equal(result.rootMalformed, false);
	assert.equal(result.valid[2], "秘密句子。");
	assert.equal(restore(prepared, request, result.valid), SPOILER_RESTORED);
	assert.equal((restore(prepared, request, result.valid).match(/\|\|/g) || []).length, 2);
	assert.doesNotMatch(Object.values(result.valid).join("\n"), /\|\|/);
});

for (const [name, source, expected] of [
	["quote prefix", "> ||Secret apple sentence.||", "> ||秘密句子。||"],
	["horizontal margins", "|| \tSecret apple sentence.\t ||", "|| \t秘密句子。\t ||"]
]) test("W4 source spoiler echo preserves " + name + " in local reassembly", () => {
	const {prepared, request} = prepareSourceSpoiler(source);
	assert.deepEqual(request.sourceSpoilerEchoOrdinals, [1]);
	for (const raw of ["⟪1⟫||秘密句子。||", "||⟪1⟫秘密句子。\n||"]) {
		const result = parseWholeMarkerResponse(request, raw, VALIDATE);
		assert.equal(result.ok, true, result.reason);
		assert.equal(result.valid[1], "秘密句子。");
		assert.equal(restore(prepared, request, result.valid), expected);
	}
});

for (const [name, source] of [
	["ordinary source", "Public ordinary sentence."],
	["inline-code bars", "Public \x60||code only||\x60 sentence."],
	["fenced-code bars", "~~~text\n||code only||\n~~~\nPublic sentence."],
	["fully escaped bars", "Public \\|\\|literal bars\\|\\| sentence."],
	["escaped opening bar", "Public \\||escaped opener|| sentence."],
	["code leaf inside pair", "||Public \x60inline\x60 secret.||"],
	["nested strong syntax", "||Outer **nested apple** tail||"],
	["link syntax inside pair", "||Read [the guide](https://example.invalid)||"],
	["adjacent nested markers", "||||Secret apple sentence.||||"],
	["adjacent closing and opening markers", "||First apple.||||Second ocean.||"],
	["multiline pair", "||First apple.\nSecond ocean.||"],
	["line break in opening margin", "||\nSecret apple sentence.||"],
	["line break in closing margin", "||Secret apple sentence.\n||"],
	["non-horizontal opening margin", "||中文 Secret apple sentence.||"],
	["non-horizontal closing margin", "||Secret apple sentence. 中文||"],
	["multiple sentence ranges", "||中文 First apple. Second ocean.||"],
	["unpaired opening marker", "||Secret apple sentence."],
	["unpaired closing marker", "Secret apple sentence.||"],
	["earlier unmatched marker prevents greedy repartnering", "||\n||Secret apple sentence.||"]
]) test("W4 source spoiler echo keeps the legacy contract for " + name, () => {
	const {prepared, request} = prepareSourceSpoiler(source);
	const legacy = buildWholeMarkerRequest(prepared.plan, prepared.protectedSegments, {targetLanguageId: "zh-CN"});
	assert.equal(Object.hasOwn(request, "sourceSpoilerEchoOrdinals"), false, name);
	assert.equal(request.validatorVersion, "w2c-whole-marker-validator-v2");
	assert.equal(request.contractRevision, WHOLE_MARKER_CONTRACT_REVISION);
	for (const key of ["wire", "userPrompt", "systemPrompt", "bodyBytes", "wireBytes", "systemPromptBytes"]) assert.equal(request[key], legacy[key], key);
	const response = goodResponse(request);
	assert.deepEqual(parseWholeMarkerResponse(request, response, VALIDATE), parseWholeMarkerResponse(legacy, response, VALIDATE));
});

test("W4 source spoiler echo requires real planner spoiler-marker roles rather than raw bars", () => {
	const {prepared} = prepareSourceSpoiler("||Secret apple sentence.||");
	const plan = Object.assign({}, prepared.plan, {nodes: prepared.plan.nodes.map(node => node.role === "spoiler-marker" ? Object.assign({}, node, {role: "table-marker"}) : node)});
	const request = buildWholeMarkerRequest(plan, prepared.protectedSegments, {targetLanguageId: "zh-CN", allowSourceSpoilerEcho: true});
	assert.equal(request.ok, true, request.reason);
	assert.equal(Object.hasOwn(request, "sourceSpoilerEchoOrdinals"), false);
	assert.equal(request.contractRevision, WHOLE_MARKER_CONTRACT_REVISION);
});

test("W4 source spoiler echo pairs the whole source before eligibility and preserves a later independent pair", () => {
	const {request} = prepareSourceSpoiler("||First apple.\nSecond ocean.||\n||Third bird.||");
	assert.deepEqual(request.ranges.map(range => range.ordinal), [1, 2, 3]);
	assert.deepEqual(request.sourceSpoilerEchoOrdinals, [3]);
	assert.equal(request.contractRevision, WHOLE_MARKER_CONTRACT_REVISION + ".source-spoiler-v1");
	const good = goodLines(request);
	good[2] = good[2].replace("⟪3⟫", "⟪3⟫||") + "||";
	assert.equal(parseWholeMarkerResponse(request, good.join("\n"), VALIDATE).ok, true);
	good[0] = good[0].replace("⟪1⟫", "⟪1⟫||") + "||";
	const bad = parseWholeMarkerResponse(request, good.join("\n"), VALIDATE);
	assert.equal(bad.reason, "unsafe-structure");
	assert.equal(bad.rootMalformed, true);
	assert.equal(bad.repairable, false);
});

test("W4 source spoiler echo accepts two independent eligible source pairs without crossing their ranges", () => {
	const {prepared, request} = prepareSourceSpoiler("||First apple.||\n||Second ocean.||");
	assert.deepEqual(request.sourceSpoilerEchoOrdinals, [1, 2]);
	const result = parseWholeMarkerResponse(request, "⟪1⟫||苹果译文。||\n||⟪2⟫海洋译文。\n||", VALIDATE);
	assert.equal(result.ok, true, result.reason);
	assert.deepEqual(result.valid, {1: "苹果译文。", 2: "海洋译文。"});
	assert.equal(restore(prepared, request, result.valid), "||苹果译文。||\n||海洋译文。||");
});

for (const [name, raw] of [
	["pair on ordinary first range", "⟪1⟫||公开介绍。||\n⟪2⟫秘密句子。\n⟪3⟫公开结尾。"],
	["pair on ordinary last range", "⟪1⟫公开介绍。\n⟪2⟫秘密句子。\n⟪3⟫||公开结尾。||"],
	["two pairs for one range", "⟪1⟫公开介绍。\n⟪2⟫||秘密|| ||句子。||\n⟪3⟫公开结尾。"],
	["unpaired inline opening", "⟪1⟫公开介绍。\n⟪2⟫||秘密句子。\n⟪3⟫公开结尾。"],
	["unpaired inline closing", "⟪1⟫公开介绍。\n⟪2⟫秘密句子。||\n⟪3⟫公开结尾。"],
	["cross-range outside pair", "⟪1⟫公开介绍。\n||⟪2⟫秘密句子。\n⟪3⟫公开结尾。\n||"],
	["cross-range inline pair", "⟪1⟫公开介绍。\n⟪2⟫||秘密句子。⟪3⟫公开结尾。||"],
	["extra inline prefix", "⟪1⟫公开介绍。\n⟪2⟫额外||秘密句子。||\n⟪3⟫公开结尾。"],
	["extra inline suffix", "⟪1⟫公开介绍。\n⟪2⟫||秘密句子。||额外\n⟪3⟫公开结尾。"],
	["extra outside opening text", "⟪1⟫公开介绍。\n||额外⟪2⟫秘密句子。\n||\n⟪3⟫公开结尾。"],
	["extra outside closing text", "⟪1⟫公开介绍。\n||⟪2⟫秘密句子。\n额外||\n⟪3⟫公开结尾。"],
	["nested inline pair", "⟪1⟫公开介绍。\n⟪2⟫||||秘密句子。||||\n⟪3⟫公开结尾。"],
	["stray trailing pair marker", SPOILER_CLEAN + "\n||"],
	["stray pair marker between ranges", "⟪1⟫公开介绍。\n||\n⟪2⟫秘密句子。\n⟪3⟫公开结尾。"],
	["quote-wrapped inline pair", "⟪1⟫公开介绍。\n⟪2⟫\"||秘密句子。||\"\n⟪3⟫公开结尾。"],
	["code-wrapped inline pair", "⟪1⟫公开介绍。\n⟪2⟫\x60||秘密句子。||\x60\n⟪3⟫公开结尾。"],
	["unmarked text following an accepted pair", "⟪1⟫公开介绍。\n||⟪2⟫秘密句子。\n||\n额外文本\n⟪3⟫公开结尾。"]
]) test("W4 source spoiler echo fails closed for " + name, () => {
	const {request} = prepareSourceSpoiler();
	const result = parseWholeMarkerResponse(request, raw, VALIDATE);
	assert.equal(result.ok, false, name);
	assert.equal(result.reason, "unsafe-structure", name);
	assert.equal(result.rootMalformed, true);
	assert.equal(result.repairable, false);
	assert.deepEqual(result.valid, {});
	assert.deepEqual(result.repairOrdinals, []);
});

test("W4 source spoiler echo leaves the default parser and opt-in no-eligible parser byte-for-byte literal", () => {
	for (const [source, options] of [
		["||Secret apple sentence.||", {}],
		["||Secret apple sentence.||", {allowSourceSpoilerEcho: false}],
		["Public ordinary sentence.", {allowSourceSpoilerEcho: true}]
	]) {
		const prepared = prepare({source, targetLanguageId: "zh-CN"});
		const request = buildWholeMarkerRequest(prepared.plan, prepared.protectedSegments, Object.assign({targetLanguageId: "zh-CN"}, options));
		assert.equal(Object.hasOwn(request, "sourceSpoilerEchoOrdinals"), false);
		const result = parseWholeMarkerResponse(request, "⟪1⟫||原样译文。||", VALIDATE);
		assert.equal(result.ok, true, result.reason);
		assert.equal(result.valid[1], "||原样译文。||", "legacy inline content is not normalized");
	}
});

test("W4 source spoiler echo does not relax missing, duplicate, unknown, order, or placeholder checks", () => {
	const {request} = prepareSourceSpoiler("Public introduction.\n||Please contact IDKEEP today.||\nPublic ending.", {protectedTerms: ["IDKEEP"]});
	assert.deepEqual(request.sourceSpoilerEchoOrdinals, [2]);
	assert.equal(request.ranges[1].tokens.length, 1);
	const lines = goodLines(request);
	lines[1] = lines[1].replace("⟪2⟫", "⟪2⟫||") + "||";
	for (const [reason, response, repairable] of [
		["missing-marker", [lines[0], lines[1]].join("\n"), true],
		["duplicate-marker", [...lines, lines[2]].join("\n"), false],
		["unknown-marker", [...lines, "⟪99⟫未知段落。"].join("\n"), false],
		["marker-order", [lines[1], lines[0], lines[2]].join("\n"), false],
		["placeholder-mismatch", lines.join("\n").replace(request.ranges[1].tokens[0], ""), true],
		["placeholder-mismatch", lines.join("\n").replace("⟪2⟫||", "⟪2⟫||" + request.ranges[1].tokens[0]), true]
	]) {
		const result = parseWholeMarkerResponse(request, response, VALIDATE);
		assert.equal(result.ok, false, reason);
		assert.equal(result.reason, reason);
		assert.equal(result.repairable, repairable, reason);
		assert.equal(result.rootMalformed, !repairable, reason);
	}
});

for (const [name, missing, firstRaw, repairRaw, expectedEchoOrdinals] of [
	["non-spoiler only", [1], "⟪2⟫||秘密句子。||\n⟪3⟫公开结尾。", "⟪1⟫公开介绍。", []],
	["spoiler only", [2], "⟪1⟫公开介绍。\n⟪3⟫公开结尾。", "||⟪2⟫秘密句子。\n||", [2]],
	["mixed ordinary and spoiler", [1, 2], "⟪3⟫公开结尾。", "⟪1⟫公开介绍。\n⟪2⟫||秘密句子。||", [2]]
]) test("W4 source spoiler echo repair retains the parent contract with " + name + " marked", () => {
	const {prepared, request} = prepareSourceSpoiler();
	const first = parseWholeMarkerResponse(request, firstRaw, VALIDATE);
	assert.equal(first.reason, "missing-marker");
	assert.equal(first.repairable, true);
	assert.deepEqual(first.repairOrdinals, missing);
	const repairRequest = buildWholeMarkerRepairRequest(request, first.repairOrdinals);
	assert.equal(repairRequest.ok, true, repairRequest.reason);
	assert.deepEqual(repairRequest.ranges.map(range => range.ordinal), missing);
	assert.equal(repairRequest.totalRangeCount, 3);
	assert.equal(Object.hasOwn(repairRequest, "sourceSpoilerEchoOrdinals"), true, "all source ranges retain the new contract, even when no marked range is eligible");
	assert.deepEqual(repairRequest.sourceSpoilerEchoOrdinals, expectedEchoOrdinals);
	assert.equal(repairRequest.validatorVersion, request.validatorVersion);
	assert.equal(repairRequest.contractRevision, request.contractRevision);
	assert.equal(repairRequest.compileOptions.allowSourceSpoilerEcho, true);
	const repair = parseWholeMarkerResponse(repairRequest, repairRaw, VALIDATE);
	assert.equal(repair.ok, true, repair.reason);
	const merged = mergeWholeMarkerRepair(request, first, repairRequest, repair);
	assert.equal(merged.ok, true, merged.reason);
	assert.deepEqual(merged.repairedOrdinals, missing);
	assert.deepEqual(merged.valid, {1: "公开介绍。", 2: "秘密句子。", 3: "公开结尾。"});
	assert.equal(restore(prepared, request, merged.valid), SPOILER_RESTORED);
});

test("W4 source spoiler echo non-spoiler repair never inherits an unmarked spoiler's stripping permission", () => {
	const {request} = prepareSourceSpoiler();
	const first = parseWholeMarkerResponse(request, "⟪2⟫||秘密句子。||\n⟪3⟫公开结尾。", VALIDATE);
	const repairRequest = buildWholeMarkerRepairRequest(request, [1]);
	assert.deepEqual(repairRequest.sourceSpoilerEchoOrdinals, []);
	for (const raw of ["⟪1⟫||公开介绍。||", "||⟪1⟫公开介绍。\n||"]) {
		const repair = parseWholeMarkerResponse(repairRequest, raw, VALIDATE);
		assert.equal(repair.reason, "unsafe-structure");
		assert.equal(repair.rootMalformed, true);
		assert.equal(repair.repairable, false);
		const merged = mergeWholeMarkerRepair(request, first, repairRequest, repair);
		assert.equal(merged.ok, false);
		assert.equal(merged.repairRootMalformed, true);
		assert.deepEqual(merged.valid, {2: "秘密句子。", 3: "公开结尾。"});
		assert.deepEqual(merged.invalid, [{ordinal: 1, reason: "unsafe-structure"}]);
	}
});

test("W4 source spoiler echo counts the raw response bytes before normalization at both budget boundaries", () => {
	const {prepared, request} = prepareSourceSpoiler();
	const raw = "⟪1⟫公开介绍。\n||⟪2⟫秘密句子。\n||\n⟪3⟫公开结尾。";
	const rawBytes = Buffer.byteLength(raw);
	const cleanBytes = Buffer.byteLength(SPOILER_CLEAN);
	assert.ok(rawBytes > cleanBytes);
	const rejected = parseWholeMarkerResponse(request, raw, Object.assign({}, VALIDATE, {maxResponseBytes: cleanBytes}));
	assert.equal(rejected.reason, "response-budget");
	assert.equal(rejected.rootMalformed, true);
	assert.equal(rejected.repairable, false);
	assert.equal(rejected.responseBytes, rawBytes);
	assert.equal(rejected.maxResponseBytes, cleanBytes);
	const accepted = parseWholeMarkerResponse(request, raw, Object.assign({}, VALIDATE, {maxResponseBytes: rawBytes}));
	assert.equal(accepted.ok, true, accepted.reason);
	assert.equal(accepted.responseBytes, rawBytes);
	assert.equal(restore(prepared, request, accepted.valid), SPOILER_RESTORED);
	const limited = buildWholeMarkerRequest(prepared.plan, prepared.protectedSegments, {targetLanguageId: "zh-CN", allowSourceSpoilerEcho: true, maxResponseBytes: rawBytes - 1});
	assert.equal(parseWholeMarkerResponse(limited, raw, VALIDATE).reason, "response-budget", "the compiled request budget also applies before normalization");
});

for (const [name, source, raw, ordinals, expected] of [
	["first", "||Secret apple sentence.||\nPublic ending.", "||⟪1⟫秘密句子。\n||\n⟪2⟫公开结尾。", [1], "||秘密句子。||\n公开结尾。"],
	["last", "Public introduction.\n||Secret apple sentence.||", "⟪1⟫公开介绍。\n||⟪2⟫秘密句子。\n||", [2], "公开介绍。\n||秘密句子。||"],
	["only", "||Secret apple sentence.||", "||⟪1⟫秘密句子。\n||", [1], "||秘密句子。||"]
]) test("W4 source spoiler echo accepts an outside pair on the " + name + " range", () => {
	const {prepared, request} = prepareSourceSpoiler(source);
	assert.deepEqual(request.sourceSpoilerEchoOrdinals, ordinals);
	const result = parseWholeMarkerResponse(request, raw, VALIDATE);
	assert.equal(result.ok, true, result.reason);
	assert.equal(restore(prepared, request, result.valid), expected);
	assert.doesNotMatch(Object.values(result.valid).join("\n"), /\|\|/);
});

for (const [name, raw] of [

	["inline opening plus standalone closing", "⟪1⟫公开介绍。\n⟪2⟫||秘密句子。\n||\n⟪3⟫公开结尾。"],
	["outside opening plus inline closing and extra standalone closing", "⟪1⟫公开介绍。\n||⟪2⟫秘密句子。||\n||\n⟪3⟫公开结尾。"],
	["inline complete pair plus extra standalone closing", "⟪1⟫公开介绍。\n⟪2⟫||秘密句子。||\n||\n⟪3⟫公开结尾。"]
]) test("W4 source spoiler echo rejects the unapproved hybrid " + name, () => {
	const {request} = prepareSourceSpoiler();
	const result = parseWholeMarkerResponse(request, raw, VALIDATE);
	assert.equal(result.reason, "unsafe-structure");
	assert.equal(result.ok, false);
	assert.equal(result.rootMalformed, true);
	assert.equal(result.repairable, false);
	assert.deepEqual(result.valid, {});
});

for (const [name, decorated] of [
	["stray close characters", "|⟫|秘密句子。|⟫|"],
	["stray open characters", "|⟪|秘密句子。|⟪|"],
	["close-marker echoes", "|⟪/2⟫|秘密句子。|⟪/2⟫|"],
	["mismatched close-marker echoes", "|⟪/99⟫|秘密句子。|⟪/99⟫|"]
]) test("W4 source spoiler echo never grants pair permission created by stripping " + name, () => {
	const {prepared, request} = prepareSourceSpoiler();
	const raw = "⟪1⟫公开介绍。\n⟪2⟫" + decorated + "\n⟪3⟫公开结尾。";
	const result = parseWholeMarkerResponse(request, raw, VALIDATE);
	assert.equal(result.reason, "unsafe-structure");
	assert.equal(result.ok, false);
	assert.equal(result.rootMalformed, true);
	assert.equal(result.repairable, false);
	assert.deepEqual(result.valid, {});
	const legacy = buildWholeMarkerRequest(prepared.plan, prepared.protectedSegments, {targetLanguageId: "zh-CN"});
	const oldResult = parseWholeMarkerResponse(legacy, raw, VALIDATE);
	assert.equal(oldResult.ok, true, oldResult.reason);
	assert.equal(oldResult.valid[2], "||秘密句子。||", "the legacy noise stripping remains unchanged");
});

test("W4 source spoiler echo preserves literal quotation marks outside an eligible source pair", () => {
	const {prepared, request} = prepareSourceSpoiler("\"||Secret apple sentence.||\"");
	assert.deepEqual(request.sourceSpoilerEchoOrdinals, [1]);
	for (const raw of ["⟪1⟫||秘密句子。||", "||⟪1⟫秘密句子。\n||"]) {
		const result = parseWholeMarkerResponse(request, raw, VALIDATE);
		assert.equal(result.ok, true, result.reason);
		assert.equal(restore(prepared, request, result.valid), "\"||秘密句子。||\"");
	}
});

test("W4 source spoiler echo rejects a source pair containing an escaped-literal leaf", () => {
	const {request} = prepareSourceSpoiler("||Public \\*escaped\\* secret.||");
	assert.equal(Object.hasOwn(request, "sourceSpoilerEchoOrdinals"), false);
	assert.equal(request.validatorVersion, "w2c-whole-marker-validator-v2");
	assert.equal(request.contractRevision, WHOLE_MARKER_CONTRACT_REVISION);
});

for (const [name, prefix] of [
	["inline-code bars", "Public \x60||code only||\x60 sentence."],
	["escaped bars", "Public \\|\\|literal bars\\|\\| sentence."]
]) test("W4 source spoiler echo ignores earlier " + name + " when pairing real source markers", () => {
	const {request} = prepareSourceSpoiler(prefix + "\n||Secret apple sentence.||");
	assert.deepEqual(request.sourceSpoilerEchoOrdinals, [2]);
	assert.equal(request.contractRevision, WHOLE_MARKER_CONTRACT_REVISION + ".source-spoiler-v1");
	const lines = goodLines(request);
	lines[1] = "⟪2⟫||秘密句子。||";
	const result = parseWholeMarkerResponse(request, lines.join("\n"), VALIDATE);
	assert.equal(result.ok, true, result.reason);
	assert.equal(result.valid[2], "秘密句子。");
});

for (const [name, source, raw, ordinals, expected] of [
	["first", "||Secret apple sentence.||\nPublic ending.", "||⟪1⟫秘密句子。||\n⟪2⟫公开结尾。", [1], "||秘密句子。||\n公开结尾。"],
	["middle", "Public introduction.\n||Secret apple sentence.||\nPublic ending.", "⟪1⟫公开介绍。\n||⟪2⟫秘密句子。||\n⟪3⟫公开结尾。", [2], SPOILER_RESTORED],
	["last", "Public introduction.\n||Secret apple sentence.||", "⟪1⟫公开介绍。\n||⟪2⟫秘密句子。||", [2], "公开介绍。\n||秘密句子。||"]
]) test("W4 source spoiler echo accepts the approved same-line outside pair on the " + name + " range", () => {
	const {prepared, request} = prepareSourceSpoiler(source);
	assert.deepEqual(request.sourceSpoilerEchoOrdinals, ordinals);
	const result = parseWholeMarkerResponse(request, raw, VALIDATE);
	assert.equal(result.ok, true, result.reason);
	assert.equal(restore(prepared, request, result.valid), expected);
	assert.doesNotMatch(Object.values(result.valid).join("\n"), /\|\|/);
});

for (const [name, raw] of [
	["triple bars", "⟪1⟫|||秘密句子。|||"],
	["single bars at both edges", "⟪1⟫|秘密句子。|"],
	["single leading bar", "⟪1⟫|秘密句子。"],
	["single trailing bar", "⟪1⟫秘密句子。|"]
]) test("W4 source spoiler echo rejects extra eligible translation-edge pipes: " + name, () => {
	const {request} = prepareSourceSpoiler("||Secret apple sentence.||");
	const result = parseWholeMarkerResponse(request, raw, VALIDATE);
	assert.equal(result.reason, "unsafe-structure");
	assert.equal(result.ok, false);
	assert.equal(result.rootMalformed, true);
	assert.equal(result.repairable, false);
	assert.deepEqual(result.valid, {});
});

test("W4 source spoiler echo preserves an ordinary single pipe in the middle of an eligible translation", () => {
	const {prepared, request} = prepareSourceSpoiler("||Secret apple sentence.||");
	const result = parseWholeMarkerResponse(request, "⟪1⟫秘密|句子。", VALIDATE);
	assert.equal(result.ok, true, result.reason);
	assert.equal(result.valid[1], "秘密|句子。");
	assert.equal(restore(prepared, request, result.valid), "||秘密|句子。||");
});

test("W4 source spoiler echo does not extend the eligible edge-pipe rule to ordinary source ranges", () => {
	const {prepared, request} = prepareSourceSpoiler();
	const result = parseWholeMarkerResponse(request, "⟪1⟫|公开介绍。|\n⟪2⟫秘密句子。\n⟪3⟫公开结尾。", VALIDATE);
	assert.equal(result.ok, true, result.reason);
	assert.equal(result.valid[1], "|公开介绍。|");
	assert.equal(restore(prepared, request, result.valid), "|公开介绍。|\n||秘密句子。||\n公开结尾。");
});

for (const [name, source, protectedTerms, rawProtected] of [
	["fenced code", "||Public \x60\x60\x60js\nconst x=1;\n\x60\x60\x60 secret.||", [], "\x60\x60\x60js\nconst x=1;\n\x60\x60\x60"],
	["configured inline code", "||Public \x60inline\x60 secret.||", ["\x60inline\x60"], "\x60inline\x60"],
	["configured multiline term", "||Public ALPHA\nBETA secret.||", ["ALPHA\nBETA"], "ALPHA\nBETA"]
]) test("W4 source spoiler echo resolves numeric P1 map keys before judging " + name, () => {
	const prepared = prepare({source, protectedTerms, targetLanguageId: "zh-CN"});
	assert.equal(prepared.protectedSource.source, "||Public ⟦0⟧ secret.||", "the real P1 stage hides the original sensitive structure");
	assert.deepEqual(prepared.protectedSegments, {"0": rawProtected});
	const request = buildWholeMarkerRequest(prepared.plan, prepared.protectedSegments, {targetLanguageId: "zh-CN", allowSourceSpoilerEcho: true});
	const legacy = buildWholeMarkerRequest(prepared.plan, prepared.protectedSegments, {targetLanguageId: "zh-CN"});
	assert.equal(request.ok, true, request.reason);
	assert.equal(Object.hasOwn(request, "sourceSpoilerEchoOrdinals"), false);
	assert.equal(request.validatorVersion, "w2c-whole-marker-validator-v2");
	assert.equal(request.contractRevision, WHOLE_MARKER_CONTRACT_REVISION);
	assert.equal(request.wire, legacy.wire);
	assert.equal(request.systemPrompt, legacy.systemPrompt);
});
