const test = require("node:test");
const {assert, requireW1, planFor, validArray, validMarker} = require("../helpers/w1-compact-wire-test-kit");

function requestFor(text = "Hello\nWorld", responseMode = "array") {
	const w1 = requireW1();
	return w1.buildCompactOrderRequest(planFor(text), text, {responseMode});
}

test("W1 array parser accepts exactly one complete same-length string array", () => {
	const w1 = requireW1(), request = requestFor(), response = JSON.stringify(validArray(request));
	const parsed = w1.parseCompactOrderResponse(request, response, {likelyTarget: () => true, similarity: () => 0});
	assert.equal(parsed.ok, true);
	assert.equal(parsed.orderDetectable, false);
	assert.deepEqual(Object.keys(parsed.valid), request.mapping.map(row => row.stableId));
	for (const invalid of [
		response.slice(0, -1),
		`prefix ${response}`,
		`${response} suffix`,
		`\`\`\`json\n${response}\n\`\`\``,
		JSON.stringify(validArray(request).slice(1)),
		JSON.stringify(validArray(request).concat("extra")),
		JSON.stringify({items: validArray(request)})
	]) {
		const outcome = w1.parseCompactOrderResponse(request, invalid);
		assert.equal(outcome.ok, false, invalid.slice(0, 40));
		assert.equal(outcome.rootMalformed, true, invalid.slice(0, 40));
		assert.deepEqual(outcome.valid, {}, "array item-count/root errors cannot left-shift later items");
	}
});

test("W1 array parser localizes empty non-string wrong-language and too-similar items only when count is exact", () => {
	const w1 = requireW1(), request = requestFor("Hello\nWorld\nAgain"), rows = validArray(request);
	rows[0] = ""; rows[1] = 7; rows[2] = "源文相同";
	const parsed = w1.parseCompactOrderResponse(request, JSON.stringify(rows), {
		likelyTarget: text => text !== "源文相同",
		similarity: () => 0
	});
	assert.equal(parsed.ok, false);
	assert.equal(parsed.rootMalformed, false);
	assert.deepEqual(parsed.invalidIndexes, [0, 1, 2]);
	const similarityRows = validArray(request); similarityRows[1] = request.mapping[1].text;
	const similar = w1.parseCompactOrderResponse(request, JSON.stringify(similarityRows), {likelyTarget: () => true, similarity: (source, value) => source === value ? 1 : 0});
	assert.deepEqual(similar.invalidIndexes, [1]);
	assert.equal(similar.reason, "too-similar");
});

test("W1 marker parser owns a namespace, detects order, and rejects malformed marker sets", () => {
	const w1 = requireW1(), request = requestFor("One\nTwo\nThree", "marker"), clean = validMarker(request);
	const parsed = w1.parseCompactOrderResponse(request, clean, {likelyTarget: () => true, similarity: () => 0});
	assert.equal(parsed.ok, true);
	assert.equal(parsed.orderDetectable, true);
	assert.equal(parsed.reordered, false);
	const chunks = clean.split(/(?=⟦W\d+⟧)/);
	const reordered = [chunks[1], chunks[0], ...chunks.slice(2)].join("");
	const safe = w1.parseCompactOrderResponse(request, reordered, {likelyTarget: () => true, similarity: () => 0});
	assert.equal(safe.ok, true);
	assert.equal(safe.reordered, true);
	for (const invalid of [
		clean.replace("⟦W1⟧", ""),
		clean.replace("⟦W1⟧", "⟦W0⟧"),
		clean.replace("⟦W1⟧", "⟦W99⟧"),
		clean.replace("⟦W1⟧", "⟦ W1 ⟧"),
		clean.replace(new RegExp(`⟦W${request.mapping.length}⟧$`), "")
	]) assert.equal(w1.parseCompactOrderResponse(request, invalid).rootMalformed, true, invalid);
	assert.equal(clean.includes("⟦0⟧"), false, "P1 numeric protection namespace remains separate");
	const many = requestFor(Array.from({length: 12}, (_, index) => `Line${index}`).join("\n"), "marker"), manyParsed = w1.parseCompactOrderResponse(many, validMarker(many), {likelyTarget: () => true});
	assert.equal(manyParsed.ok, true);
	assert.ok(manyParsed.markerSequence.includes(10));
});

test("W1 response parser rejects response budget, deep/prototype data and preserves Unicode bytes", () => {
	const w1 = requireW1(), request = requestFor("Cafe\u0301 😀 RTL مرحبا"), rows = validArray(request);
	for (let index = 0; index < rows.length; index++) rows[index] = index === 0 ? "咖啡e\u0301😀" : `目标译文${index} مرحبا`;
	assert.equal(w1.parseCompactOrderResponse(request, JSON.stringify(rows), {likelyTarget: () => true}).ok, true);
	assert.equal(w1.parseCompactOrderResponse(request, "[\"" + "x".repeat(2_000_000) + "\"]").reason, "response-budget");
	assert.equal(w1.parseCompactOrderResponse(request, ["x".repeat(2_000_000)]).reason, "response-budget");
	assert.equal(w1.parseCompactOrderResponse(request, '[{"__proto__":{"polluted":true}}]').ok, false);
});

test("W1 B rejects every unexpected local marker injected by a model", () => {
	const w1 = requireW1();
	for (const mode of ["array", "marker"]) {
		const request = requestFor("Hello", mode), injected = "你好 ⟦999⟧ ⟦C8⟧";
		const response = mode === "array" ? JSON.stringify([injected]) : `⟦W0⟧${injected}⟦W1⟧`;
		const parsed = w1.parseCompactOrderResponse(request, response, {likelyTarget: () => true});
		assert.equal(parsed.ok, false, mode);
		assert.equal(parsed.reason, "placeholder-mismatch", mode);
	}
});
