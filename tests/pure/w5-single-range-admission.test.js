const test = require('node:test');
const assert = require('node:assert/strict');
const {createWholeMarkerBatchCanary} = require('../../src/orchestrator/whole-marker-batch-canary');
const {planReceivedMarkdown} = require('../../src/planner/received-markdown-lossless-planner');
const {buildWholeMarkerRequest} = require('../../src/planner/translation-whole-marker-wire');
const {historyW5Eligibility} = require('../../src/orchestrator/history-w5-policy');

function fixture(sources) {
 const items = sources.map((content,index) => ({message:{id:`m-${index}`,content},originalContentData:{content},channelId:'channel',input:{id:'en'},output:{id:'zh-CN'},semanticRequest:{enabled:true,adapter:'typed-json'}}));
 const requests = items.map(item => buildWholeMarkerRequest(planReceivedMarkdown(item.message.content,{direction:'received',fieldPath:'body',targetLanguageId:'zh-CN'}),{}, {targetLanguageId:'zh-CN'}));
 assert.ok(requests.every(request => request.ok));
 const owner = createWholeMarkerBatchCanary({compile:item => requests[items.indexOf(item)]});
 assert.equal(owner.enable({engineKey:'fixture',channelId:'channel',messageIds:items.map(item=>item.message.id),maxMessages:2,ttlMs:60000}),true);
 return {items,requests,owner};
}

for (const source of ['Please **check the schedule** before the meeting tomorrow.','Do **not share** the draft before Friday.','The build passed.\nPlease publish it tomorrow.']) for (const position of [0,1]) test(`W5 multi-range admission rejects the whole batch without claiming messages: position ${position}, ${source}`, () => {
 const sources = ['Please review the update.','Please confirm the deadline.']; sources[position] = source;
 const h = fixture(sources);
 try {
  assert.ok(h.requests[position].ranges.length > 1, 'the real D planner supplies multiple natural-language ranges');
  const before = h.owner.snapshot();
  assert.equal(h.owner.claim('fixture',h.items,null),null);
  assert.deepEqual(h.owner.snapshot(),before,'rejection spends no grant, dispatch or active request resource');
  assert.ok(h.items.every(item=>!item.wholeMarkerBatchFinal && !item.wholeMarkerBatchIsCurrent));
 } finally {h.owner.disable();}
});

test('W5 single-range admission still permits whole-span emphasis without extra dispatch',async()=>{
 const h = fixture(['Please review the update.','**Please confirm the deadline.**']);
 try {
  assert.deepEqual(h.requests.map(request=>request.ranges.length),[1,1]);
  const claim = h.owner.claim('fixture',h.items,null); assert.ok(claim);
  let calls = 0;
  const result = await claim.run(async batch => {calls++;assert.deepEqual(Object.keys(JSON.parse(batch.wire)),['1.1','2.1']);return {text:'{"1.1":"请核对更新。","2.1":"请确认截止时间。"}',statusCode:200};});
  assert.equal(calls,1); assert.ok(Object.values(result.translations).every(row=>row.wholeMarkerBatch.outcome.ok));
  assert.equal(h.owner.snapshot().admittedMessages,2); assert.equal(h.owner.snapshot().remainingMessages,0);
  assert.equal(h.owner.snapshot().applicationDispatches,1); assert.equal(h.owner.snapshot().activeRequests,0);
 } finally {h.owner.disable();}
});

test('W5 single-range real owner sends a complete-message prompt and retains repeated full inputs',async()=>{
 const source = 'The package passed every check. We can publish it tomorrow.';
 const h = fixture([source,source]);
 try {
  const claim = h.owner.claim('fixture',h.items,null); assert.ok(claim);
  let batch;
  await claim.run(async request => {batch = request; return {failureKind:'transient'};});
   assert.deepEqual(JSON.parse(batch.wire),{'1.1':source,'2.1':source});
   assert.match(batch.contractRevision,/\.prompt-v2\.validator-v1$/);
   assert.match(batch.systemPrompt,/complete message/);
   assert.match(batch.systemPrompt,/every sentence and condition/);
   assert.match(batch.systemPrompt,/Do not summarize, shorten, extract/);
   assert.match(batch.systemPrompt,/Repeated input values still need a complete translation at every key/);
   assert.match(batch.systemPrompt,/negations.*without.*time.*numbers.*comparisons/);
   assert.doesNotMatch(batch.systemPrompt,/fixed-span|may remain fragments|context only|Do not translate the whole message/);
   assert.match(batch.systemPrompt,/Preserve every ⟦\.\.\.⟧ token exactly in its own value/);
 } finally {h.owner.disable();}
});

test('W5 owner admission agrees with pure History policy across seven cases and never spends a rejected grant', () => {
 const cases = [
  {sources: ['Please review the update.','Please confirm the deadline.'], eligible: true},
  {sources: ['**Please review the update.**','Please confirm the deadline.'], eligible: true},
  {sources: ['The package passed.','The package passed.'], eligible: true},
  {sources: ['Please **review the update** before Friday.','Please confirm the deadline.'], eligible: false},
  {sources: ['Do **not share** the draft before Friday.','Please confirm the deadline.'], eligible: false},
  {sources: ['The build passed.\nPlease publish it tomorrow.','Please confirm the deadline.'], eligible: false},
  {sources: ['Please review the update.','Please **confirm the deadline** tomorrow.'], eligible: false}
 ];
 for (const scenario of cases) {
  const h = fixture(scenario.sources);
  try {
   const ids = h.items.map(item => item.message.id);
   const decision = historyW5Eligibility({
    items: h.items.map((item, index) => ({message: item.message, request: h.requests[index]})),
    engineKey: 'fixture', channelId: 'channel',
    grant: {engineKey: 'fixture', channelId: 'channel', ids: new Set(ids), remaining: ids.length, expiresAt: Date.now() + 60000, enabled: true}
   });
   assert.equal(decision.eligible, scenario.eligible, JSON.stringify({scenario, decision}));
   const before = h.owner.snapshot();
   const claim = h.owner.claim('fixture', h.items, null);
   assert.equal(!!claim, scenario.eligible, JSON.stringify({scenario, decision, claim: !!claim}));
   if (!scenario.eligible) assert.deepEqual(h.owner.snapshot(), before, 'typed fallback must not consume grant resources');
  } finally { h.owner.disable(); }
 }
});
