function createDisplayView(state) {
	if (!state) return null;
	const translated = state.status === "translated" && !!state.translation;
	const content = translated ? state.translation.content : state.source && state.source.content;
	return Object.freeze({
		messageId: state.messageId,
		channelId: state.channelId,
		revision: state.revision,
		status: state.status,
		content: String(content == null ? "" : content),
		translated,
		showWatermark: translated,
		showLoading: state.status === "pending" || state.status === "translating",
		reason: state.reason,
		renderStatus: state.renderStatus,
		renderReason: state.renderReason,
		translation: state.translation,
		restoredTranslation: state.restoredTranslation || null,
		source: state.source,
		origin: state.origin,
		generation: state.generation,
		sourceSignature: state.sourceSignature,
		requestIdentity: state.requestIdentity
	});
}

function createEmptyOutcome(additions) {
	return {
		confirmedIds: [],
		missingIds: [],
		fallbackUsed: false,
		...additions
	};
}

function createTranslationDisplayController({store, renderAdapter, journal = null}) {
	let transactionSequence = 0;

	function recordRenderTransition(view, transition) {
		if (!journal || !view) return;
		journal.append({channelId: view.channelId, messageId: view.messageId, revision: view.revision, transition});
	}

	async function refreshRecords(records, {channelId = null, ownerMessageIds = []} = {}) {
		if (!records.length && !ownerMessageIds.length) return createEmptyOutcome();
		const views = records.map(record => createDisplayView(store.getDisplayState(record.messageId)));
		if (views.some(view => !view)) throw new Error("A display transaction requires one view per record");
		const channelIds = new Set(views.map(view => view.channelId));
		if (channelId != null) channelIds.add(String(channelId));
		if (channelIds.size !== 1) throw new Error("A display transaction cannot span channels");
		const transactionChannelId = channelIds.values().next().value;
		const requestedViews = new Map(views.map(view => [String(view.messageId), view]));
		for (const view of views) recordRenderTransition(view, "render-requested");
		const outcome = await renderAdapter.refreshMessages({
			transactionId: ++transactionSequence,
			channelId: transactionChannelId,
			messageIds: views.map(view => view.messageId),
			ownerMessageIds,
			views
		});
		const rawOutcome = outcome || createEmptyOutcome();
		const staleIds = [];
		const staleIdSet = new Set();

		function filterCurrentIds(messageIds) {
			return (Array.isArray(messageIds) ? messageIds : []).filter(messageId => {
				const requestedView = requestedViews.get(String(messageId));
				if (!requestedView) return false;
				const current = store.getDisplayState(requestedView.messageId);
				if (current && current.revision === requestedView.revision) return true;
				if (!staleIdSet.has(requestedView.messageId)) {
					staleIdSet.add(requestedView.messageId);
					staleIds.push(requestedView.messageId);
				}
				return false;
			});
		}

		const confirmedIds = filterCurrentIds(rawOutcome.confirmedIds);
		const missingIds = filterCurrentIds(rawOutcome.missingIds);
		const deferredIds = filterCurrentIds(rawOutcome.deferredIds);
		const retryIds = filterCurrentIds(rawOutcome.retryIds);
		for (const messageId of confirmedIds) recordRenderTransition(requestedViews.get(String(messageId)), "render-confirmed");
		for (const messageId of missingIds) recordRenderTransition(requestedViews.get(String(messageId)), "render-unconfirmed");
		store.markRenderOutcome({confirmedIds, missingIds});
		const filteredOutcome = {
			...rawOutcome,
			confirmedIds,
			missingIds,
			fallbackUsed: rawOutcome.fallbackUsed === true
		};
		if (deferredIds.length) filteredOutcome.deferredIds = deferredIds;
		else delete filteredOutcome.deferredIds;
		if (retryIds.length) filteredOutcome.retryIds = retryIds;
		else delete filteredOutcome.retryIds;
		if (staleIds.length) filteredOutcome.staleIds = staleIds;
		return filteredOutcome;
	}

	return Object.freeze({
		getDisplayView(messageId) {
			return createDisplayView(store.getDisplayState(messageId));
		},
		async renderMessage(messageId) {
			const record = store.getDisplayState(messageId);
			return record ? refreshRecords([record]) : createEmptyOutcome();
		},
		async renderMessages(messageIds) {
			const records = (Array.isArray(messageIds) ? messageIds : []).map(messageId => store.getDisplayState(messageId)).filter(Boolean);
			return refreshRecords(records);
		},
		async refreshDisplayTransaction({channelId, messageIds = [], ownerMessageIds = []} = {}) {
			const uniqueMessageIds = [...new Set((Array.isArray(messageIds) ? messageIds : []).map(String))];
			const records = uniqueMessageIds.map(messageId => store.getDisplayState(messageId)).filter(Boolean);
			return refreshRecords(records, {channelId, ownerMessageIds: [...new Set((Array.isArray(ownerMessageIds) ? ownerMessageIds : []).map(String))]});
		},
		async deleteMessage(messageId, channelId, {refresh = true} = {}) {
			const ownerMessageIds = store.getPreviewHostMessageIds(channelId, [String(messageId)]);
			if (!store.deleteMessage(messageId, channelId)) return false;
			if (!refresh || !ownerMessageIds.length) return createEmptyOutcome({deleted: true});
			return refreshRecords([], {channelId, ownerMessageIds});
		},
		async markPending(request, {refresh = true} = {}) {
			const record = store.markPending(request);
			if (!record) return createEmptyOutcome({rejectedIds: [String(request.messageId)]});
			return refresh ? refreshRecords([record]) : createEmptyOutcome({deferredIds: [record.messageId]});
		},
		async commitMessageResult(result, {refresh = true} = {}) {
			const record = store.commitResult(result);
			if (!record) return createEmptyOutcome({rejectedIds: [String(result.messageId)]});
			return refresh ? refreshRecords([record]) : createEmptyOutcome({deferredIds: [record.messageId]});
		},
		async commitHistoricalBatch(results) {
			const channelIds = new Set(results.map(result => result && result.channelId != null ? String(result.channelId) : ""));
			if (channelIds.size === 1) for (const result of results) {
				const current = result && store.getDisplayState(result.messageId);
				if (result && result.source && (!current || !current.sourceSignature)) store.captureSource({messageId: result.messageId, channelId: result.channelId, generation: result.generation, sourceSignature: result.sourceSignature, source: result.source});
			}
			const outcome = store.commitBatch(results);
			if (!outcome.committed.length) {
				if (!outcome.rejected.length) return createEmptyOutcome();
				return createEmptyOutcome({rejectedIds: outcome.rejected.map(result => String(result.messageId))});
			}
			const refreshOutcome = await refreshRecords(outcome.committed);
			if (outcome.rejected.length) refreshOutcome.rejectedIds = outcome.rejected.map(result => String(result.messageId));
			return refreshOutcome;
		},
		async commitPreviewResult(result, {refresh = true} = {}) {
			const record = store.commitPreviewResult(result);
			if (!record) return createEmptyOutcome({rejectedIds: [String(result && result.messageId)]});
			if (!refresh) return createEmptyOutcome();
			const channelId = record.channelId || result.channelId;
			const ownerMessageIds = store.getPreviewHostMessageIds(channelId, [record.messageId]);
			return refreshRecords([], {channelId, ownerMessageIds});
		},
		async restoreMessage(messageId, {refresh = true} = {}) {
			const records = store.restoreMessage(messageId);
			if (!records.length) return createEmptyOutcome();
			return refresh ? refreshRecords(records) : createEmptyOutcome({deferredIds: records.map(record => record.messageId)});
		},
		async restoreChannel(channelId, {clearPreviews = false, clearSuppressions = false} = {}) {
			const previewHostMessageIds = clearPreviews ? store.getPreviewHostMessageIds(channelId) : [];
			const restored = store.restoreChannel(channelId);
			if (clearPreviews) store.clearPreviews(channelId);
			if (clearSuppressions) store.clearChannelSuppression(channelId);
			const messageIds = [...new Set(restored.map(record => record.messageId))];
			return refreshRecords(messageIds.map(messageId => store.getDisplayState(messageId)).filter(Boolean), {channelId, ownerMessageIds: previewHostMessageIds});
		},
		async restoreAll({refresh = true} = {}) {
			const records = store.restoreAll();
			if (!refresh) return records;
			if (!records.length) return createEmptyOutcome();
			const byChannel = new Map();
			for (const record of records) {
				if (!byChannel.has(record.channelId)) byChannel.set(record.channelId, []);
				byChannel.get(record.channelId).push(record);
			}
			return Promise.all([...byChannel.values()].map(refreshRecords));
		}
	});
}

module.exports = {createDisplayView, createTranslationDisplayController};
