const test = require("node:test");
const {assert, requireW1} = require("../helpers/w1-compact-wire-test-kit");

test("W1 fallback classifier allows only one bounded second application dispatch", () => {
	const w1 = requireW1();
	assert.equal(w1.classifyCompactFallback({stage:"precheck",reason:"body-budget",dispatchCount:0}).action, "legacy");
	assert.equal(w1.classifyCompactFallback({stage:"primary",kind:"clean",dispatchCount:1}).action, "complete");
	assert.equal(w1.classifyCompactFallback({stage:"primary",kind:"partial",dispatchCount:1}).action, "repair");
	assert.equal(w1.classifyCompactFallback({stage:"primary",kind:"root-malformed",dispatchCount:1}).action, "legacy");
	for (const state of [
		{stage:"repair",kind:"failed",dispatchCount:2},
		{stage:"legacy",kind:"failed",dispatchCount:2},
		{stage:"primary",kind:"partial",dispatchCount:2}
	]) assert.equal(w1.classifyCompactFallback(state).action, "terminal");
	let state = w1.createCompactFallbackState();
	state = w1.transitionCompactFallbackState(state, "primary");
	state = w1.transitionCompactFallbackState(state, "repair");
	assert.equal(w1.transitionCompactFallbackState(state, "legacy").reason, "application-dispatch-limit");
	state = w1.createCompactFallbackState();
	state = w1.transitionCompactFallbackState(state, "primary");
	state = w1.transitionCompactFallbackState(state, "legacy");
	assert.equal(w1.transitionCompactFallbackState(state, "repair").reason, "application-dispatch-limit");
	assert.equal(w1.classifyCompactFallback({stage:"primary",kind:"partial",arm:"C",wireFamily:"whole",dispatchCount:1}).action, "legacy");
	const wholeRequest = w1.buildWholeMessageRequest(require("../../src/planner/received-markdown-lossless-planner").planReceivedMarkdown("中文 English", {targetLanguageId:"zh-CN"}), {}, {}), wholeOutcome = w1.validateWholeMessageResponse(wholeRequest, "中文 英文", {likelyTarget:() => true});
	assert.equal(wholeOutcome.reason, "semantic-order-undetectable");
	assert.equal(w1.classifyCompactFallback(wholeOutcome, {request:wholeRequest}).action, "legacy");
});

test("W1 A/B/C identities and cache cohorts are isolated across every version field", () => {
	const w1 = requireW1(), common = {wireVersion:"v1",promptVersion:"p1",plannerVersion:"m3i-v1",protectionVersion:"pv2",validatorVersion:"vv2",languagePair:"en:zh-CN",providerSemanticRevision:"s1",reasoningProfile:"off"};
	const a = w1.createFastWireIdentity({...common, arm:"A", wireFamily:"typed-json"}), b = w1.createFastWireIdentity({...common, arm:"B", wireFamily:"compact-order"}), c = w1.createFastWireIdentity({...common, arm:"C", wireFamily:"whole"});
	assert.notEqual(a.key, b.key); assert.notEqual(b.key, c.key); assert.notEqual(a.key, c.key);
	assert.equal(w1.assessFastCacheEntry({kind:"translation",identityKey:b.key}, b).read, true);
	assert.equal(w1.assessFastCacheEntry({kind:"translation",identityKey:a.key}, b).read, false);
	assert.equal(w1.assessFastCacheEntry({kind:"skip",identityKey:b.key}, b).read, false);
	for (const field of ["wireVersion","promptVersion","customPromptDigest","plannerVersion","protectionVersion","validatorVersion","languagePair","providerSemanticRevision","reasoningProfile"]) {
		const changed = w1.createFastWireIdentity({...common, arm:"B", wireFamily:"compact-order", [field]: `${common[field]}-changed`});
		assert.notEqual(changed.key, b.key, field);
		assert.equal(w1.assessFastCacheEntry({kind:"translation",identityKey:b.key}, changed).read, false, field);
	}
});
