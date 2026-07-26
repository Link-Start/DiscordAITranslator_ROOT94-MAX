const test = require("node:test");
const assert = require("node:assert/strict");
const {
	createProtectionLogic,
	MESSAGE_PLACES,
	TRANSLATION_PROTECTION_SIGNATURE_VERSION
} = require("../src/protection/protection-logic");

// The two glyphs the module writes, named so an assertion reads as "placeholder 0"
// rather than as punctuation. Invisible characters below (zero-width joiner, variation
// selector) are always written as escapes; visible ones are written as themselves.
const PLACEHOLDER_OPEN = "⟦";
const PLACEHOLDER_CLOSE = "⟧";

function placeholder(index) {
	return `${PLACEHOLDER_OPEN}${index}${PLACEHOLDER_CLOSE}`;
}

// The only library surface protection touches. The real BDFDB.ArrayUtils.is is the
// "is this a usable array" guard applied to the user-editable exception lists.
function createBDFDB(overrides = {}) {
	return Object.assign({ArrayUtils: {is: Array.isArray}}, overrides);
}

// Minimal stand-in for the plugin instance every method takes as its first argument.
// getProtectedWrapperRules mirrors the runtime implementation, including the
// longest-rule-first ordering, because the wrapper pass depends on that order.
function createPlugin(overrides = {}) {
	const settings = {
		general: Object.assign({protectQuotedText: true}, overrides.general || {}),
		exceptions: Object.assign({wordStart: ["!"], protectedTerms: [], wrapperPairs: []}, overrides.exceptions || {})
	};
	return {
		settings,
		getProtectedWrapperRules() {
			const wrapperPairs = Array.isArray(settings.exceptions.wrapperPairs) ? settings.exceptions.wrapperPairs : [];
			return [...new Set(wrapperPairs.map(rule => (rule || "").trim()).filter(Boolean))].map(rule => {
				const splitIndex = rule.indexOf("|");
				if (splitIndex < 1 || splitIndex >= rule.length - 1) return null;
				return {left: rule.slice(0, splitIndex), right: rule.slice(splitIndex + 1), raw: rule};
			}).filter(Boolean).sort((ruleA, ruleB) => (ruleB.left.length + ruleB.right.length) - (ruleA.left.length + ruleA.right.length));
		}
	};
}

function createProtection(bdfdbOverrides) {
	return createProtectionLogic({BDFDB: createBDFDB(bdfdbOverrides)});
}

// The whole point of the module: mask, then unmask, and compare.
function roundTrip(protection, plugin, text, place = MESSAGE_PLACES.SENT) {
	const [maskedText, protectedSegments, hasTranslatableContent] = protection.removeExceptions(plugin, text, place);
	return {
		maskedText,
		protectedSegments,
		protectedValues: Object.values(protectedSegments),
		hasTranslatableContent,
		restoredText: protection.addExceptions(plugin, maskedText, protectedSegments)
	};
}

// --- constants ---------------------------------------------------------------

test("the protection signature version is a fixed string callers can stamp into a cache key", () => {
	// A cache entry written under different protection rules masked different text, so
	// the version is only allowed to change together with the rules below.
	assert.equal(TRANSLATION_PROTECTION_SIGNATURE_VERSION, "2026-06-16-auto-protect-v11");
	assert.equal(typeof TRANSLATION_PROTECTION_SIGNATURE_VERSION, "string");
});

test("changing a protection rule without bumping the version changes what is masked", () => {
	// Demonstrates why the version exists: the same input masks differently under two
	// different exception configurations, so the signature has to carry the rules too.
	const protection = createProtection();
	const withoutTerms = roundTrip(protection, createPlugin(), "the bugteam is here");
	const withTerms = roundTrip(protection, createPlugin({exceptions: {protectedTerms: ["BUG team"]}}), "the bugteam is here");
	assert.notEqual(withoutTerms.maskedText, withTerms.maskedText);
});

test("the message places carry the persisted string values", () => {
	assert.deepEqual(MESSAGE_PLACES, {RECEIVED: "received", SENT: "sent"});
	assert.ok(Object.isFrozen(MESSAGE_PLACES));
});

test("the factory returns a frozen object so no caller can swap a pass out", () => {
	const protection = createProtection();
	assert.ok(Object.isFrozen(protection));
});

// --- settings seams ----------------------------------------------------------

test("escapeRegExp neutralises regex metacharacters and tolerates no input", () => {
	const protection = createProtection();
	assert.equal(protection.escapeRegExp(null, "a.b*c+d?"), "a\\.b\\*c\\+d\\?");
	assert.equal(protection.escapeRegExp(null, "(x)[y]{z}|\\"), "\\(x\\)\\[y\\]\\{z\\}\\|\\\\");
	assert.equal(protection.escapeRegExp(null, ""), "");
	assert.equal(protection.escapeRegExp(null, undefined), "");
});

test("an unset exception scope falls back, an explicit false does not", () => {
	const protection = createProtection();
	assert.equal(protection.getExceptionScopeSetting(createPlugin(), "protectedTermsForSent", true), true);
	assert.equal(protection.getExceptionScopeSetting(createPlugin(), "protectedTermsForSent", false), false);
	assert.equal(protection.getExceptionScopeSetting(createPlugin({exceptions: {protectedTermsForSent: false}}), "protectedTermsForSent", true), false);
	// A plugin with no settings record at all must not throw during startup.
	assert.equal(protection.getExceptionScopeSetting({}, "protectedTermsForSent", true), true);
});

test("each place reads its own scope switch", () => {
	const protection = createProtection();
	const plugin = createPlugin({exceptions: {
		protectedTermsForSent: false,
		protectedTermsForReceived: true,
		wrapperPairsForSent: true,
		wrapperPairsForReceived: false
	}});
	assert.equal(protection.shouldProtectConfiguredTermsForPlace(plugin, MESSAGE_PLACES.SENT), false);
	assert.equal(protection.shouldProtectConfiguredTermsForPlace(plugin, MESSAGE_PLACES.RECEIVED), true);
	assert.equal(protection.shouldProtectWrappedTextForPlace(plugin, MESSAGE_PLACES.SENT), true);
	assert.equal(protection.shouldProtectWrappedTextForPlace(plugin, MESSAGE_PLACES.RECEIVED), false);
	// Anything that is not SENT is treated as received, which is what a null place does.
	assert.equal(protection.shouldProtectWrappedTextForPlace(plugin, null), false);
});

test("the protected term list is trimmed, de-duplicated and ordered longest first", () => {
	const protection = createProtection();
	const plugin = createPlugin({exceptions: {protectedTerms: ["  GPT ", "GPT", "", "   ", "BUG team"]}});
	assert.deepEqual(protection.getProtectedTermsList(plugin), ["BUG team", "GPT"]);
});

test("a protected term list that is not an array is ignored", () => {
	const protection = createProtection();
	assert.deepEqual(protection.getProtectedTermsList(createPlugin({exceptions: {protectedTerms: "GPT"}})), []);
});

test("the injected BDFDB is what decides whether a stored list is usable", () => {
	// Proves the dependency is really wired: a library that rejects the array makes the
	// list empty even though the setting holds terms.
	const protection = createProtection({ArrayUtils: {is: () => false}});
	assert.deepEqual(protection.getProtectedTermsList(createPlugin({exceptions: {protectedTerms: ["GPT"]}})), []);
});

// --- primitives --------------------------------------------------------------

test("trailing punctuation is split off so it can stay translatable", () => {
	const protection = createProtection();
	assert.deepEqual(protection.trimTrailingProtectedPunctuation(null, "example.com,"), {protectedText: "example.com", trailingText: ","});
	assert.deepEqual(protection.trimTrailingProtectedPunctuation(null, "example.com)]"), {protectedText: "example.com", trailingText: ")]"});
	assert.deepEqual(protection.trimTrailingProtectedPunctuation(null, "example.com"), {protectedText: "example.com", trailingText: ""});
	// Punctuation only: nothing may be split off, or the whole match would be lost.
	assert.deepEqual(protection.trimTrailingProtectedPunctuation(null, "..."), {protectedText: "...", trailingText: ""});
	assert.deepEqual(protection.trimTrailingProtectedPunctuation(null, ""), {protectedText: "", trailingText: ""});
});

test("a zero-width match advances instead of looping forever", () => {
	const protection = createProtection();
	const result = protection.protectRegexMatches(createPlugin(), "abc", /x*/g);
	assert.equal(result.string, "abc");
	assert.equal(result.count, 0);
});

test("a non-global regex protects only its first match", () => {
	const protection = createProtection();
	const result = protection.protectRegexMatches(createPlugin(), "a1b2", /\d+/);
	assert.equal(result.string, `a${placeholder(0)}b2`);
	assert.deepEqual(result.protectedSegments, {0: "1"});
});

test("a pass that matches nothing hands back the original string untouched", () => {
	const protection = createProtection();
	const source = "nothing to protect";
	const result = protection.protectRegexMatches(createPlugin(), source, /\d+/g);
	assert.equal(result.string, source);
	assert.equal(result.count, 0);
	// Not a RegExp, and empty input, are both early-outs rather than throws.
	assert.equal(protection.protectRegexMatches(createPlugin(), source, "not-a-regex").string, source);
	assert.equal(protection.protectRegexMatches(createPlugin(), "", /\d+/g).string, "");
});

test("a normalize hook can shrink a match or decline it entirely", () => {
	const protection = createProtection();
	const shrink = protection.protectRegexMatches(createPlugin(), "see abc! ok", /abc!/g, {}, 0, {
		normalize: fullMatch => ({protectedText: fullMatch.slice(0, -1), trailingText: "!"})
	});
	assert.equal(shrink.string, `see ${placeholder(0)}! ok`);
	assert.deepEqual(shrink.protectedSegments, {0: "abc"});

	// Declining leaves the matched text in place and consumes no placeholder number.
	const decline = protection.protectRegexMatches(createPlugin(), "see abc! ok", /abc!/g, {}, 0, {
		normalize: () => ({protectedText: "   "})
	});
	assert.equal(decline.string, "see abc! ok");
	assert.equal(decline.count, 0);
});

test("placeholders are numbered from a counter the caller threads through the passes", () => {
	const protection = createProtection();
	const plugin = createPlugin();
	const first = protection.protectRegexMatches(plugin, "a1b2", /\d/g);
	const second = protection.protectRegexMatches(plugin, "c3", /\d/g, first.protectedSegments, first.count);
	assert.equal(second.string, `c${placeholder(2)}`);
	assert.deepEqual(second.protectedSegments, {0: "1", 1: "2", 2: "3"});
});

// --- individual protection passes --------------------------------------------

test("a fenced code block is protected whole, an unclosed fence is not", () => {
	const protection = createProtection();
	const plugin = createPlugin();
	const source = "```js\nhttps://example.com API_KEY\n```";
	const protectedResult = protection.protectCodeBlockSegments(plugin, source);
	assert.equal(protectedResult.string, placeholder(0));
	assert.deepEqual(protectedResult.protectedSegments, {0: source});

	const unclosed = protection.protectCodeBlockSegments(plugin, "```js\nhello");
	assert.equal(unclosed.string, "```js\nhello");
	assert.equal(unclosed.count, 0);
});

test("emails, urls, bare domains, addresses and slash commands are auto-detected", () => {
	const protection = createProtection();
	const plugin = createPlugin();
	assert.deepEqual(Object.values(protection.protectAutoDetectedSegments(plugin, "write to name@example.com now").protectedSegments), ["name@example.com"]);
	assert.deepEqual(Object.values(protection.protectAutoDetectedSegments(plugin, "go to platform.openai.com now").protectedSegments), ["platform.openai.com"]);
	assert.deepEqual(Object.values(protection.protectAutoDetectedSegments(plugin, "ping 192.168.0.1:8080 ok").protectedSegments), ["192.168.0.1:8080"]);
	assert.deepEqual(Object.values(protection.protectAutoDetectedSegments(plugin, "run /help now").protectedSegments), ["/help"]);
	assert.deepEqual(Object.values(protection.protectAutoDetectedSegments(plugin, "/help now").protectedSegments), ["/help"]);
});

test("a url keeps its sentence punctuation outside the protected span", () => {
	const protection = createProtection();
	const result = protection.protectAutoDetectedSegments(createPlugin(), "see https://example.com/a, ok");
	assert.equal(result.string, `see ${placeholder(0)}, ok`);
	assert.deepEqual(result.protectedSegments, {0: "https://example.com/a"});
});

test("a bare decimal number is not mistaken for a domain", () => {
	const protection = createProtection();
	const result = protection.protectAutoDetectedSegments(createPlugin(), "version 3.1 here");
	assert.equal(result.string, "version 3.1 here");
	assert.equal(result.count, 0);
});

test("discord markup is protected by shape, not by lookup", () => {
	const protection = createProtection();
	const source = "hi <@!123> <@&456> <#789> <:wave:321> <a:spin:654> <t:1700000000:R>";
	const result = protection.protectDiscordMarkupSegments(createPlugin(), source);
	assert.deepEqual(Object.values(result.protectedSegments), ["<@!123>", "<@&456>", "<#789>", "<:wave:321>", "<a:spin:654>", "<t:1700000000:R>"]);
	assert.equal(protection.addExceptions(createPlugin(), result.string, result.protectedSegments), source);
});

test("quoted text is protected only while the setting is on and the quote has content", () => {
	const protection = createProtection();
	const on = protection.protectQuotedTextSegments(createPlugin(), `he said "hi there" ok`);
	assert.equal(on.string, `he said ${placeholder(0)} ok`);
	assert.deepEqual(on.protectedSegments, {0: `"hi there"`});

	const off = protection.protectQuotedTextSegments(createPlugin({general: {protectQuotedText: false}}), `he said "hi there" ok`);
	assert.equal(off.count, 0);

	const blank = protection.protectQuotedTextSegments(createPlugin(), `he said "   " ok`);
	assert.equal(blank.count, 0);
});

test("wrapper pairs protect their whole span, delimiters included", () => {
	const protection = createProtection();
	const plugin = createPlugin({exceptions: {wrapperPairs: [`"|"`, "`|`"]}});
	const result = protection.protectWrappedTextSegments(plugin, "use `default` for now");
	assert.equal(result.string, `use ${placeholder(0)} for now`);
	assert.deepEqual(result.protectedSegments, {0: "`default`"});
});

test("a wrapper span is skipped when it is unclosed, empty or spans a line break", () => {
	const protection = createProtection();
	const plugin = createPlugin({exceptions: {wrapperPairs: [`"|"`]}});
	assert.equal(protection.protectWrappedTextSegments(plugin, `say "a then`).count, 0);
	assert.equal(protection.protectWrappedTextSegments(plugin, `say "   " then`).count, 0);
	assert.equal(protection.protectWrappedTextSegments(plugin, `say "a\nb" then`).count, 0);
});

test("the wrapper pass is skipped for a place whose scope switch is off", () => {
	const protection = createProtection();
	const plugin = createPlugin({exceptions: {wrapperPairs: [`"|"`], wrapperPairsForSent: false}});
	assert.equal(protection.protectWrappedTextSegments(plugin, `say "a" then`, {}, 0, MESSAGE_PLACES.SENT).count, 0);
	assert.equal(protection.protectWrappedTextSegments(plugin, `say "a" then`, {}, 0, MESSAGE_PLACES.RECEIVED).count, 1);
});

test("two spans sharing a delimiter are protected separately, not merged", () => {
	const protection = createProtection();
	const plugin = createPlugin({exceptions: {wrapperPairs: [`"|"`]}});
	const result = roundTrip(protection, plugin, `say "a" then "b"`);
	assert.deepEqual(result.protectedValues, [`"a"`, `"b"`]);
	assert.equal(result.restoredText, `say "a" then "b"`);
});

test("a nested wrapper pair survives the round trip", () => {
	// The outer span swallows the inner placeholder, so segment 1 holds the text `<0>`
	// and placeholder 0 never reaches the provider. A single ascending pass used to
	// substitute 0 before 1 put it back, leaving a raw marker in the message, and the
	// response guard used to demand a placeholder the provider was never shown - which
	// rejected every translation of a message containing a nested pair.
	const protection = createProtection();
	const plugin = createPlugin({exceptions: {wrapperPairs: [`"|"`, "`|`"]}});
	const result = roundTrip(protection, plugin, '`"x"` done');
	assert.equal(result.maskedText, `${placeholder(1)} done`);
	assert.deepEqual(result.protectedSegments, {0: `"x"`, 1: `\`${placeholder(0)}\``});
	assert.equal(result.restoredText, '`"x"` done');
	assert.equal(protection.hasAllProtectionPlaceholders(plugin, result.maskedText, result.protectedSegments), true);
});

test("a three-deep nest restores from the inside out", () => {
	const protection = createProtection();
	const plugin = createPlugin({exceptions: {wrapperPairs: [`"|"`, "`|`", "(|)"]}});
	const result = roundTrip(protection, plugin, '(`"x"`)');
	assert.equal(result.restoredText, '(`"x"`)');
	assert.equal(protection.hasAllProtectionPlaceholders(plugin, result.maskedText, result.protectedSegments), true);
});

test("a nested placeholder the provider dropped is still detected", () => {
	// Only the markers the provider actually saw are evidence. Dropping the outer one
	// must still fail the guard, or a mangled response would reach the user.
	const protection = createProtection();
	const plugin = createPlugin({exceptions: {wrapperPairs: [`"|"`, "`|`"]}});
	const result = roundTrip(protection, plugin, '`"x"` done');
	assert.equal(protection.hasAllProtectionPlaceholders(plugin, "done", result.protectedSegments), false);
});

test("configured terms match case-insensitively and across collapsed spaces", () => {
	const protection = createProtection();
	const plugin = createPlugin({exceptions: {protectedTerms: ["BUG team", "GPT"]}});
	const result = protection.protectConfiguredTerms(plugin, "the bugteam uses GPT and gpt4");
	assert.deepEqual(result.protectedSegments, {0: "bugteam", 1: "GPT"});
	// "gpt4" is not the term: the trailing word character blocks the boundary match.
	assert.match(result.string, /and gpt4$/);
});

test("a configured term keeps the character that preceded it", () => {
	const protection = createProtection();
	const plugin = createPlugin({exceptions: {protectedTerms: ["GPT"]}});
	const result = protection.protectConfiguredTerms(plugin, "use GPT now");
	assert.equal(result.string, `use ${placeholder(0)} now`);
});

test("paths, filenames, versions, camel case and snake case are auto-protected", () => {
	const protection = createProtection();
	const result = protection.protectAutoTechnicalTerms(createPlugin(), "open src/app.js and read camelCaseThing plus snake_case_word v1.2.3");
	const values = Object.values(result.protectedSegments);
	assert.ok(values.includes("src/app.js"));
	assert.ok(values.includes("camelCaseThing"));
	assert.ok(values.includes("snake_case_word"));
	assert.ok(values.includes("v1.2.3"));
});

test("all-caps shouting stays translatable while acronyms in other text do not", () => {
	const protection = createProtection();
	const plugin = createPlugin();
	assert.equal(protection.protectAutoTechnicalTerms(plugin, "HELLO CRYZYYY").count, 0);
	const mixed = protection.protectAutoTechnicalTerms(plugin, "我需要CDK用于GPT");
	assert.deepEqual(Object.values(mixed.protectedSegments), ["CDK", "GPT"]);
});

test("the mixed-language latin pass is a deliberate no-op", () => {
	const protection = createProtection();
	const result = protection.protectMixedLanguageLatinTokens(null, "this is bybit again");
	assert.equal(result.string, "this is bybit again");
	assert.equal(result.count, 0);
});

test("emoji graphemes are protected whole, digits are not", () => {
	const protection = createProtection();
	const plugin = createPlugin();
	const thumbsUp = "\u{1F44D}\u{1F3FD}";
	const family = "👨‍👩‍👦";
	const result = protection.protectUnicodeEmojiSegments(plugin, `hi ${thumbsUp} and ${family} end`);
	assert.deepEqual(result.protectedSegments, {0: thumbsUp, 1: family});
	assert.equal(protection.protectUnicodeEmojiSegments(plugin, "1 2 3").count, 0);
	// A keycap sequence is an emoji even though it starts with a digit.
	assert.deepEqual(protection.protectUnicodeEmojiSegments(plugin, "1️⃣").protectedSegments, {0: "1️⃣"});
});

test("the emoji detector rejects the bare characters a keycap is built from", () => {
	const protection = createProtection();
	assert.equal(protection.isUnicodeEmojiGrapheme(null, "1"), false);
	assert.equal(protection.isUnicodeEmojiGrapheme(null, "#"), false);
	assert.equal(protection.isUnicodeEmojiGrapheme(null, "a"), false);
	assert.equal(protection.isUnicodeEmojiGrapheme(null, ""), false);
	assert.equal(protection.isUnicodeEmojiGrapheme(null, null), false);
	assert.equal(protection.isUnicodeEmojiGrapheme(null, "\u{1F44D}"), true);
});

// --- placeholders and restore -------------------------------------------------

test("the written placeholder is the corner-bracket form", () => {
	const protection = createProtection();
	assert.equal(protection.createProtectionPlaceholder(null, 7), `${PLACEHOLDER_OPEN}7${PLACEHOLDER_CLOSE}`);
});

test("the placeholder regex matches every shape an engine is known to emit", () => {
	const protection = createProtection();
	const plugin = createPlugin();
	const variants = [
		placeholder(0),
		`${PLACEHOLDER_OPEN} DTA 0 ${PLACEHOLDER_CLOSE}`,
		"【0】",
		"【 0 】",
		"[0]",
		"[ 0 ]",
		"<<<0>>>",
		"< < < 0 > > >",
		"{{0}}",
		"｛｛0｝｝"
	];
	for (const variant of variants) assert.equal(protection.getProtectionPlaceholderRegex(plugin, 0).test(variant), true, `expected ${JSON.stringify(variant)} to be recognised`);
	assert.equal(protection.getProtectionPlaceholderRegex(plugin, 0).test("(0)"), false);
	// Each call builds a fresh regex, so the /g lastIndex of one test cannot leak into
	// the next - which is what hasAllProtectionPlaceholders relies on.
	const regex = protection.getProtectionPlaceholderRegex(plugin, 0);
	assert.equal(regex.lastIndex, 0);
});

test("a display exception is passed through unchanged, and null becomes empty", () => {
	const protection = createProtection();
	assert.equal(protection.formatProtectedExceptionForDisplay(null, "<@123>"), "<@123>");
	assert.equal(protection.formatProtectedExceptionForDisplay(null, "plain"), "plain");
	assert.equal(protection.formatProtectedExceptionForDisplay(null, null), "");
	assert.equal(protection.formatProtectedExceptionForDisplay(null, 5), "5");
});

test("the placeholder guard passes on nothing to protect and fails on a dropped marker", () => {
	const protection = createProtection();
	const plugin = createPlugin();
	assert.equal(protection.hasAllProtectionPlaceholders(plugin, "anything", {}), true);
	assert.equal(protection.hasAllProtectionPlaceholders(plugin, "anything", null), true);
	assert.equal(protection.hasAllProtectionPlaceholders(plugin, `a ${placeholder(0)} b ${placeholder(1)}`, {0: "x", 1: "y"}), true);
	assert.equal(protection.hasAllProtectionPlaceholders(plugin, `a ${placeholder(0)} b`, {0: "x", 1: "y"}), false);
	assert.equal(protection.hasAllProtectionPlaceholders(plugin, "", {0: "x"}), false);
	// A rewritten marker still counts as present, or every such response would be dropped.
	assert.equal(protection.hasAllProtectionPlaceholders(plugin, "a 【0】 b", {0: "x"}), true);
});

test("restore accepts a rewritten marker and silently tolerates a missing one", () => {
	const protection = createProtection();
	const plugin = createPlugin();
	assert.equal(protection.addExceptions(plugin, "hello 【0】", {0: "<@123>"}), "hello <@123>");
	assert.equal(protection.addExceptions(plugin, "hello {{0}}", {0: "<@123>"}), "hello <@123>");
	// Nothing to substitute into: the segment is dropped rather than appended.
	assert.equal(protection.addExceptions(plugin, "hello", {0: "<@123>"}), "hello");
});

test("restore strips a configured word-start marker from what it puts back", () => {
	const protection = createProtection();
	const plugin = createPlugin();
	assert.equal(protection.addExceptions(plugin, `hi ${placeholder(0)}`, {0: "!keep"}), "hi keep");
	assert.equal(protection.addExceptions(plugin, `hi ${placeholder(0)}`, {0: "keep"}), "hi keep");
});

// --- the full mask/restore contract -------------------------------------------

test("a sent message round-trips through mask and restore", () => {
	const protection = createProtection();
	const plugin = createPlugin({exceptions: {protectedTerms: ["BUG team"], wrapperPairs: ["`|`"]}});
	const source = "ping <@!123> about `default` for BUG team on https://example.com/docs";
	const result = roundTrip(protection, plugin, source);
	assert.ok(result.protectedValues.includes("<@!123>"));
	assert.ok(result.protectedValues.includes("`default`"));
	assert.ok(result.protectedValues.includes("BUG team"));
	assert.ok(result.protectedValues.includes("https://example.com/docs"));
	assert.equal(result.hasTranslatableContent, true);
	assert.equal(result.restoredText, source);
});

test("a received message round-trips without the word-splitting pass", () => {
	const protection = createProtection();
	const plugin = createPlugin();
	const source = "hello <@!123456789> <:wave:456789> world";
	const result = roundTrip(protection, plugin, source, MESSAGE_PLACES.RECEIVED);
	assert.ok(result.protectedValues.includes("<@!123456789>"));
	assert.ok(result.protectedValues.includes("<:wave:456789>"));
	assert.equal(result.restoredText, source);
});

test("only the sent path masks bare mentions and word-start marked words", () => {
	const protection = createProtection();
	const plugin = createPlugin();
	const sent = roundTrip(protection, plugin, "hi @bob !skip", MESSAGE_PLACES.SENT);
	assert.ok(sent.protectedValues.includes("@bob"));
	assert.ok(sent.protectedValues.includes("!skip"));

	const received = roundTrip(protection, plugin, "hi @bob !skip", MESSAGE_PLACES.RECEIVED);
	assert.equal(received.maskedText, "hi @bob !skip");
	assert.deepEqual(received.protectedValues, []);
});

test("both paths preserve the message whitespace exactly", () => {
	// The sent path splits on single spaces and rejoins on them, which only round-trips
	// because the empty pieces of a run of spaces survive the split. The received path
	// never splits at all. Either way the masked text has to be the original layout.
	const protection = createProtection();
	const source = "a  b\nc";
	assert.equal(roundTrip(protection, createPlugin(), source, MESSAGE_PLACES.SENT).maskedText, source);
	assert.equal(roundTrip(protection, createPlugin(), source, MESSAGE_PLACES.RECEIVED).maskedText, source);
});

test("a message that is entirely protected content is reported as untranslatable", () => {
	const protection = createProtection();
	const plugin = createPlugin();
	const codeOnly = roundTrip(protection, plugin, "```js\nconst a = 1;\n```");
	assert.equal(codeOnly.hasTranslatableContent, false);
	assert.equal(codeOnly.restoredText, "```js\nconst a = 1;\n```");

	const mentionOnly = roundTrip(protection, plugin, "<@!123>", MESSAGE_PLACES.RECEIVED);
	assert.equal(mentionOnly.hasTranslatableContent, false);
});

test("a rewritten marker in the response still leaves nothing translatable behind", () => {
	// hasTranslatableContent strips the same alternative marker shapes the restore
	// accepts, so a masked message is not judged translatable because of its markers.
	const protection = createProtection();
	const result = protection.removeExceptions(createPlugin(), "<@!123> <@!456>", MESSAGE_PLACES.RECEIVED);
	assert.equal(result[2], false);
});

test("empty and blank input are handled without throwing", () => {
	const protection = createProtection();
	const plugin = createPlugin();
	assert.deepEqual(protection.removeExceptions(plugin, "", MESSAGE_PLACES.SENT), ["", {}, false]);
	assert.deepEqual(protection.removeExceptions(plugin, "", MESSAGE_PLACES.RECEIVED), ["", {}, false]);
	assert.deepEqual(protection.removeExceptions(plugin, "   ", MESSAGE_PLACES.RECEIVED), ["   ", {}, false]);
	assert.equal(protection.addExceptions(plugin, "", {}), "");
});

test("content inside a protected code block is not protected a second time", () => {
	// Ordering guarantee: the code block pass runs before the url and acronym passes,
	// so the block is one segment instead of several nested ones.
	const protection = createProtection();
	const source = "```\nsee https://example.com and API_KEY\n```";
	const result = roundTrip(protection, createPlugin(), source);
	assert.deepEqual(result.protectedValues, [source]);
	assert.equal(result.restoredText, source);
});

test("a url inside a wrapper pair is protected once, as part of the wrapper span", () => {
	const protection = createProtection();
	const plugin = createPlugin({exceptions: {wrapperPairs: ["`|`"]}});
	const source = "read `https://example.com/a` please";
	const result = roundTrip(protection, plugin, source);
	assert.deepEqual(result.protectedValues, ["`https://example.com/a`"]);
	assert.equal(result.restoredText, source);
});
