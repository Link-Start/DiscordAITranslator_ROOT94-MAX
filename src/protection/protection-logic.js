// Owns text protection: the pass that hides everything a translation engine must not
// touch behind numbered placeholders, and the pass that puts it back afterwards.
//
// The two halves are a contract, not two independent helpers. removeExceptions hands
// back [maskedText, protectedSegments, hasTranslatableContent]; addExceptions is the
// only thing that can undo it, and it does so by index. Every rule below exists to
// keep that round trip intact:
//
// - The order of the protect* passes in removeExceptions is load bearing. Discord
//   markup and fenced code blocks are masked first, so a URL or an acronym inside a
//   code block is never re-masked and never re-ordered by a later pass.
// - Placeholders are allocated from one shared counter that the caller threads through
//   every pass, which is why each pass takes and returns {string, protectedSegments,
//   count} instead of owning its own numbering.
// - getProtectionPlaceholderRegex deliberately matches more shapes than
//   createProtectionPlaceholder ever writes. Translation engines rewrite the marker
//   into square brackets, fullwidth brackets, angle-bracket triples or double braces,
//   and they insert whitespace or a stray "DTA" inside it. A restore that only matched
//   the exact form it wrote would drop the protected text on the floor.
// - hasTranslatableContent is what stops the plugin paying for a request whose entire
//   payload is placeholders.
//
// The module knows nothing about translation, caching or display. What it cannot
// compute for itself - the user's wrapper pairs - arrives through the plugin instance
// that every method takes as its first argument, exactly as the legacy runtime passed
// it, so the plugin-side wrappers stay one-liners.

// Same values as the legacy messageTypes map. Protection only ever compares a place
// against these two, and the values are what is persisted in settings, so they are
// string literals rather than symbols.
const MESSAGE_PLACES = Object.freeze({
	RECEIVED: "received",
	SENT: "sent"
});

// Stamped into the received-translation request signature. Bump it whenever a change
// here would make an already cached translation wrong - a cache entry written under
// different protection rules masked different text, so it is not evidence about what
// the current rules would produce.
const TRANSLATION_PROTECTION_SIGNATURE_VERSION = "2026-06-16-auto-protect-v11";

function createProtectionLogic({
	// The only thing protection needs from the library is the "is this a usable array"
	// guard it applies to the three user-editable exception lists. Defaulted so the
	// module is constructible on its own; the plugin injects the real library.
	BDFDB = {ArrayUtils: {is: Array.isArray}}
} = {}) {
	const protectionLogic = {
		escapeRegExp(_plugin, string) {
			return (string || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		},
		getExceptionScopeSetting(plugin, key, fallback = true) {
			const exceptions = plugin.settings && plugin.settings.exceptions || {};
			return exceptions[key] == null ? !!fallback : !!exceptions[key];
		},
		shouldProtectConfiguredTermsForPlace(plugin, place) {
			return place == MESSAGE_PLACES.SENT ? protectionLogic.getExceptionScopeSetting(plugin, "protectedTermsForSent", true) : protectionLogic.getExceptionScopeSetting(plugin, "protectedTermsForReceived", true);
		},
		shouldProtectWrappedTextForPlace(plugin, place) {
			return place == MESSAGE_PLACES.SENT ? protectionLogic.getExceptionScopeSetting(plugin, "wrapperPairsForSent", true) : protectionLogic.getExceptionScopeSetting(plugin, "wrapperPairsForReceived", true);
		},
		getProtectedTermsList(plugin) {
			let protectedTerms = BDFDB.ArrayUtils.is(plugin.settings.exceptions.protectedTerms) ? plugin.settings.exceptions.protectedTerms : [];
			return [...new Set(protectedTerms.map(term => (term || "").trim()).filter(Boolean))].sort((termA, termB) => termB.length - termA.length);
		},
		trimTrailingProtectedPunctuation(_plugin, text) {
			if (!text) return {protectedText: text, trailingText: ""};
			const trailingMatch = text.match(/([,.;:!?'"`)\]}>，。！？；：）】」》、]+)$/);
			if (!trailingMatch || trailingMatch.index < 1) return {protectedText: text, trailingText: ""};
			return {
				protectedText: text.slice(0, trailingMatch.index),
				trailingText: trailingMatch[0]
			};
		},
		protectRegexMatches(plugin, string, regex, protectedSegments = {}, count = 0, options = {}) {
			if (!string || !(regex instanceof RegExp)) return {string, protectedSegments, count};
			regex.lastIndex = 0;
			let lastIndex = 0, nextString = "", hasMatch = false, match;
			while ((match = regex.exec(string))) {
				let fullMatch = match[0];
				if (!fullMatch) {
					if (regex.global && regex.lastIndex === match.index) regex.lastIndex++;
					continue;
				}
				let protectedText = fullMatch;
				let trailingText = "";
				if (typeof options.normalize == "function") {
					let normalized = options.normalize(fullMatch, match, string) || {};
					protectedText = normalized.protectedText != null ? normalized.protectedText : protectedText;
					trailingText = normalized.trailingText || "";
				}
				if (!protectedText || !String(protectedText).trim()) continue;
				hasMatch = true;
				nextString += string.slice(lastIndex, match.index);
				protectedSegments[count] = protectedText;
				nextString += `${protectionLogic.createProtectionPlaceholder(plugin, count++)}${trailingText}`;
				lastIndex = match.index + fullMatch.length;
				if (!regex.global) break;
			}
			if (!hasMatch) return {string, protectedSegments, count};
			nextString += string.slice(lastIndex);
			return {string: nextString, protectedSegments, count};
		},
		protectCodeBlockSegments(plugin, string, protectedSegments = {}, count = 0) {
			return protectionLogic.protectRegexMatches(plugin, string, /```[\s\S]*?```/g, protectedSegments, count);
		},
		protectAutoDetectedSegments(plugin, string, protectedSegments = {}, count = 0) {
			let result = protectionLogic.protectRegexMatches(plugin, string, /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,24}\b/gi, protectedSegments, count);
			string = result.string;
			protectedSegments = result.protectedSegments;
			count = result.count;

			const trimTrailing = fullMatch => protectionLogic.trimTrailingProtectedPunctuation(plugin, fullMatch);
			result = protectionLogic.protectRegexMatches(plugin, string, /\bhttps?:\/\/[^\s<>()\u3000]+/gi, protectedSegments, count, {normalize: trimTrailing});
			string = result.string;
			protectedSegments = result.protectedSegments;
			count = result.count;

			result = protectionLogic.protectRegexMatches(plugin, string, /\b(?:www\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}(?:\/[^\s<>()\u3000]*)?/gi, protectedSegments, count, {
				normalize: fullMatch => {
					const trimmed = trimTrailing(fullMatch);
					if (!/[./]/.test(trimmed.protectedText || "")) return {protectedText: "", trailingText: fullMatch};
					return trimmed;
				}
			});
			string = result.string;
			protectedSegments = result.protectedSegments;
			count = result.count;

			result = protectionLogic.protectRegexMatches(plugin, string, /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{2,5})?\b/g, protectedSegments, count);
			string = result.string;
			protectedSegments = result.protectedSegments;
			count = result.count;

			string = string.replace(/(^|\s)(\/[A-Za-z][A-Za-z0-9_-]{1,32})(?=\s|$)/g, (fullMatch, leading, command) => {
				protectedSegments[count] = command;
				return `${leading || ""}${protectionLogic.createProtectionPlaceholder(plugin, count++)}`;
			});

			return {string, protectedSegments, count};
		},
		protectDiscordMarkupSegments(plugin, string, protectedSegments = {}, count = 0) {
			if (!string) return {string, protectedSegments, count};
			return protectionLogic.protectRegexMatches(plugin, string, /<a?:[A-Za-z0-9_~]+:\d+>|<@[!&]?\d+>|<#\d+>|<@&\d+>|<t:\d+(?::[tTdDfFR])?>/g, protectedSegments, count);
		},
		protectQuotedTextSegments(plugin, string, protectedSegments = {}, count = 0) {
			if (!plugin.settings.general.protectQuotedText || !string) return {string, protectedSegments, count};
			const quotedRegex = /"([^"\r\n]+)"|“([^”\r\n]+)”/g;
			string = string.replace(quotedRegex, fullMatch => {
				if (!fullMatch || !fullMatch.slice(1, -1).trim()) return fullMatch;
				protectedSegments[count] = fullMatch;
				return protectionLogic.createProtectionPlaceholder(plugin, count++);
			});
			return {string, protectedSegments, count};
		},
		protectWrappedTextSegments(plugin, string, protectedSegments = {}, count = 0, place = null) {
			if (!protectionLogic.shouldProtectWrappedTextForPlace(plugin, place) || !string) return {string, protectedSegments, count};
			for (let rule of plugin.getProtectedWrapperRules()) {
				let cursor = 0;
				let nextString = "";
				while (cursor < string.length) {
					let startIndex = string.indexOf(rule.left, cursor);
					if (startIndex < 0) {
						nextString += string.slice(cursor);
						break;
					}
					let contentStart = startIndex + rule.left.length;
					let endIndex = string.indexOf(rule.right, contentStart);
					if (endIndex < 0) {
						nextString += string.slice(cursor);
						break;
					}
					let fullText = string.slice(startIndex, endIndex + rule.right.length);
					let innerText = string.slice(contentStart, endIndex);
					nextString += string.slice(cursor, startIndex);
					if (innerText.trim() && !/[\r\n]/.test(fullText)) {
						protectedSegments[count] = fullText;
						nextString += protectionLogic.createProtectionPlaceholder(plugin, count++);
					}
					else nextString += fullText;
					cursor = endIndex + rule.right.length;
				}
				string = nextString;
			}
			return {string, protectedSegments, count};
		},
		protectConfiguredTerms(plugin, string, protectedSegments = {}, count = 0) {
			let protectedTerms = protectionLogic.getProtectedTermsList(plugin);
			const boundaryChars = "A-Za-z0-9_";
			for (let term of protectedTerms) {
				term = (term || "").trim();
				if (!term) continue;
				const startsWithWord = new RegExp(`^[${boundaryChars}]`).test(term);
				const endsWithWord = new RegExp(`[${boundaryChars}]$`).test(term);
				const termPattern = term.split(/\s+/).filter(Boolean).map(part => protectionLogic.escapeRegExp(plugin, part)).join("\\s*");
				const regex = new RegExp(`${startsWithWord ? `(^|[^${boundaryChars}])` : `()`}(${termPattern})${endsWithWord ? `(?=$|[^${boundaryChars}])` : ""}`, "gi");
				string = string.replace(regex, (match, leading, protectedTerm) => {
					if (!protectedTerm) return match;
					protectedSegments[count] = protectedTerm;
					return `${leading || ""}${protectionLogic.createProtectionPlaceholder(plugin, count++)}`;
				});
			}
			return {string, protectedSegments, count};
		},
		protectAutoTechnicalTerms(plugin, string, protectedSegments = {}, count = 0) {
			if (!string) return {string, protectedSegments, count};
			const protectToken = (fullMatch, offset, fullString) => {
				if (!fullMatch || fullMatch.length < 2) return fullMatch;
				const left = fullString[offset - 1] || "";
				const right = fullString[offset + fullMatch.length] || "";
				if (/[A-Za-z0-9_]/.test(left) || /[A-Za-z0-9_]/.test(right)) return fullMatch;
				protectedSegments[count] = fullMatch;
				return protectionLogic.createProtectionPlaceholder(plugin, count++);
			};

			string = string.replace(/\b[A-Za-z0-9_.-]{2,}\/[A-Za-z0-9_.-]{2,}(?:\/[A-Za-z0-9_.-]+)*\b/g, protectToken);
			string = string.replace(/\b[A-Za-z0-9_.-]+\.(?:js|jsx|ts|tsx|json|yml|yaml|toml|env|py|java|go|rs|cpp|c|h|css|html|md|txt|zip|rar|7z|exe|dll|png|jpg|jpeg|webp|gif|mp4|mov|psd|fig)\b/gi, protectToken);
			string = string.replace(/\bv\d+(?:\.\d+){1,4}(?:[-+][A-Za-z0-9.-]+)?\b|\b\d+(?:\.\d+){2,4}(?:[-+][A-Za-z0-9.-]+)?\b/gi, protectToken);
			const originalForShoutCheck = String(string);
			const isAllCapsLatinShouting = (() => {
				const latinLetters = originalForShoutCheck.match(/[A-Za-z]/g) || [];
				if (latinLetters.length < 4) return false;
				const upperCount = latinLetters.reduce((n, c) => n + (c >= "A" && c <= "Z" ? 1 : 0), 0);
				if (upperCount / latinLetters.length < 0.8) return false;
				const nonLatin = (originalForShoutCheck.match(/[一-鿿぀-ヿ가-힯]/g) || []).length;
				return nonLatin * 2 < latinLetters.length;
			})();
			if (!isAllCapsLatinShouting) {
				string = string.replace(/\b[A-Z][A-Z0-9]{1,}(?:[-_/+.][A-Z0-9]+)*\b/g, protectToken);
			}
			string = string.replace(/\b[A-Za-z]+(?:[A-Z][a-z0-9]+){1,}[A-Za-z0-9]*\b/g, protectToken);
			string = string.replace(/\b[A-Za-z0-9]+(?:[_-][A-Za-z0-9]+){1,}\b/g, protectToken);
			return {string, protectedSegments, count};
		},
		protectMixedLanguageLatinTokens(_plugin, string, protectedSegments = {}, count = 0) {
			return {string, protectedSegments, count};
		},
		getUnicodeEmojiDetector() {
			try {return new RegExp("[\\u200D\\uFE0E\\uFE0F\\u20E3]|\\p{Extended_Pictographic}|\\p{Regional_Indicator}", "u");}
			catch (err) {return /[\u200D\uFE0E\uFE0F\u20E3\u2600-\u27BF]|[\uD83C-\uDBFF][\uDC00-\uDFFF]/;}
		},
		isUnicodeEmojiGrapheme(_plugin, segment) {
			if (!segment || typeof segment != "string") return false;
			if (/^(?:\d|#|\*)$/.test(segment)) return false;
			const detector = protectionLogic.getUnicodeEmojiDetector();
			return !!(detector && detector.test(segment));
		},
		getUnicodeEmojiRegex() {
			try {
				return new RegExp("(?:\\p{Regional_Indicator}{2}|[0-9#*]\\uFE0F?\\u20E3|\\p{Extended_Pictographic}(?:\\uFE0F|\\uFE0E)?(?:\\p{Emoji_Modifier})?(?:\\u200D\\p{Extended_Pictographic}(?:\\uFE0F|\\uFE0E)?(?:\\p{Emoji_Modifier})?)*)", "gu");
			}
			catch (err) {
				return /(?:[\u2600-\u27BF]\uFE0F?|[\uD83C-\uDBFF][\uDC00-\uDFFF](?:\uFE0F|\uFE0E)?(?:\u200D[\uD83C-\uDBFF][\uDC00-\uDFFF](?:\uFE0F|\uFE0E)?)*)/g;
			}
		},
		protectUnicodeEmojiSegments(plugin, string, protectedSegments = {}, count = 0) {
			if (!string) return {string, protectedSegments, count};
			if (typeof Intl != "undefined" && Intl.Segmenter) {
				const detector = protectionLogic.getUnicodeEmojiDetector();
				const segmenter = new Intl.Segmenter(undefined, {granularity: "grapheme"});
				let nextString = "";
				for (const part of segmenter.segment(string)) {
					const segment = part && part.segment || "";
					if (segment && detector && protectionLogic.isUnicodeEmojiGrapheme(plugin, segment)) {
						protectedSegments[count] = segment;
						nextString += protectionLogic.createProtectionPlaceholder(plugin, count++);
					}
					else nextString += segment;
				}
				return {string: nextString, protectedSegments, count};
			}
			return protectionLogic.protectRegexMatches(plugin, string, protectionLogic.getUnicodeEmojiRegex(), protectedSegments, count);
		},
		createProtectionPlaceholder(_plugin, count) {
			return `⟦${count}⟧`;
		},
		getProtectionPlaceholderRegex(_plugin, count) {
			return new RegExp(`(?:⟦\\s*(?:DTA\\s*)?${count}\\s*⟧|【\\s*${count}\\s*】|\\[\\s*${count}\\s*\\]|<\\s*<\\s*<\\s*${count}\\s*>\\s*>\\s*>|[｛\\{]\\s*[｛\\{]\\s*${count}\\s*[｝\\}]\\s*[｝\\}])`, "g");
		},
		formatProtectedExceptionForDisplay(_plugin, exception) {
			if (exception == null) return "";
			exception = String(exception);
			if (/^<a?:[A-Za-z0-9_~]+:\d+>$/.test(exception)) return exception;
			if (/^<@!?\d+>$/.test(exception)) return exception;
			if (/^<@&\d+>$/.test(exception)) return exception;
			if (/^<#\d+>$/.test(exception)) return exception;
			return exception;
		},
		hasAllProtectionPlaceholders(plugin, string, protectedSegments) {
			if (!protectedSegments || !Object.keys(protectedSegments).length) return true;
			return Object.keys(protectedSegments).every(count => protectionLogic.getProtectionPlaceholderRegex(plugin, count).test(string || ""));
		},
		addExceptions(plugin, string, protectedSegments) {
			for (let count in protectedSegments) {
				let exception = BDFDB.ArrayUtils.is(plugin.settings.exceptions.wordStart) && plugin.settings.exceptions.wordStart.some(n => String(protectedSegments[count]).indexOf(n) == 0) ? String(protectedSegments[count]).slice(1) : String(protectedSegments[count]);
				let replacement = protectionLogic.formatProtectedExceptionForDisplay(plugin, exception);
				let newString = string.replace(protectionLogic.getProtectionPlaceholderRegex(plugin, count), replacement);
				string = newString;
			}
			return string;
		},
		removeExceptions(plugin, string, place) {
			let protectedSegments = {}, newString = [], count = 0;
			let discordMarkupResult = protectionLogic.protectDiscordMarkupSegments(plugin, string, protectedSegments, count);
			string = discordMarkupResult.string;
			protectedSegments = discordMarkupResult.protectedSegments;
			count = discordMarkupResult.count;
			let codeBlockResult = protectionLogic.protectCodeBlockSegments(plugin, string, protectedSegments, count);
			string = codeBlockResult.string;
			protectedSegments = codeBlockResult.protectedSegments;
			count = codeBlockResult.count;
			let wrappedTextResult = protectionLogic.protectWrappedTextSegments(plugin, string, protectedSegments, count, place);
			string = wrappedTextResult.string;
			protectedSegments = wrappedTextResult.protectedSegments;
			count = wrappedTextResult.count;
			let autoProtectedResult = protectionLogic.protectAutoDetectedSegments(plugin, string, protectedSegments, count);
			string = autoProtectedResult.string;
			protectedSegments = autoProtectedResult.protectedSegments;
			count = autoProtectedResult.count;
			if (protectionLogic.shouldProtectConfiguredTermsForPlace(plugin, place)) {
				let protectedTermsResult = protectionLogic.protectConfiguredTerms(plugin, string, protectedSegments, count);
				string = protectedTermsResult.string;
				protectedSegments = protectedTermsResult.protectedSegments;
				count = protectedTermsResult.count;
			}
			let autoTechnicalTermsResult = protectionLogic.protectAutoTechnicalTerms(plugin, string, protectedSegments, count);
			string = autoTechnicalTermsResult.string;
			protectedSegments = autoTechnicalTermsResult.protectedSegments;
			count = autoTechnicalTermsResult.count;
			let emojiProtectedResult = protectionLogic.protectUnicodeEmojiSegments(plugin, string, protectedSegments, count);
			string = emojiProtectedResult.string;
			protectedSegments = emojiProtectedResult.protectedSegments;
			count = emojiProtectedResult.count;

			if (place == MESSAGE_PLACES.RECEIVED) {
				newString.push(string);
			}
			else {
				let usedExceptions = BDFDB.ArrayUtils.is(plugin.settings.exceptions.wordStart) ? plugin.settings.exceptions.wordStart : [];
				string.split(" ").forEach(word => {
					if (word.indexOf("<@!") == 0 || word.indexOf("<#") == 0 || word.indexOf(":") == 0 || word.indexOf("<:") == 0 || word.indexOf("<a:") == 0 || word.indexOf("@") == 0 || word.indexOf("#") == 0 || usedExceptions.some(n => word.indexOf(n) == 0 && word.length > 1)) {
						newString.push(protectionLogic.createProtectionPlaceholder(plugin, count));
						protectedSegments[count] = word;
						count++;
					}
					else newString.push(word);
				});
			}
			const maskedString = newString.join(place == MESSAGE_PLACES.RECEIVED ? "" : " ");
			const hasTranslatableContent = maskedString.replace(/(?:⟦\s*(?:DTA\s*)?\d+\s*⟧|【\s*\d+\s*】|\[\s*\d+\s*\]|<<<\s*\d+\s*>>>|\{\{\d+\}\})/g, "").trim().length > 0;
			return [maskedString, protectedSegments, hasTranslatableContent];
		}
	};

	return Object.freeze(protectionLogic);
}

module.exports = {
	MESSAGE_PLACES,
	TRANSLATION_PROTECTION_SIGNATURE_VERSION,
	createProtectionLogic
};
