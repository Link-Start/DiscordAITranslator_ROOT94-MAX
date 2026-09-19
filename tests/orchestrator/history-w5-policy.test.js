'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {historyW5Eligibility} = require('../../src/orchestrator/history-w5-policy');

const grant = (overrides = {}) => ({engineKey: 'ENGINE', channelId: 'CHANNEL', messageIds: ['1', '2'], remaining: 2, expiresAt: 2000, ...overrides});
const items = (requests = [{totalRangeCount: 1, ranges: [{}]}, {totalRangeCount: 1, ranges: [{}]}]) => requests.map((request, i) => ({message: {id: String(i + 1)}, request}));
const decide = (options = {}) => historyW5Eligibility({items: items(), engineKey: 'ENGINE', channelId: 'CHANNEL', grant: grant(), now: () => 1000, ...options});

test('History W5 admits only a complete single-range batch with a matching live grant', () => {
  assert.deepEqual(decide(), {eligible: true, mode: 'w5', reason: 'single-range-complete'});
});

test('History W5 falls back to typed when any item has multiple ranges', () => {
  const result = decide({items: items([{totalRangeCount: 1, ranges: [{}]}, {totalRangeCount: 2, ranges: [{}, {}]}])});
  assert.deepEqual(result, {eligible: false, mode: 'typed', reason: 'multi-range'});
});

test('History W5 rejects missing, mismatched, expired, or exhausted grants', () => {
  for (const options of [{grant: null}, {grant: grant({engineKey: 'OTHER'})}, {grant: grant({channelId: 'OTHER'})}, {grant: grant({expiresAt: 999})}, {grant: grant({remaining: 1})}]) {
    assert.equal(decide(options).eligible, false);
  }
});

test('History W5 rejects duplicate or ungranted message IDs without mutation', () => {
  const duplicate = [{message: {id: '1'}, request: {totalRangeCount: 1, ranges: [{}]}}, {message: {id: '1'}, request: {totalRangeCount: 1, ranges: [{}]}}];
  assert.deepEqual(historyW5Eligibility({items: duplicate, engineKey: 'ENGINE', channelId: 'CHANNEL', grant: grant(), now: () => 1000}), {eligible: false, mode: 'typed', reason: 'duplicate-message-id'});
  assert.deepEqual(decide({grant: grant({messageIds: ['1']})}), {eligible: false, mode: 'typed', reason: 'message-not-granted'});
});
