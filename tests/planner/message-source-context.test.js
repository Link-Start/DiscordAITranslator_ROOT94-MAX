const test = require("node:test");
const assert = require("node:assert/strict");
const {createSemanticRequest, validateSemanticResponse, planSemanticRepair, isPlanTranslationMeaningful} = require("../../src/planner/translation-semantic-runtime");

const judges = {likelyTarget: value => /\p{Script=Han}/u.test(value), similarity: (a, b) => a.trim() === b.trim() ? 1 : 0};
const create = source => createSemanticRequest({engineKey: "oaicompat", source, targetLanguageId: "zh-CN"});
const keepName = "__KEEP_NAME__";

test("mixed messages send their complete protected sentence once and still ask the model about each word", () => {
	const source = "nora的alpha5是正常的，5.1有问题", request = create(source), payload = JSON.parse(request.wire);
	assert.equal(payload.sourceContext, source);
	assert.deepEqual(payload.segments.map(row => row.text), ["nora", "alpha5"]);
	assert.ok(payload.segments.every(row => row.allowNameKeep === true));
	assert.equal(isPlanTranslationMeaningful(request.plan), true);
	const result = validateSemanticResponse(request, {segments: payload.segments.map(row => ({id: row.id, translation: keepName}))}, judges);
	assert.equal(result.ok, true);
	assert.equal(result.translation, source);
	assert.equal(result.keptCount, 2);
});

test("short slang and ordinary phrases still require translation rather than an unexplained echo", () => {
	const request = create("lol，这也太快了"), payload = JSON.parse(request.wire);
	assert.equal(isPlanTranslationMeaningful(request.plan), true);
	assert.equal(validateSemanticResponse(request, {segments: [{id: "s1", translation: "哈哈，"}]}, judges).translation, "哈哈，这也太快了");
	const phrase = create("这个功能 really helps a lot");
	assert.equal(validateSemanticResponse(phrase, {segments: [{id: "s1", translation: "really helps a lot"}]}, judges).ok, false);
	const ordinary = create("这个效果 nice 真不错");
	assert.equal(validateSemanticResponse(ordinary, {segments: [{id: "s1", translation: "很好 "}]}, judges).translation, "这个效果 很好 真不错");
	assert.equal(validateSemanticResponse(ordinary, {segments: [{id: "s1", translation: "nice "}]}, judges).ok, false, "an unexplained echo is not an explicit name decision");
});

test("context does not reveal protected code or links, and plain English is not duplicated", () => {
	const mixed = create("这是说明 [guide](https://example.invalid/private) 和 `secret-code`，please restart");
	const payload = JSON.parse(mixed.wire);
	assert.match(payload.sourceContext, /这是说明/);
	assert.doesNotMatch(payload.sourceContext, /example\.invalid|secret-code/);
	assert.equal(JSON.parse(create("Please restart the app.").wire).sourceContext, undefined);
});

test("repairs keep the original context and cannot publish a partial message", () => {
	const request = create("nora的版本说明\nplease restart the server."), payload = JSON.parse(request.wire);
	const failed = validateSemanticResponse(request, {segments: payload.segments.map(row => ({id: row.id, translation: row.text === "nora" ? keepName : row.text}))}, judges);
	assert.equal(failed.ok, false);
	assert.equal(failed.translation, null);
	const repair = planSemanticRepair(request, failed, {parentSettled: true}).requests[0];
	assert.equal(JSON.parse(repair.wire).sourceContext, payload.sourceContext);
	const fixed = validateSemanticResponse(repair, {segments: [{id: "s1", translation: "请重启服务器。"}]}, {...judges, priorValid: failed.valid});
	assert.equal(fixed.translation, "nora的版本说明\n请重启服务器。");
});

test("a name repaired alone retains its original context and permission", () => {
	const source = "nora的版本说明\nplease restart the server.", request = create(source);
	const first = validateSemanticResponse(request, {segments: [{id: "s2", translation: "请重启服务器。"}]}, judges);
	const repair = planSemanticRepair(request, first, {parentSettled: true}).requests[0];
	assert.equal(JSON.parse(repair.wire).segments[0].allowNameKeep, true);
	const result = validateSemanticResponse(repair, {segments: [{id: "s1", translation: keepName}]}, {...judges, priorValid: first.valid});
	assert.equal(result.translation, "nora的版本说明\n请重启服务器。");
});

test("punctuation and formatting stay intact when a contextual name is kept", () => {
	for (const source of ["我用的是nora。", "联系nora，已经更新", "这个 **nora** 已经更新"]) {
		const request = create(source), payload = JSON.parse(request.wire);
		assert.equal(payload.segments[0].allowNameKeep, true, source);
		const result = validateSemanticResponse(request, {segments: [{id: "s1", translation: keepName}]}, judges);
		assert.equal(result.ok, true, source);
		assert.equal(result.translation, source);
	}
});

test("capitalized ordinary commands cannot bypass whole-message rejection, even during repair", () => {
	const request = create("请先 Open The App 再继续\nplease restart the server.");
	const first = validateSemanticResponse(request, {segments: [{id: "s1", translation: "Open The App "}, {id: "s2", translation: "请重启服务器。"}]}, judges);
	assert.equal(first.ok, false);
	const repair = planSemanticRepair(request, first, {parentSettled: true}).requests[0];
	const second = validateSemanticResponse(repair, {segments: [{id: "s1", translation: "Open The App "}]}, {...judges, priorValid: first.valid});
	assert.equal(second.ok, false);
	assert.equal(second.translation, null);
	assert.match(repair.systemPrompt, /Repair pass:/);
	const third = planSemanticRepair(repair, second, {parentSettled: true}).requests[0];
	assert.equal((third.systemPrompt.match(/Repair pass:/g) || []).length, 1);
});

test("a name sentinel may keep exact source punctuation and formatting, never altered wrappers", () => {
	for (const [source, answer] of [["我用的是nora。", "__KEEP_NAME__。"], ["这个 **nora** 已经更新", "⟦F0⟧__KEEP_NAME__⟦/F0⟧"], ["这个 **F0** 已经更新", "⟦F0⟧__KEEP_NAME__⟦/F0⟧"]]) {
		const request = create(source);
		assert.equal(validateSemanticResponse(request, {segments: [{id:"s1", translation:answer}]}, judges).translation, source);
	}
	for (const answer of ["⟦F1⟧__KEEP_NAME__⟦/F1⟧", "⟦F0⟧__KEEP_NAME__", "说明__KEEP_NAME__", "__KEEP_NAME____KEEP_NAME__"]) {
		assert.equal(validateSemanticResponse(create("这个 **nora** 已经更新"), {segments:[{id:"s1",translation:answer}]}, judges).ok, false, answer);
	}
});

test("name permission is independent of context and repair cannot enable an unannounced permission", () => {
	const smallContext = createSemanticRequest({engineKey: "oaicompat", source: "nora的版本", targetLanguageId: "zh-CN", maxContextChars: 1});
	assert.equal(JSON.parse(smallContext.wire).sourceContext, undefined);
	assert.match(smallContext.systemPrompt, /allowNameKeep/);
	assert.equal(validateSemanticResponse(smallContext, {segments: [{id: "s1", translation: keepName}]}, judges).unchanged, true);
	const request = createSemanticRequest({engineKey: "oaicompat", source: "nora", targetLanguageId: "zh-CN", maxBodyBytes: 115});
	assert.equal(request.enabled, true);
	assert.deepEqual(request.contextNameIds, []);
	const first = validateSemanticResponse(request, {segments: [{id: "s1", translation: keepName}]}, judges);
	assert.equal(first.ok, false);
	const repair = planSemanticRepair(request, first, {parentSettled: true}).requests[0];
	assert.deepEqual(repair.contextNameIds, []);
	assert.doesNotMatch(repair.systemPrompt, /Repair pass:/);
});

test("context marker leakage and duplicate name decisions remain hard failures", () => {
	const request = create("这个nora已经更新");
	for (const rows of [[{id: "s1", translation: "名称⟦CTX0⟧"}], [{id: "s1", translation: keepName}, {id: "s1", translation: keepName}]]) {
		const result = validateSemanticResponse(request, {segments: rows}, judges);
		assert.equal(result.ok, false);
		assert.equal(result.translation, null);
	}
});

test("native adapters keep their wire and reject null rows without throwing", () => {
	for (const engineKey of ["anthropicnative", "gemininative"]) {
		const request = createSemanticRequest({engineKey, source: "这个nora已经更新", targetLanguageId: "zh-CN"});
		assert.equal(request.adapter, "native-multi");
		assert.doesNotMatch(request.wire, /sourceContext|allowNameKeep/);
		assert.equal(validateSemanticResponse(request, {items: [null]}, judges).ok, false);
		assert.deepEqual(request.contextNameIds, []);
		assert.equal(validateSemanticResponse(request, {items: [keepName]}, judges).ok, false, "native adapters never sent this permission");
	}
});

for (const source of ["明天nova 4.1来不来", "免费的orion 100%路由了", "atlas cloud？", "支持 Atlas Code、Nova Code 和 Atlas/Nova 协议", "我用 nova 4.1 ⟦0⟧ 版本"]) test(`explicit whole-result keep: ${source}`, () => {
	const request = create(source), payload = JSON.parse(request.wire);
	assert.ok(payload.segments.every(row => row.allowNameKeep));
	const result = validateSemanticResponse(request, {segments: payload.segments.map(row => ({id: row.id, translation: keepName}))}, judges);
	assert.equal(result.ok, true);
	assert.equal(result.unchanged, true);
	assert.equal(result.translation, source);
});

test("a kept name cannot settle an incomplete root message or hide a translated sentence", () => {
	const request = create("nova 4.1 的版本说明\nplease restart the server.");
	const first = validateSemanticResponse(request, {segments: [{id: "s1", translation: keepName}]}, judges);
	assert.equal(first.ok, false);
	assert.equal(first.unchanged, false);
	const repair = planSemanticRepair(request, first, {parentSettled: true}).requests[0];
	const result = validateSemanticResponse(repair, {segments: [{id: "s1", translation: "请重启服务器。"}]}, {...judges, priorValid: first.valid});
	assert.equal(result.ok, true);
	assert.equal(result.unchanged, false);
	assert.equal(result.translation, "nova 4.1 的版本说明\n请重启服务器。");
});
