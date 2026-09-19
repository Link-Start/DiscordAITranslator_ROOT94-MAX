const test = require("node:test");
const assert = require("node:assert/strict");

const {createProtectionLogic, MESSAGE_PLACES} = require("../../src/protection/protection-logic");
const {parseTypedPlanResponse} = require("../../src/planner/translation-plan-serializer");
const {createSemanticRequest, validateSemanticResponse} = require("../../src/planner/translation-semantic-runtime");
const {P2_FIXTURES, P2_FIXTURE_HASHES, sha256: fixtureSha256} = require("../fixtures/p2-inline-protected-fixtures");
const {P2_MALFORMED_SAMPLES, sha256} = require("../fixtures/p2-malformed-samples");

const CJK_RE = /[\p{Script=Han}]/u;

function productionRequest(fixtureId) {
	const fixture = P2_FIXTURES.find(row => row.id === fixtureId);
	assert.ok(fixture, fixtureId);
	assert.equal(fixtureSha256(fixture.source), P2_FIXTURE_HASHES[fixture.id]);
	const settings = {wordStart: ["!"], protectedTerms: [...(fixture.protectedTerms || [])], wrapperPairs: [...(fixture.wrapperPairs || [])], protectedTermsForReceived: true, wrapperPairsForReceived: true};
	const plugin = {settings: {exceptions: settings}, getProtectedWrapperRules() {return settings.wrapperPairs.map(value => {const [left, right] = String(value).split("|"); return {left, right};}).filter(row => row.left && row.right);}};
	const logic = createProtectionLogic();
	const masked = logic.prepareSemanticSource(plugin, fixture.source, MESSAGE_PLACES.RECEIVED);
	// These literal upstream answers were captured before formatting joined a sentence.
	const request = createSemanticRequest({engineKey: "oaicompat", source: masked.source, direction: "received", fieldPath: "body", inputLanguageId: "en", targetLanguageId: "zh-CN", inlineFormatting: false});
	assert.equal(request.enabled, true);
	assert.equal(request.adapter, "typed-json");
	return {fixture, plugin, logic, masked, request};
}

test("P2-d captured answers are pinned and match the production request of their fixture", () => {
	assert.equal(P2_MALFORMED_SAMPLES.length, 4);
	assert.deepEqual([...new Set(P2_MALFORMED_SAMPLES.map(sample => sample.fixtureId))].sort(), ["f10-markdown-protected-mixed", "f11-inline-placeholders-tail"]);
	for (const sample of P2_MALFORMED_SAMPLES) {
		const {request} = productionRequest(sample.fixtureId);
		assert.equal(sha256(sample.response), sample.responseSha256, sample.id);
		assert.deepEqual(request.segmentOrder.slice(), sample.expectedRows, `${sample.id}: ids of the production request`);
		assert.deepEqual(JSON.parse(request.wire).segments.map(row => row.text), sample.requestSegments.map(row => row.text), `${sample.id}: wire text of the production request`);
		assert.throws(() => JSON.parse(sample.response), `${sample.id} is not a valid JSON document`);
	}
});

test("P2-d complete row objects are recovered when the segments container is broken by stray text", () => {
	for (const sample of P2_MALFORMED_SAMPLES) {
		const rows = parseTypedPlanResponse(sample.response);
		assert.ok(Array.isArray(rows), `${sample.id}: rows recovered`);
		assert.deepEqual(rows.map(row => row.id), sample.expectedRows, `${sample.id}: ids in answer order`);
		for (const row of rows) {
			assert.equal(typeof row.translation, "string");
			assert.match(row.translation, CJK_RE);
			assert.doesNotMatch(row.translation, /stockholders|Corporation/, "stray text never enters a translation");
		}
	}
	const truncated = '{"segments":[{"id":"a","translation":"甲"},{"id":"b","translation":"乙';
	assert.deepEqual(parseTypedPlanResponse(truncated).map(row => [row.id, row.translation]), [["a", "甲"]], "a truncated container yields only its complete rows");
	const between = '{"segments":[{"id":"b","translation":"乙"} foo {"id":"a","translation":"甲"} bar]}';
	assert.deepEqual(parseTypedPlanResponse(between).map(row => row.id), ["b", "a"], "answer order is preserved, ids are never inferred");
	const fenced = '```json\n{"segments":[{"id":"a","translation":"甲"} stray]}\n```';
	assert.deepEqual(parseTypedPlanResponse(fenced).map(row => row.id), ["a"], "fenced documents recover the same way");
});

test("P2-d recovery never widens what a syntactically valid or prose answer means", () => {
	assert.equal(parseTypedPlanResponse("bad"), null);
	assert.equal(parseTypedPlanResponse("这是整段翻译，没有任何 JSON。"), null, "prose stays malformed");
	assert.deepEqual(parseTypedPlanResponse('{"result":[{"id":"a","translation":"甲"}]}').map(row => row.id), ["a"], "the existing balanced-slice extraction of a row array is unchanged");
	assert.equal(parseTypedPlanResponse('{"result":"done"}'), null, "a valid document without rows stays rejected");
	assert.equal(parseTypedPlanResponse('{"wrapped":{"id":"a","translation":"甲"}}'), null, "a syntactically valid document never triggers row recovery");
	assert.equal(parseTypedPlanResponse('{"error":{"id":"req_1","message":"quota"}} trailing'), null, "objects without a translation field are not rows");
	assert.equal(parseTypedPlanResponse('{"segments":{"translation":"甲"} x'), null, "objects without an id are not recovered as rows");
	assert.equal(parseTypedPlanResponse('[{"text":"{\\"segments\\":[{\\"id\\":\\"a\\",\\"translation\\":\\"甲\\"}]}"}]').map(row => row.id).join(), "a", "the existing nested-text unwrapping is unchanged");
});

test("P2-d recovered rows flow through the production validator and restore every protected byte", () => {
	for (const sample of P2_MALFORMED_SAMPLES) {
		const {fixture, plugin, logic, masked, request} = productionRequest(sample.fixtureId);
		const outcome = validateSemanticResponse(request, sample.response, {likelyTarget: value => CJK_RE.test(value), similarity: () => 0});
		assert.equal(outcome.ok, true, `${sample.id}: ${outcome.reason} ${JSON.stringify(outcome.invalidIds)}`);
		assert.doesNotMatch(outcome.translation, /⟦C\d+⟧/);
		const restored = logic.addSemanticExceptions(plugin, outcome.translation, masked.protectedSegments || {});
		assert.doesNotMatch(restored, /⟦(?:DTA)?\d+⟧/);
		for (const literal of fixture.preserveLiterals) assert.equal(restored.split(literal).length - 1, fixture.source.split(literal).length - 1, `${sample.id} conserves ${literal}`);
		assert.doesNotMatch(restored, /stockholders|Corporation/);
		assert.equal(restored.split(/\r\n|\r|\n/).length, fixture.source.split(/\r\n|\r|\n/).length);
	}
});
