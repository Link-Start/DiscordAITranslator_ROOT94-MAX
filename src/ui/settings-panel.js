// The BetterDiscord settings panel: five task tabs rendered in the mk-* design
// system from artifacts/ui-redesign-draft.html (the reference plugin's damc-*
// anatomy). Pages are row-forms drawn directly on the panel background - group
// headers, 36px rows, hairline splits - with self-drawn switches, selects, chips
// and buttons instead of BDFDB form widgets. It reads plugin getters, writes back
// through BDFDB.DataUtils.save, and asks BDFDB to re-render itself.
//
// Short-lived UI state lives on the plugin instance (tabs, selected provider, secret
// visibility and translated colour) because a refresh rebuilds this whole tree, so
// anything the panel kept locally would be lost on every interaction that triggers
// refreshPanel().
//
// BDFDB arrives in the dependencies object rather than as a module import: it is a live
// BetterDiscord library handle the plugin factory receives, not something this module
// can require. BdApi is a genuine Discord global and is referenced directly, exactly as
// the legacy factory did.

const {translationEngines, enginePortals, SYNTHETIC_BENCHMARK_TEXTS, getModelCatalogPersistenceKey, getRegisteredCustomProtocolAdapters, isCustomEngineKey, createCustomEngineId, normalizeCustomProviders} = require("../providers/provider-client");
const {createDeferredFieldWriter} = require("../settings/deferred-field-writes");
const {MIN_TRANSLATION_CACHE_CAPACITY, MAX_TRANSLATION_CACHE_CAPACITY, parseTranslationCacheCapacity, normalizeTranslationCacheCapacity} = require("../settings/translation-cache-capacity");
const {BUILTIN_PROMPT_ID, ensureAiPromptLibrary, addAiPrompt, updateAiPrompt, deleteAiPrompt, selectAiPrompt, isAiPromptSendingEnabled, setAiPromptSendingEnabled} = require("../settings/prompt-library");
// Dropdown value that turns preference sending off without changing the selected prompt.
const AI_PROMPT_OFF_OPTION = "__preferences_off__";
const {createSearchableSelectComponent, createModelComboComponent} = require("./searchable-select");
const {PROVIDER_GROUPS, resolveProviderGroupKeys} = require("./provider-catalog");
const {formatThinkingRawLabel, thinkingRawGlossKey, resolveCustomProviderStatus, getVisibleAdapterOptions} = require("./custom-provider-ui-contract");
const {UPDATE_PROJECT_URL, checkForUpdate} = require("../updates/update-checker");
const {findSettingsHostModal, localizeSettingsHostModal} = require("./settings-host-modal");
const {BATCH_ANSWER_SHAPES} = require("../planner/semantic-batch-answer");
const {MAX_RECENT_BATCH_ANSWERS, sanitizeBatchAnswerObservation} = require("../diagnostics/batch-answer-observation");

// Same values as the legacy factory-scope languageTypes/messageTypes maps, and as
// LANGUAGE_DIRECTIONS/MESSAGE_DIRECTIONS in settings-store.js and
// language-heuristics.js. Kept as a local copy, under the legacy names, so the panel
// body reads exactly the way it did inside runtime.js and the panel does not own
// runtime-wide vocabulary for everyone else.
const languageTypes = Object.freeze({INPUT: "input", OUTPUT: "output"});
const messageTypes = Object.freeze({RECEIVED: "received", SENT: "sent"});

function replaceTextSlots(template, values = {}) {
	return Object.keys(values).reduce((text, key) => String(text).split(`{${key}}`).join(String(values[key])), String(template || ""));
}

// Compatibility cleanup for a W2 owner left in settings UI state. Published
// settings no longer create one; closing or stopping still invalidates every closure
// captured by a still-open confirmation modal. Nulling the owner before calling
// cancel makes a late modal confirmation inert, while owner.cancel performs the
// synchronous controller + physical experiment-session abort for an active run.
function cancelW2SettingsBenchmark(plugin, reason = "cancelled") {
	const state = plugin && plugin.settingsUiState && plugin.settingsUiState.w2WireBenchmark;
	if (!state) return false;
	const owner = state.owner;
	state.owner = null;
	state.providerClient = null;
	state.preview = null;
	state.progress = null;
	state.running = false;
	let cancelled = false;
	try {if (owner && typeof owner.cancel === "function") cancelled = owner.cancel(reason) === true;}
	catch (error) {}
	return cancelled;
}

function formatLatencyDuration(durationMs, getText) {
	const value = Math.max(0, Number(durationMs) || 0);
	if (value < 1000) return replaceTextSlots(getText("latency_milliseconds"), {n: Math.round(value)});
	const seconds = Math.round(value / 10) / 100;
	return replaceTextSlots(getText("latency_seconds"), {n: seconds});
}

function getLatencyErrorTextKey(errorClass) {
	const keys = {
		timeout: "latency_error_timeout",
		auth: "latency_error_auth",
		not_found: "latency_error_not_found",
		rate_limit: "latency_error_rate_limit",
		server: "latency_error_server",
		network: "latency_error_network",
		invalid: "latency_error_invalid",
		invalid_request: "latency_error_invalid_request",
		unsupported_field: "latency_error_unsupported_field",
		unsupported_value: "latency_error_unsupported_value",
		sampling_conflict: "latency_error_sampling_conflict",
		schema: "latency_error_schema",
		unknown: "latency_error_unknown"
	};
	return keys[errorClass] || "latency_error_unknown";
}

function getReasoningStatusTextKey(support) {
	return {
		provider_default: "reasoning_status_provider_default",
		pending: "reasoning_status_pending",
		accepted: "reasoning_status_accepted",
		reduced: "reasoning_status_reduced",
		unsupported: "reasoning_status_unsupported"
	}[support] || "reasoning_status_pending";
}

function createReasoningStatusView(status, getText) {
	const support = status && status.support || "provider_default";
	const mode = status && status.mode || "off";
	const resolvedValue = status && status.resolvedValue || "";
	const evidence = status && status.evidence || "none";
	let key = getReasoningStatusTextKey(support);
	if (support === "accepted" && mode === "on") key = evidence === "confirmed"
		? "reasoning_status_on_confirmed"
		: evidence === "contradicted" ? "reasoning_status_on_ignored" : "reasoning_status_on_accepted";
	else if (support === "accepted") key = evidence === "confirmed"
		? "reasoning_status_close_confirmed"
		: evidence === "contradicted" ? "reasoning_status_close_ignored" : "reasoning_status_close_accepted";
	else if (support === "reduced" && resolvedValue) key = "reasoning_status_reduced_value";
	return {
		text: replaceTextSlots(getText(key), {value: resolvedValue || "—"}),
		tone: support === "unsupported" || support === "pending" || evidence === "contradicted" ? "warn" : support === "accepted" || support === "reduced" ? "ok" : "neutral"
	};
}

function shouldShowReasoningEffort(mode, effectiveProfile) {
	return mode === "on" && effectiveProfile === "openai";
}

// One plain sentence instead of signed percent pairs: the reader gets
// "current setting is N% faster", not a P50 delta to decode.
function formatBenchmarkCompare(baseline, controlled, getText) {
	if (!Number.isFinite(baseline) || baseline <= 0 || !Number.isFinite(controlled)) return getText("benchmark_no_compare");
	const percent = Math.round((controlled - baseline) / baseline * 100);
	if (Math.abs(percent) < 1) return getText("benchmark_unchanged");
	return replaceTextSlots(getText(percent < 0 ? "benchmark_compare_faster" : "benchmark_compare_slower"), {n: Math.abs(percent)});
}

function createBenchmarkArmLabels(status, getText) {
	const mode = status && status.mode || "off";
	const support = status && status.support || "pending";
	const evidence = status && status.evidence || "none";
	const effort = status && (status.resolvedValue || status.effort) || "—";
	let controlledKey = "benchmark_arm_disable_request";
	if (mode === "on") controlledKey = "benchmark_arm_enabled";
	else if (support === "reduced") controlledKey = "benchmark_arm_reduced";
	else if (evidence === "confirmed") controlledKey = "benchmark_arm_disabled";
	else if (evidence === "contradicted") controlledKey = "benchmark_arm_ignored";
	return {
		baseline: getText("benchmark_arm_default"),
		controlled: replaceTextSlots(getText(controlledKey), {effort})
	};
}

function getBenchmarkRecommendation(result, complete, getText) {
	if (!complete) return getText("benchmark_recommend_pending");
	if (result.evidence === "contradicted") return getText("benchmark_recommend_none");
	if ((result.controlled.successCount || 0) < (result.baseline.successCount || 0)) return getText("benchmark_recommend_default");
	const p50Delta = result.controlled.p50Ms - result.baseline.p50Ms;
	const p95Delta = result.controlled.p95Ms - result.baseline.p95Ms;
	if (p50Delta < 0 && p95Delta < 0) return getText("benchmark_recommend_current");
	if (p50Delta > 0 && p95Delta > 0) return getText("benchmark_recommend_default");
	if (p50Delta === 0 && p95Delta === 0) return getText("benchmark_recommend_none");
	return getText("benchmark_recommend_mixed");
}

function createBenchmarkResultView(result, getText) {
	if (!result) return null;
	const samplesPerArm = Math.max(1, Math.floor((Number(result.total) || SYNTHETIC_BENCHMARK_TEXTS.length * 2) / 2));
	const formatArm = arm => {
		const success = replaceTextSlots(getText("benchmark_success"), {ok: arm && arm.successCount || 0, total: samplesPerArm});
		if (!arm || arm.p50Ms == null || arm.p95Ms == null) return success;
		const reasoning = arm.reasoningTokens == null ? "" : ` · ${replaceTextSlots(getText("benchmark_reasoning_tokens"), {n: arm.reasoningTokens})}`;
		const typical = replaceTextSlots(getText("benchmark_typical"), {v: formatLatencyDuration(arm.p50Ms, getText)});
		const worst = replaceTextSlots(getText("benchmark_worst"), {v: formatLatencyDuration(arm.p95Ms, getText)});
		return `${success} · ${typical} · ${worst}${reasoning}`;
	};
	const complete = result.baseline && result.controlled && result.baseline.p50Ms != null && result.controlled.p50Ms != null;
	const compare = complete ? formatBenchmarkCompare(result.baseline.p50Ms, result.controlled.p50Ms, getText) : getText("benchmark_no_compare");
	let status = "";
	if (result.cancelled || result.reason === "cancelled") status = replaceTextSlots(getText("benchmark_cancelled"), {sent: result.completed || 0, total: result.total || SYNTHETIC_BENCHMARK_TEXTS.length * 2});
	else if (result.reason === "stale") status = getText("benchmark_stale");
	else if (result.reason && !complete) status = getText(`benchmark_error_${result.reason}`);
	else status = getBenchmarkRecommendation(result, complete, getText);
	const armLabels = createBenchmarkArmLabels(result, getText);
	return {
		rows: [
			{key: armLabels.baseline, value: formatArm(result.baseline)},
			{key: armLabels.controlled, value: formatArm(result.controlled)},
			{key: getText("benchmark_change"), value: compare}
		],
		status,
		tone: complete && result.controlled.p50Ms < result.baseline.p50Ms && result.controlled.p95Ms < result.baseline.p95Ms ? "ok" : complete ? "warn" : "neutral"
	};
}

function getSafeValidationErrorParameter(validation) {
	const parameter = validation && typeof validation.errorParameter == "string" ? validation.errorParameter : "";
	return /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(parameter) ? parameter : "";
}

// What a non-technical user can act on: the failure, the HTTP status, how long it
// took and the localized error class. Wire parameter names, resolved values and the
// previous reasoning verdict are deliberately left out - they belong in the title.
function createValidationPublicSummary(validation, getText) {
	if (!validation) return "";
	const statusCode = Number(validation.httpStatus) || null;
	const duration = validation.durationMs == null ? null : formatLatencyDuration(validation.durationMs, getText);
	return [
		`${getText("model_validation_failure")}${statusCode ? ` · HTTP ${statusCode}` : ""}`,
		duration == null ? getText("model_validation_see_toast") : replaceTextSlots(getText("latency_failure"), {duration}),
		validation.errorClass ? getText(getLatencyErrorTextKey(validation.errorClass)) : ""
	].filter(Boolean).join(" · ");
}

function createModelValidationView(validation, model, getText) {
	if (!validation) return null;
	if (validation.loading) return {tone: "neutral", main: getText("model_validation_loading"), detail: ""};
	const ok = !!validation.ok;
	const statusCode = Number(validation.httpStatus) || null;
	const main = ok
		? replaceTextSlots(getText("model_validation_success"), {model: model || "—"})
		: `${getText("model_validation_failure")}${statusCode ? ` · HTTP ${statusCode}` : ""}`;
	const duration = validation.durationMs == null ? null : formatLatencyDuration(validation.durationMs, getText);
	let detail = duration == null
		? getText("model_validation_see_toast")
		: replaceTextSlots(getText(ok ? "latency_response" : "latency_failure"), {duration});
	if (!ok && validation.errorClass) detail += ` · ${getText(getLatencyErrorTextKey(validation.errorClass))}`;
	let detailTone = "neutral";
	const errorParameter = getSafeValidationErrorParameter(validation);
	if (!ok && errorParameter) detail += ` · ${errorParameter}`;
	if (validation.reasoningSupport && validation.reasoningSupport !== "provider_default") {
		const reasoning = createReasoningStatusView({mode: validation.reasoningMode, support: validation.reasoningSupport, resolvedValue: validation.reasoningResolvedValue, evidence: validation.reasoningEvidence}, getText);
		detail += ` · ${reasoning.text}`;
		detailTone = reasoning.tone;
	}
	return {tone: ok ? "ok" : "fail", main, detail, detailTone};
}

function isBenchmarkSlower(result) {
	if (!result || result.reason || !result.baseline || !result.controlled) return false;
	if ((result.controlled.successCount || 0) < (result.baseline.successCount || 0)) return true;
	return Number.isFinite(result.baseline.p50Ms) && Number.isFinite(result.baseline.p95Ms)
		&& Number.isFinite(result.controlled.p50Ms) && Number.isFinite(result.controlled.p95Ms)
		&& result.controlled.p50Ms > result.baseline.p50Ms && result.controlled.p95Ms > result.baseline.p95Ms;
}

// The visible level is always a localized human label: raw wire values (none,
// budget=128, think=low) belong in the title, never in the sentence.
function createCustomProviderStatusView({validation = null, stale = false, manualPending = false, strategy = "auto", interfaceStatus = null, reasoningState = {}, benchmarkResult = null, model = ""} = {}, getText, getFormatLabel) {
	const semantic = resolveCustomProviderStatus({
		detecting: !!(validation && validation.loading),
		error: !!(validation && !validation.loading && validation.ok === false && !stale),
		stale,
		manualPending,
		benchmarkWarning: isBenchmarkSlower(benchmarkResult),
		strategy,
		validationOk: !!(validation && validation.ok),
		interfaceResolved: interfaceStatus && interfaceStatus.resolved || "",
		reasoning: reasoningState
	});
	const format = getFormatLabel && getFormatLabel(interfaceStatus && interfaceStatus.resolved || "") || "";
	if (semantic.key === "custom_status_error") {
		// A failed request never carries the previous "reasoning disabled" verdict: the
		// two together read as a contradiction on one line. The visible line stays at
		// "result + human reason"; the HTTP status, the timing and the wire parameter
		// ride in the title and in the diagnostics disclosure.
		const statusCode = Number(validation && validation.httpStatus) || null;
		const reason = validation && validation.errorClass ? getText(getLatencyErrorTextKey(validation.errorClass)) : statusCode ? `HTTP ${statusCode}` : "";
		const text = [getText("model_validation_failure"), reason].filter(Boolean).join(" · ");
		const summary = createValidationPublicSummary(validation, getText) || text;
		return {tone: "fail", text, latency: "", title: [summary, getSafeValidationErrorParameter(validation), format].filter(Boolean).join(" · ")};
	}
	// The rejected-value sentence names the exact raw the user has stored, never a
	// localized tier word: the whole point is that this value is the one being refused.
	// The one value every sentence may name is the one that goes on the wire.
	const dispatched = reasoningState && reasoningState.dispatchedRaw;
	const raw = dispatched !== undefined && dispatched !== null && dispatched !== ""
		? String(dispatched)
		: reasoningState && reasoningState.onRaw !== undefined && reasoningState.onRaw !== null ? String(reasoningState.onRaw) : String(reasoningState && reasoningState.effort || "");
	const sentence = replaceTextSlots(getText(semantic.key), {raw});
	// One format for every state: the sentence is the conclusion, and any probe that
	// completed reports its round-trip time on its own second line - including while
	// following the provider, where the timing is the user's first speed read.
	const latency = validation && validation.ok && !stale && validation.durationMs != null
		? replaceTextSlots(getText("latency_response"), {duration: formatLatencyDuration(validation.durationMs, getText)})
		: "";
	// The provider's own thinking counter for this probe rides next to the timing.
	// A compatible relay's zero is displayed as reported telemetry, not promoted into
	// a conclusion: the relay may have rewritten the request or erased usage details.
	const usageTokens = validation && validation.ok && !stale && validation.reasoningTokens != null && Number.isFinite(Number(validation.reasoningTokens)) ? Number(validation.reasoningTokens) : null;
	// A Responses reply echoes the effort actually in force, so the sentence can name
	// the level the server substituted instead of hinting at an unnamed one. Chat
	// replies never carry it; those keep the generic sentences.
	const echoRaw = validation && validation.ok && !stale && typeof validation.reasoningEchoRaw == "string" && validation.reasoningEchoRaw.trim() ? validation.reasoningEchoRaw.trim() : "";
	let verdict = sentence;
	let tone = semantic.tone;
	if (echoRaw && semantic.key === "custom_status_off_not_applied") verdict = replaceTextSlots(getText("custom_status_off_not_applied_actual"), {actual: echoRaw});
	else if (echoRaw && reasoningState && reasoningState.mode === "on" && raw && echoRaw.toLowerCase() !== raw.toLowerCase()
		&& (semantic.key === "custom_status_thinking_on_confirmed" || semantic.key === "custom_status_setting_sent_unconfirmed")) {
		verdict = replaceTextSlots(getText("custom_status_on_substituted"), {raw, actual: echoRaw});
		tone = "warn";
	}
	const meta = [latency, usageTokens != null ? replaceTextSlots(getText("reasoning_usage_reported"), {n: usageTokens}) : "", echoRaw ? replaceTextSlots(getText("reasoning_echo_reported"), {raw: echoRaw}) : ""].filter(Boolean).join(" · ");
	const text = semantic.decorator ? replaceTextSlots(getText(semantic.decorator), {result: verdict}) : verdict;
	const compatibleZeroUnconfirmed = usageTokens === 0 && reasoningState && reasoningState.evidence === "none"
		&& ["openai_chat", "openai_responses"].includes(interfaceStatus && interfaceStatus.resolved);
	// Safe title: the sentence plus the resolved API type and the exact accepted value.
	// No endpoint, key, header or message text ever reaches it.
	return {
		tone,
		text,
		latency: meta,
		title: [text, compatibleZeroUnconfirmed ? getText("thinking_zero_unconfirmed_tip") : "", format, raw, meta].filter(Boolean).join(" · ")
	};
}

function createTtftGateSnapshot(snapshot = {}) {
	const liveSampleCount = Math.max(0, Number(snapshot.liveSampleCount) || 0);
	const ttftSampleCount = Math.max(0, Number(snapshot.liveTtftSampleCount) || 0);
	const totalP50 = snapshot.liveP50Ms == null ? null : Math.max(0, Number(snapshot.liveP50Ms) || 0);
	const ttftP50 = snapshot.liveTtftP50Ms == null ? null : Math.max(0, Number(snapshot.liveTtftP50Ms) || 0);
	const ready = !!snapshot.liveSufficient && !!snapshot.liveTtftSufficient && totalP50 != null && ttftP50 != null && totalP50 > 0;
	const leadMs = ready ? Math.max(0, totalP50 - ttftP50) : null;
	const ratioPercent = ready ? Math.round(ttftP50 / totalP50 * 100) : null;
	return Object.freeze({ready, passed: ready && ratioPercent <= 60 && leadMs >= 500, leadMs, ratioPercent, sampleCount: Math.min(liveSampleCount, ttftSampleCount)});
}

function createAiPerformanceRows(snapshot = {}, getEngineLabel, getText, attemptSnapshot = {}) {
	const formatAttempt = (attempt, emptyKey) => {
		if (!attempt) return {value: getText(emptyKey), tone: "neutral"};
		const provider = attempt.engineKey && getEngineLabel(attempt.engineKey) || getText("ai_latency_unknown_provider");
		const duration = formatLatencyDuration(attempt.transportMs, getText);
		let value = `${provider} · ${attempt.status == "ok" ? duration : replaceTextSlots(getText("latency_failure"), {duration})}`;
		if (attempt.role == "backup") value += ` (${getText("ai_latency_backup")})`;
		if (attempt.status != "ok") {
			if (attempt.httpStatus) value += ` · HTTP ${attempt.httpStatus}`;
			if (attempt.errorClass) value += ` · ${getText(getLatencyErrorTextKey(attempt.errorClass))}`;
		}
		return {value, tone: attempt.status == "ok" ? "neutral" : "fail"};
	};
	const translationAttempt = snapshot.latestTranslation || null;
	const detectAttempt = snapshot.latestDetect || null;
	const latestTranslation = formatAttempt(translationAttempt, "ai_latency_no_translation");
	const latestDetection = formatAttempt(detectAttempt, "ai_latency_no_detection");
	const queueWaitValue = snapshot.queueWaitMs == null ? "—" : formatLatencyDuration(snapshot.queueWaitMs, getText);
	const sampleCount = Math.max(0, Number(snapshot.sampleCount) || 0);
	const responseSamplesValue = snapshot.sufficient && snapshot.p50Ms != null && snapshot.p95Ms != null
		? replaceTextSlots(getText("ai_latency_sample_summary"), {
			n: sampleCount,
			p50: formatLatencyDuration(snapshot.p50Ms, getText),
			p95: formatLatencyDuration(snapshot.p95Ms, getText)
		})
		: replaceTextSlots(getText("ai_latency_insufficient"), {n: sampleCount});
	const queueSampleCount = Math.max(0, Number(snapshot.queueSampleCount) || 0);
	const queueSamplesValue = snapshot.queueSufficient && snapshot.queueP50Ms != null && snapshot.queueP95Ms != null
		? replaceTextSlots(getText("ai_latency_sample_summary"), {
			n: queueSampleCount,
			p50: formatLatencyDuration(snapshot.queueP50Ms, getText),
			p95: formatLatencyDuration(snapshot.queueP95Ms, getText)
		})
		: replaceTextSlots(getText("ai_latency_insufficient"), {n: queueSampleCount});
	const liveSampleCount = Math.max(0, Number(snapshot.liveSampleCount) || 0);
	const liveSamplesValue = snapshot.liveSufficient && snapshot.liveP50Ms != null && snapshot.liveP95Ms != null
		? replaceTextSlots(getText("ai_latency_sample_summary"), {n: liveSampleCount, p50: formatLatencyDuration(snapshot.liveP50Ms, getText), p95: formatLatencyDuration(snapshot.liveP95Ms, getText)})
		: replaceTextSlots(getText("ai_latency_insufficient"), {n: liveSampleCount});
	const ttftSampleCount = Math.max(0, Number(snapshot.liveTtftSampleCount) || 0);
	const ttftSamplesValue = snapshot.liveTtftSufficient && snapshot.liveTtftP50Ms != null && snapshot.liveTtftP95Ms != null
		? replaceTextSlots(getText("ai_latency_sample_summary"), {n: ttftSampleCount, p50: formatLatencyDuration(snapshot.liveTtftP50Ms, getText), p95: formatLatencyDuration(snapshot.liveTtftP95Ms, getText)})
		: replaceTextSlots(getText("ai_latency_insufficient"), {n: ttftSampleCount});
	const ttftGate = createTtftGateSnapshot(snapshot);
	const ttftGateValue = ttftGate.ready
		? replaceTextSlots(getText("ai_latency_ttft_gate_summary"), {lead: formatLatencyDuration(ttftGate.leadMs, getText), ratio: ttftGate.ratioPercent, status: getText(ttftGate.passed ? "ai_latency_gate_met" : "ai_latency_gate_not_met")})
		: replaceTextSlots(getText("ai_latency_insufficient"), {n: ttftGate.sampleCount});
	const streamCountsValue = [snapshot.streamAttemptCount, snapshot.streamChunkCount, snapshot.streamFallbackCount, snapshot.streamCancelCount].map(value => Math.max(0, Number(value) || 0)).join(" / ");
	const resourceValues = [attemptSnapshot.active, attemptSnapshot.readerCount, attemptSnapshot.timerCount].map(value => Math.max(0, Number(value) || 0));
	const resourcesValue = resourceValues.join(" / ");
	const ioBatchValue = translationAttempt
		? replaceTextSlots(getText("ai_latency_io_batch_summary"), {
			input: translationAttempt.inputChars == null ? "—" : Math.max(0, Number(translationAttempt.inputChars) || 0),
			output: translationAttempt.outputChars == null ? "—" : Math.max(0, Number(translationAttempt.outputChars) || 0),
			batch: Math.max(1, Number(translationAttempt.messageCount) || 1)
		})
		: "—";
	const timeoutCount = Math.max(0, Number(snapshot.timeoutCount) || 0);
	const rateLimitCount = Math.max(0, Number(snapshot.rateLimitCount) || 0);
	const observedCount = value => value == null || !Number.isFinite(Number(value)) ? "—" : Math.max(0, Math.floor(Number(value)));
	return [
		{key: getText("ai_latency_latest_translation"), value: latestTranslation.value, tone: latestTranslation.tone},
		{key: getText("ai_latency_latest_detection"), value: latestDetection.value, tone: latestDetection.tone, technical: true},
		{key: getText("ai_latency_queue_wait"), value: queueWaitValue, tone: "neutral"},
		{key: getText("ai_latency_live_response_samples"), value: liveSamplesValue, tone: "neutral", technical: true, tip: getText("ai_latency_percentiles_tip")},
		{key: getText("ai_latency_ttft_samples"), value: ttftSamplesValue, tone: "neutral", technical: true},
		{key: getText("ai_latency_ttft_gate"), value: ttftGateValue, tone: ttftGate.ready ? ttftGate.passed ? "ok" : "fail" : "neutral", technical: true, reportOnly: true},
		{key: getText("ai_latency_stream_counts"), value: streamCountsValue, tone: "neutral", technical: true},
		{key: getText("ai_latency_stream_resources"), value: resourcesValue, tone: "neutral", technical: true, reportOnly: true},
		{key: getText("ai_latency_response_samples"), value: responseSamplesValue, tone: "neutral", technical: true},
		{key: getText("ai_latency_queue_samples"), value: queueSamplesValue, tone: "neutral", technical: true},
		{key: getText("ai_latency_io_batch"), value: ioBatchValue, tone: "neutral", technical: true, tip: getText("ai_latency_units_tip")},
		{key: getText("ai_latency_failovers"), value: String(Math.max(0, Number(snapshot.failoverCount) || 0)), tone: "neutral"},
		{key: getText("ai_latency_timeout_rate_limit"), value: `${timeoutCount} / ${rateLimitCount}`, tone: timeoutCount || rateLimitCount ? "fail" : "neutral"},
		{key: getText("ai_latency_transport_attempts"), value: replaceTextSlots(getText("ai_latency_transport_attempts_summary"), {attempts: observedCount(snapshot.attemptTotalCount), batches: observedCount(snapshot.batchRequestCount)}), tone: "neutral", technical: true}
	];
}

const W0_REPAIR_REASONS = Object.freeze([
	"malformed", "unknown-id", "duplicate-id", "missing-id", "empty",
	"placeholder-mismatch", "wrong-language", "too-similar", "attempt-budget",
	"body-budget", "token-budget", "capability-unverified", "unknown"
]);
const W0_FALLBACK_REASONS = Object.freeze(["root-malformed", "root-schema-incompatible", "unknown"]);
const W0_BATCH_SHAPES = BATCH_ANSWER_SHAPES;
const W0_BUDGET_COUNTERS = Object.freeze(["attempt", "body", "token", "capability"]);
const W0_LEAK_COUNTERS = Object.freeze(["configuredTerm", "wrapperContent", "email", "bareDomain", "ipPort", "command"]);

// Copy diagnostics is a second privacy boundary after provider-latency-store. Never
// spread the owner snapshot: a future producer mistake must not publish text, endpoint
// or credential-shaped extras. Only fixed keys whose values are anonymous counts pass.
function sanitizeWireObservationDiagnostics(value = {}) {
	const input = value && typeof value == "object" && !Array.isArray(value) ? value : {};
	const count = raw => {
		const numeric = Number(raw);
		return Number.isFinite(numeric) ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(numeric))) : 0;
	};
	const presentCounts = (raw, allowed) => {
		const source = raw && typeof raw == "object" && !Array.isArray(raw) ? raw : {};
		const output = {};
		for (const key of allowed) if (Object.prototype.hasOwnProperty.call(source, key)) output[key] = count(source[key]);
		return Object.freeze(output);
	};
	const fixedCounts = (raw, allowed) => {
		const source = raw && typeof raw == "object" && !Array.isArray(raw) ? raw : {};
		return Object.freeze(Object.fromEntries(allowed.map(key => [key, count(source[key])])));
	};
	const localSource = input.latestLocal && typeof input.latestLocal == "object" && !Array.isArray(input.latestLocal) ? input.latestLocal : null;
	const nullable = raw => raw == null || !Number.isFinite(Number(raw)) ? null : count(raw);
	const latestLocal = localSource ? Object.freeze({schemaVersion: localSource.schemaVersion === "w0-1" ? "w0-1" : null, wireFamily: ["typed-json", "native-multi", "classic-marked", "legacy-single", "legacy-batch", "compact-order", "compact-marker", "whole-marker", "whole", "unknown"].includes(String(localSource.wireFamily || "")) ? String(localSource.wireFamily) : "unknown", wireVersion: /^[A-Za-z0-9._:-]{1,32}$/.test(String(localSource.wireVersion || "")) ? String(localSource.wireVersion) : null, sourceBytes: nullable(localSource.sourceBytes), translateBytes: nullable(localSource.translateBytes), wireBytes: nullable(localSource.wireBytes), promptBytes: nullable(localSource.promptBytes), metadataBytes: nullable(localSource.metadataBytes), requestBodyBytes: nullable(localSource.requestBodyBytes), wireAmplification: localSource.wireAmplification == null || !Number.isFinite(Number(localSource.wireAmplification)) ? null : Math.max(0, Number(localSource.wireAmplification)), segmentCount: nullable(localSource.segmentCount), itemCount: nullable(localSource.itemCount), contextIncluded: localSource.contextIncluded === true, contextBytes: nullable(localSource.contextBytes), protectedMarkerBytes: nullable(localSource.protectedMarkerBytes), prohibitedFieldCount: nullable(localSource.prohibitedFieldCount), danglingContextRefCount: nullable(localSource.danglingContextRefCount), danglingContextRefBytes: nullable(localSource.danglingContextRefBytes), configuredTermLeakCount: nullable(localSource.configuredTermLeakCount), wrapperContentLeakCount: nullable(localSource.wrapperContentLeakCount), emailLeakCount: nullable(localSource.emailLeakCount), bareDomainLeakCount: nullable(localSource.bareDomainLeakCount), ipPortLeakCount: nullable(localSource.ipPortLeakCount), commandLeakCount: nullable(localSource.commandLeakCount), protectedIntegrity: ["pass", "fail", "unknown"].includes(String(localSource.protectedIntegrity || "")) ? String(localSource.protectedIntegrity) : "unknown"}) : null;
	return Object.freeze({
		schemaVersion: "w0-1",
		generation: count(input.generation),
		attemptCount: count(input.attemptCount),
		localSampleCount: count(input.localSampleCount),
		latestLocal,
		repairReasonCounts: presentCounts(input.repairReasonCounts, W0_REPAIR_REASONS),
		fallbackReasonCounts: presentCounts(input.fallbackReasonCounts, W0_FALLBACK_REASONS),
		batchShapeCounts: presentCounts(input.batchShapeCounts, W0_BATCH_SHAPES),
		batchAnswerCount: count(input.batchAnswerCount),
		recentBatchAnswers: Object.freeze((Array.isArray(input.recentBatchAnswers) ? input.recentBatchAnswers.slice(-MAX_RECENT_BATCH_ANSWERS) : []).map(sanitizeBatchAnswerObservation).filter(Boolean)),
		budgetCounts: fixedCounts(input.budgetCounts, W0_BUDGET_COUNTERS),
		leakCounts: fixedCounts(input.leakCounts, W0_LEAK_COUNTERS),
		display: Object.freeze({latestMs: input.display && input.display.latestMs != null ? count(input.display.latestMs) : null, confirmedCount: count(input.display && input.display.confirmedCount), deferredCount: count(input.display && input.display.deferredCount), staleCount: count(input.display && input.display.staleCount), failedCount: count(input.display && input.display.failedCount)})
	});
}

// W3 compile shadow summary for the copy payload: fixed keys, counts and permille quantiles
// only. The store already refuses text; this second boundary keeps the copy shape closed.
function sanitizeCompactWireShadowDiagnostics(value = {}) {
	const input = value && typeof value == "object" && !Array.isArray(value) ? value : {};
	const count = raw => {const numeric = Number(raw); return Number.isFinite(numeric) ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(numeric))) : 0;};
	const nullable = raw => raw == null || !Number.isFinite(Number(raw)) ? null : count(raw);
	const quantile = raw => {const source = raw && typeof raw == "object" && !Array.isArray(raw) ? raw : {}; return Object.freeze({count: count(source.count), p50: nullable(source.p50), p95: nullable(source.p95), max: nullable(source.max)});};
	const batches = input.batches && typeof input.batches == "object" && !Array.isArray(input.batches) ? input.batches : {};
	return Object.freeze({
		schemaVersion: input.schemaVersion === "w3-shadow-1" ? "w3-shadow-1" : null,
		contractRevision: /^[a-z0-9_.:-]{1,48}$/.test(String(input.contractRevision || "")) ? String(input.contractRevision) : null,
		count: count(input.count),
		okCount: count(input.okCount),
		identityMismatchCount: count(input.identityMismatchCount),
		budgetFailCount: count(input.budgetFailCount),
		compileFailedCount: count(input.compileFailedCount),
		prohibitedCount: count(input.prohibitedCount),
		windowedCount: count(input.windowedCount),
		windowedPermille: nullable(input.windowedPermille),
		bodyRatioPermille: quantile(input.bodyRatioPermille),
		inputRatioPermille: quantile(input.inputRatioPermille),
		compileMicros: quantile(input.compileMicros),
		typedBytes: count(input.typedBytes),
		dBytes: count(input.dBytes),
		batches: Object.freeze({count: count(batches.count), itemCount: count(batches.itemCount), typedBatchBytes: count(batches.typedBatchBytes), dBytesSum: count(batches.dBytesSum), bodyRatioPermille: quantile(batches.bodyRatioPermille), inputRatioPermille: quantile(batches.inputRatioPermille)})
	});
}

function createDiagnosticsCopyPayload(basePayload = {}, aiPerformance = {}) {
	const safeWireObservation = sanitizeWireObservationDiagnostics(aiPerformance && aiPerformance.wireObservation);
	const safeCompactWireShadow = sanitizeCompactWireShadowDiagnostics(aiPerformance && aiPerformance.compactWireShadow);
	return Object.assign({}, basePayload, {
		metricDefinitions: {
			providerDispatchCount: "Per-message route participation in provider dispatches; shared batches count once per participating message. Do not sum as HTTP requests.",
			inputChars: "UTF-16 code units of the input string recorded by that route. Typed/history paths can include serialization and protection markers; this is not original-text characters, tokens, or request-body bytes.",
			outputChars: "UTF-16 code units of the output string observed at the provider adapter; this is not tokens or UTF-8 bytes.",
			transportAttempts: "Existing provider-latency-store attempt outcomes since the last diagnostics reset, including failures and cancellations. Counts do not establish upstream receipt or billing.",
			byteFields: "sourceBytes, translateBytes, wireBytes, promptBytes, metadataBytes and requestBodyBytes measure UTF-8 bytes at their named boundary. Null means unobserved; do not derive bytes from inputChars."
		},
		wireObservation: safeWireObservation,
		compactWireShadow: safeCompactWireShadow,
		aiPerformance: Object.assign({}, aiPerformance, {wireObservation: safeWireObservation, compactWireShadow: safeCompactWireShadow})
	});
}

function createAiLatencyDiagnosticsPayload(snapshot = {}, attemptSnapshot = {}) {
	const nullableCount = value => value == null || !Number.isFinite(Number(value)) ? null : Math.max(0, Math.floor(Number(value)));
	const safeEnum = (value, allowed, fallback) => allowed.includes(String(value || "")) ? String(value) : fallback;
	const sanitizeAttempt = attempt => attempt ? {
		engineKey: String(attempt.engineKey || ""),
		kind: String(attempt.kind || ""),
		durationMs: Math.max(0, Number(attempt.transportMs) || 0),
		queueWaitMs: attempt.queueWaitMs == null ? null : Math.max(0, Number(attempt.queueWaitMs) || 0),
		status: String(attempt.status || ""),
		httpStatus: attempt.httpStatus == null ? null : Number(attempt.httpStatus),
		errorClass: attempt.errorClass || null,
		role: safeEnum(attempt.role, ["primary", "repair", "backup", "fallback"], "primary"),
		attempt: Math.max(0, Number(attempt.attempt) || 0),
		messageCount: Math.max(1, Number(attempt.messageCount) || 1),
		inputChars: attempt.inputChars == null ? null : Math.max(0, Number(attempt.inputChars) || 0),
		outputChars: attempt.outputChars == null ? null : Math.max(0, Number(attempt.outputChars) || 0),
		streaming: !!attempt.streaming,
		ttftMs: attempt.ttftMs == null ? null : Math.max(0, Number(attempt.ttftMs) || 0),
		streamChunkCount: Math.max(0, Number(attempt.streamChunkCount) || 0),
		streamFallback: !!attempt.streamFallback,
		lane: safeEnum(attempt.lane, ["manual", "auto-single", "history-primary", "batch-repair", "item-repair", "live-burst", "reply", "embed-forward", "sent", "cache-hit", "unknown"], "unknown"),
		engineFamily: safeEnum(attempt.engineFamily, ["custom", "ai", "native", "classic", "unknown"], "unknown"),
		providerMs: nullableCount(attempt.providerMs),
		leaseWaitMs: nullableCount(attempt.leaseWaitMs),
		enqueueToDomMs: nullableCount(attempt.enqueueToDomMs),
		promptTokens: nullableCount(attempt.promptTokens),
		completionTokens: nullableCount(attempt.completionTokens),
		reasoningTokens: nullableCount(attempt.reasoningTokens),
		requestCount: nullableCount(attempt.requestCount),
		repairCount: nullableCount(attempt.repairCount),
		fallbackCount: nullableCount(attempt.fallbackCount),
		outcome: safeEnum(attempt.outcome, ["translated", "skipped", "failed", "cancelled", "stale"], "failed"),
		stage: safeEnum(attempt.stage, ["precheck", "protection", "cache", "provider", "parse", "placeholder", "target-language", "similarity", "repair", "display-currentness"], "provider"),
		reason: attempt.reason == null ? null : safeEnum(attempt.reason, W0_REPAIR_REASONS, "unknown"),
		schemaVersion: attempt.schemaVersion === "w0-1" ? "w0-1" : null,
		wireFamily: attempt.wireFamily == null ? null : safeEnum(attempt.wireFamily, ["typed", "typed-json", "native", "native-multi", "classic", "classic-marked", "classic-tagged", "legacy", "legacy-single", "legacy-batch", "compact-order", "compact-marker", "whole-marker", "whole", "unknown"], "unknown"),
		wireVersion: attempt.wireVersion == null || !/^[A-Za-z0-9._:-]{1,32}$/.test(String(attempt.wireVersion)) ? null : String(attempt.wireVersion),
		sourceBytes: nullableCount(attempt.sourceBytes),
		translateBytes: nullableCount(attempt.translateBytes),
		wireBytes: nullableCount(attempt.wireBytes),
		promptBytes: nullableCount(attempt.promptBytes),
		metadataBytes: nullableCount(attempt.metadataBytes),
		requestBodyBytes: nullableCount(attempt.requestBodyBytes),
		wireAmplification: attempt.wireAmplification == null || !Number.isFinite(Number(attempt.wireAmplification)) ? null : Math.max(0, Number(attempt.wireAmplification)),
		segmentCount: nullableCount(attempt.segmentCount),
		itemCount: nullableCount(attempt.itemCount),
		contextIncluded: !!attempt.contextIncluded,
		contextBytes: nullableCount(attempt.contextBytes),
		protectedMarkerBytes: nullableCount(attempt.protectedMarkerBytes),
		prohibitedFieldCount: nullableCount(attempt.prohibitedFieldCount),
		danglingContextRefCount: nullableCount(attempt.danglingContextRefCount),
		danglingContextRefBytes: nullableCount(attempt.danglingContextRefBytes),
		configuredTermLeakCount: nullableCount(attempt.configuredTermLeakCount),
		wrapperContentLeakCount: nullableCount(attempt.wrapperContentLeakCount),
		emailLeakCount: nullableCount(attempt.emailLeakCount),
		bareDomainLeakCount: nullableCount(attempt.bareDomainLeakCount),
		ipPortLeakCount: nullableCount(attempt.ipPortLeakCount),
		commandLeakCount: nullableCount(attempt.commandLeakCount),
		protectedIntegrity: safeEnum(attempt.protectedIntegrity, ["pass", "fail", "unknown"], "unknown")
	} : null;
	const gate = createTtftGateSnapshot(snapshot);
	return {
		latestTranslation: sanitizeAttempt(snapshot.latestTranslation),
		latestDetect: sanitizeAttempt(snapshot.latestDetect),
		transportAttempts: {
			generation: nullableCount(snapshot.generation),
			settledCount: nullableCount(snapshot.attemptTotalCount),
			historicalSettledCount: nullableCount(snapshot.historicalAttemptCount),
			batchSettledCount: nullableCount(snapshot.batchRequestCount),
			batchMessageParticipations: nullableCount(snapshot.batchMessageCount)
		},
		translation: {
			sampleCount: Math.max(0, Number(snapshot.sampleCount) || 0),
			p50Ms: snapshot.p50Ms == null ? null : Math.max(0, Number(snapshot.p50Ms) || 0),
			p95Ms: snapshot.p95Ms == null ? null : Math.max(0, Number(snapshot.p95Ms) || 0)
		},
		queue: {
			latestMs: snapshot.queueWaitMs == null ? null : Math.max(0, Number(snapshot.queueWaitMs) || 0),
			sampleCount: Math.max(0, Number(snapshot.queueSampleCount) || 0),
			p50Ms: snapshot.queueP50Ms == null ? null : Math.max(0, Number(snapshot.queueP50Ms) || 0),
			p95Ms: snapshot.queueP95Ms == null ? null : Math.max(0, Number(snapshot.queueP95Ms) || 0)
		},
		live: {
			sampleCount: Math.max(0, Number(snapshot.liveSampleCount) || 0),
			p50Ms: snapshot.liveP50Ms == null ? null : Math.max(0, Number(snapshot.liveP50Ms) || 0),
			p95Ms: snapshot.liveP95Ms == null ? null : Math.max(0, Number(snapshot.liveP95Ms) || 0)
		},
		ttft: {
			sampleCount: Math.max(0, Number(snapshot.liveTtftSampleCount) || 0),
			p50Ms: snapshot.liveTtftP50Ms == null ? null : Math.max(0, Number(snapshot.liveTtftP50Ms) || 0),
			p95Ms: snapshot.liveTtftP95Ms == null ? null : Math.max(0, Number(snapshot.liveTtftP95Ms) || 0)
		},
		ttftGate: {ready: gate.ready, passed: gate.passed, leadMs: gate.leadMs, ratioPercent: gate.ratioPercent},
		stream: {
			attemptCount: Math.max(0, Number(snapshot.streamAttemptCount) || 0),
			chunkCount: Math.max(0, Number(snapshot.streamChunkCount) || 0),
			fallbackCount: Math.max(0, Number(snapshot.streamFallbackCount) || 0),
			cancelCount: Math.max(0, Number(snapshot.streamCancelCount) || 0)
		},
		resources: {
			active: Math.max(0, Number(attemptSnapshot.active) || 0),
			controllerCount: Math.max(0, Number(attemptSnapshot.controllerCount) || 0),
			readerCount: Math.max(0, Number(attemptSnapshot.readerCount) || 0),
			decoderCount: Math.max(0, Number(attemptSnapshot.decoderCount) || 0),
			timerCount: Math.max(0, Number(attemptSnapshot.timerCount) || 0),
			logicalSignalCount: Math.max(0, Number(attemptSnapshot.logicalSignalCount) || 0),
			bufferBytes: Math.max(0, Number(attemptSnapshot.bufferBytes) || 0)
		},
		wireObservation: sanitizeWireObservationDiagnostics(snapshot.wireObservation),
		compactWireShadow: sanitizeCompactWireShadowDiagnostics(snapshot.compactWireShadow),
		failoverCount: Math.max(0, Number(snapshot.failoverCount) || 0),
		timeoutCount: Math.max(0, Number(snapshot.timeoutCount) || 0),
		rateLimitCount: Math.max(0, Number(snapshot.rateLimitCount) || 0)
	};
}

// Material Symbols glyphs live in icon-paths.js so every translator surface
// (settings panel, channel popout) draws from the same table.
const {MATERIAL_ICON_PATHS} = require("./icon-paths");
const GITHUB_ICON_PATH = "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12";
const TRANSLATE_ICON_PATH = "m 9.6568988,1.9999999 c -1.141416,0 -0.951614,1.2688185 -0.951614,1.2688185 v 0.6505173 h -5.392479 c 0,0 -1.2688185,-0.1898024 -1.2688185,0.9516139 0,1.1414159 1.2688185,0.9516139 1.2688185,0.9516139 H 12.426863 C 12.695162,7.2780713 11.349082,9.1398691 9.7646988,10.765256 8.6555628,9.6878231 7.4332858,8.3134878 6.8664892,7.065981 6.6161862,6.515072 5.9881318,6.6956414 5.7283935,6.9736693 5.1836529,7.5567679 5.5785907,8.592173 6.0833902,9.3409331 c 0.246901,0.366224 1.3724726,1.5182279 2.4570966,2.5995909 -1.6322361,1.477469 -3.154699,2.550028 -3.154699,2.550028 0,0 -1.0769951,0.696378 -0.322161,1.552568 0.7548319,0.856187 1.5810669,-0.125147 1.5810669,-0.125147 0,0 1.5136611,-1.082765 3.2203701,-2.6696 0.5195872,0.508635 0.8970952,0.874172 0.8970952,0.874172 0,0 0.82821,0.985394 1.582925,0.09231 0.754714,-0.893081 -0.354377,-1.545753 -0.354377,-1.545753 0.0097,0.03486 -0.34186,-0.224086 -0.864878,-0.666625 1.804964,-1.884163 3.470802,-4.1622897 3.47686,-6.1799145 h 1.398302 c 0,0 1.268819,0.2176541 1.268819,-0.9516139 0,-1.1692683 -1.268819,-0.9516139 -1.268819,-0.9516139 H 10.608512 V 3.2688184 c 0,0 0.189804,-1.2688185 -0.9516132,-1.2688185 z M 15.056812,10.104826 10.536646,22 h 2.379035 l 0.964624,-2.537637 h 4.732049 L 19.576978,22 h 2.379035 L 17.435847,10.104826 Z m 1.189517,3.130537 1.643021,4.323772 h -3.286042 z";
// Brand marks for the AI providers, traced in the design draft.
const DEEPSEEK_ICON_PATH = "M23.748 4.651c-.254-.124-.364.113-.512.233-.051.04-.094.09-.137.137-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136 9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.328 1.78.398.629.058 1.235-.031 1.705-.129.735-.155.684-.836.418-.961-2.155-1.004-1.682-.595-2.112-.926 1.095-1.295 2.768-3.598 3.284-6.733.05-.346.115-.834.108-1.114-.004-.171.035-.238.23-.257a4.2 4.2 0 0 0 1.545-.475c1.397-.763 1.96-2.016 2.093-3.517.02-.23-.004-.467-.247-.588M11.58 18.168c-2.088-1.642-3.101-2.183-3.52-2.16-.39.024-.32.472-.234.763.09.288.207.487.371.74.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.168-1.361-.801-2.5-1.86-3.301-3.306-.775-1.393-1.225-2.888-1.299-4.482-.02-.385.094-.522.477-.592a4.7 4.7 0 0 1 1.53-.038c2.131.311 3.946 1.264 5.467 2.774.868.86 1.525 1.887 2.202 2.89.72 1.066 1.494 2.082 2.48 2.915.348.291.626.513.892.677-.802.09-2.14.109-3.055-.615zm1.001-6.44a.306.306 0 0 1 .415-.287.3.3 0 0 1 .113.074.3.3 0 0 1 .086.214c0 .17-.136.307-.308.307a.303.303 0 0 1-.306-.307m3.11 1.596c-.2.081-.4.151-.591.16a1.25 1.25 0 0 1-.798-.254c-.274-.23-.47-.358-.551-.758a1.7 1.7 0 0 1 .015-.588c.07-.327-.007-.537-.238-.727-.188-.156-.426-.199-.689-.199a.6.6 0 0 1-.254-.078.253.253 0 0 1-.114-.358 1 1 0 0 1 .192-.21c.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.392.451.462.576.685.915.176.264.336.536.446.848.066.194-.02.353-.25.45";
const OPENAI_ICON_PATH = "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z";
const GEMINI_ICON_PATH = "M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81";
// Official marks for the machine-translation providers (simple-icons paths).
const GOOGLE_ICON_PATH = "M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z";
const GOOGLECLOUD_ICON_PATH = "M12.19 2.38a9.344 9.344 0 0 0-9.234 6.893c.053-.02-.055.013 0 0-3.875 2.551-3.922 8.11-.247 10.941l.006-.007-.007.03a6.717 6.717 0 0 0 4.077 1.356h5.173l.03.03h5.192c6.687.053 9.376-8.605 3.835-12.35a9.365 9.365 0 0 0-2.821-4.552l-.043.043.006-.05A9.344 9.344 0 0 0 12.19 2.38zm-.358 4.146c1.244-.04 2.518.368 3.486 1.15a5.186 5.186 0 0 1 1.862 4.078v.518c3.53-.07 3.53 5.262 0 5.193h-5.193l-.008.009v-.04H6.785a2.59 2.59 0 0 1-1.067-.23h.001a2.597 2.597 0 1 1 3.437-3.437l3.013-3.012A6.747 6.747 0 0 0 8.11 8.24c.018-.01.04-.026.054-.023a5.186 5.186 0 0 1 3.67-1.69z";
const AZURE_ICON_PATH = "M22.379 23.343a1.62 1.62 0 0 0 1.536-2.14v.002L17.35 1.76A1.62 1.62 0 0 0 15.816.657H8.184A1.62 1.62 0 0 0 6.65 1.76L.086 21.204a1.62 1.62 0 0 0 1.536 2.139h4.741a1.62 1.62 0 0 0 1.535-1.103l.977-2.892 4.947 3.675c.28.208.618.32.966.32m-3.084-12.531 3.624 10.739a.54.54 0 0 1-.51.713v-.001h-.03a.54.54 0 0 1-.322-.106l-9.287-6.9h4.853m6.313 7.006c.116-.326.13-.694.007-1.058L9.79 1.76a1.722 1.722 0 0 0-.007-.02h6.034a.54.54 0 0 1 .512.366l6.562 19.445a.54.54 0 0 1-.338.684";
const DEEPL_ICON_PATH = "M20.907 4.93953 12.68543.18573a1.3577 1.3577 0 0 0-1.3709 0L3.09298 4.9565a1.3766 1.3766 0 0 0-.68639 1.18233v9.52646a1.3766 1.3766 0 0 0 .68639 1.19363l8.22157 4.75946.06223.03583 4.04856 2.3458-.01131-2.06106.0075-1.1446.0038.01885v-.38467c0-.23006.1188-.43371.29605-.56005l.264-.15086.12633-.06977h-.0075l4.80283-2.7795a1.3803 1.3803 0 0 0 .68639-1.19551V6.13505a1.3803 1.3803 0 0 0-.68642-1.19552m-9.85269 9.68863a1.4275 1.4275 0 0 1-.39976 1.3841 1.4086 1.4086 0 0 1-1.97054 0 1.4199 1.4199 0 0 1 0-2.06294 1.4086 1.4086 0 0 1 2.0422.07543l3.32822-1.91585.6864.38656zm5.77019-2.41367a1.4086 1.4086 0 0 1-1.97054 0 1.4256 1.4256 0 0 1-.3696-1.47837l-.0132.0075-3.7525-2.1723-.05657.05656a1.4086 1.4086 0 0 1-1.97053 0 1.4199 1.4199 0 0 1 0-2.06293 1.4086 1.4086 0 0 1 1.97242 0c.3941.37713.52422.91832.39033 1.40672l3.7808 2.20059.01886-.01886a1.4086 1.4086 0 0 1 1.97242 0 1.42746 1.42746 0 0 1 0 2.06105z";
const NAVER_ICON_PATH = "M16.273 12.845 7.376 0H0v24h7.726V11.156L16.624 24H24V0h-7.727v12.845Z";
const BAIDU_ICON_PATH = "M9.154 0C7.71 0 6.54 1.658 6.54 3.707c0 2.051 1.171 3.71 2.615 3.71 1.446 0 2.614-1.659 2.614-3.71C11.768 1.658 10.6 0 9.154 0zm7.025.594C14.86.58 13.347 2.589 13.2 3.927c-.187 1.745.25 3.487 2.179 3.735 1.933.25 3.175-1.806 3.422-3.364.252-1.555-.995-3.364-2.362-3.674a1.218 1.218 0 0 0-.261-.03zM3.582 5.535a2.811 2.811 0 0 0-.156.008c-2.118.19-2.428 3.24-2.428 3.24-.287 1.41.686 4.425 3.297 3.864 2.617-.561 2.262-3.68 2.183-4.362-.125-1.018-1.292-2.773-2.896-2.75zm16.534 1.753c-2.308 0-2.617 2.119-2.617 3.616 0 1.43.121 3.425 2.988 3.362 2.867-.063 2.553-3.238 2.553-3.988 0-.745-.62-2.99-2.924-2.99zm-8.264 2.478c-1.424.014-2.708.925-3.323 1.947-1.118 1.868-2.863 3.05-3.112 3.363-.25.309-3.61 2.116-2.864 5.42.746 3.301 3.365 3.237 3.365 3.237s1.93.19 4.171-.31c2.24-.495 4.17.123 4.17.123s5.233 1.748 6.665-1.616c1.43-3.364-.808-5.109-.808-5.109s-2.99-2.306-4.736-4.798c-1.072-1.665-2.348-2.268-3.528-2.257zm-2.234 3.84l1.542.024v8.197H7.758c-1.47-.291-2.055-1.292-2.13-1.462-.072-.173-.488-.976-.268-2.343.635-2.049 2.447-2.196 2.447-2.196h1.81zm3.964 2.39v3.881c.096.413.612.488.612.488h1.614v-4.343h1.689v5.782h-3.915c-1.517-.39-1.59-1.465-1.59-1.465v-4.317zm-5.458 1.147c-.66.197-.978.708-1.05.928-.076.22-.247.78-.1 1.269.294 1.095 1.248 1.144 1.248 1.144h1.37v-3.34z";

const credentialFieldWriters = new WeakMap();

function getCredentialFieldWriter(plugin) {
	let writer = credentialFieldWriters.get(plugin);
	if (!writer) {
		writer = createDeferredFieldWriter({
			write: (compoundKey, value) => {
				const separator = compoundKey.indexOf("\u0000");
				if (separator < 1) return;
				const engineKey = compoundKey.slice(0, separator);
				const field = compoundKey.slice(separator + 1);
				plugin.ensureSettingsStore().setCredentialField(engineKey, field, value);
				plugin.SettingsUpdated = true;
			}
		});
		credentialFieldWriters.set(plugin, writer);
	}
	return writer;
}

function flushDeferredSettingsWrites(plugin) {
	const writer = plugin && credentialFieldWriters.get(plugin);
	return writer ? writer.flushAll() : 0;
}

function renderBdfdbLoadingPanel() {
	const panel = document.createElement("div");
	panel.style.color = "var(--text-normal)";
	panel.style.fontSize = "16px";
	panel.style.lineHeight = "22px";
	panel.style.whiteSpace = "pre-wrap";
	panel.textContent = "BDFDB 正在加载，请稍后重新打开设置。\nBDFDB is loading. Please reopen settings in a few seconds.";
	return panel;
}

function renderSettingsPanel(plugin, collapseStates = {}, dependencies = {}) {
	const {BDFDB} = dependencies;
	if (typeof window == "undefined" || !window.BDFDB_Global || !window.BDFDB_Global.loaded) return renderBdfdbLoadingPanel();
	let settingsPanel;
	return settingsPanel = BDFDB.PluginUtils.createSettingsPanel(plugin, {
		collapseStates: collapseStates,
		children: _ => {
			const el = BDFDB.ReactUtils.createElement;
			const cls = BDFDB.DOMUtils.formatClassName;
			const SearchableSelect = createSearchableSelectComponent(BdApi.React, el);
			const ModelCombo = createModelComboComponent(BdApi.React, el);
			// Audit item 29: two bundles with identical metadata used to be indistinguishable
			// at runtime. The build identity line lets anyone compare the loaded plugin
			// against the repository artifact in one glance.
			const buildId = plugin.getBuildId && plugin.getBuildId();
			// Repaint-path diagnostics (2026-08-19 flicker audit): shows whether display
			// transactions run through the atomic single-task rebuild or silently fall
			// back to the two-flush rerenderAll, so a user screenshot answers the
			// question no non-technical report can.
			let rebuildStats = null;
			try {rebuildStats = plugin.ensureReceivedDisplayRuntime && plugin.ensureReceivedDisplayRuntime().getRebuildStats();}
			catch (err) {rebuildStats = null;}
			let fullRepaints = 0;
			try {fullRepaints = plugin.ensureReceivedDisplayRepaintScheduler ? plugin.ensureReceivedDisplayRepaintScheduler().getDiagnostics().fullRepaints : 0;}
			catch (err) {fullRepaints = 0;}
			const getSettingsPanelRoot = () => document.querySelector(".translator-settings-panel-root");
			const isScrollableElement = node => {
				if (!node || node == document || node == document.body || node == document.documentElement) return false;
				if (typeof node.scrollTop != "number" || typeof node.scrollHeight != "number" || typeof node.clientHeight != "number") return false;
				if (node.scrollHeight <= node.clientHeight + 1) return false;
				let overflowY = "";
				try {
					const style = window.getComputedStyle(node);
					overflowY = style && style.overflowY || "";
				}
				catch (err) {}
				// Discord/BDFDB scrollers can use generated classes or overlay/hidden overflow, so relying only on auto/scroll misses the real modal scroller.
				return overflowY != "visible" && overflowY != "clip" || node.scrollTop > 0;
			};
			const getSettingsPanelScrollElements = root => {
				const scrollers = [];
				const addScroller = node => {
					if (node && isScrollableElement(node) && !scrollers.includes(node)) scrollers.push(node);
				};
				let current = root;
				while (current && current.parentElement) {
					addScroller(current);
					current = current.parentElement;
				}
				addScroller(current);
				try {
					for (const node of document.querySelectorAll("div")) {
						if (node.scrollTop > 0) addScroller(node);
					}
				}
				catch (err) {}
				return scrollers;
			};
			let boundSettingsScrollHost = null;
			// BetterDiscord appends the rendered panel to its addon modal after the root ref
			// fires, so the host lookup polls a few frames before giving up. Every refresh
			// re-binds the ref, which also re-applies the label after a language change.
			const localizeSettingsHostModalFrom = (node, framesLeft) => {
				const general = plugin.settings && plugin.settings.general || {};
				const followsDiscord = !general.interfaceLanguage || general.interfaceLanguage == "system";
				if (findSettingsHostModal(node)) {
					localizeSettingsHostModal(node, typeof plugin.getUiLanguageId == "function" ? plugin.getUiLanguageId() : null, {followsDiscord});
					return;
				}
				if (framesLeft > 0 && typeof requestAnimationFrame == "function") requestAnimationFrame(() => localizeSettingsHostModalFrom(node, framesLeft - 1));
			};
			const bindSettingsPanelScrollHost = node => {
				if (boundSettingsScrollHost && (!node || !boundSettingsScrollHost.contains(node))) {
					boundSettingsScrollHost.classList.remove("translator-settings-scroll-host");
					boundSettingsScrollHost = null;
				}
				if (!node) return;
				localizeSettingsHostModalFrom(node, 30);
				const host = getSettingsPanelScrollElements(node).find(scroller => scroller != node && scroller.contains(node));
				if (!host || !host.classList) return;
				host.classList.add("translator-settings-scroll-host");
				boundSettingsScrollHost = host;
			};
			const captureSettingsPanelScrollState = () => {
				const root = getSettingsPanelRoot();
				if (!root) return null;
				const scrollers = getSettingsPanelScrollElements(root);
				if (!scrollers.length) return null;
				return {
					items: scrollers.map(scroller => ({
						scroller,
						scrollTop: scroller.scrollTop,
						scrollLeft: scroller.scrollLeft
					})),
					windowX: typeof window != "undefined" ? window.scrollX : 0,
					windowY: typeof window != "undefined" ? window.scrollY : 0
				};
			};
			const applySettingsPanelScrollState = scrollState => {
				if (!scrollState || !scrollState.items) return;
				for (const item of scrollState.items) {
					if (!item || !item.scroller) continue;
					const maxScrollTop = Math.max(0, item.scroller.scrollHeight - item.scroller.clientHeight);
					const maxScrollLeft = Math.max(0, item.scroller.scrollWidth - item.scroller.clientWidth);
					item.scroller.scrollTop = Math.max(0, Math.min(item.scrollTop, maxScrollTop));
					item.scroller.scrollLeft = Math.max(0, Math.min(item.scrollLeft || 0, maxScrollLeft));
				}
				if (typeof window != "undefined") window.scrollTo(scrollState.windowX || 0, scrollState.windowY || 0);
			};
			const restoreSettingsPanelScrollState = scrollState => {
				if (!scrollState) return;
				applySettingsPanelScrollState(scrollState);
				requestAnimationFrame(() => {
					applySettingsPanelScrollState(scrollState);
					requestAnimationFrame(() => applySettingsPanelScrollState(scrollState));
				});
			};
			const refreshPanel = () => {
				const scrollState = captureSettingsPanelScrollState();
				BDFDB.PluginUtils.refreshSettingsPanel(plugin, settingsPanel, collapseStates);
				restoreSettingsPanelScrollState(scrollState);
			};
			const clearModelValidation = engineKey => {
				if (plugin.settingsUiState && plugin.settingsUiState.modelValidation && plugin.settingsUiState.modelValidation.engine == engineKey) plugin.settingsUiState.modelValidation = Object.assign({}, plugin.settingsUiState.modelValidation, {loading: false, stale: true});
			};
			const saveAuthField = (engineKey, field, value) => {
				clearModelValidation(engineKey);
				getCredentialFieldWriter(plugin).schedule(`${engineKey}\u0000${field}`, value);
				plugin.SettingsUpdated = true;
			};
			const flushAuthField = (engineKey, field) => getCredentialFieldWriter(plugin).flush(`${engineKey}\u0000${field}`);
			const flushAuthFieldAndRefresh = (engineKey, field) => {flushAuthField(engineKey, field); refreshPanel();};
			const saveAuthFieldImmediately = (engineKey, field, value) => {
				clearModelValidation(engineKey);
				getCredentialFieldWriter(plugin).flush(`${engineKey}\u0000${field}`);
				plugin.ensureSettingsStore().setCredentialField(engineKey, field, value);
				plugin.SettingsUpdated = true;
			};
			const isChineseUi = plugin.isChineseUiLanguage();
			const isRussianUi = plugin.isRussianUiLanguage();
			const compactText = (zh, en, ru = null) => isChineseUi ? zh : isRussianUi ? (ru || en) : en;
			/* ===== drawing primitives (mk-* anatomy) ===== */
			const createIcon = (name, size = 15) => el("svg", {
				viewBox: "0 -960 960 960",
				width: size,
				height: size,
				"aria-hidden": true,
				children: el("path", {fill: "currentColor", d: MATERIAL_ICON_PATHS[name] || ""})
			});
			const createBrandIcon = (path, fill) => el("svg", {
				viewBox: "0 0 24 24",
				"aria-hidden": true,
				children: el("path", {fill: fill || "currentColor", d: path})
			});
			const createTranslateGlyph = () => el("svg", {
				viewBox: "0 0 24 24",
				"aria-hidden": true,
				children: el("path", {fill: "currentColor", d: TRANSLATE_ICON_PATH})
			});
			const createGeminiIcon = () => el("svg", {
				viewBox: "0 0 24 24",
				"aria-hidden": true,
				children: [
					el("defs", {children: el("linearGradient", {id: "translatorGeminiGradient", x1: "0", y1: "0", x2: "1", y2: "1", children: [
						el("stop", {offset: "0", stopColor: "#5684F7"}),
						el("stop", {offset: "1", stopColor: "#9168C9"})
					]})}),
					el("path", {fill: "url(#translatorGeminiGradient)", d: GEMINI_ICON_PATH})
				]
			});
			const infoText = text => el("div", {className: "translator-settings-note", children: text});
			const createInfoTip = text => text && el(BDFDB.LibraryComponents.TooltipContainer, {
				text,
				tooltipConfig: {type: "bottom", style: "max-width: 300px; white-space: normal;"},
				children: el("button", {
					type: "button",
					className: "translator-info-tip",
					"aria-label": text,
					onClick: event => event && event.preventDefault && event.preventDefault(),
					children: createIcon("info", 13)
				})
			});
			const createGroupHeader = (text, tip = null) => el("div", {
				className: "translator-group",
				children: [text, tip && createInfoTip(tip)].filter(Boolean)
			});
			const createSplit = () => el("div", {className: "translator-split", "aria-hidden": true});
			const createRowLabel = (label, tip) => el("span", {
				className: "translator-row-label",
				children: [label, tip && createInfoTip(tip)].filter(Boolean)
			});
			const createSettingRow = ({label, tip = null, control = null, dependent = false, disabled = false, className = "", key = null, note = null}) => el("div", {
				key: key || undefined,
				className: cls("translator-row", dependent && "translator-settings-dependent-row", disabled && "translator-settings-dependent-disabled", className),
				children: [
					createRowLabel(label, tip),
					control && el("div", {className: "translator-row-control", children: control}),
					note && el("div", {className: "translator-row-note", children: note})
				].filter(Boolean)
			});
			const createFieldLabel = (label, tip = null) => el("div", {
				className: "translator-field-label",
				children: [label, tip && createInfoTip(tip)].filter(Boolean)
			});
			const createSwitch = ({value, onChange, disabled = false, label = null}) => el("button", {
				type: "button",
				role: "switch",
				"aria-checked": !!value,
				"aria-label": label || undefined,
				disabled,
				className: cls("translator-switch", value && "translator-switch-on"),
				onClick: _ => !disabled && onChange(!value)
			});
			const createButton = ({label, onClick, kind = "secondary", icon = null, disabled = false, title = null, className = null, performanceAction = null}) => el("button", {
				type: "button",
				disabled,
				title: title || undefined,
				"data-performance-action": performanceAction || undefined,
				className: cls("translator-btn", kind == "secondary" && "translator-btn-sec", kind == "green" && "translator-btn-green", className),
				onClick,
				children: [icon, label].filter(Boolean)
			});
			// Legacy name kept: several handlers below still call createActionButton.
			const createActionButton = ({label, onClick, kind = "secondary", icon = null, disabled = false, className = null}) => createButton({label, onClick, kind, icon, disabled, className});
			const createIconButton = ({icon, onClick, danger = false, title = null, disabled = false, attrs = null}) => el("button", Object.assign({
				type: "button",
				disabled,
				title: title || undefined,
				"aria-label": title || undefined,
				className: cls("translator-iconbtn", danger && "translator-iconbtn-danger"),
				onClick,
				children: icon
			}, attrs || {}));
			const createMiniButton = ({icon, onClick, danger = false, title = null}) => el("button", {
				type: "button",
				title: title || undefined,
				"aria-label": title || undefined,
				className: cls("translator-minibtn", danger && "translator-minibtn-danger"),
				onClick,
				children: icon
			});
			const createPortalLink = ({label, icon, url, onClick}) => el("button", {
				type: "button",
				className: "translator-portal",
				onClick: onClick || (_ => BDFDB.DiscordUtils.openLink(url)),
				children: [icon, label].filter(Boolean)
			});
			const createCustomSelect = props => el(SearchableSelect, Object.assign({
				// A three-item list with a search box reads as a much bigger decision than
				// it is, so the field only appears once a list is genuinely long.
				searchThreshold: 8,
				searchPlaceholder: compactText("搜索选项", "Search options", "Поиск вариантов"),
				emptyLabel: compactText("没有匹配项", "No matching options", "Нет совпадений")
			}, props));
			const createSearchableSelect = props => createCustomSelect(Object.assign({
				searchPlaceholder: compactText("搜索语言或代码", "Search language or code", "Поиск языка или кода"),
				emptyLabel: compactText("没有匹配项", "No matching options", "Нет совпадений")
			}, props));
			const createSelectIn = (width, props) => el("div", {style: {width: typeof width == "number" ? `${width}px` : width, maxWidth: "100%", minWidth: 0}, children: createCustomSelect(props)});
			const ensureSecretInputState = () => {
				if (!plugin.secretInputState) plugin.secretInputState = {};
				return plugin.secretInputState;
			};
			const isSecretFieldVisible = fieldKey => !!ensureSecretInputState()[fieldKey];
			const toggleSecretFieldVisibility = fieldKey => {
				const secretState = ensureSecretInputState();
				secretState[fieldKey] = !secretState[fieldKey];
				refreshPanel();
			};
			// Uncontrolled inputs on purpose: keystrokes go through the deferred writer
			// without re-rendering the panel, and the `key` remounts the field with the
			// stored value whenever the user switches providers.
			const createTextField = ({fieldKey, placeholder, value, onChange, onBlur, type = "text", mono = false, ariaLabel = null}) => el("input", {
				key: fieldKey,
				type,
				className: "translator-input",
				style: mono ? {fontFamily: "var(--font-code, Consolas, monospace)", fontSize: "13px"} : undefined,
				placeholder,
				"aria-label": ariaLabel || undefined,
				defaultValue: value || "",
				spellCheck: false,
				onChange: event => onChange(event.target.value),
				onBlur: onBlur || undefined
			});
			const createSecretInput = ({fieldKey, placeholder, value, onChange, onBlur, ariaLabel = null}) => el("div", {
				className: "translator-input-wrap",
				children: [
					createTextField({fieldKey: `${fieldKey}-${isSecretFieldVisible(fieldKey) ? "text" : "password"}`, type: isSecretFieldVisible(fieldKey) ? "text" : "password", placeholder, value, onChange, onBlur, ariaLabel}),
					el("button", {
						type: "button",
						className: "translator-eye",
						"aria-label": isSecretFieldVisible(fieldKey) ? plugin.getCustomText("hide_secret_label") : plugin.getCustomText("show_secret_label"),
						title: isSecretFieldVisible(fieldKey) ? plugin.getCustomText("hide_secret_label") : plugin.getCustomText("show_secret_label"),
						onClick: _ => toggleSecretFieldVisibility(fieldKey),
						children: createIcon("eye", 15)
					})
				]
			});
			const createExceptionScopeSwitches = (sentKey, receivedKey, sentLabelKey, receivedLabelKey) => el("div", {
				className: "translator-scope-chips",
				children: [[sentKey, sentLabelKey], [receivedKey, receivedLabelKey]].map(([key, labelKey]) => {
					const active = plugin.getExceptionScopeSetting(key, true);
					return el("button", {
						type: "button",
						className: cls("translator-scope-chip", active && "translator-scope-chip-active"),
						"aria-pressed": active,
						onClick: _ => {
							if (!plugin.settings.exceptions) plugin.settings.exceptions = {};
							plugin.settings.exceptions[key] = !active;
							BDFDB.DataUtils.save(!active, plugin, "exceptions", key);
							plugin.SettingsUpdated = true;
							refreshPanel();
						},
						children: `${active ? "✓ " : ""}${plugin.getCustomText(labelKey)}`
					});
				})
			});
			// Word chips with an inline dashed add-input (the mk-chip / mk-chip-add pair).
			const createStackedTokenInput = ({items, maxLength, placeholder, emptyText, onChange, className = "", mono = false}) => el(class extends BdApi.React.Component {
				constructor(props) {
					super(props);
					this.state = {
						value: "",
						items: BDFDB.ArrayUtils.is(props.items) ? [].concat(props.items) : []
					};
				}
				componentDidUpdate(prevProps) {
					const previousItems = BDFDB.ArrayUtils.is(prevProps.items) ? prevProps.items : [];
					const nextItems = BDFDB.ArrayUtils.is(this.props.items) ? this.props.items : [];
					if (JSON.stringify(previousItems) != JSON.stringify(nextItems)) this.setState({items: [].concat(nextItems)});
				}
				commitValue(rawValue) {
					let value = String(rawValue == null ? this.state.value : rawValue).trim();
					if (!value) return;
					if (typeof this.props.maxLength == "number" && this.props.maxLength > 0) value = value.slice(0, this.props.maxLength);
					const currentItems = BDFDB.ArrayUtils.is(this.state.items) ? this.state.items : [];
					if (currentItems.includes(value)) {
						this.setState({value: ""});
						return;
					}
					const nextItems = [].concat(currentItems, value);
					this.setState({value: "", items: nextItems});
					this.props.onChange(nextItems);
				}
				removeItem(targetItem) {
					const currentItems = BDFDB.ArrayUtils.is(this.state.items) ? this.state.items : [];
					const nextItems = currentItems.filter(item => item != targetItem);
					this.setState({items: nextItems});
					this.props.onChange(nextItems);
				}
				render() {
					const currentItems = BDFDB.ArrayUtils.is(this.state.items) ? this.state.items : [];
					return el("div", {
						className: cls("translator-chips", this.props.className),
						children: [
							...currentItems.map(item => el("span", {
								className: "translator-chip",
								key: item,
								children: [
									el("span", {
										className: "translator-chip-label",
										style: this.props.mono ? {fontFamily: "var(--font-code, Consolas, monospace)", fontSize: "12px"} : undefined,
										children: item
									}),
									el("button", {
										type: "button",
										className: "translator-chip-remove",
										title: compactText("删除", "Remove", "Удалить"),
										"aria-label": `${compactText("删除", "Remove", "Удалить")} ${item}`,
										onClick: _ => this.removeItem(item),
										children: "✕"
									})
								]
							})),
							el("input", {
								className: "translator-chip-input",
								value: this.state.value,
								placeholder: this.props.placeholder,
								maxLength: this.props.maxLength,
								spellCheck: false,
								"aria-label": this.props.placeholder,
								onChange: event => this.setState({value: event.target.value}),
								onKeyDown: event => {
									if (event.key == "Enter") {
										event.preventDefault();
										this.commitValue();
									}
								},
								onBlur: _ => this.commitValue()
							})
						]
					});
				}
			}, {items, maxLength, placeholder, emptyText, onChange, className, mono});
			/* ===== advanced page forms ===== */
			const createDisablePrefixForm = () => [
				createSettingRow({
					label: plugin.getCustomText("disable_prefix_title"),
					tip: plugin.getCustomText("disable_prefix_hint")
				}),
				createStackedTokenInput({
					placeholder: plugin.getCustomText("disable_prefix_placeholder"),
					emptyText: plugin.getCustomText("disable_prefix_placeholder"),
					maxLength: plugin.defaults.exceptions.wordStart.max,
					items: plugin.settings.exceptions.wordStart,
					mono: true,
					onChange: value => {
						plugin.SettingsUpdated = true;
						BDFDB.DataUtils.save(value, plugin, "exceptions", "wordStart");
					}
				})
			];
			const createProtectedTermsForm = () => [
				createSettingRow({
					label: plugin.getCustomText("protected_terms_title"),
					tip: plugin.getCustomText("protected_terms_hint"),
					control: createExceptionScopeSwitches("protectedTermsForSent", "protectedTermsForReceived", "protected_terms_scope_sent", "protected_terms_scope_received")
				}),
				createStackedTokenInput({
					placeholder: plugin.getCustomText("protected_terms_placeholder"),
					emptyText: plugin.getCustomText("protected_terms_placeholder"),
					maxLength: plugin.defaults.exceptions.protectedTerms.max,
					items: plugin.settings.exceptions.protectedTerms || [],
					onChange: value => {
						const nextValue = BDFDB.ArrayUtils.is(value) ? [].concat(value) : [];
						plugin.settings.exceptions.protectedTerms = nextValue;
						plugin.SettingsUpdated = true;
						BDFDB.DataUtils.save(nextValue, plugin, "exceptions", "protectedTerms");
					}
				})
			];
			const createWrapperPairsForm = () => [
				createSettingRow({
					label: plugin.getCustomText("wrapper_pairs_title"),
					tip: plugin.getCustomText("wrapper_pairs_hint"),
					control: createExceptionScopeSwitches("wrapperPairsForSent", "wrapperPairsForReceived", "wrapper_pairs_scope_sent", "wrapper_pairs_scope_received")
				}),
				createStackedTokenInput({
					placeholder: plugin.getCustomText("wrapper_pairs_placeholder"),
					emptyText: plugin.getCustomText("wrapper_pairs_placeholder"),
					maxLength: plugin.defaults.exceptions.wrapperPairs.max,
					items: plugin.getWrapperPairItemsForSettings(),
					mono: true,
					onChange: value => {
						const nextValue = (BDFDB.ArrayUtils.is(value) ? value : []).filter(rule => !plugin.isDiscordSpoilerWrapperRule(rule));
						plugin.settings.exceptions.wrapperPairs = [].concat(nextValue);
						plugin.SettingsUpdated = true;
						BDFDB.DataUtils.save(nextValue, plugin, "exceptions", "wrapperPairs");
					}
				})
			];
			const createTranslatePrefixForm = () => [
				createFieldLabel(plugin.getCustomText("translate_prefix_title"), plugin.getCustomText("translate_prefix_hint")),
				...(plugin.settings.prefixes.translationPrefixData || []).map((entry, index) => el("div", {
					className: "translator-prefix-translation-row",
					key: `prefix-${index}`,
					children: [
						el("div", {
							className: "translator-prefix-translation-cell translator-prefix-input-cell",
							children: createTextField({
								fieldKey: `prefix-${index}-${entry.prefix}`,
								placeholder: plugin.getCustomText("translate_prefix_placeholder"),
								value: entry.prefix,
								mono: true,
								onChange: value => {
									plugin.settings.prefixes.translationPrefixData[index].prefix = value;
									BDFDB.DataUtils.save(plugin.settings.prefixes.translationPrefixData, plugin, "prefixes", "translationPrefixData");
									plugin.SettingsUpdated = true;
								}
							})
						}),
						el("div", {
							className: "translator-prefix-translation-cell translator-prefix-language-cell",
							children: createFavoriteLanguageSelect({
								value: entry.language,
								options: plugin.ensureSettingsStore().getLanguageIds()
									.filter(key => !plugin.ensureSettingsStore().getLanguage(key).auto && !plugin.ensureSettingsStore().getLanguage(key).special)
									.map(createLanguageOption)
									.sort((a, b) => a.label.localeCompare(b.label)),
								onChange: value => {
									plugin.settings.prefixes.translationPrefixData[index].language = value;
									BDFDB.DataUtils.save(plugin.settings.prefixes.translationPrefixData, plugin, "prefixes", "translationPrefixData");
									plugin.SettingsUpdated = true;
								}
							})
						}),
						el("div", {
							className: "translator-prefix-translation-cell translator-prefix-delete-cell",
							children: createIconButton({
								icon: createIcon("trash", 15),
								danger: true,
								title: compactText("删除此前缀", "Delete this prefix", "Удалить этот префикс"),
								onClick: _ => {
									plugin.settings.prefixes.translationPrefixData.splice(index, 1);
									BDFDB.DataUtils.save(plugin.settings.prefixes.translationPrefixData, plugin, "prefixes", "translationPrefixData");
									plugin.SettingsUpdated = true;
									refreshPanel();
								}
							})
						})
					]
				})),
				createButton({
					label: plugin.getCustomText("add_prefix_button"),
					kind: "green",
					icon: createIcon("add", 13),
					className: "translator-prefix-add",
					onClick: _ => {
						if (!plugin.settings.prefixes.translationPrefixData) plugin.settings.prefixes.translationPrefixData = [];
						plugin.settings.prefixes.translationPrefixData.push({
							prefix: "$en",
							language: "en"
						});
						BDFDB.DataUtils.save(plugin.settings.prefixes.translationPrefixData, plugin, "prefixes", "translationPrefixData");
						plugin.SettingsUpdated = true;
						refreshPanel();
					}
				})
			];
			/* ===== general page: colours + live preview ===== */
			const saveTranslatedTextColor = color => {
				color = (color || "").trim() || "#7cc7ff";
				plugin.settings.general.translatedTextColor = color;
				if (!BDFDB.ArrayUtils.is(plugin.settings.general.customTranslatedTextColors)) plugin.settings.general.customTranslatedTextColors = [];
				if (!plugin.getTranslatedTextColorPresets().includes(color) && !plugin.settings.general.customTranslatedTextColors.includes(color)) plugin.settings.general.customTranslatedTextColors.unshift(color);
				plugin.settings.general.customTranslatedTextColors = plugin.settings.general.customTranslatedTextColors.filter((value, index, array) => value && array.indexOf(value) == index).slice(0, 12);
				BDFDB.DataUtils.save(plugin.settings.general, plugin, "general");
				plugin.SettingsUpdated = true;
				refreshPanel();
			};
			const removeTranslatedTextColor = color => {
				color = (color || "").trim();
				if (!color || plugin.getTranslatedTextColorPresets().includes(color)) return;
				plugin.settings.general.customTranslatedTextColors = (plugin.settings.general.customTranslatedTextColors || []).filter(savedColor => savedColor != color);
				if (plugin.getTranslatedTextColor() == color) plugin.settings.general.translatedTextColor = plugin.getTranslatedTextColorPresets()[0] || "#7cc7ff";
				BDFDB.DataUtils.save(plugin.settings.general, plugin, "general");
				plugin.SettingsUpdated = true;
				refreshPanel();
			};
			const ensureTranslatedTextColorState = () => {
				if (!plugin.translatedTextColorState) plugin.translatedTextColorState = {
					showCustom: false,
					customValue: plugin.getTranslatedTextColor()
				};
				if (!plugin.translatedTextColorState.customValue) plugin.translatedTextColorState.customValue = plugin.getTranslatedTextColor();
				return plugin.translatedTextColorState;
			};
			const getCustomTranslatedTextColors = () => BDFDB.ArrayUtils.is(plugin.settings.general.customTranslatedTextColors) ? plugin.settings.general.customTranslatedTextColors : [];
			const createColorChip = (color, active) => {
				const isCustomColor = getCustomTranslatedTextColors().includes(color) && !plugin.getTranslatedTextColorPresets().includes(color);
				return el("button", {
					type: "button",
					className: cls("translator-color-chip", active && "translator-color-chip-active"),
					title: isCustomColor ? `${color} · ${compactText("点击选择，点 × 删除", "Click to select, click × to delete", "Нажмите для выбора, × для удаления")}` : color,
					onClick: _ => {
						const colorState = ensureTranslatedTextColorState();
						colorState.showCustom = false;
						colorState.customValue = color;
						saveTranslatedTextColor(color);
					},
					children: [
						el("span", {
							className: "translator-settings-color-swatch",
							style: {background: color}
						}),
						el("span", {
							className: "translator-color-chip-code",
							children: color
						}),
						isCustomColor && el("span", {
							className: "translator-color-chip-delete",
							title: compactText("删除这个自定义颜色", "Delete this custom color", "Удалить этот цвет"),
							onClick: event => {
								event.preventDefault();
								event.stopPropagation();
								removeTranslatedTextColor(color);
							},
							children: "×"
						})
					].filter(Boolean)
				});
			};
			const createGeneralSwitch = (key, {disabled = false, dependent = false} = {}) => createSettingRow({
				key: `general-${key}`,
				label: plugin.getGeneralSettingLabel(key),
				dependent,
				disabled,
				className: "translator-settings-switch-row",
				control: createSwitch({
					value: plugin.settings.general[key],
					disabled,
					label: plugin.getGeneralSettingLabel(key),
					onChange: value => {
						if (disabled) return;
						plugin.settings.general[key] = !!value;
						BDFDB.DataUtils.save(plugin.settings.general, plugin, "general");
						plugin.SettingsUpdated = true;
						refreshPanel();
					}
				})
			});
			const createOriginalDisplaySettings = () => [
				createGroupHeader(compactText("原文展示 · 发送", "Original text · sent", "Оригинал · отправка")),
				createGeneralSwitch("sendOriginalMessage"),
				createGeneralSwitch("useSpoilerInSentOriginal", {dependent: true, disabled: !plugin.settings.general.sendOriginalMessage}),
				createGroupHeader(compactText("原文展示 · 接收", "Original text · received", "Оригинал · получение")),
				createGeneralSwitch("showOriginalMessage"),
				createGeneralSwitch("useSpoilerInReceivedOriginal", {dependent: true, disabled: !plugin.settings.general.showOriginalMessage}),
				createGeneralSwitch("showOriginalInReplyPreview")
			];
			const createUiLanguageSelector = () => createSettingRow({
				label: plugin.getCustomText("plugin_language_title"),
				tip: plugin.getCustomText("plugin_language_hint"),
				control: createSelectIn(210, {
					value: plugin.settings.general.interfaceLanguage || "system",
					options: plugin.getPluginLanguageOptions(),
					onChange: value => {
						plugin.settings.general.interfaceLanguage = value || "system";
						BDFDB.DataUtils.save(plugin.settings.general, plugin, "general");
						plugin.SettingsUpdated = true;
						// Reload legacy labels so the popout/quick panel and label fallbacks
						// follow the new plugin language (BDFDB only reloads on Discord lang change),
						// then rebuild the language table so names baked from labels follow too.
						plugin.labels = plugin.setLabelsByLanguage();
						plugin.setLanguages();
						refreshPanel();
					}
				})
			});
			const createTranslatedTextColorInput = () => {
				const currentColor = plugin.getTranslatedTextColor();
				const colorState = ensureTranslatedTextColorState();
				const presetColors = plugin.getTranslatedTextColorPalette();
				return [
					createGeneralSwitch("highlightTranslatedMessages"),
					createSettingRow({
						label: plugin.getCustomText("translated_text_color_title"),
						tip: compactText("点色票即可切换；＋ 可添加自定义颜色，自定义色可删除。下方消息实时预览。", "Pick a swatch to switch; + adds a custom color, custom colors can be deleted. The message below previews live.", "Нажмите цвет для выбора; + добавляет свой цвет. Предпросмотр ниже.")
					}),
					el("div", {
						className: "translator-color-palette",
						children: [
							...presetColors.map(color => createColorChip(color, color == currentColor)),
							el("button", {
								type: "button",
								className: "translator-color-chip translator-color-chip-add",
								title: compactText("自定义颜色", "Custom color", "Свой цвет"),
								onClick: _ => {
									colorState.showCustom = !colorState.showCustom;
									colorState.customValue = currentColor;
									refreshPanel();
								},
								children: createIcon("add", 14)
							})
						]
					}),
					colorState.showCustom && el("div", {
						className: "translator-color-custom-row",
						children: [
							el("input", {
								type: "color",
								className: "translator-native-color-input",
								defaultValue: /^#[0-9a-f]{6}$/i.test(colorState.customValue || "") ? colorState.customValue : "#7cc7ff",
								onInput: event => {
									const nextColor = event && event.target && event.target.value || colorState.customValue;
									colorState.customValue = nextColor;
									const row = event && event.target && event.target.closest && event.target.closest(".translator-color-custom-row");
									const textInput = row && row.querySelector && row.querySelector(".translator-color-custom-input");
									if (textInput && textInput.value != nextColor) textInput.value = nextColor;
								},
								onChange: event => {
									colorState.customValue = event && event.target && event.target.value || colorState.customValue;
								}
							}),
							el("input", {
								type: "text",
								className: "translator-color-custom-input",
								placeholder: "#7cc7ff",
								defaultValue: colorState.customValue,
								onInput: event => {
									colorState.customValue = event && event.target && event.target.value || "";
								}
							}),
							createButton({
								kind: "primary",
								label: plugin.getCustomText("translated_text_color_save_button"),
								onClick: _ => {
									const customColor = (colorState.customValue || "").trim();
									if (!plugin.isValidCssColorValue(customColor)) return BDFDB.NotificationUtils.toast(plugin.getCustomText("translated_text_color_invalid"), {type: "danger", position: "center"});
									colorState.showCustom = false;
									colorState.customValue = customColor;
									saveTranslatedTextColor(customColor);
								}
							}),
							createButton({
								label: compactText("取消", "Cancel", "Отмена"),
								onClick: _ => {
									colorState.showCustom = false;
									refreshPanel();
								}
							})
						]
					}),
					// Live preview mirroring the real received rendering: the translated
					// block (accent bar, tinted background, tinted text) sits on top and
					// the original line follows underneath, exactly like chat.
					el("div", {
						className: cls("translator-color-preview", !plugin.settings.general.highlightTranslatedMessages && "translator-color-preview-plain"),
						style: {"--translator-preview-color": currentColor},
						children: [
							el("span", {className: "translator-color-preview-avatar", "aria-hidden": true, children: el("svg", {viewBox: "0 0 36 36", children: [
								el("defs", {children: el("linearGradient", {id: "translatorPreviewAvatarGradient", x1: "0", y1: "0", x2: "1", y2: "1", children: [
									el("stop", {offset: "0", stopColor: "#5865f2"}),
									el("stop", {offset: "1", stopColor: "#8b5cf6"})
								]})}),
								el("circle", {cx: 18, cy: 18, r: 18, fill: "url(#translatorPreviewAvatarGradient)"}),
								el("path", {d: "M10 13 L7 5 L14 9 Z", fill: "#4046c8"}),
								el("path", {d: "M26 13 L29 5 L22 9 Z", fill: "#4046c8"}),
								el("circle", {cx: 12.5, cy: 17, r: 3.4, fill: "#fff"}),
								el("circle", {cx: 23.5, cy: 17, r: 3.4, fill: "#fff"}),
								el("circle", {cx: 13.3, cy: 17.7, r: 1.6, fill: "#2b2d31"}),
								el("circle", {cx: 24.3, cy: 17.7, r: 1.6, fill: "#2b2d31"}),
								el("path", {d: "M13 25 Q15.5 27.5 18 25 Q20.5 27.5 23 25", stroke: "#fff", strokeWidth: 1.6, fill: "none", strokeLinecap: "round"}),
								el("circle", {cx: 8.5, cy: 22, r: 1.8, fill: "#f0a5b8", opacity: 0.85}),
								el("circle", {cx: 27.5, cy: 22, r: 1.8, fill: "#f0a5b8", opacity: 0.85})
							]})}),
							el("div", {className: "translator-color-preview-body", children: [
								el("div", {className: "translator-color-preview-head", children: [
									el("span", {className: "translator-color-preview-name", children: "Sakura"}),
									el("span", {className: "translator-color-preview-time", children: compactText("今天 21:47", "Today 21:47", "Сегодня 21:47")})
								]}),
								el("div", {className: "translator-color-preview-trans", children: el("div", {className: "translator-color-preview-message", children: compactText("今晚要不要一起打排位？", "Want to play ranked together tonight?", "Сыграем сегодня в ранкеде?")})}),
								el("div", {className: "translator-color-preview-original", children: "今夜ランクやらない？"}),
								el("div", {className: "translator-color-preview-mark", children: compactText("(已翻译)", "(translated)", "(переведено)")})
							]})
						]
					})
				].filter(Boolean);
			};
			/* ===== strategy page ===== */
			const updateEngineSetting = (field, value) => {
				plugin.settings.engines[field] = value;
				if (field == "translator" && plugin.settings.engines.backup == value) {
					plugin.settings.engines.backup = "----";
					BDFDB.NotificationUtils.toast(compactText("主服务与备用服务不能相同，备用已清为“无”。", "Primary and backup providers must differ; backup was cleared.", "Основной и резервный провайдеры должны отличаться; резервный сброшен."), {type: "info", position: "center"});
				}
				BDFDB.DataUtils.save(plugin.settings.engines, plugin, "engines");
				plugin.setLanguages();
				plugin.SettingsUpdated = true;
				refreshPanel();
			};
			const saveFilterSetting = (key, value) => {
				if (!plugin.settings.filters) plugin.settings.filters = {};
				plugin.settings.filters[key] = value;
				BDFDB.DataUtils.save(value, plugin, "filters", key);
				plugin.SettingsUpdated = true;
			};
			// The visible label follows the interface language; the search haystack
			// still spans every script so any spelling finds the language.
			const getLanguageSearchText = language => [language && language.name, language && language.ownlang, plugin.getChineseLanguageName(language && language.id)].filter(Boolean).join(" ");
			const createLanguageOption = key => {
				const language = plugin.ensureSettingsStore().getLanguage(key);
				return {value: key, label: plugin.getLanguageDisplayName(language), search: getLanguageSearchText(language), pinned: key == "auto", favoriteDisabled: key == "auto"};
			};
			const createFavoriteLanguageSelect = props => createSearchableSelect(Object.assign({
				favoriteValues: plugin.ensureSettingsStore().getFavorites(),
				autoFavoriteOnSelect: true,
				favoriteLabel: compactText("收藏语言", "Favorite language", "Добавить в избранное"),
				unfavoriteLabel: compactText("取消收藏", "Remove favorite", "Убрать из избранного"),
				onToggleFavorite: (languageId, active) => {
					plugin.ensureSettingsStore().setFavorite(languageId, active);
					plugin.setLanguages();
				}
			}, props));
			const createLanguageOptions = direction => plugin.ensureSettingsStore().getLanguageIds()
				.filter(key => !plugin.ensureSettingsStore().getLanguage(key).special && (direction == languageTypes.INPUT || !plugin.ensureSettingsStore().getLanguage(key).auto))
				.map(createLanguageOption)
				.sort((a, b) => {
					if (a.value == "auto") return -1;
					if (b.value == "auto") return 1;
					return a.label.localeCompare(b.label);
				});
			const saveLanguageChoice = (place, direction, value, shouldRefresh = true) => {
				plugin.settings.choices[place][direction] = value;
				BDFDB.DataUtils.save(plugin.settings.choices, plugin, "choices");
				plugin.setLanguages();
				plugin.SettingsUpdated = true;
				if (shouldRefresh) refreshPanel();
			};
			// "翻译方向" row: [source select] → [target select] with a swap button, the
			// sentence-shaped direction control from the draft.
			const createTranslationDirectionRow = place => {
				const input = plugin.settings.choices[place][languageTypes.INPUT];
				const output = plugin.settings.choices[place][languageTypes.OUTPUT];
				return el("div", {
					className: "translator-row",
					children: [
						createRowLabel(compactText("翻译方向", "Direction", "Направление")),
						// The swap button sits between the two languages, where the arrow
						// used to be, so exchanging them is one obvious click.
						el("span", {className: "translator-dir", children: [
							el("div", {className: "translator-dir-select", children: createFavoriteLanguageSelect({value: input, options: createLanguageOptions(languageTypes.INPUT), onChange: value => saveLanguageChoice(place, languageTypes.INPUT, value)})}),
							el(BDFDB.LibraryComponents.TooltipContainer, {
								text: input == "auto" ? compactText("左边是「检测语言」时无法交换", "Cannot swap while the source is auto-detect", "Нельзя поменять при автоопределении") : compactText("交换两边语言", "Swap the two languages", "Поменять языки местами"),
								tooltipConfig: {type: "top"},
								children: el("button", {
								type: "button",
								className: "translator-swap",
								disabled: input == "auto",
								title: input == "auto" ? compactText("自动检测不能作为目标语言", "Auto-detect cannot be a target language", "Автоопределение не может быть целевым языком") : compactText("交换两边语言", "Swap source and target", "Поменять языки местами"),
								"aria-label": compactText("交换源语言和目标语言", "Swap source and target", "Поменять языки местами"),
								onClick: _ => {
									if (input == "auto") return;
									plugin.settings.choices[place][languageTypes.INPUT] = output;
									plugin.settings.choices[place][languageTypes.OUTPUT] = input;
									BDFDB.DataUtils.save(plugin.settings.choices, plugin, "choices");
									plugin.setLanguages();
									plugin.SettingsUpdated = true;
									refreshPanel();
								},
								children: createIcon("swap", 14)
							})}),
							el("div", {className: "translator-dir-select", children: createFavoriteLanguageSelect({value: output, options: createLanguageOptions(languageTypes.OUTPUT), onChange: value => saveLanguageChoice(place, languageTypes.OUTPUT, value)})})
						]})
					]
				});
			};
			// Source-language filters are one multi-select with pinned favorites: the
			// star toggles a language without closing the popout (chips squeezed the
			// row once more than a few languages were picked), selected languages
			// sort to the top of the list, and the trigger summarizes the state.
			const createSourceLanguageFilterField = ({settingKey, title, hint}) => {
				if (!plugin.settings.filters) plugin.settings.filters = {};
				const selectedIds = BDFDB.ArrayUtils.is(plugin.settings.filters[settingKey]) ? plugin.settings.filters[settingKey] : [];
				const concreteOptions = plugin.ensureSettingsStore().getLanguageIds()
					.filter(key => !plugin.ensureSettingsStore().getLanguage(key).auto && !plugin.ensureSettingsStore().getLanguage(key).special)
					.map(createLanguageOption)
					.sort((a, b) => {
						const aSelected = selectedIds.includes(a.value);
						const bSelected = selectedIds.includes(b.value);
						if (aSelected != bSelected) return aSelected ? -1 : 1;
						return a.label.localeCompare(b.label);
					});
				const save = nextIds => {
					plugin.settings.filters[settingKey] = [...new Set(nextIds.filter(languageId => concreteOptions.some(option => option.value == languageId)))];
					BDFDB.DataUtils.save(plugin.settings.filters[settingKey], plugin, "filters", settingKey);
					plugin.SettingsUpdated = true;
					// No refreshPanel here: the popout stays open while stars toggle;
					// the select owns the live selection until it closes.
				};
				return el("div", {
					className: "translator-row",
					children: [
						createRowLabel(title, hint),
						el("div", {className: "translator-language-filter-select", children: createCustomSelect({
							multi: true,
							values: selectedIds,
							options: concreteOptions,
							searchPlaceholder: compactText("搜索语言或代码", "Search language or code", "Поиск языка или кода"),
							summarize: values => values.length
								? compactText(`已选 ${values.length} 种语言`, `${values.length} selected`, `Выбрано: ${values.length}`)
								: compactText("全部语言（未限制）", "All languages (no limit)", "Все языки (без ограничений)"),
							onToggle: (_value, nextValues) => save(nextValues),
							renderOption: (option, selected) => el("div", {className: "translator-multi-option", children: [
								el("span", {className: "translator-multi-option-name", children: option.label}),
								el("span", {className: cls("translator-multi-star", selected && "translator-multi-star-active"), "aria-hidden": true, children: selected ? "★" : "☆"})
							]})
						})})
					]
				});
			};
			const createSourceLanguageFilter = () => createSourceLanguageFilterField({
				settingKey: "autoTranslateSourceLanguages",
				title: plugin.getCustomText("source_filter_title"),
				hint: plugin.getCustomText("source_filter_hint")
			});
			const createReceivedSourceLanguageFilter = () => createSourceLanguageFilterField({
				settingKey: "receivedAutoTranslateSourceLanguages",
				title: plugin.getCustomText("received_source_filter_title"),
				hint: plugin.getCustomText("received_source_filter_hint")
			});
			const promptLibraryOptions = () => ({
				legacyPrompts: plugin.getLegacyAiAutoTranslatePrompts(),
				migratedName: compactText("迁移的提示词", "Migrated prompt", "Перенесённый промпт"),
				createId: () => `prompt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
			});
			const persistPromptLibrary = () => {
				BDFDB.DataUtils.save(plugin.settings.filters, plugin, "filters");
				plugin.SettingsUpdated = true;
			};
			// The prompt library rendered as policy cards: an editable card for the
			// selected custom prompt (rename in the head, body autosaves) and a locked
			// built-in template card with copy/new actions - the reference plugin's
			// policy-card anatomy.
			const createPromptLibraryEditor = () => {
				if (!plugin.settings.filters) plugin.settings.filters = {};
				const options = promptLibraryOptions();
				const state = ensureAiPromptLibrary(plugin.settings.filters, options);
				if (state.changed) persistPromptLibrary();
				const selected = state.items.find(item => item.id == state.selectedId) || null;
				const selectedBody = selected ? selected.body : plugin.getDefaultAiAutoTranslatePrompt();
				const sendingEnabled = isAiPromptSendingEnabled(plugin.settings.filters);
				const offBadge = sendingEnabled ? null : el("span", {className: "translator-policy-lock translator-policy-off", children: compactText("已关闭 · 不随请求发送", "Off · not sent with requests", "Выкл. · не отправляется")});
				const selectOptions = [{value: BUILTIN_PROMPT_ID, label: compactText("内置模板（只读）", "Built-in template (read only)", "Встроенный шаблон (только чтение)")}]
					.concat(state.items.map(item => ({value: item.id, label: item.name})))
					.concat([{value: AI_PROMPT_OFF_OPTION, label: compactText("关闭（不发送偏好）", "Off (send no preferences)", "Выкл. (не отправлять предпочтения)")}]);
				const createPromptFrom = (name, body) => {
					const id = options.createId();
					const item = addAiPrompt(plugin.settings.filters, {id, name, body}, options);
					if (!item) return;
					persistPromptLibrary();
					refreshPanel();
				};
				const confirmDelete = () => {
					if (!selected) return;
					const remove = () => {
						if (!deleteAiPrompt(plugin.settings.filters, selected.id, options)) return;
						persistPromptLibrary();
						refreshPanel();
					};
					if (typeof BdApi != "undefined" && BdApi.UI && typeof BdApi.UI.showConfirmationModal == "function") BdApi.UI.showConfirmationModal(
						compactText("删除提示词", "Delete prompt", "Удалить промпт"),
						compactText(`确定删除“${selected.name}”吗？`, `Delete “${selected.name}”?`, `Удалить «${selected.name}»?`),
						{danger: true, confirmText: compactText("删除", "Delete", "Удалить"), cancelText: compactText("取消", "Cancel", "Отмена"), onConfirm: remove}
					);
					else remove();
				};
				const newPromptAction = createMiniButton({
					icon: createIcon("add", 14),
					title: compactText("新建提示词", "New prompt", "Новый промпт"),
					onClick: _ => createPromptFrom(compactText(`自定义提示词 ${state.items.length + 1}`, `Custom prompt ${state.items.length + 1}`, `Пользовательский промпт ${state.items.length + 1}`), "")
				});
				const duplicateAction = createMiniButton({
					icon: createIcon("copy", 14),
					title: selected ? compactText("复制为新提示词", "Duplicate prompt", "Дублировать промпт") : compactText("复制为我的提示词", "Copy as my prompt", "Скопировать как свой"),
					onClick: _ => createPromptFrom(selected ? `${compactText("副本", "Copy", "Копия")} · ${selected.name}` : compactText("我的提示词", "My prompt", "Мой промпт"), selectedBody)
				});
				const selectorRow = createSettingRow({
					label: compactText("当前使用的提示词", "Active prompt", "Активный промпт"),
					tip: compactText("选哪套翻译偏好随请求发送；选“关闭”则什么都不发，原来选的那条会记着。点名字改名；正文直接编辑，自动保存。切换或修改后，已缓存译文会在下次看到时重翻一次。", "Pick which preferences travel with requests; “Off” sends none and remembers your previous choice. Click the name to rename; the body edits in place and saves automatically. After a switch or an edit, cached translations are redone the next time they are shown.", "Выберите, какие предпочтения отправлять с запросами; «Выкл.» ничего не отправляет и запоминает прежний выбор. Нажмите имя, чтобы переименовать; текст правится на месте и сохраняется сам. После переключения или правки кэшированные переводы будут переделаны при следующем показе."),
					control: el("div", {className: "translator-prompt-selector", children: createCustomSelect({
						value: sendingEnabled ? state.selectedId : AI_PROMPT_OFF_OPTION,
						options: selectOptions,
						onChange: value => {
							if (value == AI_PROMPT_OFF_OPTION) {setAiPromptSendingEnabled(plugin.settings.filters, false); persistPromptLibrary(); refreshPanel(); return;}
							if (!selectAiPrompt(plugin.settings.filters, value, options)) return;
							setAiPromptSendingEnabled(plugin.settings.filters, true);
							persistPromptLibrary();
							refreshPanel();
						}
					})})
				});
				const selectedCard = el("div", {
					className: cls("translator-policy", selected && "translator-policy-editable"),
					children: [
						el("div", {className: "translator-policy-head", children: selected ? [
							el("input", {
								key: `${selected.id}-name`,
								className: "translator-policy-name",
								defaultValue: selected.name,
								maxLength: 80,
								spellCheck: false,
								size: Math.max(6, Math.min(30, String(selected.name || "").length + 2)),
								"aria-label": compactText("提示词名称", "Prompt name", "Название промпта"),
								title: compactText("点击修改名称", "Click to rename", "Нажмите, чтобы переименовать"),
								onInput: event => {
									if (!updateAiPrompt(plugin.settings.filters, selected.id, {name: event.target.value}, options)) return;
									persistPromptLibrary();
								}
							}),
							el("span", {className: "translator-minibtn", style: {pointerEvents: "none"}, "aria-hidden": true, children: createIcon("pencil", 12)}),
							offBadge,
							el("div", {className: "translator-policy-actions", children: [newPromptAction, duplicateAction, createMiniButton({
								icon: createIcon("trash", 14),
								danger: true,
								title: compactText("删除此提示词", "Delete this prompt", "Удалить этот промпт"),
								onClick: confirmDelete
							})]})
						].filter(Boolean) : [
							el("span", {className: "translator-policy-name-static", children: compactText("内置模板", "Built-in template", "Встроенный шаблон")}),
							el("span", {className: "translator-policy-lock", children: [createIcon("lock", 10), compactText("只读", "Read only", "Только чтение")]}),
							offBadge,
							el("div", {className: "translator-policy-actions", children: [duplicateAction, newPromptAction]})
						].filter(Boolean)}),
						el("textarea", {
							key: state.selectedId,
							className: "translator-policy-body",
							defaultValue: selectedBody,
							placeholder: compactText("在这里输入提示词正文…", "Write the prompt body here…", "Введите текст промпта…"),
							readOnly: !selected,
							spellCheck: false,
							"aria-label": compactText("AI 翻译偏好正文", "AI translation preferences body", "Текст предпочтений перевода"),
							onInput: selected ? event => {
								if (!updateAiPrompt(plugin.settings.filters, selected.id, {body: event.target.value}, options)) return;
								persistPromptLibrary();
							} : undefined
						})
					]
				});
				return el("div", {className: "translator-prompt-library", children: [
					selectorRow,
					selectedCard,
					infoText(!sendingEnabled ? compactText("已关闭：当前不发送任何偏好，固定规则照常生效；在上面选回任一提示词即恢复发送。", "Off: no preferences are sent and the fixed rules still apply; pick any prompt above to resume.", "Выключено: предпочтения не отправляются, фиксированные правила действуют; выберите любой промпт выше, чтобы возобновить.") : selected ? compactText("名称和正文自动保存；正文留空时使用内置默认偏好；发送时最多带前 1500 字。", "Name and body save automatically; a blank body falls back to the built-in preferences; at most the first 1500 characters are sent.", "Название и текст сохраняются автоматически; пустой текст использует встроенный шаблон.") : compactText("内置模板保持只读；复制后即可编辑。", "The built-in template stays read only; duplicate it to edit.", "Встроенный шаблон только для чтения; создайте копию для редактирования."))
				]});
			};
			const createAutoTranslateDecisionSettings = () => {
				const aiCapable = plugin.isAiAutoTranslateDecisionAvailable();
				// No visible mode switch (the reference plugin has none either): AI
				// judgment turns on automatically once an AI provider is configured and
				// falls back to the language filters above when none is. The stored
				// mode just follows availability.
				const desiredMode = aiCapable ? "ai" : "basic";
				if (plugin.getAutoTranslateDecisionMode() != desiredMode) {
					if (!plugin.settings.filters) plugin.settings.filters = {};
					plugin.settings.filters.autoTranslateDecisionMode = desiredMode;
					BDFDB.DataUtils.save(desiredMode, plugin, "filters", "autoTranslateDecisionMode");
					plugin.SettingsUpdated = true;
				}
				return [
					createGroupHeader(compactText("AI 翻译偏好", "AI translation preferences", "Предпочтения перевода AI"), plugin.getCustomText("auto_translate_decision_hint")),
					!aiCapable && el("div", {className: "translator-settings-note", children: [
						compactText("尚未配置 AI 服务商，翻译偏好只对 AI 服务商生效；配置后自动随请求发送。", "No AI provider is configured yet; translation preferences only apply to AI providers and are sent automatically once one is set up. ", "AI-провайдер не настроен; решают языковые фильтры выше. "),
						el("a", {
							className: "translator-note-link",
							onClick: _ => {
								if (!plugin.settingsUiState) plugin.settingsUiState = {};
								plugin.settingsUiState.activeTab = "providers";
								refreshPanel();
							},
							children: compactText("前往服务商页 →", "Open the providers tab →", "Открыть вкладку провайдеров →")
						})
					]}),
					createPromptLibraryEditor(),
					createSplit(),
					createGroupHeader(compactText("语言检测", "Language detection", "Определение языка")),
					createSettingRow({
						label: compactText("语言检测策略", "Detection strategy", "Стратегия определения"),
						tip: compactText("本地检测只在很有把握时给结论，拿不准就交给免密钥的 Google 检测；也可以强制只用其中一种。", "Local detection answers only when confident; the default falls back to keyless Google detection when uncertain. Either can be forced.", "Локальное определение отвечает только при уверенности; иначе используется Google без ключа."),
						control: createSelectIn(260, {
							value: plugin.getLanguageDetectionStrategy(),
							options: [
								{value: "local_first", label: compactText("本地优先，失败用 Google Free", "Local first, then Google Free", "Сначала локально, затем Google Free")},
								{value: "google_free", label: compactText("仅 Google Free", "Google Free only", "Только Google Free")},
								{value: "local_only", label: compactText("仅本地检测", "Local only", "Только локально")}
							],
							onChange: value => {
								if (!plugin.settings.filters) plugin.settings.filters = {};
								plugin.settings.filters.languageDetectionStrategy = value;
								BDFDB.DataUtils.save(value, plugin, "filters", "languageDetectionStrategy");
								plugin.SettingsUpdated = true;
								refreshPanel();
							}
						})
					}),
					createSettingRow({
						label: compactText("本地语言预检测", "Local language pre-check", "Локальное предварительное определение языка"),
						tip: compactText("在请求翻译前辅助识别具体语言，减少无效请求。关闭后，明显已经是目标语言的消息仍会被基础规则跳过。", "Identifies the language before a translation request to reduce wasted calls. Obvious target-language messages are still skipped by the basic guard when this is off.", "Определяет язык до запроса и сокращает лишние вызовы. Явные сообщения на целевом языке по-прежнему пропускаются базовой защитой."),
						control: createSwitch({
							value: plugin.useLocalLanguagePrecheck(),
							label: compactText("本地语言预检测", "Local language pre-check", "Локальное определение языка"),
							onChange: value => {
								saveFilterSetting("useLocalLanguagePrecheck", value);
								refreshPanel();
							}
						})
					}),
					// 语言检测 and 历史补翻 share the third block: group headers alone
					// separate them, keeping the page at three hairline splits total.
					...createLoadedScopeSettings()
				].filter(Boolean);
			};
			// The 2026-08-10 audit (item 39) found the panel rewrite dropped the loaded
			// scope and limit controls while the runtime still read them; users could
			// no longer change how much history each channel backfills.
			const createLoadedScopeSettings = () => {
				const enabled = plugin.getReceivedAutoTranslateScope() == "loaded_messages";
				const currentLimit = String(plugin.getReceivedAutoTranslateLoadedLimit());
				const limitOptions = ["10", "20", "50", "100"];
				if (!limitOptions.includes(currentLimit)) limitOptions.unshift(currentLimit);
				return [
					createGroupHeader(compactText("历史补翻", "History backfill", "Перевод истории")),
					createSettingRow({
						label: compactText("开启频道翻译时，补翻已加载的历史消息", "Backfill loaded history when enabling a channel", "Переводить загруженную историю при включении канала"),
						tip: compactText("关闭 = 只翻新消息。开启后按下方上限一次性补翻最近已加载的历史，进度显示在悬浮胶囊上。", "Off translates only new messages; on backfills recent loaded history up to the limit below, with progress on the floating capsule.", "Если выключено, переводятся только новые сообщения; если включено — история до лимита ниже."),
						className: "translator-backfill-switch",
						control: createSwitch({
							value: enabled,
							label: compactText("历史补翻", "History backfill", "Перевод истории"),
							onChange: value => {
								if (!plugin.settings.filters) plugin.settings.filters = {};
								plugin.settings.filters.receivedAutoTranslateScope = value ? "loaded_messages" : "new_only";
								BDFDB.DataUtils.save(plugin.settings.filters.receivedAutoTranslateScope, plugin, "filters", "receivedAutoTranslateScope");
								plugin.SettingsUpdated = true;
								refreshPanel();
							}
						})
					}),
					el("div", {
						className: cls("translator-backfill-dependent", !enabled && "translator-backfill-dependent-disabled"),
						children: createSettingRow({
							label: compactText("补翻数量上限", "Backfill limit", "Лимит перевода"),
							control: createSelectIn(180, {
								disabled: !enabled,
								value: currentLimit,
								options: limitOptions.map(limit => ({value: limit, label: compactText(`最多补翻 ${limit} 条`, `Backfill up to ${limit}`, `Не более ${limit}`)})),
								onChange: value => {
									if (!enabled) return;
									if (!plugin.settings.filters) plugin.settings.filters = {};
									plugin.settings.filters.receivedAutoTranslateLoadedLimit = value;
									BDFDB.DataUtils.save(value, plugin, "filters", "receivedAutoTranslateLoadedLimit");
									plugin.SettingsUpdated = true;
								}
							})
						})
					})
				];
			};
			/* ===== provider page ===== */
			const getEnginePortalConfig = engineKey => {
				const portal = enginePortals[engineKey];
				if (!portal) return null;
				return {
					primaryUrl: portal.primaryUrl,
					primaryLabel: isChineseUi ? portal.primaryLabelZh : portal.primaryLabelEn,
					secondaryUrl: portal.secondaryUrl,
					secondaryLabel: isChineseUi ? portal.secondaryLabelZh : portal.secondaryLabelEn,
					hint: isChineseUi ? portal.hintZh : portal.hintEn
				};
			};
			const createEnginePortalRow = engineKey => {
				const portal = getEnginePortalConfig(engineKey);
				if (!portal) return null;
				const links = [
					portal.primaryUrl && createButton({label: portal.primaryLabel, icon: createIcon("open", 14), onClick: _ => BDFDB.DiscordUtils.openLink(portal.primaryUrl)}),
					portal.secondaryUrl && portal.secondaryLabel && createButton({label: portal.secondaryLabel, icon: createIcon("open", 14), onClick: _ => BDFDB.DiscordUtils.openLink(portal.secondaryUrl)})
				].filter(Boolean);
				if (!links.length) return null;
				return el("div", {className: "translator-portal-row", children: links});
			};
			// Fetched models feed the model input's own drop list (the reference
			// plugin's combo); a catalog fetched from a different endpoint stays hidden.
			const getFetchedModels = engineKey => {
				const state = plugin.modelCatalogState && plugin.modelCatalogState[engineKey];
				if (!state || !state.items || !state.items.length) return [];
				const auth = plugin.ensureSettingsStore().getCredential(engineKey) || {};
				const engine = translationEngines[engineKey] || {};
				const providerClient = plugin.ensureProviderClient();
				// The expected catalog URL must be derived with the same resolved wire format
				// the fetch used: computed chat-shaped, a Responses/Ollama/Gemini endpoint
				// produces a different key and hides the list the fetch just loaded.
				let format = null;
				try {
					const interfaceStatus = providerClient.getCustomInterfaceStatus(engineKey);
					format = interfaceStatus && interfaceStatus.available && interfaceStatus.resolved || null;
				}
				catch (error) {}
				const options = format ? {format} : {};
				const normalizedEndpoint = providerClient.normalizeApiEndpoint(engineKey, auth.endpoint || engine.endpoint || "", options);
				const currentCatalogEndpoint = providerClient.getModelCatalogEndpoint(engineKey, normalizedEndpoint, options);
				if (state.endpoint && currentCatalogEndpoint && getModelCatalogPersistenceKey(state.endpoint) != getModelCatalogPersistenceKey(currentCatalogEndpoint)) return [];
				return state.items;
			};
			const getModelValidationRecord = engineKey => {
				const validation = plugin.settingsUiState && plugin.settingsUiState.modelValidation;
				if (!validation || validation.engine != engineKey) return null;
				return validation;
			};
			const getModelValidationState = engineKey => {
				const validation = getModelValidationRecord(engineKey);
				if (!validation || validation.stale) return null;
				if (validation.fingerprint) {
					try {if (validation.fingerprint != plugin.ensureProviderClient().getEngineConfigFingerprint(engineKey)) return null;}
					catch (error) {return null;}
				}
				return validation;
			};
			const isCustomProviderKey = engineKey => isCustomEngineKey(engineKey) || !!(translationEngines[engineKey] && translationEngines[engineKey].custom);
			const isBenchmarkRunning = engineKey => !!(plugin.settingsUiState && plugin.settingsUiState.reasoningBenchmark && plugin.settingsUiState.reasoningBenchmark[engineKey] && plugin.settingsUiState.reasoningBenchmark[engineKey].running);
			const runModelValidation = async (engineKey, {rewrite = false} = {}) => {
				flushDeferredSettingsWrites(plugin);
				if (!plugin.settingsUiState) plugin.settingsUiState = {};
				const model = plugin.ensureSettingsStore().getCredentialField(engineKey, "model") || (translationEngines[engineKey] && translationEngines[engineKey].model) || "";
				plugin.settingsUiState.modelValidation = {engine: engineKey, loading: true, model};
				refreshPanel();
				let result;
				try {result = await plugin.validateEngineConfig(engineKey, {rewrite});}
				catch (error) {result = {ok: false, normalized: false, errorClass: "unknown"};}
				let reasoningStatus = null;
				try {reasoningStatus = plugin.ensureProviderClient().getReasoningControlStatus(engineKey);}
				catch (error) {}
				let probeUsage = null;
				let probeEcho = null;
				try {
					const probeClient = plugin.ensureProviderClient();
					probeUsage = probeClient.getLastReasoningProbeUsage(engineKey);
					probeEcho = probeClient.getLastReasoningProbeEcho(engineKey);
				}
				catch (error) {}
				plugin.settingsUiState.modelValidation = {
					engine: engineKey,
					loading: false,
					ok: !!(result && result.ok),
					model,
					durationMs: result && result.durationMs != null ? result.durationMs : null,
					httpStatus: result && result.httpStatus != null ? result.httpStatus : null,
					errorClass: result && result.errorClass || (result && !result.ok && result.durationMs != null && Number(result.httpStatus) == 200 ? "invalid" : null),
					errorParameter: result && result.errorParameter || null,
					fingerprint: reasoningStatus && reasoningStatus.fingerprint || null,
					reasoningMode: reasoningStatus && reasoningStatus.mode || "follow",
					reasoningSupport: reasoningStatus && reasoningStatus.support || null,
					reasoningCandidateId: reasoningStatus && reasoningStatus.candidateId || null,
					reasoningResolvedValue: reasoningStatus && reasoningStatus.resolvedValue || null,
					reasoningEvidence: reasoningStatus && reasoningStatus.evidence || "none",
					reasoningTokens: probeUsage,
					reasoningEchoRaw: probeEcho
				};
				refreshPanel();
			};
			const createCustomProviderSections = (engineKey, validation) => {
				if (!isCustomProviderKey(engineKey)) return null;
				const providerClient = plugin.ensureProviderClient();
				let reasoningState;
				try {reasoningState = providerClient.getReasoningControlStatus(engineKey);}
				catch (error) {reasoningState = {mode: "follow", profile: "auto", effectiveProfile: "openai", effort: "low", support: "provider_default", evidence: "none"};}
				if (!plugin.settingsUiState.customProviderAdvancedExpanded) plugin.settingsUiState.customProviderAdvancedExpanded = {};
				if (!plugin.settingsUiState.customProviderSpeedExpanded) plugin.settingsUiState.customProviderSpeedExpanded = {};
				if (!plugin.settingsUiState.reasoningBenchmark) plugin.settingsUiState.reasoningBenchmark = {};
				const benchmarkState = plugin.settingsUiState.reasoningBenchmark[engineKey] || (plugin.settingsUiState.reasoningBenchmark[engineKey] = {running: false, runId: 0, progress: null, result: null});
				const advancedExpanded = !!plugin.settingsUiState.customProviderAdvancedExpanded[engineKey];
				const speedExpanded = advancedExpanded && !!plugin.settingsUiState.customProviderSpeedExpanded[engineKey];
				const advancedContentId = `translator-provider-advanced-${engineKey}`;
				const speedContentId = `translator-provider-speed-${engineKey}`;
				const updateReasoningPreference = patch => {
					const keys = Object.keys(patch || {});
					if (!keys.some(key => reasoningState[key] !== patch[key])) return false;
					if (benchmarkState.running) {benchmarkState.runId++; providerClient.cancelSyntheticBenchmark(); benchmarkState.running = false;}
					providerClient.setReasoningModelPreference(engineKey, patch);
					clearModelValidation(engineKey);
					plugin.SettingsUpdated = true;
					refreshPanel();
					return true;
				};
				const currentBenchmarkFingerprint = providerClient.getBenchmarkFingerprint(engineKey);
				// Stale means "measured under a different selection": endpoint/model/key,
				// mode, strength or wire family. Verdict fields (support, evidence) move on
				// their own when a validation lands, and must not retire a result whose
				// requests were identical.
				const benchmarkResultStale = benchmarkState.result && (benchmarkState.result.fingerprint !== currentBenchmarkFingerprint || benchmarkState.result.mode !== reasoningState.mode || benchmarkState.result.effort !== reasoningState.effort || benchmarkState.result.profile !== reasoningState.effectiveProfile);
				const displayedBenchmarkResult = benchmarkResultStale ? Object.assign({}, benchmarkState.result, {reason: "stale"}) : benchmarkState.result;
				const benchmarkView = createBenchmarkResultView(displayedBenchmarkResult, key => plugin.getCustomText(key));
				let benchmarkDisabledKey = null;
				if (!plugin.isEngineConfiguredForRuntime(engineKey)) benchmarkDisabledKey = "benchmark_error_configuration";
				else if (reasoningState.mode === "follow") benchmarkDisabledKey = "benchmark_need_mode";
				else if (reasoningState.availability === "unsupported") benchmarkDisabledKey = "custom_status_invalid_strength";
				else if (reasoningState.support === "unsupported") benchmarkDisabledKey = "benchmark_error_reasoning_unsupported";
				// Any sendable selection may measure: the test reports real latencies either
				// way, so an unconfirmed or freshly switched tier needs no validation first.
				else if (providerClient.isBackoffActive()) benchmarkDisabledKey = "benchmark_error_backoff";
				const stopBenchmark = () => {
					if (!benchmarkState.running) return;
					benchmarkState.runId++;
					providerClient.cancelSyntheticBenchmark();
					const progress = benchmarkState.progress || {};
					benchmarkState.running = false;
					benchmarkState.result = {
						mode: reasoningState.mode,
						profile: reasoningState.effectiveProfile,
						effort: reasoningState.effort,
						support: reasoningState.support,
						candidateId: reasoningState.candidateId,
						resolvedValue: reasoningState.resolvedValue,
						evidence: reasoningState.evidence,
						fingerprint: currentBenchmarkFingerprint,
						total: progress.total || SYNTHETIC_BENCHMARK_TEXTS.length * 2,
						completed: progress.completed || 0,
						baseline: {successCount: progress.baselineSuccess || 0, failureCount: 0, p50Ms: null, p95Ms: null, inputChars: 0, outputChars: 0},
						controlled: {successCount: progress.controlledSuccess || 0, failureCount: 0, p50Ms: null, p95Ms: null, inputChars: 0, outputChars: 0},
						cancelled: true,
						reason: "cancelled"
					};
					benchmarkState.progress = null;
					refreshPanel();
				};
				const launchBenchmark = () => {
					const runId = ++benchmarkState.runId;
					benchmarkState.running = true;
					benchmarkState.progress = {total: SYNTHETIC_BENCHMARK_TEXTS.length * 2, completed: 0, fixture: 0, arm: "baseline", baselineSuccess: 0, controlledSuccess: 0};
					benchmarkState.result = null;
					refreshPanel();
					providerClient.runSyntheticBenchmark(engineKey, {
						isCancelled: () => benchmarkState.runId !== runId,
						onProgress: progress => {
							if (benchmarkState.runId !== runId) return;
							benchmarkState.progress = progress;
							refreshPanel();
						}
					}).then(result => {
						if (benchmarkState.runId !== runId) return;
						benchmarkState.running = false;
						benchmarkState.progress = null;
						benchmarkState.result = result;
						refreshPanel();
					}).catch(_ => {
						if (benchmarkState.runId !== runId) return;
						benchmarkState.running = false;
						benchmarkState.progress = null;
						benchmarkState.result = {fingerprint: currentBenchmarkFingerprint, mode: reasoningState.mode, profile: reasoningState.effectiveProfile, effort: reasoningState.effort, support: reasoningState.support, candidateId: reasoningState.candidateId, resolvedValue: reasoningState.resolvedValue, evidence: reasoningState.evidence, total: SYNTHETIC_BENCHMARK_TEXTS.length * 2, completed: 0, baseline: {}, controlled: {}, reason: "provider_failed"};
						refreshPanel();
					});
				};
				const confirmBenchmark = () => {
					if (benchmarkDisabledKey || benchmarkState.running) return;
					if (typeof BdApi != "undefined" && BdApi.UI && typeof BdApi.UI.showConfirmationModal == "function") BdApi.UI.showConfirmationModal(
						plugin.getCustomText("benchmark_title"),
						plugin.getCustomText("benchmark_confirm_body"),
						{confirmText: plugin.getCustomText("benchmark_confirm"), cancelText: compactText("取消", "Cancel", "Отмена"), onConfirm: launchBenchmark}
					);
					else launchBenchmark();
				};
				const benchmarkProgress = benchmarkState.progress;
				const benchmarkArmLabels = createBenchmarkArmLabels(reasoningState, key => plugin.getCustomText(key));
				const benchmarkArmLabel = benchmarkProgress && benchmarkArmLabels[benchmarkProgress.arm == "controlled" ? "controlled" : "baseline"];
				const benchmarkProgressText = benchmarkProgress && replaceTextSlots(plugin.getCustomText("benchmark_progress"), {done: benchmarkProgress.completed || 0, total: benchmarkProgress.total || SYNTHETIC_BENCHMARK_TEXTS.length * 2, fixture: benchmarkProgress.fixture || 0, fixtures: SYNTHETIC_BENCHMARK_TEXTS.length, arm: benchmarkArmLabel});
				const benchmarkPercent = benchmarkProgress ? Math.max(0, Math.min(100, Math.round((benchmarkProgress.completed || 0) / Math.max(1, benchmarkProgress.total || SYNTHETIC_BENCHMARK_TEXTS.length * 2) * 100))) : 0;
				const benchmarkSection = speedExpanded && el("div", {className: "translator-reasoning-benchmark", children: [
					el("div", {className: "translator-benchmark-header", children: [
						el("div", {className: "translator-benchmark-title", children: [plugin.getCustomText("benchmark_title"), el("span", {className: "translator-benchmark-badge", children: plugin.getCustomText("benchmark_badge")})]}),
						createButton({
							label: plugin.getCustomText(benchmarkState.running ? "benchmark_stop" : benchmarkState.result ? "benchmark_retry" : "benchmark_start"),
							disabled: !benchmarkState.running && !!benchmarkDisabledKey,
							title: benchmarkDisabledKey ? plugin.getCustomText(benchmarkDisabledKey) : plugin.getCustomText("benchmark_tip"),
							onClick: benchmarkState.running ? stopBenchmark : confirmBenchmark
						})
					]}),
					// The approved draft prints the method line instead of hiding it in a hover tip.
					el("div", {className: "translator-benchmark-desc", children: plugin.getCustomText("benchmark_tip") + " " + compactText("这里只比较服务商思考设置，不代表当前翻译规则的端到端速度；实际消息耗时请看诊断页。", "This compares provider reasoning settings, not end-to-end translation performance. For actual message latency, use the Diagnostics page.", "Это сравнение настроек размышлений API, а не сквозной скорости перевода. Задержки реальных сообщений смотрите на странице диагностики.")}),
					benchmarkProgressText && el("div", {className: "translator-benchmark-progress-copy", role: "status", children: benchmarkProgressText}),
					benchmarkProgress && el("div", {className: "translator-benchmark-progress", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": benchmarkProgress.total || SYNTHETIC_BENCHMARK_TEXTS.length * 2, "aria-valuenow": benchmarkProgress.completed || 0, children: el("span", {style: {width: `${benchmarkPercent}%`}})}),
					benchmarkView && el("div", {className: "translator-benchmark-results", children: [
						...benchmarkView.rows.map(row => el("div", {className: "translator-benchmark-result-row", key: row.key, children: [el("span", {children: row.key}), el("span", {children: row.value})]})),
						benchmarkView.status && el("div", {className: cls("translator-benchmark-result-status", `translator-benchmark-result-status-${benchmarkView.tone}`), children: benchmarkView.status})
					].filter(Boolean)})
				].filter(Boolean)});
				let interfaceStatus = null;
				try {interfaceStatus = providerClient.getCustomInterfaceStatus(engineKey);}
				catch (error) {interfaceStatus = {requested: "auto", resolved: "openai_chat", evidence: "legacy"};}
				const visibleAdapters = getVisibleAdapterOptions(getRegisteredCustomProtocolAdapters({uiReadyOnly: true}));
				const adapterLabelById = Object.fromEntries(visibleAdapters.map(adapter => [adapter.id, plugin.getCustomText(adapter.labelKey)]));
				const getFormatLabel = id => adapterLabelById[id] || id || "—";
				const resolvedAdapter = visibleAdapters.find(adapter => adapter.id === (interfaceStatus && interfaceStatus.resolved)) || null;
				let validationStale = !!(validation && validation.stale);
				if (!validationStale && validation && validation.fingerprint) try {validationStale = validation.fingerprint !== providerClient.getEngineConfigFingerprint(engineKey);}
				catch (error) {validationStale = true;}
				const statusView = createCustomProviderStatusView({validation, stale: validationStale, interfaceStatus, reasoningState, benchmarkResult: displayedBenchmarkResult, model: reasoningState.model}, key => plugin.getCustomText(key), getFormatLabel);
				const statusId = `translator-provider-status-${engineKey}`;
				// The state the status line is reporting, named once for the eye and the tests.
				const statusState = !plugin.isEngineConfiguredForRuntime(engineKey) ? "unconfigured"
					: validation && validation.loading ? "verifying"
					: reasoningState.mode === "follow" ? "follow"
					: reasoningState.availability === "unsupported" ? "invalid-strength"
					: validation && validation.ok === false ? "error"
					: validationStale ? "stale"
					: reasoningState.support === "unsupported" ? "rejected"
					: reasoningState.support === "reduced" ? "reduced"
					: reasoningState.support === "accepted" ? reasoningState.evidence === "confirmed" ? "confirmed" : reasoningState.evidence === "contradicted" ? "ignored" : "sent"
					: "pending";
				const configured = plugin.isEngineConfiguredForRuntime(engineKey);
				const locallyRefused = reasoningState.availability === "unsupported";
				// One validation action for the whole surface, and it lives in the model row.
				// A value this model is documented to refuse has nothing to ask the endpoint,
				// so the button is disabled and points at the sentence that explains it.
				const validateDisabledKey = !configured ? "benchmark_error_configuration"
					: validation && validation.loading ? "custom_status_detecting"
					: benchmarkState.running ? "detect_disabled_benchmark"
					: locallyRefused ? "custom_status_invalid_strength"
					: null;
				const validateButton = el("button", {
					type: "button",
					disabled: !!validateDisabledKey,
					// A setting that was accepted but never took effect retries through this
					// same button with another known spelling - one action, explained here.
					title: validateDisabledKey ? locallyRefused ? `${plugin.getCustomText(validateDisabledKey)} · ${plugin.getCustomText("thinking_migration_invalid_note")}` : plugin.getCustomText(validateDisabledKey) : statusState === "ignored" ? plugin.getCustomText("thinking_not_applied_tip") : undefined,
					"aria-describedby": statusId,
					className: cls("translator-btn", "translator-btn-sec", "translator-provider-validate"),
					"data-provider-action": "validate-config",
					onClick: _ => runModelValidation(engineKey, statusState === "ignored" ? {rewrite: true} : undefined),
					children: plugin.getCustomText("validate_config")
				});
				const thinkingSlot = el("div", {className: "translator-provider-main-slot", "data-provider-main-slot": "thinking", "data-thinking-field": "mode", children: createSettingRow({
					label: plugin.getCustomText("thinking_mode_label"),
					tip: plugin.getCustomText("thinking_mode_tip"),
					note: reasoningState.mode === "on" ? null : plugin.getCustomText(`thinking_mode_${reasoningState.mode}_note`),
					control: createSelectIn(196, {
						value: reasoningState.mode,
						options: ["follow", "off", "on"].map(value => ({value, label: plugin.getCustomText(`thinking_mode_${value}`)})),
						disabled: benchmarkState.running,
						onChange: value => {
							if (value === reasoningState.mode) return;
							// Following the provider has no controlled arm to compare against.
							if (value === "follow") plugin.settingsUiState.customProviderSpeedExpanded[engineKey] = false;
							if (!updateReasoningPreference({mode: value})) refreshPanel();
						}
					})
				})});
				// The options double as the badge's source: the ladder shape is known in every
				// mode, so following the provider can still describe the model's control.
				let tierOptions = [];
				try {tierOptions = providerClient.getReasoningTierOptions(engineKey) || [];}
				catch (error) {tierOptions = [];}
				const customTier = tierOptions.find(option => option.custom) || null;
				if (!plugin.settingsUiState.customProviderCustomDraft) plugin.settingsUiState.customProviderCustomDraft = {};
				const customDraft = plugin.settingsUiState.customProviderCustomDraft[engineKey] !== undefined ? String(plugin.settingsUiState.customProviderCustomDraft[engineKey]) : null;
				const customErrorId = `translator-provider-custom-error-${engineKey}`;
				// A typed value is checked against the adapter declaration before anything is
				// written, and the reason is said out loud instead of the field going quiet.
				const validateCustomDraft = draft => {
					const value = String(draft == null ? "" : draft).trim();
					if (!value) return plugin.getCustomText("thinking_strength_custom_error_empty");
					if (!customTier || customTier.kind !== "number") return "";
					const parsed = Number(value);
					const min = customTier.min == null ? null : Number(customTier.min);
					const max = customTier.max == null ? null : Number(customTier.max);
					if (!Number.isFinite(parsed) || min != null && parsed < min || max != null && parsed > max) {
						return replaceTextSlots(plugin.getCustomText("thinking_strength_custom_error_range"), {min: min == null ? 0 : min, max: max == null ? "" : max});
					}
					return "";
				};
				const customError = customDraft === null ? "" : validateCustomDraft(customDraft);
				const applyCustomDraft = draft => {
					if (validateCustomDraft(draft)) return refreshPanel();
					const value = String(draft).trim();
					const raw = customTier && customTier.kind === "number" ? Number(value) : value;
					delete plugin.settingsUiState.customProviderCustomDraft[engineKey];
					if (!updateReasoningPreference({mode: "on", effort: raw})) refreshPanel();
				};
				const selectedRawKey = customDraft !== null
					? "custom"
					: (tierOptions.find(option => !option.custom && option.raw === reasoningState.onRaw) || {}).rawKey || "";
				// One compact, redacted sentence about the control's shape: a switch, a count
				// of levels, or a numeric budget. Never a field name, a schema or a raw list.
				const realTiers = tierOptions.filter(option => !option.custom);
				const hasFreshVerdict = !validationStale && (realTiers.some(option => option.state && option.state !== "pending")
					|| reasoningState.support === "accepted" || reasoningState.support === "reduced" || reasoningState.support === "unsupported");
				const capabilityBadge = !hasFreshVerdict ? {key: "capability_badge_pending", state: "pending"}
					: realTiers.length && realTiers.every(option => typeof option.raw == "boolean") ? {key: "capability_badge_switch", state: "switch"}
					: realTiers.some(option => typeof option.raw == "string") ? {key: "capability_badge_tiers", state: "tiers", n: realTiers.length}
					: {key: "capability_badge_budget", state: "budget"};
				const strengthSlot = reasoningState.mode === "on" && el("div", {className: "translator-provider-main-slot", "data-provider-main-slot": "strength", "data-thinking-field": "strength", "data-raw-value": String(reasoningState.dispatchedRaw !== undefined && reasoningState.dispatchedRaw !== null && reasoningState.dispatchedRaw !== "" ? reasoningState.dispatchedRaw : reasoningState.onRaw !== undefined && reasoningState.onRaw !== null ? reasoningState.onRaw : ""), children: [
					createSettingRow({
						label: plugin.getCustomText("thinking_strength_label"),
						tip: plugin.getCustomText("thinking_strength_tip"),
						control: createSelectIn(196, {
							value: selectedRawKey,
							options: [
								...tierOptions.filter(option => !option.custom).map(option => ({
									value: option.rawKey,
									label: formatThinkingRawLabel(option.raw),
									subState: option.availability === "unsupported" ? "invalid" : option.state,
									rawValue: option.raw,
									// The raw stays the label; the gloss says in plain words how
									// strong that raw is, so "minimal" needs no guessing.
									gloss: plugin.getCustomText(thinkingRawGlossKey(option.raw)),
									sub: plugin.getCustomText(`thinking_tier_state_${option.availability === "unsupported" ? "invalid" : option.state}`)
								})),
								...(customTier ? [{value: "custom", label: plugin.getCustomText("thinking_strength_custom"), gloss: plugin.getCustomText("thinking_strength_custom_sub")}] : [])
							],
							renderOption: (option, selected) => el("div", {className: cls("translator-tier-option", selected && "translator-tier-option-selected"), children: [
								el("span", {className: "translator-tier-copy", children: [
									el("span", {className: "translator-tier-raw", children: option.label}),
									option.gloss && el("span", {className: "translator-tier-gloss", children: option.gloss})
								].filter(Boolean)}),
								option.sub && el("span", {className: cls("translator-tier-sub", option.subState && `is-${option.subState}`), "data-tier-state": option.subState || undefined, "data-raw-value": option.rawValue === undefined ? undefined : String(option.rawValue), children: option.sub})
							].filter(Boolean)}),
							disabled: benchmarkState.running,
							onChange: value => {
								if (value === "custom") {
									plugin.settingsUiState.customProviderCustomDraft[engineKey] = "";
									refreshPanel();
									return;
								}
								delete plugin.settingsUiState.customProviderCustomDraft[engineKey];
								const picked = tierOptions.find(option => option.rawKey === value);
								if (!picked) return refreshPanel();
								if (!updateReasoningPreference({mode: "on", effort: picked.raw})) refreshPanel();
							}
						})
					}),
					customDraft !== null && el("div", {className: "translator-row translator-settings-dependent-row translator-tier-custom", "data-thinking-field": "custom", children: [
						createRowLabel(plugin.getCustomText("thinking_strength_custom"), plugin.getCustomText("thinking_strength_custom_tip")),
						el("div", {className: "translator-row-control translator-tier-custom-control", children: [
							el("input", {
								key: `${engineKey}-custom-raw`,
								type: "text",
								className: cls("translator-input", customError && "translator-input-invalid"),
								placeholder: customTier && customTier.kind === "number" ? String(customTier.min == null ? 0 : customTier.min) : "xhigh",
								defaultValue: customDraft,
								spellCheck: false,
								"aria-invalid": customError ? true : undefined,
								"aria-describedby": customError ? customErrorId : undefined,
								"data-raw-value": "custom-input",
								onChange: event => {
									plugin.settingsUiState.customProviderCustomDraft[engineKey] = event.target.value;
									// The message itself is the state: going from "enter a value"
									// to "out of range" is a repaint even though both are errors.
									if (customError !== validateCustomDraft(event.target.value)) refreshPanel();
								},
								// Enter is the keyboard form of pressing Apply, never a silent save.
								onKeyDown: event => {
									if (event.key !== "Enter") return;
									event.preventDefault();
									applyCustomDraft(plugin.settingsUiState.customProviderCustomDraft[engineKey]);
								}
							}),
							el("button", {
								type: "button",
								className: "translator-btn translator-btn-primary translator-tier-custom-apply",
								"data-status-action": "apply-custom",
								disabled: !!customError,
								title: customError || undefined,
								"aria-describedby": customError ? customErrorId : undefined,
								onClick: _ => applyCustomDraft(plugin.settingsUiState.customProviderCustomDraft[engineKey]),
								children: plugin.getCustomText("thinking_strength_custom_apply")
							})
						]}),
						customError && el("div", {id: customErrorId, className: "translator-row-note translator-row-note-error", role: "alert", children: customError})
					].filter(Boolean)})
				].filter(Boolean)});
				// The technical chain prints directly under the sentence whenever there is a
				// failure to explain - a failed request or a refused setting - with no
				// disclosure button in between. A setting that was accepted but never took
				// effect retries through the one validate button (which switches to another
				// known spelling by itself). A locally refused value gets no detail line
				// either - the strength control itself is the next step.
				const validationErrorVisible = !!(validation && !validation.loading && validation.ok === false && !validationStale);
				const diagnosticsVisible = !locallyRefused && (validationErrorVisible || reasoningState.support === "unsupported");
				// The status strip owns the sentence and its technical detail line; the
				// advanced disclosure lives at the card bottom. The sentence wraps inside
				// the tinted strip, it never truncates.
				const statusActions = el("div", {
					id: statusId,
					className: "translator-provider-status-actions translator-provider-main-status",
					"data-provider-main-slot": "status-actions",
					"data-status-tone": statusView.tone || "neutral",
					"data-status-state": statusState,
					role: "status", "aria-live": "polite", "aria-atomic": true,
					title: statusView.title,
					children: [
						el("span", {className: "translator-status-strip-dot", "aria-hidden": true}),
						el("div", {className: "translator-status-strip-body", children: [
							el("span", {className: "translator-status-main", children: statusView.text}),
							statusView.latency && el("div", {className: "translator-status-latency", "data-status-latency": true, children: statusView.latency}),
							diagnosticsVisible && el("div", {className: "translator-provider-diagnostics", "data-provider-diagnostics": "reasoning", role: "note", title: plugin.getCustomText("thinking_migration_rejected_note"), children: validationErrorVisible
								? [createValidationPublicSummary(validation, key => plugin.getCustomText(key)), getSafeValidationErrorParameter(validation)].filter(Boolean).join(" · ")
								: validation && validation.httpStatus ? replaceTextSlots(plugin.getCustomText("thinking_diagnostics_summary"), {status: validation.httpStatus}) : plugin.getCustomText("thinking_diagnostics_summary_plain")})
						].filter(Boolean)})
					].filter(Boolean)
				});
				const advanced = el("div", {className: "translator-provider-advanced", children: [
					el("button", {type: "button", disabled: benchmarkState.running, className: "translator-provider-advanced-toggle", "data-provider-action": "advanced", "aria-expanded": advancedExpanded, "aria-controls": advancedContentId, onClick: _ => {
						plugin.settingsUiState.customProviderAdvancedExpanded[engineKey] = !advancedExpanded;
						if (advancedExpanded) plugin.settingsUiState.customProviderSpeedExpanded[engineKey] = false;
						refreshPanel();
					}, children: [plugin.getCustomText("advanced_settings"), el("span", {className: "translator-provider-advanced-chevron", children: createIcon("expand", 14)})]}),
					advancedExpanded && el("div", {id: advancedContentId, className: "translator-provider-advanced-body", children: [
						el("div", {"data-provider-advanced-field": "format", "data-provider-select": "api-type", children: createSettingRow({label: plugin.getCustomText("api_type"), tip: plugin.getCustomText("api_type_tip"), note: plugin.getCustomText("api_type_note"), control: createSelectIn(196, {
							value: interfaceStatus && interfaceStatus.requested || "auto",
							// Short names keep the 196px trigger readable; the protocol's full name
							// rides along in the title for anyone who needs the exact wire format.
							triggerTitle: plugin.getCustomText(`api_format_${interfaceStatus && interfaceStatus.resolved || "openai_chat"}`),
							options: [{value: "auto", label: plugin.getCustomText("api_type_auto")}, ...visibleAdapters.map(adapter => ({value: adapter.id, label: plugin.getCustomText(`api_type_${adapter.id}_short`)}))],
							disabled: benchmarkState.running,
							onChange: value => {
								if ((interfaceStatus && interfaceStatus.requested || "auto") === value) return;
								if (benchmarkState.running) {benchmarkState.runId++; providerClient.cancelSyntheticBenchmark(); benchmarkState.running = false;}
								saveAuthFieldImmediately(engineKey, "interfaceFormat", value);
								refreshPanel();
							}
						})})}),
						reasoningState.mode !== "follow" && el("div", {className: "translator-provider-speed", "data-speed-state": benchmarkState.running ? "running" : displayedBenchmarkResult ? "done" : "idle", children: [
							el("button", {type: "button", disabled: benchmarkState.running || locallyRefused, title: locallyRefused ? plugin.getCustomText("custom_status_invalid_strength") : undefined, "aria-describedby": locallyRefused ? statusId : undefined, className: "translator-provider-speed-toggle", "data-provider-action": "speed", "aria-expanded": speedExpanded, "aria-controls": speedContentId, onClick: _ => {
								plugin.settingsUiState.customProviderSpeedExpanded[engineKey] = !speedExpanded;
								refreshPanel();
							}, children: [plugin.getCustomText("speed_test"), el("span", {className: "translator-provider-speed-meta", children: [
								el("span", {className: cls("translator-provider-speed-state", !benchmarkState.running && displayedBenchmarkResult && "is-done"), children: plugin.getCustomText(benchmarkState.running ? "benchmark_state_running" : displayedBenchmarkResult ? "benchmark_state_done" : "benchmark_state_idle")}),
								createIcon("expand", 14)
							]})]}),
							speedExpanded && el("div", {id: speedContentId, className: "translator-provider-speed-body", children: benchmarkSection})
						].filter(Boolean)})
					].filter(Boolean)})
				].filter(Boolean)});
				return {thinkingSlot, strengthSlot, statusActions, advanced, validateButton, capabilityBadge};
			};
			const createEngineFields = engineKey => {
				const engine = translationEngines[engineKey];
				if (!engine) return [infoText(plugin.getCustomText("engine_unknown_hint"))];
				if (engineKey == "googleapi") return [createEnginePortalRow(engineKey)].filter(Boolean);
				const customProvider = isCustomProviderKey(engineKey);
				const validation = customProvider ? getModelValidationRecord(engineKey) : getModelValidationState(engineKey);
				const customSections = customProvider ? createCustomProviderSections(engineKey, validation) : null;
				let items = [];
				// The model row belongs to the thinking group on custom providers, so its slot
				// is captured here and pushed inside the group wrapper below.
				let customModelSlot = null;
				const pushFieldNodes = (slot, nodes) => {
					if (!customProvider) return items.push(...nodes);
					const slotNode = el("div", {className: "translator-provider-main-slot", "data-provider-main-slot": slot, children: nodes});
					if (slot === "model") customModelSlot = slotNode;
					else items.push(slotNode);
				};
				if (engine.premium) items.push(createSettingRow({
					label: plugin.getCustomText("paid_version_label"),
					control: createSwitch({
						value: plugin.ensureSettingsStore().getCredentialField(engineKey, "paid"),
						label: plugin.getCustomText("paid_version_label"),
						onChange: value => {
							plugin.ensureSettingsStore().setCredentialFlag(engineKey, "paid", value);
							plugin.SettingsUpdated = true;
							refreshPanel();
						}
					})
				}));
				// Endpoint above key, the reference plugin's field order.
				if (engine.endpoint) {
					pushFieldNodes("endpoint", [createFieldLabel(plugin.getCustomText("api_endpoint_label"), isCustomProviderKey(engineKey) ? plugin.getCustomText("api_endpoint_auto_type_tip") : null), createTextField({
						fieldKey: `${engineKey}-endpoint`,
						placeholder: engine.endpoint,
						value: plugin.ensureSettingsStore().getCredentialField(engineKey, "endpoint"),
						onChange: value => saveAuthField(engineKey, "endpoint", value),
						onBlur: _ => customProvider ? flushAuthFieldAndRefresh(engineKey, "endpoint") : flushAuthField(engineKey, "endpoint")
					})]);
				}
				if (engineKey == "baidu") {
					const secretLabel = compactText("密钥", "Secret key", "Секретный ключ");
					items.push(createFieldLabel("APP ID", compactText("在百度翻译开放平台的开发者信息中获取 APP ID 和密钥；这里使用通用文本翻译服务。", "Find the APP ID and secret key in your Baidu Translate developer information. This provider uses the General Text Translation service.", "APP ID и секретный ключ доступны в сведениях разработчика Baidu Translate. Используется сервис обычного перевода текста.")), createTextField({
						fieldKey: "baidu-appId", ariaLabel: "APP ID", placeholder: "APP ID",
						value: plugin.ensureSettingsStore().getCredentialField(engineKey, "appId"),
						onChange: value => saveAuthField(engineKey, "appId", value),
						onBlur: _ => flushAuthField(engineKey, "appId")
					}), createFieldLabel(secretLabel), createSecretInput({
						fieldKey: "baidu-secretKey", ariaLabel: secretLabel, placeholder: secretLabel,
						value: plugin.ensureSettingsStore().getCredentialField(engineKey, "secretKey"),
						onChange: value => saveAuthField(engineKey, "secretKey", value),
						onBlur: _ => flushAuthField(engineKey, "secretKey")
					}));
				}
				else if (engine.key) {
					let keyPlaceholder = engine.key;
					if (customProvider) try {
						const interfaceStatus = plugin.ensureProviderClient().getCustomInterfaceStatus(engineKey);
						const adapter = getRegisteredCustomProtocolAdapters().find(item => item.id === interfaceStatus.resolved);
						if (adapter && adapter.credentialPlaceholderKey) keyPlaceholder = plugin.getCustomText(adapter.credentialPlaceholderKey);
						else if (adapter && adapter.credentialPolicy === "optional") keyPlaceholder = plugin.getCustomText("api_key_optional_placeholder");
					}
					catch (error) {}
					pushFieldNodes("key", [createFieldLabel(plugin.getCustomText("api_key_label")), createSecretInput({
						fieldKey: `${engineKey}-key`,
						placeholder: keyPlaceholder,
						value: plugin.ensureSettingsStore().getCredentialField(engineKey, "key"),
						onChange: value => saveAuthField(engineKey, "key", value),
						onBlur: _ => customProvider ? flushAuthFieldAndRefresh(engineKey, "key") : flushAuthField(engineKey, "key")
					})]);
				}
				if (engine.model) {
					const modelCatalogState = plugin.modelCatalogState && plugin.modelCatalogState[engineKey];
					items.push(createSplit());
					const modelTip = engineKey == "googlecloud"
						? compactText("留空使用默认 NMT 神经机器翻译，无需手动选择。其他受支持模型按 Google 官方文档填写；验证配置会发送一条试翻。", "Leave empty for default NMT neural machine translation; no selection is required. For other supported models, follow Google's documentation. Validation sends one sample translation.", "Оставьте пустым для нейронного перевода NMT; выбирать модель не нужно. Другие поддерживаемые модели указываются по документации Google. Проверка отправляет тестовый перевод.")
						: compactText("「获取模型列表」把服务商的可选模型拉进这个输入框的下拉列表（结果会保存，重启不用重拉）；「验证配置」发一条试翻确认当前配置可用。", "“Fetch models” pulls the provider's models into this field's own dropdown (saved across restarts); “Validate configuration” sends one sample translation to confirm it works.", "«Получить модели» загружает модели в список этого поля; «Проверить настройку» отправляет тестовый перевод.");
					const modelNodes = [createFieldLabel(plugin.getCustomText("model_id_label"), modelTip), el("div", {
						className: "translator-model-row",
						children: [
							el(ModelCombo, {
								key: `${engineKey}-model`,
								ariaLabel: plugin.getCustomText("model_id_label"),
								placeholder: engine.model,
								value: plugin.ensureSettingsStore().getCredentialField(engineKey, "model"),
								models: getFetchedModels(engineKey),
								autoOpen: plugin.settingsUiState && plugin.settingsUiState.modelComboAutoOpen && plugin.settingsUiState.modelComboAutoOpen.engine == engineKey ? plugin.settingsUiState.modelComboAutoOpen : null,
								openLabel: compactText("展开模型列表", "Open the model list", "Открыть список моделей"),
								emptyLabel: compactText("没有匹配项", "No matching options", "Нет совпадений"),
								onChange: value => saveAuthField(engineKey, "model", value),
								onSelect: value => {saveAuthFieldImmediately(engineKey, "model", value); if (customProvider) refreshPanel();},
								onBlur: _ => customProvider ? flushAuthFieldAndRefresh(engineKey, "model") : flushAuthField(engineKey, "model")
							}),
							plugin.supportsModelCatalog(engineKey) && createIconButton({
								icon: createIcon("refresh", 15),
								title: modelCatalogState && modelCatalogState.loading ? plugin.getCustomText("model_fetch_loading") : plugin.getCustomText("model_fetch_button"),
								disabled: !!(modelCatalogState && modelCatalogState.loading),
								attrs: {"data-provider-action": "fetch-models", "aria-busy": !!(modelCatalogState && modelCatalogState.loading) || undefined},
								onClick: _ => {
									flushDeferredSettingsWrites(plugin);
									// The reference plugin pops the list open right after a
									// fetch so the user sees where the models landed.
									return plugin.fetchModelCatalog(engineKey, refreshPanel).then(result => {
										if (result && result.ok && Array.isArray(result.items) && result.items.length) {
											if (!plugin.settingsUiState) plugin.settingsUiState = {};
											plugin.settingsUiState.modelComboAutoOpen = {engine: engineKey};
											refreshPanel();
										}
									});
								}
							}),
							customProvider ? customSections && customSections.validateButton : plugin.isValidatableEngine(engineKey) && createButton({
								label: plugin.getCustomText("validate_config"),
								disabled: !!(validation && validation.loading) || isBenchmarkRunning(engineKey),
								onClick: _ => runModelValidation(engineKey)
							})
						].filter(Boolean)
					})];
					pushFieldNodes("model", modelNodes);
					// Fetch progress lives on the refresh button itself (title, disabled,
					// aria-busy): a separate banner outside the model row jolts the layout.
					const validationView = !customProvider && createModelValidationView(validation, validation && validation.model, key => plugin.getCustomText(key));
					if (validationView) items.push(el("div", {
						className: cls("translator-status", "translator-model-validation-status", validationView.tone == "ok" && "translator-status-ok", validationView.tone == "fail" && "translator-status-fail"),
						role: "status",
						"aria-live": "polite",
						title: `${validationView.main}${validationView.detail ? `\n${validationView.detail}` : ""}`,
						children: [
							el("span", {className: "translator-status-main", children: validationView.main}),
							validationView.detail && el("span", {className: cls("translator-status-detail", validationView.detailTone && `translator-status-detail-${validationView.detailTone}`), children: validationView.detail})
						].filter(Boolean)
					}));
				}
				if (customSections) {
					// One group for "which model, what it thinks, what we know": the model row,
					// the mode, the strength, the status and the advanced disclosure all live
					// inside the one bordered container, the way the frozen artboard draws it.
					items.push(el("div", {className: "translator-thinking-group", "data-thinking-group": engineKey, children: [
						el("div", {className: "translator-thinking-group-head", children: [
							el("span", {className: "translator-thinking-group-title", children: plugin.getCustomText("thinking_group_title")}),
							customSections.capabilityBadge && el("span", {
								className: "translator-thinking-group-badge",
								"data-capability-badge": customSections.capabilityBadge.state,
								title: plugin.getCustomText("capability_badge_tip"),
								children: replaceTextSlots(plugin.getCustomText(customSections.capabilityBadge.key), {n: customSections.capabilityBadge.n || 0})
							})
						].filter(Boolean)}),
						customModelSlot, customSections.thinkingSlot, customSections.strengthSlot, customSections.statusActions, customSections.advanced
					].filter(Boolean)}));
				}
				else if (customModelSlot) items.push(customModelSlot);
				if (engineKey == "microsoft") {
					items.push(createFieldLabel(String(plugin.getCustomText("microsoft_region_label") || "").replace(/[：:]\s*$/, "")));
					items.push(el("div", {className: "translator-provider-region-select", children: createSelectIn("100%", {
						value: plugin.ensureSettingsStore().getCredentialField(engineKey, "region") || "global",
						options: [
							{value: "global", label: "Global"},
							{value: "eastasia", label: "East Asia"},
							{value: "southeastasia", label: "Southeast Asia"},
							{value: "centralus", label: "Central US"},
							{value: "eastus", label: "East US"},
							{value: "eastus2", label: "East US 2"},
							{value: "westus", label: "West US"},
							{value: "westeurope", label: "West Europe"},
							{value: "japaneast", label: "Japan East"}
						],
						onChange: value => saveAuthFieldImmediately(engineKey, "region", value)
					})}));
				}
				const portalRow = createEnginePortalRow(engineKey);
				if (portalRow) items.push(portalRow);
				if (!items.length) items.push(infoText(plugin.getCustomText("engine_no_extra_fields")));
				return items;
			};
			// Group membership, archiving and row order live in provider-catalog.js so the
			// channel popout's provider select shows exactly these rows.
			const providerGroupLabels = {
				ai: compactText("AI 服务", "AI services", "AI-сервисы"),
				machine: compactText("机器翻译", "Machine translation", "Машинный перевод")
			};
			const providerGroups = PROVIDER_GROUPS.map(group => Object.assign({label: providerGroupLabels[group.id]}, group));
			// The reference plugin's head-card summary: fetched models beat
			// "configured", which beats "unset". Keyless Google is always ready.
			const getProviderStatusText = engineKey => {
				if (engineKey == "googleapi") return compactText("无需配置，开箱即用", "No setup needed, ready to use", "Без настройки, готов к работе");
				const catalogState = plugin.modelCatalogState && plugin.modelCatalogState[engineKey];
				const modelsCount = catalogState && Array.isArray(catalogState.items) ? catalogState.items.length : 0;
				if (plugin.supportsModelCatalog(engineKey) && modelsCount) return compactText(`已获取 ${modelsCount} 个可用模型`, `${modelsCount} models available`, `Доступно моделей: ${modelsCount}`);
				if (!isProviderConfigured(engineKey)) return compactText("尚未配置", "Not configured yet", "Ещё не настроено");
				return plugin.supportsModelCatalog(engineKey)
					? compactText("已配置，尚未获取模型", "Configured, models not fetched", "Настроено, модели не получены")
					: compactText("已配置", "Configured", "Настроено");
			};
			// Official brand marks (the reference plugin's PROVIDER_ICON_SVGS pattern);
			// custom providers draw the plugin's own translate glyph in brand color.
			const createProviderGlyph = engineKey => {
				if (engineKey == "deepseek") return createBrandIcon(DEEPSEEK_ICON_PATH, "#5786FE");
				if (engineKey == "openai") return createBrandIcon(OPENAI_ICON_PATH);
				if (engineKey == "gemini") return createGeminiIcon();
				if (engineKey == "googleapi") return createBrandIcon(GOOGLE_ICON_PATH, "#4285F4");
				if (engineKey == "googlecloud") return createBrandIcon(GOOGLECLOUD_ICON_PATH, "#4285F4");
				if (engineKey == "microsoft") return createBrandIcon(AZURE_ICON_PATH, "#0078D4");
				if (engineKey == "deepl") return createBrandIcon(DEEPL_ICON_PATH);
				if (engineKey == "papago") return createBrandIcon(NAVER_ICON_PATH, "#03C75A");
				if (engineKey == "baidu") return createBrandIcon(BAIDU_ICON_PATH, "#2932E1");
				if (isCustomProviderKey(engineKey)) return el("span", {className: "translator-provider-custom-glyph", children: createTranslateGlyph()});
				return el("span", {className: "translator-provider-initial", children: engineKey.slice(0, 2).toUpperCase()});
			};
			const isProviderConfigured = engineKey => engineKey == "googleapi" || !!(plugin.isEngineConfiguredForRuntime && plugin.isEngineConfiguredForRuntime(engineKey));
			// Custom OpenAI-compatible providers (the reference plugin's ai.custom list):
			// stored as engines.customProviders, registered into the engine tables by
			// setLanguages(). The legacy "oaicompat" slot migrates in as the first row
			// when it was configured or selected, so nothing needs remapping.
			const ensureCustomProviders = () => {
				if (!BDFDB.ArrayUtils.is(plugin.settings.engines.customProviders)) {
					const seeded = [];
					const referenced = plugin.settings.engines.translator == "oaicompat" || plugin.settings.engines.backup == "oaicompat";
					if (referenced || isProviderConfigured("oaicompat")) seeded.push({id: "oaicompat", name: ""});
					plugin.settings.engines.customProviders = seeded;
					BDFDB.DataUtils.save(plugin.settings.engines, plugin, "engines");
					plugin.setLanguages();
				}
				return normalizeCustomProviders(plugin.settings.engines.customProviders);
			};
			const saveCustomProviders = entries => {
				plugin.settings.engines.customProviders = entries;
				BDFDB.DataUtils.save(plugin.settings.engines, plugin, "engines");
				plugin.setLanguages();
				plugin.SettingsUpdated = true;
			};
			const addCustomProvider = () => {
				const entries = ensureCustomProviders().slice();
				const id = entries.some(entry => entry.id == "oaicompat") || isProviderConfigured("oaicompat") ? createCustomEngineId() : "oaicompat";
				if (!entries.some(entry => entry.id == id)) entries.push({id, name: ""});
				saveCustomProviders(entries);
				plugin.settingsUiState.provider = id;
				plugin.settingsUiState.renamingProvider = id;
				refreshPanel();
			};
			const renameCustomProvider = (engineKey, name) => {
				saveCustomProviders(ensureCustomProviders().map(entry => entry.id == engineKey ? {id: entry.id, name: String(name || "").trim().slice(0, 60)} : entry));
			};
			const removeCustomProvider = engineKey => {
				const entries = ensureCustomProviders().filter(entry => entry.id != engineKey);
				const label = plugin.getEngineLabel(engineKey);
				const remove = () => {
					plugin.ensureProviderClient().cancelSyntheticBenchmark();
					if (plugin.settings.engines.translator == engineKey) plugin.settings.engines.translator = "googleapi";
					if (plugin.settings.engines.backup == engineKey) plugin.settings.engines.backup = "----";
					plugin.ensureSettingsStore().deleteCredential(engineKey);
					try {plugin.ensureProviderClient().invalidateReasoningCapabilities(engineKey);}
					catch (error) {}
					saveCustomProviders(entries);
					plugin.settingsUiState.provider = "googleapi";
					plugin.settingsUiState.renamingProvider = null;
					refreshPanel();
				};
				if (typeof BdApi != "undefined" && BdApi.UI && typeof BdApi.UI.showConfirmationModal == "function") BdApi.UI.showConfirmationModal(
					compactText("删除自定义平台", "Delete custom provider", "Удалить платформу"),
					compactText(`确定删除“${label}”吗？其接口地址、密钥和模型设置将一并清除。`, `Delete “${label}”? Its endpoint, key and model settings are removed with it.`, `Удалить «${label}»? Настройки будут удалены.`),
					{danger: true, confirmText: compactText("删除", "Delete", "Удалить"), cancelText: compactText("取消", "Cancel", "Отмена"), onConfirm: remove}
				);
				else remove();
			};
			const createProviderWorkspace = () => {
				if (!plugin.settingsUiState) plugin.settingsUiState = {};
				const customEntries = ensureCustomProviders();
				if (!translationEngines[plugin.settingsUiState.provider]) plugin.settingsUiState.provider = translationEngines[plugin.settings.engines.translator] ? plugin.settings.engines.translator : "googleapi";
				const selectedProvider = plugin.settingsUiState.provider;
				const configuredPaid = Object.keys(translationEngines).some(engineKey => engineKey != "googleapi" && isProviderConfigured(engineKey));
				const selectProvider = engineKey => {
					if (!translationEngines[engineKey]) return;
					const currentBenchmark = plugin.settingsUiState.reasoningBenchmark && plugin.settingsUiState.reasoningBenchmark[plugin.settingsUiState.provider];
					if (currentBenchmark && currentBenchmark.running) {currentBenchmark.runId++; plugin.ensureProviderClient().cancelSyntheticBenchmark(); currentBenchmark.running = false;}
					flushDeferredSettingsWrites(plugin);
					plugin.settingsUiState.provider = engineKey;
					plugin.settingsUiState.renamingProvider = null;
					refreshPanel();
				};
				const toggleBackup = engineKey => {
					if (engineKey == plugin.settings.engines.translator) return;
					updateEngineSetting("backup", plugin.settings.engines.backup == engineKey ? "----" : engineKey);
				};
				// The static "oaicompat" slot in the AI group expands into the live
				// custom-provider rows, so the whole custom list renders where the old
				// single row sat and hides entirely while the list is empty. Archived
				// stock rows stay only while serving as primary/backup or currently open.
				const resolveGroupKeys = group => resolveProviderGroupKeys(group, {
					engines: translationEngines,
					customProviderIds: customEntries.map(entry => entry.id),
					getLabel: engineKey => plugin.getEngineLabel(engineKey),
					keepKeys: [plugin.settings.engines.translator, plugin.settings.engines.backup, selectedProvider]
				});
				const providerRail = el("nav", {
					className: "translator-provider-rail",
					"aria-label": compactText("翻译服务商", "Translation providers", "Провайдеры перевода"),
					children: [
						...providerGroups.map(group => el(BdApi.React.Fragment, {
							key: group.label,
							children: [
								el("div", {className: "translator-provider-group-title", children: group.label}),
								...resolveGroupKeys(group).map(engineKey => el("button", {
									type: "button",
									className: cls("translator-provider-option", engineKey == selectedProvider && "translator-provider-option-active"),
									"aria-pressed": engineKey == selectedProvider,
									onClick: _ => selectProvider(engineKey),
									children: [
										el("span", {className: "translator-provider-ic", children: [
											createProviderGlyph(engineKey),
											isProviderConfigured(engineKey) && el("span", {className: "translator-provider-dot", "aria-label": compactText("已配置", "Configured", "Настроено")})
										].filter(Boolean)}),
										el("span", {className: "translator-provider-name", title: plugin.getEngineLabel(engineKey), children: plugin.getEngineLabel(engineKey)}),
										plugin.settings.engines.translator == engineKey && el("span", {className: "translator-provider-role translator-provider-role-primary", children: compactText("主", "Main", "Осн.")}),
										plugin.settings.engines.backup == engineKey && el("span", {className: "translator-provider-role translator-provider-role-backup", children: compactText("备", "Backup", "Рез.")})
									].filter(Boolean)
								}))
							]
						})),
						el("button", {
							type: "button",
							className: "translator-provider-add",
							onClick: addCustomProvider,
							children: [createIcon("add", 13), compactText("添加自定义平台", "Add custom provider", "Добавить платформу")]
						})
					]
				});
				const selectedIsPrimary = plugin.settings.engines.translator == selectedProvider;
				const selectedIsBackup = plugin.settings.engines.backup == selectedProvider;
				const selectedConfigured = isProviderConfigured(selectedProvider);
				const selectedIsCustom = isCustomProviderKey(selectedProvider);
				const backupHint = selectedIsPrimary
					? compactText("主服务不能同时作为备用。", "The primary provider cannot also be the backup.", "Основной не может быть резервным.")
					: compactText("备用只在主服务失败时接手。再点一次取消备用。", "The backup takes over only when the primary fails. Click again to remove it.", "Резервный включается только при сбое основного. Нажмите ещё раз, чтобы убрать.");
				const backupButton = createButton({
					disabled: selectedIsPrimary,
					title: backupHint,
					onClick: _ => toggleBackup(selectedProvider),
					label: selectedIsBackup ? compactText("取消备用", "Remove backup", "Убрать резерв") : compactText("备用", "Backup", "Резервный")
				});
				// Custom providers rename inline in the head card, the reference
				// plugin's InlineName pattern: click the name to edit, Enter/blur keeps
				// the change, Escape restores the value from edit start.
				const renaming = plugin.settingsUiState.renamingProvider == selectedProvider;
				const cardName = selectedIsCustom
					? (renaming
						? el("input", {
							key: `${selectedProvider}-rename`,
							className: "translator-provider-rename-input",
							defaultValue: (customEntries.find(entry => entry.id == selectedProvider) || {}).name || "",
							placeholder: compactText("自定义平台", "Custom provider", "Платформа"),
							maxLength: 60,
							autoFocus: true,
							spellCheck: false,
							"aria-label": compactText("平台名称", "Provider name", "Название платформы"),
							onKeyDown: event => {
								if (event.key == "Enter") {
									event.preventDefault();
									renameCustomProvider(selectedProvider, event.target.value);
									plugin.settingsUiState.renamingProvider = null;
									refreshPanel();
								}
								else if (event.key == "Escape") {
									event.preventDefault();
									plugin.settingsUiState.renamingProvider = null;
									refreshPanel();
								}
							},
							onBlur: event => {
								renameCustomProvider(selectedProvider, event.target.value);
								plugin.settingsUiState.renamingProvider = null;
								refreshPanel();
							}
						})
						: el("button", {
							type: "button",
							className: "translator-provider-rename",
							title: compactText("点击修改名称", "Click to rename", "Нажмите, чтобы переименовать"),
							onClick: _ => {
								plugin.settingsUiState.renamingProvider = selectedProvider;
								refreshPanel();
							},
							children: [
								el("span", {className: "translator-provider-card-title", children: plugin.getEngineLabel(selectedProvider)}),
								el("span", {className: "translator-provider-pencil", "aria-hidden": true, children: createIcon("pencil", 12)})
							]
						}))
					: el("div", {className: cls("translator-provider-card-title", selectedProvider == "googlecloud" && "translator-provider-card-title-full"), children: selectedProvider == "googlecloud" ? "Cloud Translation" : plugin.getEngineLabel(selectedProvider)});
				const providerCardActions = el("div", {className: "translator-provider-card-actions", children: [
					el("div", {className: "translator-provider-role-actions", children: [
					selectedIsPrimary
						? el("span", {className: "translator-provider-badge", children: compactText("主服务中", "Primary", "Основной")})
						: createButton({kind: "primary", onClick: _ => updateEngineSetting("translator", selectedProvider), label: compactText("主服务", "Primary", "Основной")}),
					backupButton,
					]}),
					selectedIsCustom && createIconButton({
						icon: createIcon("trash", 15),
						danger: true,
						title: compactText("删除此自定义平台", "Delete this custom provider", "Удалить эту платформу"),
						onClick: _ => removeCustomProvider(selectedProvider)
					})
				].filter(Boolean)});
				const detail = el("div", {
					className: "translator-provider-detail",
					children: [
						el("div", {
							className: "translator-provider-card",
							children: [
								el("span", {className: cls("translator-provider-tile", selectedIsCustom && "translator-provider-tile-custom"), children: createProviderGlyph(selectedProvider)}),
								el("div", {className: "translator-provider-card-copy", children: [
									cardName,
									el("div", {className: cls("translator-provider-card-description", selectedConfigured && "translator-provider-card-description-ok"), children: getProviderStatusText(selectedProvider)})
								]}),
								providerCardActions
							].filter(Boolean)
						}),
						...createEngineFields(selectedProvider)
					]
				});
				return el("div", {
					className: "translator-provider-page",
					children: [
						!configuredPaid && el("div", {
							className: "translator-provider-onboarding",
							children: [
								el("span", {className: "translator-provider-onboarding-icon", children: createTranslateGlyph()}),
								el("div", {children: [
									el("div", {className: "translator-provider-onboarding-title", children: compactText("当前可使用 Google 免费翻译", "Google Free translation is ready now", "Google Free уже доступен")}),
									el("div", {className: "translator-provider-onboarding-body", children: [
										el("b", {children: compactText("Google（免费）", "Google (free)", "Google (бесплатно)")}),
										compactText("无需密钥，开箱即用。想要更高质量，推荐配一家 AI 服务（如 ", " needs no key. For higher quality, configure an AI provider (for example ", " не требует ключа. Для лучшего качества настройте AI-провайдера (например "),
										el("b", {children: "DeepSeek"}),
										compactText("）：填入 API 密钥，点「设为主服务」即可。", "): paste its API key, then press “Set primary”.", "): вставьте API-ключ и нажмите «Сделать основным».")
									]})
								]})
							]
						}),
						el("div", {className: "translator-provider-workspace", children: [providerRail, detail]})
					].filter(Boolean)
				});
			};
			/* ===== diagnostics page ===== */
			if (!plugin.settingsUiState) plugin.settingsUiState = {};
			const createDiagnosticsContent = () => {
				const configuredProviders = Object.keys(translationEngines).filter(engineKey => isProviderConfigured(engineKey));
				const updateState = plugin.settingsUiState.updateCheck || (plugin.settingsUiState.updateCheck = {loading: false, result: null, error: ""});
				// Health signals mirror the reference plugin's DiagPage: a neutral host
				// row first, then status rows whose dot color reads without the text.
				const bdfdbLoaded = typeof window != "undefined" && !!(window.BDFDB_Global && window.BDFDB_Global.loaded);
				let capsuleHealthy = false;
				try {capsuleHealthy = !!(plugin.ensureLoadedStatusCapsuleController && plugin.ensureLoadedStatusCapsuleController());}
				catch (err) {capsuleHealthy = false;}
				const okOrMissing = healthy => healthy ? compactText("正常", "ok", "в порядке") : compactText("缺失", "missing", "отсутствует");
				const uiLanguageName = isChineseUi ? "中文" : isRussianUi ? "Русский" : "English";
				const diagnosticsRows = [
					[compactText("BDFDB 库", "BDFDB library", "Библиотека BDFDB"), okOrMissing(bdfdbLoaded), bdfdbLoaded ? "ok" : "fail"],
					[compactText("主服务", "Primary provider", "Основной провайдер"), isProviderConfigured(plugin.settings.engines.translator) ? plugin.getEngineLabel(plugin.settings.engines.translator) : `${plugin.getEngineLabel(plugin.settings.engines.translator)} · ${compactText("未配置", "not configured", "не настроен")}`, isProviderConfigured(plugin.settings.engines.translator) ? "ok" : "fail"],
					[compactText("备用服务", "Backup provider", "Резервный провайдер"), plugin.settings.engines.backup == "----" ? compactText("无", "None", "Нет") : isProviderConfigured(plugin.settings.engines.backup) ? plugin.getEngineLabel(plugin.settings.engines.backup) : `${plugin.getEngineLabel(plugin.settings.engines.backup)} · ${compactText("未配置", "not configured", "не настроен")}`, plugin.settings.engines.backup == "----" || isProviderConfigured(plugin.settings.engines.backup) ? "ok" : "fail"],
				];
				const environmentRows = [
					[compactText("构建", "Build", "Сборка"), buildId || "?", "neutral"],
					["BetterDiscord", typeof BdApi != "undefined" && BdApi.version || "?", "neutral"],
					[compactText("消息重绘通道", "Message repaint channel", "Канал перерисовки"), okOrMissing(!!rebuildStats), rebuildStats ? "ok" : "fail"],
					[compactText("补翻胶囊", "Backfill capsule", "Капсула статуса"), okOrMissing(capsuleHealthy), capsuleHealthy ? "ok" : "fail"],
					[compactText("重绘统计", "Repaint statistics", "Статистика перерисовки"), rebuildStats ? `${rebuildStats.live || 0}L / ${rebuildStats.rebuild || 0}R / ${fullRepaints || 0}F` : "?", "neutral"],
					[compactText("界面语言", "Interface language", "Язык интерфейса"), uiLanguageName, "neutral"],
				];
				let latencySnapshot = {}, attemptSnapshot = {};
				try {
					const providerClient = plugin.ensureProviderClient();
					latencySnapshot = providerClient.getLatencySnapshot();
					attemptSnapshot = providerClient.getProviderAttemptSnapshot();
				}
				catch (err) {latencySnapshot = {}; attemptSnapshot = {};}
				const aiPerformanceRows = createAiPerformanceRows(latencySnapshot, engineKey => plugin.getEngineLabel(engineKey), key => plugin.getCustomText(key), attemptSnapshot);
				const aiLatencyDiagnostics = createAiLatencyDiagnosticsPayload(latencySnapshot, attemptSnapshot);
				let historicalPerformance = {}, livePerformance = {}, terminalLedger = {}, translationPlanShadow = {};
				try {
					const history = plugin.getHistoricalBatchPerformanceSnapshot();
					historicalPerformance = history || {};
					const liveQueue = plugin.ensureLiveTranslationQueue();
					livePerformance = {capacity: liveQueue.getLiveSlotCapacity(), active: liveQueue.getLiveSlotActiveCount(), queued: liveQueue.getQueueLength()};
					terminalLedger = typeof plugin.getTranslationTerminalLedgerSnapshot == "function" ? plugin.getTranslationTerminalLedgerSnapshot() || {} : {};
					translationPlanShadow = typeof plugin.getTranslationPlanShadowSnapshot == "function" ? plugin.getTranslationPlanShadowSnapshot() || {} : {};
				}
				catch (error) {historicalPerformance = {}; livePerformance = {}; terminalLedger = {}; translationPlanShadow = {};}
				// Same shape as the reference plugin's copy payload: one pretty JSON blob.
				const diagnosticsText = JSON.stringify(createDiagnosticsCopyPayload({
					plugin: `DiscordAITranslator v${plugin.getVersion()}`,
					build: buildId || "?",
					betterdiscord: typeof BdApi != "undefined" && BdApi.version || "?",
					bdfdb: bdfdbLoaded ? "ok" : "missing",
					repaintChannel: rebuildStats ? "ok" : "missing",
					capsule: capsuleHealthy ? "ok" : "missing",
					primary: plugin.settings.engines.translator,
					backup: plugin.settings.engines.backup,
					providers: configuredProviders.join(","),
					repaint: rebuildStats ? `${rebuildStats.live || 0}L/${rebuildStats.rebuild || 0}R/${fullRepaints || 0}F` : "?",
					locale: uiLanguageName,
					performanceControls: {
						settings: {
							historicalConcurrency: plugin.settings.performance && plugin.settings.performance.historicalConcurrency || "auto",
							historicalSafetyDownshift: !plugin.settings.performance || plugin.settings.performance.historicalSafetyDownshift !== false,
							liveConcurrency: plugin.settings.performance && plugin.settings.performance.liveConcurrency || "1",
							liveStreaming: !plugin.settings.performance || plugin.settings.performance.liveStreaming !== false,
							compactWireShadow: plugin.settings.performance && plugin.settings.performance.compactWireShadow === "shadow" ? "shadow" : "off"
						},
						historical: historicalPerformance,
						live: livePerformance,
						terminalLedger,
						translationPlanShadow
					}
				}, aiLatencyDiagnostics), null, 2);
				const runUpdateCheck = async () => {
					updateState.loading = true;
					updateState.error = "";
					refreshPanel();
					try {
						updateState.result = await checkForUpdate({currentVersion: plugin.getVersion(), fetch: (url, init) => BdApi.Net.fetch(url, init)});
					}
					catch (error) {updateState.error = error && error.message || String(error);}
					finally {updateState.loading = false; refreshPanel();}
				};
				let updateText = "";
				let updateTone = "";
				if (updateState.error) {updateText = compactText(`检查失败：${updateState.error}`, `Update check failed: ${updateState.error}`, `Ошибка проверки: ${updateState.error}`); updateTone = "fail";}
				else if (updateState.result) {
					if (updateState.result.status == "available") {updateText = compactText(`发现新版本 v${updateState.result.latest}`, `Version v${updateState.result.latest} is available`, `Доступна версия v${updateState.result.latest}`); updateTone = "available";}
					else if (updateState.result.status == "development") {updateText = compactText(`当前版本高于稳定版 v${updateState.result.latest}`, `Current build is newer than stable v${updateState.result.latest}`, `Текущая версия новее стабильной v${updateState.result.latest}`); updateTone = "neutral";}
					else {updateText = compactText(`当前已是最新版本 v${updateState.result.latest}`, `Latest stable version v${updateState.result.latest}`, `Установлена последняя версия v${updateState.result.latest}`); updateTone = "ok";}
				}
				const openLink = url => BDFDB.DiscordUtils.openLink(url);
				return el("div", {className: "translator-diagnostics", children: [
					createGroupHeader(compactText("关于", "About", "О плагине")),
					el("div", {className: "translator-about-card", children: [
						el("div", {className: "translator-about-identity", children: [
							el("div", {className: "translator-about-icon", children: createTranslateGlyph()}),
							el("div", {className: "translator-about-copy", children: [
								el("div", {className: "translator-about-name", children: "DiscordAITranslator"}),
								el("div", {className: "translator-about-description", children: compactText("自动翻译收发消息 · 支持多家翻译服务与 AI 判定", "Translates sent and received messages · Translation services and AI", "Автоперевод сообщений · Сервисы перевода и AI")})
							]}),
							el("div", {className: "translator-about-release", children: [
								el("span", {className: "translator-about-version", children: `v${plugin.getVersion()}`})
							]})
						]}),
						el("div", {className: "translator-about-split", "aria-hidden": true}),
						el("div", {className: "translator-about-actions", children: [
							createPortalLink({label: compactText("GitHub 仓库", "GitHub repository", "Репозиторий GitHub"), icon: el("svg", {viewBox: "0 0 24 24", "aria-hidden": true, children: el("path", {fill: "currentColor", d: GITHUB_ICON_PATH})}), url: UPDATE_PROJECT_URL}),
							el("button", {type: "button", className: "translator-portal", disabled: updateState.loading, onClick: runUpdateCheck, children: [createIcon("refresh", 13), updateState.loading ? compactText("检查中…", "Checking…", "Проверка…") : compactText("检查更新", "Check for updates", "Проверить обновления")]}),
							createPortalLink({label: compactText("问题反馈", "Report issue", "Сообщить о проблеме"), icon: createIcon("feedback", 13), url: `${UPDATE_PROJECT_URL}/issues`}),
							updateState.result && updateState.result.releaseUrl && createPortalLink({label: compactText("查看发布页", "View release", "Открыть релиз"), icon: createIcon("open", 13), url: updateState.result.releaseUrl})
						].filter(Boolean)}),
						updateText && el("div", {className: `translator-update-status translator-update-status-${updateTone}`, role: "status", children: updateText})
					].filter(Boolean)}),
					createGroupHeader(compactText("运行状态", "Service status", "Состояние сервисов"), compactText("先看状态和速度摘要；技术计数只用于排查，复制报告会保留完整脱敏数据。", "Start with the status and speed summary; technical counters are for troubleshooting and remain in the redacted copy.", "Сначала смотрите состояние и скорость; технические счётчики нужны для диагностики и входят в обезличенный отчёт.")),
					el("div", {className: "translator-diagnostic-table", children: diagnosticsRows.map(([key, value, tone]) => el("div", {className: "translator-diagnostic-row", key, children: [
						el("span", {className: "translator-diagnostic-key", children: key}),
						el("span", {className: `translator-diagnostic-value translator-diagnostic-value-${tone}`, children: value})
					]}))}),
					createGroupHeader(plugin.getCustomText("ai_performance_title"), plugin.getCustomText("ai_performance_tip")),
					el("div", {className: "translator-diagnostic-table translator-ai-performance-table", children: aiPerformanceRows.filter(row => !row.technical).map(row => el("div", {className: "translator-diagnostic-row", key: row.key, children: [
						el("span", {className: "translator-diagnostic-key", children: row.key}),
						el("span", {className: `translator-diagnostic-value translator-diagnostic-value-${row.tone}`, children: row.value})
					]}))}),
					el("details", {className: "translator-diagnostic-technical", children: [
						el("summary", {children: compactText("排障详情", "Troubleshooting details", "Подробности диагностики")}),
						el("div", {className: "translator-diagnostic-table", children: [
							...environmentRows.map(([key, value, tone]) => ({key, value, tone})),
							...aiPerformanceRows.filter(row => row.technical && !row.reportOnly)
						].map(row => el("div", {className: "translator-diagnostic-row", key: row.key, children: [
							el("span", {className: "translator-diagnostic-key", children: [row.key, row.tip && createInfoTip(row.tip)].filter(Boolean)}),
							el("span", {className: `translator-diagnostic-value translator-diagnostic-value-${row.tone}`, children: row.value})
						]}))})
				]}),
					createButton({
						label: compactText("复制诊断信息", "Copy diagnostics", "Копировать диагностику"),
						icon: createIcon("copy", 13),
						className: "translator-copy-diagnostics",
						onClick: _ => {
							BDFDB.LibraryModules.WindowUtils.copy(diagnosticsText);
							BDFDB.NotificationUtils.toast(compactText("诊断信息已复制。", "Diagnostics copied.", "Диагностика скопирована."), {type: "success", position: "center"});
						}
					})
				]});
			};
			const createPerformanceExperimentSettings = () => {
				const performance = plugin.settings.performance || (plugin.settings.performance = {historicalConcurrency: "auto", historicalSafetyDownshift: true, liveConcurrency: "1", liveStreaming: true});
				const save = (key, value, apply) => {
					performance[key] = value;
					BDFDB.DataUtils.save(value, plugin, "performance", key);
					plugin.SettingsUpdated = true;
					try {apply();} catch (error) {}
					try {plugin.ensureProviderClient().resetLatency();} catch (error) {}
					refreshPanel();
				};
				const control = (id, {label, tip, field}) => el("div", {
					"data-performance-setting": id,
					className: "translator-performance-control",
					children: [createFieldLabel(label, tip), el("div", {className: "translator-performance-control-input", children: field})]
				});
				let historicalState = {};
				try {historicalState = plugin.getHistoricalBatchPerformanceSnapshot() || {};}
				catch (error) {historicalState = {};}
				const targetHistory = String(performance.historicalConcurrency || "auto");
				const learnedHistory = Math.max(1, Number(historicalState.learnedTier) || 2);
				const effectiveHistory = Math.max(1, Number(historicalState.effectiveCap) || historicalState.physical && Number(historicalState.physical.capacity) || 1);
				const cooldownRemainingMs = historicalState.cooldownRemainingMs == null ? null : Math.max(0, Number(historicalState.cooldownRemainingMs) || 0);
				const safetyDownshiftEnabled = performance.historicalSafetyDownshift !== false;
				const historyStateText = compactText(
					`当前生效 ${effectiveHistory} · ${cooldownRemainingMs > 0 ? "服务保护中" : "正常运行"} · 设置 ${targetHistory}`,
					`Active ${effectiveHistory} · ${cooldownRemainingMs > 0 ? "provider protection" : "normal"} · selected ${targetHistory}`,
					`Активно ${effectiveHistory} · ${cooldownRemainingMs > 0 ? "защита провайдера" : "норма"} · цель ${targetHistory}`
				);

				return [el("section", {className: "translator-performance-card", children: [
					el("div", {className: "translator-performance-control-grid", children: [
					control("history-concurrency", {
						label: compactText("历史任务并发", "Historical task concurrency", "Параллельность исторических задач"),
						tip: compactText("自动模式从 2 开始，在连续两个干净且饱和的任务后逐级升到 4；固定值便于对照测试。", "Auto starts at 2 and promotes to 4 after two clean saturated jobs per tier. Fixed values are for controlled comparisons.", "Авто начинает с 2 и повышает до 4 после двух чистых насыщенных задач на каждом уровне."),
						field: createSelectIn("100%", {
							value: ["auto", "1", "2", "3", "4"].includes(String(performance.historicalConcurrency)) ? String(performance.historicalConcurrency) : "auto",
							options: [
								{value: "auto", label: compactText("自动 2→3→4", "Auto 2→3→4", "Авто 2→3→4")},
								...[1, 2, 3, 4].map(value => ({value: String(value), label: compactText(`固定 ${value}`, `Fixed ${value}`, `Фиксировано ${value}`)}))
							],
							onChange: value => save("historicalConcurrency", String(value), () => plugin.setHistoricalBatchExperimentConcurrency(String(value), {resetTrace: true}))
						})
					}),
					control("live-concurrency", {
						label: compactText("实时任务并发", "Live task concurrency", "Параллельность live-задач"),
						tip: compactText("1 为当前稳定基线；2 允许两条独立实时请求重叠，用于观察连续消息和跨频道尾部延迟。", "1 is the stable baseline. 2 overlaps two independent live requests to measure burst and cross-channel tail latency.", "1 — стабильная база; 2 позволяет двум независимым live-запросам выполняться параллельно."),
						field: createSelectIn("100%", {
							value: String(performance.liveConcurrency) === "2" ? "2" : "1",
							options: ["1", "2"].map(value => ({value, label: compactText(`并发 ${value}`, `Concurrency ${value}`, `Параллельность ${value}`)})),
							onChange: value => save("liveConcurrency", String(value) === "2" ? "2" : "1", () => plugin.ensureLiveTranslationQueue().setLiveSlotCapacity(value))
						})
					}),
					control("live-streaming", {
						label: compactText("实时消息逐步显示（仅支持的接口）", "Progressive live display (supported interfaces only)", "Постепенный показ live (только поддерживаемые интерфейсы)"),
						tip: compactText("开启时单条实时 OpenAI Chat 使用 SSE；关闭时回到完整响应。修改会清除流式能力记忆并重置统计。", "On uses SSE for one live OpenAI Chat message; Off returns to full responses. Changing it clears stream capability memory and resets metrics.", "Вкл. использует SSE для одного live-сообщения OpenAI Chat; выкл. возвращает полный ответ."),
						field: createSelectIn("100%", {
							value: performance.liveStreaming === false ? "off" : "on",
							options: [{value: "on", label: compactText("开启", "On", "Вкл.")}, {value: "off", label: compactText("关闭", "Off", "Выкл.")}],
							onChange: value => save("liveStreaming", value !== "off", () => plugin.ensureProviderClient().resetOpenAiChatStreamCapabilities())
						})
					}),
					control("history-safety-downshift", {
						label: compactText("服务异常时临时降速", "Temporarily slow down on provider errors", "Временно снизить скорость при ошибке провайдера"),
						tip: compactText("异常时历史并发暂降到 1；冷却结束或健康探测成功后先恢复到最多 2，再以连续两个干净且饱和的任务逐级恢复。关闭只取消可选降速，服务健康限制、退避和实时消息优先仍然生效。", "Errors temporarily reduce historical concurrency to 1. After cooldown or a successful health probe, recovery starts at up to 2, then advances after two clean saturated jobs per tier. Turning this off removes only optional downshift; provider health limits, backoff and live priority still apply.", "Ошибки временно снижают параллельность до 1. После паузы или успешной проверки восстановление начинается максимум с 2 и растёт после двух чистых насыщенных задач на уровне. Ограничения здоровья API, паузы и приоритет live сохраняются."),
						field: el("div", {className: "translator-performance-switch-field", children: [
							el("span", {children: safetyDownshiftEnabled ? compactText("开启", "On", "Вкл.") : compactText("关闭", "Off", "Выкл.")}),
							createSwitch({value: safetyDownshiftEnabled, label: compactText("服务异常时临时降速", "Temporarily slow down on provider errors", "Временно снизить скорость при ошибке провайдера"), onChange: enabled => save("historicalSafetyDownshift", !!enabled, () => plugin.setHistoricalBatchExperimentConcurrency(String(performance.historicalConcurrency || "auto"), {resetTrace: true}))})
						]})
					})
					]}),
					el("div", {"data-performance-setting": "history-runtime", className: `translator-performance-runtime ${effectiveHistory < (targetHistory === "auto" ? learnedHistory : Math.max(1, Number(targetHistory) || 1)) ? "translator-performance-runtime-limited" : ""}`, children: [
						el("div", {className: "translator-performance-runtime-copy", children: [
							el("div", {className: "translator-performance-runtime-label", children: compactText("当前历史并发", "Current historical concurrency", "Текущая параллельность истории")}),
							el("div", {className: "translator-performance-runtime-value", children: historyStateText})
						]}),
						el("span", {className: "translator-performance-runtime-cap", children: String(effectiveHistory)})
					]}),

				]})];
			};
			const createCacheSettings = () => {
				const capacity = normalizeTranslationCacheCapacity(plugin.settings.general.translationCacheLimit);
				const cacheStore = plugin.ensureTranslationCacheStore();
				const targetHistory = String(plugin.settings.performance?.historicalConcurrency || "auto");
				const clearTranslationCache = async () => {
					try {if (plugin.translationPipelineInstance) plugin.translationPipelineInstance.disableWholeMarkerSingleCanary();} catch (error) {}
					let cleared = 0;
					try {plugin.clearAutoTranslationQueue();} catch (error) {}
					try {plugin.clearHistoricalTranslationFailures();} catch (error) {}
					try {await Promise.resolve(plugin.restoreAllReceivedDisplay({refresh: true}));} catch (error) {}
					try {plugin.clearDisplayedTranslations();} catch (error) {}
					try {
						const cacheStore = plugin.ensureTranslationCacheStore();
						cleared = cacheStore.clearAll();
						cacheStore.flushPendingSave();
					}
					catch (error) {}
					try {plugin.setHistoricalBatchExperimentConcurrency(targetHistory, {resetTrace: true});} catch (error) {}
					try {plugin.ensureProviderClient().resetLatency();} catch (error) {}
					BDFDB.NotificationUtils.toast(compactText(`已清除 ${cleared} 条翻译缓存。`, `Cleared ${cleared} translation-cache entries.`, `Удалено записей кэша перевода: ${cleared}.`), {type: "success", position: "center"});
					refreshPanel();
				};
				const saveCapacity = event => {
					const input = event.currentTarget;
					const value = parseTranslationCacheCapacity(input.value);
					if (value == null) {
						input.value = normalizeTranslationCacheCapacity(plugin.settings.general.translationCacheLimit);
						BDFDB.NotificationUtils.toast(compactText("请输入 100～10,000 之间的整数。", "Enter a whole number from 100 to 10,000.", "Введите целое число от 100 до 10 000."), {type: "danger", position: "center"});
						return;
					}
					if (value === normalizeTranslationCacheCapacity(plugin.settings.general.translationCacheLimit)) return;
					BDFDB.DataUtils.save(value, plugin, "general", "translationCacheLimit");
					plugin.settings.general.translationCacheLimit = value;
					// Applied in place: SettingsUpdated would reset active translation work on close.
					cacheStore.applyCapacityLimit();
					cacheStore.flushPendingSave();
					refreshPanel();
				};
				return el("section", {className: "translator-cache-card", children: [
					el("div", {className: "translator-cache-heading", children: [
						el("span", {className: "translator-cache-title", children: [compactText("翻译缓存", "Translation cache", "Кэш перевода"), createInfoTip(compactText("默认 500 条；10,000 仅为可设置上限。可输入 100～10,000 的整数，离开输入框后保存。调小容量时淘汰最旧记录，已淘汰的记录不会恢复。清除缓存会停止当前补翻并恢复原文；再次翻译可能产生服务费用。", "Default 500 entries; 10,000 is only the configurable maximum. Enter a whole number from 100 to 10,000; saved when the field loses focus. Reducing capacity evicts the oldest entries; increasing it cannot recover them. Clearing stops current backfill and restores originals. Translating again may incur provider charges.", "По умолчанию 500 записей; 10 000 — только верхний предел. Введите целое число от 100 до 10 000; сохраняется при выходе из поля. Уменьшение удаляет старые записи без восстановления. Очистка останавливает перевод истории и возвращает оригиналы. Повторный перевод может быть платным."))]}),
						el("span", {className: "translator-cache-usage", children: compactText(`已用 ${cacheStore.getEntryCount()} / ${capacity} 条`, `${cacheStore.getEntryCount()} / ${capacity} entries used`, `Использовано ${cacheStore.getEntryCount()} / ${capacity}`)})
					]}),
					el("div", {className: "translator-cache-controls", children: [
						el("label", {className: "translator-cache-capacity", children: [
							el("span", {children: compactText("最多保留", "Keep up to", "Хранить до")}),
							el("input", {key: capacity, className: "translator-input", "data-cache-setting": "capacity", type: "number", min: MIN_TRANSLATION_CACHE_CAPACITY, max: MAX_TRANSLATION_CACHE_CAPACITY, step: 1, defaultValue: capacity, onBlur: saveCapacity, onKeyDown: event => {if (event.key === "Enter") {event.preventDefault(); event.currentTarget.blur();}}, "aria-label": compactText("翻译缓存容量（条）", "Translation cache capacity (entries)", "Ёмкость кэша перевода")}),
							el("span", {children: compactText("条", "entries", "записей")})
						]}),
						createButton({label: compactText("清除翻译缓存", "Clear translation cache", "Очистить кэш перевода"), title: compactText("取消当前补翻、恢复已显示原文，并清除翻译结果和跳过判定；后续重新翻译会再次请求服务商并可能计费。这不是提速开关。", "Cancel current backfill, restore displayed originals, and clear translations plus skip decisions. Later retranslation sends new provider requests and may be billed. This is not a speed setting.", "Отменить текущий перевод, вернуть оригиналы и очистить кэш. Повторный перевод отправляет новые запросы и может оплачиваться; это не настройка ускорения."), kind: "danger", className: "translator-btn-danger", performanceAction: "clear-translation-cache", onClick: clearTranslationCache})
					]})
				]});
			};
			/* ===== page composition ===== */
			const servicePage = [createProviderWorkspace()];
			const strategyPage = [
				createGroupHeader(compactText("收到的消息（别人发来的）", "Received messages (from others)", "Полученные сообщения")),
				createTranslationDirectionRow(messageTypes.RECEIVED),
				createReceivedSourceLanguageFilter(),
				createSplit(),
				createGroupHeader(compactText("发送的消息（你打出去的）", "Sent messages (what you type)", "Отправленные сообщения")),
				createTranslationDirectionRow(messageTypes.SENT),
				createSourceLanguageFilter(),
				createSplit(),
				...createAutoTranslateDecisionSettings()
			];
			const generalPage = [
				createGroupHeader(compactText("界面", "Interface", "Интерфейс")),
				createUiLanguageSelector(),
				createSplit(),
				...createOriginalDisplaySettings(),
				createSplit(),
				createGroupHeader(compactText("译文外观", "Translation appearance", "Внешний вид перевода")),
				...createTranslatedTextColorInput()
			];
			const advancedPage = [
				createGroupHeader(compactText("性能设置", "Performance settings", "Настройки производительности"), compactText("修改后立即生效并重置本次延迟统计；正常使用后到诊断页复制一次结果。", "Changes apply immediately and reset this run's latency metrics. Use normally, then copy diagnostics once.", "Изменения применяются сразу и сбрасывают метрики; после обычного использования скопируйте диагностику один раз.")),
				...createPerformanceExperimentSettings(),
				createCacheSettings(),
				createSplit(),
				createGroupHeader(compactText("保护规则（这些内容不会被翻译）", "Protection rules (kept untranslated)", "Правила защиты (не переводится)")),
				...createProtectedTermsForm(),
				createSplit(),
				...createWrapperPairsForm(),
				createSplit(),
				createGroupHeader(compactText("前缀（写消息时的快捷指令）", "Prefixes (composer shortcuts)", "Префиксы (быстрые команды)")),
				...createDisablePrefixForm(),
				...createTranslatePrefixForm()
			];
			const diagnosticsPage = [createDiagnosticsContent()];
			const tabEntries = [
				{id: "providers", label: compactText("服务商", "Providers", "Провайдеры"), page: servicePage},
				{id: "strategy", label: compactText("翻译策略", "Translation", "Перевод"), page: strategyPage},
				{id: "general", label: compactText("通用", "General", "Общие"), page: generalPage},
				{id: "advanced", label: compactText("高级", "Advanced", "Расширенные"), page: advancedPage},
				{id: "diagnostics", label: compactText("诊断", "Diagnostics", "Диагностика"), page: diagnosticsPage}
			];
			if (!tabEntries.some(entry => entry.id == plugin.settingsUiState.activeTab)) plugin.settingsUiState.activeTab = "providers";
			const activeTab = plugin.settingsUiState.activeTab;
			const selectTab = (nextId, restoreFocus = false) => {
				if (!tabEntries.some(entry => entry.id == nextId)) return;
				flushDeferredSettingsWrites(plugin);
				plugin.settingsUiState.activeTab = nextId;
				refreshPanel();
				if (restoreFocus && typeof document != "undefined") setTimeout(() => {
					const next = document.querySelector(`[data-translator-settings-tab="${nextId}"]`);
					if (next && typeof next.focus == "function") next.focus();
				}, 0);
			};
			const handleTabKeyDown = (event, index) => {
				let nextIndex = null;
				if (event.key == "ArrowRight") nextIndex = (index + 1) % tabEntries.length;
				else if (event.key == "ArrowLeft") nextIndex = (index + tabEntries.length - 1) % tabEntries.length;
				else if (event.key == "Home") nextIndex = 0;
				else if (event.key == "End") nextIndex = tabEntries.length - 1;
				if (nextIndex == null) return;
				event.preventDefault();
				selectTab(tabEntries[nextIndex].id, true);
			};
			const activeEntry = tabEntries.find(entry => entry.id == activeTab) || tabEntries[0];
			return el("div", {
				className: "translator-settings-panel-root translator-settings-ui",
				ref: bindSettingsPanelScrollHost,
				children: [
					el("div", {
						className: "translator-settings-tabbar",
						role: "tablist",
						"aria-label": compactText("翻译插件设置", "Translator settings", "Настройки переводчика"),
						children: tabEntries.map((entry, index) => el("button", {
							type: "button",
							id: `translator-settings-tab-${entry.id}`,
							role: "tab",
							"aria-selected": entry.id == activeTab,
							"aria-controls": `translator-settings-page-${entry.id}`,
							tabIndex: entry.id == activeTab ? 0 : -1,
							"data-translator-settings-tab": entry.id,
							className: cls("translator-settings-tab", entry.id == activeTab && "translator-settings-tab-active"),
							onClick: _ => selectTab(entry.id),
							onKeyDown: event => handleTabKeyDown(event, index),
							children: entry.label
						}))
					}),
					el("div", {
						className: "translator-settings-tabpage",
						id: `translator-settings-page-${activeEntry.id}`,
						role: "tabpanel",
						"aria-labelledby": `translator-settings-tab-${activeEntry.id}`,
						children: activeEntry.page.flat(10).filter(n => n)
					})
				]
			});
		}
	});
}

module.exports = {
	renderSettingsPanel,
	flushDeferredSettingsWrites,
	formatLatencyDuration,
	createModelValidationView,
	createCustomProviderStatusView,
	isBenchmarkSlower,
	createReasoningStatusView,
	shouldShowReasoningEffort,
	formatBenchmarkCompare,
	createBenchmarkResultView,
	createAiPerformanceRows,
	sanitizeWireObservationDiagnostics,
	createDiagnosticsCopyPayload,
	sanitizeCompactWireShadowDiagnostics,
	createAiLatencyDiagnosticsPayload,
	cancelW2SettingsBenchmark
};
