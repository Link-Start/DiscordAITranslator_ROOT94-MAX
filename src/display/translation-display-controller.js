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

function createTranslationDisplayController({store, renderAdapter}) {
	let transactionSequence = 0;

	async function refreshRecords(records) {
		if (!records.length) return createEmptyOutcome();
		const views = records.map(record => createDisplayView(store.getDisplayState(record.messageId)));
		if (views.some(view => !view)) throw new Error("A display transaction requires one view per record");
		const channelIds = new Set(views.map(view => view.channelId));
		if (channelIds.size !== 1) throw new Error("A display transaction cannot span channels");
		const requestedViews = new Map(views.map(view => [String(view.messageId), view]));
		const outcome = await renderAdapter.refreshMessages({
			transactionId: ++transactionSequence,
			channelId: views[0].channelId,
			messageIds: views.map(view => view.messageId),
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
		store.markRenderOutcome({confirmedIds, missingIds});
		const filteredOutcome = {
			...rawOutcome,
			confirmedIds,
			missingIds,
			fallbackUsed: rawOutcome.fallbackUsed === true
		};
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
			const outcome = store.commitBatch(results);
			if (outcome.committed.length) return refreshRecords(outcome.committed);
			if (!outcome.rejected.length) return createEmptyOutcome();
			return createEmptyOutcome({rejectedIds: outcome.rejected.map(result => String(result.messageId))});
		},
		async restoreMessage(messageId, {refresh = true} = {}) {
			const records = store.restoreMessage(messageId);
			if (!records.length) return createEmptyOutcome();
			return refresh ? refreshRecords(records) : createEmptyOutcome({deferredIds: records.map(record => record.messageId)});
		},
		async restoreChannel(channelId) {
			return refreshRecords(store.restoreChannel(channelId));
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
