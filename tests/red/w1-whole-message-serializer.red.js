const test = require("node:test");
const {assert, requireW1, planFor, createProtectionFixture, utf8} = require("../helpers/w1-compact-wire-test-kit");
const ACCEPT_EXPERIMENT = Object.freeze({likelyTarget: () => true, experimentalOracle: () => true});

test("W1 C sends one safe whole message within source plus 768 bytes", () => {
	const w1 = requireW1(), source = "中文说明\n# Degree of Interest\n- GED\n- Non-Degree", fixture = createProtectionFixture(), protectedSource = fixture.protect(source), plan = planFor(protectedSource.source), safe = w1.buildSafeContext(plan, protectedSource.protectedSegments), request = w1.buildWholeMessageRequest(plan, safe, {targetLanguageId: "zh-CN"});
	assert.equal(request.ok, true);
	assert.equal(typeof request.wire, "string");
	assert.ok(request.bodyBytes <= utf8(source) + 768);
	assert.ok(request.systemPromptBytes <= 512);
	assert.equal(request.wire, request.safeContext);
	assert.equal(request.productionEligible, false);
	assert.equal(request.orderDetectable, false);
});

test("W1 C validator accepts strict structure and rejects echo, truncation, reordering and marker damage", () => {
	const w1 = requireW1(), source = "中文说明\n# Degree of Interest\n- GED\n- Non-Degree", plan = planFor(source), safe = w1.buildSafeContext(plan, {}), request = w1.buildWholeMessageRequest(plan, safe, {}), good = "中文说明\n# 意向学位\n- 普通教育发展证书\n- 非学位";
	assert.equal(w1.validateWholeMessageResponse(request, good, ACCEPT_EXPERIMENT).ok, true);
	for (const bad of ["", source, "前言\n" + good, good.slice(0, -3), "中文说明\n- 普通教育发展证书\n# 意向学位\n- 非学位", good.replace("中文说明", "改写中文")]) assert.equal(w1.validateWholeMessageResponse(request, bad, ACCEPT_EXPERIMENT).ok, false, bad);
});

test("W1 C preserves CRLF/LF and protected markers without trim or normalization", () => {
	const w1 = requireW1(), source = "中文\r\n`code`\r\nEnglish", plan = planFor(source), safe = w1.buildSafeContext(plan, {}), request = w1.buildWholeMessageRequest(plan, safe, {}), marker = safe.markers[0].token, output = `中文\r\n${marker}\r\n英文`;
	const valid = w1.validateWholeMessageResponse(request, output, ACCEPT_EXPERIMENT);
	assert.equal(valid.ok, true);
	assert.equal(valid.translation.includes("`code`"), true);
	assert.equal((valid.translation.match(/\r\n/g) || []).length, 2);
	assert.equal(w1.validateWholeMessageResponse(request, output + "\n", ACCEPT_EXPERIMENT).ok, false);
});

test("W1 C detects multiple protected marker loss duplication and reordering", () => {
	const w1 = requireW1(), source = "中文\n`code one`\nEnglish\n“4-3”\nMore English", plan = planFor(source), safe = w1.buildSafeContext(plan, {}), request = w1.buildWholeMessageRequest(plan, safe, {}), [first, second] = safe.contextMarkers.map(row => row.token), good = `中文\n${first}\n英文\n${second}\n更多英文`;
	assert.equal(w1.validateWholeMessageResponse(request, good, ACCEPT_EXPERIMENT).ok, true);
	assert.equal(w1.validateWholeMessageResponse(request, good.replace(first, ""), ACCEPT_EXPERIMENT).reason, "protected-mismatch");
	assert.equal(w1.validateWholeMessageResponse(request, good.replace(first, first + first), ACCEPT_EXPERIMENT).reason, "protected-mismatch");
	assert.equal(w1.validateWholeMessageResponse(request, good.replace(first, "TEMP").replace(second, first).replace("TEMP", second), ACCEPT_EXPERIMENT).reason, "protected-order-mismatch");
});

test("W1 C catches merged lines, changed target prose, Markdown damage and wrong-language output", () => {
	const w1 = requireW1(), source = "中文锚点\n> English quote\n||English spoiler||\n| English | Value |\n| --- | --- |", plan = planFor(source), safe = w1.buildSafeContext(plan, {}), request = w1.buildWholeMessageRequest(plan, safe, {}), good = "中文锚点\n> 中文引用\n||中文隐藏||\n| 中文 | 数值 |\n| --- | --- |";
	assert.equal(w1.validateWholeMessageResponse(request, good, ACCEPT_EXPERIMENT).ok, true);
	assert.equal(w1.validateWholeMessageResponse(request, good.replace("\n> ", "> "), ACCEPT_EXPERIMENT).ok, false);
	assert.equal(w1.validateWholeMessageResponse(request, good.replace("中文锚点", "改写锚点"), ACCEPT_EXPERIMENT).reason, "preserve-target-changed");
	assert.equal(w1.validateWholeMessageResponse(request, good.replace("||中文隐藏||", "中文隐藏"), ACCEPT_EXPERIMENT).reason, "markdown-mismatch");
	assert.equal(w1.validateWholeMessageResponse(request, good, {likelyTarget: () => false, experimentalOracle: () => true}).reason, "wrong-language");
});

test("W1 C fails closed on semantic order, same-line adornment and deleted translate slots without an oracle", () => {
	const w1 = requireW1(), source = "中文一\n- Apple\n- Banana\n中文二", request = w1.buildWholeMessageRequest(planFor(source), {}, {});
	const unverifiable = [
		"中文一\n- 苹果\n- 香蕉\n中文二",
		"中文一\n- 香蕉\n- 苹果\n中文二",
		"中文一\n- 苹果（翻译完成）\n- 香蕉\n中文二",
		"中文一\n- \n- 香蕉\n中文二"
	];
	for (const response of unverifiable) assert.equal(w1.validateWholeMessageResponse(request, response, {likelyTarget: () => true}).ok, false);
	for (const response of unverifiable.slice(0, 3)) assert.equal(w1.validateWholeMessageResponse(request, response, {likelyTarget: () => true}).reason, "semantic-order-undetectable");
});

test("W1 C rejects preserve duplication, huge output, residual foreign text and unknown markers before oracle", () => {
	const w1 = requireW1(), source = "中文说明\nDegree of Interest\nGraduate", request = w1.buildWholeMessageRequest(planFor(source), {}, {}), good = "中文说明\n意向学位\n研究生";
	assert.equal(w1.validateWholeMessageResponse(request, good.replace("中文说明", "中文说明中文说明"), ACCEPT_EXPERIMENT).reason, "preserve-target-changed");
	assert.equal(w1.validateWholeMessageResponse(request, "中文说明\n" + "译".repeat(10000) + "\n研究生", ACCEPT_EXPERIMENT).reason, "length-anomaly");
	assert.equal(w1.validateWholeMessageResponse(request, "中文说明\n意向学位\nGraduate", ACCEPT_EXPERIMENT).reason, "untranslated-residual");
	assert.equal(w1.validateWholeMessageResponse(request, good + "⟦999⟧", ACCEPT_EXPERIMENT).reason, "unknown-marker");
	assert.equal(w1.validateWholeMessageResponse(request, good + "⟦C8⟧", ACCEPT_EXPERIMENT).reason, "unknown-marker");
});

test("W1 C protects user marker lookalikes and restores them under an experimental oracle", () => {
	const w1 = requireW1(), source = "中文 ⟦C0⟧ and ⟦W9⟧ English", plan = planFor(source), safe = w1.buildSafeContext(plan, {}), request = w1.buildWholeMessageRequest(plan, safe, {});
	assert.equal(safe.context.includes("⟦C0⟧"), false);
	assert.equal(safe.context.includes("⟦W9⟧"), false);
	const output = request.wire.replace("English", "英文").replace("and", "和"), validated = w1.validateWholeMessageResponse(request, output, ACCEPT_EXPERIMENT);
	assert.equal(validated.ok, true);
	assert.equal(validated.translation.includes("⟦C0⟧"), true);
	assert.equal(validated.translation.includes("⟦W9⟧"), true);
});
