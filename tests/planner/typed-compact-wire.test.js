const test = require("node:test");
const assert = require("node:assert/strict");

const {planReceivedMarkdown} = require("../../src/planner/received-markdown-lossless-planner");
const {compileTypedPlan, resolveTypedRowAliases, typedBatchItemPayload, TYPED_WIRE_VERSION} = require("../../src/planner/translation-plan-serializer");
const {createSemanticRequest, validateSemanticResponse, planSemanticRepair} = require("../../src/planner/translation-semantic-runtime");

const BOOKKEEPING_KEYS = ["semanticRevision", "document", "plannerVersion", "sourceLength", "direction", "fieldPath", "dataOnly", "output"];
const PLAIN = "Can anyone check the schedule before tomorrow's meeting? I might be a bit late.";
const STRUCTURED = "Team update:\n- deploy is done\n- **do not** restart the bot before 10:30\n> old note: keep logs\nThanks!";
const judge = {likelyTarget: value => /\p{Script=Han}/u.test(String(value || "")), similarity: () => 0};

test("typed-compact-v1 sends short labels and no client bookkeeping, and maps every label back to its plan id", () => {
	const typed = compileTypedPlan(planReceivedMarkdown(STRUCTURED, {targetLanguageId: "zh-CN"}));
	assert.equal(typed.ok, true);
	assert.equal(typed.wireVersion, TYPED_WIRE_VERSION);
	assert.deepEqual(Object.keys(typed.payload), ["schemaVersion", "targetLanguageId", "segments", "contexts"]);
	assert.deepEqual(typed.payload.segments.map(row => row.id), ["s1", "s2", "s3", "s4", "s5", "s6"]);
	assert.deepEqual(typed.payload.segments.map(row => typed.aliases[row.id]), typed.segmentOrder);
	assert.equal(typed.segmentOrder.every(id => id.startsWith("m3i-")), true, "segmentOrder keeps the real plan ids");
	assert.equal(typed.payload.segments.filter(row => "contextIds" in row).length, 4, "only segments inside a context carry contextIds");
	assert.deepEqual(typed.payload.contexts.map(row => row.id), ["c1", "c2", "c3"]);
	for (const row of typed.payload.contexts) {
		assert.equal(typeof row.type, "string");
		for (const key of Object.keys(row)) assert.equal(["id", "type", "parentId", "previousSiblingId", "nextSiblingId"].includes(key), true, key);
		for (const key of ["parentId", "previousSiblingId", "nextSiblingId"]) if (key in row) assert.match(row[key], /^c\d+$/);
	}
	for (const key of BOOKKEEPING_KEYS) assert.equal(typed.body.includes(`"${key}"`), false, `${key} must not reach the model`);
	assert.equal(typed.body.includes("m3i-"), false, "plan ids never leave the client");
	assert.equal(typed.body.includes("ctx|"), false);
});

test("a plain message serializes to one labelled segment with no contexts key", () => {
	const typed = compileTypedPlan(planReceivedMarkdown(PLAIN, {targetLanguageId: "zh-CN"}));
	assert.deepEqual(typed.payload, {schemaVersion: "segment-json-v2", targetLanguageId: "zh-CN", segments: [{id: "s1", text: PLAIN, allowNameKeep: true}]});
	assert.ok(typed.bodyBytes < 200, `compact single wire is ${typed.bodyBytes} bytes`);
	assert.deepEqual(typedBatchItemPayload(typed.payload), {segments: [{id: "s1", text: PLAIN, allowNameKeep: true}]}, "batch items drop the per-request marker and target language");
});

test("resolveTypedRowAliases maps known labels to plan ids and leaves everything else alone", () => {
	const aliases = {s1: "plan-a", s2: "plan-b"};
	assert.deepEqual(resolveTypedRowAliases([{id: "s2", translation: "乙"}, {id: "s1", translation: "甲"}, {id: "s9", translation: "?"}, {id: "plan-a", translation: "直"}, null, "x"], aliases), [
		{id: "plan-b", translation: "乙"}, {id: "plan-a", translation: "甲"}, {id: "s9", translation: "?"}, {id: "plan-a", translation: "直"}, null, "x"
	]);
	assert.equal(resolveTypedRowAliases(null, aliases), null);
	assert.deepEqual(resolveTypedRowAliases([{id: "s1", translation: "甲"}], null), [{id: "s1", translation: "甲"}]);
	assert.deepEqual(resolveTypedRowAliases([{id: "__proto__", translation: "x"}], aliases), [{id: "__proto__", translation: "x"}]);
});

test("the semantic request validates labelled answers against plan ids, including missing, unknown and duplicate labels", () => {
	const request = createSemanticRequest({engineKey: "gemini", source: STRUCTURED, targetLanguageId: "zh-CN"});
	assert.equal(request.enabled, true);
	assert.equal(request.wireVersion, TYPED_WIRE_VERSION);
	assert.deepEqual(Object.keys(request.segmentAliases), ["s1", "s2", "s3", "s4", "s5"]);
	const answers = ["团队更新：", " 部署已完成", "在 10:30 之前⟦F0⟧不要⟦/F0⟧重启机器人", " 旧备注：保留日志", "谢谢！"];
	const reply = labels => JSON.stringify({segments: labels.map(label => ({id: label, translation: answers[Number(label.slice(1)) - 1]}))});
	const ok = validateSemanticResponse(request, reply(["s1", "s2", "s3", "s4", "s5"]), judge);
	assert.equal(ok.ok, true, ok.reason);
	assert.deepEqual(Object.keys(ok.valid).sort(), request.segmentOrder.slice().sort(), "valid is keyed by plan ids");
	assert.equal(ok.translation, "团队更新：\n- 部署已完成\n- 在 10:30 之前**不要**重启机器人\n> 旧备注：保留日志\n谢谢！");

	const missing = validateSemanticResponse(request, reply(["s1", "s2", "s3"]), judge);
	assert.equal(missing.ok, false);
	assert.equal(missing.reason, "missing-id");
	assert.deepEqual(missing.invalidIds, request.segmentOrder.slice(3), "missing ids are reported as plan ids");

	const unknown = validateSemanticResponse(request, JSON.stringify({segments: [{id: "s7", translation: "多余"}]}), judge);
	assert.equal(unknown.ok, false);
	assert.equal(unknown.reason, "unknown-id");

	const duplicate = validateSemanticResponse(request, reply(["s1", "s1", "s2", "s3", "s4", "s5"]), judge);
	assert.equal(duplicate.ok, false);
	assert.equal(duplicate.reason, "duplicate-id");
});

test("a repair round renumbers its labels from s1 and still completes the original plan", () => {
	const request = createSemanticRequest({engineKey: "gemini", source: STRUCTURED, targetLanguageId: "zh-CN"});
	const partial = validateSemanticResponse(request, JSON.stringify({segments: [
		{id: "s1", translation: "团队更新："}, {id: "s2", translation: " 部署已完成"}, {id: "s3", translation: "在 10:30 之前⟦F0⟧不要⟦/F0⟧重启机器人"}
	]}), judge);
	assert.equal(partial.ok, false);
	const repair = planSemanticRepair(request, partial, {parentSettled: true});
	assert.equal(repair.dispatchable, true, repair.reason);
	const next = repair.requests[0];
	assert.deepEqual(JSON.parse(next.wire).segments.map(row => row.id), ["s1", "s2"], "the repair wire starts its labels over");
	assert.deepEqual(Object.values(next.segmentAliases), request.segmentOrder.slice(3), "but its table points at the two failed plan ids");
	const fixed = validateSemanticResponse(next, JSON.stringify({segments: [{id: "s1", translation: " 旧备注：保留日志"}, {id: "s2", translation: "谢谢！"}]}), Object.assign({priorValid: partial.valid}, judge));
	assert.equal(fixed.ok, true, fixed.reason);
	assert.equal(fixed.translation, "团队更新：\n- 部署已完成\n- 在 10:30 之前**不要**重启机器人\n> 旧备注：保留日志\n谢谢！");
});

test("the compact wire keeps the semantic identity of the request unchanged", () => {
	const request = createSemanticRequest({engineKey: "oaicompat", source: PLAIN, targetLanguageId: "zh-CN"});
	assert.equal(request.semanticRevision, "s8b-p2-v1", "cache and workload identities do not move with the wire encoding");
	assert.match(request.systemPrompt, /Read targetLanguageId from the request/);
	assert.equal(JSON.parse(request.wire).targetLanguageId, "zh-CN");
	assert.doesNotMatch(request.wire, /semanticRevision|plannerVersion|"document"/);
});
