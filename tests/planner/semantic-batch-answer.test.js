const test = require("node:test");
const assert = require("node:assert/strict");
const {BATCH_ANSWER_SHAPES, readSemanticBatchAnswer} = require("../../src/planner/semantic-batch-answer");

// Two messages labelled m1/m2 on the wire; m1 has one segment, m2 has two.
const LABELS = new Map([["m1", "msg-a"], ["m2", "msg-b"]]);
const PLAN_SEGMENTS = {"msg-a": ["s1"], "msg-b": ["s1", "s2"]};
const options = {expectedIds: ["msg-a", "msg-b"], resolveId: id => LABELS.has(id) ? LABELS.get(id) : id, planSegmentIdsFor: id => PLAN_SEGMENTS[id] || null};
const read = content => readSemanticBatchAnswer(typeof content === "string" ? content : JSON.stringify(content), options);
const ids = result => Object.keys(result.translations || {}).sort();

test("captured extra closing braces preserve all six messages and seven segments without changing text", () => {
	for (const fixture of require("../fixtures/typed-batch-extra-braces.json").cases) {
		assert.throws(() => JSON.parse(fixture.content), SyntaxError);
		const result = readSemanticBatchAnswer(fixture.content, {expectedIds: ["m1", "m2", "m3", "m4", "m5", "m6"], planSegmentIdsFor: id => id === "m6" ? ["s1", "s2"] : ["s1"]});
		assert.equal(result.structure.parsedMessageCount, 6);
		assert.equal(result.structure.missingSegmentCount, 0);
		assert.deepEqual(result.shapes, ["message-objects"]);
		assert.equal(result.structure.jsonSource, "fragment");
		assert.deepEqual(result.translations, Object.fromEntries(Object.entries(fixture.expected).map(([id, translations]) => [id, {semanticSegments: translations.map((translation, index) => ({id: `s${index + 1}`, translation}))}])));
	}
});

test("a captured premature batch close preserves all ten explicitly addressed messages", () => {
	const fixture = require("../fixtures/typed-batch-premature-close.json");
	const expectedIds = Array.from({length: 10}, (_, index) => `m${index + 1}`);
	const segments = {m3: ["s1", "s2"], m7: ["s1", "s2", "s3"], m8: ["s1", "s2", "s3"], m10: ["s1", "s2"]};
	const result = readSemanticBatchAnswer(fixture.content, {expectedIds, planSegmentIdsFor: id => segments[id] || ["s1"]});
	assert.equal(result.structure.parsedMessageCount, 10, "the first valid prefix must not discard the seven following message objects");
	assert.equal(result.structure.missingSegmentCount, 0);
	assert.deepEqual(result.shapes, ["message-objects"]);
	assert.equal(result.structure.jsonSource, "fragment");
	assert.equal(result.translations.m10.semanticSegments[1].translation, "在开打之前，你还可以再探索一下村子。");
});

test("the canonical answer reads without naming any shape", () => {
	const result = read({messages: [{id: "m1", segments: [{id: "s1", translation: "甲"}]}, {id: "m2", segments: [{id: "s1", translation: "乙"}, {id: "s2", translation: "丙"}]}]});
	assert.deepEqual(ids(result), ["msg-a", "msg-b"]);
	assert.deepEqual(result.shapes, []);
	assert.equal(result.malformed, null);
	assert.equal(result.structure.jsonSource, "whole");
	assert.deepEqual(result.translations["msg-b"].semanticSegments, [{id: "s1", translation: "乙"}, {id: "s2", translation: "丙"}]);
});

test("an answer that mirrors the request nesting (plan.segments) is read and named plan-nested", () => {
	const result = read({messages: [{id: "m1", plan: {segments: [{id: "s1", translation: "甲"}]}}, {id: "m2", plan: {segments: [{id: "s1", translation: "乙"}, {id: "s2", translation: "丙"}]}}]});
	assert.deepEqual(ids(result), ["msg-a", "msg-b"]);
	assert.deepEqual(result.shapes, ["plan-nested"]);
});

test("other list keys, nested envelopes and bare arrays are read and named", () => {
	assert.deepEqual(read({translations: [{id: "m1", segments: [{id: "s1", translation: "甲"}]}]}).shapes, ["alt-list"]);
	assert.deepEqual(read({result: {messages: [{id: "m1", segments: [{id: "s1", translation: "甲"}]}]}}).shapes, ["alt-list"]);
	const bare = read([{id: "m1", segments: [{id: "s1", translation: "甲"}]}]);
	assert.deepEqual(ids(bare), ["msg-a"]);
	assert.deepEqual(bare.shapes, ["bare-array"]);
});

test("an object keyed by message label is read; values may be a segment list, a row or a string", () => {
	const result = read({m1: "甲", m2: {segments: [{id: "s1", translation: "乙"}, {id: "s2", translation: "丙"}]}});
	assert.deepEqual(ids(result), ["msg-a", "msg-b"]);
	assert.deepEqual(result.shapes.sort(), ["id-keyed", "translation-string"]);
	assert.deepEqual(result.translations["msg-a"].semanticSegments, [{id: "s1", translation: "甲"}]);
	const lists = read({m2: [{id: "s1", translation: "乙"}, {id: "s2", translation: "丙"}]});
	assert.deepEqual(ids(lists), ["msg-b"]);
	assert.deepEqual(lists.shapes, ["id-keyed"]);
});

test("a translation string is mapped onto the only segment of a one-segment message and refused for multi-segment ones", () => {
	const result = read({messages: [{id: "m1", translation: "甲"}, {id: "m2", translation: "乙丙"}]});
	assert.deepEqual(ids(result), ["msg-a"], "m2 has two segments, so its string cannot be placed and the row is left for the missing-id repair");
	assert.deepEqual(result.shapes, ["translation-string"]);
	assert.deepEqual(result.translations["msg-a"].semanticSegments, [{id: "s1", translation: "甲"}]);
	assert.deepEqual(read({messages: [{id: "m1", text: "甲"}]}).shapes, ["translation-string"]);
});

test("segment maps and alternative row lists are read", () => {
	assert.deepEqual(read({messages: [{id: "m2", segments: {s1: "乙", s2: {translation: "丙"}}}]}).translations["msg-b"].semanticSegments, [{id: "s1", translation: "乙"}, {id: "s2", translation: "丙"}]);
	assert.deepEqual(read({messages: [{id: "m2", segments: {s1: "乙", s2: "丙"}}]}).shapes, ["segment-map"]);
	assert.deepEqual(read({messages: [{id: "m1", translations: [{id: "s1", translation: "甲"}]}]}).shapes, ["alt-row-list"]);
});

test("real message ids are still accepted and unknown or duplicate ids are left to the validator", () => {
	const result = read({messages: [{id: "msg-a", segments: [{id: "s1", translation: "甲"}]}, {id: "m1", segments: [{id: "s1", translation: "重复"}]}, {id: "m9", segments: [{id: "s1", translation: "多余"}]}]});
	assert.deepEqual(ids(result), ["msg-a"]);
	assert.deepEqual(result.translations["msg-a"].semanticSegments, [], "conflicting aliases require message repair, not first-row-wins");
});

test("complete complementary rows join by explicit message and segment ids, including reversed rows", () => {
	const rows = [{id: "m2", segments: [{id: "s2", translation: "丙 ⟦0⟧"}]}, {id: "m1", segments: [{id: "s1", translation: "甲"}]}, {id: "m2", segments: [{id: "s1", translation: "乙"}]}];
	for (const messages of [rows, rows.slice().reverse()]) {
		const result = read({messages});
		assert.equal(result.malformed, null);
		assert.equal(result.structure.duplicateMessageRowCount, 1);
		assert.equal(result.structure.missingSegmentCount, 0);
		assert.deepEqual(result.translations["msg-b"].semanticSegments.slice().sort((a, b) => a.id.localeCompare(b.id)), [{id: "s1", translation: "乙"}, {id: "s2", translation: "丙 ⟦0⟧"}]);
	}
});

test("ambiguous duplicate rows repair only their message and never invent coverage", () => {
	const first = {id: "m2", segments: [{id: "s1", translation: "乙"}]};
	for (const extra of [
		[{id: "m2", segments: [{id: "s1", translation: "冲突"}, {id: "s2", translation: "丙"}]}],
		[first], [{id: "m2", segments: [{id: "s9", translation: "丙"}]}],
		[{id: "m2", segments: [{id: "s2", translation: ""}]}],
		[{id: "m2", translation: "丙"}], [{id: "m2", segments: []}],
		[{id: "msg-b", segments: [{id: "s2", translation: "丙"}]}],
		[{id: "m2", plan: {segments: [{id: "s2", translation: "丙"}]}}]
	]) {
		const result = read({messages: [{id: "m1", segments: [{id: "s1", translation: "甲"}]}, first, ...extra]});
		assert.deepEqual(result.translations["msg-b"].semanticSegments, [], JSON.stringify(extra));
		assert.equal(result.translations["msg-a"].semanticSegments[0].translation, "甲");
		assert.equal(result.structure.missingSegmentCount, 2);
		assert.equal(result.malformed, null, "one ambiguous message must not trigger whole-batch legacy fallback");
	}
	const incomplete = readSemanticBatchAnswer(JSON.stringify({messages: [first, {id: "m2", segments: [{id: "s2", translation: "丙"}]}]}), {...options, planSegmentIdsFor: () => ["s1", "s2", "s3"]});
	assert.deepEqual(incomplete.translations["msg-b"].semanticSegments, []);
});

test("unusable answers are classified without guessing", () => {
	const outcome = content => {const {structure, ...result} = read(content); return result;};
	assert.deepEqual(outcome(""), {translations: null, shapes: [], malformed: "malformed-empty"});
	assert.deepEqual(outcome("Sorry, I cannot translate this batch."), {translations: null, shapes: [], malformed: "malformed-not-json"});
	assert.deepEqual(outcome({status: "ok"}), {translations: null, shapes: [], malformed: "malformed-no-rows"});
	assert.deepEqual(outcome({messages: [{id: "m9", segments: [{id: "s1", translation: "x"}]}]}), {translations: null, shapes: [], malformed: "malformed-unknown-ids"});
	assert.deepEqual(outcome({messages: [{id: "m2", translation: "no place for this string"}]}), {translations: null, shapes: [], malformed: "malformed-no-segments"});
	assert.deepEqual(read("```json\n" + JSON.stringify({messages: [{id: "m1", segments: [{id: "s1", translation: "甲"}]}]}) + "\n```").shapes, [], "a fenced canonical answer is canonical");
});

test("empty lists, absent ids and a single-message envelope have different failure diagnoses", () => {
	assert.equal(read({messages: []}).malformed, "malformed-empty-list");
	assert.equal(read({messages: [{translation: "甲"}]}).malformed, "malformed-missing-id-fields");
	assert.equal(read({messages: [{messageId: "m1", segments: [{id: "s1", translation: "甲"}]}]}).malformed, "malformed-missing-id-fields", "nested segment ids must not be mistaken for message ids");
	assert.equal(read({segments: [{id: "s1", translation: "甲"}]}).malformed, "malformed-segment-root");
	assert.equal(read({messages: [{id: "m9", segments: [{id: "s1", translation: "甲"}]}]}).malformed, "malformed-unknown-ids");
});

test("an unreadable segment root reports ID categories without guessing message ownership", () => {
	const result = read({segments: [{id: "s1", translation: "PRIVATE_OUTPUT"}, {id: "s1", translation: "PRIVATE_OUTPUT"}, {id: "PRIVATE_ID", translation: "PRIVATE_OUTPUT"}]});
	assert.equal(result.malformed, "malformed-segment-root");
	assert.equal(result.translations, null);
	assert.equal(result.structure.rootRowCount, 3);
	assert.equal(result.structure.rootMessageIdRowCount, 0);
	assert.equal(result.structure.rootSegmentIdRowCount, 2);
	assert.doesNotMatch(JSON.stringify(result.structure), /PRIVATE/);
});

test("structural diagnostics distinguish missing messages, unreadable messages and missing segments without retaining content", () => {
	const result = read({messages: [{id: "m1", segments: []}, {id: "m2", translation: "SECRET_TEXT"}, {translation: "SECRET_TEXT"}, {id: "SECRET_ID", translation: "SECRET_TEXT"}]});
	assert.equal(result.structure.expectedMessageCount, 2);
	assert.equal(result.structure.rowCount, 4);
	assert.equal(result.structure.recognizedMessageCount, 2);
	assert.equal(result.structure.parsedMessageCount, 1);
	assert.equal(result.structure.missingMessageCount, 0);
	assert.equal(result.structure.unreadableMessageCount, 1);
	assert.equal(result.structure.missingSegmentCount, 1);
	assert.equal(result.structure.missingIdRowCount, 1);
	assert.equal(result.structure.unknownIdRowCount, 1);
	assert.equal(read({messages: [{id: "m1", translation: "甲"}]}).structure.missingMessageCount, 1);
	assert.doesNotMatch(JSON.stringify(result.structure), /SECRET/);
});

test("broken quoting cannot promote a JSON example inside translation text into a message answer", () => {
	const a = {id: "m1", segments: [{id: "s1", translation: "第一条真实译文"}]};
	const example = {id: "m2", segments: [{id: "s1", translation: "正文内示例对象"}]};
	const input = '{"messages":[' + JSON.stringify(a) + ',{"id":"m2","segments":[{"id":"s1","translation":"请复制这个示例 ' + JSON.stringify(example) + ' 然后继续操作。"}]}]}';
	const result = readSemanticBatchAnswer(input, {expectedIds: ["m1", "m2"], planSegmentIdsFor: () => ["s1"]});
	assert.equal(result.translations, null);
	assert.equal(result.shapes.includes("message-objects"), false);
});

test("fragment recovery requires every explicit message id exactly once and never expands a valid document", () => {
	const a = {id: "m1", segments: [{id: "s1", translation: "甲"}]};
	const b = {id: "m2", segments: [{id: "s1", translation: "乙"}, {id: "s2", translation: "丙"}]};
	const malformed = rows => `{"messages":[${rows.map(row => JSON.stringify(row)).join(",")},]}`;
	assert.deepEqual(read(malformed([b, a])).shapes, ["message-objects"], "explicit ids work in reversed order");
	for (const rows of [[a], [a, {...b, id: "m9"}], [a, b, {...a, id: "msg-a", segments: [{id: "s1", translation: "冲突"}]}]]) {
		assert.equal(read(malformed(rows)).shapes.includes("message-objects"), false, "missing, unknown or conflicting ids cannot be recovered by position");
	}
	assert.equal(read(malformed([a, a, b])).shapes.includes("message-objects"), false, "identical duplicate rows still violate unique message coverage");
	const quotedExample = {...a, segments: [{id: "s1", translation: "请复制 " + JSON.stringify(b)}]};
	assert.equal(read(malformed([quotedExample, b])).translations["msg-a"].semanticSegments[0].translation, quotedExample.segments[0].translation, "escaped JSON inside text stays text");
	const valid = JSON.stringify({messages: [a], ignored: b});
	assert.deepEqual(ids(read(valid)), ["msg-a"]);
	assert.deepEqual(ids(read("```json\n" + valid + "\n```")), ["msg-a"]);
	assert.equal(read("```json\n" + valid + "\n```").structure.jsonSource, "fenced");
	assert.equal(read(malformed([a])).structure.jsonSource, "fragment");
	assert.equal(read({segments: a.segments}).structure.jsonSource, "whole");
	assert.equal(read("not JSON").structure.jsonSource, "none");
});

test("the shape vocabulary is closed and contains every value the reader can emit", () => {
	assert.deepEqual([...BATCH_ANSWER_SHAPES].sort(), ["alt-list", "alt-row-list", "bare-array", "id-keyed", "malformed-empty", "malformed-empty-list", "malformed-invalid-rows", "malformed-missing-id-fields", "malformed-no-rows", "malformed-no-segments", "malformed-not-json", "malformed-segment-root", "malformed-unknown-ids", "message-objects", "plan-nested", "segment-map", "translation-string", "unknown"]);
});

test("extra-brace recovery preserves quoted text and requires complete unambiguous direct members", () => {
	const a = {id: "m1", segments: [{id: "s1", translation: 'JSON {"id":"m2","segments":[]} and }]}, quote " backslash \\ newline\n⟦C0⟧'}]};
	const b = {id: "m2", segments: [{id: "s1", translation: "乙"}, {id: "s2", translation: "丙"}]};
	const wrap = rows => '{"messages":[' + rows.map(row => JSON.stringify(row)).join("},") + "]}";
	const reversed = read(wrap([b, a]));
	assert.deepEqual(ids(reversed), ["msg-a", "msg-b"]);
	assert.deepEqual(reversed.shapes, ["message-objects"]);
	assert.deepEqual(reversed.translations["msg-a"].semanticSegments, a.segments);
	const corrupt = [
		wrap([a]), wrap([a, {...b, id: "m9"}]), wrap([a, a]), wrap([a, a, b]),
		wrap([a, b, {...a, id: "msg-a"}]),
		wrap([a, b]).replace('"translation":', '"translation">'),
		'{"messages":[{"id":"m1","segments":[{"id":"s1","translation":"unfinished ' + JSON.stringify(b) + "]}",
		wrap([a, b]).replace("}," + JSON.stringify(b), "}junk," + JSON.stringify(b)),
		wrap([a, b]).slice(0, -2), wrap([a, b]) + "junk"
	];
	for (const content of corrupt) assert.equal(read(content).shapes.includes("message-objects"), false, "damaged text, incomplete coverage and ambiguous boundaries must not be recovered");
});
