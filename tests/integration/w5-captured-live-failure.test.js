"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fixture = require("../fixtures/w5-captured-live-failure.json");
const {harness, grant, runLive, close, ENGINE, CHANNEL} = require("../helpers/w5-captured-response-harness");
const {planReceivedMarkdown} = require("../../src/planner/received-markdown-lossless-planner");
const {buildWholeMarkerRequest,parseWholeMarkerResponse,reassembleWholeMarkerResponse} = require("../../src/planner/translation-whole-marker-wire");
const {buildWholeMarkerBatchRequest,parseWholeMarkerBatchResponse,buildWholeMarkerBatchRepairRequest} = require("../../src/planner/translation-whole-marker-batch");
const {compileWholeMarkerSingle} = require("../../src/orchestrator/whole-marker-single-canary");
const validate = {likelyTarget:t=>/\p{Script=Han}/u.test(t), similarity:(a,b)=>a===b?1:0};
const simpleRequest = source => buildWholeMarkerRequest(planReceivedMarkdown(source,{direction:"received",fieldPath:"body",targetLanguageId:"zh-CN"}),{},{targetLanguageId:"zh-CN"});
function prepared(h, rows=fixture.sources) {
 return rows.map(row=>h.plugin.prepareHistoricalAiBatchQueueItem({message:{id:row.id,channel_id:CHANNEL,content:row.content,embeds:[],attachments:[],author:{id:"other-user"}},channel:{id:CHANNEL},originalContentData:{content:row.content,embeds:[]}},CHANNEL,{id:"en",name:"English"},{id:"zh-CN",name:"Chinese"}));
}

// This frozen tuple capture belongs to the retired batch-tuples-v2 contract. Keep its bytes unchanged.
test("W5 legacy captured full envelope stays rejected before any sibling is exposed", async () => {
 const h=harness(()=>{throw new Error("codec test must remain local");});
 try {
  const items=prepared(h),batch=buildWholeMarkerBatchRequest(items.map(item=>({id:item.message.id,request:compileWholeMarkerSingle(h.plugin,item.semanticRequest)})));
  assert.equal(batch.ok,true,batch.reason);
  assert.deepEqual(Object.keys(JSON.parse(batch.wire)),["1.1","2.1","3.1","4.1","4.2","4.3","5.1","6.1"]);
  assert.equal(JSON.parse(batch.wire)["4.2"],"check the schedule");
  const parsed=JSON.parse(fixture.response); assert.equal(parsed.length,11);assert.deepEqual(parsed.filter(x=>typeof x==="number"),[2,3,4,5,6]);
  const result=parseWholeMarkerBatchResponse(batch,fixture.response,validate);
  assert.equal(result.ok,false);assert.equal(result.rootMalformed,true);assert.equal(result.reason,"unexpected-root");assert.equal(result.valid.size,0);assert.equal(result.translations.size,0);assert.equal(buildWholeMarkerBatchRepairRequest(batch,result),null);
  assert.equal(h.requests.length,0);
 }finally{await close(h);}
});

test("W5 retired tuple roots remain rejected even after removing the bare numeric element",()=>{
 const batch=buildWholeMarkerBatchRequest(fixture.minimalRoot.sources.map((source,i)=>({id:`fixture-${i}`,request:simpleRequest(source)})));
 const bad=parseWholeMarkerBatchResponse(batch,fixture.minimalRoot.response,validate);
 assert.equal(bad.reason,"unexpected-root");assert.equal(bad.rootMalformed,true);assert.equal(bad.valid.size,0);
 // Neither raw nor cleaned retired tuples are migrated or accepted at runtime.
 const corrected='[[1,"⟪1⟫请审阅这段文字。"],[2,"⟪1⟫请审阅这段文字。"]]';
 const retired=parseWholeMarkerBatchResponse(batch,corrected,validate);assert.equal(retired.reason,"unexpected-root");
 const control=parseWholeMarkerBatchResponse(batch,'{"1.1":"请审阅这段文字。","2.1":"请审阅这段文字。"}',validate);
 assert.equal(control.ok,true);assert.equal(control.valid.size,2);
});

test("unchanged W4 D codec documents the retired captured semantic limitation separately",()=>{
 const request=simpleRequest(fixture.bold.source);
 const wrong=parseWholeMarkerResponse(request,fixture.bold.response,validate);
 assert.equal(wrong.ok,true,"existing parser only checks structure, markers, language and similarity");
 assert.equal(reassembleWholeMarkerResponse(request,wrong.valid),fixture.bold.observedTranslation);
 assert.doesNotMatch(fixture.bold.observedTranslation,/\*\*(?:核对|查看).*日程表\*\*/);
 // A literal range-faithful control uses the exact same existing contract.
 const correct=parseWholeMarkerResponse(request,fixture.bold.correctedRangeResponse,validate);
 assert.equal(correct.ok,true);assert.equal(reassembleWholeMarkerResponse(request,correct.valid),fixture.bold.expectedCorrectedTranslation);
});

test("W5 captured Live owner: one paid request, six failed parse terminals, no repair/cache/display/requeue",async()=>{
 // Public W5 now admits single-range messages only. Keep the raw retired response unchanged,
 // but remove only the bold source boundary so this test still reaches the strict W5 root parser.
 const rows=fixture.sources.map(row=>row.id==="live-bold"?{...row,content:"Please check the schedule before the meeting tomorrow."}:row);
 const h=harness(({payload,index})=>{assert.equal(index,1);assert.equal(payload["4.1"],"Please check the schedule before the meeting tomorrow.");assert.equal(Array.isArray(payload),false);return fixture.response;});
 try {
  grant(h,rows);await runLive(h,rows.slice().reverse());
  assert.equal(h.requests.length,1);assert.equal(h.requests[0].family,"D-batch");assert.equal(h.requests[0].transport,"native");
  assert.equal(h.commits.length,0);assert.equal(h.views.size,0);assert.deepEqual(h.cacheWrites,[]);assert.deepEqual(h.skipWrites,[]);assert.deepEqual(h.singles,[]);
  const ledger=h.plugin.getTranslationTerminalLedgerSnapshot();
  assert.equal(ledger.outcomes.failed,6);assert.equal(ledger.outcomes.translated,0);assert.equal(ledger.stages.parse,6);assert.equal(ledger.reasons["unexpected-root"],6);
  const snapshot=h.plugin.ensureProviderClient().getWholeMarkerBatchCanarySnapshot();assert.equal(snapshot.applicationDispatches,1);assert.equal(snapshot.repairs,0);assert.equal(snapshot.activeRequests,0);
  assert.equal(h.plugin.ensureProviderClient().getProviderAttemptSnapshot().active,0);assert.equal(h.plugin.ensureLiveTranslationQueue().getLiveSlotActiveCount(),0);
  console.log(JSON.stringify({case:"captured-live-owner",dispatches:1,failed:6,reason:"unexpected-root",displayCommits:0,cacheWrites:0,requeues:0,activeRequests:0}));
 }finally{await close(h);}
});

test("W5 existing transport gate: absent native fetch keeps typed and spends no canary grant",async()=>{
 const rows=[{id:"gate-a",content:"Please review this text."},{id:"gate-b",content:"Please review this text."}];
 const h=harness(({payload})=>{assert.equal(payload.schemaVersion,"semantic-batch-v1");return JSON.stringify({messages:payload.messages.map(row=>({id:row.id,segments:row.plan.segments.map(segment=>({id:segment.id,translation:"请审阅这段文字。"}))}))});},{nativeFetch:false});
 try {
  grant(h,rows);const items=prepared(h,rows);const result=await h.plugin.requestAiBatchTranslationDetailed(ENGINE,items);
  assert.equal(result.failureKind,null);assert.equal(h.requests.length,1);assert.equal(h.requests[0].transport,"callback");assert.equal(h.requests[0].family,"semantic-batch-v1");
  assert.equal(h.plugin.ensureProviderClient().getWholeMarkerBatchCanarySnapshot().admittedMessages,0);assert.ok(items.every(item=>!item.wholeMarkerBatchFinal));
 }finally{await close(h);}
});
