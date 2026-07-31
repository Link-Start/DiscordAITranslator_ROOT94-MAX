// Decides WHEN committed translations become visible. A commit always lands in the
// store immediately; only the repaint is scheduled here, so deferring never loses a
// translation - it only delays the paint.
//
// Targeted automatic display always uses the live cadence. It updates exact message
// owners and never remounts the chat, so typing and scrolling do not delay results.
// The retained full-list compatibility path still guards disruptive legacy repaints.
const LIVE_REPAINT_DELAY_MS = 120;
const CALM_REPAINT_DELAY_MS = 1500;
const BUSY_RETRY_DELAY_MS = 450;
const SETTINGS_RETRY_DELAY_MS = 1000;

function createDisplayRepaintScheduler({
	renderMessages,
	canRepaintNow,
	isViewingHistory,
	// The full-list repaint path needs the two predicates separately, because it may
	// be told to ignore one of them.
	isSettingsSurfaceOpen = () => false,
	isTextAreaFocused = () => false,
	repaintAll = () => {},
	// Pass BDFDB.TimeUtils.timeout/clear here, never the globals these default to.
	// Every timer below ends in a full-list repaint, and a raw timer outlives the plugin
	// instance that armed it, so after a reload a dead instance keeps repainting
	// alongside the live one. The defaults exist only so a unit test can drive the
	// scheduler without BDFDB; the managed-timer contract test pins the real wiring.
	setTimeout: scheduleTimer = setTimeout,
	clearTimeout: cancelTimer = clearTimeout
}) {
	const queues = new Map();
	let timer = null;

	function nextDelay() {
		return LIVE_REPAINT_DELAY_MS;
	}

	function arm(delay) {
		if (timer) return;
		timer = scheduleTimer(() => {
			timer = null;
			flush();
		}, delay);
	}

	function flush() {
		if (!queues.size) return;
		if (!canRepaintNow()) {
			// Re-check rather than paint over the user; the commit is already stored.
			arm(BUSY_RETRY_DELAY_MS);
			return;
		}
		const pending = [...queues.entries()];
		queues.clear();
		for (const [channelId, messageIds] of pending) {
			const rendering = renderMessages([...messageIds]);
			if (rendering && rendering.then) rendering.then(outcome => {
				for (const messageId of outcome && outcome.retryIds || []) schedule(channelId, messageId, BUSY_RETRY_DELAY_MS);
			}).catch(() => {});
		}
	}

	function schedule(channelId, messageId, delay = null) {
		if (!channelId || messageId == null) return;
		const key = String(channelId);
		if (!queues.has(key)) queues.set(key, new Set());
		queues.get(key).add(String(messageId));
		arm(delay == null ? nextDelay() : delay);
	}

	// The legacy full-list repaint, kept for the paths that still own their display
	// through the old maps (manual translation, reply previews, embeds, titles). It
	// obeys the same two rules as the targeted flush, and additionally remembers a
	// repaint deferred by an open settings surface so closing the panel can flush it.
	let fullRepaintTimer = null;
	let settingsRetryTimer = null;
	let textAreaRetryTimer = null;
	let deferredFullRepaintPending = false;

	function scheduleFullRepaint(options = {}) {
		const config = typeof options == "boolean" ? {batched: options} : Object.assign({batched: false, allowWhileSettings: false, allowWhileTyping: false}, options);
		if (!config.allowWhileSettings && isSettingsSurfaceOpen()) {
			deferredFullRepaintPending = true;
			if (!settingsRetryTimer) settingsRetryTimer = scheduleTimer(() => {
				settingsRetryTimer = null;
				scheduleFullRepaint({batched: true});
			}, SETTINGS_RETRY_DELAY_MS);
			return;
		}
		if (!config.allowWhileTyping && isTextAreaFocused()) {
			if (textAreaRetryTimer) cancelTimer(textAreaRetryTimer);
			textAreaRetryTimer = scheduleTimer(() => {
				textAreaRetryTimer = null;
				scheduleFullRepaint(Object.assign({}, config, {batched: true}));
			}, BUSY_RETRY_DELAY_MS);
			return;
		}
		if (textAreaRetryTimer) {
			cancelTimer(textAreaRetryTimer);
			textAreaRetryTimer = null;
		}
		deferredFullRepaintPending = false;
		if (!config.batched) {
			if (fullRepaintTimer) cancelTimer(fullRepaintTimer);
			fullRepaintTimer = null;
			repaintAll();
			return;
		}
		if (fullRepaintTimer) return;
		const delay = isViewingHistory() ? CALM_REPAINT_DELAY_MS : LIVE_REPAINT_DELAY_MS;
		fullRepaintTimer = scheduleTimer(() => {
			fullRepaintTimer = null;
			repaintAll();
		}, delay);
	}

	return Object.freeze({
		scheduleFullRepaint,
		hasDeferredFullRepaint: () => deferredFullRepaintPending,
		flushDeferredFullRepaint() {
			if (!deferredFullRepaintPending) return;
			deferredFullRepaintPending = false;
			scheduleFullRepaint({batched: true});
		},
		cancelFullRepaintTimers() {
			for (const timer of [fullRepaintTimer, settingsRetryTimer, textAreaRetryTimer]) if (timer) cancelTimer(timer);
			fullRepaintTimer = null;
			settingsRetryTimer = null;
			textAreaRetryTimer = null;
			deferredFullRepaintPending = false;
		},
		schedule,
		flush,
		clear() {
			if (timer) cancelTimer(timer);
			timer = null;
			queues.clear();
		},
		getNextDelay: nextDelay
	});
}

module.exports = {
	SETTINGS_RETRY_DELAY_MS,
	LIVE_REPAINT_DELAY_MS,
	CALM_REPAINT_DELAY_MS,
	BUSY_RETRY_DELAY_MS,
	createDisplayRepaintScheduler
};
