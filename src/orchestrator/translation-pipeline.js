// The manual/live translation pipeline: translateMessage (one message end-to-end -
// untranslate toggle, skip policy, cache hit, provider request, display commit) and
// translateText (protection, language resolution, special cases, engine dispatch
// with backup failover, AI-decision safety net, toast/watchdog lifecycle).
// Extracted textually from the legacy runtime in display-unification slice 4: every
// collaborator call routes through the plugin so policy methods keep their existing
// seams and test stubs keep intercepting. The composition-root rewrite (slice 5)
// may narrow these dependencies; this slice only moves ownership.
const {translationEngines, isCustomEngineKey} = require("../providers/provider-client");
const {parseStoredEmbedTranslations} = require("../received/embed-translation-parser");
const {createProviderCompatibilityBudget} = require("../providers/provider-attempt-owner");
const {createWireObservationProbe} = require("../diagnostics/wire-observation-producer");
const {observeCompactWireShadow} = require("../diagnostics/compact-wire-shadow-wiring");
const {createWholeMarkerCacheIdentity, createWholeMarkerSingleCanary, isExplicitReceivedBodySingle, compileWholeMarkerSingle, runWholeMarkerSingle, WHOLE_MARKER_VERSION, WHOLE_MARKER_VALIDATOR_VERSION} = require("./whole-marker-single-canary");
const {VALIDATOR_FAMILY} = require("../planner/translation-soft-validation");
const {LEGACY_DECISION_RULES} = require("../settings/translation-preferences");

function createTranslationPipeline({BDFDB, getPlugin, messageTypes, languageTypes}) {
	const canary = createWholeMarkerSingleCanary({setTimeout: (fn, ms) => BDFDB.TimeUtils.timeout(fn, ms), clearTimeout: timer => BDFDB.TimeUtils.clear(timer)}), canaryToken = Symbol("received-body-canary"), canaryCacheToken = Symbol("received-body-cache");
	const canaryProviderSupported = (plugin, channelId) => {
        if (!canary.snapshot().enabled) return false;
        try {const engineKey = plugin.getEffectivePrimaryEngine(channelId); return (isCustomEngineKey(engineKey) || engineKey === "oaicompat") && plugin.ensureProviderClient().getWireExperimentCapability(engineKey).protocolFamily === "openai_chat";} catch {return false;}
    };
	// Pin each source representation before dispatch. A caller-supplied Embed projection
	// can differ from Discord's raw shape, and an already-old display view is not a new edit.
	function createManualSourceGuard(plugin, message, channelId, requestSignature) {
		const signatureOf = item => plugin.createReceivedTranslationSignature(item, channelId, plugin.extractOriginalContentData(item, {ignoreReferencedPreview: true}));
		const viewSignature = () => {const view = plugin.getReceivedDisplayRuntimeView(message.id); return view && String(view.channelId) === String(channelId) ? view.sourceSignature : null;};
		let originalSignature, initialViewSignature;
		try {originalSignature = signatureOf(message); initialViewSignature = viewSignature();}
		catch (error) {return () => false;}
		return () => {
			try {
				// Check the original object even when Store holds a distinct copy of that source.
				if (signatureOf(message) !== originalSignature) return false;
				const store = BDFDB.LibraryStores && BDFDB.LibraryStores.MessageStore;
				const current = store && typeof store.getMessage === "function" ? store.getMessage(channelId, message.id) : null;
				if (current && signatureOf(current) !== originalSignature) return false;
				const currentViewSignature = viewSignature();
				return !currentViewSignature || currentViewSignature === initialViewSignature || currentViewSignature === originalSignature || currentViewSignature === requestSignature;
			}
			catch (error) {return false;}
		};
	}

	function translateMessage(message, channel, options = {}) {
		const plugin = getPlugin();
		return new Promise(callback => {
			let liveRequest = options.auto ? options.liveRequest || null : null;
			let manualRequestKey = null;
			let manualRequest = null, canaryLease = null, canaryCache = null;
			let terminalRouteId = null;
			const finish = (result, terminal = null) => {
				if (canaryLease) canaryLease.finish();
				if (terminalRouteId) {plugin.finishTranslationTerminalRoute(terminalRouteId, terminal || {outcome: result === true ? "translated" : result === false ? "skipped" : "failed", stage: "display-currentness", reason: result === true ? "completed" : result === false ? "not_displayed" : "invalid"}); terminalRouteId = null;}
				if (liveRequest) plugin.finishLiveTranslationRequest(liveRequest);
				plugin.ensureSentTranslationStore().releaseManualRequest(manualRequestKey, manualRequest);
				callback(result);
			};
			if (!message) return finish(null);
			const channelId = channel && channel.id || BDFDB.LibraryStores.SelectedChannelStore.getChannelId();
			const isManualTranslation = !!options.manual || !options.auto;
			terminalRouteId = plugin.beginTranslationTerminalRoute({lane: options.auto ? "auto-single" : "manual", entry: options.auto ? "received-auto" : "manual-click", eligibility: options.auto ? "eligible" : "not-applicable", shape: message.embeds && message.embeds.length ? "embed-forward" : "text", validatorFamily: "manual-received", requestFamily: "single-text"});
			if (message.embeds && message.embeds.length) plugin.updateTranslationTerminalRoute(terminalRouteId, {laneTag: "embed-forward"});
			plugin.recordTranslationTerminalStage(terminalRouteId, "precheck", "started");
			if (isManualTranslation) manualRequestKey = plugin.ensureSentTranslationStore().createManualRequestKey(channelId, message.id);
			const activeTranslation = plugin.getActiveMessageTranslation(message, channelId);
			const storeDisplayView = !activeTranslation && plugin.getReceivedDisplayRuntimeView(message.id);
			const storeTranslated = !!(storeDisplayView && storeDisplayView.translated && storeDisplayView.origin === "automatic");
			if (isManualTranslation && !activeTranslation && !storeTranslated && plugin.ensureSentTranslationStore().hasManualRequest(manualRequestKey)) return finish(false, {outcome: "cancelled", stage: "precheck", reason: "duplicate_request"});
			if (isManualTranslation) plugin.lockManualTranslationScroll(message.id);
			if (activeTranslation || storeTranslated) {
				// Untranslate. The display store owns the translation, so the restore is what
				// produces the cancelled terminal state with its reason and repaints the
				// original; clearing first would return the record to idle and leave the
				// restore with nothing to do.
				if (options.auto) return finish(false, {outcome: "skipped", stage: "display-currentness", reason: "already_translated"});
				plugin.ensureReceivedDisplayRuntime().suppress(message.id);
				plugin.restoreReceivedDisplayMessage(message.id).then(_ => {
					plugin.ensureReceivedDisplayRuntime().clearPreview(message.id);
					finish(false);
				}, _ => finish(false, {outcome: "failed", stage: "display-currentness", reason: "restore_failed"}));
			}
			else {
				if (options.auto && !plugin.isTranslationEnabled(channelId)) return finish(false, {outcome: "cancelled", stage: "precheck", reason: "translation_disabled"});
				const originalContentData = options.originalContentData || plugin.extractOriginalContentData(message, {ignoreReferencedPreview: isManualTranslation});
				if (!plugin.hasTranslatableMessageContent(originalContentData)) {if (typeof plugin.observeReceivedBodyTranslationPlan == "function") plugin.observeReceivedBodyTranslationPlan(originalContentData && originalContentData.content || "", {lane: options.auto ? "auto-single" : "manual", channelId, legacyHardSkip: null, legacyEligibility: "no_content"}); if (typeof plugin.observeTranslationDocumentPlan == "function") plugin.observeTranslationDocumentPlan(originalContentData, {lane: options.auto ? "auto-single" : "manual", direction: "received", channelId}); return finish(false, {outcome: "skipped", stage: "precheck", reason: "no_content"});}
				const legacyHardSkip = plugin.shouldSkipReceivedTranslationBeforeRequest(originalContentData, channelId);
				if (typeof plugin.observeReceivedBodyTranslationPlan == "function") plugin.observeReceivedBodyTranslationPlan(originalContentData.content || "", {lane: options.auto ? "auto-single" : "manual", channelId, legacyHardSkip, legacyEligibility: legacyHardSkip ? "filtered" : options.auto ? "eligible" : "not-applicable"}); if (typeof plugin.observeTranslationDocumentPlan == "function") plugin.observeTranslationDocumentPlan(originalContentData, {lane: options.auto ? "auto-single" : "manual", direction: "received", channelId});
				if (legacyHardSkip) {
					const skipReason = plugin.getReceivedAutoTranslateSkipReason(originalContentData, channelId) || "same_language";
					const diagnosticText = plugin.buildTranslationRequestText(originalContentData), [, diagnosticSegments] = plugin.removeExceptions(diagnosticText, messageTypes.RECEIVED), protection = plugin.getProtectionRuleSummary(diagnosticSegments);
					plugin.recordTranslationTerminalStage(terminalRouteId, "protection", "rules_applied", Object.assign({eligibility: "filtered", sourceFilterReason: skipReason}, protection));
					const skipSignature = plugin.createReceivedTranslationSignature(message, channelId, originalContentData);
					plugin.persistReceivedSkipDecision(message.id, skipSignature, skipReason, plugin.buildTranslationRequestText(originalContentData));
					plugin.updateTranslationTerminalRoute(terminalRouteId, {cacheWrite: "skip"});
					if (options.auto) {
						plugin.commitReceivedDisplayResult(plugin.createReceivedDisplayCommitResult(message, channelId, {
							sourceSignature: skipSignature,
							requestIdentity: liveRequest ? String(liveRequest.id) : null,
							status: "skipped",
							reason: skipReason
						}), {refresh: false}).then(_ => finish(false, {outcome: "skipped", stage: "precheck", reason: skipReason}), _ => finish(false, {outcome: "failed", stage: "display-currentness", reason: "commit_failed"}));
						return;
					}
					return finish(false, {outcome: "skipped", stage: "precheck", reason: skipReason});
				}
				// Auto needs its signature before live-request admission. A manual cache hit
				// already receives the cache owner's independently validated signature.
				let signature = options.auto ? plugin.createReceivedTranslationSignature(message, channelId, originalContentData) : null;
				if (options.auto && !liveRequest) liveRequest = plugin.createLiveTranslationRequest(message, channelId, originalContentData, signature);
				if (options.auto && !plugin.isLiveTranslationRequestCurrent(liveRequest, message)) return finish(false, {outcome: "stale", stage: "display-currentness", reason: "stale_before_request"});
				const cachedTranslation = plugin.getCachedReceivedTranslation(message, channelId, originalContentData);
				if (cachedTranslation) {
					plugin.recordTranslationTerminalStage(terminalRouteId, "cache", "translation_hit", {cacheRead: "translation-hit"});
					const storedCachedTranslation = Object.assign({}, cachedTranslation, {
						channelId,
						auto: !!options.auto,
						manual: isManualTranslation,
						independentOfTextAreaSwitch: !!options.independentOfTextAreaSwitch
					});
					if (options.auto) {
						plugin.refreshTranslationDisplay(storedCachedTranslation);
						plugin.commitReceivedDisplayResult(plugin.createReceivedDisplayCommitResult(message, channelId, {
							sourceSignature: storedCachedTranslation.signature != null ? String(storedCachedTranslation.signature) : signature,
							requestIdentity: liveRequest ? String(liveRequest.id) : null,
							status: "translated",
							translation: storedCachedTranslation
						}), {refresh: false}).then(outcome => {
							if (outcome && outcome.deferredIds && outcome.deferredIds.length) plugin.scheduleReceivedDisplayFlush(channelId, message.id, null, null, "manual");
							finish(true, {outcome: "translated", stage: "cache", reason: "translation_hit", displayCommit: "cache-applied"});
						}, _ => finish(false, {outcome: "failed", stage: "display-currentness", reason: "cache_commit_failed"}));
						return;
					}
					// The store commit inside applyStoredTranslationToMessage is the manual
					// display transaction; the per-message flush paints and acknowledges it
					// through the same chain the automatic path uses (5a).
					plugin.applyStoredTranslationToMessage(message, storedCachedTranslation, originalContentData);
					plugin.scheduleReceivedDisplayFlush(channelId, message.id, null, null, "manual");
					return finish(true, {outcome: "translated", stage: "cache", reason: "translation_hit", displayCommit: "cache-applied"});
				}
				plugin.recordTranslationTerminalStage(terminalRouteId, "cache", "miss", {cacheRead: "miss"});
				if (!options.auto) signature = plugin.createReceivedTranslationSignature(message, channelId, originalContentData);
				const allTextsToTranslate = plugin.buildTranslationRequestText(originalContentData);
				message.embeds.forEach(embed => embed.message_id = message.id);
				const manualSourceIsCurrent = isManualTranslation ? createManualSourceGuard(plugin, message, channelId, signature) : null;
				if (isManualTranslation) manualRequest = plugin.ensureSentTranslationStore().beginManualRequest(manualRequestKey);
				if (canaryProviderSupported(plugin, channelId) && isExplicitReceivedBodySingle(message, originalContentData, options)) canaryLease = canary.claim({channelId, messageId: message.id, signal: liveRequest && liveRequest.signal, isCurrent: () => options.auto ? plugin.isLiveTranslationRequestCurrent(liveRequest, message) : plugin.ensureSentTranslationStore().isManualRequestCurrent(manualRequestKey, manualRequest) && manualSourceIsCurrent()});
				if (canaryLease && canaryLease.cacheEnabled) canaryCache = {messageId: message.id, channelId, source: String(originalContentData.content || ""), identity: null, store: null, hit: false};
				const commitDCache = (translation, outcome = null) => {
					if (!canaryCache || !canaryCache.identity || translation.wireFamily !== "whole-marker") return true;
					if (!canaryLease.isCurrent() || !canaryCache.isCurrent()) return false;
					const id = String(message.id), view = plugin.getReceivedDisplayRuntimeView(id);
					if (outcome && ([].concat(outcome.rejectedIds || [], outcome.staleIds || []).map(String).includes(id) || ![].concat(outcome.deferredIds || [], outcome.confirmedIds || [], outcome.committedIds || []).map(String).includes(id))) return false;
					if (!view || !view.translated || String(view.channelId) !== String(channelId) || view.origin !== (options.auto ? "automatic" : "manual") || !view.translation || view.translation.signature !== signature || view.translation.translatedContent !== translation.translatedContent) return false;
					if (!canaryCache.hit && canaryCache.store.persistTranslation(canaryCache.identity, Object.assign({}, translation, {originalContent: canaryCache.source, cacheWrite: true}))) plugin.updateTranslationTerminalRoute(terminalRouteId, {cacheWrite: "translation"});
					return true;
				};
				try {
					plugin.translateText(allTextsToTranslate, messageTypes.RECEIVED, (translation, input, output, meta = {}) => {
						try {
							if (canaryLease && !canaryLease.isCurrent()) return finish(false, {outcome: "stale", stage: "display-currentness", reason: "canary_revoked"});
							if (canaryCache && canaryCache.identity && !canaryCache.isCurrent()) return finish(false, {outcome: "stale", stage: "display-currentness", reason: "cache_identity_changed"});
							if (options.auto && !plugin.isLiveTranslationRequestCurrent(liveRequest, message)) return finish(false, {outcome: "stale", stage: "display-currentness", reason: "stale_after_provider"});
							if (isManualTranslation && !plugin.ensureSentTranslationStore().isManualRequestCurrent(manualRequestKey, manualRequest)) return finish(false, {outcome: "cancelled", stage: "display-currentness", reason: "manual_superseded"});
							if (isManualTranslation && !manualSourceIsCurrent()) return finish(false, {outcome: "stale", stage: "display-currentness", reason: "stale_after_provider"});
							if (translation) {
								let strings = translation.split(/\n{0,1}__________________ __________________ __________________\n{0,1}/);
								let oldContent = (originalContentData.content || "").trim();
								let translatedContent = (strings.shift() || "").trim();
								let content = plugin.buildReceivedDisplayContent(translatedContent, oldContent);
								const embeds = parseStoredEmbedTranslations({messageEmbeds: message.embeds, originalEmbeds: originalContentData.embeds, segments: strings});
								const storedTranslation = {
									signature,
									channelId,
									auto: !!options.auto,
									manual: isManualTranslation,
									independentOfTextAreaSwitch: !!options.independentOfTextAreaSwitch,
									content: content,
									translatedContent,
									originalContent: oldContent,
									embeds: embeds,
									input,
									output
								};
								if (meta && meta.keptSegmentCount > 0) {storedTranslation.keptSegmentCount = meta.keptSegmentCount; storedTranslation.keptReasons = Object.assign({}, meta.keptReasons || {});}
								if (meta.wholeMarkerCanary) {storedTranslation.wholeMarkerCanary = true; storedTranslation.cacheWrite = false; storedTranslation.wireFamily = meta.wireFamily;}
								if (meta && meta.semanticRevision && !meta.wholeMarkerCanary) {storedTranslation.semanticRevision = meta.semanticRevision; storedTranslation.semanticWorkloadKey = meta.semanticWorkloadKey || null; storedTranslation.plannerVersion = meta.plannerVersion || null; storedTranslation.planHash = meta.planHash || null; storedTranslation.validatorVersion = meta.validatorVersion || null; storedTranslation.outputSchemaVersion = meta.outputSchemaVersion || null;}
								const semanticValidated = !!(meta && (meta.semanticRevision || meta.wholeMarkerCanary)), compatibilityFallback = !!(meta && (meta.legacyFallback || meta.cacheWrite === false));
								// A semantic result has already passed target-language and similarity checks per
								// natural-language segment. Re-running the legacy whole-message guard rejects
								// mixed documents whose original target-language spans were intentionally replayed.
								const rejectReason = semanticValidated ? null : plugin.getAutoTranslatedResultRejectReason(storedTranslation, channelId);
								const tooSimilar = semanticValidated ? false : plugin.isTranslationResultTooSimilar(storedTranslation);
								if ((options.auto && rejectReason) || tooSimilar) {
									plugin.recordTranslationTerminalStage(terminalRouteId, "similarity", rejectReason || "too_similar", {cacheWrite: "skip"});
									if (!compatibilityFallback) plugin.persistReceivedSkipDecision(message.id, signature, rejectReason || "too_similar", storedTranslation.originalContent || storedTranslation.translatedContent);
									if (options.auto) {
										plugin.commitReceivedDisplayResult(plugin.createReceivedDisplayCommitResult(message, channelId, {
											sourceSignature: signature,
											requestIdentity: liveRequest ? String(liveRequest.id) : null,
											status: "skipped",
											reason: rejectReason || "too_similar"
										}), {refresh: false}).then(_ => finish(false, {outcome: "skipped", stage: "similarity", reason: rejectReason || "too_similar"}), _ => finish(false, {outcome: "failed", stage: "display-currentness", reason: "commit_failed"}));
										return;
									}
									return finish(false, {outcome: "skipped", stage: "similarity", reason: rejectReason || "too_similar"});
								}
								if (options.auto) {
									if (!compatibilityFallback) {plugin.persistTranslationCacheEntry(message.id, signature, storedTranslation); plugin.updateTranslationTerminalRoute(terminalRouteId, {cacheWrite: "translation"});}
									plugin.commitReceivedDisplayResult(plugin.createReceivedDisplayCommitResult(message, channelId, {
										sourceSignature: signature,
										requestIdentity: liveRequest ? String(liveRequest.id) : null,
										status: "translated",
										translation: storedTranslation
									}), {refresh: false}).then(outcome => {
										if (!commitDCache(storedTranslation, outcome)) return finish(false, {outcome: "stale", stage: "display-currentness", reason: "cache_commit_rejected"});
										if (outcome && outcome.deferredIds && outcome.deferredIds.length) plugin.scheduleReceivedDisplayFlush(channelId, message.id, null, null, "manual");
									finish(true, {outcome: "translated", stage: "display-currentness", reason: "committed", displayCommit: "applied"});
									}, _ => finish(false, {outcome: "failed", stage: "display-currentness", reason: "commit_failed"}));
									return;
								}
								plugin.applyStoredTranslationToMessage(message, storedTranslation, originalContentData);
								if (!commitDCache(storedTranslation)) return finish(false, {outcome: "stale", stage: "display-currentness", reason: "cache_commit_rejected"});
								plugin.scheduleReceivedDisplayFlush(channelId, message.id, null, null, "manual");
								if (!compatibilityFallback) {plugin.persistTranslationCacheEntry(message.id, signature, storedTranslation); plugin.updateTranslationTerminalRoute(terminalRouteId, {cacheWrite: "translation"});}
								return finish(true, {outcome: "translated", stage: "display-currentness", reason: "manual_applied", displayCommit: "applied"});
							}
							else if (meta && meta.skipped && options.auto) {
								const skipReason = meta.reason || "ai_skip_signal";
								if (!meta.legacyFallback && meta.cacheWrite !== false) plugin.persistReceivedSkipDecision(message.id, signature, skipReason, allTextsToTranslate);
								plugin.commitReceivedDisplayResult(plugin.createReceivedDisplayCommitResult(message, channelId, {
									sourceSignature: signature,
									requestIdentity: liveRequest ? String(liveRequest.id) : null,
									status: "skipped",
									reason: skipReason
								}), {refresh: false}).then(_ => finish(true, {outcome: "skipped", stage: "provider", reason: skipReason}), _ => finish(true, {outcome: "skipped", stage: "provider", reason: skipReason}));
								return;
							}
							else if (options.auto && !translation && !(meta && meta.skipped)) {
								plugin.commitReceivedDisplayResult(plugin.createReceivedDisplayCommitResult(message, channelId, {
									sourceSignature: signature,
									requestIdentity: liveRequest ? String(liveRequest.id) : null,
									status: "failed",
									reason: "provider_failed"
								}), {refresh: false}).then(_ => finish(false, {outcome: "failed", stage: meta.reason === "placeholder_missing" ? "placeholder" : "provider", reason: meta.reason || "empty"}), _ => finish(false, {outcome: "failed", stage: "display-currentness", reason: "commit_failed"}));
								return;
							}
							finish(!!translation || !!(meta && meta.skipped), {outcome: translation ? "translated" : meta && meta.skipped ? "skipped" : "failed", stage: translation ? "display-currentness" : meta && meta.reason === "placeholder_missing" ? "placeholder" : meta && meta.wrongTargetLanguage ? "target-language" : "provider", reason: translation ? "completed" : meta && meta.reason || "empty"});
						}
						catch (error) {finish(false);}
					}, null, {
						showToast: !options.silent,
						showFailureToast: !options.silent,
						trackBusy: options.trackBusy !== false,
						auto: !!options.auto,
						forcePlainTranslation: !!options.forcePlainTranslation,
						liveSingleSource: options.liveSingleSource,
						channelId,
						latencyToken: options.latencyToken || null,
						latencyKind: options.latencyKind || (options.auto ? "live" : "manual"),
						queueWaitMs: options.queueWaitMs,
						messageCount: Math.max(1, Number(options.messageCount) || 1),
						terminalRouteId,
						terminalLane: options.auto ? "auto-single" : "manual",
						terminalEntry: options.auto ? "received-auto" : "manual-click",
						logicalRequestId: liveRequest ? String(liveRequest.id) : null,
						[canaryToken]: canaryLease,
						[canaryCacheToken]: canaryCache,
						signal: canaryLease ? canaryLease.signal : liveRequest && liveRequest.signal || null,
						isCurrent: canaryLease ? canaryLease.isCurrent : liveRequest ? () => plugin.isLiveTranslationRequestCurrent(liveRequest, message) : null
					});
				}
				catch (error) {finish(false);}
			}
		});
	}

	function translateText(text, place, callback, forcedOutputLanguage = null, options = {}) {
		const plugin = getPlugin();
		const ownsTerminalRoute = !options.terminalRouteId;
		const terminalLane = options.terminalLane || (place == messageTypes.SENT ? "sent" : options.historicalTraceContext ? "item-repair" : "reply");
		let terminalRouteId = options.terminalRouteId || plugin.beginTranslationTerminalRoute({lane: terminalLane, entry: options.terminalEntry || (place == messageTypes.SENT ? "sent-submit" : options.historicalTraceContext ? "historical-repair" : "reply-preview"), eligibility: "not-applicable", shape: "text", validatorFamily: place == messageTypes.SENT ? "sent" : "single-text", requestFamily: "single-text"});
		const showToast = options.showToast !== false;
		const showFailureToast = options.showFailureToast !== false;
		const trackBusy = options.trackBusy !== false;
		let logicalAbortHandler = null;
		let requestContext = null;
		let providerValidationReason = null;
		// Kept segments of the accepted semantic outcome (P3 soft keep), so the stored translation can say so.
		let semanticKept = null, semanticUnchanged = false;
		let semanticRequest = null, legacyFallbackReason = null, canaryMeta = null;
		const canaryLease = options[canaryToken] || null;
		if (canaryLease) canaryMeta = {wholeMarkerCanary: true, cacheWrite: false, wireFamily: "none", semanticRevision: null, semanticWorkloadKey: null, plannerVersion: null, planHash: null, validatorVersion: null, outputSchemaVersion: null};
		let toast = null, toastInterval, finished = false, retriedAfterSkip = false, skipSafetyNetHandler = null, finishTranslation = translation => {
			// AI-decision safety net: when AI decision mode returns a skip signal OR a wrong-target
			// result (e.g. it echoes all-caps text unchanged, treating it as an acronym) for a
			// received auto message, verify the original is actually foreign before honoring the
			// drop. A real foreign message gets a forced plain re-translation (no skip option) so it
			// is never dropped to an AI misjudgement. Runs before the cleanup guards so the
			// translating state stays live.
			const isSkip = semanticUnchanged || plugin.isSkipTranslationSignal(translation);
			if (!isSkip && translation && !semanticRequest) translation = plugin.addExceptions(translation, protectedSegments);
			const wrongTarget = !semanticRequest && !isSkip && !!translation && !plugin.isTranslationLikelyInTargetLanguage(translation, output && output.id);
			if (!semanticUnchanged && !finished && !legacyFallbackReason && !retriedAfterSkip && skipSafetyNetHandler && (isSkip || wrongTarget) && options.auto && place == messageTypes.RECEIVED && plugin.useLocalLanguagePrecheck() && plugin.shouldUseAiAutoTranslateDecision(channelId)) {
				retriedAfterSkip = true;
				skipSafetyNetHandler(translation);
				return;
			}
			if (trackBusy) plugin.ensureLiveTranslationQueue().setBusyTranslating(false);
			if (toast) toast.close();
			BDFDB.TimeUtils.clear(toastInterval);

			if (finished) return;
			finished = true;
			if (requestContext && requestContext.signal && logicalAbortHandler) {
				try {requestContext.signal.removeEventListener("abort", logicalAbortHandler);}
				catch (error) {}
				logicalAbortHandler = null;
			}
			const complete = (...args) => {
				if (ownsTerminalRoute && terminalRouteId) {const meta = args[3] || {}, translated = args[0], replyAllProtected = !translated && !meta.skipped && !translate && terminalLane === "reply" && !(requestContext && requestContext.signal && requestContext.signal.aborted); plugin.finishTranslationTerminalRoute(terminalRouteId, {outcome: translated ? "translated" : meta.skipped || replyAllProtected ? "skipped" : requestContext && requestContext.signal && requestContext.signal.aborted ? "cancelled" : "failed", stage: meta.wrongTargetLanguage ? "target-language" : meta.skipped && meta.reason === "too_similar" ? "similarity" : meta.skipped ? "provider" : translated ? "provider" : translate ? "provider" : "protection", reason: meta.reason || (meta.wrongTargetLanguage ? "wrong_language" : translated ? "translated" : translate ? "empty" : "all_protected")}); terminalRouteId = null;}
				callback(...args);
				if (trackBusy) plugin.processAutoTranslationQueue();
			};
			const fallbackMeta = Object.assign({}, legacyFallbackReason ? {legacyFallback: legacyFallbackReason} : {}, canaryMeta || {});
			if (latencyToken) {const observationOutcome = translation && !wrongTarget && !isSkip ? "translated" : isSkip ? "skipped" : requestContext && requestContext.signal && requestContext.signal.aborted ? "cancelled" : "failed", observationStage = wrongTarget ? "target-language" : providerValidationReason === "placeholder-mismatch" || providerValidationReason === "placeholder_missing" ? "placeholder" : providerValidationReason === "wrong-language" || providerValidationReason === "wrong_language" ? "target-language" : providerValidationReason === "too-similar" || providerValidationReason === "too_similar" ? "similarity" : legacyFallbackReason ? "repair" : "provider"; try {plugin.ensureProviderClient().recordAttemptOutcome({token: latencyToken, outcome: observationOutcome, stage: observationStage, reason: observationOutcome === "translated" ? null : providerValidationReason || (isSkip ? "unknown" : "empty")});} catch (error) {}}
			if (isSkip) return complete("", input, output, Object.assign({skipped: true, reason: semanticUnchanged ? "ai_skip_signal" : undefined}, fallbackMeta));
			if (translation && wrongTarget) return complete("", input, output, Object.assign({failed: true, wrongTargetLanguage: true, reason: providerValidationReason || "wrong_language"}, fallbackMeta));
			if (!semanticRequest && translation == text) return complete("", input, output, Object.assign({skipped: true, reason: plugin.isSameLanguageOrVariant(input && input.id, output && output.id) ? "same_language" : "too_similar"}, fallbackMeta));
			complete(translation, input, output, Object.assign({failed: !translation, reason: !translation ? providerValidationReason : null, semanticRevision: semanticRequest && semanticRequest.semanticRevision || null, semanticWorkloadKey: semanticRequest && semanticRequest.workload && semanticRequest.workload.key || null, plannerVersion: semanticRequest && semanticRequest.plan && semanticRequest.plan.plannerVersion || null, planHash: semanticRequest && plugin.getAtomicSemanticPlanHash(semanticRequest) || null, validatorVersion: semanticRequest && semanticRequest.workload && semanticRequest.workload.fields.validatorVersion || null, outputSchemaVersion: semanticRequest && semanticRequest.workload && semanticRequest.workload.fields.outputSchemaVersion || null, keptSegmentCount: semanticKept ? semanticKept.count : 0, keptReasons: semanticKept ? semanticKept.reasons : null}, fallbackMeta));
		};
		// Bottom-layer protection is shared by AI and traditional engines: only protected placeholders are sent for mentions/emoji/links/code.
		let [newText, protectedSegments, translate] = plugin.removeExceptions(text.trim(), place);
		const legacySnapshot = Object.freeze({text: newText, protectedSegments, translate});
		const observationSource = String(text || "");
		const configuredTerms = typeof plugin.getProtectedTermsList == "function" && (typeof plugin.shouldProtectConfiguredTermsForPlace != "function" || plugin.shouldProtectConfiguredTermsForPlace(place)) ? plugin.getProtectedTermsList() : [];
		const wrapperRules = typeof plugin.getProtectedWrapperRules == "function" && (typeof plugin.shouldProtectWrappedTextForPlace != "function" || plugin.shouldProtectWrappedTextForPlace(place)) ? plugin.getProtectedWrapperRules() : [];
		const createObservationProbe = (request = null, legacyText = newText, legacySegments = protectedSegments) => createWireObservationProbe({source: observationSource, request, wireFamily: request ? request.adapter : "legacy-single", wireVersion: request ? request.wireVersion || request.semanticRevision : "legacy", wire: request ? request.wire : legacyText, translateSegments: request ? null : [legacyText], itemCount: 1, protectedSegments: request ? plugin.getAtomicSemanticLocalState(request).protectedSegments : legacySegments, configuredTerms, wrapperRules});
		const legacyObservationProbe = createObservationProbe(null, legacySnapshot.text, legacySnapshot.protectedSegments);
		const protection = plugin.getProtectionRuleSummary(protectedSegments);
		plugin.recordTranslationTerminalStage(terminalRouteId, "protection", translate ? "rules_applied" : "all_protected", protection);
		let channelId = options.channelId || BDFDB.LibraryStores.SelectedChannelStore.getChannelId();
		const compatibilityBudget = options.compatibilityBudget || createProviderCompatibilityBudget();
		const currentnessCheck = typeof options.isCurrent == "function" ? options.isCurrent : null;
		const logicalSignal = options.signal || null;
		const isLogicalRequestCurrent = () => {
			if (logicalSignal && logicalSignal.aborted) return false;
			if (!currentnessCheck) return true;
			try {return !!currentnessCheck();}
			catch (error) {return false;}
		};
		requestContext = Object.freeze({
			...(canaryLease ? {wholeMarkerCanary: true} : {}),
			logicalRequestId: options.logicalRequestId == null ? null : String(options.logicalRequestId),
			signal: logicalSignal,
			isCurrent: isLogicalRequestCurrent,
			compatibilityBudget
		});
		const primaryEngineKey = plugin.getEffectivePrimaryEngine(channelId);
		const backupEngineKey = plugin.getEffectiveBackupEngine(channelId);
		let latencyToken = options.latencyToken || null;
		const latencyKind = options.latencyKind || (options.auto ? "live" : "manual");
		const latencyMessageCount = Math.max(1, Number(options.messageCount) || 1);
		const observationLane = options.terminalLane || (place == messageTypes.SENT ? "sent" : options.auto ? "auto-single" : options.historicalTraceContext ? "item-repair" : "reply");
		const engineFamilyFor = engineKey => {try {const auth = plugin.ensureSettingsStore().getAuthKeys()[engineKey] || {}; if (["ollama_native", "gemini_native", "anthropic_messages"].includes(String(auth.interfaceFormat || ""))) return "native";} catch (error) {} if (["gemininative", "anthropicnative"].includes(String(engineKey))) return "native"; if (isCustomEngineKey(engineKey)) return "custom"; return plugin.supportsAiAutoTranslateDecisionEngine(engineKey) ? "ai" : "classic";};
		const createTimingContext = (engineKey, role, observationProbe = null) => {
			if (!engineKey || latencyKind !== "historical" && !plugin.supportsAiAutoTranslateDecisionEngine(engineKey) && !isCustomEngineKey(engineKey)) return null;
			if (!latencyToken) latencyToken = plugin.ensureProviderClient().beginLatencyRequest({kind: latencyKind, lane: observationLane, queueWaitMs: options.queueWaitMs, messageCount: latencyMessageCount, inputChars: String(newText || "").length});
			if (!latencyToken) return null;
			const observationRole = role === "repair" ? "repair" : role === "fallback" ? "fallback" : role === "backup" ? "backup" : "primary";
			const base = {token: latencyToken, role, observationRole, engineKey, engineFamily: engineFamilyFor(engineKey), lane: observationLane, messageCount: latencyMessageCount, requestContext, wireObservationProbe: observationProbe || legacyObservationProbe, diagnosticRequestObserver: event => plugin.updateTranslationTerminalRoute(terminalRouteId, {requestBodyBytes: event && event.bodyBytes, requestBodyIdentity: event && event.bodyIdentity}), diagnosticStageObserver: event => {const reason = event && (event.errorClass || event.status) || "unknown"; plugin.recordTranslationTerminalStage(terminalRouteId, "provider", reason); if (["timeout", "abort", "network"].includes(reason)) providerValidationReason = reason;}};
			if (options.historicalTraceContext && typeof options.historicalTraceContext.createTimingContext == "function") {
				try {return options.historicalTraceContext.createTimingContext(base) || base;}
				catch (error) {}
			}
			return base;
		};
		const resolveLanguage = languageId => {
			const dynamicDiscordLanguage = String(languageId || "").toLowerCase() == "$discord";
			const resolvedId = dynamicDiscordLanguage ? plugin.normalizeLanguageId(languageId) : languageId;
			const language = Object.assign({}, plugin.ensureSettingsStore().getLanguage(resolvedId) || plugin.ensureSettingsStore().getLanguage(languageId) || {id: resolvedId || languageId, name: resolvedId || languageId});
			if (dynamicDiscordLanguage) {language.id = resolvedId; delete language.special;}
			return language;
		};
		let input = resolveLanguage(plugin.getLanguageChoice(languageTypes.INPUT, place, channelId));
		let output = resolveLanguage(forcedOutputLanguage || plugin.getLanguageChoice(languageTypes.OUTPUT, place, channelId));
		if (place == messageTypes.RECEIVED && !output.special) {
			const candidate = plugin.createAtomicSemanticRevisionContract(String(text || "").trim(), {place, channelId, engineKey: primaryEngineKey, inputLanguageId: input.id || "auto", targetLanguageId: output.id || "zh-CN", fieldPath: options.semanticFieldPath || "body", nameRepair: options.liveSingleSource === "burst-requeue", attempt: 1, maxAttempts: 3});
			if (candidate && candidate.enabled && candidate.segmentOrder.length) {
				const semanticState = plugin.getAtomicSemanticLocalState(candidate), protectionSummary = typeof plugin.getProtectionRuleSummary == "function" ? plugin.getProtectionRuleSummary(semanticState.protectedSegments) : {placeholderOccurrences: Object.keys(semanticState.protectedSegments || {}).length, ruleCounts: {}};
				semanticRequest = candidate;
				newText = candidate.wire;
				protectedSegments = semanticState.protectedSegments;
				translate = true;
				observeCompactWireShadow(plugin, candidate);
				plugin.recordTranslationTerminalStage(terminalRouteId, "protection", "semantic_plan", Object.assign({}, protectionSummary, {replaceRuleCounts: true, validatorFamily: VALIDATOR_FAMILY, requestFamily: candidate.adapter, semanticRevision: candidate.semanticRevision}));
			}
			else if (candidate && candidate.enabled) {const localProbe = createObservationProbe(candidate); latencyToken = latencyToken || plugin.ensureProviderClient().beginLatencyRequest({kind: latencyKind, lane: observationLane, messageCount: latencyMessageCount, inputChars: String(newText || "").length}); if (latencyToken && localProbe && typeof localProbe.local == "function") plugin.ensureProviderClient().recordWireObservationEvent({token: latencyToken, wireObservation: localProbe.local()});}
			else if (candidate && candidate.fallbackReason) {latencyToken = latencyToken || plugin.ensureProviderClient().beginLatencyRequest({kind: latencyKind, lane: observationLane, messageCount: latencyMessageCount, inputChars: String(newText || "").length}); if (latencyToken) plugin.ensureProviderClient().recordSemanticObservation({token: latencyToken, reason: candidate.fallbackReason});}
		}
		logicalAbortHandler = () => finishTranslation("");
		if (requestContext.signal && typeof requestContext.signal.addEventListener == "function") {
			if (requestContext.signal.aborted) return logicalAbortHandler();
			try {requestContext.signal.addEventListener("abort", logicalAbortHandler, {once: true});}
			catch (error) {logicalAbortHandler = null;}
		}
		const finishIfProviderDispatchStale = () => {
			if (requestContext.isCurrent()) return false;
			finishTranslation("");
			return true;
		};
		if (canaryLease && !semanticRequest) {providerValidationReason = "typed-unavailable"; return finishTranslation("");}
		if (translate && input.id != output.id) {
			let specialCase = plugin.checkForSpecialCase(newText, input);
			if (specialCase) {
				input.name = specialCase.name;
				switch (specialCase.id) {
					case "binary": newText = plugin.binary2string(newText); break;
					case "braille": newText = plugin.braille2string(newText); break;
					case "morse": newText = plugin.morse2string(newText); break;
					case "hex": newText = plugin.hex2string(newText); break;
				}
			}
			if (output.special) {
				switch (output.id) {
					case "binary": newText = plugin.string2binary(newText); break;
					case "braille": newText = plugin.string2braille(newText); break;
					case "morse": newText = plugin.string2morse(newText); break;
					case "hex": newText = plugin.string2hex(newText); break;
				}
				finishTranslation(newText);
			}
			else {
				const startTranslating = engine => {
					if (trackBusy) plugin.ensureLiveTranslationQueue().setBusyTranslating(true);
					if (toast) toast.close();
					BDFDB.TimeUtils.clear(toastInterval);
					if (showToast) toast = BDFDB.NotificationUtils.toast(`${plugin.labels.toast_translating} (${translationEngines[engine].name}) - ${BDFDB.LanguageUtils.LibraryStrings.please_wait}`, {
						timeout: 0,
						ellipsis: true,
						position: "center",
						onClose: _ => BDFDB.TimeUtils.clear(toastInterval)
					});
					// The watchdog floor must cover requestWithTimeout's 30s window (60 ticks
					// at 500ms); a shorter floor discards paid responses arriving after it.
					const timeoutTicks = Math.max(64, Math.min(120, Math.ceil((newText || "").length / 25)));
					toastInterval = BDFDB.TimeUtils.interval((_, count) => {
						if (count < timeoutTicks) return;
						finishTranslation("");
						if (showFailureToast) BDFDB.NotificationUtils.toast(`${plugin.labels.toast_translating_failed} (${translationEngines[engine].name}) - ${plugin.labels.toast_translating_tryanother}`, {
							type: "danger",
							position: "center"
						});
					}, 500);
				};
				const aiPrompt = plugin.getAiAutoTranslatePrompt({input, output});
				const normalizeProviderTranslation = translation => {
					if (semanticRequest) return translation;
					if (!translation || plugin.isSkipTranslationSignal(translation)) return translation;
					if (plugin.hasAllProtectionPlaceholders(translation, protectedSegments)) return translation;
					providerValidationReason = "placeholder_missing";
					plugin.recordTranslationTerminalStage(terminalRouteId, "placeholder", "placeholder_missing");
					return "";
				};
				const semanticProviderData = (engineKey, request, role, autoDecision = false) => ({input, output, text: request.wire, specialCase: null, engine: translationEngines[engineKey], autoDecision, decisionPrompt: LEGACY_DECISION_RULES, preferencePrompt: aiPrompt, timingContext: createTimingContext(engineKey, role, createObservationProbe(request)), requestContext, semanticRequest: {adapter: request.adapter, semanticRevision: request.semanticRevision, targetLanguageId: request.targetLanguageId, systemPrompt: request.systemPrompt, wire: request.wire, segmentOrder: request.segmentOrder}});
				let legacyFallbackStarted = false;
				const recordSemanticFailure = outcome => {providerValidationReason = outcome && outcome.reason || "unknown"; if (latencyToken) {plugin.ensureProviderClient().recordSemanticObservation({token: latencyToken, reason: providerValidationReason}); plugin.ensureProviderClient().recordAttemptOutcome({token: latencyToken, outcome: "failed", stage: providerValidationReason === "wrong-language" ? "target-language" : providerValidationReason === "too-similar" ? "similarity" : providerValidationReason === "placeholder-mismatch" ? "placeholder" : "parse", reason: providerValidationReason});} plugin.recordTranslationTerminalStage(terminalRouteId, providerValidationReason === "wrong-language" ? "target-language" : providerValidationReason === "too-similar" ? "similarity" : providerValidationReason === "placeholder-mismatch" ? "placeholder" : "parse", providerValidationReason, {validatorFamily: VALIDATOR_FAMILY, semanticRevision: semanticRequest && semanticRequest.semanticRevision});};
				const dispatchLegacyCompatibilityFallback = (engineKey, done, reason = "root-malformed") => {
					if (legacyFallbackStarted || finishIfProviderDispatchStale()) return done("");
					legacyFallbackStarted = true;
					legacyFallbackReason = reason;
					semanticRequest = null;
					newText = legacySnapshot.text;
					protectedSegments = legacySnapshot.protectedSegments;
					translate = legacySnapshot.translate;
					providerValidationReason = "legacy_fallback_failed";
					if (latencyToken) plugin.ensureProviderClient().recordSemanticObservation({token: latencyToken, fallbackKind: reason});
					startTranslating(engineKey);
					plugin.recordTranslationTerminalStage(terminalRouteId, "repair", "legacy_compatibility_fallback", {providerDispatch: true, providerRole: "fallback", requestFamily: "legacy-single-fallback", engineFamily: isCustomEngineKey(engineKey) ? "custom" : plugin.supportsAiAutoTranslateDecisionEngine(engineKey) ? "ai" : "classic", decisionApplied: false, promptFamily: "single-manual"});
					const data = {input, output, text: newText, specialCase: null, engine: translationEngines[engineKey], autoDecision: false, decisionPrompt: LEGACY_DECISION_RULES, preferencePrompt: aiPrompt, timingContext: createTimingContext(engineKey, "fallback", legacyObservationProbe), requestContext};
					plugin[translationEngines[engineKey].funcName].apply(plugin, [data, fallbackTranslation => {
						if (finishIfProviderDispatchStale()) return;
						const normalized = normalizeProviderTranslation(fallbackTranslation);
						if (!normalized || plugin.isSkipTranslationSignal(normalized)) {providerValidationReason = "legacy_fallback_failed"; plugin.recordTranslationTerminalStage(terminalRouteId, "repair", "legacy_fallback_failed", {requestFamily: "legacy-single-fallback"});}
						done(normalized);
					}]);
				};
				let handleSemanticOutcome;
				const commitSemanticOutcome = outcome => {semanticUnchanged = outcome.unchanged === true && place == messageTypes.RECEIVED; semanticKept = outcome.keptCount > 0 ? {count: outcome.keptCount, reasons: Object.assign({}, outcome.keptReasons || {})} : null; if (terminalRouteId && outcome.keptCount > 0) plugin.updateTranslationTerminalRoute(terminalRouteId, {keptSegmentCount: outcome.keptCount, keptReasons: outcome.keptReasons, validatorFamily: VALIDATOR_FAMILY}); return outcome.translation;};
				const dispatchSemanticRepairRound = (engineKey, requests, seedValid, done) => {
					let index = 0, accumulated = Object.assign({}, seedValid || {}), lastOutcome = null, lastRequest = null;
					const dispatchNext = () => {
						if (finishIfProviderDispatchStale()) return;
						if (index >= requests.length) return lastOutcome ? handleSemanticOutcome(engineKey, lastRequest, lastOutcome, done, true) : done("");
						const next = requests[index++]; lastRequest = next;
						plugin.recordTranslationTerminalStage(terminalRouteId, "repair", "precise_segment_repair", {providerDispatch: true, providerRole: "repair", requestFamily: next.adapter, semanticRevision: next.semanticRevision});
						plugin[translationEngines[engineKey].funcName].apply(plugin, [semanticProviderData(engineKey, next, "repair", false), repairTranslation => {
							if (finishIfProviderDispatchStale()) return;
							lastOutcome = plugin.validateAtomicSemanticResponse(next, repairTranslation, {priorValid: accumulated, likelyTarget: value => plugin.isTranslationLikelyInTargetLanguage(value, output && output.id), similarity: (source, value) => plugin.getTextSimilarityScore(source, value), maxSimilarity: 0.94});
							accumulated = Object.assign({}, lastOutcome.valid || accumulated);
							if (lastOutcome.ok) return done(commitSemanticOutcome(lastOutcome));
							recordSemanticFailure(lastOutcome);
							dispatchNext();
						}]);
					};
					dispatchNext();
				};
				handleSemanticOutcome = (engineKey, request, outcome, done, alreadyRecorded = false) => {
					if (outcome.ok) return done(commitSemanticOutcome(outcome));
					if (!alreadyRecorded) recordSemanticFailure(outcome);
					const rootSchemaIncompatible = request.attempt === 1 && ["malformed", "unknown-id"].includes(outcome.reason) && Object.keys(outcome.valid || {}).length === 0;
					if (rootSchemaIncompatible) return dispatchLegacyCompatibilityFallback(engineKey, done, outcome.reason === "malformed" ? "root-malformed" : "root-schema-incompatible");
					const repair = plugin.planAtomicSemanticRepair(request, outcome, {parentSettled: true, maxItems: 10, maxChars: 12000});
					if (!repair.dispatchable || !repair.requests.length) return done("");
					dispatchSemanticRepairRound(engineKey, repair.requests, outcome.valid, done);
				};
				const handleSemanticResponse = (engineKey, request, raw, priorValid, done) => {
					if (finishIfProviderDispatchStale()) return;
					const outcome = plugin.validateAtomicSemanticResponse(request, raw, {priorValid, likelyTarget: value => plugin.isTranslationLikelyInTargetLanguage(value, output && output.id), similarity: (source, value) => plugin.getTextSimilarityScore(source, value), maxSimilarity: 0.94});
					handleSemanticOutcome(engineKey, request, outcome, done);
				};
				const dispatchEngine = (useAutoDecision, requestRole = "primary") => {
					const aiDecisionFor = engineKey => !!useAutoDecision && plugin.supportsAiAutoTranslateDecisionEngine(engineKey);
					const recordDispatch = engineKey => plugin.recordTranslationTerminalStage(terminalRouteId, "provider", "dispatch", {providerRole: options.terminalProviderRole || requestRole, requestFamily: semanticRequest ? semanticRequest.adapter : "single-text", engineFamily: isCustomEngineKey(engineKey) ? "custom" : plugin.supportsAiAutoTranslateDecisionEngine(engineKey) ? "ai" : "classic", decisionApplied: semanticRequest ? false : aiDecisionFor(engineKey), promptFamily: semanticRequest ? "segment-json" : aiDecisionFor(engineKey) ? "single-auto-decision" : "single-manual", semanticRevision: semanticRequest && semanticRequest.semanticRevision});
					if (finishIfProviderDispatchStale()) return;
					if (plugin.validTranslator(primaryEngineKey, input, output, specialCase)) {
						if (finishIfProviderDispatchStale()) return;
						startTranslating(primaryEngineKey);
						if (finishIfProviderDispatchStale()) return;
						recordDispatch(primaryEngineKey);
						const primaryData = semanticRequest ? semanticProviderData(primaryEngineKey, semanticRequest, requestRole, false) : {input, output, text: newText, specialCase, engine: translationEngines[primaryEngineKey], autoDecision: aiDecisionFor(primaryEngineKey), decisionPrompt: LEGACY_DECISION_RULES, preferencePrompt: aiPrompt, timingContext: createTimingContext(primaryEngineKey, requestRole, legacyObservationProbe), requestContext}; plugin[translationEngines[primaryEngineKey].funcName].apply(plugin, [primaryData, translation => {
							if (finishIfProviderDispatchStale()) return;
							if (semanticRequest) return handleSemanticResponse(primaryEngineKey, semanticRequest, translation, {}, finishTranslation);
							translation = normalizeProviderTranslation(translation);
							if (!translation && plugin.validTranslator(backupEngineKey, input, output, specialCase)) {
								if (finishIfProviderDispatchStale()) return;
								startTranslating(backupEngineKey);
								if (finishIfProviderDispatchStale()) return;
								recordDispatch(backupEngineKey);
								plugin[translationEngines[backupEngineKey].funcName].apply(plugin, [{input, output, text: newText, specialCase, engine: translationEngines[backupEngineKey], autoDecision: aiDecisionFor(backupEngineKey), decisionPrompt: LEGACY_DECISION_RULES, preferencePrompt: aiPrompt, timingContext: createTimingContext(backupEngineKey, "backup", legacyObservationProbe), requestContext}, backupTranslation => {
									if (finishIfProviderDispatchStale()) return;
									finishTranslation(normalizeProviderTranslation(backupTranslation));
								}]);
							}
							else finishTranslation(translation);
						}]);
					}
					else if (plugin.validTranslator(backupEngineKey, input, output, specialCase)) {
						if (finishIfProviderDispatchStale()) return;
						startTranslating(backupEngineKey);
						if (finishIfProviderDispatchStale()) return;
						recordDispatch(backupEngineKey);
						plugin[translationEngines[backupEngineKey].funcName].apply(plugin, [{input, output, text: newText, specialCase, engine: translationEngines[backupEngineKey], autoDecision: aiDecisionFor(backupEngineKey), decisionPrompt: LEGACY_DECISION_RULES, preferencePrompt: aiPrompt, timingContext: createTimingContext(backupEngineKey, requestRole, legacyObservationProbe), requestContext}, backupTranslation => {
							if (finishIfProviderDispatchStale()) return;
							finishTranslation(normalizeProviderTranslation(backupTranslation));
						}]);
					}
					else finishTranslation();
				};
				// Safety net handler: invoked by finishTranslation on an AI skip signal for a received
				// auto message. If the message is foreign, force a plain re-translation (autoDecision:false,
				// no skip option); otherwise honor the original skip.
				skipSafetyNetHandler = skipTranslation => {
					plugin.isReceivedMessageForeignAsync(newText, output && output.id, isForeign => {
						if (finishIfProviderDispatchStale()) return;
						if (isForeign) dispatchEngine(false, "retry");
						else finishTranslation(skipTranslation);
					});
				};
				// Clearly cross-script foreign messages (e.g. all-caps Latin "HELLO CRYZYYY" -> Chinese)
				// are always foreign: translate plainly so AI decision mode cannot misjudge all-caps
				// text as an acronym and echo/skip it. Same-script (latin<->latin) still uses AI decision.
				const isReceivedAutoAiDecision = !semanticRequest && options.auto && !options.forcePlainTranslation && place == messageTypes.RECEIVED && plugin.shouldUseAiAutoTranslateDecision(channelId);
				const useAutoDecision = isReceivedAutoAiDecision && !plugin.isClearlyForeignLanguageMessage(newText, output && output.id);
				if (canaryLease && semanticRequest && plugin.validTranslator(primaryEngineKey, input, output, specialCase)) {
                    const dRequest = compileWholeMarkerSingle(plugin, semanticRequest);
                    {
                        canaryMeta = {wholeMarkerCanary: true, cacheWrite: false, wireFamily: "whole-marker", semanticRevision: null, semanticWorkloadKey: null, plannerVersion: null, planHash: null, validatorVersion: dRequest ? dRequest.validatorVersion : WHOLE_MARKER_VALIDATOR_VERSION, outputSchemaVersion: WHOLE_MARKER_VERSION};
                        const cache = options[canaryCacheToken];
                        if (cache && canaryLease.cacheEnabled && dRequest) {
                            try {
                                const identity = createWholeMarkerCacheIdentity(plugin, dRequest, cache, input, output, primaryEngineKey);
                                if (identity) {
                                    const key = JSON.stringify(identity);
                                    cache.identity = identity;
                                    cache.isCurrent = () => {try {return key === JSON.stringify(createWholeMarkerCacheIdentity(plugin, dRequest, cache, input, output, primaryEngineKey));} catch {return false;}};
                                    cache.store = plugin.ensureTranslationCacheStore().getWholeMarkerStore();
                                    const hit = cache.store.getCachedTranslation(identity);
                                    if (finishIfProviderDispatchStale() || !cache.isCurrent()) return finishTranslation("");
                                    if (hit) {cache.hit = true; plugin.recordTranslationTerminalStage(terminalRouteId, "cache", "translation_hit", {cacheRead: "translation-hit", requestFamily: "whole-marker", validatorFamily: dRequest.validatorVersion, semanticRevision: WHOLE_MARKER_VERSION, engineFamily: engineFamilyFor(primaryEngineKey)}); return finishTranslation(hit.translatedContent);}
                                }
                            } catch {cache.identity = null; cache.store = null;}
                        }
                        runWholeMarkerSingle({plugin, request: dRequest, lease: canaryLease,
                            onFailure: outcome => {providerValidationReason = outcome.reason; plugin.recordTranslationTerminalStage(terminalRouteId, "parse", outcome.reason, {validatorFamily: dRequest.validatorVersion, semanticRevision: WHOLE_MARKER_VERSION, requestFamily: "whole-marker"});},
                            dispatchTyped: () => {
                                startTranslating(primaryEngineKey);
                                let typedSettled = false;
                                canaryMeta.wireFamily = "typed-json"; canaryMeta.semanticRevision = semanticRequest.semanticRevision; canaryMeta.validatorVersion = semanticRequest.workload.fields.validatorVersion; canaryMeta.outputSchemaVersion = semanticRequest.workload.fields.outputSchemaVersion;
                                plugin.recordTranslationTerminalStage(terminalRouteId, "repair", "whole_marker_typed_fallback", {providerDispatch: true, providerRole: "fallback", engineFamily: engineFamilyFor(primaryEngineKey), requestFamily: semanticRequest.adapter, validatorFamily: VALIDATOR_FAMILY, semanticRevision: semanticRequest.semanticRevision, promptFamily: "segment-json"});
                                plugin[translationEngines[primaryEngineKey].funcName].apply(plugin, [semanticProviderData(primaryEngineKey, semanticRequest, "fallback", false), (raw, providerFailure) => {
                                    if (typedSettled) return; typedSettled = true;
                                    if (finishIfProviderDispatchStale()) return;
                                    if (providerFailure && providerFailure.terminalFailure === "auth" && [401, 403].includes(providerFailure.httpStatus)) {providerValidationReason = "auth"; return finishTranslation("");}
                                    const outcome = plugin.validateAtomicSemanticResponse(semanticRequest, raw, {likelyTarget: value => plugin.isTranslationLikelyInTargetLanguage(value, output.id), similarity: (source, value) => plugin.getTextSimilarityScore(source, value), maxSimilarity: 0.94});
                                    providerValidationReason = outcome.reason || null; if (!outcome.ok) recordSemanticFailure(outcome);
                                    finishTranslation(outcome.ok ? commitSemanticOutcome(outcome) : "");
                                }]);
                            },
                            validation: {likelyTarget: value => plugin.isTranslationLikelyInTargetLanguage(value, output.id), similarity: (source, value) => plugin.getTextSimilarityScore(source, value), maxSimilarity: 0.94},
                            dispatch: (request, role, done) => {
                                startTranslating(primaryEngineKey);
                                plugin.recordTranslationTerminalStage(terminalRouteId, "provider", "dispatch", {providerRole: role, engineFamily: engineFamilyFor(primaryEngineKey), requestFamily: "whole-marker", decisionApplied: false, validatorFamily: request.validatorVersion, semanticRevision: WHOLE_MARKER_VERSION, promptFamily: "whole-marker"});
                                const probe = createWireObservationProbe({source: observationSource, wireFamily: "whole-marker", wireVersion: WHOLE_MARKER_VERSION, wire: request.wire, translateSegments: request.ranges.map(range => range.text), itemCount: 1, protectedSegments: request.protectedSegments, configuredTerms, wrapperRules});
                                const data = semanticProviderData(primaryEngineKey, semanticRequest, role, false);
                                data.text = request.wire; data.semanticRequest = {adapter: request.adapter, systemPrompt: request.systemPrompt, wire: request.wire, targetLanguageId: request.targetLanguageId}; data.timingContext = createTimingContext(primaryEngineKey, role, probe);
                                plugin[translationEngines[primaryEngineKey].funcName].apply(plugin, [data, done]);
                            }, finish: (translation, outcome) => {providerValidationReason = outcome.reason; finishTranslation(translation);}});
                        return;
                    }
                }
                dispatchEngine(useAutoDecision);
			}
		}
		else finishTranslation();
	}

	return Object.freeze({translateMessage, translateText, enableWholeMarkerSingleCanary: canary.enable, disableWholeMarkerSingleCanary: canary.disable, getWholeMarkerSingleCanarySnapshot: canary.snapshot});
}

module.exports = {createTranslationPipeline};
