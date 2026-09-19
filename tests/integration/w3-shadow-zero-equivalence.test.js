const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {capture, summarize} = require("../../scripts/verify-w3-zero-equivalence");

const BUNDLE = process.env.DTA_PLUGIN_PATH ? path.resolve(process.env.DTA_PLUGIN_PATH) : path.resolve(__dirname, "../../DiscordAITranslator.plugin.js");

// Physical request bodies captured by scripts/verify-w3-zero-equivalence.js on the
// typed-compact-v1 bundle (short segment/message labels, no client bookkeeping fields;
// the W2c HEAD rows were 16386/1506/1053/... bytes). W3 must reproduce every row byte for
// byte with the shadow off and with the shadow on.
// Re-captured 2026-09-14: the user translation preferences block now rides in every typed
// system prompt, so every row grew by that block (English default preferences in the harness).
// The typed-batch-v2 format fix changes only the history-batch row: one messages output
// schema and explicit message-local segment rules. All single-request rows stay identical.
// JSON mode adds only response_format:{type:"json_object"} (41 bytes) to that batch;
// the shadow still leaves every request byte unchanged.
const W2C_HEAD_ROWS = Object.freeze([
	"manual-original14|11379|FB2F3C84D1AC63263F8161BDCD2CE86FAD276E0E3A3BA0B10191AF417648EF34",
	"auto-original14|11379|FB2F3C84D1AC63263F8161BDCD2CE86FAD276E0E3A3BA0B10191AF417648EF34",
	"embed|1743|2908C821A69C89056D08F256CA74D64D7CD3E70B242FF1E310C543460362A28C",
	"reply|1553|59CD8D7FBCB622752367884B62F8A9A14614EB9E9B71847B1A5D84B1BB7250D9",
	"w2-f01-exact-academic|11379|FB2F3C84D1AC63263F8161BDCD2CE86FAD276E0E3A3BA0B10191AF417648EF34",
	"w2-f02-short-english|1560|73AF93BDE4CEF8EE4589A6193BBBAC26DADAD0641D19098D04ACEA73E22360E4",
	"w2-f03-long-english|4273|932F9DD3FB5220C1B64970EAFC30113E81F67D5B5704A197D70B99223D493DAC",
	"w2-f04-target-body-title|1538|0AB08E952691FE2185C323FFA36BE45C44B83BA05569970072E412131C3DA362",
	"w2-f05-protection-composite|1737|51B287A8214ACB5DDA9644B2B71B53A4039249E935E7BDE74BF756B5C49AA1A5",
	"w2-f06-markdown-structure|2401|7DBE04D42A6B094EC45B9EDABBA9F4B96024A5F774B26533A9DA6D12FD722719",
	"w2-f07-academic-technical|1751|6DA7116E8D38C07802A0EDABEA6DD5BBFBE96AC6E63724DCEFC818F70FDD3C7D",
	"w2-f08-order-oracle|1763|96796517D9B7B50FF4D46BDD220799299D7BB7367996E2592607AB121A17425F",
	"w2-f09-unicode-lines|1768|48E57C70E03E736EC706BCD279B5C369D0A8D9A77CB84F8B7398CEDC06738644",
	"w2-f10-markdown-protected-mixed|2373|793A93EE5AA97DD73CB00FE4D5A104A75CEB194DD198F540F50A6A40BF63216E",
	"w2-f11-inline-placeholders-tail|1634|831C92358A4F1E66F3BF8810E18B70D2DFDE9F0A11A435636280C12FDA3D3EA8",
	"w2-f12-trailing-punctuation-emoji|1633|34F882A6C48A22C3726AD0C9309E3BB39B906E0EFB9ACB05D539AA9EF9697784",
	"w2-f13-long-chinese-one-english|1550|82515D54598E03F22E7077C7360D1E7A12FC29F7AEA9E6E433686409417BF748",
	"history-batch|2266|21BE28010A5F4C9A84C814685EF49EFECE9BC21230F3EA2AF602346579F74E4E"
]);
const DISPATCHED_TYPED_REQUESTS = 20; // 17 single messages + 3 history items in one batch
// Explicit name decisions add a fixed prompt and permission to typed requests.
// Re-captured for this protocol; shadow on/off must still be byte-identical.
const CURRENT_ROWS = Object.freeze([
	"manual-original14|13803|9D964E237185CA523BBA7673467AFB135738874917638D79D4244F92D349140B",
	"auto-original14|13803|9D964E237185CA523BBA7673467AFB135738874917638D79D4244F92D349140B",
	"embed|2902|719D61F5FB78C4B6B3C0EA6CBEE5D469DBA5DF12550DDD4FAAEDB9E8ADCC2DF7",
	"reply|2597|515D018F1827866BCFD963EEB7F3E2A8C6AEA03A15949A5894069B3C26F4CC52",
	"w2-f01-exact-academic|13803|9D964E237185CA523BBA7673467AFB135738874917638D79D4244F92D349140B",
	"w2-f02-short-english|2604|60D33F4BF96F4B74504A52D4AEA9A3D11E68694A4CDBE7C38CCE05307ACFCEE9",
	"w2-f03-long-english|5317|8C56DF6345F8B3E4C7ECE874DD3B6665717D54D00C208F96FE03095621306012",
	"w2-f04-target-body-title|6220|99B5BAD4C78FEE1C026C74B6BD187CD6CA323A0287D5B311853657E60587338E",
	"w2-f05-protection-composite|2827|40847756501C0B57E8E566B755A08A7B814C2B7F2D4D50C466C524A1C96ACCF0",
	"w2-f06-markdown-structure|3763|6AE74A2FA7320DEE6A13E2C06D2731CA12C2B9DFF605889E4AE98703D6E1E2B7",
	"w2-f07-academic-technical|2818|FFCF71998F62F6215F56BF618CCB5D1D06D0EF4E15589A5E55561A8AC1062051",
	"w2-f08-order-oracle|2922|7AEC130E170C67681DB00ACF44208435E680F1239CBD207F526156C6AF1FB025",
	"w2-f09-unicode-lines|2858|6A8B0083BB861BCF4AC7008928F2AFD01F1E45504B41E5AB26E4B3C072C80F14",
	"w2-f10-markdown-protected-mixed|4405|60C34E670E8F548E8A8F792516216BB143811107FE246D3FAFF8E0495B250DEC",
	"w2-f11-inline-placeholders-tail|2701|427C08FD23A9F2F9F2E87738C40F94A3876789DB51836E0553A765A3B171B805",
	"w2-f12-trailing-punctuation-emoji|2723|10FE8883BC93A208B215135513FD37C11271F37832A8CA6FE3DD0ED9B07E7215",
	"w2-f13-long-chinese-one-english|4711|9004CB90B2A54EB9492590B5D78D92D53927415C80711DFB40DC4C9C5C141A97",
	"history-batch|3356|56EAD6FE44CE48A0A435E8708356EFBA8C368198A3F5C37F18311EC76790963B"
]);
let offCapture = null;
const captureOff = () => offCapture || (offCapture = capture(BUNDLE, {shadow: "off"}));

test("W3 flag off: every typed lane reproduces its current request bytes and records no shadow", async () => {
	const off = await captureOff();
	assert.deepEqual(summarize(off).rows, CURRENT_ROWS);
	assert.equal(off.results.every(([, ok]) => ok === true), true, JSON.stringify(off.results));
	assert.equal(off.netUsed, false, "the fixture never exposes BdApi.Net; every request goes through the captured transport");
	assert.equal(off.shadow.count, 0);
	assert.equal(off.shadow.batchCount, 0);
});

test("W3 flag on: request bytes, results and side effects are unchanged, one shadow per dispatched typed request, cleared on settings close and stop", async () => {
	const off = await captureOff();
	const on = await capture(BUNDLE, {shadow: "shadow", closeSettings: true});
	assert.deepEqual(summarize(on).rows, CURRENT_ROWS, "the shadow never changes a byte that leaves the plugin");
	assert.deepEqual(summarize(on).results, summarize(off).results);
	assert.deepEqual(on.sideEffects, off.sideEffects, "cache, skip and display writes are identical with the shadow on");
	assert.equal(on.wire.length, off.wire.length, "the shadow sends nothing");
	assert.equal(on.netUsed, false);
	const shadow = on.shadowSnapshot;
	assert.equal(shadow.schemaVersion, "w3-shadow-1");
	assert.equal(shadow.contractRevision, "whole-marker-v2.prompt-v3.validator-v2");
	assert.equal(shadow.count, DISPATCHED_TYPED_REQUESTS);
	assert.equal(shadow.okCount, DISPATCHED_TYPED_REQUESTS);
	assert.equal(shadow.identityMismatchCount, 0, "identity mismatch is a blocking finding");
	assert.equal(shadow.budgetFailCount, 0);
	assert.equal(shadow.compileFailedCount, 0);
	assert.equal(shadow.prohibitedCount, 0, "no typed structure leaks into any D wire");
	assert.equal(shadow.windowedCount, 2, "f04 and f13 are the two windowed fixtures");
	assert.ok(shadow.bodyRatioPermille.p50 > 0 && shadow.bodyRatioPermille.p50 < 1000, JSON.stringify(shadow.bodyRatioPermille));
	assert.equal(shadow.batches.count, 1);
	assert.equal(shadow.batches.latest.itemCount, 3);
	assert.equal(shadow.batches.latest.shadowedCount, 3);
	assert.equal(shadow.batches.latest.okCount, 3);
	assert.equal(shadow.batches.latest.typedBatchBytes > shadow.batches.latest.dBytesSum, true);
	assert.doesNotMatch(JSON.stringify(shadow), /Financial Aid|Application Title|Quoted line|译|https/, "the shadow window carries no text");
	assert.equal(on.afterSettingsClosed.count, 0, "settings close clears the shadow window");
	assert.equal(on.afterStop.count, 0, "plugin stop clears the shadow window");
});
