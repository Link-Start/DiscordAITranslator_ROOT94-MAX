const {createWireObservationProbe} = require("../diagnostics/wire-observation-producer");
const {observeCompactWireShadow} = require("../diagnostics/compact-wire-shadow-wiring");

function createHistoricalWireObservationProbe(plugin, sourceText, semanticRequest, protectedSegments, {wireFamily = null, wire = null, itemCount = 1} = {}) {
	return createWireObservationProbe({source: sourceText, request: semanticRequest, wireFamily: wireFamily || semanticRequest && semanticRequest.adapter || "legacy-batch", wireVersion: semanticRequest && (semanticRequest.wireVersion || semanticRequest.semanticRevision) || "legacy", wire: semanticRequest ? semanticRequest.wire : wire, translateSegments: semanticRequest ? null : [wire], itemCount, protectedSegments, configuredTerms: typeof plugin.getProtectedTermsList == "function" && (typeof plugin.shouldProtectConfiguredTermsForPlace != "function" || plugin.shouldProtectConfiguredTermsForPlace("received")) ? plugin.getProtectedTermsList() : [], wrapperRules: typeof plugin.getProtectedWrapperRules == "function" && (typeof plugin.shouldProtectWrappedTextForPlace != "function" || plugin.shouldProtectWrappedTextForPlace("received")) ? plugin.getProtectedWrapperRules() : []});
}

function refreshHistoricalWireObservationProbe(plugin, prepared) {
	if (!prepared || !prepared.semanticRequest) return prepared;
	const sourceText = plugin.buildTranslationRequestText(prepared.originalContentData || {}) || "";
	prepared.wireObservationProbe = createHistoricalWireObservationProbe(plugin, sourceText, prepared.semanticRequest, plugin.getAtomicSemanticLocalState(prepared.semanticRequest).protectedSegments);
	return prepared;
}

function prepareHistoricalAiBatchQueueItem(plugin, queueItem, channelId, input, output, receivedPlace) {
	if (!queueItem || !queueItem.message || !queueItem.message.id) return null;
	if (queueItem.cachedTranslation) return {queueItem, cachedTranslation: queueItem.cachedTranslation};
	const cachedSkipDecision = plugin.getCachedReceivedSkipDecision(queueItem.message, channelId, queueItem.originalContentData);
	if (cachedSkipDecision) return {queueItem, skipped: true, skipReason: cachedSkipDecision.reason, skipPreview: cachedSkipDecision.preview};
	if (!plugin.shouldAutoTranslateReceivedMessage(queueItem.message, queueItem.channel, queueItem.originalContentData, true)) return {queueItem, skipped: true};
	const originalContentData = queueItem.originalContentData || plugin.extractOriginalContentData(queueItem.message);
	const rawSourceText = plugin.buildTranslationRequestText(originalContentData) || "";
	const sourceText = rawSourceText.trim();
	const legacy = plugin.removeExceptions(sourceText, receivedPlace);
	const engineKey = plugin.getHistoricalAiBatchEngineKey(channelId);
	const primaryEngineKey = plugin.getHistoricalPrimaryEngineKey(channelId);
	const requestOptions = {place: receivedPlace, channelId, inputLanguageId: input.id || "auto", targetLanguageId: output.id || "zh-CN", fieldPath: "body", attempt: 1, maxAttempts: 3};
	const semanticRequest = engineKey
		? plugin.createAtomicSemanticRevisionContract(sourceText, Object.assign({}, requestOptions, {engineKey}))
		: primaryEngineKey === "googleapi"
			? plugin.createProtectedSemanticRequest(sourceText, Object.assign({}, requestOptions, {engineKey: primaryEngineKey, forceClassic: "marked"}))
			: Object.freeze({enabled: false, fallbackReason: "capability-unverified", semanticRevision: "legacy"});
	const semanticState = semanticRequest.enabled ? plugin.getAtomicSemanticLocalState(semanticRequest) : null;
	const protectedText = semanticRequest.enabled ? semanticRequest.wire : legacy[0];
	const exceptions = semanticRequest.enabled ? semanticState.protectedSegments : legacy[1];
	const legacyWireObservationProbe = createHistoricalWireObservationProbe(plugin, rawSourceText, null, legacy[1], {wireFamily: "legacy-batch", wire: legacy[0]});
	const wireObservationProbe = semanticRequest.enabled ? createHistoricalWireObservationProbe(plugin, rawSourceText, semanticRequest, semanticState.protectedSegments) : legacyWireObservationProbe;
	const shouldTranslate = semanticRequest.enabled ? semanticRequest.segmentOrder.length > 0 : legacy[2];
	if (!shouldTranslate || !protectedText) return {queueItem, skipped: true};
	if (semanticRequest.enabled) observeCompactWireShadow(plugin, semanticRequest);
	return {
		queueItem,
		message: queueItem.message,
		channelId,
		originalContentData,
		signature: plugin.createReceivedTranslationSignature(queueItem.message, channelId, originalContentData),
		protectedText,
		exceptions,
		wireObservationProbe,
		legacyWireObservationProbe,
		semanticRequest: semanticRequest.enabled ? semanticRequest : null,
		legacyProtectedText: legacy[0],
		legacyExceptions: legacy[1],
		input,
		output
	};
}

module.exports = {prepareHistoricalAiBatchQueueItem, refreshHistoricalWireObservationProbe};
