const test = require("node:test");
const assert = require("node:assert/strict");

const {planReceivedMarkdown} = require("../../src/planner/received-markdown-lossless-planner");
const {validateSegmentResponse} = require("../../src/planner/translation-segment-validator");
const {createSemanticRequest, validateSemanticResponse} = require("../../src/planner/translation-semantic-runtime");

const plan = planReceivedMarkdown("I am hungry", {targetLanguageId: "zh-CN"});
const id = plan.nodes.find(node => node.classification === "translate").id;
const accept = {likelyTarget: () => true, similarity: () => 0};

test("an answer that wraps the untouched source in target-language words is wrong-language", () => {
	for (const translation of ["翻译：I am hungry", "I am hungry（我饿了）", "这句话是 I am hungry"]) {
		const result = validateSegmentResponse(plan, [{id, translation}], accept);
		assert.deepEqual(result.invalid, [{id, reason: "wrong-language"}], translation);
	}
});

test("a real translation, short sources and tokenised sentences are not caught by the containment guard", () => {
	assert.deepEqual(validateSegmentResponse(plan, [{id, translation: "我饿了"}], accept).valid, {[id]: "我饿了"});
	// Whitespace differences do not hide an untouched source.
	assert.deepEqual(validateSegmentResponse(plan, [{id, translation: "I  am hungry 。"}], accept).invalid, [{id, reason: "wrong-language"}]);
	const shortPlan = planReceivedMarkdown("GG", {targetLanguageId: "zh-CN"}), shortId = shortPlan.nodes.find(node => node.classification === "translate").id;
	assert.deepEqual(validateSegmentResponse(shortPlan, [{id: shortId, translation: "GG，打得好"}], accept).valid, {[shortId]: "GG，打得好"}, "sources under four letters are names and may be carried over");
	// P2 merges the run around inline code into one segment whose text carries a ⟦C0⟧ token.
	const request = createSemanticRequest({engineKey: "gemini", source: "run `npm test` before you publish", targetLanguageId: "zh-CN"});
	const outcome = validateSemanticResponse(request, JSON.stringify({segments: [{id: "s1", translation: "发布前先运行 ⟦C0⟧"}]}), {likelyTarget: () => true, similarity: () => 0});
	assert.equal(outcome.ok, true, outcome.reason);
	assert.equal(outcome.translation, "发布前先运行 `npm test`");
});

test("the semantic validator accepts a name-heavy Chinese answer with the production judge shape", () => {
	const request = createSemanticRequest({engineKey: "gemini", source: "Use Adobe Audition or Ultimate Vocal Remover (UVR)", targetLanguageId: "zh-CN"});
	const hasChinese = value => /[一-鿿]/.test(String(value || ""));
	const ok = validateSemanticResponse(request, JSON.stringify({segments: [{id: "s1", translation: "使用 Adobe Audition 或 Ultimate Vocal Remover (UVR)"}]}), {likelyTarget: hasChinese, similarity: () => 0});
	assert.equal(ok.ok, true, ok.reason);
	assert.equal(ok.translation, "使用 Adobe Audition 或 Ultimate Vocal Remover (UVR)");
	const echo = validateSemanticResponse(request, JSON.stringify({segments: [{id: "s1", translation: "Use Adobe Audition or Ultimate Vocal Remover (UVR)"}]}), {likelyTarget: hasChinese, similarity: () => 0, softKeep: false});
	assert.equal(echo.ok, false);
	assert.equal(echo.reason, "wrong-language");
});
