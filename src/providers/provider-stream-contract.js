const PROVIDER_STREAM_EVENT_TYPES = Object.freeze({CHUNK: "chunk", FINAL: "final", ERROR: "error"});
const PROVIDER_STREAM_ERROR_KINDS = Object.freeze(["abort", "timeout", "network", "http", "content_type", "parse", "truncated", "frame_limit", "buffer_limit", "provider"]);

function requireAttemptId(attemptId) {
	const value = String(attemptId == null ? "" : attemptId);
	if (!value) throw new TypeError("provider stream event requires attemptId");
	return value;
}

function finiteStatus(value) {
	const status = Number(value);
	return Number.isInteger(status) && status >= 100 && status <= 999 ? status : null;
}

function createProviderStreamChunk({attemptId, text} = {}) {
	const value = String(text == null ? "" : text);
	if (!value.trim()) throw new TypeError("provider stream chunk requires non-empty translation text");
	return Object.freeze({type: PROVIDER_STREAM_EVENT_TYPES.CHUNK, attemptId: requireAttemptId(attemptId), text: value});
}

function createProviderStreamFinal({attemptId, text = "", usage = null, finishReason = null, streamed = true} = {}) {
	const safeUsage = usage && typeof usage == "object" && !Array.isArray(usage) ? Object.freeze(Object.assign({}, usage)) : null;
	return Object.freeze({
		type: PROVIDER_STREAM_EVENT_TYPES.FINAL,
		attemptId: requireAttemptId(attemptId),
		text: String(text == null ? "" : text),
		usage: safeUsage,
		finishReason: finishReason == null ? null : String(finishReason),
		streamed: !!streamed
	});
}

function createProviderStreamError({attemptId, errorKind, httpStatus = null, hadText = false, streamUnsupported = false} = {}) {
	const kind = String(errorKind == null ? "" : errorKind);
	if (!PROVIDER_STREAM_ERROR_KINDS.includes(kind)) throw new TypeError("unknown provider stream error kind");
	return Object.freeze({
		type: PROVIDER_STREAM_EVENT_TYPES.ERROR,
		attemptId: requireAttemptId(attemptId),
		errorKind: kind,
		httpStatus: finiteStatus(httpStatus),
		hadText: !!hadText,
		streamUnsupported: !!streamUnsupported
	});
}

function isProviderStreamEvent(event) {
	return !!event && Object.isFrozen(event) && Object.values(PROVIDER_STREAM_EVENT_TYPES).includes(event.type) && typeof event.attemptId == "string" && !!event.attemptId;
}

module.exports = {
	PROVIDER_STREAM_EVENT_TYPES,
	PROVIDER_STREAM_ERROR_KINDS,
	createProviderStreamChunk,
	createProviderStreamFinal,
	createProviderStreamError,
	isProviderStreamEvent
};
