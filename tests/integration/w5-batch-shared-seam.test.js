const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {createPluginInstance} = require("../helpers/createPluginInstance");
const ENGINE = "custom-w5shared", CHANNEL = "w5-shared";
const isRangeObject = value => value && !Array.isArray(value) && Object.keys(value).every(key => /^[1-9]\d*\.[1-9]\d*$/.test(key));
const flatReply = (wire, translate) => JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(wire)).map(([key,text]) => [key,translate(text,key)])));
function fixture(respond = wire => flatReply(wire, () => "请检查这个更新后的时间安排。"), contents = ["Please review the updated schedule.", "Please check the delivery tomorrow."]) {
 const requests = [], writes = [], messages = contents.map((content, i) => ({id: String(i + 1), channel_id: CHANNEL, content, embeds: [], attachments: [], author: {id: "other"}}));
 const fetch = async (_url, options) => {const payload = JSON.parse(options.body), wire = payload.messages.at(-1).content; requests.push({wire, payload, signal: options.signal}); const value = await respond(wire, requests.length); return {status: value && value.status || 200, headers: {get: () => "application/json"}, text: async () => value && value.rawBody || JSON.stringify({choices: [{message: {content: typeof value === "string" ? value : ""}}]})};};
 const request = (url, options, callback) => {fetch(url, options).then(async response => callback(null, {statusCode: response.status}, await response.text())); return {abort() {}};};
 const plugin = createPluginInstance({pluginPath: process.env.DTA_PLUGIN_PATH ? path.resolve(process.env.DTA_PLUGIN_PATH) : path.resolve(__dirname, "../../DiscordAITranslator.plugin.js"), callSetLanguages: false, bdfdb: {LibraryRequires: {request}}, settings: {engines: {translator: ENGINE, backup: "----", customProviders: [{id: ENGINE, name: "W5"}]}, performance: {liveStreaming: false}, filters: {receivedAutoTranslateScope: "loaded_messages", skipMixedReceivedMessages: false, useLocalLanguagePrecheck: false, minimumAutoTranslateLength: 1}, choices: {received: {input: "en", output: "zh-CN"}}, exceptions: {wrapperPairs: [], protectedTerms: []}}, defaults: {choices: {received: {value: {input: "en", output: "zh-CN"}}}}});
 global.BdApi.Net = {fetch}; try {plugin.onLoad();} catch {} plugin.settings.engines.translator = ENGINE; plugin.settings.engines.customProviders = [{id: ENGINE, name: "W5"}]; try {plugin.setLanguages();} catch {}
 plugin.ensureSettingsStore().replaceAuthKeys({[ENGINE]: {key: "fixture", endpoint: "https://w5.fixture/v1/chat/completions", model: "fixture", interfaceFormat: "openai_chat", reasoningMode: "off", reasoningProfile: "openai"}});
 plugin.isTranslationEnabled = () => true; plugin.isOwnMessage = () => false; plugin.getLanguageChoice = () => "en"; plugin.getCachedReceivedTranslation = () => null; plugin.getCachedReceivedSkipDecision = () => null; plugin.shouldAutoTranslateReceivedMessage = () => true;
 plugin.isTranslationLikelyInTargetLanguage = text => /[\p{Script=Han}]/u.test(String(text)); plugin.getTextSimilarityScore = (a,b) => a === b ? 1 : 0; plugin.persistTranslationCacheEntry = (...args) => writes.push(args); plugin.persistReceivedSkipDecision = (...args) => writes.push(args);
 const input = {id: "en", name: "English"}, output = {id: "zh-CN", name: "Chinese"};
 const prepared = messages.map(message => plugin.prepareHistoricalAiBatchQueueItem({message, channel: {id: CHANNEL}, originalContentData: {content: message.content, embeds: []}}, CHANNEL, input, output));
 return {plugin, prepared, requests, writes, client: plugin.ensureProviderClient(), close() {delete global.BdApi.Net; return plugin.onStop();}};
}
const grant = h => h.client.enableWholeMarkerBatchCanary({engineKey: ENGINE, channelId: CHANNEL, messageIds: ["1", "2"], maxMessages: 2, ttlMs: 60000});
test("W5 public provider is default off and explicit grant yields one real D batch with authentic per-item validation", async () => {
 const h = fixture(); try {assert.equal(typeof h.client.enableWholeMarkerBatchCanary, "function"); assert.equal(h.client.getWholeMarkerBatchCanarySnapshot().enabled, false); assert.equal(grant(h), true); const result = await h.plugin.requestAiBatchTranslationDetailed(ENGINE, h.prepared); assert.equal(h.requests.length, 1); assert.equal(isRangeObject(JSON.parse(h.requests[0].wire)), true); for (const item of h.prepared) {assert.equal(item.wholeMarkerBatchFinal, true); const raw = result.translations[item.message.id]; assert.ok(raw.wholeMarkerBatch.request.plan); assert.ok(raw.wholeMarkerBatch.outcome.valid); assert.equal(raw.semanticSegments, undefined); assert.equal(h.plugin.validateHistoricalTranslationJobResult(item, raw, {channelId: CHANNEL}).ok, true);} assert.equal(h.writes.length, 0); assert.equal(h.client.getWholeMarkerBatchCanarySnapshot().activeRequests, 0);} finally {await h.close();}
});
test("W5 public provider repair contains only failed sibling and retains successful primary", async () => {
 const h = fixture((wire, count) => flatReply(wire, (_text,key) => count === 1 && key === "2.1" ? "English answer" : `第${key}条消息的中文译文。`)); try {grant(h); const result = await h.plugin.requestAiBatchTranslationDetailed(ENGINE, h.prepared); assert.equal(h.requests.length, 2); assert.deepEqual(Object.keys(JSON.parse(h.requests[1].wire)), ["2.1"]); assert.equal(h.client.getWholeMarkerBatchCanarySnapshot().repairs, 1); for(const item of h.prepared) assert.equal(h.plugin.validateHistoricalTranslationJobResult(item, result.translations[item.message.id], {channelId: CHANNEL}).ok, true);} finally {await h.close();}
});
test("W5 public provider malformed and auth terminate without typed or legacy dispatch", async () => {
 for(const response of ["bad root", {status: 401}]) {const h = fixture(() => response); try {grant(h); const result = await h.plugin.requestAiBatchTranslationDetailed(ENGINE, h.prepared); assert.equal(h.requests.length, 1); assert.ok(result.failureKind); assert.ok(h.prepared.every(item => item.wholeMarkerBatchFinal)); assert.equal(h.writes.length, 0);} finally {await h.close();}}
});
test("W5 off and mismatched grants leave ordinary typed batch wire byte-identical", async () => {
 const bodies=[];
 for(const mode of ["off","wrong-engine","wrong-channel","wrong-id"]) {
  const h=fixture(wire => {const parsed=JSON.parse(wire); return JSON.stringify({messages: parsed.messages.map(row=>({id:row.id,segments:row.plan.segments.map(segment=>({id:segment.id,translation:"请检查更新后的安排。"}))}))});});
  try {if(mode!=="off") h.client.enableWholeMarkerBatchCanary({engineKey:mode==="wrong-engine"?"custom-other":ENGINE,channelId:mode==="wrong-channel"?"other":CHANNEL,messageIds:mode==="wrong-id"?["x","y"]:["1","2"],maxMessages:2,ttlMs:60000}); await h.plugin.requestAiBatchTranslationDetailed(ENGINE,h.prepared); bodies.push(JSON.stringify(h.requests[0].payload)); assert.equal(h.client.getWholeMarkerBatchCanarySnapshot().admittedMessages,0); assert.ok(h.prepared.every(item=>!item.wholeMarkerBatchFinal));} finally {await h.close();}
 }
 assert.ok(bodies.every(body=>body===bodies[0]));
});
test("W5 disable aborts physical request and makes late output terminal without repair or cache", async () => {
 let release; const h=fixture(()=>new Promise(resolve=>{release=resolve;}));
 try {grant(h); const pending=h.plugin.requestAiBatchTranslationDetailed(ENGINE,h.prepared); await new Promise(resolve=>setImmediate(resolve)); assert.equal(h.requests.length,1); h.client.disableWholeMarkerBatchCanary(); assert.equal(h.requests[0].signal.aborted,true); release(JSON.stringify({"1.1":"更新后的安排。","2.1":"明天发货。"})); const result=await pending; assert.equal(result.failureKind,"stale"); assert.equal(h.requests[0].signal.aborted,true); assert.equal(h.client.getWholeMarkerBatchCanarySnapshot().activeRequests,0); release(JSON.stringify({"1.1":"更新后的安排。","2.1":"明天发货。"})); await new Promise(resolve=>setImmediate(resolve)); assert.equal(h.requests.length,1); assert.equal(h.writes.length,0);} finally {if(release)release(""); await h.close();}
});
test("W5 currentness rejects a result after source edit or after post-response grant revoke", async () => {
 for(const change of ["edit","disable"]) {const h=fixture(); try {grant(h); const result=await h.plugin.requestAiBatchTranslationDetailed(ENGINE,h.prepared); if(change==="edit") h.prepared[0].message.content="Source has changed."; else h.client.disableWholeMarkerBatchCanary(); for(const item of h.prepared) assert.equal(h.plugin.validateHistoricalTranslationJobResult(item,result.translations[item.message.id],{channelId:CHANNEL}).ok,false); assert.equal(h.writes.length,0);} finally {await h.close();}}
});
test("W5 repair HTTP failure preserves only primary-success sibling and original reason", async () => {
 for(const status of [401,403,429,503]) {const h=fixture((wire,count)=>count===2?{status}:JSON.stringify({"1.1":"请检查更新后的安排。","2.1":"English answer"})); try {grant(h); const result=await h.plugin.requestAiBatchTranslationDetailed(ENGINE,h.prepared); assert.equal(h.requests.length,2); assert.equal(h.plugin.validateHistoricalTranslationJobResult(h.prepared[0],result.translations["1"],{channelId:CHANNEL}).ok,true); const failed=h.plugin.validateHistoricalTranslationJobResult(h.prepared[1],result.translations["2"],{channelId:CHANNEL}); assert.equal(failed.ok,false); assert.equal(failed.reason,status<429?"auth":status===429?"rate_limit":"server"); assert.equal(h.writes.length,0);} finally {await h.close();}}
});
test("W5 authentic outcome cannot be replaced with a copied or typed result", async () => {
 const h=fixture();try {grant(h);const result=await h.plugin.requestAiBatchTranslationDetailed(ENGINE,h.prepared);const raw=result.translations["1"];for(const counterfeit of [JSON.parse(JSON.stringify(raw)),{semanticSegments:[]},result.translations["2"]]) assert.equal(h.plugin.validateHistoricalTranslationJobResult(h.prepared[0],counterfeit,{channelId:CHANNEL}).ok,false);}finally{await h.close();}
});
test("W5 oversized actual request envelope is rejected before physical dispatch", async () => {
 const h=fixture();try {h.plugin.ensureSettingsStore().replaceAuthKeys({[ENGINE]:{key:"fixture",endpoint:"https://w5.fixture/v1/chat/completions",model:"x".repeat(66000),interfaceFormat:"openai_chat",reasoningMode:"follow",reasoningProfile:"openai"}});grant(h);const result=await h.plugin.requestAiBatchTranslationDetailed(ENGINE,h.prepared);assert.equal(result.failureKind,"request_budget");assert.equal(h.requests.length,0);assert.equal(h.client.getWholeMarkerBatchCanarySnapshot().applicationDispatches,1);}finally{await h.close();}
});
test("W5 oversized outer response is rejected before parsing its small valid content", async () => {
 const h=fixture(()=>({rawBody:JSON.stringify({padding:"x".repeat(66000),choices:[{message:{content:JSON.stringify({"1.1":"更新后的安排。","2.1":"明天发货。"})}}]})}));try{grant(h);const result=await h.plugin.requestAiBatchTranslationDetailed(ENGINE,h.prepared);assert.equal(result.failureKind,"response-budget");assert.equal(h.requests.length,1);assert.ok(h.prepared.every(item=>item.wholeMarkerBatchFinal));}finally{await h.close();}
});
test("W5 rejected repair promise preserves primary-success sibling", async () => {
 const {createWholeMarkerBatchCanary}=require("../../src/orchestrator/whole-marker-batch-canary"), {compileWholeMarkerSingle}=require("../../src/orchestrator/whole-marker-single-canary");
 const h=fixture(), owner=createWholeMarkerBatchCanary({compile:item=>compileWholeMarkerSingle(h.plugin,item.semanticRequest),validation:()=>({likelyTarget:text=>/[\p{Script=Han}]/u.test(text),similarity:()=>0})});
 try{owner.enable({engineKey:ENGINE,channelId:CHANNEL,messageIds:["1","2"],maxMessages:2,ttlMs:60000});const claim=owner.claim(ENGINE,h.prepared,null);assert.ok(claim);const result=await claim.run((_batch,role)=>role==="primary"?Promise.resolve({text:JSON.stringify({"1.1":"请检查更新后的安排。","2.1":"English answer"})}):Promise.reject(new Error("transport rejection")));assert.equal(result.translations["1"].wholeMarkerBatch.outcome.ok,true);assert.equal(result.translations["2"].wholeMarkerBatch.outcome.reason,"transient");}finally{owner.disable();await h.close();}
});

test("W5 terminal ledger uses its fixed bounded revision alias rather than stale typed metadata", async () => {
 const h=fixture();try{const item=h.prepared[0],id=h.plugin.beginTranslationTerminalRoute({lane:"live-burst",entry:"received-auto",semanticRevision:"s8b-p2-v1"});item.queueItem.terminalRouteId=id;grant(h);const result=await h.plugin.requestAiBatchTranslationDetailed(ENGINE,h.prepared);assert.equal(h.plugin.validateHistoricalTranslationJobResult(item,result.translations["1"],{channelId:CHANNEL}).ok,true);h.plugin.finishTranslationTerminalRoute(id,{outcome:"translated",stage:"display-currentness",reason:"committed"});const route=h.plugin.getTranslationTerminalLedgerSnapshot().recent.at(-1);assert.equal(route.semanticRevision,"w5-whole-marker-batch-v1");assert.equal(route.requestFamily,"whole-marker-batch");}finally{await h.close();}
});

test("W5 remains nonstream for a one-item repair even with liveStreaming enabled", async () => {
 const h=fixture((wire,count)=>flatReply(wire, (_text,key)=>count===1&&key==="2.1"?"English answer":`第${key}条消息的中文译文。`));
 try {h.plugin.settings.performance.liveStreaming=true;grant(h);const result=await h.plugin.requestAiBatchTranslationDetailed(ENGINE,h.prepared);assert.equal(h.requests.length,2);assert.equal(Object.keys(JSON.parse(h.requests[0].wire)).length,2);assert.equal(Object.keys(JSON.parse(h.requests[1].wire)).length,1);assert.ok(h.requests.every(row=>row.payload.stream!==true),"W5 primary and single-item repair must both retain nonstream envelope limits");for(const item of h.prepared)assert.equal(h.plugin.validateHistoricalTranslationJobResult(item,result.translations[item.message.id],{channelId:CHANNEL}).ok,true);}finally{await h.close();}
});
for (const [label, source] of [
 ["long-windowed", "这是为短英文提供的自然语言上下文。".repeat(80) + "\nPlease review the updated schedule."],
 ["short-mixed", "请注意这里的中文上下文。Please review the updated schedule."]
]) test(`W5 excludes ${label} natural-language context without spending its grant or changing typed wire`, async () => {
 const {compileWholeMarkerSingle}=require("../../src/orchestrator/whole-marker-single-canary");
 const bodies=[];
 const respond=wire=>{const value=JSON.parse(wire);if(isRangeObject(value))return flatReply(wire,()=>"请检查更新后的安排。");return JSON.stringify({messages:value.messages.map(row=>({id:row.id,segments:row.plan.segments.map(segment=>({id:segment.id,translation:"请检查更新后的安排。"}))}))});};
 for(const enabled of [false,true]) {const h=fixture(respond,[source,"Please check the delivery tomorrow."]);try{const request=compileWholeMarkerSingle(h.plugin,h.prepared[0].semanticRequest);assert.equal(request.ok,true);assert.equal(request.windowed,label==="long-windowed");assert.ok(request.plan.nodes.some(node=>node.kind==="text"&&node.classification==="preserve-target"&&/\p{L}/u.test(node.raw)));if(enabled)grant(h);await h.plugin.requestAiBatchTranslationDetailed(ENGINE,h.prepared);assert.equal(h.requests.length,1);assert.equal(JSON.parse(h.requests[0].wire).schemaVersion,"semantic-batch-v1");bodies.push(JSON.stringify(h.requests[0].payload));assert.equal(h.client.getWholeMarkerBatchCanarySnapshot().admittedMessages,0);if(enabled)assert.equal(h.client.getWholeMarkerBatchCanarySnapshot().remainingMessages,2);assert.ok(h.prepared.every(item=>!item.wholeMarkerBatchFinal));}finally{await h.close();}}
 assert.equal(bodies[0],bodies[1]);
});
test("W5 still admits ordinary English surrounded only by Markdown structure", async () => {
 const h=fixture(undefined,["**Please review the updated schedule.**","Please check the delivery tomorrow."]);try{grant(h);const result=await h.plugin.requestAiBatchTranslationDetailed(ENGINE,h.prepared);assert.equal(h.requests.length,1);assert.ok(isRangeObject(JSON.parse(h.requests[0].wire)));assert.equal(h.client.getWholeMarkerBatchCanarySnapshot().admittedMessages,2);const verdict=h.plugin.validateHistoricalTranslationJobResult(h.prepared[0],result.translations["1"],{channelId:CHANNEL});assert.equal(verdict.ok,true);assert.equal(verdict.translation.translatedContent,"**请检查这个更新后的时间安排。**");}finally{await h.close();}
});

test("W5 request observer inputChars is actual sent flat user content UTF-16 length",async()=>{
 const observations=[],contracts=[];
 const h=fixture(wire=>flatReply(wire,(source,key)=>key==="1.1"?`请在星期五前检查 ${(source.match(/⟦[^⟧]+⟧/g)||[]).join("")}。`:"请核对明天的送货情况。"),["Please review `CODE` before Friday.","Please check the delivery tomorrow."]);
 try{
  grant(h);
  const token=h.client.beginLatencyRequest({kind:"historical",messageCount:2,inputChars:0});
  const result=await h.client.requestAiBatchTranslationDetailed(ENGINE,h.prepared,{token,role:"primary",historicalBatch:true,historicalObserver:{onRequest:event=>observations.push(event)},historicalSampleObserver:{onContract:(_contract,metrics)=>contracts.push(metrics)}});
  assert.equal(result.failureKind,null);assert.equal(h.requests.length,1);assert.equal(observations.length,1);assert.equal(contracts.length,1);
  const actualUser=h.requests[0].payload.messages.at(-1).content,actualSystem=h.requests[0].payload.messages[0].content;
  assert.equal(actualUser,h.requests[0].wire);assert.equal(observations[0].inputChars,actualUser.length);
  assert.equal(contracts[0].inputChars,actualUser.length);assert.equal(observations[0].promptChars,actualSystem.length+actualUser.length);
  assert.notEqual(actualUser.length,Buffer.byteLength(actualUser,"utf8"),"protected markers distinguish UTF-16 character length from bytes");
  assert.notEqual(actualUser.length,h.prepared.reduce((n,item)=>n+item.originalContentData.content.length,0),"the observer measures the sent user payload, not raw message bodies");
 }finally{await h.close();}
});
