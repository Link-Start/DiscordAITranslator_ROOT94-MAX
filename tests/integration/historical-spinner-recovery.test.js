const test = require('node:test');
const assert = require('node:assert/strict');
const {createHarness} = require('../helpers/createReceivedDisplayHarness');
const {createLoadedTranslationStatusStore} = require('../../src/status/loaded-translation-status-store');

test('the runtime content hook acknowledges the forwarded body, never its empty parent', () => {
  const h = createHarness();
  try {
    const p = h.plugin, id = 'forwarded-row';
    p.isTranslationEnabled = () => false;
    p.getReceivedDisplayRuntimeView = () => ({messageId: id, revision: 9, status: 'cancelled', showLoading: false});
    const snapshots = [{message: {content: 'original'}}];
    const event = content => ({instance: {props: {message: {id, channel_id: 'channel-a', content, messageSnapshots: snapshots}}}, returnvalue: {props: {children: [], 'data-translator-revision': 'old'}}});
    const parent = event(''), body = event('original');
    p.processMessageContent(parent);
    p.processMessageContent(body);
    assert.equal(parent.returnvalue.props['data-translator-revision'], undefined);
    assert.equal(body.returnvalue.props['data-translator-revision'], '9');
  } finally {h.restore();}
});

test('capsule primary text stays ratio and elapsed only through pending and failed display', () => {
  let time = 1000;
  const store = createLoadedTranslationStatusStore({now: () => time});
  store.recordSessionDisplayed('channel-a', ['ready']);
  store.update({channelId: 'channel-a', aggregate: true, active: true, phase: 'displaying', pendingMessageIds: ['pending'], displayPending: 1});
  time = 5000;
  assert.equal(store.getStatusText(), '1/2 4s');
  store.update({active: false, phase: 'failed', displayPending: 0, displayFailed: 1, retryable: 1, retryableCounted: true});
  time = 9000;
  assert.equal(store.getStatusText(), '1/2 4s');
});

test('a terminal historical failure removes its spinner before queue finalization', async () => {
  const h = createHarness();
  try {
    const p = h.plugin, id = 'failed-row', channelId = 'channel-a';
    p.captureReceivedMessageSource({messageId: id, channelId, generation: 1, sourceSignature: 'source', source: {content: 'source', embeds: []}});
    const job = p.createCollectedHistoricalTranslationJob(channelId);
    job.add({message: {id, channel_id: channelId, content: 'source'}, channel: {id: channelId}});
    job.items.get(id).status = 'failed'; job.state = 'ready';
    p.ensureLiveTranslationQueue().markMessageQueued(id, {type: 'historical', channelId, jobId: job.id});
    await p.commitHistoricalReceivedDisplayBatch([{messageId: id, channelId, generation: 1, sourceSignature: 'source', origin: 'automatic', status: 'failed', reason: 'provider_failed'}]);
    const event = {instance: {props: {message: {id, channel_id: channelId, content: 'source'}}}, returnvalue: {props: {children: []}}};
    p.processMessageContent(event);
    assert.equal(event.returnvalue.props.children.some(child => child && child.props && child.props.className === 'translator-translation-loading'), false);
    job.items.get(id).status = 'pending'; job.state = 'collecting';
    p.processMessageContent(event);
    assert.equal(event.returnvalue.props.children.some(child => child && child.props && child.props.className === 'translator-translation-loading'), true, 'new work still shows loading over the old failed result');
  } finally {h.restore();}
});

for (const status of ['pending', 'failed', 'translated', 'skipped']) test(`disable repaints an uncommitted historical ${status} row`, async () => {
  const h = createHarness();
  try {
    const p = h.plugin, id = 'collected-row', channelId = 'channel-a';
    delete p.isTranslationEnabled;
    p.setChannelEnablementStateValue(channelId, true);
    p.captureReceivedMessageSource({messageId: id, channelId, generation: 1, sourceSignature: 'source', source: {content: 'source', embeds: []}});
    const job = p.createCollectedHistoricalTranslationJob(channelId);
    job.add({message: {id, channel_id: channelId, content: 'source'}, channel: {id: channelId}});
    p.ensureLiveTranslationQueue().markMessageQueued(id, {type: 'historical', channelId, jobId: job.id});
    assert.equal(p.isMessageTranslationPending(id, channelId), true);
    job.items.get(id).status = status;
    if (status !== 'pending') job.state = 'ready';
    const before = h.calls.messageUpdates;
    await p.toggleTranslation(channelId);
    assert.equal(p.isMessageTranslationPending(id, channelId), false);
    assert.ok(h.calls.messageUpdates > before, 'the mounted spinner needs a repaint after its historical queue is cleared');
    assert.equal(p.getReceivedDisplayView(id).status, 'cancelled');
    const event = {instance: {props: {message: {id, channel_id: channelId, content: 'source'}}}, returnvalue: {props: {children: [{key: 'translator-translation-loading', props: {className: 'translator-translation-loading'}}]}}};
    p.processMessageContent(event);
    assert.equal(event.returnvalue.props.children.some(child => child && child.props && child.props.className === 'translator-translation-loading'), false);
  } finally {h.restore();}
});

test('an initially empty completed channel has no running clock', () => {
  let time = 1000;
  const store = createLoadedTranslationStatusStore({now: () => time});
  store.update({channelId: 'empty', aggregate: true, active: false, done: true, phase: 'done', pendingMessageIds: []});
  assert.equal(store.getStatusText(), '0/0');
  time = 11000; store.update({});
  assert.equal(store.getStatusText(), '0/0');
  store.update({channelId: 'working', active: true, phase: 'requesting', done: false, pendingMessageIds: ['m']});
  time = 13000;
  store.update({channelId: 'empty', active: false, done: true, phase: 'done', pendingMessageIds: []});
  time = 21000; store.update({});
  assert.equal(store.getStatusText(), '0/0');
});

test('historical retry runs a fresh request and clears the retained failure after a valid result', async () => {
  const h = createHarness();
  try {
    const p = h.plugin, id = 'retry-row', channelId = 'channel-a';
    const message = {id, channel_id: channelId, content: 'source', embeds: [], attachments: [], author: {id: 'other'}};
    const source = p.extractOriginalContentData(message);
    const signature = p.createReceivedTranslationSignature(message, channelId, source);
    p.captureReceivedMessageSource({messageId: id, channelId, generation: 1, sourceSignature: signature, source});
    p.isTranslationEnabled = () => true;
    p.scheduleHistoricalTranslationJobStart = () => {};
    p.persistTranslationCacheEntry = () => {};
    p.persistReceivedSkipDecision = () => {};
    p.prepareHistoricalTranslationJobItem = item => ({status: 'pending', prepared: {message: item.message, originalContentData: source, signature}});
    let attempts = 0, recover = false;
    p.translateHistoricalTranslationJobBatch = async () => {attempts++; return {[id]: recover ? '译文' : null};};
    p.validateHistoricalTranslationJobResult = (_prepared, raw) => raw ? {ok: true, translation: {signature, channelId, auto: true, content: raw, translatedContent: raw, originalContent: 'source'}} : {ok: false, reason: 'provider_failed'};
    p.repairHistoricalTranslationJobBatch = async () => null;
    p.repairHistoricalTranslationJobItem = async () => ({status: 'failed', reason: 'provider_failed'});
    p.collectHistoricalTranslationMessage({message, channel: {id: channelId}, originalContentData: source});
    await p.startCollectedHistoricalTranslationJobs(channelId);
    assert.equal(p.getFailedHistoricalTranslationCount(channelId), 1);
    recover = true;
    assert.equal(await p.retryFailedHistoricalTranslations(channelId), true);
    assert.equal(attempts, 2, 'manual retry must reach the translation owner exactly once');
    assert.equal(p.getReceivedDisplayView(id).translated, true);
    assert.equal(p.getFailedHistoricalTranslationCount(channelId), 0);
  } finally {h.restore();}
});
