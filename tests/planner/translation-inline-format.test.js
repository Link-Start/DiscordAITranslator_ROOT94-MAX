const test = require("node:test");
const assert = require("node:assert/strict");
const {createSemanticRequest, validateSemanticResponse, planSemanticRepair} = require("../../src/planner/translation-semantic-runtime");
const {validateReceivedMarkdownPlan} = require("../../src/planner/received-markdown-lossless-planner");
const {createSemanticWorkloadKey, assessLegacyCacheEntry} = require("../../src/planner/translation-semantic-revision");

const requestFor = source => createSemanticRequest({engineKey: "custom-format-fixture", source, inputLanguageId: "en", targetLanguageId: "zh-CN"});
const validate = (request, text) => validateSemanticResponse(request, {segments: [{id: "s1", translation: text}]}, {likelyTarget: value => /\p{Script=Han}/u.test(value), softKeep: false});

test("inline bold keeps the complete publication restriction in one translation unit and permits natural Chinese word order", () => {
	const request = requestFor("Please **do not publish** the draft before Friday.");
	assert.equal(request.enabled, true);
	assert.deepEqual(JSON.parse(request.wire).segments.map(segment => segment.text), ["Please ⟦F0⟧do not publish⟦/F0⟧ the draft before Friday."]);
	assert.equal(validateReceivedMarkdownPlan(request.plan).valid, true);
	const outcome = validate(request, "请在周五之前⟦F0⟧不要发布⟦/F0⟧这份草稿。");
	assert.equal(outcome.ok, true);
	assert.equal(outcome.translation, "请在周五之前**不要发布**这份草稿。");
});

test("a nested formatted link moves with its translated label while its destination stays local and exact", () => {
	const request = requestFor("Please read [the **updated** schedule](https://example.com/a_(b)?x=1#top) before Friday.");
	assert.deepEqual(JSON.parse(request.wire).segments.map(segment => segment.text), ["Please read ⟦F0⟧the ⟦F1⟧updated⟦/F1⟧ schedule⟦/F0⟧ before Friday."]);
	assert.equal(validateReceivedMarkdownPlan(request.plan).valid, true);
	const outcome = validate(request, "请在周五之前阅读⟦F0⟧⟦F1⟧更新后的⟦/F1⟧日程表⟦/F0⟧。");
	assert.equal(outcome.ok, true);
	assert.equal(outcome.translation, "请在周五之前阅读[**更新后的**日程表](https://example.com/a_(b)?x=1#top)。");
});

test("format validation rejects reversed, crossing, reparented and empty spans despite a complete token multiset", () => {
	const request = requestFor("Please **read the *updated* report** before Friday.");
	assert.equal(JSON.parse(request.wire).segments.length, 1);
	for (const text of [
		"请在周五前⟦/F0⟧阅读⟦F1⟧更新后的⟦/F1⟧报告⟦F0⟧。",
		"请在周五前⟦F0⟧阅读⟦F1⟧更新后的⟦/F0⟧报告⟦/F1⟧。",
		"请在周五前⟦F0⟧阅读报告⟦/F0⟧⟦F1⟧更新后的⟦/F1⟧。",
		"请在周五前⟦F0⟧阅读⟦F1⟧⟦/F1⟧更新后的报告⟦/F0⟧。"
	]) {
		const outcome = validate(request, text);
		assert.equal(outcome.ok, false, text);
		assert.equal(outcome.reason, "placeholder-mismatch");
	}
	assert.equal(validate(request, "请在周五前⟦F0⟧阅读⟦F1⟧更新后的⟦/F1⟧报告⟦/F0⟧。").ok, true);
});

test("formatted sentences explain paired markers once and reject cached translations from the fragmented contract", () => {
	const request = requestFor("Please **do not publish** the draft before Friday.");
	const previous = createSemanticWorkloadKey({plannerVersion: request.plan.plannerVersion, languagePair: "en:zh-CN", providerSemanticRevision: request.semanticRevision});
	assert.notEqual(request.workload.key, previous.key);
	assert.equal(assessLegacyCacheEntry({kind: "translation", planHash: "same-source", workloadKey: previous.key, validatorVersion: previous.fields.validatorVersion, outputSchemaVersion: previous.fields.outputSchemaVersion}, {planHash: "same-source", workloadKey: request.workload.key}).read, false);
	assert.match(request.systemPrompt, /paired.*⟦F0⟧.*⟦\/F0⟧/i);
	const plain = requestFor("Please do not publish the draft before Friday.");
	assert.notEqual(plain.workload.key, previous.key, "explicit name permission has its own workload version");
	assert.equal(plain.workload.fields.nameKeepVersion, "explicit-name-keep-v1");
	assert.doesNotMatch(plain.systemPrompt, /⟦F0⟧/);
});

test("inline emphasis, underline, strike and spoilers retain their exact delimiters after whole-sentence translation", () => {
	for (const marker of ["**", "*", "__", "_", "~~", "||", "***", "___"]) {
		const request = requestFor(`We will ${marker}send the final report${marker} after the review is complete.`);
		const triple = marker.length === 3;
		assert.deepEqual(JSON.parse(request.wire).segments.map(segment => segment.text), [triple ? "We will ⟦F0⟧⟦F1⟧send the final report⟦/F1⟧⟦/F0⟧ after the review is complete." : "We will ⟦F0⟧send the final report⟦/F0⟧ after the review is complete."]);
		const outcome = validate(request, triple ? "审核完成后，我们会⟦F0⟧⟦F1⟧发送最终报告⟦/F1⟧⟦/F0⟧。" : "审核完成后，我们会⟦F0⟧发送最终报告⟦/F0⟧。");
		assert.equal(outcome.ok, true);
		assert.equal(outcome.translation, `审核完成后，我们会${marker}发送最终报告${marker}。`);
	}
});

test("independent formatted spans can move without swapping their own identities", () => {
	const request = requestFor("Send **the report** to *Alice* before Friday.");
	const outcome = validate(request, "请在周五前向⟦F1⟧Alice⟦/F1⟧发送⟦F0⟧报告⟦/F0⟧。");
	assert.equal(outcome.ok, true);
	assert.equal(outcome.translation, "请在周五前向*Alice*发送**报告**。");
});

test("block layout and fenced code stay local while each formatted line remains complete", () => {
	const source = "> **Read the report** before Friday.\r\n- Visit [the guide](https://example.com/guide) after Monday.\n```js\nconst text = '**not prose**';\n```";
	const request = requestFor(source), wire = JSON.parse(request.wire);
	assert.deepEqual(wire.segments.map(segment => segment.text), ["⟦F0⟧Read the report⟦/F0⟧ before Friday.", "Visit ⟦F0⟧the guide⟦/F0⟧ after Monday."]);
	assert.equal(validateReceivedMarkdownPlan(request.plan).valid, true);
	const outcome = validateSemanticResponse(request, {segments: [{id: "s1", translation: "请在周五之前⟦F0⟧阅读报告⟦/F0⟧。"}, {id: "s2", translation: "请在周一之后查看⟦F0⟧指南⟦/F0⟧。"}]}, {likelyTarget: () => true});
	assert.equal(outcome.translation, "> 请在周五之前**阅读报告**。\r\n- 请在周一之后查看[指南](https://example.com/guide)。\n```js\nconst text = '**not prose**';\n```");
});

test("an invalid formatting response repairs only its complete sentence and retains valid siblings", () => {
	const request = requestFor("Please **do not publish** the draft before Friday.\nThe meeting starts tomorrow.");
	const first = validateSemanticResponse(request, {segments: [{id: "s1", translation: "请在周五前⟦/F0⟧不要发布⟦F0⟧草稿。"}, {id: "s2", translation: "会议明天开始。"}]}, {likelyTarget: () => true});
	assert.equal(first.ok, false);
	const repair = planSemanticRepair(request, first, {parentSettled: true});
	assert.equal(repair.dispatchable, true);
	assert.equal(repair.requests.length, 1);
	assert.deepEqual(JSON.parse(repair.requests[0].wire).segments.map(segment => segment.text), ["Please ⟦F0⟧do not publish⟦/F0⟧ the draft before Friday."]);
	const done = validateSemanticResponse(repair.requests[0], {segments: [{id: "s1", translation: "请在周五前⟦F0⟧不要发布⟦/F0⟧草稿。"}]}, {priorValid: first.valid, likelyTarget: () => true});
	assert.equal(done.ok, true);
	assert.equal(done.translation, "请在周五前**不要发布**草稿。\n会议明天开始。");
});

test("adjacent closing emphasis delimiters retain nested scopes without fragmenting the sentence", () => {
	for (const [source, text, translated] of [
		["Please **read *this*** before Friday.", "Please ⟦F0⟧read ⟦F1⟧this⟦/F1⟧⟦/F0⟧ before Friday.", "请在周五前⟦F0⟧阅读⟦F1⟧这份资料⟦/F1⟧⟦/F0⟧。"],
		["Please ***read* this** before Friday.", "Please ⟦F0⟧⟦F1⟧read⟦/F1⟧ this⟦/F0⟧ before Friday.", "请在周五前⟦F0⟧⟦F1⟧阅读⟦/F1⟧这份资料⟦/F0⟧。"]
	]) {
		const request = requestFor(source);
		assert.deepEqual(JSON.parse(request.wire).segments.map(segment => segment.text), [text]);
		assert.equal(validateReceivedMarkdownPlan(request.plan).valid, true);
		const outcome = validate(request, translated);
		assert.equal(outcome.ok, true);
		assert.equal(outcome.translation, source.startsWith("Please **read ") ? "请在周五前**阅读*这份资料***。" : "请在周五前***阅读*这份资料**。");
	}
});

test("a plain message rejects format tokens copied from another batch item but keeps literal source lookalikes", () => {
	const plain = requestFor("Please read the report before Friday.");
	assert.equal(validate(plain, "请在周五前⟦F0⟧阅读报告⟦/F0⟧。").reason, "placeholder-mismatch");
	const literal = requestFor("Please keep the literal label ⟦F0⟧ in this example.");
	const result = validate(literal, "请保留这个示例中的字面标签 ⟦F0⟧。");
	assert.equal(result.ok, true);
	assert.equal(result.translation, "请保留这个示例中的字面标签 ⟦F0⟧。");
});

test("unbalanced formatting retains the previous complete protected-node ranges", () => {
	const source = "Please *ask ⟦8⟧ to review ⟦3⟧ before Friday.";
	const request = requestFor(source);
	assert.deepEqual(JSON.parse(request.wire).segments.map(segment => segment.text), ["Please ", "ask ⟦8⟧ to review ⟦3⟧ before Friday."]);
	assert.equal(validateReceivedMarkdownPlan(request.plan).valid, true);
});

test("a single literal tilde does not create an extra translation segment", () => {
	const source = "Please send ~ten reports before Friday.";
	assert.deepEqual(JSON.parse(requestFor(source).wire).segments.map(segment => segment.text), [source]);
});

test("local restoration never interprets formatting lookalikes inside a link destination", () => {
	const source = "Please read [the guide](https://example.com/⟦F1⟧) and **the report** before Friday.";
	const result = validate(requestFor(source), "请在周五前阅读⟦F0⟧指南⟦/F0⟧和⟦F1⟧报告⟦/F1⟧。");
	assert.equal(result.ok, true);
	assert.equal(result.translation, "请在周五前阅读[指南](https://example.com/⟦F1⟧)和**报告**。");
});

test("a local code token containing a formatting lookalike is restored only once", () => {
	const request = requestFor("Keep `⟦F0⟧` while **reading the guide**.");
	const result = validate(request, "保留 ⟦C0⟧ 并⟦F0⟧阅读指南⟦/F0⟧。");
	assert.equal(result.ok, true);
	assert.equal(result.translation, "保留 `⟦F0⟧` 并**阅读指南**。");
});
