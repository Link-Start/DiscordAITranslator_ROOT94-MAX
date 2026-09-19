const test = require("node:test");
const assert = require("node:assert/strict");

const {classifyHistoricalBatchValidation} = require("../../src/orchestrator/historical-validation-classifier");
const {isNameLikeMessage, messageTextLines, legacySoftReasonLabel, SOFT_REASONS} = require("../../src/planner/translation-soft-validation");

const DIVIDER = "__________________ __________________ __________________";
const likelyTarget = value => /[\p{Script=Han}]/u.test(String(value || ""));
const createStored = (message, channelId, originalContentData, signature, translation) => {
	const strings = String(translation).split(/\n{0,1}__________________ __________________ __________________\n{0,1}/);
	return {signature, channelId, auto: true, translatedContent: strings.shift().trim(), originalContent: String(originalContentData.content || "").trim(), embeds: strings.length ? {"embed-0": {title: strings[0].split("\n")[0]}} : {}};
};
const tooSimilarByText = stored => String(stored.originalContent).trim() === String(stored.translatedContent).trim();

function prepared(content, {embeds = [], protectedText = null, exceptions = []} = {}) {
	const originalContentData = {content, embeds};
	let text = content;
	for (const embed of embeds) text += `\n${DIVIDER}\n${embed.title}\n${embed.description}${(embed.fields || []).map(field => `\n\n${field.name}__________________${field.value}`).join("")}${embed.footerText ? `\n${embed.footerText}` : ""}`;
	return {message: {id: "m1"}, originalContentData, signature: "sig", protectedText: protectedText == null ? text.trim() : protectedText, exceptions, input: {id: "en"}, output: {id: "zh-CN"}};
}

function classify(item, rawTranslation, overrides = {}) {
	return classifyHistoricalBatchValidation(Object.assign({
		prepared: item, rawTranslation, channelId: "c1",
		isSkipSignal: () => false,
		hasPlaceholders: () => true,
		addExceptions: (value, exceptions) => String(value).replace(/⟦(\d+)⟧/g, (_, index) => exceptions[Number(index)] || ""),
		likelyTarget,
		createStored,
		shouldKeep: stored => !tooSimilarByText(stored),
		tooSimilar: tooSimilarByText
	}, overrides));
}

test("legacy compatibility validation also repairs ordinary short sentence echoes", () => {
	for (const source of ["Do not publish this.", "Please wait until Friday.", "please wait", "**PLEASE WAIT.**", "***Are You Ready?***", "__PLEASE WAIT.__", "||PLEASE WAIT.||"]) {
		const result = classify(prepared(source), source);
		assert.equal(result.outcome.ok, false, source);
		assert.equal(result.reason, "wrong_language");
		assert.equal(result.repairEligible, true);
	}
});

test("P3-b whole-message rule: every lettered line left after placeholders and dividers must be name-like", () => {
	assert.deepEqual(messageTextLines(`Atomic Gains\n⟦0⟧\n${DIVIDER}\nECHOES OF TOMORROW | Higgsfield Community\nA short film about memory and loss.\n\nDuration__________________2:31\nHiggsfield Community`), ["Atomic Gains", "ECHOES OF TOMORROW | Higgsfield Community", "A short film about memory and loss.", "Duration", "Higgsfield Community"]);
	assert.equal(isNameLikeMessage("Atomic Gains"), true);
	assert.equal(isNameLikeMessage("ECHOES OF TOMORROW | Higgsfield Community"), true);
	assert.equal(isNameLikeMessage(`Atomic Gains ⟦0⟧\n${DIVIDER}\nECHOES OF TOMORROW\nHiggsfield Community`), true, "placeholders and dividers are not text");
	assert.equal(isNameLikeMessage("Atomic ⟦0⟧ Gains [NEWLINE] Self-Pay"), true, "batch wire newline markers split lines");
	assert.equal(isNameLikeMessage("Atomic Gains\nplease review the updated schedule before the meeting tomorrow morning"), false, "one prose line makes the message prose");
	assert.equal(isNameLikeMessage(`${DIVIDER}\nECHOES OF TOMORROW\nA short film about memory and loss made with generative tools over one weekend.`), false);
	assert.equal(isNameLikeMessage(""), false, "no lettered line: not name-like, the existing verdict stands");
	assert.equal(isNameLikeMessage("⟦0⟧ ⟦1⟧ 12345"), false);
	assert.equal(legacySoftReasonLabel("wrong_language"), "wrong-language");
	assert.equal(legacySoftReasonLabel("too_similar"), "too-similar");
	assert.equal(legacySoftReasonLabel("same_as_source"), "too-similar");
	assert.equal(legacySoftReasonLabel("policy_rejected"), null);
	assert.equal(legacySoftReasonLabel("missing_id"), null);
	for (const label of ["wrong-language", "too-similar"]) assert.ok(SOFT_REASONS.includes(label));
});

test("P3-b classifier keeps a name-like whole message echoed by the legacy batch as its source text", () => {
	const item = prepared("Atomic Gains");
	const echoed = classify(item, "Atomic Gains");
	assert.equal(echoed.outcome.ok, true);
	assert.equal(echoed.reason, null);
	assert.equal(echoed.repairEligible, false);
	assert.equal(echoed.kept, "wrong-language", "an English echo fails the target-language check first");
	assert.equal(echoed.outcome.keptCount, 1);
	assert.deepEqual(echoed.outcome.keptReasons, {"wrong-language": 1});
	assert.equal(echoed.outcome.translation.translatedContent, "Atomic Gains", "kept text is the source");
	assert.equal(echoed.outcome.translation.keptSegmentCount, 1);
	assert.deepEqual(echoed.outcome.translation.keptReasons, {"wrong-language": 1});
	// The kept copy is rebuilt from the protected source, never from the provider's bytes.
	const paraphrased = classify(item, "Atomic  Gains!!");
	assert.equal(paraphrased.outcome.ok, true);
	assert.equal(paraphrased.outcome.translation.translatedContent, "Atomic Gains");
	// Reach the similarity branch for a name accepted by the target-language check.
	const same = classify(item, "Atomic Gains", {likelyTarget: () => true});
	assert.equal(same.outcome.ok, true);
	assert.equal(same.kept, "too-similar");
	assert.deepEqual(same.outcome.keptReasons, {"too-similar": 1});
	const viaTooSimilar = classify(item, "Atomic Gains", {likelyTarget: () => true, shouldKeep: () => true});
	assert.equal(viaTooSimilar.outcome.ok, true);
	assert.equal(viaTooSimilar.kept, "too-similar");
});

test("P3-b classifier: placeholders are restored in the kept copy and an embed-shaped name-like message is kept whole", () => {
	const item = prepared("Atomic Gains ⟦0⟧", {embeds: [{title: "ECHOES OF TOMORROW", description: "Higgsfield Community", footerText: "Higgsfield Community"}], exceptions: ["https://www.youtube.invalid/watch?v=p3fixture"]});
	const echoed = classify(item, item.protectedText.replace(/\n/g, " [NEWLINE] "));
	assert.equal(echoed.outcome.ok, true);
	assert.equal(echoed.outcome.translation.translatedContent, "Atomic Gains https://www.youtube.invalid/watch?v=p3fixture");
	assert.equal(echoed.outcome.translation.embeds["embed-0"].title, "ECHOES OF TOMORROW");
	assert.equal(echoed.outcome.keptCount, 1, "the legacy wire has one unit: the whole message");
});

test("P3-b classifier: prose soft failures and every hard or policy failure keep the existing verdicts byte for byte", () => {
	const prose = prepared("please review the updated schedule before the meeting tomorrow morning");
	assert.deepEqual(classify(prose, prose.protectedText), {outcome: {ok: false}, reason: "wrong_language", repairEligible: true});
	// Passes the target-language check (it carries Han) but is prose: the similarity verdicts stand.
	const mixedProse = prepared("please review the updated schedule before the meeting tomorrow morning 请审阅");
	assert.deepEqual(classify(mixedProse, mixedProse.protectedText), {outcome: {ok: false}, reason: "policy_rejected", repairEligible: true}, "the keep policy rejection stays policy_rejected for prose");
	assert.deepEqual(classify(mixedProse, mixedProse.protectedText, {shouldKeep: () => true}), {outcome: {ok: false}, reason: "same_as_source", repairEligible: true});
	const name = prepared("Atomic Gains");
	assert.deepEqual(classify(name, null), {outcome: {ok: false}, reason: "missing_id", repairEligible: true});
	assert.deepEqual(classify(name, "   "), {outcome: {ok: false}, reason: "empty", repairEligible: true});
	assert.deepEqual(classify(name, "Atomic Gains", {hasPlaceholders: () => false}), {outcome: {ok: false}, reason: "placeholder_missing", repairEligible: true});
	assert.deepEqual(classify(name, "SKIP", {isSkipSignal: () => true}), {outcome: {ok: false, skipped: true, reason: "ai_skip_signal"}, reason: "policy_rejected", repairEligible: false});
	// A name-like message rejected by policy for a reason other than similarity (same language,
	// source filter) is not a soft failure and is not kept.
	assert.deepEqual(classify(name, "原子增益", {shouldKeep: () => false, tooSimilar: () => false}), {outcome: {ok: false}, reason: "policy_rejected", repairEligible: true});
	// A translated name-like message is simply valid, no kept fields.
	const valid = classify(name, "原子增益");
	assert.equal(valid.outcome.ok, true);
	assert.equal(valid.outcome.keptCount, undefined);
	assert.equal(valid.outcome.translation.keptSegmentCount, undefined);
	// The name-like test is never evaluated on the way to a valid or hard verdict.
	let asked = 0;
	const spy = Object.defineProperty(Object.assign({}, name), "protectedText", {get() {asked++; return "Atomic Gains";}});
	classify(spy, "原子增益");
	classify(spy, null);
	assert.equal(asked, 0);
});
