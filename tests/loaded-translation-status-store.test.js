const test = require("node:test");
const assert = require("node:assert/strict");
const {
	LOADED_STATUS_STALLED_AFTER_MS,
	LOADED_STATUS_PHASES,
	LOADED_STATUS_PHASE_BY_JOB_STATE,
	createLoadedTranslationStatusStore
} = require("../src/status/loaded-translation-status-store");

function createHarness({chinese = false, startTime = 1000} = {}) {
	let clock = startTime;
	let uiIsChinese = chinese;
	const timers = new Map();
	let timerSequence = 0;
	const store = createLoadedTranslationStatusStore({
		now: () => clock,
		setTimeout: (callback, delay) => {
			const handle = ++timerSequence;
			timers.set(handle, {callback, delay});
			return handle;
		},
		clearTimeout: handle => {
			timers.delete(handle);
		},
		isChineseUiLanguage: () => uiIsChinese
	});
	return {
		store,
		timers,
		advance(ms) {
			clock += ms;
		},
		setChinese(value) {
			uiIsChinese = value;
		},
		runTimer(handle) {
			const timer = timers.get(handle);
			timers.delete(handle);
			timer.callback();
		}
	};
}

// A status object built by hand, exactly as legacy call sites and older tests do it:
// no phase, no timestamps.
function legacyStatus(fields) {
	return Object.assign({active: false, collecting: false, done: false, channelId: "c1", total: 0, processed: 0, batch: 0, displayed: 0, skipped: 0, failed: 0, retryable: 0, aiDropped: 0}, fields);
}

test("the Chinese capsule wording is unchanged for every branch", () => {
	const {store} = createHarness({chinese: true});

	assert.equal(store.getStatusText(legacyStatus({done: true})), "已加载翻译：开启，暂无待翻译");
	assert.equal(store.getStatusText(legacyStatus({done: true, failed: 2, retryable: 3})), "已加载翻译：失败 2，待重试 3");
	assert.equal(store.getStatusText(legacyStatus({done: true, batch: 2, total: 10, displayed: 7})), "已加载翻译：第 2 批完成，显示 7/10");
	assert.equal(store.getStatusText(legacyStatus({active: true, collecting: true, batch: 1, total: 21, processed: 0})), "收集已加载：第 1 批 0/21");
	assert.equal(store.getStatusText(legacyStatus({active: true})), "已加载翻译：开启，等待消息");
	assert.equal(store.getStatusText(legacyStatus({active: true, batch: 1, total: 21, processed: 4, displayed: 3})), "翻译已加载：第 1 批 4/21，显示 3");
});

test("the English capsule wording is unchanged for every branch", () => {
	const {store} = createHarness({chinese: false});

	assert.equal(store.getStatusText(legacyStatus({done: true})), "Loaded translation: on, no pending messages");
	assert.equal(store.getStatusText(legacyStatus({done: true, failed: 2, retryable: 3})), "Loaded translation: 2 failed, 3 retry pending");
	assert.equal(store.getStatusText(legacyStatus({done: true, batch: 2, total: 10, displayed: 7})), "Loaded translation: batch 2 done, shown 7/10");
	assert.equal(store.getStatusText(legacyStatus({active: true, collecting: true, batch: 1, total: 21, processed: 0})), "Collecting loaded: batch 1 0/21");
	assert.equal(store.getStatusText(legacyStatus({active: true})), "Loaded translation: on, waiting");
	assert.equal(store.getStatusText(legacyStatus({active: true, batch: 1, total: 21, processed: 4, displayed: 3})), "Translating loaded: batch 1 4/21, shown 3");
});

test("the skipped/failed/retry suffixes keep their wording in both languages", () => {
	const harness = createHarness({chinese: true});
	const status = legacyStatus({done: true, batch: 1, total: 10, displayed: 4, skipped: 3, failed: 2, retryable: 5});

	assert.equal(harness.store.getStatusText(status), "已加载翻译：第 1 批完成，显示 4/10，跳过 3，失败 2，待重试 5");
	harness.setChinese(false);
	assert.equal(harness.store.getStatusText(status), "Loaded translation: batch 1 done, shown 4/10, skipped 3, failed 2, retry pending 5");
});

test("a retry count equal to the failed count is not repeated", () => {
	const {store} = createHarness({chinese: false});
	const status = legacyStatus({done: true, batch: 1, total: 4, displayed: 3, failed: 1, retryable: 1});

	// The historical-job suite depends on this: a fully retryable batch says "retry"
	// once and never doubles the failure count.
	assert.equal(store.getStatusText(status), "Loaded translation: batch 1 done, shown 3/4, failed 1");
});

test("counters are clamped and the failure count falls back to the AI-dropped count", () => {
	const {store} = createHarness({chinese: false});

	// Processed/displayed/skipped can never exceed the total the capsule shows.
	assert.equal(store.getStatusText(legacyStatus({active: true, total: 5, processed: 99, displayed: 99})), "Translating loaded: batch 1 5/5, shown 5");
	// Negative values are floored at zero rather than rendered.
	assert.equal(store.getStatusText(legacyStatus({active: true, total: 5, processed: -3, displayed: -3})), "Translating loaded: batch 1 0/5, shown 0");
	// A record written before `failed` existed only carries aiDropped.
	const droppedOnly = legacyStatus({done: true, total: 4, displayed: 2, aiDropped: 2});
	delete droppedOnly.failed;
	assert.equal(store.getStatusText(droppedOnly), "Loaded translation: batch 1 done, shown 2/4, failed 2");
});

test("a status without a phase renders exactly as it did before phases existed", () => {
	const harness = createHarness({chinese: true});
	harness.advance(10 * 60 * 1000);

	// No phase means no timestamps, so no elapsed time and no stall marker may appear
	// no matter how long the clock has run.
	assert.equal(harness.store.getStatusText(legacyStatus({active: true, batch: 1, total: 21, processed: 0, displayed: 0})), "翻译已加载：第 1 批 0/21，显示 0");
});

test("a running phase reports how long it has been working", () => {
	const harness = createHarness({chinese: true});
	harness.store.update({active: true, collecting: false, channelId: "c1", batch: 1, total: 21, processed: 0, displayed: 0, phase: "requesting"});
	harness.advance(12000);

	assert.equal(harness.store.getStatusText(), "翻译已加载：第 1 批 0/21，显示 0，请求中 12s");
	harness.setChinese(false);
	assert.equal(harness.store.getStatusText(), "Translating loaded: batch 1 0/21, shown 0, requesting 12s");
});

test("a phase with no counter movement is reported as stuck", () => {
	const harness = createHarness({chinese: true});
	harness.store.update({active: true, channelId: "c1", batch: 1, total: 21, processed: 0, displayed: 0, phase: "requesting"});
	harness.advance(LOADED_STATUS_STALLED_AFTER_MS - 1);
	assert.equal(harness.store.getPhaseSnapshot().working, true);
	assert.equal(harness.store.getPhaseSnapshot().stalled, false);

	harness.advance(1);
	// This is the incident text: the counters read the same as ever, and the suffix is
	// the only thing that says the job is not moving.
	assert.equal(harness.store.getStatusText(), "翻译已加载：第 1 批 0/21，显示 0，请求中 45s 无进展");
	assert.equal(harness.store.getPhaseSnapshot().stalled, true);
	assert.equal(harness.store.getPhaseSnapshot().working, false);

	harness.setChinese(false);
	assert.equal(harness.store.getStatusText(), "Translating loaded: batch 1 0/21, shown 0, requesting 45s no progress");
});

test("counter movement restarts the stall clock without restarting the phase clock", () => {
	const harness = createHarness();
	harness.store.update({active: true, channelId: "c1", batch: 1, total: 21, processed: 0, phase: "requesting"});
	const phaseStartedAt = harness.store.getStatus().phaseStartedAt;

	harness.advance(40000);
	harness.store.update({processed: 5});
	harness.advance(40000);

	const snapshot = harness.store.getPhaseSnapshot();
	assert.equal(snapshot.stalled, false, "a job that moved 40s ago is slow, not stuck");
	assert.equal(snapshot.sinceProgressMs, 40000);
	assert.equal(snapshot.phaseElapsedMs, 80000, "the phase itself has been running the whole time");
	assert.equal(harness.store.getStatus().phaseStartedAt, phaseStartedAt);
});

test("a collecting capsule reports its phase while a waiting one stays quiet", () => {
	const harness = createHarness({chinese: true});
	harness.store.update({active: true, collecting: true, channelId: "c1", batch: 1, total: 0, processed: 0});
	harness.advance(3000);
	assert.equal(harness.store.getStatusText(), "收集已加载：第 1 批 0/0，收集中 3s");

	// Idle-with-nothing-to-do has no job behind it, so a growing timer would only alarm.
	harness.store.update({collecting: false, active: true, total: 0});
	harness.advance(60000);
	assert.equal(harness.store.getStatusText(), "已加载翻译：开启，等待消息");
});

test("a terminal phase adds nothing to the finished wording", () => {
	const harness = createHarness({chinese: true});
	harness.store.update({active: false, collecting: false, done: true, channelId: "c1", batch: 2, total: 10, displayed: 9});
	harness.advance(120000);

	assert.equal(harness.store.getStatus().phase, "done");
	assert.equal(harness.store.getStatusText(), "已加载翻译：第 2 批完成，显示 9/10");

	harness.store.update({done: false, active: false, phase: "failed"});
	harness.advance(120000);
	assert.equal(harness.store.getStatus().phase, "failed");
	assert.equal(harness.store.getStatusText(), "翻译已加载：第 2 批 0/10，显示 9", "a failed phase adds no timer either");
});

test("the phase is derived from the flags when the caller states none", () => {
	const harness = createHarness();

	harness.store.update({active: true, collecting: true, channelId: "c1"});
	assert.equal(harness.store.getStatus().phase, "collecting");

	// Collecting cannot carry forward once the flag drops.
	harness.store.update({collecting: false});
	assert.equal(harness.store.getStatus().phase, "requesting");

	harness.store.update({phase: "repairing"});
	assert.equal(harness.store.getStatus().phase, "repairing");
	harness.store.update({displayed: 1});
	assert.equal(harness.store.getStatus().phase, "repairing", "a non-terminal phase carries forward");

	harness.store.update({active: false, done: true});
	assert.equal(harness.store.getStatus().phase, "done");

	harness.store.update({done: false, active: false});
	assert.equal(harness.store.getStatus().phase, null, "an inactive, unfinished record has no phase");
});

test("an unknown phase string is ignored rather than stored", () => {
	const harness = createHarness();
	harness.store.update({active: true, collecting: false, channelId: "c1", phase: "uploading"});

	assert.equal(harness.store.getStatus().phase, "requesting");
	assert.ok(LOADED_STATUS_PHASES.includes(harness.store.getStatus().phase));
});

test("a phase change restamps both timestamps", () => {
	const harness = createHarness({startTime: 5000});
	harness.store.update({active: true, collecting: true, channelId: "c1"});
	assert.equal(harness.store.getStatus().phaseStartedAt, 5000);
	assert.equal(harness.store.getStatus().progressAt, 5000);

	harness.advance(7000);
	harness.store.update({collecting: false});
	assert.equal(harness.store.getStatus().phaseStartedAt, 12000);
	assert.equal(harness.store.getStatus().progressAt, 12000);
});

test("every historical job state maps onto a capsule phase", () => {
	const {store} = createHarness();

	assert.equal(store.getPhaseForJobState("collecting"), "collecting");
	assert.equal(store.getPhaseForJobState("translating"), "requesting");
	assert.equal(store.getPhaseForJobState("repairing"), "repairing");
	assert.equal(store.getPhaseForJobState("ready"), "committing");
	assert.equal(store.getPhaseForJobState("committed"), "done");
	// A cancelled job is not visible, so it reports nothing.
	assert.equal(store.getPhaseForJobState("cancelled"), null);
	assert.equal(store.getPhaseForJobState("nonsense"), null);
	assert.equal(store.getPhaseForJobState(undefined), null);
	assert.deepEqual(Object.keys(LOADED_STATUS_PHASE_BY_JOB_STATE), ["collecting", "translating", "repairing", "ready", "committed", "cancelled"]);
});

test("batch numbering advances globally and restarts per channel", () => {
	const {store} = createHarness();

	assert.equal(store.getNextBatchNumber(), 1);
	store.update({active: true, channelId: "c1", batch: store.getNextBatchNumber()});
	assert.equal(store.getCurrentBatchNumber(), 1);

	assert.equal(store.getNextBatchNumber(), 2, "the unscoped counter keeps advancing");
	assert.equal(store.getNextBatchNumber("c1"), 2, "the same channel continues its own count");
	assert.equal(store.getNextBatchNumber("c2"), 1, "another channel starts over");

	store.update({batch: 7});
	assert.equal(store.getCurrentBatchNumber(), 7);
	store.clear();
	assert.equal(store.getCurrentBatchNumber(), 1, "a cleared record reports batch 1, never 0");
});

test("the status is channel scoped and reports its own completion", () => {
	const {store} = createHarness();
	store.update({active: false, done: true, channelId: "c1"});

	assert.equal(store.isForChannel("c1"), true);
	assert.equal(store.isForChannel(1), false);
	assert.equal(store.isForChannel("c2"), false);
	assert.equal(store.isDone(), true);
	assert.equal(store.isActive(), false);
	// Numeric channel ids from Discord must still match their string form.
	store.update({channelId: 123});
	assert.equal(store.isForChannel("123"), true);
});

test("the returned status is a copy, so a reader cannot corrupt the record", () => {
	const {store} = createHarness();
	store.update({active: true, channelId: "c1", total: 5});

	const snapshot = store.getStatus();
	snapshot.total = 999;
	snapshot.channelId = "hijacked";

	assert.equal(store.getStatus().total, 5);
	assert.equal(store.getStatus().channelId, "c1");
});

test("clearing resets the whole record and cancels a pending hide", () => {
	const harness = createHarness();
	harness.store.update({active: true, collecting: true, done: false, channelId: "c1", total: 9, processed: 4, batch: 3, displayed: 2, skipped: 1, failed: 1, retryable: 1, aiDropped: 1, lastSkipReason: "link_only", lastSkipPreview: "hi"});
	harness.store.scheduleHide(1600, () => {});
	assert.equal(harness.store.hasPendingHide(), true);

	const cleared = harness.store.clear();

	assert.equal(harness.store.hasPendingHide(), false);
	assert.equal(harness.timers.size, 0, "the hide timer handle must actually be released");
	assert.deepEqual(cleared, {
		active: false, collecting: false, done: false, channelId: null,
		total: 0, processed: 0, batch: 0, displayed: 0, skipped: 0,
		failed: 0, retryable: 0, aiDropped: 0, lastSkipReason: "", lastSkipPreview: "",
		phase: null, phaseStartedAt: 0, progressAt: 0
	});
});

test("scheduling a hide replaces any pending one and releases its handle first", () => {
	const harness = createHarness();
	let hidden = 0;

	const first = harness.store.scheduleHide(1600, () => {hidden++;});
	const second = harness.store.scheduleHide(1600, () => {hidden++;});

	assert.equal(harness.timers.has(first), false, "the superseded timer must be cancelled");
	assert.equal(harness.timers.size, 1);
	assert.equal(harness.timers.get(second).delay, 1600);

	harness.runTimer(second);
	assert.equal(hidden, 1);
	assert.equal(harness.store.hasPendingHide(), false, "the handle is cleared before the callback runs");
});

test("cancelling a hide that was never scheduled is a no-op", () => {
	const harness = createHarness();
	harness.store.cancelHide();
	assert.equal(harness.store.hasPendingHide(), false);
	assert.equal(harness.timers.size, 0);
});

test("seen messages are tracked per channel and report repeats", () => {
	const {store} = createHarness();

	assert.equal(store.markMessageSeen("c1", "m1"), false, "the first sighting is new");
	assert.equal(store.markMessageSeen("c1", "m1"), true, "the second sighting is a repeat");
	assert.equal(store.markMessageSeen("c2", "m1"), false, "another channel tracks separately");
	assert.equal(store.getSeenCount("c1"), 1);
	assert.equal(store.getSeenCount("c2"), 1);
	assert.equal(store.getSeenCount("c3"), 0);
	assert.equal(store.getSeenCount(null), 0);
	// Numeric ids from Discord and their string form are the same message.
	assert.equal(store.markMessageSeen(1, 2), false);
	assert.equal(store.markMessageSeen("1", "2"), true);
});

test("a missing channel or message id is never recorded", () => {
	const {store} = createHarness();

	assert.equal(store.markMessageSeen(null, "m1"), false);
	assert.equal(store.markMessageSeen("c1", null), false);
	assert.equal(store.markMessageSeen("", ""), false);
	assert.equal(store.getSeenCount("c1"), 0);
});

test("resetting seen messages is channel scoped, and global without a channel", () => {
	const {store} = createHarness();
	store.markMessageSeen("c1", "m1");
	store.markMessageSeen("c2", "m2");

	store.resetSeen("c1");
	assert.equal(store.getSeenCount("c1"), 0);
	assert.equal(store.getSeenCount("c2"), 1, "leaving one channel keeps the other");
	assert.equal(store.markMessageSeen("c1", "m1"), false, "a reset channel forgets its messages");

	store.resetSeen();
	assert.equal(store.getSeenCount("c1"), 0);
	assert.equal(store.getSeenCount("c2"), 0);
});

test("the inline text shows the record only for the channel it belongs to", () => {
	const harness = createHarness({chinese: true});
	harness.store.update({active: true, done: false, collecting: false, channelId: "c1", batch: 1, total: 4, processed: 2, displayed: 2});

	assert.equal(harness.store.getInlineStatusText("c1"), harness.store.getStatusText());
	assert.equal(harness.store.getInlineStatusText("c2"), "已加载消息自动翻译已开启，等待当前批次…");
	harness.setChinese(false);
	assert.equal(harness.store.getInlineStatusText("c2"), "Loaded-message auto-translate is on; waiting for the current batch…");
});

test("a global or unassigned record shows inline for any channel", () => {
	const harness = createHarness({chinese: true});

	harness.store.update({active: true, channelId: "__global", batch: 1, total: 4, processed: 1, displayed: 1});
	assert.equal(harness.store.getInlineStatusText("c9"), harness.store.getStatusText());

	harness.store.update({channelId: null});
	assert.equal(harness.store.getInlineStatusText("c9"), harness.store.getStatusText());

	// Neither active nor done means there is nothing to report yet.
	harness.store.clear();
	assert.equal(harness.store.getInlineStatusText("c9"), "已加载消息自动翻译已开启，等待当前批次…");
});

test("preview text is collapsed, trimmed and truncated", () => {
	const {store} = createHarness();

	assert.equal(store.getPreviewText("  hello   world \n again "), "hello world again");
	assert.equal(store.getPreviewText(""), "");
	assert.equal(store.getPreviewText(null), "");
	assert.equal(store.getPreviewText("   "), "");
	assert.equal(store.getPreviewText("x".repeat(24)), "x".repeat(24), "exactly at the limit is kept whole");
	assert.equal(store.getPreviewText("x".repeat(25)), `${"x".repeat(24)}...`);
});

test("a full batch lifecycle keeps the counters and gains a working signal", () => {
	const harness = createHarness({chinese: true});
	const jobStates = ["collecting", "translating", "repairing", "ready", "committed"];

	harness.store.update({active: true, collecting: true, done: false, channelId: "c1", batch: harness.store.getNextBatchNumber(), total: 0, processed: 0, displayed: 0, phase: harness.store.getPhaseForJobState("collecting")});
	assert.equal(harness.store.getStatusText(), "收集已加载：第 1 批 0/0，收集中 0s");

	harness.advance(1000);
	// Exactly what updateHistoricalTranslationJobStatus writes once the job leaves
	// collecting: the flags and the phase move together.
	harness.store.update({collecting: false, total: 21, phase: harness.store.getPhaseForJobState(jobStates[1])});
	harness.advance(5000);
	assert.equal(harness.store.getStatusText(), "翻译已加载：第 1 批 0/21，显示 0，请求中 5s");

	harness.advance(LOADED_STATUS_STALLED_AFTER_MS);
	assert.equal(harness.store.getStatusText(), "翻译已加载：第 1 批 0/21，显示 0，请求中 50s 无进展");

	harness.store.update({processed: 21, displayed: 20, failed: 1, retryable: 1, aiDropped: 1, phase: harness.store.getPhaseForJobState("ready")});
	assert.equal(harness.store.getStatusText(), "翻译已加载：第 1 批 21/21，显示 20，失败 1，提交中 0s");

	harness.store.update({active: false, collecting: false, done: true, phase: harness.store.getPhaseForJobState("committed")});
	assert.equal(harness.store.getStatusText(), "已加载翻译：第 1 批完成，显示 20/21，失败 1");
});

test("repositioning coalesces into one frame per burst", () => {
	// Repositioning the banner reads getBoundingClientRect, which forces a synchronous
	// layout. A historical batch changes the status once per message, and the callers used
	// to pay two layouts per change - one immediate, one in an undeduped animation frame.
	// A burst of N updates must cost one layout, not 2N.
	const frames = [];
	const store = createLoadedTranslationStatusStore({
		requestFrame: callback => {frames.push(callback); return frames.length;},
		cancelFrame: handle => {frames[handle - 1] = null;}
	});

	let repositions = 0;
	const reposition = () => {repositions++;};
	for (let i = 0; i < 20; i++) store.schedulePosition(reposition);
	assert.equal(frames.filter(Boolean).length, 1, "twenty updates must arm exactly one frame");
	assert.equal(repositions, 0, "nothing repositions until the frame runs");

	frames[0]();
	assert.equal(repositions, 1);

	// After the frame ran, the next burst may arm again.
	store.schedulePosition(reposition);
	assert.equal(frames.filter(Boolean).length, 2);
});

test("a cancelled reposition frame does not strand the guard", () => {
	const frames = [];
	const store = createLoadedTranslationStatusStore({
		requestFrame: callback => {frames.push(callback); return frames.length;},
		cancelFrame: handle => {frames[handle - 1] = null;}
	});

	let repositions = 0;
	store.schedulePosition(() => {repositions++;});
	store.cancelScheduledPosition();
	assert.equal(frames.filter(Boolean).length, 0, "the pending frame must be cancelled");

	// The guard must be clear, or a detach would block repositioning forever.
	assert.equal(store.schedulePosition(() => {repositions++;}), true);
});
