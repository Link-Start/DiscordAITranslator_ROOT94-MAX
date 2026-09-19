function createHistoricalDisplayTracker({isStatusForChannel = () => false, getRevision = () => null, updateStatus = () => {}, getBatchNumber = () => null, onResolved = () => {}} = {}) {
	const channels = new Map();
	let sequence = 0;
	const ids = values => new Set([].concat(values || []).map(String));
	function snapshot(channelId) {
		const pending = new Set(), failed = new Set(), blocked = new Set();
		const batches = channels.get(String(channelId));
		for (const [key, batch] of batches || []) {
			for (const [id, row] of batch.rows) {
				if (getRevision(String(channelId), id) !== row.revision) {batch.rows.delete(id); continue;}
				(row.failed ? failed : pending).add(id);
				if (row.displayable) blocked.add(id);
			}
			if (!batch.rows.size) batches.delete(key);
		}
		if (batches && !batches.size) channels.delete(String(channelId));
		return {pendingIds: [...pending], failedIds: [...failed], blockedTranslationIds: [...blocked]};
	}
	return Object.freeze({
		getSnapshot: snapshot,
		retryFailed({channelId, schedule = () => {}} = {}) {
			const channel = String(channelId);
			snapshot(channel); // Prune edited/deleted revisions before user-requested recovery.
			let scheduled = 0;
			for (const [key, batch] of channels.get(channel) || []) for (const [id, row] of batch.rows) {
				if (!row.failed) continue;
				row.failed = false;
				row.paintPending = false;
				try {schedule(id, key); scheduled++;}
				catch (error) {row.failed = true;}
			}
			return scheduled;
		},
		begin({channelId, batchKey = null, outcome = {}, displayed = 0, displayableIds = null, schedule = () => {}} = {}) {
			outcome = outcome || {};
			if (channelId == null || !String(channelId)) return 0;
			const channel = String(channelId), key = String(batchKey || `${channel}:display:${++sequence}`);
			if (!channels.has(channel)) channels.set(channel, new Map());
			const batches = channels.get(channel);
			const pending = ids([].concat(outcome.missingIds || [], outcome.retryIds || [], outcome.paintPendingIds || []));
			const ready = ids([].concat(outcome.confirmedIds || [], outcome.deferredIds || []).filter(id => !pending.has(String(id))));
			const displayable = ids(displayableIds == null ? [...pending] : displayableIds);
			const batch = batches.get(key) || {rows: new Map(), displayed: 0, batch: getBatchNumber()};
			if (ids(outcome.paintPendingIds).size) batch.schedule = schedule;
			batch.displayed = Math.max(batch.displayed, Number(displayed) || 0);
			for (const id of ready) batch.rows.delete(id);
			for (const id of pending) {
				// A new revision owns its result; an old report cannot acknowledge it.
				for (const [otherKey, other] of batches) if (otherKey !== key) other.rows.delete(id);
				const revision = getRevision(channel, id), previous = batch.rows.get(id);
				if (!previous || previous.revision !== revision) batch.rows.set(id, {revision, displayable: displayable.has(id), failed: false, paintPending: ids(outcome.paintPendingIds).has(id)});
			}
			if (batch.rows.size) batches.set(key, batch);
			else batches.delete(key);
			// Gated paints already belong to the controller's deferred wave.
			for (const id of ids([].concat(outcome.missingIds || [], outcome.retryIds || []))) schedule(id, key);
			return snapshot(channel).pendingIds.length;
		},
		handle({channelId, messageIds = [], trackingKeysByMessageId = {}, revisionsByMessageId = {}, outcome = {}} = {}) {
			outcome = outcome || {};
			const channel = String(channelId), batches = channels.get(channel);
			if (!batches) return false;
			const ready = ids([].concat(outcome.confirmedIds || [], outcome.deferredIds || []));
			const retry = ids([].concat(outcome.retryIds || [], outcome.paintPendingIds || []));
			const failed = ids([].concat(outcome.exhaustedIds || [], outcome.rejectedIds || []));
			const stale = ids(outcome.staleIds);
			let changed = false, displayed = 0, batchNumber = null, lastKey = null;
			for (const [key, batch] of batches) {
				let resolved = 0, shown = 0;
				for (const id of ids(messageIds)) {
					const row = batch.rows.get(id);
					if (!row) continue;
					const named = ids(trackingKeysByMessageId[id]).has(key);
					const stamped = Object.prototype.hasOwnProperty.call(revisionsByMessageId, id) && revisionsByMessageId[id] === row.revision;
					if (!named && !stamped) continue;
					if (stale.has(id) || getRevision(channel, id) !== row.revision) batch.rows.delete(id);
					else if (ready.has(id) && !retry.has(id)) {batch.rows.delete(id); if (row.displayable) shown++;}
					else if (failed.has(id) || !retry.has(id)) {if (row.failed) continue; row.failed = true;}
					else {
						if (row.paintPending) {row.paintPending = false; if (batch.schedule) batch.schedule(id, key);}
						continue;
					}
					resolved++;
				}
				if (![...batch.rows.values()].some(row => row.paintPending && !row.failed)) delete batch.schedule;
				if (!resolved) continue;
				changed = true; batch.displayed += shown; displayed = batch.displayed; batchNumber = batch.batch; lastKey = key;
				try {onResolved({batchKey: key, confirmedCount: shown, resolvedCount: resolved});} catch (error) {}
			}
			const state = snapshot(channel);
			if (!changed || !isStatusForChannel(channel)) return false;
			const update = {channelId: channel, jobId: lastKey, displayed, displayPending: state.pendingIds.length, displayFailed: state.failedIds.length};
			if (batchNumber != null) update.batch = batchNumber;
			updateStatus(update);
			return true;
		},
		clear(channelId = null) {if (channelId == null) channels.clear(); else channels.delete(String(channelId));}
	});
}

module.exports = {createHistoricalDisplayTracker};
