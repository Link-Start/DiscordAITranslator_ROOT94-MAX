// Synthetic P2 regression corpus. The four texts are byte-identical copies of the W2/W2b
// diagnostics fixtures f05, f10, f11 and f12 (see the W2b verification record for the
// primary-engine evidence); the SHA-256 values pin them so the corpus cannot drift.
const crypto = require("node:crypto");

function fixture(id, source, extra = {}) {
	return Object.freeze(Object.assign({id, targetLanguageId: "zh-CN", source: String(source)}, extra));
}

const P2_FIXTURE_HASHES = Object.freeze({
	"f05-protection-composite": "7CBCD2DD0C331D3C3D3564A9232AC7BACC7B60E2858C2FCB4C829B1660DFBE21",
	"f10-markdown-protected-mixed": "24B38770BF24D1C6B054EB24CABA9128A4A63AE338F925A4B1A153B334C6A594",
	"f11-inline-placeholders-tail": "FE20062D208567657DF28AC100DB504B80612758FB5DD54F9377408B51F0F039",
	"f12-trailing-punctuation-emoji": "D674D07F12DCE03192183D7A841FBE400F74AA5BE0620D64AA2C70E8EA699BD7"
});

const P2_FIXTURES = Object.freeze([
	fixture("f05-protection-composite", `Please ask Longma to review "KEEP EXACT" before Friday.
Email w2.user@example.invalid, visit https://example.invalid/a?b=1, connect to 192.0.2.10:8443, run /deploy and keep \`const flag = true;\` unchanged.
Notify <@123456789012345678> in <#234567890123456789> at <t:1700000000:F>.`, {
		protectedTerms: Object.freeze(["Longma"]),
		wrapperPairs: Object.freeze(["\"|\""]),
		preserveLiterals: Object.freeze(["Longma", "\"KEEP EXACT\"", "w2.user@example.invalid", "https://example.invalid/a?b=1", "192.0.2.10:8443", "/deploy", "`const flag = true;`", "<@123456789012345678>", "<#234567890123456789>", "<t:1700000000:F>"]),
		p1SegmentCount: 12,
		p2SegmentCount: 3
	}),
	fixture("f10-markdown-protected-mixed", `### 3. Deployment Notes for Longma
> Ask Longma to run /deploy before 18:00 and keep "KEEP EXACT" unchanged.
- A. Send the report to w2.user@example.invalid today.
- B. 请勿修改 https://example.invalid/docs 链接。
- C. Connect to 192.0.2.10:8443 first, then open the dashboard.
报名前请注意：Read the FAQ first. Then submit the form. 谢谢配合。
**Important**: the \`build.sh\` script must stay unchanged.`, {
		protectedTerms: Object.freeze(["Longma"]),
		wrapperPairs: Object.freeze(["\"|\""]),
		preserveLiterals: Object.freeze(["Longma", "/deploy", "\"KEEP EXACT\"", "w2.user@example.invalid", "https://example.invalid/docs", "192.0.2.10:8443", "`build.sh`", "请勿修改", "谢谢配合。"]),
		// Only runs that contain an inline protected node merge; the Chinese-flanked English
		// sentence pair and the bold word carry no protected node and stay P1 segments.
		p1SegmentCount: 13,
		p2SegmentCount: 7
	}),
	fixture("f11-inline-placeholders-tail", `Please forward https://example.invalid/report to w2.user@example.invalid and ping <@123456789012345678> today.
Backup runs at 192.0.2.10:8443, then /verify must pass.`, {
		preserveLiterals: Object.freeze(["https://example.invalid/report", "w2.user@example.invalid", "<@123456789012345678>", "192.0.2.10:8443", "/verify"]),
		p1SegmentCount: 7,
		p2SegmentCount: 2
	}),
	fixture("f12-trailing-punctuation-emoji", `Release is ready!!!\n\n\nThanks to everyone 🎉🎉\nSee you tomorrow...${" ".repeat(3)}\n`, {
		preserveLiterals: Object.freeze(["🎉🎉"]),
		p1SegmentCount: 3,
		p2SegmentCount: 3
	})
]);

function sha256(value) {return crypto.createHash("sha256").update(String(value)).digest("hex").toUpperCase();}

module.exports = {P2_FIXTURES, P2_FIXTURE_HASHES, sha256};
