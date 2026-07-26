// Decides WHEN committed translations become visible. A commit always lands in the
// store immediately; only the repaint is scheduled here, so deferring never loses a
// translation - it only delays the paint.
//
// Two rules, each learned from a real incident:
//   * Never repaint while the user is typing or has a translator settings surface
//     open. The legacy path guarded both and the first store-based implementation
//     dropped the guards, which interrupted typing.
//   * A targeted repaint (only the committed message ids) does not disturb someone
//     reading back through history, so it paints at the live cadence. Only after a
//     transaction had to fall back to a full-list remount does the next one wait out
//     the calmer delay, because a remount genuinely does disturb reading.
const LIVE_REPAINT_DELAY_MS = 120;
const CALM_REPAINT_DELAY_MS = 1500;
const BUSY_RETRY_DELAY_MS = 450;

function createDisplayRepaintScheduler({
	renderMessages,
	canRepaintNow,
	isViewingHistory,
	lastRenderUsedFallback,
	setTimeout: scheduleTimer = setTimeout,
	clearTimeout: cancelTimer = clearTimeout
}) {
	const queues = new Map();
	let timer = null;

	function nextDelay() {
		return lastRenderUsedFallback() && isViewingHistory() ? CALM_REPAINT_DELAY_MS : LIVE_REPAINT_DELAY_MS;
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
		const pending = [...queues.values()];
		queues.clear();
		for (const messageIds of pending) {
			const rendering = renderMessages([...messageIds]);
			if (rendering && rendering.catch) rendering.catch(() => {});
		}
	}

	return Object.freeze({
		schedule(channelId, messageId, delay = null) {
			if (!channelId || messageId == null) return;
			const key = String(channelId);
			if (!queues.has(key)) queues.set(key, new Set());
			queues.get(key).add(String(messageId));
			arm(delay == null ? nextDelay() : delay);
		},
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
	LIVE_REPAINT_DELAY_MS,
	CALM_REPAINT_DELAY_MS,
	BUSY_RETRY_DELAY_MS,
	createDisplayRepaintScheduler
};
