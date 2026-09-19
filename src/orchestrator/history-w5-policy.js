'use strict';

// Pure admission policy for the History-only W5 candidate.  This module does
// not enable a canary or mutate settings; callers use the decision to choose
// either the existing typed path or an already-authorized W5 claim.
function historyW5Eligibility({
  items,
  engineKey,
  channelId,
  grant,
  now = Date.now
} = {}) {
  const typed = reason => Object.freeze({eligible: false, mode: 'typed', reason});
  if (!Array.isArray(items) || items.length === 0) return typed('empty-items');
  if (typeof engineKey !== 'string' || !engineKey) return typed('invalid-engine');
  if (channelId === undefined || channelId === null || String(channelId) === '') return typed('invalid-channel');
  if (!grant || typeof grant !== 'object') return typed('missing-grant');
  if (typeof grant.engineKey !== 'string' || grant.engineKey !== engineKey) return typed('grant-engine-mismatch');
  if (grant.channelId === undefined || String(grant.channelId) !== String(channelId)) return typed('grant-channel-mismatch');
  const current = Number(now());
  if (!Number.isFinite(current)) return typed('invalid-clock');
  if (!Number.isFinite(Number(grant.expiresAt)) || Number(grant.expiresAt) <= current) return typed('grant-expired');
  if (grant.enabled === false) return typed('grant-disabled');
  const ids = items.map(item => String(item && item.message && item.message.id || item && item.id || ''));
  if (ids.some(id => !id)) return typed('missing-message-id');
  if (new Set(ids).size !== ids.length) return typed('duplicate-message-id');
  const grantIds = grant.ids instanceof Set
    ? grant.ids
    : new Set(Array.isArray(grant.messageIds) ? grant.messageIds.map(String) : []);
  if (!grantIds.size || ids.some(id => !grantIds.has(id))) return typed('message-not-granted');
  if (!Number.isSafeInteger(Number(grant.remaining)) || Number(grant.remaining) < items.length) return typed('grant-exhausted');
  for (const item of items) {
    const request = item && (item.request || item.semanticRequest || item);
    if (!request || request.totalRangeCount !== 1 || !Array.isArray(request.ranges) || request.ranges.length !== 1) return typed('multi-range');
  }
  return Object.freeze({eligible: true, mode: 'w5', reason: 'single-range-complete'});
}

module.exports = {historyW5Eligibility};
