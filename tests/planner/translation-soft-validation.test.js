const test = require("node:test");
const assert = require("node:assert/strict");

const {createProtectionLogic, MESSAGE_PLACES} = require("../../src/protection/protection-logic");
const {createSemanticRequest, validateSemanticResponse, planSemanticRepair, attachSemanticLocalState} = require("../../src/planner/translation-semantic-runtime");
const {VALIDATOR_VERSION, createSemanticWorkloadKey} = require("../../src/planner/translation-semantic-revision");
const {SOFT_REASONS, HARD_REASONS, VALIDATOR_FAMILY, SOFT_VALIDATION_VERSION, isSoftReason, isNameLikeText, isNameLikeSegment, resolveSoftFailures, summarizeKept, segmentKeepText} = require("../../src/planner/translation-soft-validation");
const {P3_FIXTURES, requestTextFor, fixtureById} = require("../fixtures/p3-soft-validation-fixtures");

const logic = createProtectionLogic();
const plugin = {settings: {exceptions: {wordStart: ["!"], protectedTerms: [], wrapperPairs: [], protectedTermsForReceived: true, wrapperPairsForReceived: true}}, getProtectedWrapperRules() {return [];}};
const likelyTarget = value => /[\p{Script=Han}]/u.test(String(value || ""));
const similarity = (source, value) => String(source).trim() === String(value).trim() ? 1 : 0;
const VALIDATE = {likelyTarget, similarity, maxSimilarity: 0.94};

function typedFor(source) {
	const protection = logic.prepareSemanticSource(plugin, source, MESSAGE_PLACES.RECEIVED);
	const request = createSemanticRequest({engineKey: "oaicompat", source: protection.source, direction: "received", fieldPath: "body", inputLanguageId: "auto", targetLanguageId: "zh-CN"});
	attachSemanticLocalState(request, {protectedSegments: protection.protectedSegments, cachePlanHash: "x"});
	return {protection, request};
}
// The wire carries short labels; the validator and keep policy work on plan ids.
function segmentsOf(request) {return JSON.parse(request.wire).segments.map(segment => Object.assign({}, segment, {id: request.segmentAliases[segment.id]}));}
function rowsFor(request, translate) {return {segments: segmentsOf(request).map((segment, index) => ({id: segment.id, translation: translate(segment, index)}))};}
const tokensOf = text => (String(text).match(/⟦(?:DTA)?\d+⟧|⟦C\d+⟧/g) || []).join("");
const translated = (segment, index) => `译${index}${tokensOf(segment.text)}`;

test("release labels and HTTP operation echoes keep exact protected text without a repair", () => {
	for (const source of [
		"📦 **mirasim v0.0.228** · 2026-08-25\n\nMirasim v0.0.228\n\nPlease restart the app.",
		"📦 **AnotherTool v1.2.3-beta.1** · 2026-09-16\n\nAnotherTool v1.2.3-beta.1\n\nPlease restart the app.",
		"HTTP https://example.invalid/mcp > initialize\nPlease restart the app."
	]) {
		const {request, protection} = typedFor(source);
		const outcome = validateSemanticResponse(request, rowsFor(request, segment => segment.text.includes("Please restart") ? "请重启应用。" : segment.text), VALIDATE);
		assert.equal(outcome.ok, true, source);
		assert.ok(outcome.keptCount > 0);
		assert.equal(logic.addSemanticExceptions(plugin, outcome.translation, protection.protectedSegments), source.replace("Please restart the app.", "请重启应用。"));
	}
});

test("technical-looking prose and uncorroborated versions still require their existing soft repair", () => {
	for (const source of [
		"Please update Mirasim v0.0.228 before Friday.", "Delete v0.0.228", "Update v0.0.228", "mirasim v0.0.228",
		"HTTP https://example.invalid/mcp > please initialize the connection",
		"HTTP https://example.invalid/mcp > initialize failed, please try again.",
		"HTTP <@123456789012345678> > initialize",
		"API Error: 502 Error: no device ticket yet; the relay leg cannot be signed. This is a server-side issue, usually temporary.",
		"*Transform this photo into an ultra photorealistic snapshot taken with smartphone, realistic pores and natural texture.*", "tag", "lol", "zijin"
	]) {
		const {request} = typedFor(source);
		const outcome = validateSemanticResponse(request, rowsFor(request, segment => segment.text), VALIDATE);
		assert.equal(outcome.ok, false, source);
	}
});

test("technical labels cannot waive changed responses or hard structural failures", () => {
	const {request} = typedFor("HTTP https://example.invalid/mcp > initialize");
	for (const translation of ["HTTP ⟦0⟧ > randomwords", "HTTP > initialize", "", "HTTP ⟦0⟧ ⟦0⟧ > initialize"]) {
		assert.equal(validateSemanticResponse(request, rowsFor(request, () => translation), VALIDATE).ok, false, translation);
	}
	assert.equal(validateSemanticResponse(request, {segments: []}, VALIDATE).ok, false);
});

test("null rows from native protocols remain repairable instead of throwing during soft validation", () => {
	for (const engineKey of ["gemininative", "anthropicnative"]) {
		const request = createSemanticRequest({engineKey, source: "Please check the logs.\n\nPlease restart the app.", direction: "received", fieldPath: "body", inputLanguageId: "auto", targetLanguageId: "zh-CN"});
		const outcome = validateSemanticResponse(request, {items: [null, "Please restart the app."]}, VALIDATE);
		assert.equal(outcome.ok, false);
		assert.equal(outcome.invalidIds.length, 2);
		assert.equal(planSemanticRepair(request, outcome, {parentSettled: true}).dispatchable, true);
	}
});

test("P3 reason classes: wrong-language and too-similar are soft, everything else stays hard", () => {
	assert.deepEqual(SOFT_REASONS, ["wrong-language", "too-similar"]);
	for (const reason of HARD_REASONS) assert.equal(isSoftReason(reason), false, reason);
	for (const reason of SOFT_REASONS) assert.equal(isSoftReason(reason), true, reason);
	assert.equal(isSoftReason("unknown"), false);
	assert.equal(SOFT_VALIDATION_VERSION, "p3-soft-validation-v4");
	assert.equal(VALIDATOR_FAMILY, "segment-validator-v3");
	// Only kept results change their policy identity; ordinary paid results keep
	// the existing validator/workload identity.
	assert.equal(VALIDATOR_VERSION, "segment-validator-v2");
	assert.equal(createSemanticWorkloadKey({plannerVersion: "m3i-v2"}).fields.validatorVersion, "segment-validator-v2");
});

test("P3 name-like rule requires name casing rather than short length or footer position", () => {
	for (const text of ["Atomic Gains", "ECHOES OF TOMORROW", "Higgsfield Community", "GED", "Self-Pay", "Discord", "OpenAI", "Gemini 3.7", "The Quick Brown Fox Jumps Over Everything Today", "NVIDIA GeForce RTX 5090 Founders Edition Review 2026", "12,345 Views"]) assert.equal(isNameLikeText(text), true, text);
	for (const text of ["one two three four five", "", "12345"]) assert.equal(isNameLikeText(text), false, text);
	for (const text of ["A short film about memory and loss made with generative tools over one weekend.", "please review the updated schedule before the meeting", "The committee will publish the revised financial aid requirements before the end of the month.", "We shipped Version 2 of the Atomic planner today and it works well"]) assert.equal(isNameLikeText(text), false, text);
	// 60% share: 4 of 6 lettered words capitalised passes, 3 of 6 does not.
	assert.equal(isNameLikeText("Alpha Beta Gamma Delta epsilon zeta"), true);
	assert.equal(isNameLikeText("Alpha Beta Gamma delta epsilon zeta"), false);
});

test("soft preservation needs source evidence even after a failed repair", () => {
	const {request} = typedFor(requestTextFor(fixtureById("f16-plain-sentence-echoed")));
	const id = segmentsOf(request)[0].id;
	const first = resolveSoftFailures({plan: request.plan, invalid: [{id, reason: "wrong-language"}], attempt: 1});
	assert.deepEqual(first.kept, {}, "a long lowercase sentence is not name-like: repair first");
	assert.equal(first.remaining.length, 1);
	const second = resolveSoftFailures({plan: request.plan, invalid: [{id, reason: "too-similar"}], attempt: 2});
	assert.deepEqual(second.kept, {});
	assert.equal(second.remaining.length, 1);
	const hard = resolveSoftFailures({plan: request.plan, invalid: [{id, reason: "missing-id"}, {id, reason: "placeholder-mismatch"}], attempt: 2});
	assert.deepEqual(hard.kept, {});
	assert.equal(hard.remaining.length, 2);
	const name = typedFor("Atomic Gains").request, nameId = segmentsOf(name)[0].id;
	assert.deepEqual(resolveSoftFailures({plan: name.plan, invalid: [{id: nameId, reason: "wrong-language"}], attempt: 1}).kept, {[nameId]: "wrong-language"});
	assert.deepEqual(summarizeKept({a: "wrong-language", b: "wrong-language", c: "too-similar", d: "weird"}), {keptCount: 4, keptReasons: {"wrong-language": 2, "too-similar": 1, unknown: 1}});
});

test("P3 validateSemanticResponse keeps name-like echoes as source text with protected content byte-conserved, one shot", () => {
	const fixture = fixtureById("f14-forward-embed-title-footer");
	const {protection, request} = typedFor(requestTextFor(fixture));
	const echoed = new Set(fixture.echoed);
	const outcome = validateSemanticResponse(request, rowsFor(request, (segment, index) => echoed.has(segment.text.trim()) ? segment.text : translated(segment, index)), VALIDATE);
	assert.equal(outcome.ok, true, outcome.reason);
	assert.equal(outcome.keptCount, 3, JSON.stringify(outcome.kept));
	assert.deepEqual(outcome.keptReasons, {"wrong-language": 3});
	const restored = logic.addSemanticExceptions(plugin, outcome.translation, protection.protectedSegments);
	assert.ok(restored.includes("ECHOES OF TOMORROW | Higgsfield Community"), restored);
	assert.ok(restored.endsWith("Higgsfield Community"), restored);
	assert.ok(restored.includes("https://higgsfield.invalid/showcase/echoes"), "the protected link is restored byte for byte");
	assert.ok(/译\d/.test(restored), "the description was translated");
	assert.deepEqual(outcome.invalidIds, []);
	const strict = validateSemanticResponse(request, rowsFor(request, (segment, index) => echoed.has(segment.text.trim()) ? segment.text : translated(segment, index)), Object.assign({softKeep: false}, VALIDATE));
	assert.equal(strict.ok, false, "softKeep=false is the P2 verdict the W2 harness scores with");
	assert.equal(strict.reason, "wrong-language");
	assert.equal(strict.keptCount, 0);
});

test("a non-name-like echo remains invalid after repair; hard failures retain their budget", () => {
	const {request} = typedFor(requestTextFor(fixtureById("f16-plain-sentence-echoed")));
	const first = validateSemanticResponse(request, rowsFor(request, segment => segment.text), VALIDATE);
	assert.equal(first.ok, false);
	assert.equal(first.reason, "wrong-language", "the validator tests the target language before similarity");
	assert.equal(first.keptCount, 0);
	assert.equal(first.invalidIds.length, 1);
	const repair = planSemanticRepair(request, first, {parentSettled: true});
	assert.equal(repair.dispatchable, true);
	assert.equal(repair.requests.length, 1);
	assert.equal(repair.requests[0].attempt, 2);
	const second = validateSemanticResponse(repair.requests[0], rowsFor(repair.requests[0], segment => segment.text), Object.assign({priorValid: first.valid}, VALIDATE));
	assert.equal(second.ok, false);
	assert.equal(second.keptCount, 0);
	assert.deepEqual(second.keptReasons, {});
	assert.equal(second.translation, null, "a failed segment cannot become a successful source copy");
	assert.equal(planSemanticRepair(repair.requests[0], second, {parentSettled: true}).dispatchable, true, "the existing final repair is still available");
	const hard = typedFor(requestTextFor(fixtureById("f17-missing-segment-hard-failure")));
	const missing = validateSemanticResponse(hard.request, {segments: rowsFor(hard.request, translated).segments.slice(0, 1)}, VALIDATE);
	assert.equal(missing.ok, false);
	assert.equal(missing.reason, "missing-id");
	assert.equal(missing.keptCount, 0);
	const hardRepair = planSemanticRepair(hard.request, missing, {parentSettled: true});
	assert.equal(hardRepair.dispatchable, true);
	const stillMissing = validateSemanticResponse(hardRepair.requests[0], {segments: []}, Object.assign({priorValid: missing.valid}, VALIDATE));
	assert.equal(stillMissing.ok, false);
	assert.equal(stillMissing.reason, "missing-id");
	assert.equal(planSemanticRepair(hardRepair.requests[0], stillMissing, {parentSettled: true}).dispatchable, true, "hard failures keep the P2 attempt budget (attempt 3)");
	assert.equal(planSemanticRepair(Object.assign({}, hardRepair.requests[0], {attempt: 3}), stillMissing, {parentSettled: true}).dispatchable, false);
});

test("P3 kept text is the wire form so P2 tokens restore and the fixture set is what the record says", () => {
	assert.equal(segmentKeepText({wireText: "Atomic ⟦C0⟧ Gains", raw: "Atomic `x` Gains"}), "Atomic ⟦C0⟧ Gains");
	assert.equal(segmentKeepText({raw: "plain"}), "plain");
	assert.deepEqual(P3_FIXTURES.filter(fixture => !fixture.probeOnly).map(fixture => fixture.id), ["f14-forward-embed-title-footer", "f15-channel-name-line-with-link", "f16-plain-sentence-echoed", "f17-missing-segment-hard-failure", "f18-all-protected-reply"]);
	assert.deepEqual(P3_FIXTURES.filter(fixture => fixture.probeOnly).map(fixture => fixture.id), ["f19-embed-title-footer-only", "f20-channel-name-only"]);
});

test("short prose echoes stay invalid instead of being accepted as names", () => {
	for (const source of ["Do not publish this.", "Please wait until Friday.", "please wait", "Are You Ready?", "нет спасибо", "不要发布这个"] ) {
		assert.equal(isNameLikeText(source), false, source);
	}
	for (const source of ["Do not publish this.", "Please wait until Friday.", "please wait"]) {
		const {request} = typedFor(source);
		const first = validateSemanticResponse(request, rowsFor(request, segment => segment.text), VALIDATE);
		assert.equal(first.ok, false, source);
		assert.equal(first.reason, "wrong-language");
		assert.equal(first.keptCount, 0);
		const repair = planSemanticRepair(request, first, {parentSettled: true});
		assert.equal(repair.requests.length, 1);
		const next = repair.requests[0];
		const second = validateSemanticResponse(next, rowsFor(next, segment => segment.text), {...VALIDATE, priorValid: first.valid});
		assert.equal(second.ok, false);
		assert.equal(second.keptCount, 0, "repair failure is not evidence of a name");
		assert.equal(planSemanticRepair(next, second, {parentSettled: true}).dispatchable, true);
	}
});

test("a repaired formatted short sentence stays whole and restores its emphasis", () => {
	const {request} = typedFor("Do **not publish** this.");
	assert.equal(segmentsOf(request).length, 1);
	const first = validateSemanticResponse(request, rowsFor(request, segment => segment.text), VALIDATE);
	assert.equal(first.ok, false);
	const repair = planSemanticRepair(request, first, {parentSettled: true}).requests[0];
	assert.equal(segmentsOf(repair).length, 1);
	const second = validateSemanticResponse(repair, rowsFor(repair, segment => `请${segment.text.match(/⟦F\d+⟧/)[0]}不要发布${segment.text.match(/⟦\/F\d+⟧/)[0]}这个。`), {...VALIDATE, priorValid: first.valid});
	assert.equal(second.ok, true);
	assert.equal(second.keptCount, 0);
	assert.equal(second.translation, "请**不要发布**这个。");
});

test("footer placement alone does not make an echoed instruction a name", () => {
	const {request} = typedFor("Body text\n__________________ __________________ __________________\nExample Title\nA description of this example.\nPlease wait until Friday.");
	const footer = request.plan.nodes.find(node => node.raw === "Please wait until Friday.");
	assert.ok(footer);
	assert.equal(request.plan.nodes.at(-1), footer, "the fixture ends in the embed footer instruction");
	assert.equal(isNameLikeSegment(request.plan, footer), false);
	const outcome = validateSemanticResponse(request, rowsFor(request, (segment, index) => segment.text === footer.raw ? segment.text : translated(segment, index)), VALIDATE);
	assert.equal(outcome.ok, false);
	assert.deepEqual(outcome.invalidIds, [footer.id]);
	assert.equal(outcome.keptCount, 0);
});
