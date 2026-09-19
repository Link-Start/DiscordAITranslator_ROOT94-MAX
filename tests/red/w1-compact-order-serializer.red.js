const test = require("node:test");
const {
	assert, original14Markdown, requireW1, utf8, sha256, planFor,
	exactBaseline, withNoSideEffects, performance, p95
} = require("../helpers/w1-compact-wire-test-kit");

test("W1 R0 freezes the W0/P1 exact typed baseline and has zero side effects", () => {
	const w1 = requireW1(), base = exactBaseline();
	assert.equal(base.chars, 1755);
	assert.equal(base.sourceBytes, 2167);
	assert.equal(base.typed.segmentCount, 61);
	assert.equal(base.typed.bodyBytes, 14528);
	assert.equal(base.translateBytes, 1063);
	const before = sha256(require("node:fs").readFileSync("DiscordAITranslator.plugin.js"));
	const candidateSource = require("node:fs").readFileSync("src/planner/translation-compact-wire.js", "utf8");
	assert.doesNotMatch(candidateSource, /require\(["'](?:node:https?|\.\.\/providers|\.\.\/cache)|global\.BDFDB|\bfetch\s*\(|\bdocument\s*\.|localStorage\s*\./);
	const first = withNoSideEffects(() => w1.buildCompactOrderRequest(base.plan, base.source, {targetLanguageId: "zh-CN"}));
	for (let index = 0; index < 100; index++) assert.equal(w1.buildCompactOrderRequest(base.plan, base.source, {targetLanguageId: "zh-CN"}).wire, first.wire);
	assert.equal(sha256(require("node:fs").readFileSync("DiscordAITranslator.plugin.js")), before);
});

test("W1 B exact wire is c/x only and meets both exact budgets", () => {
	const w1 = requireW1(), base = exactBaseline(), request = w1.buildCompactOrderRequest(base.plan, base.source, {targetLanguageId: "zh-CN"});
	assert.equal(request.ok, true);
	assert.deepEqual(Object.keys(JSON.parse(request.wire)).sort(), ["c", "x"]);
	assert.equal(request.contextIncluded, true);
	assert.equal(request.mapping.length, 61);
	assert.equal(request.translateBytes, 1063);
	assert.ok(request.bodyBytes <= 4608, request.bodyBytes);
	assert.ok(request.bodyBytes <= base.sourceBytes * 2.1, request.bodyBytes);
	assert.ok(request.systemPromptBytes <= 512);
	assert.ok(request.metadataBytes <= 512);
	assert.equal(w1.inspectProviderWire(request.wire).ok, true);
});

test("W1 B context inclusion uses the pre-registered UTF-8 90 percent boundary", () => {
	const w1 = requireW1();
	const single = "A".repeat(2000), singleRequest = w1.buildCompactOrderRequest(planFor(single), single, {});
	assert.equal(singleRequest.ok, true);
	assert.equal(singleRequest.contextIncluded, false);
	assert.equal(Object.hasOwn(JSON.parse(singleRequest.wire), "c"), false);
	assert.ok(singleRequest.bodyBytes <= utf8(single) + 512);
	const synthetic = ratio => {const source = "S".repeat(1000); return {source, nodes: [
		{id: "stable-0", kind: "text", classification: "translate", raw: source.slice(0, ratio), sourceStart: 0, sourceEnd: ratio},
		{id: "stable-1", kind: "text", classification: "preserve-target", raw: source.slice(ratio), sourceStart: ratio, sourceEnd: 1000}
	]};};
	assert.equal(w1.buildCompactOrderRequest(synthetic(900), synthetic(900).source, {}).contextIncluded, false);
	assert.equal(w1.buildCompactOrderRequest(synthetic(899), synthetic(899).source, {}).contextIncluded, true);
});

test("W1 B no-segments and custom prompt boundary are explicit", () => {
	const w1 = requireW1();
	assert.equal(w1.buildCompactOrderRequest(planFor("全是中文。"), "全是中文。", {}).reason, "no-segments");
	assert.equal(w1.buildCompactOrderRequest(planFor("Hello"), "Hello", {userPrompt: "x".repeat(1024)}).ok, true);
	assert.equal(w1.buildCompactOrderRequest(planFor("Hello"), "Hello", {userPrompt: "x".repeat(1025)}).reason, "user-prompt-budget");
	const utf8Boundary = "你".repeat(341) + "a", utf8Over = utf8Boundary + "b";
	assert.equal(Buffer.byteLength(utf8Boundary), 1024);
	assert.equal(Buffer.byteLength(utf8Over), 1025);
	assert.equal(w1.buildCompactOrderRequest(planFor("Hello"), "Hello", {userPrompt: utf8Boundary}).ok, true);
	assert.equal(w1.buildCompactOrderRequest(planFor("Hello"), "Hello", {userPrompt: utf8Over}).reason, "user-prompt-budget");
	const request = w1.buildCompactOrderRequest(planFor("Hello"), "Hello", {userPrompt: "保持语气", targetLanguageId: "zh-CN"});
	assert.equal(request.userPrompt, "保持语气");
	assert.equal((request.systemPrompt.match(/zh-CN/g) || []).length, 1);
	assert.equal(request.wire.includes("保持语气"), false);
	assert.equal(request.wire.includes("zh-CN"), false);
});

test("W1 B preserves duplicate text as separate stable positions", () => {
	const w1 = requireW1(), source = "Repeat\nRepeat", request = w1.buildCompactOrderRequest(planFor(source), source, {});
	assert.equal(request.mapping.length, 2);
	assert.equal(request.mapping[0].text, request.mapping[1].text);
	assert.notEqual(request.mapping[0].stableId, request.mapping[1].stableId);
	const parsed = w1.parseCompactOrderResponse(request, JSON.stringify(["第一处", "第二处"]), {likelyTarget: () => true});
	const output = w1.reassembleCompactResponse(request, parsed.valid);
	assert.equal(output, "第一处\n第二处");
});

test("W1 wire families match W0 cohorts and same-script language pairs remain translatable", () => {
	const w1 = requireW1(), english = planFor("Hello world", "fr"), french = planFor("Bonjour le monde", "en");
	const array = w1.buildCompactOrderRequest(english, english.source, {inputLanguageId: "en", targetLanguageId: "fr"}), marker = w1.buildCompactOrderRequest(english, english.source, {inputLanguageId: "en", targetLanguageId: "fr", responseMode: "marker"}), whole = w1.buildWholeMessageRequest(english, {}, {inputLanguageId: "en", targetLanguageId: "fr"});
	assert.equal(array.ok, true); assert.equal(array.wireFamily, "compact-order");
	assert.equal(marker.ok, true); assert.equal(marker.wireFamily, "compact-marker");
	assert.equal(whole.ok, true); assert.equal(whole.wireFamily, "whole");
	assert.equal(JSON.parse(array.wire).x.join(" ").includes("Hello world"), true);
	const reverse = w1.buildCompactOrderRequest(french, french.source, {inputLanguageId: "fr", targetLanguageId: "en"});
	assert.equal(reverse.ok, true);
	assert.equal(JSON.parse(reverse.wire).x.join(" ").includes("Bonjour le monde"), true);
	assert.deepEqual(whole.preserveTarget, []);
});

test("W1 serializer exact fixture P95 stays below 2ms", () => {
	const w1 = requireW1(), base = exactBaseline(), samples = [];
	for (let index = 0; index < 100; index++) w1.buildCompactOrderRequest(base.plan, original14Markdown, {});
	for (let index = 0; index < 1000; index++) {const started = performance.now(); w1.buildCompactOrderRequest(base.plan, original14Markdown, {}); samples.push(performance.now() - started);}
	assert.ok(p95(samples) < 2, `serializer P95 ${p95(samples)}ms`);
});
