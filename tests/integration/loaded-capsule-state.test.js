const test = require('node:test');
const assert = require('node:assert/strict');
const repo = require('node:path').resolve(__dirname, '../..');
const {createLoadedTranslationStatusStore} = require(repo + '/src/status/loaded-translation-status-store');
const {createHistoricalDisplayTracker} = require(repo + '/src/display/historical-display-tracker');
const {createPluginInstance} = require(repo + '/tests/helpers/createPluginInstance');
const {createMessageStateStore} = require(repo + '/src/display/message-state-store');
const {createTranslationDisplayController, createDisplayView} = require(repo + '/src/display/translation-display-controller');
const {projectHistoricalStatus} = require(repo + "/src/status/historical-status-projection");
function store() {return createLoadedTranslationStatusStore({now: () => 1000, isChineseUiLanguage: () => true});}
function seed(s, count = 235) {s.recordSessionDisplayed('c1', Array.from({length: count}, (_, i) => 'seen-' + i));}
function plugin() {
  const instance = createPluginInstance({pluginPath: process.env.DTA_PLUGIN_PATH || require('node:path').join(repo, 'DiscordAITranslator.plugin.js'), bdfdb: {dotCN: {}, dotCNS: {}, LibraryStores: {SelectedChannelStore: {getChannelId: () => 'c1'}}}});
  instance.onLoad();
  return instance;
}
function addJob(p, count) {
  const job = p.createCollectedHistoricalTranslationJob('c1');
  for (let i = 0; i < count; i++) job.add({message: {id: job.id + '-' + i, channel_id: 'c1', content: 'Test source.'}, channel: {id: 'c1'}});
  return job;
}

test('pending display must keep the channel cumulative numerator', () => {
  const s = store(); seed(s);
  s.update({channelId: 'c1', batch: 1, total: 9, processed: 9, displayed: 9, done: true});
  const before = s.getStatusText();
  s.update({displayed: 8, displayPending: 1});
  const during = s.getStatusText();
  s.update({displayed: 9, displayPending: 0});
  const after = s.getStatusText();
  assert.ok(during.startsWith('235/'), 'pending state unexpectedly switches to one batch');
});

test('queued jobs and late completions retain the cumulative channel ratio', () => {
  const p = plugin();
  const capsule = p.ensureLoadedStatusCapsuleController();
  capsule.recordTranslationsDisplayed('c1', Array.from({length: 235}, (_, i) => 'seen-' + i));
  const first = addJob(p, 9);
  first.seal(); first.state = 'translating'; p.updateHistoricalTranslationJobStatus(first);
  assert.match(p.getLoadedAutoTranslationStatusText(), /^235\/244/);
  const second = addJob(p, 28);
  second.seal();
  assert.match(p.getLoadedAutoTranslationStatusText(), /^235\/272/);
  capsule.recordTranslationsDisplayed('c1', [...first.items.keys()]);
  first.state = 'committed'; p.updateHistoricalTranslationJobStatus(first);
  assert.match(p.getLoadedAutoTranslationStatusText(), /^244\/272/);
  assert.match(p.getLoadedAutoTranslationStatusDetailText(), /排队中|queued/);
  second.state = 'translating'; p.updateHistoricalTranslationJobStatus(second);
  p.updateLoadedAutoTranslationStatus({channelId: 'c1', jobId: first.id, done: true, displayed: 9, total: 9});
  assert.match(p.getLoadedAutoTranslationStatusText(), /^244\/272/);
  assert.match(p.getLoadedAutoTranslationStatusDetailText(), /请求中|requesting/);
  capsule.recordTranslationsDisplayed('c1', [...second.items.keys()]);
  second.state = 'committed'; p.updateHistoricalTranslationJobStatus(second);
  assert.equal(p.getLoadedAutoTranslationStatusText(), '272/272');
});

test('repair and commit phases must follow actual installed job state', () => {
  const p = plugin(); const job = addJob(p, 3);
  const phases = {};
  for (const state of ['translating', 'repairing', 'ready']) {
    job.state = state; p.updateHistoricalTranslationJobStatus(job);
    phases[state] = p.getLoadedAutoTranslationStatusDetailText();
  }
  assert.match(phases.translating, /requesting|请求中/);
  assert.match(phases.repairing, /repairing|修复中/);
  assert.match(phases.ready, /committing|提交中/);
});

test('exhausted paints stay failed until a revision-matched render succeeds', () => {
  const s = store(); seed(s);
  const refresh = () => s.update(projectHistoricalStatus({channelId: 'c1', display: tracker.getSnapshot('c1'), includeEmpty: true}));
  const tracker = createHistoricalDisplayTracker({isStatusForChannel: () => true, getRevision: () => 1, updateStatus: refresh});
  tracker.begin({channelId: 'c1', batchKey: 'old-job', displayableIds: ['seen-234'], outcome: {missingIds: ['seen-234'], retryIds: ['seen-234']}});
  refresh();
  assert.equal(s.getStatusText(), '234/235 0s');
  tracker.handle({channelId: 'c1', messageIds: ['seen-234'], trackingKeysByMessageId: {'seen-234': ['old-job']}, outcome: {exhaustedIds: ['seen-234']}});
  assert.equal(s.getStatusText(), '234/235 0s');
  assert.equal(s.getStatus().done, false);
  assert.equal(s.getStatus().displayFailed, 1);
  assert.match(s.getStatusDetailText(), /显示失败 1/);
  tracker.handle({channelId: 'c1', messageIds: ['seen-234'], revisionsByMessageId: {'seen-234': 1}, outcome: {confirmedIds: ['seen-234']}});
  assert.equal(s.getStatusText(), '235/235');
  assert.equal(s.getStatus().done, true);
});

test('pending display tracking must not forget an older job on a newer same-channel completion', () => {
  const resolved = [];
  const tracker = createHistoricalDisplayTracker({isStatusForChannel: () => true, onResolved: r => resolved.push(r)});
  tracker.begin({channelId: 'c1', batchKey: 'older', outcome: {missingIds: ['older-row']}});
  tracker.begin({channelId: 'c1', batchKey: 'newer', outcome: {confirmedIds: ['newer-row']}});
  const handled = tracker.handle({channelId: 'c1', messageIds: ['older-row'], trackingKeysByMessageId: {'older-row': ['older']}, outcome: {confirmedIds: ['older-row']}});
  assert.equal(handled, true, 'newer begin deleted the old job tracking record');
});

for (const renderResult of ['confirmed', 'offscreen', 'exception', 'retry', 'initial-exception']) test(`scrolling cache commit awaits ${renderResult} render without another translation request`, async () => {
  const p = plugin();
  p.settings.filters.receivedAutoTranslateScope = 'loaded_messages';
  p.shouldAutoTranslateReceivedMessage = () => true;
  p.isMessageWithinLoadedRange = () => true;
  p.isTranslationEnabled = () => true;
  p.scheduleHistoricalTranslationJobStart = () => {};
  p.isHistoricalTranslationJobCurrent = () => true;
  p.persistTranslationCacheEntry = () => {};
  p.persistReceivedSkipDecision = () => {};
  let renders = 0, recovered = false, canPaint = renderResult === "initial-exception";
  p.translateHistoricalTranslationJobBatch = () => {throw new Error("cache-only job must not request translation");};
  const scheduled = [], retries = [];
  p.scheduleReceivedDisplayFlush = (channelId, messageId, delay, key) => retries.push({channelId, messageId, delay, key});
  const states = createMessageStateStore({onTranslationDisplayed: (channelId, messageId) => p.ensureLoadedStatusCapsuleController().recordTranslationsDisplayed(channelId, [messageId])});
  const display = createTranslationDisplayController({store: states, canRepaintNow: () => canPaint, onRenderOutcome: report => p.handleHistoricalDisplayOutcome(report), setTimeout: callback => {scheduled.push(callback); return scheduled.length;}, renderAdapter: {refreshMessages: async request => {renders++; if (renderResult === "retry" && renders === 1) return {missingIds: request.messageIds, retryIds: request.messageIds}; if (!recovered && (renderResult === "exception" || renderResult === "initial-exception")) throw new Error("render failed"); return renderResult === "offscreen" ? {deferredIds: request.messageIds} : {confirmedIds: request.messageIds};}}});
  p.getReceivedDisplayRuntimeView = id => createDisplayView(states.getDisplayState(id));
  const commits = [];
  p.commitHistoricalReceivedDisplayBatch = async results => {const outcome = await display.commitHistoricalBatch(results); commits.push({results, outcome}); return outcome;};
  p.ensureLoadedStatusCapsuleController().recordTranslationsDisplayed('c1', Array.from({length: 325}, (_, i) => 'old-' + i));
  const content = 'Synthetic cached source.';
  const message = {id: 'cached-new', channel_id: 'c1', content, embeds: [], attachments: [], author: {id: 'other-user'}};
  const source = p.extractOriginalContentData(message);
  const signature = p.createReceivedTranslationSignature(message, 'c1', source);
  p.queueAutoTranslateMessage(message, {id: 'c1'}, source, {historicalLoad: true, cachedTranslation: {signature, channelId: 'c1', auto: true, content: '合成缓存译文', translatedContent: '合成缓存译文', originalContent: content, input: {id: 'en'}, output: {id: 'zh-CN'}}});
  const job = p.getHistoricalTranslationJobQueue('c1').jobs[0];
  await p.startCollectedHistoricalTranslationJobs('c1');
  const text = p.getLoadedAutoTranslationStatusText(), detail = p.getLoadedAutoTranslationStatusDetailText();
  const view = p.getReceivedDisplayRuntimeView('cached-new');
  assert.equal(renders, renderResult === "initial-exception" ? 1 : 0);
  assert.equal(view.renderStatus, 'pending');
  assert.match(text, /^325\/326 \d+s$/);
  assert.match(detail, /待显示|awaiting display/);
  assert.doesNotMatch(detail, /已完成|done/);
  assert.equal(job.progressCommittedIds.size, 1);
  assert.equal(commits.length, 1, 'finalization must not recommit cached progress');
  if (renderResult === 'initial-exception') {
    assert.equal(retries.length, 1, 'initial render errors retain the store ACK and retry display only');
    await assert.rejects(display.renderMessage('cached-new'), /render failed/);
    assert.match(p.getLoadedAutoTranslationStatusText(), /^325\/326 \d+s$/);
    assert.equal(commits.length, 1);
    await retryDisplayFailure();
    return;
  }
  assert.equal(retries.length, 0, "the scroll gate owns its deferred wave");
  canPaint = true;
  await scheduled.shift()();
  assert.equal(renders, 1);
  if (renderResult === 'retry') {
    assert.equal(retries.length, 1, "an unconfirmed deferred paint enters the existing targeted retry queue once");
    assert.match(p.getLoadedAutoTranslationStatusText(), /^325\/326 \d+s$/);
    await display.renderMessage('cached-new');
  }
  if (renderResult === 'exception') {
    assert.match(p.getLoadedAutoTranslationStatusText(), /^325\/326 \d+s$/);
    assert.match(p.getLoadedAutoTranslationStatusDetailText(), /显示失败|display failed/);
    await retryDisplayFailure();
  }
  else {
    assert.equal(p.getLoadedAutoTranslationStatusText(), '326/326');
    assert.match(p.getLoadedAutoTranslationStatusDetailText(), /已完成|done/);
  }
  async function retryDisplayFailure() {
    const before = retries.length;
    assert.equal(p.retryFailedHistoricalDisplays('c1'), 1);
    assert.equal(p.retryFailedHistoricalDisplays('c1'), 0, 'double clicking does not start two display rounds');
    assert.equal(retries.length, before + 1);
    assert.match(p.getLoadedAutoTranslationStatusText(), /^325\/326 \d+s$/);
    recovered = true;
    await display.renderMessage('cached-new');
    assert.equal(p.getLoadedAutoTranslationStatusText(), '326/326');
    assert.equal(commits.length, 1, 'display retry reuses the stored translation');
  }
});


test('a retry and its retained failure share one message in the cumulative denominator', () => {
  const s = store(); seed(s);
  const job = {id: 'retry-job', state: 'translating', sealed: true, items: new Map([['failed-row', {status: 'pending'}]])};
  const refresh = () => s.update(projectHistoricalStatus({channelId: 'c1', jobs: [job], retryableIds: ['failed-row']}));
  refresh();
  assert.equal(s.getStatus().workTotal, 236);
  job.items.get('failed-row').status = 'translated';
  s.recordSessionDisplayed('c1', ['failed-row']);
  job.progressCommitAcks = new Map([['failed-row', {}]]);
  refresh();
  assert.equal(s.getStatus().workTotal, 236);
  assert.equal(s.getStatus().readyCount, 236);
  assert.equal(s.getStatus().retryable, 0);
});

test('a finished empty queue keeps only the numeric zero ratio', () => {
  const s = store();
  s.update(projectHistoricalStatus({channelId: 'c1', jobs: [], includeEmpty: true}));
  assert.equal(s.getStatusText(), '0/0');
  assert.equal(s.getStatus().done, true);
});
