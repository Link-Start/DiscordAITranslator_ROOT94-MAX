const {
	createProviderStreamChunk,
	createProviderStreamFinal,
	createProviderStreamError
} = require("./provider-stream-contract");

const OPENAI_SSE_MAX_FRAME_BYTES = 256 * 1024;
const OPENAI_SSE_MAX_BUFFER_BYTES = 1024 * 1024;

function createOpenAiChatSseParser({
	attemptId,
	onEvent = () => {},
	maxFrameBytes = OPENAI_SSE_MAX_FRAME_BYTES,
	maxBufferBytes = OPENAI_SSE_MAX_BUFFER_BYTES,
	decoder = new TextDecoder("utf-8", {fatal: false}),
	encoder = new TextEncoder()
} = {}) {
	let buffer = "";
	let text = "";
	let usage = null;
	let finishReason = null;
	let sawFinishReason = false;
	let sawDone = false;
	let terminalEvent = null;
	let sseEventCount = 0;
	let translationChunkCount = 0;

	function emit(event) {
		try {onEvent(event);}
		catch (error) {}
		return event;
	}

	function fail(errorKind) {
		if (terminalEvent) return terminalEvent;
		terminalEvent = emit(createProviderStreamError({attemptId, errorKind, hadText: !!text}));
		buffer = "";
		return terminalEvent;
	}

	function finishFinal() {
		if (terminalEvent) return terminalEvent;
		terminalEvent = emit(createProviderStreamFinal({attemptId, text, usage, finishReason, streamed: true}));
		buffer = "";
		return terminalEvent;
	}

	function frameBoundary(value) {
		const candidates = [
			{index: value.indexOf("\r\n\r\n"), length: 4},
			{index: value.indexOf("\n\n"), length: 2},
			{index: value.indexOf("\r\r"), length: 2}
		].filter(candidate => candidate.index >= 0).sort((left, right) => left.index - right.index || right.length - left.length);
		return candidates[0] || null;
	}

	function processFrame(frame) {
		if (terminalEvent || !frame) return;
		if (encoder.encode(frame).byteLength > maxFrameBytes) return fail("frame_limit");
		const dataLines = [];
		for (const line of frame.split(/\r\n|\n|\r/)) {
			if (!line || line.startsWith(":")) continue;
			const separator = line.indexOf(":");
			const field = separator < 0 ? line : line.slice(0, separator);
			if (field !== "data") continue;
			let value = separator < 0 ? "" : line.slice(separator + 1);
			if (value.startsWith(" ")) value = value.slice(1);
			dataLines.push(value);
		}
		if (!dataLines.length) return;
		sseEventCount++;
		const data = dataLines.join("\n").trim();
		if (!data) return;
		if (data === "[DONE]") {sawDone = true; return finishFinal();}
		let payload;
		try {payload = JSON.parse(data);}
		catch (error) {return fail("parse");}
		if (payload && payload.error) return fail("provider");
		if (payload && payload.usage && typeof payload.usage == "object") usage = Object.assign({}, payload.usage);
		const choice = payload && Array.isArray(payload.choices) ? payload.choices[0] : null;
		if (!choice) return;
		if (choice.finish_reason != null) {finishReason = String(choice.finish_reason); sawFinishReason = true;}
		const content = choice.delta && typeof choice.delta.content == "string" ? choice.delta.content : "";
		if (!content || !content.trim()) return;
		text += content;
		translationChunkCount++;
		emit(createProviderStreamChunk({attemptId, text: content}));
	}

	function drainFrames() {
		while (!terminalEvent) {
			const boundary = frameBoundary(buffer);
			if (!boundary) break;
			const frame = buffer.slice(0, boundary.index);
			buffer = buffer.slice(boundary.index + boundary.length);
			processFrame(frame);
		}
		if (!terminalEvent && encoder.encode(buffer).byteLength > maxBufferBytes) fail("buffer_limit");
	}

	function push(input) {
		if (terminalEvent) return terminalEvent;
		try {
			const bytes = typeof input == "string" ? encoder.encode(input) : input instanceof Uint8Array ? input : new Uint8Array(input || []);
			buffer += decoder.decode(bytes, {stream: true});
		}
		catch (error) {return fail("parse");}
		drainFrames();
		return terminalEvent;
	}

	function finish() {
		if (terminalEvent) return terminalEvent;
		try {buffer += decoder.decode();}
		catch (error) {return fail("parse");}
		drainFrames();
		if (terminalEvent) return terminalEvent;
		if (buffer.trim()) {const tail = buffer; buffer = ""; processFrame(tail);}
		if (terminalEvent) return terminalEvent;
		if (sawDone || sawFinishReason) return finishFinal();
		return fail("truncated");
	}

	function abort() {return fail("abort");}

	function getSnapshot() {
		return Object.freeze({
			terminal: !!terminalEvent,
			terminalType: terminalEvent && terminalEvent.type || null,
			bufferBytes: encoder.encode(buffer).byteLength,
			sseEventCount,
			translationChunkCount,
			hadText: !!text,
			sawDone,
			sawFinishReason
		});
	}

	return Object.freeze({push, finish, abort, getSnapshot});
}

module.exports = {OPENAI_SSE_MAX_FRAME_BYTES, OPENAI_SSE_MAX_BUFFER_BYTES, createOpenAiChatSseParser};
