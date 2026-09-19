// P2-d captured provider answers (synthetic fixtures f10/f11, primary engine, 2026-09-02) that the
// typed-json parser rejected as malformed before the row recovery. Every sample is a JSON document
// whose segments array container is broken after the last complete row object (a stray bare
// word, or the closing bracket missing) while every row object itself is intact. Texts are
// verbatim; SHA-256 pins them.
"use strict";
const crypto = require("node:crypto");
function sha256(value) {return crypto.createHash("sha256").update(String(value), "utf8").digest("hex").toUpperCase();}
const P2_MALFORMED_SAMPLES = Object.freeze([
	{
		"id": "p2d-step1-trial-08-f11-stray-word-before-array-close",
		"fixtureId": "f11-inline-placeholders-tail",
		"capturedAt": "2026-09-02",
		"mechanism": "stray bare word between the last row object and the closing bracket of the segments array; the trailing targetLanguageId key is missing",
		"requestSegments": [
			{
				"id": "m3i-v2|received|body|0:45|2ef0ff7b",
				"text": "Please forward ⟦2⟧ to ⟦1⟧ and ping ⟦0⟧ today.",
				"contextIds": []
			},
			{
				"id": "m3i-v2|received|body|46:85|aed16244",
				"text": "Backup runs at ⟦3⟧, then ⟦4⟧ must pass.",
				"contextIds": []
			}
		],
		"response": "{\"segments\":[{\"id\":\"m3i-v2|received|body|0:45|2ef0ff7b\",\"translation\":\"请今天将⟦2⟧转发给⟦1⟧并 ping ⟦0⟧。\"},{\"id\":\"m3i-v2|received|body|46:85|aed16244\",\"translation\":\"备份在 ⟦3⟧ 运行，随后 ⟦4⟧ 必须通过。\"} stockholders]}",
		"responseSha256": "58325476027345F3C44C1975A2451B1D1C6F2A2A632B90E0390C59063CDB549F",
		"expectedRows": [
			"m3i-v2|received|body|0:45|2ef0ff7b",
			"m3i-v2|received|body|46:85|aed16244"
		]
	},
	{
		"id": "p2d-step1-trial-11-f11-stray-word-before-array-close",
		"fixtureId": "f11-inline-placeholders-tail",
		"capturedAt": "2026-09-02",
		"mechanism": "stray bare word between the last row object and the closing bracket of the segments array; the trailing targetLanguageId key is missing",
		"requestSegments": [
			{
				"id": "m3i-v2|received|body|0:45|2ef0ff7b",
				"text": "Please forward ⟦2⟧ to ⟦1⟧ and ping ⟦0⟧ today.",
				"contextIds": []
			},
			{
				"id": "m3i-v2|received|body|46:85|aed16244",
				"text": "Backup runs at ⟦3⟧, then ⟦4⟧ must pass.",
				"contextIds": []
			}
		],
		"response": "{\"segments\":[{\"id\":\"m3i-v2|received|body|0:45|2ef0ff7b\",\"translation\":\"请在今天将 ⟦2⟧ 转发给 ⟦1⟧，并 ping 一下 ⟦0⟧。\"},{\"id\":\"m3i-v2|received|body|46:85|aed16244\",\"translation\":\"备份会在 ⟦3⟧ 运行，随后 ⟦4⟧ 必须通过。\"} stockholders]}",
		"responseSha256": "1E4204ACE0188BEBC2743C08B54FF8DB8EBD0253FD65408EC84EE2CDDA9BB371",
		"expectedRows": [
			"m3i-v2|received|body|0:45|2ef0ff7b",
			"m3i-v2|received|body|46:85|aed16244"
		]
	},
	{
		"id": "p2d-rerun-trial-03-f10-array-close-missing",
		"fixtureId": "f10-markdown-protected-mixed",
		"capturedAt": "2026-09-02",
		"mechanism": "the closing bracket of the segments array is missing: the document ends with two braces right after the last row object",
		"requestSegments": [
			{
				"id": "m3i-v2|received|body|7:31|4bc4b979",
				"text": "Deployment Notes for ⟦6⟧",
				"contextIds": [
					"ctx|m3i-v2|received|body|heading|0:31"
				]
			},
			{
				"id": "m3i-v2|received|body|34:89|f62abf48",
				"text": "Ask ⟦7⟧ to run ⟦5⟧ before 18:00 and keep ⟦0⟧ unchanged.",
				"contextIds": []
			},
			{
				"id": "m3i-v2|received|body|95:124|7ffb0a62",
				"text": "Send the report to ⟦1⟧ today.",
				"contextIds": [
					"ctx|m3i-v2|received|body|list-item|90:124",
					"ctx|m3i-v2|received|body|heading|0:31"
				]
			},
			{
				"id": "m3i-v2|received|body|148:194|3d9d06bf",
				"text": "Connect to ⟦4⟧ first, then open the dashboard.",
				"contextIds": [
					"ctx|m3i-v2|received|body|list-item|143:194",
					"ctx|m3i-v2|received|body|heading|0:31"
				]
			},
			{
				"id": "m3i-v2|received|body|202:244|b51ade90",
				"text": "Read the FAQ first. Then submit the form. ",
				"contextIds": []
			},
			{
				"id": "m3i-v2|received|body|252:261|c93c9dc5",
				"text": "Important",
				"contextIds": []
			},
			{
				"id": "m3i-v2|received|body|263:302|439f75f8",
				"text": ": the ⟦C0⟧ script must stay unchanged.",
				"contextIds": []
			}
		],
		"response": "{\"segments\":[{\"id\":\"m3i-v2|received|body|7:31|4bc4b979\",\"translation\":\"⟦6⟧ 的部署说明\"},{\"id\":\"m3i-v2|received|body|34:89|f62abf48\",\"translation\":\"请 ⟦7⟧ 在 18:00 前运行 ⟦5⟧，并保持 ⟦0⟧ 不变。\"},{\"id\":\"m3i-v2|received|body|95:124|7ffb0a62\",\"translation\":\"今天将报告发送给 ⟦1⟧。\"},{\"id\":\"m3i-v2|received|body|148:194|3d9d06bf\",\"translation\":\"先连接到 ⟦4⟧，然后打开仪表板。\"},{\"id\":\"m3i-v2|received|body|202:244|b51ade90\",\"translation\":\"请先阅读常见问题解答（FAQ）。然后提交表单。\"},{\"id\":\"m3i-v2|received|body|252:261|c93c9dc5\",\"translation\":\"重要提示\"},{\"id\":\"m3i-v2|received|body|263:302|439f75f8\",\"translation\":\"：⟦C0⟧ 脚本必须保持不变。\"}}",
		"responseSha256": "81CF4C57852490DB6C4C44E5447704A929F594C79DF1A1C81F788387FB2E4EF2",
		"expectedRows": [
			"m3i-v2|received|body|7:31|4bc4b979",
			"m3i-v2|received|body|34:89|f62abf48",
			"m3i-v2|received|body|95:124|7ffb0a62",
			"m3i-v2|received|body|148:194|3d9d06bf",
			"m3i-v2|received|body|202:244|b51ade90",
			"m3i-v2|received|body|252:261|c93c9dc5",
			"m3i-v2|received|body|263:302|439f75f8"
		]
	},
	{
		"id": "p2d-rerun-trial-12-f11-different-stray-word",
		"fixtureId": "f11-inline-placeholders-tail",
		"capturedAt": "2026-09-02",
		"mechanism": "a different stray bare word (Corporation) between the last row object and the closing bracket",
		"requestSegments": [
			{
				"id": "m3i-v2|received|body|0:45|2ef0ff7b",
				"text": "Please forward ⟦2⟧ to ⟦1⟧ and ping ⟦0⟧ today.",
				"contextIds": []
			},
			{
				"id": "m3i-v2|received|body|46:85|aed16244",
				"text": "Backup runs at ⟦3⟧, then ⟦4⟧ must pass.",
				"contextIds": []
			}
		],
		"response": "{\"segments\":[{\"id\":\"m3i-v2|received|body|0:45|2ef0ff7b\",\"translation\":\"请今天将⟦2⟧转发给⟦1⟧，并 ping ⟦0⟧。\"},{\"id\":\"m3i-v2|received|body|46:85|aed16244\",\"translation\":\"备份在⟦3⟧运行，之后⟦4⟧必须通过。\"} Corporation]}",
		"responseSha256": "FAA011C04EC0A3B24A8B7909E1555F5047200C4F6BF2DCC5F56D87A6B00A1FFF",
		"expectedRows": [
			"m3i-v2|received|body|0:45|2ef0ff7b",
			"m3i-v2|received|body|46:85|aed16244"
		]
	}
].map(row => Object.freeze(row)));
module.exports = {P2_MALFORMED_SAMPLES, sha256};
