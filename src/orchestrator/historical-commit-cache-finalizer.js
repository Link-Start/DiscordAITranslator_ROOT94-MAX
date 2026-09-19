// Persists historical cache/skip entries only after the display store has atomically
// accepted them and after one final source/job/view fence. No asynchronous boundary is
// allowed between the fence and each cache write.
function createHistoricalCommitCacheFinalizer({BDFDB, performance, displayTracker} = {}) {
	// Store acceptance is authoritative; optional persistence/diagnostic failures cannot revoke its ACK.
	function observe(effect) {try {const result = effect(); if (result && typeof result.then === "function") Promise.resolve(result).catch(() => {}); return result;} catch (error) {return null;}}
	function displayScheduler(plugin, channelId) {
		return (messageId, trackingKey) => plugin.scheduleReceivedDisplayFlush(channelId, messageId, null, trackingKey, "historical");
	}

	function committedIds(batchOutcome) {
		const explicit = batchOutcome && Array.isArray(batchOutcome.committedIds) ? batchOutcome.committedIds : [];
		const blocked = new Set([].concat(batchOutcome && batchOutcome.rejectedIds || [], batchOutcome && batchOutcome.staleIds || []).map(String));
		return new Set(explicit.map(String).filter(messageId => !blocked.has(messageId)));
	}

	function currentSourceMatches(plugin, entry, job) {
		let currentMessage = null;
		try {
			const messageStore = BDFDB && BDFDB.LibraryStores && BDFDB.LibraryStores.MessageStore;
			if (messageStore && typeof messageStore.getMessage == "function") currentMessage = messageStore.getMessage(job.channelId, entry.item.message.id);
		}
		catch (error) {}
		currentMessage = currentMessage || entry.item.message;
		const currentContentData = plugin.extractOriginalContentData(currentMessage);
		return plugin.createReceivedTranslationSignature(currentMessage, job.channelId, currentContentData) === entry.result.sourceSignature;
	}

	function committedViewMatches(plugin, entry) {
		const view = plugin.getReceivedDisplayRuntimeView(entry.result.messageId);
		if (!view || view.generation !== entry.result.generation || view.sourceSignature !== entry.result.sourceSignature || view.status !== entry.result.status) return false;
		if (view.origin && entry.result.origin && view.origin !== entry.result.origin) return false;
		if (entry.result.status !== "translated") return true;
		return !!view.translation && String(view.translation.content || "") === String(entry.result.translation && entry.result.translation.content || "")
			&& String(view.translation.translatedContent || "") === String(entry.result.translation && entry.result.translation.translatedContent || "");
	}

	function capture(plugin, {job, summary} = {}) {
		const preCommitItems = [].concat(summary && summary.translated || [], summary && summary.skipped || [], summary && summary.failed || []);
		const liveSupersededItems = preCommitItems.filter(item => {
			if (!item || !item.message) return false;
			const record = job && job.items && job.items.get(String(item.message.id));
			if (record && record.status === "cancelled") return false;
			const view = plugin.getReceivedDisplayRuntimeView(String(item.message.id));
			const expectedSignature = plugin.createReceivedTranslationSignature(item.message, job.channelId, item.originalContentData || plugin.extractOriginalContentData(item.message));
			return !!(view && (view.status === "translated" || view.translated) && view.sourceSignature === expectedSignature);
		});
		return {preCommitItems, liveSupersededItems};
	}

	function finalize(plugin, {job, batchOutcome, entries = [], onCacheEvent = null} = {}) {
		const allowedIds = committedIds(batchOutcome);
		const blockedIds = new Set([].concat(batchOutcome && batchOutcome.rejectedIds || [], batchOutcome && batchOutcome.staleIds || []).map(String));
		const result = {acceptedIds: [], supersededTranslatedIds: [], translated: 0, skipped: 0, rejected: 0};
		if (!job || !plugin.isHistoricalTranslationJobCurrent(job)) {
			result.rejected = entries.length;
			return result;
		}
		for (const entry of entries) {
			const messageId = entry && entry.result && String(entry.result.messageId);
			const jobRecord = job && job.items && typeof job.items.get == "function" ? job.items.get(messageId) : null;
			const itemCurrent = !jobRecord || jobRecord.status !== "cancelled";
			const failedResult = entry && entry.result && entry.result.status === "failed";
			const currentView = messageId && plugin.getReceivedDisplayRuntimeView(messageId);
			const sameSourceTranslatedView = !!(currentView && (currentView.status === "translated" || currentView.translated) && currentView.sourceSignature === entry.result.sourceSignature);
			const acceptedByStore = failedResult ? !blockedIds.has(messageId) : allowedIds.has(messageId) && committedViewMatches(plugin, entry);
			if (messageId && sameSourceTranslatedView && (failedResult || !acceptedByStore) && itemCurrent && currentSourceMatches(plugin, entry, job)) result.supersededTranslatedIds.push(messageId);
			if (!messageId || !acceptedByStore || !plugin.isHistoricalTranslationJobCurrent(job) || !itemCurrent || failedResult && sameSourceTranslatedView || !currentSourceMatches(plugin, entry, job)) {
				result.rejected++;
				continue;
			}
			result.acceptedIds.push(messageId);
			let evictedBefore = null;
			try {if (typeof plugin.getTranslationCacheEvictedCount == "function") evictedBefore = plugin.getTranslationCacheEvictedCount();}
			catch (error) {}
			if (entry.result.status === "translated" && entry.translation) {
				if (!(entry.item && (entry.item.semanticCompatibilityFallback || entry.item.wholeMarkerBatchFinal))) observe(() => plugin.persistTranslationCacheEntry(messageId, entry.result.sourceSignature, entry.translation));
				result.translated++;
			}
			else if (entry.result.status === "skipped") {
				if (!(entry.item && (entry.item.semanticCompatibilityFallback || entry.item.wholeMarkerBatchFinal))) observe(() => plugin.persistReceivedSkipDecision(messageId, entry.result.sourceSignature, entry.reason || "local_guard", plugin.buildTranslationRequestText(entry.item.originalContentData || {})));
				result.skipped++;
			}
			if (evictedBefore != null && typeof onCacheEvent == "function") {
				try {
					const evictedAfter = plugin.getTranslationCacheEvictedCount();
					const evicted = Math.max(0, Number(evictedAfter) - Number(evictedBefore));
					if (evicted) onCacheEvent({evicted});
				}
				catch (error) {}
			}
		}
		return result;
	}

	function finalizeSummary(plugin, {job, summary, batchOutcome, entries, context, onCacheEvent = null} = {}) {
		const finalized = finalize(plugin, {job, batchOutcome, entries, onCacheEvent});
		const acceptedIds = new Set(finalized.acceptedIds.map(String));
		const acceptedSummary = {
			translated: summary.translated.filter(item => item && item.message && acceptedIds.has(String(item.message.id))),
			skipped: summary.skipped.filter(item => item && item.message && acceptedIds.has(String(item.message.id))),
			failed: summary.failed.filter(item => item && item.message && acceptedIds.has(String(item.message.id)))
		};
		const supersededIds = new Set([].concat(finalized.supersededTranslatedIds, (context.liveSupersededItems || []).map(item => String(item.message.id))).map(String));
		const snapshotSummary = Object.assign({}, acceptedSummary, {translated: acceptedSummary.translated.concat((context.preCommitItems || []).filter(item => item && item.message && supersededIds.has(String(item.message.id))))});
		const blockedIds = new Set([].concat(batchOutcome && batchOutcome.missingIds || [], batchOutcome && batchOutcome.retryIds || [], batchOutcome && batchOutcome.paintPendingIds || [], batchOutcome && batchOutcome.rejectedIds || [], batchOutcome && batchOutcome.staleIds || []).map(String));
		const displayReadyIds = new Set([].concat(batchOutcome && batchOutcome.confirmedIds || [], batchOutcome && batchOutcome.deferredIds || []).map(String).filter(messageId => !blockedIds.has(messageId)));
		const displayed = acceptedSummary.translated.filter(item => item && item.message && displayReadyIds.has(String(item.message.id))).length;
		const liveDisplayed = [...job.items.keys()].filter(messageId => {const view = plugin.getReceivedDisplayRuntimeView(String(messageId)); return view && view.translated && !displayReadyIds.has(String(messageId));}).length;
		return {acceptedSummary, snapshotSummary, displayReadyIds, displayed, liveDisplayed};
	}


	function progressEntries(plugin, job) {
		const entries = [];
		for (const [id, saved] of job.progressCommitAcks || []) {
			const record = job.items && job.items.get(id);
			if (!plugin.isHistoricalTranslationJobCurrent(job) || record && record.status === "cancelled" || !currentSourceMatches(plugin, saved.entry, job) || !committedViewMatches(plugin, saved.entry)) {
				job.progressCommitAcks.delete(id);
				continue;
			}
			entries.push(saved);
		}
		return entries;
	}

	function getProgressDisplayed(plugin, job) {
		return progressEntries(plugin, job).filter(saved => !saved.paintPendingIds && (saved.confirmedIds || saved.deferredIds)).length;
	}

	async function commit(plugin, originalSummary, job, {partial = false} = {}) {
		const empty = {committedIds: []};
		// Counts describe commit checks, not unique messages: progress and final commits
		// may inspect the same candidate. Observation never changes ownership or waits.
		const preparation = {attemptCount: 1, partialAttemptCount: partial ? 1 : 0, alreadyCommittedCount: 0, displayOwnedCount: 0, sourceChangedCount: 0, missingTranslationCount: 0};
		if (!plugin.isHistoricalTranslationJobCurrent(job)) {observe(() => performance.recordCommitPreparation(job, Object.assign(preparation, {staleJobCount: 1}))); return empty;}
		if (partial && typeof originalSummary.isCurrent === "function" && !originalSummary.isCurrent()) {observe(() => performance.recordCommitPreparation(job, Object.assign(preparation, {staleBlockCount: 1}))); return empty;}
		const prior = progressEntries(plugin, job);
		const priorIds = new Set(prior.map(saved => String(saved.entry.result.messageId)));
		const context = capture(plugin, {job, summary: originalSummary});
		context.liveSupersededItems = context.liveSupersededItems.filter(item => !priorIds.has(String(item.message.id)));
		const summary = {
			translated: originalSummary.translated.filter(item => {if (priorIds.has(String(item.message.id))) {preparation.alreadyCommittedCount++; return false;} return plugin.isHistoricalTranslationJobItemCurrent(item, job, preparation);}),
			skipped: partial ? [] : originalSummary.skipped.filter(item => plugin.isHistoricalTranslationJobItemCurrent(item, job, preparation)),
			failed: partial ? [] : originalSummary.failed.filter(item => plugin.isHistoricalTranslationJobItemCurrent(item, job, preparation))
		};
		const generation = plugin.getReceivedDisplayCommitGeneration(job.channelId);
		const results = [], entries = [];
		for (const status of ["translated", "skipped", "failed"]) for (const item of summary[status]) {
			if (!item || !item.message) continue;
			if (status === "translated" && !item.translation) {preparation.missingTranslationCount++; continue;}
			const translation = status === "translated" ? plugin.refreshTranslationDisplay(Object.assign({channelId: job.channelId, auto: true}, item.translation)) : null;
			const view = plugin.getReceivedDisplayRuntimeView(item.message.id);
			const result = {
				messageId: item.message.id, channelId: job.channelId, generation,
				sourceSignature: translation && translation.signature != null ? String(translation.signature) : plugin.createReceivedTranslationSignature(item.message, job.channelId, item.originalContentData),
				requestIdentity: view && view.requestIdentity != null ? view.requestIdentity : null,
				origin: "automatic", status,
				source: {content: item.originalContentData && item.originalContentData.content || "", embeds: item.originalContentData && item.originalContentData.embeds || []}
			};
			if (translation) result.translation = translation;
			else result.reason = item.reason || (status === "skipped" ? "local_guard" : "provider_failed");
			results.push(result);
			entries.push({item, result, translation, reason: result.reason});
		}
		let batchOutcome = null, batchCommitFailed = false;
		if (partial && typeof originalSummary.isCurrent === "function" && !originalSummary.isCurrent()) {observe(() => performance.recordCommitPreparation(job, Object.assign(preparation, {staleBlockCount: 1}))); return empty;}
		observe(() => performance.recordCommitPreparation(job, Object.assign(preparation, {submittedCount: results.length})));
		if (results.length) {
			try {batchOutcome = await plugin.commitHistoricalReceivedDisplayBatch(results);}
			catch (error) {batchCommitFailed = true;}
			observe(() => performance.recordAtomicCommit(job, batchOutcome, results.length, batchCommitFailed));
		}
		if (!plugin.isHistoricalTranslationJobCurrent(job)) return empty;
		const state = finalizeSummary(plugin, {job, summary, batchOutcome, entries, context, onCacheEvent: metrics => performance.recordCache(job, metrics)});
		const accepted = new Set(state.acceptedSummary.translated.map(item => String(item.message.id)));
		const flags = ["committedIds", "confirmedIds", "deferredIds", "paintPendingIds", "missingIds", "retryIds", "rejectedIds", "staleIds"];
		for (const entry of entries) {
			const id = String(entry.result.messageId), record = job.items && job.items.get(id), routeId = record && record.source && record.source.terminalRouteId;
			const has = flag => [].concat(batchOutcome && batchOutcome[flag] || []).map(String).includes(id);
			if (routeId) {
				observe(() => plugin.recordHistoricalAutoCheckpoint(routeId, "atomic-commit", has("committedIds") ? "committed" : batchCommitFailed ? "failed" : "rejected"));
				observe(() => plugin.recordHistoricalAutoCheckpoint(routeId, "display-currentness", has("confirmedIds") ? "confirmed" : has("deferredIds") ? "deferred" : "unconfirmed"));
			}
			if (!partial || !accepted.has(id)) continue;
			if (!job.progressCommitAcks) job.progressCommitAcks = new Map();
			const saved = {entry};
			for (const flag of flags) saved[flag] = has(flag);
			job.progressCommitAcks.set(id, saved);
			if (routeId && !saved.paintPendingIds && (saved.confirmedIds || saved.deferredIds)) {
				observe(() => plugin.finishTranslationTerminalRoute(routeId, {outcome: "translated", stage: "display-currentness", reason: "committed", displayCommit: "atomic"}));
				record.source.terminalRouteId = null;
			}
		}
		if (results.length) observe(() => performance.recordDomConfirm(job, {confirmedCount: [].concat(batchOutcome && batchOutcome.confirmedIds || []).length, deferredCount: [].concat(batchOutcome && batchOutcome.deferredIds || []).length}));
		// Register only this commit's new results. Progress ACKs retain their existing
		// tracker ownership, so finalization cannot resurrect an already resolved paint.
		const displayPending = observe(() => displayTracker.begin({channelId: job.channelId, batchKey: job.id, outcome: batchOutcome, displayed: state.displayed, displayableIds: [...accepted], schedule: displayScheduler(plugin, job.channelId)})) || 0;
		if (partial) {
			observe(() => plugin.updateLoadedAutoTranslationStatus({channelId: job.channelId, jobId: job.id, active: true, collecting: false, done: false, displayPending, displayed: getProgressDisplayed(plugin, job)}));
			return {committedIds: originalSummary.translated.map(item => String(item.message.id)).filter(id => priorIds.has(id) || accepted.has(id))};
		}
		const currentPrior = progressEntries(plugin, job).filter(saved => originalSummary.translated.some(item => String(item.message.id) === String(saved.entry.result.messageId)));
		for (const saved of currentPrior) {
			const id = String(saved.entry.result.messageId), view = plugin.getReceivedDisplayRuntimeView(id);
			if (view && view.renderStatus === "confirmed") {
				if (!saved.confirmedIds && !saved.deferredIds) observe(() => performance.recordDomConfirm(job, {confirmedCount: 1}));
				saved.confirmedIds = true; saved.missingIds = saved.retryIds = saved.deferredIds = saved.paintPendingIds = false;
				const record = job.items.get(id), routeId = record && record.source && record.source.terminalRouteId;
				if (routeId) observe(() => plugin.recordHistoricalAutoCheckpoint(routeId, "display-currentness", "confirmed"));
			}
		}
		const outcome = Object.assign({}, batchOutcome || {});
		for (const flag of flags) outcome[flag] = [...new Set([].concat(outcome[flag] || []).map(String).concat(currentPrior.filter(saved => saved[flag]).map(saved => String(saved.entry.result.messageId))))];
		state.acceptedSummary.translated.push(...currentPrior.map(saved => saved.entry.item));
		state.snapshotSummary.translated.push(...currentPrior.map(saved => saved.entry.item));
		const acceptedIds = new Set(state.acceptedSummary.translated.map(item => String(item.message.id)));
		const blocked = new Set([].concat(outcome.missingIds, outcome.retryIds, outcome.paintPendingIds, outcome.rejectedIds, outcome.staleIds));
		const displayReady = new Set([].concat(outcome.confirmedIds, outcome.deferredIds).filter(id => !blocked.has(id)));
		const displayed = [...acceptedIds].filter(id => displayReady.has(id)).length;
		const liveDisplayed = [...job.items.keys()].filter(id => {
			const view = plugin.getReceivedDisplayRuntimeView(String(id)), record = job.items.get(id);
			const item = record && record.source || context.preCommitItems.find(item => String(item.message.id) === String(id));
			return view && view.translated && (!record || record.status !== "cancelled") && item && currentSourceMatches(plugin, {item, result: {sourceSignature: view.sourceSignature}}, job) && !acceptedIds.has(String(id)) && !displayReady.has(String(id));
		}).length;
		const failedCount = plugin.updateFailedHistoricalTranslationSnapshots(state.snapshotSummary, job.channelId);
		plugin.updateLoadedAutoTranslationStatus({active: false, collecting: false, done: !displayPending, channelId: job.channelId, jobId: job.id, total: job.items.size, processed: job.items.size, displayed: displayed + liveDisplayed, displayPending, skipped: state.acceptedSummary.skipped.length, failed: state.acceptedSummary.failed.length, retryable: failedCount, aiDropped: state.acceptedSummary.failed.length});
		return {committedIds: [...acceptedIds]};
	}

	return Object.freeze({capture, finalize, finalizeSummary, commit, getProgressDisplayed});
}

module.exports = {createHistoricalCommitCacheFinalizer};
