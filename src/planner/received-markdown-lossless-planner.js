const PLANNER_VERSION = "m3i-v2";
const MAX_SOURCE_LENGTH = 200000;
const MAX_NODE_COUNT = 4096;
const CLASSIFICATIONS = new Set(["translate", "preserve-target", "protected", "uncertain"]);
const LETTER_RE = /\p{L}/u;
const PICTOGRAPH_RE = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
const FENCE_LINE_RE = /^( {0,3})(`{3,}|~{3,})[^\r\n]*$/;
const HEADING_MARKER_RE = /^( {0,3})(#{1,6})(?=[ \t]|$)/;
const LIST_MARKER_RE = /^(\s*)(?:[-+*]|\d+[.)])(?=[ \t])/;
const BLOCKQUOTE_MARKER_RE = /^( {0,3})>(?=[ \t]|$)/;
const HEADING_CONTEXT_RE = /^ {0,3}(#{1,6})[ \t]+/;
const LIST_CONTEXT_RE = /^(\s*)(?:[-+*]|\d+[.)])[ \t]+/;
const HIGH_CONFIDENCE_TECHNICAL_RE = /^(?:Windows[ \t]+\d+(?:\.\d+)*|HTTP[ \t]+\d{3}|(?:API|URL|URI|UUID|JSON|XML|HTML|CSS|SQL|SDK|CLI|ID))(?![\p{L}\p{N}_-])/u;
const PLACEHOLDER_RE = /^⟦(?:DTA)?\d+⟧/;
const FIELD_DIVIDER = "__________________ __________________ __________________";
const FIELD_VALUE_DIVIDER = "__________________";

function textHash(value) {const text = String(value || ""); let hash = 2166136261; for (let index = 0; index < text.length; index++) {hash ^= text.charCodeAt(index); hash = Math.imul(hash, 16777619);} return (hash >>> 0).toString(16).padStart(8, "0");}
function stablePart(value) {return encodeURIComponent(String(value == null ? "" : value)).replace(/%/g, "~");}
function lineEnd(source, start) {const index = source.indexOf("\n", start); return index < 0 ? source.length : index > start && source[index - 1] === "\r" ? index - 1 : index;}
function afterLineEnding(source, end) {if (source.slice(end, end + 2) === "\r\n") return end + 2; return /[\r\n]/.test(source[end] || "") ? end + 1 : end;}
function isLineStart(source, index) {return index === 0 || source[index - 1] === "\n" || source[index - 1] === "\r";}

function targetScriptRegex(languageId) {
	const id = String(languageId || "").toLowerCase();
	if (id.startsWith("zh")) return /[\p{Script=Han}\p{Script=Bopomofo}]/u;
	if (id === "ja" || id.startsWith("ja-")) return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
	if (id === "ko" || id.startsWith("ko-")) return /[\p{Script=Hangul}\p{Script=Han}]/u;
	if (/^(?:ru|uk|bg|be|mk|sr)/.test(id)) return /\p{Script=Cyrillic}/u;
	if (/^(?:ar|fa|ur)/.test(id)) return /\p{Script=Arabic}/u;
	if (/^(?:he|iw)/.test(id)) return /\p{Script=Hebrew}/u;
	if (/^(?:en|fr|de|es|pt|it|nl|pl|cs|sk|sl|hr|ro|sv|no|da|fi|tr|id|ms|vi)/.test(id)) return /\p{Script=Latin}/u;
	return null;
}

function targetScriptKind(languageId) {
	const id = String(languageId || "").toLowerCase();
	if (id.startsWith("zh")) return "han";
	if (id === "ja" || id.startsWith("ja-")) return "japanese";
	if (id === "ko" || id.startsWith("ko-")) return "korean";
	if (/^(?:ru|uk|bg|be|mk|sr)/.test(id)) return "cyrillic";
	if (/^(?:ar|fa|ur)/.test(id)) return "arabic";
	if (/^(?:he|iw)/.test(id)) return "hebrew";
	if (/^(?:en|fr|de|es|pt|it|nl|pl|cs|sk|sl|hr|ro|sv|no|da|fi|tr|id|ms|vi)/.test(id)) return "latin";
	return "unknown";
}

function classifyCharacter(character, targetKind, targetRegex) {
	const code = character.codePointAt(0); let script = null;
	if (code >= 65 && code <= 90 || code >= 97 && code <= 122 || code >= 0x00C0 && code <= 0x024F) script = "latin";
	else if (code >= 0x3400 && code <= 0x9FFF || code >= 0xF900 && code <= 0xFAFF) script = "han";
	else if (code >= 0x3040 && code <= 0x30FF) script = "japanese";
	else if (code >= 0xAC00 && code <= 0xD7AF) script = "korean";
	else if (code >= 0x0400 && code <= 0x052F) script = "cyrillic";
	else if (code >= 0x0590 && code <= 0x05FF) script = "hebrew";
	else if (code >= 0x0600 && code <= 0x08FF) script = "arabic";
	else if (!LETTER_RE.test(character)) return null;
	if (script) {const target = script === targetKind || script === "han" && (targetKind === "japanese" || targetKind === "korean"); return target ? "preserve-target" : "translate";}
	return targetRegex && targetRegex.test(character) ? "preserve-target" : "translate";
}

function emojiEnd(source, start) {
	const first = String.fromCodePoint(source.codePointAt(start)), isEmoji = PICTOGRAPH_RE.test(first);
	if (!isEmoji) return start;
	let end = start + first.length, joinNext = false;
	while (end < source.length) {
		const codePoint = source.codePointAt(end), character = String.fromCodePoint(codePoint);
		if (codePoint === 0xFE0E || codePoint === 0xFE0F || codePoint === 0x20E3 || codePoint >= 0x1F3FB && codePoint <= 0x1F3FF) {end += character.length; continue;}
		if (codePoint === 0x200D) {joinNext = true; end += 1; continue;}
		if (joinNext && PICTOGRAPH_RE.test(character)) {joinNext = false; end += character.length; continue;}
		if (/\p{Regional_Indicator}/u.test(first) && /\p{Regional_Indicator}/u.test(character) && end === start + first.length) {end += character.length;}
		break;
	}
	return end;
}
function mayStartEmoji(source, index) {const code = source.codePointAt(index); return code >= 0x2600 && code <= 0x27BF || code >= 0xD800;}
function startsUrl(source, index) {return source.startsWith("http://", index) || source.startsWith("https://", index);}

function findLink(source, start, limit) {
	let bracketDepth = 1, cursor = start + 1, closeLabel = -1;
	for (; cursor < limit; cursor++) {
		if (source[cursor] === "\\") {cursor++; continue;}
		if (source[cursor] === "\n" || source[cursor] === "\r") return null;
		if (source[cursor] === "[") bracketDepth++;
		else if (source[cursor] === "]" && --bracketDepth === 0) {closeLabel = cursor; break;}
	}
	if (closeLabel < 0 || source[closeLabel + 1] !== "(") return null;
	let parenDepth = 1, closeDestination = -1;
	for (cursor = closeLabel + 2; cursor < limit; cursor++) {
		if (source[cursor] === "\\") {cursor++; continue;}
		if (source[cursor] === "\n" || source[cursor] === "\r") return null;
		if (source[cursor] === "(") parenDepth++;
		else if (source[cursor] === ")" && --parenDepth === 0) {closeDestination = cursor; break;}
	}
	return closeDestination < 0 ? null : {labelStart: start + 1, labelEnd: closeLabel, destinationStart: closeLabel + 2, destinationEnd: closeDestination, end: closeDestination + 1};
}

function planReceivedMarkdown(input, options = {}) {
	const source = String(input == null ? "" : input), direction = String(options.direction || "received"), fieldPath = String(options.fieldPath || "body"), targetLanguageId = String(options.targetLanguageId || "zh-CN"), targetKind = targetScriptKind(targetLanguageId), targetRegex = targetScriptRegex(targetLanguageId), identityPrefix = `${PLANNER_VERSION}|${stablePart(direction)}|${stablePart(fieldPath)}|`, segmentPrefix = identityPrefix, contextPrefix = `ctx|${identityPrefix}`, nodes = [];
	let stopped = false;
	const emit = (start, end, kind, classification, role) => {
		if (stopped || end <= start) return;
		if (nodes.length >= MAX_NODE_COUNT - 1 && end < source.length) {end = source.length; kind = "text"; classification = "uncertain"; role = "overflow"; stopped = true;}
		const raw = source.slice(start, end), hash = textHash(raw), node = {id: `${segmentPrefix}${start}:${end}|${hash}`, kind, classification: CLASSIFICATIONS.has(classification) ? classification : "uncertain", role, sourceStart: start, sourceEnd: end, raw, textHash: hash, contextIds: []};
		nodes.push(node);
	};
	const emitClassified = (start, end, role = "text") => {
		// A Markdown list marker has already been emitted when this branch sees the
		// human-facing option label ("A. "). Keep that label in the lossless skeleton
		// so classic MT receives "GED" rather than "D. GED" (the latter is commonly
		// mistaken for an identifier and returned unchanged).
		const lineStart = Math.max(source.lastIndexOf("\n", start - 1), source.lastIndexOf("\r", start - 1)) + 1, before = source.slice(lineStart, start), listMarker = source.slice(lineStart, end).match(LIST_MARKER_RE), optionLabel = listMarker && listMarker.index === 0 && /^[ \t]*$/.test(before.slice(listMarker[0].length)) ? source.slice(start, end).match(/^[ \t]*[A-Za-z][.)][ \t]+/) : null;
		if (optionLabel && optionLabel[0]) {emit(start, start + optionLabel[0].length, "syntax", "protected", "option-label"); start += optionLabel[0].length; if (start >= end) return;}
		let runStart = start, runClass = null, cursor = start;
		const flush = at => {if (at > runStart) emit(runStart, at, "text", runClass || "uncertain", role); runStart = at;};
		while (cursor < end && !stopped) {
			const character = String.fromCodePoint(source.codePointAt(cursor)), category = classifyCharacter(character, targetKind, targetRegex);
			if (category && runClass && category !== runClass) {flush(cursor); runClass = category;}
			else if (category && !runClass) runClass = category;
			cursor += character.length;
		}
		flush(end);
	};
	const scan = (start, end, textRole = "text") => {
		let cursor = start;
		while (cursor < end && !stopped) {
			if (nodes.length >= MAX_NODE_COUNT - 1) {emit(cursor, source.length, "text", "uncertain", "overflow"); break;}
			if (isLineStart(source, cursor)) {
				const endOfLine = lineEnd(source, cursor), line = source.slice(cursor, endOfLine), fence = line.match(FENCE_LINE_RE);
				if (fence) {
					emit(cursor, endOfLine, "syntax", "protected", "fence-open"); const contentStart = afterLineEnding(source, endOfLine); if (contentStart > endOfLine) emit(endOfLine, contentStart, "syntax", "protected", "line-ending");
					let seek = contentStart, closeStart = -1, closeEnd = -1; const marker = fence[2];
					while (seek < end) {const candidateEnd = lineEnd(source, seek), candidate = source.slice(seek, candidateEnd); if (new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \\t]*$`).test(candidate)) {closeStart = seek; closeEnd = candidateEnd; break;} seek = afterLineEnding(source, candidateEnd); if (seek <= candidateEnd) break;}
					if (closeStart < 0) {emit(contentStart, end, "text", "protected", "fenced-code-content"); cursor = end; continue;}
					emit(contentStart, closeStart, "text", "protected", "fenced-code-content"); emit(closeStart, closeEnd, "syntax", "protected", "fence-close"); cursor = afterLineEnding(source, closeEnd); if (cursor > closeEnd) emit(closeEnd, cursor, "syntax", "protected", "line-ending"); continue;
				}
				const marker = line.match(HEADING_MARKER_RE) || line.match(LIST_MARKER_RE) || line.match(BLOCKQUOTE_MARKER_RE);
				if (marker && marker[0]) {const role = marker[0].includes("#") ? "heading-marker" : marker[0].includes(">") ? "blockquote-marker" : "list-marker"; emit(cursor, cursor + marker[0].length, "syntax", "protected", role); cursor += marker[0].length; continue;}
			}
			const newline = source.slice(cursor, cursor + 2) === "\r\n" ? 2 : /[\r\n]/.test(source[cursor]) ? 1 : 0;
			if (newline) {let next = cursor + newline; while (next < end) {const size = source.slice(next, next + 2) === "\r\n" ? 2 : /[\r\n]/.test(source[next]) ? 1 : 0; if (!size) break; next += size;} let role = "line-ending"; if (next < end) {const following = source.slice(next, lineEnd(source, next)), marker = following.match(HEADING_MARKER_RE) || following.match(LIST_MARKER_RE) || following.match(BLOCKQUOTE_MARKER_RE); if (marker && marker[0] && !FENCE_LINE_RE.test(following)) {role = marker[0].includes("#") ? "heading-marker" : marker[0].includes(">") ? "blockquote-marker" : "list-marker"; next += marker[0].length;}} emit(cursor, next, "syntax", "protected", role); cursor = next; continue;}
			if (source.startsWith("“4-3”", cursor)) {emit(cursor, cursor + 5, "text", "protected", "protected-literal"); cursor += 5; continue;}
			if (source.startsWith(FIELD_DIVIDER, cursor)) {emit(cursor, cursor + FIELD_DIVIDER.length, "text", "protected", "field-divider"); cursor += FIELD_DIVIDER.length; continue;}
			if (source.startsWith(FIELD_VALUE_DIVIDER, cursor)) {emit(cursor, cursor + FIELD_VALUE_DIVIDER.length, "text", "protected", "field-value-divider"); cursor += FIELD_VALUE_DIVIDER.length; continue;}
			const placeholder = source.slice(cursor, end).match(PLACEHOLDER_RE); if (placeholder) {emit(cursor, cursor + placeholder[0].length, "text", "protected", "placeholder"); cursor += placeholder[0].length; continue;}
			const technical = source.slice(cursor, end).match(HIGH_CONFIDENCE_TECHNICAL_RE); if (technical) {emit(cursor, cursor + technical[0].length, "text", "protected", "high-confidence-technical"); cursor += technical[0].length; continue;}
			if (source[cursor] === "\\" && cursor + 1 < end) {const escapedEnd = cursor + 1 + String.fromCodePoint(source.codePointAt(cursor + 1)).length; emit(cursor, escapedEnd, "text", "protected", "escaped-literal"); cursor = escapedEnd; continue;}
			if (source[cursor] === "[") {const link = findLink(source, cursor, end); if (link) {emit(cursor, cursor + 1, "syntax", "protected", "link-open"); scan(link.labelStart, link.labelEnd, "link-label"); emit(link.labelEnd, link.destinationStart, "syntax", "protected", "link-middle"); emit(link.destinationStart, link.destinationEnd, "text", "protected", "link-destination"); emit(link.destinationEnd, link.end, "syntax", "protected", "link-close"); cursor = link.end; continue;}}
			if (source[cursor] === "`") {let length = 1; while (source[cursor + length] === "`") length++; const marker = "`".repeat(length), close = source.indexOf(marker, cursor + length); const inlineEnd = close >= 0 && close < end ? close + length : end; emit(cursor, inlineEnd, "text", "protected", close >= 0 ? "inline-code" : "unclosed-inline-code"); cursor = inlineEnd; continue;}
			if (source[cursor] === "<") {const close = source.indexOf(">", cursor + 1); if (close >= 0 && close < end) {const token = source.slice(cursor, close + 1); if (/^<(?:@!?\d+|@&\d+|#\d+|a?:[A-Za-z0-9_~]+:\d+|t:\d+(?::[tTdDfFR])?|https?:\/\/[^>]+)>$/.test(token)) {emit(cursor, close + 1, "text", "protected", /^<https?:/.test(token) ? "url" : "discord-token"); cursor = close + 1; continue;}}}
			const url = source.slice(cursor, end).match(/^https?:\/\/[^\s<>()]+/i); if (url) {emit(cursor, cursor + url[0].length, "text", "protected", "url"); cursor += url[0].length; continue;}
			const emoji = emojiEnd(source, cursor); if (emoji > cursor) {emit(cursor, emoji, "text", "protected", "emoji"); cursor = emoji; continue;}
			const syntax = source.startsWith("||", cursor) ? [2, "spoiler-marker"] : source.startsWith("~~", cursor) ? [2, "strikethrough-marker"] : source.startsWith("**", cursor) || source.startsWith("__", cursor) ? [2, "emphasis-marker"] : source[cursor] === "|" ? [1, "table-marker"] : /[*_]/.test(source[cursor]) ? [1, "emphasis-marker"] : null;
			if (syntax) {emit(cursor, cursor + syntax[0], "syntax", "protected", syntax[1]); cursor += syntax[0]; continue;}
			let next = cursor + String.fromCodePoint(source.codePointAt(cursor)).length;
			while (next < end && !/[\r\n\\\[\]`<|*_]/.test(source[next]) && !source.startsWith("~~", next) && !source.startsWith("“4-3”", next) && !source.startsWith(FIELD_DIVIDER, next) && !source.startsWith(FIELD_VALUE_DIVIDER, next) && !PLACEHOLDER_RE.test(source.slice(next, end)) && !HIGH_CONFIDENCE_TECHNICAL_RE.test(source.slice(next, end)) && !startsUrl(source, next)) {if (mayStartEmoji(source, next) && emojiEnd(source, next) > next) break; next += String.fromCodePoint(source.codePointAt(next)).length;}
			emitClassified(cursor, next, textRole); cursor = next;
		}
	};
	if (source.length > MAX_SOURCE_LENGTH) emit(0, source.length, "text", "uncertain", "oversized-document"); else scan(0, source.length);

	const contexts = [], contextByLineStart = new Map(), lines = []; let cursor = 0;
	while (cursor < source.length) {const end = lineEnd(source, cursor), next = afterLineEnding(source, end); lines.push({start: cursor, end, next, text: source.slice(cursor, end)}); if (next <= end) break; cursor = next;}
	let currentParent = null, previousByKey = new Map();
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index], heading = line.text.match(HEADING_CONTEXT_RE), list = line.text.match(LIST_CONTEXT_RE), nextList = lines[index + 1] && LIST_CONTEXT_RE.test(lines[index + 1].text), trimmed = line.text.trim(), shortTitle = !heading && !list && trimmed && trimmed.length <= 40 && nextList;
		if (!heading && !list && !shortTitle) continue;
		const type = heading ? "heading" : list ? "list-item" : "short-title", id = `${contextPrefix}${type}|${line.start}:${line.end}`, context = {id, type, sourceStart: line.start, sourceEnd: line.end, readOnly: true, output: false, coverage: false, parentId: null, previousSiblingId: null, nextSiblingId: null};
		if (heading || shortTitle) {currentParent = id; previousByKey = new Map();}
		else {context.parentId = currentParent; const key = `${currentParent || "root"}:${list[1].length}`, previous = previousByKey.get(key); if (previous) {context.previousSiblingId = previous.id; previous.nextSiblingId = id;} previousByKey.set(key, context);}
		contexts.push(context); contextByLineStart.set(line.start, context);
	}
	let lineIndex = 0;
	for (const node of nodes) {while (lineIndex + 1 < lines.length && node.sourceStart >= lines[lineIndex].next) lineIndex++; const context = contextByLineStart.get(lines[lineIndex] && lines[lineIndex].start); if (context && node.sourceStart >= context.sourceStart && node.sourceEnd <= context.sourceEnd) {node.contextIds.push(context.id); if (context.parentId) node.contextIds.push(context.parentId);}}
	return {plannerVersion: PLANNER_VERSION, direction, fieldPath, targetLanguageId, coordinateUnit: "utf-16-code-unit", normalization: "preserve", lineEndings: "preserve", source, sourceLength: source.length, sourceHash: textHash(source), nodes, contexts, limits: {maxSourceLength: MAX_SOURCE_LENGTH, maxNodeCount: MAX_NODE_COUNT}, diagnostics: {recordedPayloads: 0, emittedLogs: 0}};
}

function reassembleReceivedMarkdown(plan, replacements = {}) {
	if (!plan || !Array.isArray(plan.nodes)) return "";
	return plan.nodes.map(node => {
		if (!Object.prototype.hasOwnProperty.call(replacements || {}, node.id) || node.classification !== "translate" && node.classification !== "uncertain") return node.raw;
		let translated = String(replacements[node.id]);
		// Source-owned horizontal gaps can share a text leaf with prose (e.g. "##" + " Title").
		// Inline ranges already move plain edge gaps into protected nodes; wireText excludes
		// whitespace inside local protected leaves, which must not be added a second time.
		const source = typeof node.wireText === "string" ? node.wireText : String(node.raw || "");
		const leading = (source.match(/^[ \t]+/) || [""])[0], trailing = (source.match(/[ \t]+$/) || [""])[0];
		if (leading) {const supplied = (translated.match(/^[ \t]*/) || [""])[0]; if (!supplied.startsWith(leading)) translated = leading + supplied.slice(leading.length) + translated.slice(supplied.length);}
		if (trailing) {const supplied = (translated.match(/[ \t]*$/) || [""])[0]; if (!supplied.endsWith(trailing)) translated = translated.slice(0, translated.length - supplied.length) + supplied.slice(0, Math.max(0, supplied.length - trailing.length)) + trailing;}
		return translated;
	}).join("");
}

function validateReceivedMarkdownPlan(plan) {
	const errors = []; if (!plan || typeof plan !== "object") return Object.freeze({valid: false, errors: Object.freeze(["invalid_plan"]), coveredCodeUnits: 0});
	const source = String(plan.source == null ? "" : plan.source), ids = new Set(); let cursor = 0;
	for (const node of plan.nodes || []) {
		if (!node || node.sourceStart !== cursor) errors.push("coverage_gap_or_overlap");
		if (!node || node.sourceEnd < node.sourceStart || node.sourceEnd > source.length) errors.push("span_out_of_bounds");
		if (node && source.slice(node.sourceStart, node.sourceEnd) !== node.raw) errors.push("raw_span_mismatch");
		if (node && node.textHash !== textHash(node.raw)) errors.push("text_hash_mismatch");
		if (node && !String(node.id).includes(`${node.sourceStart}:${node.sourceEnd}|`)) errors.push("id_missing_span");
		if (node && ids.has(node.id)) errors.push("duplicate_id"); else if (node) ids.add(node.id);
		if (node) cursor = node.sourceEnd;
	}
	if (cursor !== source.length) errors.push("coverage_incomplete");
	if (plan.sourceLength !== source.length || plan.sourceHash !== textHash(source)) errors.push("source_identity_mismatch");
	if ((plan.contexts || []).some(context => context.coverage !== false || context.output !== false || context.readOnly !== true)) errors.push("context_contract");
	return Object.freeze({valid: errors.length === 0, errors: Object.freeze([...new Set(errors)]), coveredCodeUnits: cursor, nodeCount: (plan.nodes || []).length, contextCount: (plan.contexts || []).length});
}

module.exports = {PLANNER_VERSION, MAX_SOURCE_LENGTH, MAX_NODE_COUNT, planReceivedMarkdown, reassembleReceivedMarkdown, validateReceivedMarkdownPlan, hashReceivedMarkdownSource: textHash};
