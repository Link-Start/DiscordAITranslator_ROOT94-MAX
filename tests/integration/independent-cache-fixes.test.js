const test = require("node:test");
const assert = require("node:assert/strict");
const {createPluginInstance} = require("../helpers/createPluginInstance");
const {createPluginTranslationCacheStore} = require("../../src/cache/translation-cache-wiring");
const {createTranslationCacheStore} = require("../../src/cache/translation-cache-store");
const {createSemanticRequest, validateSemanticResponse, planSemanticRepair} = require("../../src/planner/translation-semantic-runtime");
const {isNameLikeText} = require("../../src/planner/translation-soft-validation");
const CHANNEL = "independent-cache-channel", ENGINE = "oaicompat";
const clone = value => value == null ? null : JSON.parse(JSON.stringify(value));
const messageOf = (content = "Atomic Gains", embeds = []) => ({id: "independent-cache-message", channel_id: CHANNEL, content, embeds, author: {id: "fixture-author"}});

// The project bundle supplies real normalization, signature, protection and P3 policy.
// The store under test is loaded from source through the production cache wiring.
// Disk, timers and network are doubles; this is offline cache integration, not client E2E.
function harness(disk = {}) {
 let timerId = 0, transportCalls = 0, contextCalls = 0;
 const timers = new Map();
 const BDFDB = {TimeUtils: {timeout: callback => {timers.set(++timerId, callback); return timerId;}, clear: id => timers.delete(id)}, DataUtils: {load: (_p, key) => clone(disk[key]), save: (value, _p, key) => {disk[key] = clone(value);}}, LibraryRequires: {request: () => {transportCalls++; throw new Error("Unexpected transport");}}};
 const plugin = createPluginInstance({settings: {engines: {translator: ENGINE, backup: "----"}, filters: {useLocalLanguagePrecheck: false, skipMixedReceivedMessages: false, minimumAutoTranslateLength: 1}, choices: {received: {input: "en", output: "zh-CN"}}}, bdfdb: BDFDB});
 plugin.ensureSettingsStore().replaceAuthKeys({[ENGINE]: {key: "fixture-key", endpoint: "https://independent-cache.invalid/v1/chat/completions", model: "fixture-model", interfaceFormat: "openai_chat"}});
 const store = createPluginTranslationCacheStore({plugin, BDFDB, now: () => 1, createStore: options => createTranslationCacheStore({...options, getSemanticCacheContext: (...args) => {contextCalls++; return options.getSemanticCacheContext(...args);}})});
 plugin.ensureTranslationCacheStore = () => store;
 store.loadPersisted();
 return {plugin, store, disk, contextCalls: () => contextCalls, close() {store.cancelPendingSave(); assert.equal(timers.size, 0); assert.equal(transportCalls, 0);}};
}
function sourceOf(h, message) {return h.plugin.extractOriginalContentData(message);}
function stored(h, message, text) {
 const source = sourceOf(h, message), signature = h.plugin.createReceivedTranslationSignature(message, CHANNEL, source);
 return h.plugin.createStoredReceivedTranslationData(message, CHANNEL, source, signature, text, {id: "en"}, {id: "zh-CN"}, true);
}
function typed(h, message) {
 const request = h.plugin.createAtomicSemanticRevisionContract(message.content, {place: "received", channelId: CHANNEL, inputLanguageId: "en", targetLanguageId: "zh-CN", fieldPath: "body"});
 const outcome = h.plugin.validateAtomicSemanticResponse(request, {segments: JSON.parse(request.wire).segments.map(segment => ({id: segment.id, translation: segment.text}))}, {likelyTarget: value => h.plugin.isTranslationLikelyInTargetLanguage(value, "zh-CN"), similarity: (a,b) => h.plugin.getTextSimilarityScore(a,b)});
 assert.equal(outcome.ok, true); assert.equal(request.workload.fields.validatorVersion, "segment-validator-v2");
 return Object.assign(stored(h,message,outcome.translation), {semanticRevision: request.semanticRevision, semanticWorkloadKey: request.workload.key, planHash: h.plugin.getAtomicSemanticPlanHash(request), validatorVersion: request.workload.fields.validatorVersion, outputSchemaVersion: request.workload.fields.outputSchemaVersion});
}
function persistAndRestart(writer, message, translation, mutate = () => {}) {
 writer.plugin.persistTranslationCacheEntry(message.id, translation.signature, translation);
 assert.equal(writer.store.flushPendingSave(), true);
 mutate(writer.disk.translationCache[message.id]);
 return harness(writer.disk);
}
test("independent channel mismatch is a non-destructive miss before compatible paid dual-read", () => {
 const writer=harness(), message=messageOf(); let reader;
 try {
  reader=persistAndRestart(writer,message,typed(writer,message));
  const before=clone(reader.store.getEntry(message.id));
  assert.equal(reader.plugin.getCachedReceivedTranslation(message,"different-channel",sourceOf(reader,message)),null);
  assert.deepEqual(reader.store.getEntry(message.id),before);
  assert.equal(reader.contextCalls(),0,"channel mismatch is rejected before semantic construction");
  assert.ok(reader.plugin.getCachedReceivedTranslation(message,CHANNEL,sourceOf(reader,message)),"original channel still hits");
 } finally {writer.close(); if(reader)reader.close();}
});
function embedMessage() {return messageOf("", [{id: "embed-1", title: "Release Notes", description: "Please read the updated announcement.", footer: {text: "See you tomorrow"}, fields: []}]);}
function translatedEmbed(h,message) {
 const text=h.plugin.buildTranslationRequestText(sourceOf(h,message)).replace("Release Notes","更新说明").replace("Please read the updated announcement.","请阅读更新后的公告。").replace("See you tomorrow","明天见");
 const value=stored(h,message,text);
 assert.equal(value.translatedContent,""); assert.equal(value.embeds["embed-1"].complete,true); assert.equal(value.embeds["embed-1"].hasTranslatedContent,true);
 return value;
}
test("independent empty-body complete translated Embed remains a paid JSON-restarted cache hit", () => {
 const writer=harness(), message=embedMessage();let reader;
 try {
  reader=persistAndRestart(writer,message,translatedEmbed(writer,message));
  const hit=reader.plugin.getCachedReceivedTranslation(message,CHANNEL,sourceOf(reader,message));
  assert.ok(hit,"translation lives in Embed although body is empty");
  assert.equal(hit.translatedContent,""); assert.equal(hit.embeds["embed-1"].description,"请阅读更新后的公告。");
  assert.equal(hit.embeds["embed-1"].footerText,"明天见"); assert.equal(reader.contextCalls(),0);
 } finally {writer.close();if(reader)reader.close();}
});
for(const corruption of ["incomplete","empty-flag","empty-container"]) test(`independent empty-body Embed still rejects ${corruption}`,()=>{
 const writer=harness(),message=embedMessage();let reader;
 try{
  reader=persistAndRestart(writer,message,translatedEmbed(writer,message),entry=>{if(corruption==="incomplete")entry.translation.embeds["embed-1"].complete=false;else if(corruption==="empty-flag")entry.translation.embeds["embed-1"].hasTranslatedContent=false;else entry.translation.embeds={};});
  assert.equal(reader.plugin.getCachedReceivedTranslation(message,CHANNEL,sourceOf(reader,message)),null);
 }finally{writer.close();if(reader)reader.close();}
});
for(const signatureKind of ["same-signature","paid-dual-read"]) test(`independent v2 typed kept cache retains ${signatureKind} without policy migration`,()=>{
 const writer=harness(),message=messageOf();let reader;
 try{
  reader=persistAndRestart(writer,message,typed(writer,message),entry=>{if(signatureKind==="paid-dual-read")entry.signature="previous-config-signature";});
  const hit=reader.plugin.getCachedReceivedTranslation(message,CHANNEL,sourceOf(reader,message));assert.ok(hit);assert.equal(hit.translatedContent,message.content);assert.equal(hit.validatorVersion,"segment-validator-v2");
  assert.equal(reader.contextCalls(),signatureKind==="same-signature"?0:1,"no extra semantic rebuild on same-signature hit");
 }finally{writer.close();if(reader)reader.close();}
});
test("name casing stays compatible while unresolved ordinary prose fails the whole result",()=>{
 for(const name of ["Will Smith","Apple"])assert.equal(isNameLikeText(name),true,name);
 // Uncased text cannot be proved to be a name just by counting whitespace-delimited words.
 for(const text of ["山田太郎","不要发布这个"])assert.equal(isNameLikeText(text),false,text);
 const checks={likelyTarget:value=>/\p{Script=Han}/u.test(value),similarity:(a,b)=>a===b?1:0};
 const request=createSemanticRequest({engineKey:ENGINE,source:"please bring the blue notebook to the meeting tomorrow",targetLanguageId:"zh-CN"});
 assert.equal(request.workload.fields.validatorVersion,"segment-validator-v2");
 const echo=r=>({segments:JSON.parse(r.wire).segments.map(s=>({id:s.id,translation:s.text}))});
 const first=validateSemanticResponse(request,echo(request),checks);assert.equal(first.ok,false);
 const repair=planSemanticRepair(request,first,{parentSettled:true});assert.equal(repair.dispatchable,true);assert.equal(repair.nextAttempt,2);
 const second=validateSemanticResponse(repair.requests[0],echo(repair.requests[0]),checks);assert.equal(second.ok,false);assert.equal(second.keptCount,0);
 const last=planSemanticRepair(repair.requests[0],second,{parentSettled:true}).requests[0];
 const final=validateSemanticResponse(last,echo(last),checks);assert.equal(final.ok,false);assert.equal(final.translation,null);assert.equal(planSemanticRepair(last,final,{parentSettled:true}).dispatchable,false,"existing budget is exhausted without publishing failed fragments");
});

for (const source of ["这个nora已经更新", "这里是 описание ошибки", "这个nice真的好用\n" + "汉".repeat(4100)]) test(`mixed cache requires the new signature: ${source.slice(0,20)}`, () => {
 const writer=harness(),message=messageOf(source);let reader;
 try {
  const translation=stored(writer,message,"更新已完成。");
  const request=writer.plugin.createAtomicSemanticRevisionContract(source,{place:"received",channelId:CHANNEL,inputLanguageId:"en",targetLanguageId:"zh-CN",fieldPath:"body"});
  Object.assign(translation,{semanticRevision:request.semanticRevision,semanticWorkloadKey:request.workload.key,planHash:writer.plugin.getAtomicSemanticPlanHash(request)});
  reader=persistAndRestart(writer,message,translation,entry=>{const previous=JSON.parse(translation.signature);assert.ok(previous.sourceContextVersion);delete previous.sourceContextVersion;entry.signature=JSON.stringify(previous);});
  assert.equal(reader.plugin.getCachedReceivedTranslation(message,CHANNEL,sourceOf(reader,message)),null,"old paid result cannot bypass mixed-language policy through matching semantic metadata");
 } finally {writer.close();if(reader)reader.close();}
});

test("mixed-language embed fields receive the same cache migration signature", () => {
 const h=harness(),message=messageOf("",[{id:"embed-context",description:"这里是 описание ошибки",fields:[]}]);
 try {assert.ok(JSON.parse(h.plugin.createReceivedTranslationSignature(message,CHANNEL,sourceOf(h,message))).sourceContextVersion);}finally{h.close();}
});
