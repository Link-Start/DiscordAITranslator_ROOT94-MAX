"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {harness,grant,close,ENGINE,CHANNEL}=require("../helpers/w5-captured-response-harness");
const {compileWholeMarkerSingle}=require("../../src/orchestrator/whole-marker-single-canary");
function prepared(h,rows){return rows.map(row=>h.plugin.prepareHistoricalAiBatchQueueItem({message:{id:row.id,channel_id:CHANNEL,content:row.content,embeds:[],attachments:[],author:{id:"other-user"}},channel:{id:CHANNEL},originalContentData:{content:row.content,embeds:[]}},CHANNEL,{id:"en",name:"English"},{id:"zh-CN",name:"Chinese"}));}
const translations={"Do":"请","not share":"不要分享","the preview link before the announcement.":"预览链接，在公告发布之前。","Please":"请","check the schedule":"核对日程表","before the meeting tomorrow.":"在明天开会之前。","Please read the update.":"请阅读更新。","The server is ready. You can send the next batch now.":"服务器已就绪。现在可以发送下一批。","Please check the schedule before tomorrow.":"请在明天之前核对日程表。","The last train leaves at nine tonight.":"末班火车今晚九点出发。","Run ⟦C0⟧ before publishing.":"发布之前运行 ⟦C0⟧。"};
function respond({payload}){
 translations["Do ⟦F0⟧not share⟦/F0⟧ the preview link before the announcement."]="公告发布之前，⟦F0⟧不要分享⟦/F0⟧预览链接。";
 translations["Please ⟦F0⟧check the schedule⟦/F0⟧ before the meeting tomorrow."]="请在明天开会之前⟦F0⟧核对日程表⟦/F0⟧。";
 const translate=text=>{const value=translations[String(text).trim()];assert.ok(value,`unrecognized isolated source ${text}`);return value;};
 if(payload.schemaVersion==="semantic-batch-v1")return JSON.stringify({messages:payload.messages.map(row=>({id:row.id,segments:row.plan.segments.map(segment=>({id:segment.id,translation:translate(segment.text)}))}))});
 return JSON.stringify(Object.fromEntries(Object.entries(payload).map(([key,text])=>[key,translate(text)])));
}
for(const source of ["Do **not share** the preview link before the announcement.","Please **check the schedule** before the meeting tomorrow."]) for(const complexLast of [false,true]) test(`W5 single-range admission keeps the entire mixed batch typed (${complexLast?"complex-last":"complex-first"}): ${source}`,async()=>{
 const rows=[{id:"complex",content:source},{id:"simple",content:"Please read the update."}],bodies=[];if(complexLast)rows.reverse();
 for(const enabled of [false,true]){
  const h=harness(respond);
  try{
   const items=prepared(h,rows);assert.ok(compileWholeMarkerSingle(h.plugin,items[complexLast?1:0].semanticRequest).ranges.length>1);
   if(enabled)grant(h,rows);
   const before=h.plugin.ensureProviderClient().getWholeMarkerBatchCanarySnapshot();
   const result=await h.plugin.requestAiBatchTranslationDetailed(ENGINE,items);
   assert.equal(result.failureKind,null);assert.equal(h.requests.length,1);assert.equal(h.requests[0].family,"semantic-batch-v1");bodies.push(h.requests[0].body);
   assert.ok(items.every(item=>!item.wholeMarkerBatchFinal));
   const after=h.plugin.ensureProviderClient().getWholeMarkerBatchCanarySnapshot();
   assert.equal(after.remainingMessages,before.remainingMessages);assert.equal(after.admittedMessages,0);assert.equal(after.applicationDispatches,0);assert.equal(after.repairs,0);assert.equal(after.activeRequests,0);
  }finally{await close(h);}
 }
 assert.equal(bodies[1],bodies[0],"grant must neither split nor add a request nor change default-off typed bytes");
});


test("W5 single-range admission retains paragraphs, whole bold/spoiler and inline code",async()=>{
 const rows=[
  {id:"paragraph",content:"The server is ready. You can send the next batch now."},
  {id:"whole-bold",content:"**Please check the schedule before tomorrow.**"},
  {id:"whole-spoiler",content:"||The last train leaves at nine tonight.||"},
  {id:"inline-code",content:"Run `npm test` before publishing."}
 ];
 const expected={paragraph:"服务器已就绪。现在可以发送下一批。","whole-bold":"**请在明天之前核对日程表。**","whole-spoiler":"||末班火车今晚九点出发。||","inline-code":"发布之前运行 `npm test`。"};
 const h=harness(respond);
 try{
  const items=prepared(h,rows);assert.ok(items.every(item=>compileWholeMarkerSingle(h.plugin,item.semanticRequest).ranges.length===1));grant(h,rows);
  const result=await h.plugin.requestAiBatchTranslationDetailed(ENGINE,items);
  assert.equal(result.failureKind,null);assert.equal(h.requests.length,1);assert.equal(h.requests[0].family,"D-batch");
  assert.deepEqual(Object.keys(h.requests[0].payload),["1.1","2.1","3.1","4.1"]);
  for(const item of items){assert.equal(item.wholeMarkerBatchFinal,true);const verdict=h.plugin.validateHistoricalTranslationJobResult(item,result.translations[item.message.id],{channelId:CHANNEL});assert.equal(verdict.ok,true,verdict.reason);assert.equal(verdict.translation.translatedContent,expected[item.message.id]);}
  const after=h.plugin.ensureProviderClient().getWholeMarkerBatchCanarySnapshot();assert.equal(after.admittedMessages,4);assert.equal(after.applicationDispatches,1);assert.equal(after.repairs,0);assert.equal(after.activeRequests,0);
 }finally{await close(h);}
});
