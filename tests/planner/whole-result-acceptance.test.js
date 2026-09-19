const test = require("node:test");
const assert = require("node:assert/strict");
const {createSemanticRequest, validateSemanticResponse, planSemanticRepair, isPlanTranslationMeaningful} = require("../../src/planner/translation-semantic-runtime");
const {planReceivedMarkdown, reassembleReceivedMarkdown, validateReceivedMarkdownPlan} = require("../../src/planner/received-markdown-lossless-planner");

test("embedded aliases remain eligible for context-aware translation without changing the source", () => {
	for (const source of ["nora的alpha5是正常的，5.1有问题", "这个 zephyr 客户端已经更新了", "nora已经修复了这个问题"]) {
		const plan = planReceivedMarkdown(source, {targetLanguageId: "zh-CN"});
		assert.equal(validateReceivedMarkdownPlan(plan).valid, true);
		assert.equal(isPlanTranslationMeaningful(plan), true, source);
		assert.equal(reassembleReceivedMarkdown(plan), source);
	}
});

test("preserving inline terms does not hide a foreign sentence or an independent foreign title", () => {
	for (const source of ["你好\nPlease restart the app.", "这是中文说明。\n## Degree of Interest", "请阅读 Please restart the app.", "Please restart nora."]) {
		const plan = planReceivedMarkdown(source, {targetLanguageId: "zh-CN"});
		assert.equal(isPlanTranslationMeaningful(plan), true, source);
		assert.equal(reassembleReceivedMarkdown(plan), source);
	}
});

test("an unresolved segment cannot commit the successful part as a complete translation", () => {
	const request = createSemanticRequest({engineKey: "oaicompat", source: "Please open the app.\nplease restart the server.", targetLanguageId: "zh-CN"});
	const judges = {likelyTarget: value => /[\p{Script=Han}]/u.test(value), similarity: (a, b) => a.trim() === b.trim() ? 1 : 0};
	const rows = req => ({segments: JSON.parse(req.wire).segments.map(row => ({id: row.id, translation: row.text.startsWith("Please open") ? "请打开应用。" : row.text}))});
	let current = request, outcome = validateSemanticResponse(current, rows(current), judges);
	assert.equal(outcome.ok, false);
	for (let round = 0; round < 2; round++) {
		const repair = planSemanticRepair(current, outcome, {parentSettled: true});
		assert.equal(repair.dispatchable, true);
		current = repair.requests[0];
		outcome = validateSemanticResponse(current, rows(current), {...judges, priorValid: outcome.valid});
		assert.equal(outcome.ok, false, "an exhausted soft failure remains a failure");
		assert.equal(outcome.translation, null, "no partial message is publishable");
		assert.equal(outcome.keptCount, 0);
	}
	assert.equal(planSemanticRepair(current, outcome, {parentSettled: true}).dispatchable, false);
});
