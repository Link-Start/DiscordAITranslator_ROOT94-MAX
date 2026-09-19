// Low-priority reply previews: one provider request, bounded waiting, and no new
// dispatch while history or live work is pending. Cache and per-message ownership
// remain with the display runtime; one shared wake-up timer exists only while busy.
function createReplyPreviewQueue({getPlugin, messageTypes, isRuntimeActive, setTimeout: schedule = setTimeout, clearTimeout: cancel = clearTimeout}) {
	const waiting = [];
	let active = null, pumping = false, timer = null, timerEpoch = 0, stopped = false;
	function higherPriorityWork() {
		const plugin = getPlugin();
		const history = typeof plugin.ensureHistoricalJobRegistry === "function" && plugin.ensureHistoricalJobRegistry();
		if (history && history.listQueues().some(entry => entry.runningPromise || entry.jobs.length)) return true;
		const live = typeof plugin.ensureLiveTranslationQueue === "function" && plugin.ensureLiveTranslationQueue();
		return !!(live && (live.getQueueLength() || live.getLiveSlotActiveCount() || live.isBusyTranslating()));
	}
	function pump() {
		if (pumping || stopped || !isRuntimeActive()) return;
		pumping = true;
		try {
			if (timer !== null) {cancel(timer); timer = null;}
			while (!active && waiting.length) {
				const next = waiting[0];
				if (!next.isCurrent()) {waiting.shift(); next.release(); continue;}
				if (next.tryCache()) {waiting.shift(); continue;}
				if (higherPriorityWork()) {const epoch = ++timerEpoch; timer = schedule(() => {if (epoch !== timerEpoch) return; timer = null; pump();}, 250); return;}
				active = waiting.shift();
				try {next();} catch (error) {next.release(); if (active === next) active = null;}
			}
		}
		finally {pumping = false;}
	}
	function queueReplyPreviewTranslation(message, channelId, contextOptions = {}) {
		const plugin = getPlugin();
		if (stopped || !isRuntimeActive()) return;
		if (!message || !message.id || !channelId || plugin.ensureReceivedDisplayRuntime().isPreviewPending(message.id)) return;
		const baseMessage = contextOptions.baseMessage || null;
		if (baseMessage && !plugin.shouldAutoTranslateReplyPreview(baseMessage, message, channelId)) return;
		if (plugin.ensureReceivedDisplayRuntime().isSuppressed(message.id)) return;
		if (!plugin.isTranslationEnabled(channelId) || plugin.isOwnMessage(message)) return;
		const originalContent = (message.content || "").trim();
		if (!originalContent) return;
		const signature = plugin.createReplyPreviewSignature(message, channelId, originalContent);
		const existingTranslation = plugin.ensureReceivedDisplayRuntime().getPreviewTranslation(message.id);
		if (existingTranslation && existingTranslation.signature == signature) return;
		const cachedTranslation = plugin.getCachedReceivedTranslation(message, channelId);
		if (cachedTranslation) {
			const previewTranslation = plugin.createReplyPreviewTranslationData(message, channelId, cachedTranslation);
			if (previewTranslation) {const previewCommit = plugin.ensureReceivedDisplayRuntime().commitPreviewResult({messageId: message.id, channelId, signature, translation: previewTranslation}); if (previewCommit && previewCommit.catch) previewCommit.catch(_ => {});}
			return;
		}
		if (waiting.length >= 200) return; // No pending token is allocated for overflow; a later render may offer it again.
		const request = plugin.ensureReceivedDisplayRuntime().markPreviewPending({messageId: message.id, channelId, signature});
		if (typeof plugin.observeReceivedBodyTranslationPlan == "function") plugin.observeReceivedBodyTranslationPlan(originalContent, {lane: "reply", channelId, legacyHardSkip: false, legacyEligibility: "eligible"});
		if (typeof plugin.observeTranslationDocumentPlan == "function") plugin.observeTranslationDocumentPlan({reply: {body: originalContent}}, {lane: "reply", direction: "received", channelId});
		const dispatch = () => plugin.translateText(originalContent, messageTypes.RECEIVED, (translation, input, output) => {
			if (active !== dispatch) return;
			active = null;
			try {
				if (dispatch.cancelled || !isRuntimeActive() || !plugin.ensureReceivedDisplayRuntime().releasePreviewPending(message.id, request)) return;
				if (plugin.createReplyPreviewSignature(message, channelId, (message.content || "").trim()) != signature) return;
				if (baseMessage && !plugin.shouldAutoTranslateReplyPreview(baseMessage, message, channelId)) return;
				if (!plugin.isTranslationEnabled(channelId)) return;
				if (translation) {
					const previewCommit = plugin.ensureReceivedDisplayRuntime().commitPreviewResult({messageId: message.id, channelId, signature, translation: {
						signature,
						channelId,
						auto: true,
						translatedContent: (translation || "").trim(),
						originalContent,
						input,
						output
					}}); if (previewCommit && previewCommit.catch) previewCommit.catch(_ => {});
				}
			} finally {pump();}
		}, null, {
			showToast: false,
			showFailureToast: false,
			trackBusy: false,
			isCurrent: dispatch.isCurrent,
			channelId
		});
		dispatch.isCurrent = () => {
			const display = plugin.ensureReceivedDisplayRuntime(), pending = typeof display.getPreviewPending === "function" ? display.getPreviewPending(message.id) : {token: request};
			return !dispatch.cancelled && isRuntimeActive() && pending && pending.token === request && !display.isSuppressed(message.id) && plugin.isTranslationEnabled(channelId) && plugin.createReplyPreviewSignature(message, channelId, (message.content || "").trim()) === signature && (!baseMessage || plugin.shouldAutoTranslateReplyPreview(baseMessage, message, channelId));
		};
		dispatch.release = () => plugin.ensureReceivedDisplayRuntime().releasePreviewPending(message.id, request);
		dispatch.tryCache = () => {
			const cached = plugin.getCachedReceivedTranslation(message, channelId);
			if (!cached) return false;
			if (plugin.ensureReceivedDisplayRuntime().releasePreviewPending(message.id, request)) {
				const translation = plugin.createReplyPreviewTranslationData(message, channelId, cached);
				if (translation) {const result = plugin.ensureReceivedDisplayRuntime().commitPreviewResult({messageId: message.id, channelId, signature, translation}); if (result && result.catch) result.catch(() => {});}
			}
			return true;
		};
		waiting.push(dispatch);
		pump();
	}

	function stop() {
		stopped = true; timerEpoch++;
		if (timer !== null) {cancel(timer); timer = null;}
		for (const entry of waiting.splice(0)) {entry.cancelled = true; entry.release();}
		// Keep the active slot until its callback: restart must not overlap an old physical request.
		if (active) {active.cancelled = true; active.release();}
	}
	return Object.freeze({queueReplyPreviewTranslation, stop, start() {stopped = false; pump();}});
}

module.exports = {createReplyPreviewQueue};
