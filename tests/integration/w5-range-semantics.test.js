"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {planReceivedMarkdown}=require("../../src/planner/received-markdown-lossless-planner");
const {buildWholeMarkerRequest}=require("../../src/planner/translation-whole-marker-wire");
const {buildWholeMarkerBatchRequest,parseWholeMarkerBatchResponse}=require("../../src/planner/translation-whole-marker-batch");
const fixture=require("../fixtures/w5-range-semantics.json");
const validation={likelyTarget:t=>/\p{Script=Han}/u.test(t),similarity:(a,b)=>a===b?1:0};
function request(row){return buildWholeMarkerRequest(planReceivedMarkdown(row.source,{direction:"received",fieldPath:"body",targetLanguageId:"zh-CN"}),{},{targetLanguageId:"zh-CN"});}
test("W5 independent range tasks retain literal source identity before any semantic decoding",()=>{
 const rows=fixture.cases,batch=buildWholeMarkerBatchRequest(rows.map(row=>({id:row.id,request:request(row)})));
 assert.equal(batch.ok,true,batch.reason);
 const expected=Object.fromEntries(rows.flatMap((row,i)=>row.rangeSources.map((text,n)=>[`${i+1}.${n+1}`,text])));
 assert.deepEqual(JSON.parse(batch.wire),expected,"each source span must be a separate JSON string task, never a whole-sentence marker stream");
});

for(const [index,row] of fixture.cases.entries()) test(`W5 literal span control preserves ${row.id} under reversed response key order`,()=>{
 const companion=fixture.cases[(index+1)%fixture.cases.length];
 const batch=buildWholeMarkerBatchRequest([{id:row.id,request:request(row)},{id:companion.id,request:request(companion)}]);
 assert.equal(batch.ok,true,batch.reason);
 const response=Object.fromEntries([row,companion].flatMap((value,i)=>value.translations.map((text,n)=>[`${i+1}.${n+1}`,text])).reverse());
 const result=parseWholeMarkerBatchResponse(batch,JSON.stringify(response),validation);
 assert.equal(result.ok,true,result.reason);
 assert.equal(result.translations.get(row.id),row.expectedDisplay,row.meaning);
 assert.deepEqual(Object.values(result.items.get(row.id).valid),row.translations,"decoded range values remain attached to their source keys even if JSON property order changes");
});

// Multi-range fixtures remain authoritative offline codec mapping controls above.
// Public admission of these mixed-format sources is checked separately in
// w5-single-range-admission.test.js; model failures stay frozen in real-verification.
