const test = require("node:test");
const assert = require("node:assert/strict");
const {createOpenAiChatSseParser} = require("../../src/providers/openai-chat-sse-parser");

function feedBySize(parser, text, size) {
	const bytes = new TextEncoder().encode(text);
	for (let offset = 0; offset < bytes.length; offset += size) parser.push(bytes.slice(offset, offset + size));
}

function contentFrame(text, finishReason = null) {
	return `data: ${JSON.stringify({choices: [{delta: {content: text}, finish_reason: finishReason}]})}\r\n\r\n`;
}

test("OpenAI Chat SSE parses CJK and emoji across every small byte chunk", () => {
	const stream = [
		`: keepalive\r\n\r\n`,
		`data: ${JSON.stringify({choices: [{delta: {role: "assistant", reasoning_content: "hidden"}, finish_reason: null}]})}\r\n\r\n`,
		contentFrame("你"),
		contentFrame("好😊", "stop"),
		`data: ${JSON.stringify({usage: {completion_tokens: 3}, choices: []})}\r\n\r\n`,
		`data: [DONE]\r\n\r\n`
	].join("");
	for (const size of [1, 2, 3, 5, 7, 13]) {
		const events = [];
		const parser = createOpenAiChatSseParser({attemptId: `a-${size}`, onEvent: event => events.push(event)});
		feedBySize(parser, stream, size);
		parser.finish();
		assert.deepEqual(events.filter(event => event.type === "chunk").map(event => event.text), ["你", "好😊"]);
		const final = events.filter(event => event.type === "final");
		assert.equal(final.length, 1);
		assert.equal(final[0].text, "你好😊");
		assert.equal(final[0].finishReason, "stop");
		assert.equal(final[0].usage.completion_tokens, 3);
		assert.equal(events.some(event => JSON.stringify(event).includes("hidden")), false);
		assert.equal(parser.getSnapshot().bufferBytes, 0);
	}
});

test("multiline data LF frames and finish_reason EOF produce one final event", () => {
	const events = [];
	const parser = createOpenAiChatSseParser({attemptId: "multi", onEvent: event => events.push(event)});
	parser.push(`data: {"choices":\ndata: [{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n`);
	parser.finish();
	assert.deepEqual(events.map(event => event.type), ["chunk", "final"]);
	assert.equal(events[1].text, "ok");
	assert.equal(events[1].finishReason, "stop");
});

test("malformed truncated oversized and aborted streams terminate exactly once", () => {
	const cases = [
		{expected: "parse", run(parser) {parser.push("data: {bad}\n\n");}},
		{expected: "truncated", run(parser) {parser.push(contentFrame("partial")); parser.finish();}},
		{expected: "frame_limit", options: {maxFrameBytes: 8}, run(parser) {parser.push(contentFrame("too long"));}},
		{expected: "buffer_limit", options: {maxBufferBytes: 8}, run(parser) {parser.push("data: unfinished payload");}},
		{expected: "abort", run(parser) {parser.push(contentFrame("partial")); parser.abort();}}
	];
	for (const entry of cases) {
		const events = [];
		const parser = createOpenAiChatSseParser(Object.assign({attemptId: entry.expected, onEvent: event => events.push(event)}, entry.options));
		entry.run(parser);
		parser.finish();
		parser.abort();
		const terminal = events.filter(event => event.type === "error" || event.type === "final");
		assert.equal(terminal.length, 1, entry.expected);
		assert.equal(terminal[0].errorKind, entry.expected);
	}
});

test("two interleaved parsers never mix attempt buffers", () => {
	const events = [];
	const left = createOpenAiChatSseParser({attemptId: "left", onEvent: event => events.push(event)});
	const right = createOpenAiChatSseParser({attemptId: "right", onEvent: event => events.push(event)});
	const leftBytes = new TextEncoder().encode(`${contentFrame("L", "stop")}data: [DONE]\n\n`);
	const rightBytes = new TextEncoder().encode(`${contentFrame("R", "stop")}data: [DONE]\n\n`);
	for (let index = 0; index < Math.max(leftBytes.length, rightBytes.length); index++) {
		if (index < rightBytes.length) right.push(rightBytes.slice(index, index + 1));
		if (index < leftBytes.length) left.push(leftBytes.slice(index, index + 1));
	}
	assert.equal(events.find(event => event.type === "final" && event.attemptId === "left").text, "L");
	assert.equal(events.find(event => event.type === "final" && event.attemptId === "right").text, "R");
});
