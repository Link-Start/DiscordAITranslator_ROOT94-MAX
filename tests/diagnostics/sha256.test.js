const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const {sha256Hex, utf8Bytes} = require("../../src/diagnostics/sha256");
const {W2_ALL_FIXTURES, W2B_FIXTURE_REVISION, W2B_EXTRA_FIXTURES, W2B_FIXTURE_MANIFEST_SHA256} = require("../../src/diagnostics/w2-wire-benchmark-fixtures");
const {original14Markdown} = require("../fixtures/s8b-m0a-mixed-language-fixtures");

const reference = value => crypto.createHash("sha256").update(String(value), "utf8").digest("hex");

function seededRandom(seed) {
	let state = seed >>> 0;
	return () => {state = (state * 1664525 + 1013904223) >>> 0; return state / 4294967296;};
}

// Emoji (astral, surrogate pairs), CJK, combining marks, control characters, both line endings,
// ASCII and a few lone surrogates, which Buffer.from and this encoder both turn into U+FFFD.
const ALPHABET = ["a", "Z", "0", " ", "\n", "\r\n", "\t", "é", "ß", "中", "文", "日本語", "한글", "Ω", "😀", "🧪", "👩‍👩‍👧", "🇨🇳", "\u200D", "\u0301", "⟦", "⟧", "⟪", "⟫", "…", "\u00A0", "\u2009", "\uFEFF", "\uD83D", "\uDE00", "\uDBFF"];

function randomText(random) {
	const length = Math.floor(random() * 400);
	let text = "";
	for (let index = 0; index < length; index++) text += ALPHABET[Math.floor(random() * ALPHABET.length)];
	return text;
}

test("W3-fix pure SHA-256 matches Node crypto on every W2 fixture, the empty string and known vectors", () => {
	assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
	assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
	assert.equal(sha256Hex("The quick brown fox jumps over the lazy dog"), "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592");
	assert.equal(sha256Hex(null), reference(""));
	assert.equal(sha256Hex(undefined), reference(""));
	assert.equal(sha256Hex(12345), reference("12345"));
	for (const fixture of W2_ALL_FIXTURES) assert.equal(sha256Hex(fixture.source), reference(fixture.source), fixture.id);
	assert.equal(sha256Hex(original14Markdown), reference(original14Markdown));
	// Block boundaries: 55/56/63/64/65 bytes and multi-block inputs.
	for (const length of [1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 4097]) {const text = "x".repeat(length); assert.equal(sha256Hex(text), reference(text), `length ${length}`);}
});

test("W3-fix pure SHA-256 matches Node crypto on 200 random emoji/CJK/newline strings", () => {
	const random = seededRandom(20260903);
	for (let index = 0; index < 200; index++) {
		const text = randomText(random);
		assert.deepEqual(Array.from(utf8Bytes(text)), Array.from(Buffer.from(text, "utf8")), `utf8 ${index}`);
		assert.equal(sha256Hex(text), reference(text), `digest ${index}`);
	}
});

test("W3-fix fixture manifest digest is unchanged by the pure SHA-256 swap", () => {
	const manifest = sha256Hex(JSON.stringify([W2B_FIXTURE_REVISION, ...W2B_EXTRA_FIXTURES.map(row => [row.id, row.sha256, row.targetLanguageId])])).toUpperCase();
	assert.equal(manifest, W2B_FIXTURE_MANIFEST_SHA256);
	assert.equal(manifest, "4B5B11EB68DDFF6BC95FB268F3792C8C763AD483EDBD5A677A84CBA9EE7CE941");
	for (const fixture of W2_ALL_FIXTURES) assert.equal(sha256Hex(fixture.source).toUpperCase(), fixture.sha256, fixture.id);
});
