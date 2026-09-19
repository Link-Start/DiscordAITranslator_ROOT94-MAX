const {createOpenAiChatSseParser} = require("./openai-chat-sse-parser");
function ignoreObserverPromise(value) {if (value && typeof value.then == "function") Promise.resolve(value).catch(() => {});}

function createOpenAiChatStreamRequest({
	transport,
	attemptOwner,
	createParser = createOpenAiChatSseParser,
	now = Date.now
} = {}) {
	if (!transport || typeof transport.openStream != "function") throw new TypeError("OpenAI Chat stream request requires transport");
	if (!attemptOwner) throw new TypeError("OpenAI Chat stream request requires attemptOwner");

	function result(fields) {return Object.freeze(Object.assign({}, fields));}
	function current(signal, isCurrent) {
		if (signal && signal.aborted) return false;
		if (typeof isCurrent != "function") return true;
		try {return !!isCurrent();}
		catch (error) {return false;}
	}
	function abortKind(signal) {return signal && String(signal.reason || "").toLowerCase() === "timeout" ? "timeout" : "abort";}

	async function request({
		url,
		requestOptions = {},
		payload = {},
		timeoutMs = 30000,
		logicalRequestId = null,
		role = "primary",
		signal = null,
		isCurrent = null,
		onDispatch = null
	} = {}) {
		const startedAt = now();
		const token = attemptOwner.begin({logicalRequestId, role, signal});
		const physicalSignal = attemptOwner.getSignal(token);
		const totalMs = () => Math.max(0, Number(now() - startedAt) || 0);
		if (!attemptOwner.owns(token) || !current(signal, isCurrent)) {
			attemptOwner.abort(token, "stale-before-stream");
			return result({mode: "error", errorKind: "abort", status: 0, hadText: false, ttftMs: null, streamChunkCount: 0, transportMs: totalMs()});
		}

		const streamPayload = Object.assign({}, payload || {}, {stream: true});
		const streamBody = JSON.stringify(streamPayload);
		if (typeof onDispatch == "function") try {ignoreObserverPromise(onDispatch(streamBody));} catch (error) {}
		let opened;
		try {
			opened = await transport.openStream({
				token,
				url,
				options: Object.assign({}, requestOptions || {}, {body: streamBody}),
				timeoutMs
			});
		}
		catch (error) {
			attemptOwner.abort(token, "stream-open-error");
			return result({mode: "error", errorKind: "network", status: 0, hadText: false, ttftMs: null, streamChunkCount: 0, transportMs: totalMs()});
		}
		if (!opened || !opened.ok) {
			const base = {
				status: Number(opened && opened.status) || 0,
				contentType: String(opened && opened.contentType || ""),
				body: String(opened && opened.body || ""),
				errorKind: String(opened && opened.errorKind || "network"),
				hadText: false,
				ttftMs: null,
				streamChunkCount: 0,
				transportMs: totalMs()
			};
			return result(Object.assign({mode: base.errorKind === "content_type" ? "response" : "error"}, base));
		}

		let terminal = null;
		let ttftMs = null;
		const parser = createParser({
			attemptId: token.id,
			onEvent(event) {
				if (!event || event.attemptId !== token.id) return;
				if (event.type === "chunk" && ttftMs == null && current(signal, isCurrent)) ttftMs = Math.max(0, Number(now() - startedAt) || 0);
				if (event.type === "final" || event.type === "error") terminal = event;
			}
		});
		attemptOwner.attachDecoder(token, parser);
		const reader = opened.reader;
		try {
			while (!terminal) {
				if (!attemptOwner.owns(token) || !current(signal, isCurrent)) {
					parser.abort();
					if (attemptOwner.owns(token)) opened.abort("stale-stream");
					break;
				}
				const part = await reader.read();
				if (!attemptOwner.owns(token) || !current(signal, isCurrent)) {
					parser.abort();
					if (attemptOwner.owns(token)) opened.abort("stale-stream");
					break;
				}
				if (part && part.done) parser.finish();
				else parser.push(part && part.value);
				const snapshot = parser.getSnapshot();
				attemptOwner.setBufferBytes(token, snapshot.bufferBytes);
			}
		}
		catch (error) {
			if (!terminal) {
				if (physicalSignal && physicalSignal.aborted || !attemptOwner.owns(token)) parser.abort();
				else {
					terminal = {type: "error", errorKind: "network", hadText: parser.getSnapshot().hadText};
					opened.abort("stream-read-error");
				}
			}
		}

		if (!terminal) terminal = parser.abort();
		const snapshot = parser.getSnapshot();
		if (terminal.type === "final") {
			try {if (reader && typeof reader.cancel == "function") await reader.cancel("stream-complete");}
			catch (error) {}
			opened.finish();
			return result({
				mode: "stream",
				status: Number(opened.status) || 200,
				text: String(terminal.text || ""),
				usage: terminal.usage || null,
				finishReason: terminal.finishReason || null,
				ttftMs,
				streamChunkCount: snapshot.translationChunkCount,
				transportMs: totalMs()
			});
		}
		if (attemptOwner.owns(token)) opened.abort("stream-terminal-error");
		const physicalReason = physicalSignal && String(physicalSignal.reason || "") || "";
		const internallyClosed = physicalReason === "stream-terminal-error" || physicalReason === "stream-read-error";
		const errorKind = physicalSignal && physicalSignal.aborted && !internallyClosed ? abortKind(physicalSignal) : String(terminal.errorKind || "network");
		return result({
			mode: "error",
			status: Number(opened.status) || 0,
			errorKind,
			hadText: !!terminal.hadText || snapshot.hadText,
			ttftMs,
			streamChunkCount: snapshot.translationChunkCount,
			transportMs: totalMs()
		});
	}

	return Object.freeze({request});
}

module.exports = {createOpenAiChatStreamRequest};
