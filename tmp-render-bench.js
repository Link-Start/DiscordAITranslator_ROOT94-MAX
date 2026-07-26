// Micro-benchmark for render-path hot functions. Run: node tmp-render-bench.js
const {createPluginInstance} = require("./tests/helpers/createPluginInstance");

const plugin = createPluginInstance({
	settings: {
		exceptions: {
			protectedTerms: ["BUG team", "ChatGPT Plus", "DeepSeek", "Discord Nitro", "BetterDiscord"],
			wrapperPairs: ['"|"', "“|”", "`|`"]
		},
		engines: {translator: "deepseek", backup: "googleapi"},
		filters: {
			autoTranslateDecisionMode: "ai",
			useLocalLanguagePrecheck: true,
			receivedAutoTranslateScope: "loaded_messages"
		},
		choices: {
			received: {input: "auto", output: "zh-CN"},
			sent: {input: "auto", output: "en"}
		}
	},
	defaults: {
		choices: {
			received: {value: {input: "auto", output: "zh-CN"}},
			sent: {value: {input: "auto", output: "en"}}
		}
	},
	isReceivedAutoTranslationEnabled: () => true
});

const englishContent = "Hey everyone, the new update just dropped and the patch notes mention a bunch of fixes for the raid encounter, including the enrage timer bug we hit last week. Anyone want to group up tonight around 9pm EST to test it?";
const chineseContent = "大家好，新版本刚刚更新了，补丁说明里提到了副本的一堆修复，包括我们上周遇到的狂暴计时器问题。今晚九点有人想一起组队测试吗？";

const englishMessage = {
	id: "1200000000000000001",
	channel_id: "channel-test",
	content: englishContent,
	embeds: [{
		id: "embed-1",
		rawTitle: "Patch notes 1.2.3",
		rawDescription: "Fixed enrage timer desync. Adjusted loot tables. Numerous quality of life improvements for controller users.",
		fields: [{rawName: "Fixes", rawValue: "Enrage timer, loot tables"}]
	}]
};
const chineseMessage = {
	id: "1200000000000000002",
	channel_id: "channel-test",
	content: chineseContent,
	embeds: []
};

function bench(label, iterations, fn) {
	// warmup
	for (let i = 0; i < Math.min(200, iterations); i++) fn();
	const start = process.hrtime.bigint();
	for (let i = 0; i < iterations; i++) fn();
	const ns = Number(process.hrtime.bigint() - start);
	const usPerOp = ns / iterations / 1000;
	console.log(`${label}: ${usPerOp.toFixed(1)} us/op  (${iterations} iters, total ${(ns / 1e6).toFixed(1)} ms)`);
	return usPerOp;
}

console.log("node", process.version);

const sig = bench("createReceivedTranslationSignature (en msg + 1 embed)", 5000, () => {
	plugin.createReceivedTranslationSignature(englishMessage, "channel-test");
});
const sigLen = plugin.createReceivedTranslationSignature(englishMessage, "channel-test").length;
console.log("  signature string length:", sigLen);

const cfg = bench("getReceivedTranslationConfigurationData only", 5000, () => {
	plugin.getReceivedTranslationConfigurationData("channel-test");
});

const extract = bench("extractOriginalContentData (en msg + 1 embed)", 10000, () => {
	plugin.extractOriginalContentData(englishMessage);
});

const shouldAuto = bench("shouldAutoTranslateReceivedMessage (zh msg, target zh-CN => skip)", 3000, () => {
	plugin.shouldAutoTranslateReceivedMessage(chineseMessage, {id: "channel-test"});
});

const translation = {
	channelId: "channel-test",
	auto: true,
	content: chineseContent,
	translatedContent: chineseContent,
	originalContent: englishContent,
	input: {id: "en"},
	output: {id: "zh-CN"},
	signature: "sig"
};
const similar = bench("isTranslationResultTooSimilar (200-char pair)", 5000, () => {
	plugin.isTranslationResultTooSimilar(translation);
});

const simScore = bench("getTextSimilarityScore (200-char pair)", 5000, () => {
	plugin.getTextSimilarityScore(englishContent, chineseContent);
});

const refresh = bench("refreshTranslationDisplay", 10000, () => {
	plugin.refreshTranslationDisplay(Object.assign({}, translation));
});

const getCached = bench("getCachedReceivedTranslation (cache miss, no entry)", 10000, () => {
	plugin.getCachedReceivedTranslation(englishMessage, "channel-test");
});

console.log("\n--- per-render estimate, 50-message channel ---");
const perMsgCheck = sig + extract; // createCheckMessageContext floor
console.log(`createCheckMessageContext floor per msg (sig + extract): ${perMsgCheck.toFixed(1)} us`);
console.log(`x50 messages per Messages render: ${(perMsgCheck * 50 / 1000).toFixed(2)} ms`);
console.log(`translated msg extra (2x getActiveMessageTranslation ~= 2x(refresh + similar)): ${(2 * (refresh + similar)).toFixed(1)} us`);
console.log(`untranslated zh msg extra (resolveLoadedMessageContentTranslation ~= extract + cacheMiss + shouldAuto): ${(extract + getCached + shouldAuto).toFixed(1)} us`);
const mixed = 50 * (sig + extract) + 20 * 2 * (refresh + similar) + 25 * (extract + getCached + shouldAuto);
console.log(`mixed channel (20 translated / 25 zh-skip / 5 other): ~${(mixed / 1000).toFixed(2)} ms per full re-render`);
