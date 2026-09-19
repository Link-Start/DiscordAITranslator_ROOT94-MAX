const {createLiveTranslationQueue} = require("./live-translation-queue");
const {createRealtimePerformanceTrace} = require("../diagnostics/realtime-performance-trace");
const {isCustomEngineKey} = require("../providers/provider-client");

// Owns the plugin/BDFDB adapter for live queue state. The queue retains ordering,
// locks, handoff reservations, channel sessions, batching and retry policy; this
// module supplies translation/display policy and neighbouring owner callbacks.
// It also owns the F0 realtime-performance trace: the queue feeds it through the
// observer seam and the repaint outcome path closes its enqueue-to-DOM spans.
function createPluginLiveTranslationQueue({
	plugin,
	BDFDB,
	loadedTranslationStatusStore,
	historicalBatchPerformance = null,
	getRuntimeActive = () => true,
	languageTypes,
	messageTypes,
	createQueue = createLiveTranslationQueue,
	createPerformanceTrace = createRealtimePerformanceTrace
}) {
	const performanceTrace = createPerformanceTrace({onDomObservation: event => {try {plugin.ensureProviderClient().recordDisplayObservation(event);} catch (error) {}}, getObservationGeneration: () => {try {return plugin.ensureProviderClient().getLatencyGeneration();} catch (error) {return null;}}});
	const beginTerminalRoute = metadata => typeof plugin.beginTranslationTerminalRoute == "function" ? plugin.beginTranslationTerminalRoute(metadata) : null;
	const stageTerminalRoute = (routeId, stage, reason, metadata) => routeId && typeof plugin.recordTranslationTerminalStage == "function" ? plugin.recordTranslationTerminalStage(routeId, stage, reason, metadata) : false;
	const finishTerminalRoute = (routeId, terminal) => routeId && typeof plugin.finishTranslationTerminalRoute == "function" ? plugin.finishTranslationTerminalRoute(routeId, terminal) : false;
	const liveRoutes = new Map(), routeKey = (channelId, messageId) => `${String(channelId || "__global")}:${String(messageId || "")}`;
	const registerLiveRoute = (queueItem, channelId) => {if (queueItem && queueItem.terminalRouteId && queueItem.message && queueItem.message.id != null) {const key = routeKey(channelId, queueItem.message.id); Object.defineProperty(queueItem, "terminalRouteKey", {value: key, writable: true, configurable: true}); liveRoutes.set(key, queueItem);}};
	const finishLiveRoute = (queueItem, terminal) => {if (!queueItem || !queueItem.terminalRouteId) return false; const routeId = queueItem.terminalRouteId; if (queueItem.terminalRouteKey) liveRoutes.delete(queueItem.terminalRouteKey); queueItem.terminalRouteId = queueItem.terminalRouteKey = null; return finishTerminalRoute(routeId, terminal);};
	const queueObserver = {notify: (type, payload) => {performanceTrace.queueObserver.notify(type, payload); if (type !== "stale-drop" && type !== "guard-drop") return; const queueItem = liveRoutes.get(routeKey(payload && payload.channelId, payload && payload.messageId)); if (queueItem) finishLiveRoute(queueItem, {outcome: type === "stale-drop" ? "stale" : "skipped", stage: type === "stale-drop" ? "display-currentness" : "precheck", reason: type === "stale-drop" ? payload && payload.site || "stale" : "guard_drop"});}};
	const queue = createQueue({
		observer: queueObserver,
		setTimeout: (callback, delay) => BDFDB.TimeUtils.timeout(callback, delay),
		clearTimeout: timer => BDFDB.TimeUtils.clear(timer),
		isRuntimeActive: getRuntimeActive,
		isTranslationEnabled: channelId => plugin.isTranslationEnabled(channelId),
		extractOriginalContentData: message => plugin.extractOriginalContentData(message),
		createTranslationSignature: (message, channelId, originalContentData) => plugin.createReceivedTranslationSignature(message, channelId, originalContentData),
		getMessageChannelId: message => plugin.getMessageChannelId(message),
		isProviderBackoffActive: () => plugin.ensureProviderClient().isBackoffActive(),
		shouldAutoTranslateMessage: (message, channel, originalContentData, ignoreQueued) => plugin.shouldAutoTranslateReceivedMessage(message, channel, originalContentData, ignoreQueued),
		isMessageWithinLoadedRange: message => plugin.isMessageWithinLoadedRange(message),
		getDisplayCommitGeneration: channelId => plugin.getReceivedDisplayCommitGeneration(channelId),
		markDisplayPending: (record, options) => plugin.markReceivedDisplayPending(record, options),
		releaseDisplayPending: record => plugin.releaseReceivedDisplayPending(record),
		scheduleDisplayFlush: (channelId, messageId, source) => plugin.scheduleReceivedDisplayFlush(channelId, messageId, null, null, source || "live"),
		collectHistoricalMessage: queueItem => plugin.collectHistoricalTranslationMessage(queueItem),
		resetLoadedMessageTracking: (channelId = null) => loadedTranslationStatusStore.resetSeen(channelId),
		clearEligibleReplyPreviewMessages: channelId => plugin.clearAutoTranslationEligibleReplyPreviewMessages(channelId),
		clearChannelTranslationQueue: channelId => plugin.clearAutoTranslationQueue(channelId),
		onChannelSessionLeft: channelId => plugin.ensureReceivedDisplayRuntime().pruneChannel(channelId),
		// new_only hides what is already on screen, so a fresh session drops the
		// automatic records the previous session painted.
		onChannelSessionStarted: channelId => plugin.getReceivedAutoTranslateScope() == "new_only" && plugin.clearDisplayedAutoTranslations(channelId),
		onLiveMessageQueued: channelId => {plugin.ensureMessageViewportStore().preserveHistoryOnLiveMessage(channelId); if (historicalBatchPerformance) historicalBatchPerformance.recordLiveDemand();},
		onLiveTurnStarted: () => historicalBatchPerformance && historicalBatchPerformance.recordLiveTurnStarted(),
		onReservedLiveRequestConsumed: (channelId, handoffTicket) => plugin.resumeQueuedHistoricalTranslationJobs(channelId, handoffTicket),
		onReservedLiveRequestRetired: (channelId, handoffTicket) => plugin.resumeQueuedHistoricalTranslationJobs(channelId, handoffTicket, {retired: true}),
		getBatchEngineKey: channelId => plugin.getHistoricalAiBatchEngineKey(channelId),
		createBurstContext: channelId => ({
			engineKey: plugin.getHistoricalAiBatchEngineKey(channelId),
			input: Object.assign({}, plugin.ensureSettingsStore().getLanguage(plugin.getLanguageChoice(languageTypes.INPUT, messageTypes.RECEIVED, channelId)) || {}),
			output: Object.assign({}, plugin.ensureSettingsStore().getLanguage(plugin.getLanguageChoice(languageTypes.OUTPUT, messageTypes.RECEIVED, channelId)) || {})
		}),
		prepareBurstItem: (queueItem, channelId, context) => {if (!queueItem.terminalRouteId) Object.defineProperty(queueItem, "terminalRouteId", {value: beginTerminalRoute({lane: "live-burst", entry: "received-auto", eligibility: "eligible", shape: queueItem.originalContentData && queueItem.originalContentData.embeds && queueItem.originalContentData.embeds.length ? "embed-forward" : "text", promptFamily: "batch-json", validatorFamily: "history-batch", requestFamily: "batch-json"}), writable: true, configurable: true}); registerLiveRoute(queueItem, channelId); stageTerminalRoute(queueItem.terminalRouteId, "precheck", "started"); const prepared = plugin.prepareHistoricalAiBatchQueueItem(queueItem, channelId, context.input, context.output); if (prepared && prepared.exceptions && typeof plugin.getProtectionRuleSummary == "function") stageTerminalRoute(queueItem.terminalRouteId, "protection", "rules_applied", plugin.getProtectionRuleSummary(prepared.exceptions)); if (typeof plugin.observeReceivedBodyTranslationPlan == "function") plugin.observeReceivedBodyTranslationPlan(queueItem.originalContentData && queueItem.originalContentData.content || queueItem.message && queueItem.message.content || "", {lane: "live-burst", channelId, legacyHardSkip: false, legacyEligibility: prepared && !prepared.skipped ? "eligible" : "filtered"}); return prepared;},
		requestBurstTranslation: (context, prepared) => {
			const providerClient = plugin.ensureProviderClient();
			for (const item of prepared) {const routeId = item && item.queueItem && item.queueItem.terminalRouteId; if (routeId) stageTerminalRoute(routeId, "provider", "dispatch", {providerRole: "primary", requestFamily: "batch-json", engineFamily: isCustomEngineKey(context.engineKey) ? "custom" : typeof plugin.supportsAiAutoTranslateDecisionEngine == "function" && plugin.supportsAiAutoTranslateDecisionEngine(context.engineKey) ? "ai" : "classic", decisionApplied: typeof plugin.shouldUseAiAutoTranslateDecision == "function" ? plugin.shouldUseAiAutoTranslateDecision(item.channelId) : null, promptFamily: "batch-json"});}
			const inputChars = prepared.reduce((total, item) => total + String(item && item.protectedText || "").length, 0);
			const token = providerClient && typeof providerClient.beginLatencyRequest == "function" ? providerClient.beginLatencyRequest({kind: "live", lane: "live-burst", queueWaitMs: context.queueWaitMs, messageCount: context.messageCount || prepared.length, inputChars}) : null;
			if (token) for (const item of prepared) if (item && item.message) performanceTrace.linkAttempt({channelId: item.channelId || item.message.channel_id, messageId: item.message.id, requestId: token.requestId, generation: token.generation});
			let timingOptions = token ? {token, role: "primary", observationRole: "primary", engineKey: context.engineKey, messageCount: context.messageCount || prepared.length} : null;
			if (timingOptions && typeof plugin.updateTranslationTerminalRoute == "function") timingOptions.diagnosticRequestObserver = event => {for (const item of prepared) {const routeId = item && item.queueItem && item.queueItem.terminalRouteId; if (routeId) plugin.updateTranslationTerminalRoute(routeId, {requestBodyBytes: event && event.bodyBytes, requestBodyIdentity: event && event.bodyIdentity});}};
			if (typeof context.onPrimaryResults === "function") timingOptions = Object.assign({}, timingOptions, {onPrimaryResults: context.onPrimaryResults});
			const request = plugin.requestAiBatchTranslationDetailed(context.engineKey, prepared, timingOptions), recordFallback = outcome => {for (const item of prepared) {const routeId = item && item.queueItem && item.queueItem.terminalRouteId; if (routeId && item.semanticCompatibilityFallback) stageTerminalRoute(routeId, "repair", "legacy_batch_compatibility_fallback", {providerDispatch: true, providerRole: "fallback", requestFamily: "legacy-batch-fallback", semanticRevision: item.semanticFallbackRevision});} return outcome;};
			return request && typeof request.then === "function" ? request.then(recordFallback) : recordFallback(request);
		},
		// Translation identity and result policy stay at the plugin seam; the queue
		// learns only whether the item completed, skipped, or needs a single retry.
		resolveBurstItemResult: (preparedItem, resultMap, channelId) => {
			const messageId = String(preparedItem.message.id);
			const rawTranslation = resultMap && Object.prototype.hasOwnProperty.call(resultMap, messageId) ? resultMap[messageId] : null;
			if (rawTranslation != null && plugin.isSkipTranslationSignal(rawTranslation)) {
				if (!preparedItem.semanticCompatibilityFallback) plugin.persistReceivedSkipDecision(messageId, preparedItem.signature, "ai_skip_signal", preparedItem.protectedText);
				return {status: "skipped", result: {sourceSignature: preparedItem.signature, status: "skipped", reason: "ai_skip_signal"}};
			}
			if (preparedItem.semanticCompatibilityFallbackFailed) {if (preparedItem.queueItem && preparedItem.queueItem.terminalRouteId) {stageTerminalRoute(preparedItem.queueItem.terminalRouteId, "repair", "legacy_fallback_failed", {requestFamily: "legacy-batch-fallback", semanticRevision: preparedItem.semanticFallbackRevision}); finishLiveRoute(preparedItem.queueItem, {outcome: "failed", stage: "repair", reason: "legacy_fallback_failed"});} return {status: "retry"};}
			let validation = {ok: false};
			try {validation = plugin.validateHistoricalTranslationJobResult(preparedItem, rawTranslation, {channelId}) || {ok: false};}
			catch (error) {validation = {ok: false};}
			if (validation.skipped) {
				const reason = validation.reason || "ai_skip_signal";
				if (!preparedItem.semanticCompatibilityFallback) plugin.persistReceivedSkipDecision(messageId, preparedItem.signature, reason, preparedItem.protectedText);
				return {status: "skipped", result: {sourceSignature: preparedItem.signature, status: "skipped", reason}};
			}
			if (!validation.ok && preparedItem.wholeMarkerBatchFinal) {finishLiveRoute(preparedItem.queueItem, {outcome: "failed", stage: "parse", reason: validation.reason || preparedItem.wholeMarkerBatchFailureReason || "w5-unresolved"}); return {status: "failed", result: {sourceSignature: preparedItem.signature, status: "failed", reason: validation.reason || "w5-unresolved", wholeMarkerBatchTerminal: true}};}
			if (!validation.ok) {if (preparedItem.queueItem && preparedItem.queueItem.terminalRouteId) {stageTerminalRoute(preparedItem.queueItem.terminalRouteId, "repair", "requeue_single", {laneTag: "item-repair"}); finishLiveRoute(preparedItem.queueItem, {outcome: "failed", stage: "repair", reason: "requeue_single"});} return {status: "retry"};}
			// A paid valid result is cached even if the live request went stale, so a
			// later retry can use the cache rather than the provider.
			try {if (!preparedItem.semanticCompatibilityFallback && !preparedItem.wholeMarkerBatchFinal) plugin.persistTranslationCacheEntry(messageId, preparedItem.signature, validation.translation);}
			catch (error) {}
			return {status: "translated", result: Object.assign({sourceSignature: preparedItem.signature, status: "translated", translation: validation.translation}, preparedItem.wholeMarkerBatchFinal ? {wholeMarkerBatchIsCurrent: preparedItem.wholeMarkerBatchIsCurrent} : {})};
		},
		commitBurstResult: (queueItem, channelId, result) => {if (result.wholeMarkerBatchTerminal) return null; if (result.wholeMarkerBatchIsCurrent && !result.wholeMarkerBatchIsCurrent()) {finishLiveRoute(queueItem, {outcome: "stale", stage: "display-currentness", reason: "stale"}); return null;} let outcome; try {outcome = plugin.commitReceivedDisplayResult(plugin.createReceivedDisplayCommitResult(queueItem.message, channelId, result), {refresh: false});} finally {finishLiveRoute(queueItem, {outcome: result.status === "translated" ? "translated" : "skipped", stage: result.status === "translated" ? "display-currentness" : "provider", reason: result.status === "translated" ? "committed" : result.reason || "ai_skip_signal", displayCommit: "applied"});} return outcome;},
		commitCachedResult: (queueItem, channelId) => {
			if (!queueItem.terminalRouteId) Object.defineProperty(queueItem, "terminalRouteId", {value: beginTerminalRoute({lane: "cache-hit", entry: "received-auto", eligibility: "eligible", shape: "text", promptFamily: "none", validatorFamily: "cache", requestFamily: "none"}), writable: true, configurable: true});
			stageTerminalRoute(queueItem.terminalRouteId, "cache", "translation_hit", {cacheRead: "translation-hit"});
			const storedTranslation = plugin.refreshTranslationDisplay(Object.assign({channelId, auto: true}, queueItem.cachedTranslation));
			const outcome = plugin.commitReceivedDisplayResult(plugin.createReceivedDisplayCommitResult(queueItem.message, channelId, {
				sourceSignature: storedTranslation.signature != null ? String(storedTranslation.signature) : plugin.createReceivedTranslationSignature(queueItem.message, channelId, queueItem.originalContentData),
				requestIdentity: queueItem.liveRequest ? String(queueItem.liveRequest.id) : null,
				status: "translated",
				translation: storedTranslation
			}), {refresh: false});
			finishLiveRoute(queueItem, {outcome: "translated", stage: "cache", reason: "translation_hit", displayCommit: "cache-applied"}); return outcome;
		},
		translateSingleItem: queueItem => {if (queueItem.terminalRouteId) {stageTerminalRoute(queueItem.terminalRouteId, "repair", "single_fallback", {laneTag: "auto-single"}); finishLiveRoute(queueItem, {outcome: "failed", stage: "repair", reason: "single_fallback"});} const client = plugin.ensureProviderClient(), token = client && typeof client.beginLatencyRequest == "function" ? client.beginLatencyRequest({kind: "live", lane: "auto-single", queueWaitMs: queueItem.queueWaitMs, messageCount: 1, inputChars: String(queueItem && queueItem.message && queueItem.message.content || "").length}) : null; if (token && queueItem.message) performanceTrace.linkAttempt({channelId: queueItem.channel && queueItem.channel.id || queueItem.message.channel_id, messageId: queueItem.message.id, requestId: token.requestId, generation: token.generation}); return plugin.translateMessage(queueItem.message, queueItem.channel, {
			auto: true,
			silent: true,
			trackBusy: false,
			originalContentData: queueItem.originalContentData,
            liveSingleSource: queueItem.historicalLoad ? "historical" : queueItem.skipLiveBatch ? "burst-requeue" : "direct-single",
			liveRequest: queueItem.liveRequest,
			latencyKind: "live",
			queueWaitMs: queueItem.queueWaitMs,
			messageCount: 1,
			latencyToken: token
		});}
	});
	return Object.freeze(Object.assign({}, queue, {performanceTrace}));
}

module.exports = {createPluginLiveTranslationQueue};
