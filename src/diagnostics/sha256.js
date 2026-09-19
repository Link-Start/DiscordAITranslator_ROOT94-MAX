// Synchronous SHA-256 over the UTF-8 bytes of a string, in plain JavaScript.
//
// BetterDiscord 1.14.x hands plugins a whitelist `require` (request, https, original-fs, fs,
// path, events, electron, process, vm, module, buffer, crypto); any other name, including the
// "node:" prefixed forms, is resolved as a file inside the plugins folder and fails to load the
// plugin. Diagnostics digests therefore never touch a runtime crypto module: this file is the
// only hashing code the bundle carries, and it matches Node's
// crypto.createHash("sha256").update(text).digest("hex") byte for byte (tests/diagnostics/sha256.test.js).

const K = new Uint32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);
const HEX = "0123456789abcdef";

// UTF-8 encoding with the same lone-surrogate rule as Buffer.from(text, "utf8"): an unpaired
// surrogate becomes U+FFFD (EF BF BD).
function utf8Bytes(text) {
	const bytes = [];
	for (let index = 0; index < text.length; index++) {
		let code = text.charCodeAt(index);
		if (code >= 0xD800 && code <= 0xDBFF) {
			const next = index + 1 < text.length ? text.charCodeAt(index + 1) : 0;
			if (next >= 0xDC00 && next <= 0xDFFF) {code = 0x10000 + ((code - 0xD800) << 10) + (next - 0xDC00); index++;}
			else code = 0xFFFD;
		}
		else if (code >= 0xDC00 && code <= 0xDFFF) code = 0xFFFD;
		if (code < 0x80) bytes.push(code);
		else if (code < 0x800) bytes.push(0xC0 | (code >> 6), 0x80 | (code & 0x3F));
		else if (code < 0x10000) bytes.push(0xE0 | (code >> 12), 0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F));
		else bytes.push(0xF0 | (code >> 18), 0x80 | ((code >> 12) & 0x3F), 0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F));
	}
	return bytes;
}

function rotr(value, bits) {return (value >>> bits) | (value << (32 - bits));}

function sha256Bytes(bytes) {
	const bitLength = bytes.length * 8;
	const padded = bytes.slice();
	padded.push(0x80);
	while (padded.length % 64 !== 56) padded.push(0);
	// 64-bit big-endian length; inputs here are far below 2^32 bits, so the high word is 0.
	padded.push(0, 0, 0, 0, (bitLength >>> 24) & 0xFF, (bitLength >>> 16) & 0xFF, (bitLength >>> 8) & 0xFF, bitLength & 0xFF);
	const hash = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
	const words = new Uint32Array(64);
	for (let offset = 0; offset < padded.length; offset += 64) {
		for (let index = 0; index < 16; index++) {
			const at = offset + index * 4;
			words[index] = (padded[at] << 24) | (padded[at + 1] << 16) | (padded[at + 2] << 8) | padded[at + 3];
		}
		for (let index = 16; index < 64; index++) {
			const w15 = words[index - 15], w2 = words[index - 2];
			const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
			const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
			words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
		}
		let a = hash[0], b = hash[1], c = hash[2], d = hash[3], e = hash[4], f = hash[5], g = hash[6], h = hash[7];
		for (let index = 0; index < 64; index++) {
			const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
			const ch = (e & f) ^ (~e & g);
			const temp1 = (h + S1 + ch + K[index] + words[index]) >>> 0;
			const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
			const maj = (a & b) ^ (a & c) ^ (b & c);
			const temp2 = (S0 + maj) >>> 0;
			h = g; g = f; f = e; e = (d + temp1) >>> 0; d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
		}
		hash[0] = (hash[0] + a) >>> 0; hash[1] = (hash[1] + b) >>> 0; hash[2] = (hash[2] + c) >>> 0; hash[3] = (hash[3] + d) >>> 0;
		hash[4] = (hash[4] + e) >>> 0; hash[5] = (hash[5] + f) >>> 0; hash[6] = (hash[6] + g) >>> 0; hash[7] = (hash[7] + h) >>> 0;
	}
	let hex = "";
	for (let index = 0; index < 8; index++) for (let shift = 28; shift >= 0; shift -= 4) hex += HEX[(hash[index] >>> shift) & 0xF];
	return hex;
}

// Lowercase hex digest of the UTF-8 encoding of String(value); null and undefined hash as "".
function sha256Hex(value) {
	return sha256Bytes(utf8Bytes(String(value == null ? "" : value)));
}

module.exports = {sha256Hex, utf8Bytes};
