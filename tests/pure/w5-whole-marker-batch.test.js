const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {planReceivedMarkdown} = require('../../src/planner/received-markdown-lossless-planner');
const {buildWholeMarkerRequest, reassembleWholeMarkerResponse} = require('../../src/planner/translation-whole-marker-wire');
const modulePath = process.env.DTA_W5_CODEC_PATH || require('node:path').resolve(__dirname, '../../src/planner/translation-whole-marker-batch.js');
const api = fs.existsSync(modulePath) ? require(modulePath) : {};
const VALIDATE = {likelyTarget: value => /\p{Script=Han}/u.test(value), similarity: (source, target) => source === target ? 1 : 0};
function request(source = 'Please review ⟦0⟧.', protectedSegments = {'0':'LOCAL_VALUE'}) {
 const plan = planReceivedMarkdown(source, {direction:'received',fieldPath:'body',targetLanguageId:'zh-CN'});
 const result = buildWholeMarkerRequest(plan, protectedSegments, {targetLanguageId:'zh-CN'});
 assert.equal(result.ok,true,result.reason);
 return result;
}
function entries() {return [{id:'original-a',request:request()}, {id:'original-b',request:request()}];}

test('range-object v1 exposes independent source values and reads matching translation addresses', () => {
 const batch = api.buildWholeMarkerBatchRequest(entries());
 assert.deepEqual(JSON.parse(batch.wire), {'1.1':'Please review ⟦0⟧.','2.1':'Please review ⟦0⟧.'});
 assert.match(batch.contractRevision, /\.batch-range-object-v1\./);
 const parsed = api.parseWholeMarkerBatchResponse(batch, '{"2.1":"请复核 ⟦0⟧。","1.1":"请审阅 ⟦0⟧。"}', VALIDATE);
 assert.equal(parsed.ok, true, parsed.reason);
 assert.equal(parsed.translations.get('original-a'), '请审阅 ⟦0⟧。');
 assert.equal(parsed.translations.get('original-b'), '请复核 ⟦0⟧。');
});

test('builds two identical D sources with local IDs and one shared prompt', () => {
 assert.equal(typeof api.buildWholeMarkerBatchRequest,'function','W5 build API must exist');
 const input = entries(), batch = api.buildWholeMarkerBatchRequest(input);
 assert.equal(batch.ok,true,batch.reason);
 assert.deepEqual(JSON.parse(batch.wire),{'1.1':'Please review ⟦0⟧.','2.1':'Please review ⟦0⟧.'});
 assert.deepEqual(batch.entries.map(row=>[row.id,row.wireId]),[['original-a',1],['original-b',2]]);
 assert.equal(batch.entries[0].request,input[0].request);
 assert.equal(batch.entries[1].request,input[1].request);
 assert.equal(typeof batch.systemPrompt,'string');
 assert.match(batch.systemPrompt,/JSON/);
 assert.doesNotMatch(batch.wire,/original-a|original-b|LOCAL_VALUE|systemPrompt/);
 assert.equal(typeof batch.contractRevision,'string');
});

test('parses out-of-order addresses by original ID and reassembles independent local tokens', () => {
 assert.equal(typeof api.parseWholeMarkerBatchResponse,'function','W5 parse API must exist');
 const input=entries(), batch=api.buildWholeMarkerBatchRequest(input);
 const parsed=api.parseWholeMarkerBatchResponse(batch,JSON.stringify({'2.1':'请复核 ⟦0⟧。','1.1':'请审阅 ⟦0⟧。'}),VALIDATE);
 assert.equal(parsed.ok,true,parsed.reason);
 assert.equal(parsed.rootMalformed,false);
 assert.equal(parsed.items.size,2);
 assert.equal(parsed.valid.size,2);
 assert.equal(parsed.items.get('original-a').valid[1],'请审阅 ⟦0⟧。');
 assert.equal(parsed.items.get('original-b').valid[1],'请复核 ⟦0⟧。');
 assert.equal(reassembleWholeMarkerResponse(input[0].request,parsed.valid.get('original-a').valid),'请审阅 ⟦0⟧。');
 assert.equal(parsed.translations.get('original-b'),'请复核 ⟦0⟧。');
 assert.equal(Object.hasOwn(parsed.items.get('original-a'),'semanticSegments'),false);
});

test('one repair keeps wire IDs and sends only failed messages and marked ranges', () => {
 assert.equal(typeof api.buildWholeMarkerBatchRepairRequest,'function','W5 repair build API must exist');
 assert.equal(typeof api.mergeWholeMarkerBatchRepair,'function','W5 repair merge API must exist');
 const input=entries();
 input[1].request=request('The apple is red.\nThe ocean is blue.\nThe bird can fly.',{});
 input.push({id:'original-c',request:request()});
 const batch=api.buildWholeMarkerBatchRequest(input);
 const first=api.parseWholeMarkerBatchResponse(batch,JSON.stringify({'1.1':'请审阅 ⟦0⟧。','2.1':'苹果是红色的。','2.3':'The bird can fly.'}),VALIDATE);
 assert.equal(first.ok,false);
 assert.equal(first.rootMalformed,false);
 assert.equal(first.items.get('original-c').reason,'missing-item');
 const repair=api.buildWholeMarkerBatchRepairRequest(batch,first);
 assert.equal(repair.ok,true,repair.reason);
 assert.deepEqual(repair.entries.map(row=>[row.id,row.wireId]),[['original-b',2],['original-c',3]]);
 assert.deepEqual(repair.entries[0].request.ranges.map(range=>range.ordinal),[2,3]);
 assert.deepEqual(repair.entries[1].request.ranges.map(range=>range.ordinal),[1]);
 assert.deepEqual(JSON.parse(repair.wire),{'2.2':'The ocean is blue.','2.3':'The bird can fly.','3.1':'Please review ⟦0⟧.'});
 const repaired=api.parseWholeMarkerBatchResponse(repair,JSON.stringify({'2.2':'海洋是蓝色的。','2.3':'鸟可以飞。','3.1':'请核对 ⟦0⟧。'}),VALIDATE);
 const merged=api.mergeWholeMarkerBatchRepair(batch,first,repair,repaired);
 assert.equal(merged.ok,true,merged.reason);
 assert.equal(merged.items.get('original-a'),first.items.get('original-a'));
 assert.equal(merged.items.get('original-b').valid[1],'苹果是红色的。');
 assert.equal(merged.translations.get('original-b'),'苹果是红色的。\n海洋是蓝色的。\n鸟可以飞。');
 assert.equal(merged.repairAttempted,true);
 assert.equal(api.buildWholeMarkerBatchRepairRequest(batch,merged),null);
});

test('accepts the supported D spoiler contract family but only source-owned spoiler echo', () => {
 const make=(source)=>buildWholeMarkerRequest(planReceivedMarkdown(source,{direction:'received',fieldPath:'body',targetLanguageId:'zh-CN'}),{},{targetLanguageId:'zh-CN',allowSourceSpoilerEcho:true});
 const plain=make('Please review this text.'),spoiler=make('||Please review this text.||');
 assert.equal(plain.ok,true);assert.equal(spoiler.ok,true);
 assert.notEqual(plain.contractRevision,spoiler.contractRevision);
 const batch=api.buildWholeMarkerBatchRequest([{id:'plain',request:plain},{id:'spoiler',request:spoiler}]);
 assert.equal(batch.ok,true,batch.reason);
 const accepted=api.parseWholeMarkerBatchResponse(batch,JSON.stringify({'1.1':'请审阅此文字。','2.1':'||请审阅此文字。||'}),VALIDATE);
 assert.equal(accepted.ok,true,accepted.reason);
 assert.equal(accepted.translations.get('spoiler'),'||请审阅此文字。||');
 const unowned=api.parseWholeMarkerBatchResponse(batch,JSON.stringify({'1.1':'||请审阅此文字。||','2.1':'||请审阅此文字。||'}),VALIDATE);
 assert.equal(unowned.items.get('plain').ok,false,'a sibling spoiler must not grant plain text permission to introduce ||');
 assert.equal(unowned.items.get('plain').reason,'unsafe-structure');
 assert.equal(unowned.items.get('plain').repairable,false);
 assert.equal(unowned.items.get('spoiler').ok,true);
 assert.equal(api.buildWholeMarkerBatchRepairRequest(batch,unowned),null);
});

test('rejects unknown D base revisions and mixed target languages', () => {
 const input=entries();
 assert.equal(api.buildWholeMarkerBatchRequest([{id:'a',request:{...input[0].request,contractRevision:'unknown-base'}}]).ok,false);
 assert.equal(api.buildWholeMarkerBatchRequest([input[0],{id:'b',request:{...input[1].request,targetLanguageId:'en'}}]).reason,'mixed-target-language');
});

for (const [name,wire,reason] of [
 ['unknown message ID','{"1.1":"请审阅 ⟦0⟧。","9.1":"额外项目。"}','unknown-id'],
 ['unknown range ID','{"1.1":"请审阅 ⟦0⟧。","2.9":"额外范围。"}','unknown-id'],
 ['duplicate ID','{"1.1":"请审阅 ⟦0⟧。","1.1":"重复 ⟦0⟧。"}','duplicate-id'],
 ['escaped duplicate ID','{"1.1":"请审阅 ⟦0⟧。","\\u0031.1":"重复 ⟦0⟧。"}','duplicate-id'],
 ['missing ordinal','{"1":"测试"}','invalid-id'],
 ['extra ordinal','{"1.1.1":"测试"}','invalid-id'],
 ['zero ID','{"0.1":"测试"}','invalid-id'],
 ['negative ID','{"-1.1":"测试"}','invalid-id'],
 ['unsafe integer ID','{"9007199254740992.1":"测试"}','invalid-id'],
 ['leading zero ID','{"01.1":"测试"}','invalid-id'],
 ['extra field','{"1.1":"测试","extra":"测试"}','invalid-id'],
 ['missing value','{"1.1":}','batch-shape'],
 ['object value','{"1.1":{}}','batch-shape'],
 ['number value','{"1.1":2}','batch-shape'],
 ['null value','{"1.1":null}','batch-shape'],
 ['nested envelope','{"items":{"1.1":"测试"}}','batch-shape'],
 ['old tuple root','[[1,"⟪1⟫测试"]]','unexpected-root'],
 ['old mixed tuple root','[[1,"⟪1⟫测试"],2,[2,"⟪1⟫测试"]]','unexpected-root'],
 ['markdown fence','```json\n{"1.1":"测试"}\n```','unexpected-root'],
 ['BOM','\ufeff{"1.1":"测试"}','unexpected-root'],
 ['explanatory prefix','Here is the result: {"1.1":"测试"}','unexpected-root'],
 ['trailing data','{"1.1":"测试"} false','unexpected-root'],
 ['trailing comma','{"1.1":"测试",}','batch-shape'],
 ['decoded newline','{"1.1":"第一行\\n第二行"}','range-shape'],
 ['decoded line separator','{"1.1":"第一行\\u2028第二行"}','range-shape'],
 ['injected marker','{"1.1":"测试⟪2⟫别的内容"}','range-shape'],
 ['escaped marker','{"1.1":"测试\\u27ea2\\u27eb别的内容"}','range-shape'],
 ['invalid escape','{"1.1":"\\q"}','batch-shape'],
 ['raw newline','{"1.1":"第一行\n第二行"}','batch-shape']
]) test(`root ${name} fails closed for every message without repair`, () => {
 const batch=api.buildWholeMarkerBatchRequest(entries());
 const result=api.parseWholeMarkerBatchResponse(batch,wire,VALIDATE);
 assert.equal(result.ok,false);assert.equal(result.rootMalformed,true);assert.equal(result.reason,reason);
 assert.equal(result.valid.size,0);assert.equal(result.translations.size,0);
 assert.equal(result.items.size,2);
 for(const item of result.items.values()){assert.equal(item.ok,false);assert.equal(item.repairable,false);}
 assert.equal(api.buildWholeMarkerBatchRepairRequest(batch,result),null);
});

test('range-object input rejects duplicate or non-positive unsafe range addresses instead of overwriting source', () => {
 const original = request(), range = original.ranges[0];
 for (const ranges of [[range, range], [{...range,ordinal:0}], [{...range,ordinal:-1}], [{...range,ordinal:1.5}], [{...range,ordinal:9007199254740992}]]) {
  const built = api.buildWholeMarkerBatchRequest([{id:'source',request:{...original,ranges}}]);
  assert.equal(built.ok,false); assert.equal(built.reason,'invalid-range');
 }
});

test('range-object accepts decoded known keys and JSON punctuation within a string value', () => {
 const batch = api.buildWholeMarkerBatchRequest([{id:'source',request:request('Read this text.',{})}]);
 const text = '请阅读 "这个" {文本}: [内容], \\ /。';
 const parsed = api.parseWholeMarkerBatchResponse(batch, ' \r\n{ "\\u0031.\\u0031" : '+JSON.stringify(text)+' }\t', VALIDATE);
 assert.equal(parsed.ok,true,parsed.reason); assert.equal(parsed.translations.get('source'),text);
});

test('a missing known ID affects only that item and is repairable even for an empty object',()=>{
 const batch=api.buildWholeMarkerBatchRequest(entries());
 const partial=api.parseWholeMarkerBatchResponse(batch,'{"1.1":"请审阅 ⟦0⟧。"}',VALIDATE);
 assert.equal(partial.rootMalformed,false);assert.equal(partial.valid.size,1);
 assert.equal(partial.items.get('original-a').ok,true);
 assert.equal(partial.items.get('original-b').reason,'missing-item');
 assert.equal(partial.items.get('original-b').repairable,true);
 assert.deepEqual(api.buildWholeMarkerBatchRepairRequest(batch,partial).entries.map(row=>row.wireId),[2]);
 const empty=api.parseWholeMarkerBatchResponse(batch,'{}',VALIDATE);
 assert.equal(empty.rootMalformed,false);assert.equal(empty.items.size,2);
 assert.deepEqual(api.buildWholeMarkerBatchRepairRequest(batch,empty).entries.map(row=>row.wireId),[1,2]);
});

test('D-level malformed output is terminal for that item and leaves a valid sibling available',()=>{
 const batch=api.buildWholeMarkerBatchRequest(entries());
 const first=api.parseWholeMarkerBatchResponse(batch,'{"1.1":"请审阅 ⟦0⟧。","2.1":"||额外格式||"}',VALIDATE);
 assert.equal(first.rootMalformed,false);
 assert.equal(first.valid.size,1);
 assert.equal(first.items.get('original-b').reason,'unsafe-structure');
 assert.equal(first.items.get('original-b').rootMalformed,true);
 assert.equal(first.items.get('original-b').repairable,false);
 assert.equal(api.buildWholeMarkerBatchRepairRequest(batch,first),null);
});

test('failed repair is terminal, preserves successful siblings and never creates typed fallback',()=>{
 const batch=api.buildWholeMarkerBatchRequest(entries());
 const first=api.parseWholeMarkerBatchResponse(batch,'{"1.1":"请审阅 ⟦0⟧。","2.1":"Please review ⟦0⟧."}',VALIDATE);
 const repair=api.buildWholeMarkerBatchRepairRequest(batch,first);
 const again=api.parseWholeMarkerBatchResponse(repair,'{"2.1":"Please review ⟦0⟧."}',VALIDATE);
 const merged=api.mergeWholeMarkerBatchRepair(batch,first,repair,again);
 assert.equal(merged.ok,false);assert.equal(merged.repairAttempted,true);
 assert.equal(merged.items.get('original-a'),first.items.get('original-a'));
 assert.equal(merged.items.get('original-b').reason,'wrong-language');
 assert.equal(merged.items.get('original-b').repairable,false);
 assert.equal(merged.valid.size,1);
 assert.equal(api.buildWholeMarkerBatchRepairRequest(batch,merged),null);
 assert.equal(api.mergeWholeMarkerBatchRepair(batch,merged,repair,again),merged);
 assert.equal(Object.hasOwn(merged,'fallback'),false);
 assert.equal(Object.hasOwn(merged.items.get('original-b'),'semanticSegments'),false);
});

test('malformed repair root discards repair tuples without discarding a valid original sibling',()=>{
 const batch=api.buildWholeMarkerBatchRequest(entries());
 const first=api.parseWholeMarkerBatchResponse(batch,'{"1.1":"请审阅 ⟦0⟧。"}',VALIDATE);
 const repair=api.buildWholeMarkerBatchRepairRequest(batch,first);
 const bad=api.parseWholeMarkerBatchResponse(repair,'{"2.1":"请审阅 ⟦0⟧。","9.1":"额外"}',VALIDATE);
 assert.equal(bad.rootMalformed,true);
 const merged=api.mergeWholeMarkerBatchRepair(batch,first,repair,bad);
 assert.equal(merged.valid.size,1);
 assert.equal(merged.items.get('original-a'),first.items.get('original-a'));
 assert.equal(merged.items.get('original-b').reason,'unknown-id');
 assert.equal(merged.items.get('original-b').repairable,false);
 assert.equal(api.buildWholeMarkerBatchRepairRequest(batch,merged),null);
});

test('no original message ID is special and duplicates, empty IDs and empty batches are rejected',()=>{
 const r=request();
 for(const input of [[],null,[{id:'',request:r}],[{id:'  ',request:r}],[{id:1,request:r}],[{id:'x',request:r},{id:'x',request:r}]]) assert.equal(api.buildWholeMarkerBatchRequest(input).ok,false);
 const batch=api.buildWholeMarkerBatchRequest([{id:'__proto__',request:r},{id:'constructor',request:r}]);
 const result=api.parseWholeMarkerBatchResponse(batch,'{"1.1":"请审阅 ⟦0⟧。","2.1":"请检查 ⟦0⟧。"}',VALIDATE);
 assert.equal(result.ok,true);assert.equal(result.items.get('__proto__').ok,true);assert.equal(result.items.get('constructor').ok,true);
});

test('ten-item and complete UTF-8 request budgets are hard caps including the shared prompt',()=>{
 const r=request(),ten=Array.from({length:10},(_,i)=>({id:`m-${i}`,request:r}));
 const batch=api.buildWholeMarkerBatchRequest(ten);
 assert.equal(batch.ok,true,batch.reason);
 assert.equal(api.buildWholeMarkerBatchRequest([...ten,{id:'eleventh',request:r}],{maxItems:100}).reason,'item-budget');
 const single=[{id:'a',request:r}],built=api.buildWholeMarkerBatchRequest(single);
 const total=Buffer.byteLength(built.wire,'utf8')+Buffer.byteLength(built.systemPrompt,'utf8');
 assert.equal(built.requestBytes,total);
 assert.equal(api.buildWholeMarkerBatchRequest(single,{maxRequestBytes:total}).ok,true);
 assert.equal(api.buildWholeMarkerBatchRequest(single,{maxRequestBytes:total-1}).reason,'request-budget');
 const huge=request('Review '.repeat(9300),{});
 assert.equal(api.buildWholeMarkerBatchRequest([{id:'huge',request:huge}],{maxRequestBytes:999999}).reason,'request-budget');
 for(const opts of [{maxItems:0},{maxRequestBytes:-1},{maxResponseBytes:0},{maxItems:1.5}]) assert.equal(api.buildWholeMarkerBatchRequest(single,opts).reason,'invalid-options');
});

test('the 64 KiB response cap counts raw UTF-8 bytes before parsing and options never relax it',()=>{
 const batch=api.buildWholeMarkerBatchRequest([{id:'a',request:request('Review this.',{})}]);
 const content=JSON.stringify({'1.1':'界'.repeat(20000)});
 const exact=content+' '.repeat(65536-Buffer.byteLength(content,'utf8'));
 assert.equal(Buffer.byteLength(exact,'utf8'),65536);
 assert.equal(api.parseWholeMarkerBatchResponse(batch,exact,VALIDATE).ok,true);
 const oversized=api.parseWholeMarkerBatchResponse(batch,exact+' ',{...VALIDATE,maxResponseBytes:999999});
 assert.equal(oversized.reason,'response-budget');assert.equal(oversized.rootMalformed,true);assert.equal(oversized.valid.size,0);
 assert.equal(api.parseWholeMarkerBatchResponse(batch,content,{...VALIDATE,maxResponseBytes:Buffer.byteLength(content)-1}).reason,'response-budget');
 const eleven=JSON.stringify(Object.fromEntries(Array.from({length:11},(_,i)=>[`${i+1}.1`,'测试'])));
 assert.equal(api.parseWholeMarkerBatchResponse(batch,eleven).reason,'item-budget');
});


// Frozen real prompt-v1 failure, not a success fixture or a new provider call.
const CAPTURED_PROMPT_V1_JSONL = {
  "originalRunSHA256": "FD9A7630A98CE869B121DA0C6B429554819D016D875F46D2C6700B9766264DD1",
  "trial": 4,
  "wire": "[[1,\"⟪1⟫Run ⟦C0⟧ before you publish the new version.\"],[2,\"||⟪1⟫The final train leaves at nine tonight.\\n||\"],[3,\"⟪1⟫Please\\n **⟪2⟫check the schedule\\n** ⟪3⟫before the meeting tomorrow.\"],[4,\"⟪1⟫The server is ready. You can send the next batch now.\"]]",
  "content": "[1,\"⟪1⟫发布新版本前请先运行 ⟦C0⟧。\"]\n[2,\"||⟪1⟫最后一班火车将于今晚九点出发。\\n||\"]\n[3,\"⟪1⟫请在明日会议前\\n **⟪2⟫核对日程安排\\n** ⟪3⟫。\"]\n[4,\"⟪1⟫服务器已就绪。您现在可以发送下一批数据。\"]",
  "sources": [
    {
      "id": "w5-command",
      "source": "Run `npm test` before you publish the new version."
    },
    {
      "id": "w5-spoiler",
      "source": "||The final train leaves at nine tonight.||"
    },
    {
      "id": "w5-bold",
      "source": "Please **check the schedule** before the meeting tomorrow."
    },
    {
      "id": "w5-plain",
      "source": "The server is ready. You can send the next batch now."
    }
  ]
};

function capturedFourBatch() {
 return api.buildWholeMarkerBatchRequest(CAPTURED_PROMPT_V1_JSONL.sources.map(row=>({id:row.id,request:buildWholeMarkerRequest(planReceivedMarkdown(row.source,{direction:'received',fieldPath:'body',targetLanguageId:'zh-CN'}),{},{targetLanguageId:'zh-CN',allowSourceSpoilerEcho:true})})));
}
test('range-object prompt specifies independent fixed spans and one object without answer-specific examples',()=>{
 const batch=capturedFourBatch();assert.equal(batch.ok,true,batch.reason);
 assert.match(batch.contractRevision,/\.batch-range-object-v1\.prompt-v2\.validator-v1$/);
 assert.match(batch.systemPrompt,/one complete JSON object/);
 assert.match(batch.systemPrompt,/independent fixed-span replacement/);
 assert.match(batch.systemPrompt,/never move meaning between keys/);
 assert.match(batch.systemPrompt,/Do not translate the whole message and then divide it again/);
 assert.match(batch.systemPrompt,/action, object, negation and time\/place relation/);
 assert.doesNotMatch(batch.systemPrompt,/check the schedule|核对日程|明天开会/);
});
test('captured prompt-v1 JSONL remains an unrepairable root failure without envelope cleaning',()=>{
 const batch=capturedFourBatch();assert.equal(batch.ok,true,batch.reason);
 // Preserve the old physical wire as history; full D requests remain local in wire v2.
 assert.equal(JSON.stringify(batch.entries.map(entry=>[entry.wireId,entry.request.wire])),CAPTURED_PROMPT_V1_JSONL.wire);
 const parsed=api.parseWholeMarkerBatchResponse(batch,CAPTURED_PROMPT_V1_JSONL.content,VALIDATE);
 assert.equal(parsed.ok,false);assert.equal(parsed.rootMalformed,true);assert.equal(parsed.reason,'unexpected-root');
 assert.equal(parsed.valid.size,0);assert.equal(parsed.items.size,4);
 assert.equal(api.buildWholeMarkerBatchRepairRequest(batch,parsed),null);
});
test('range-object source bold and code are locally reassembled while source spoiler echo remains supported',()=>{
 const batch=capturedFourBatch();
 const parsed=api.parseWholeMarkerBatchResponse(batch,JSON.stringify({
  '1.1':'在发布新版本之前运行 ⟦C0⟧。',
  '2.1':'||最后一班火车在今晚九点出发。||',
  '3.1':'请','3.2':'核对日程安排','3.3':'在明天的会议之前。',
  '4.1':'服务器已就绪。您现在可以发送下一批数据。'
 }),VALIDATE);
 assert.equal(parsed.ok,true,parsed.reason);
 assert.equal(parsed.translations.get('w5-bold'),'请 **核对日程安排** 在明天的会议之前。');
 assert.equal(parsed.translations.get('w5-command'),'在发布新版本之前运行 '+String.fromCharCode(96)+'npm test'+String.fromCharCode(96)+'。');
 assert.equal(parsed.translations.get('w5-spoiler'),'||最后一班火车在今晚九点出发。||');
});


const CAPTURED_WIRE_V1_PROMPT_V2 = {
  "originalRunSHA256": "2741E556E16410F95135C2E15BCF378AE07E6F9542AF9CFFA5B04A0A0EDB2073",
  "wire": "[[1,\"⟪1⟫Run ⟦C0⟧ before you publish the new version.\"],[2,\"||⟪1⟫The final train leaves at nine tonight.\\n||\"],[3,\"⟪1⟫Please\\n **⟪2⟫check the schedule\\n** ⟪3⟫before the meeting tomorrow.\"],[4,\"⟪1⟫The server is ready. You can send the next batch now.\"]]",
  "content": "[[1,\"⟪1⟫发布新版本之前，请先运行 ⟦C0⟧。\"],[2,\"||⟪1⟫末班火车将在今晚九点开出。\\n||\"],[3,\"⟪1⟫请在\\n **⟪2⟫明天的会议之前\\n** ⟪3⟫查看日程安排。\"],[4,\"⟪1⟫服务器已就绪。您现在可以发送下一批数据了。\"]]"
};

test('range-object wire sends independent masked values and keeps complete source D requests local',()=>{
 const batch=capturedFourBatch();assert.equal(batch.ok,true,batch.reason);
 assert.match(batch.contractRevision,/\.batch-range-object-v1\.prompt-v2\.validator-v1$/);
 assert.deepEqual(JSON.parse(batch.wire),{
  '1.1':'Run ⟦C0⟧ before you publish the new version.',
  '2.1':'The final train leaves at nine tonight.',
  '3.1':'Please','3.2':'check the schedule','3.3':'before the meeting tomorrow.',
  '4.1':'The server is ready. You can send the next batch now.'
 });
 assert.doesNotMatch(batch.wire,/\*\*|\|\||npm test/);
 assert.match(batch.entries[1].request.wire,/\|\|/);
 assert.match(batch.entries[2].request.wire,/\*\*/);
 assert.equal(batch.entries[0].request.contextMarkers[0].raw,String.fromCharCode(96)+'npm test'+String.fromCharCode(96));
 assert.equal(JSON.stringify(batch.entries.map(entry=>[entry.wireId,entry.request.wire])),CAPTURED_WIRE_V1_PROMPT_V2.wire);
});
test('range-object repair omits successful sibling messages and successful source range text',()=>{
 const input=[{id:'multi',request:request('The apple is red.\nThe ocean is blue.\nThe bird can fly.',{})},{id:'sibling',request:request('The moon is bright.',{})}];
 const batch=api.buildWholeMarkerBatchRequest(input);
 const first=api.parseWholeMarkerBatchResponse(batch,JSON.stringify({'1.1':'苹果是红色的。','1.2':'The ocean is blue.','1.3':'鸟会飞。','2.1':'月亮明亮。'}),VALIDATE);
 const repair=api.buildWholeMarkerBatchRepairRequest(batch,first);
 assert.deepEqual(JSON.parse(repair.wire),{'1.2':'The ocean is blue.'});
 assert.equal(repair.entries[0].request.ranges.length,1);
 assert.equal(repair.entries[0].request.totalRangeCount,3);
 assert.match(repair.systemPrompt,/independent fixed-span replacement/,'a single remaining repair range still belongs to a multi-range source');
 assert.doesNotMatch(repair.systemPrompt,/as one complete message/);
 assert.doesNotMatch(repair.wire,/apple|bird|moon|⟪1⟫|⟪3⟫/);
 assert.equal(repair.entries[0].request.plan,input[0].request.plan);
 const repaired=api.parseWholeMarkerBatchResponse(repair,'{"1.2":"海洋是蓝色的。"}',VALIDATE);
 const merged=api.mergeWholeMarkerBatchRepair(batch,first,repair,repaired);
 assert.equal(merged.ok,true);assert.equal(merged.items.get('sibling'),first.items.get('sibling'));
 assert.equal(merged.translations.get('multi'),'苹果是红色的。\n海洋是蓝色的。\n鸟会飞。');
});
test('captured prompt-v2 unsafe bold output remains rejected as the retired tuple contract',()=>{
 const batch=capturedFourBatch(),parsed=api.parseWholeMarkerBatchResponse(batch,CAPTURED_WIRE_V1_PROMPT_V2.content,VALIDATE);
 assert.equal(parsed.ok,false);assert.equal(parsed.rootMalformed,true);assert.equal(parsed.valid.size,0);
 assert.equal(parsed.items.get('w5-bold').reason,'unexpected-root');
 assert.equal(parsed.items.get('w5-bold').repairable,false);
 assert.equal(api.buildWholeMarkerBatchRepairRequest(batch,parsed),null);
});
test('range-object budgets the sent values rather than local unmarked context',()=>{
 const source='说明'.repeat(2000)+'\nTranslate this sentence.';
 const local=buildWholeMarkerRequest(planReceivedMarkdown(source,{direction:'received',fieldPath:'body',targetLanguageId:'zh-CN'}),{},{targetLanguageId:'zh-CN',forceWindowed:false});assert.equal(local.ok,true,local.reason);
 const input=[{id:'local-context',request:local}],batch=api.buildWholeMarkerBatchRequest(input);
 assert.equal(batch.ok,true,batch.reason);
 assert.deepEqual(JSON.parse(batch.wire),{'1.1':'Translate this sentence.'});
 const actual=Buffer.byteLength(batch.wire)+Buffer.byteLength(batch.systemPrompt);
 assert.equal(batch.requestBytes,actual);
 assert.ok(batch.requestBytes < Buffer.byteLength(local.wire)+Buffer.byteLength(batch.systemPrompt));
 assert.equal(api.buildWholeMarkerBatchRequest(input,{maxRequestBytes:actual}).ok,true);
 assert.equal(api.buildWholeMarkerBatchRequest(input,{maxRequestBytes:actual-1}).reason,'request-budget');
});
