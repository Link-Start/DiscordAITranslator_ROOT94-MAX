function createAbortableProviderTransport({
	fetchFunction,
	attemptOwner,
	setTimeout = (callback, delay) => globalThis.setTimeout(callback, delay),
	now = Date.now
} = {}) {
	if (typeof fetchFunction != "function") throw new TypeError("abortable provider transport requires fetchFunction");
	if (!attemptOwner) throw new TypeError("abortable provider transport requires attemptOwner");

	function statusOf(response) {return Number(response && (response.statusCode || response.status)) || 0;}
	function contentTypeOf(response) {
		try {return String(response && response.headers && typeof response.headers.get == "function" ? response.headers.get("content-type") || "" : response && response.headers && response.headers["content-type"] || "").toLowerCase();}
		catch (error) {return "";}
	}
	function retryAfterMsOf(response) {
		let raw = "";
		try {raw = String(response && response.headers && typeof response.headers.get == "function" ? response.headers.get("retry-after") || "" : response && response.headers && response.headers["retry-after"] || "").trim();}
		catch (error) {raw = "";}
		if (!raw) return null;
		if (/^\d+(?:\.\d+)?$/.test(raw)) return Math.max(0, Math.ceil(Number(raw) * 1000));
		const date = Date.parse(raw);
		return Number.isFinite(date) ? Math.max(0, Math.ceil(date - Number(now()))) : null;
	}

	function armTimeout(token, timeoutMs, onTimeout) {
		const delay = Math.max(0, Math.floor(Number(timeoutMs)) || 0);
		if (!delay) return null;
		const timer = setTimeout(onTimeout, delay);
		attemptOwner.attachTimer(token, timer);
		return timer;
	}

	function requestOptions(token, options) {
		return Object.assign({}, options || {}, {signal: attemptOwner.getSignal(token), timeout: 0});
	}

	async function requestText({token, url, options = {}, timeoutMs = 30000} = {}) {
		if (!attemptOwner.owns(token)) return Object.freeze({ok: false, errorKind: "abort", status: 0, body: "", retryAfterMs: null});
		let timedOut = false;
		armTimeout(token, timeoutMs, () => {timedOut = true; attemptOwner.abort(token, "timeout");});
		try {
			const response = await fetchFunction(url, requestOptions(token, options));
			if (!attemptOwner.owns(token)) return Object.freeze({ok: false, errorKind: timedOut ? "timeout" : "abort", status: statusOf(response), body: "", retryAfterMs: retryAfterMsOf(response)});
			const body = response && typeof response.text == "function" ? await response.text() : "";
			if (!attemptOwner.owns(token)) return Object.freeze({ok: false, errorKind: timedOut ? "timeout" : "abort", status: statusOf(response), body: "", retryAfterMs: retryAfterMsOf(response)});
			attemptOwner.finish(token);
			return Object.freeze({ok: true, errorKind: null, status: statusOf(response), body: String(body == null ? "" : body), contentType: contentTypeOf(response), retryAfterMs: retryAfterMsOf(response)});
		}
		catch (error) {
			const signal = attemptOwner.getSignal(token);
			const aborted = timedOut || !attemptOwner.owns(token) || signal && signal.aborted;
			attemptOwner.finish(token);
			return Object.freeze({ok: false, errorKind: timedOut ? "timeout" : aborted ? "abort" : "network", status: 0, body: "", retryAfterMs: null});
		}
	}

	async function openStream({token, url, options = {}, timeoutMs = 30000} = {}) {
		if (!attemptOwner.owns(token)) return Object.freeze({ok: false, errorKind: "abort", status: 0});
		let timedOut = false;
		armTimeout(token, timeoutMs, () => {timedOut = true; attemptOwner.abort(token, "timeout");});
		try {
			const response = await fetchFunction(url, requestOptions(token, options));
			if (!attemptOwner.owns(token)) return Object.freeze({ok: false, errorKind: timedOut ? "timeout" : "abort", status: statusOf(response)});
			const contentType = contentTypeOf(response);
			if (!contentType.includes("text/event-stream") || !response.body || typeof response.body.getReader != "function") {
				let body = "";
				try {body = response && typeof response.text == "function" ? await response.text() : "";}
				catch (error) {body = "";}
				if (!attemptOwner.owns(token)) return Object.freeze({ok: false, errorKind: timedOut ? "timeout" : "abort", status: statusOf(response), contentType, body: ""});
				attemptOwner.finish(token);
				return Object.freeze({ok: false, errorKind: "content_type", status: statusOf(response), contentType, body: String(body == null ? "" : body)});
			}
			const reader = response.body.getReader();
			attemptOwner.attachReader(token, reader);
			return Object.freeze({
				ok: true,
				errorKind: null,
				status: statusOf(response),
				contentType,
				reader,
				finish: () => attemptOwner.finish(token),
				abort: reason => attemptOwner.abort(token, reason || "stream-abort")
			});
		}
		catch (error) {
			const signal = attemptOwner.getSignal(token);
			const aborted = timedOut || !attemptOwner.owns(token) || signal && signal.aborted;
			attemptOwner.finish(token);
			return Object.freeze({ok: false, errorKind: timedOut ? "timeout" : aborted ? "abort" : "network", status: 0});
		}
	}

	return Object.freeze({requestText, openStream});
}

module.exports = {createAbortableProviderTransport};
