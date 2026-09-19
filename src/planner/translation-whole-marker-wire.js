// W2b/W2c "D" wire: the P1-premasked message is sent once, translatable ranges are marked in
// place with short numeric open markers, and the model answers one marked line per range.
// Pure functions only: no provider, cache, display or runtime owner is referenced here. The
// only production importer is the W3 compile shadow (translation-whole-marker-shadow.js),
// which never sends what it compiles (see the W2 boundary tests).
//
// W2c contract (docs/ai-fast-translation-optimization-plan.zh-CN.md §10.2 "W2c 门槛修订"):
// open markers only, stray marker characters in the answer are stripped and counted, the
// context is windowed around the ranges when they cover little of a long message, and one
// repair request can be built for the ranges a first answer missed or got wrong.

const {isTranslatableOutputNode} = require("./translation-plan-serializer");

const WHOLE_MARKER_VERSION = "whole-marker-v2";
const WHOLE_MARKER_PROMPT_VERSION = "w3-whole-marker-prompt-v3";
const WHOLE_MARKER_VALIDATOR_VERSION = "w2c-whole-marker-validator-v2";
// W3 version closure: one label that changes whenever the wire grammar, the system prompt or
// the validator changes, so shadow records and a future cache revision cannot drift apart.
const WHOLE_MARKER_CONTRACT_REVISION = `${WHOLE_MARKER_VERSION}.prompt-v3.validator-v2`;
const DEFAULT_MAX_BODY_BYTES = 65536;
const DEFAULT_MAX_RESPONSE_BYTES = 65536;
const DEFAULT_MAX_SYSTEM_PROMPT_BYTES = 640;
const DEFAULT_MAX_ITEMS = 4096;
const MAX_TRAILING_CHARS = 3;
// Ruling 2: window the context when the ranges cover less than 40% of a message longer than
// 600 characters; a neighbour line is clipped so a single huge paragraph next to a short
// range does not travel whole.
const WINDOW_MIN_SOURCE_CHARS = 600;
const WINDOW_MAX_COVERAGE = 0.4;
const WINDOW_LINE_RADIUS = 1;
const WINDOW_NEIGHBOR_MAX_CHARS = 160;
const WINDOW_ELLIPSIS = "…";
const OPEN_RE = /⟪(\d+)⟫/g;
const CLOSE_ECHO_RE = /⟪\/\d*⟫/g;
const STRAY_MARKER_CHAR_RE = /[⟪⟫]/g;
const MARKER_CHAR_RE = /[⟪⟫]/;
const LOCAL_TOKEN_RE = /⟦(?:[CW])?\d+⟧/g;
const LOCAL_TOKEN_TEST_RE = /⟦(?:[CW])?\d+⟧/;
const NUMERIC_TOKEN_RE = /^⟦(\d+)⟧$/;
const LABEL_PREFIX_RE = /^(?:\s*(?:\d{1,3}|[A-Za-z])[.)]\s+)+/;
const SENTENCE_SPLIT_RE = /(?<=[.!?。！？])\s+(?=\S)/g;
const CJK_RE = /[\p{Script=Han}\p{Script=Bopomofo}]/u;
const LETTER_RE = /\p{L}/u;
const TRAILING_ALLOWED_RE = /^[\s\p{P}]*$/u;
const NEWLINE_RE = /\r\n|\r|\n/;
const LINE_SPLIT_RE = /\r\n|\r|\n/;
// W3: the compile shadow runs once per production message, so the hot loops below avoid
// per-character regex literals and whole-wire copies. Output is byte-identical to W2c.
const WHITESPACE_RE = /\s/;
const BLANK_RE = /[ \t]/;
const LINE_BREAK_RE = /[\r\n]/;
const OPEN_AT_RE = /⟪\d+⟫/y;
const PROTECTED_PATTERN_CACHE = new Map();
const PROTECTED_PATTERN_CACHE_LIMIT = 512;

// Every reason the parser can emit; the diagnostics layer keeps this list finite.
const WHOLE_MARKER_REASONS = Object.freeze([
	"invalid-request", "unexpected-root", "response-budget", "markdown-fence", "marker-schema",
	"unknown-marker", "duplicate-marker", "missing-marker", "item-count", "marker-order",
	"unsafe-structure", "empty", "placeholder-mismatch", "wrong-language", "too-similar"
]);
// Failures a single repair request may address: the envelope was sound, only ranges are
// missing or their translations failed the per-range judge.
const REPAIRABLE_REASONS = Object.freeze(["missing-marker", "item-count", "empty", "placeholder-mismatch", "wrong-language", "too-similar"]);

function utf8(value) {return Buffer.byteLength(String(value == null ? "" : value));}
function frozenArray(values) {return Object.freeze(Array.from(values || []));}
function freezeRows(values) {return frozenArray((values || []).map(value => Object.freeze(Object.assign({}, value))));}
function integer(value, fallback) {const number = Number(value); return Number.isInteger(number) ? number : fallback;}
function finiteNumber(value, fallback) {const number = Number(value); return Number.isFinite(number) ? number : fallback;}
function failure(reason, extra = {}) {return Object.freeze(Object.assign({ok: false, reason: String(reason || "invalid")}, extra));}
function openMarker(ordinal) {return `⟪${ordinal}⟫`;}
function escapeRegExp(value) {return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");}
function codePoints(value) {
	const text = String(value == null ? "" : value);
	let count = 0;
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code >= 0xD800 && code <= 0xDBFF && index + 1 < text.length) {const next = text.charCodeAt(index + 1); if (next >= 0xDC00 && next <= 0xDFFF) index++;}
		count++;
	}
	return count;
}

function protectedValuePattern(term) {
	const cached = PROTECTED_PATTERN_CACHE.get(term);
	if (cached) return cached;
	const word = "A-Za-z0-9_", startsWord = /^[A-Za-z0-9_]/.test(term), endsWord = /[A-Za-z0-9_]$/.test(term);
	const pattern = term.split(/\s+/).filter(Boolean).map(escapeRegExp).join("\\s*");
	const regex = new RegExp(`${startsWord ? `(^|[^${word}])` : ""}${pattern}${endsWord ? `(?=$|[^${word}])` : ""}`, "i");
	if (PROTECTED_PATTERN_CACHE.size >= PROTECTED_PATTERN_CACHE_LIMIT) PROTECTED_PATTERN_CACHE.delete(PROTECTED_PATTERN_CACHE.keys().next().value);
	PROTECTED_PATTERN_CACHE.set(term, regex);
	return regex;
}

function protectedValueAppears(haystack, protectedValue) {
	const term = String(protectedValue == null ? "" : protectedValue);
	if (!term) return false;
	return protectedValuePattern(term).test(String(haystack || ""));
}

function isNumericPlaceholder(raw, protectedSegments) {
	const match = NUMERIC_TOKEN_RE.exec(String(raw || ""));
	return !!match && Object.prototype.hasOwnProperty.call(protectedSegments || {}, match[1]);
}

function lineKind(syntaxText) {
	const text = String(syntaxText || "").replace(/^[\r\n]+/, "");
	if (/^#{1,6}/.test(text)) return "heading";
	if (/^>/.test(text)) return "quote";
	if (/^(?:[-*+]|\d+[.)])/.test(text)) return "list";
	if (/^\|/.test(text)) return "table";
	return "plain";
}

// Nodes become "pieces": protected text leaves that are not P1 placeholders leave the
// machine only as ⟦Cn⟧ tokens (same rule as the W1 safe context), everything else as-is.
function buildPieces(plan, protectedSegments) {
	const source = String(plan.source == null ? "" : plan.source);
	const pieces = [], contextMarkers = [];
	let cursor = 0, contextIndex = 0;
	for (const node of plan.nodes) {
		if (!node || typeof node !== "object") return failure("invalid-plan");
		const start = integer(node.sourceStart, -1), end = integer(node.sourceEnd, -1), raw = String(node.raw == null ? "" : node.raw);
		if (start !== cursor || end < start || end > source.length || source.slice(start, end) !== raw) return failure("invalid-plan");
		cursor = end;
		const protectedLeaf = node.kind === "text" && node.classification === "protected" && !isNumericPlaceholder(raw, protectedSegments);
		if (!protectedLeaf && (MARKER_CHAR_RE.test(raw) || LOCAL_TOKEN_TEST_RE.test(raw) && !isNumericPlaceholder(raw, protectedSegments))) return failure("marker-collision");
		let safeText = raw;
		if (protectedLeaf) {
			if (!raw) continue;
			const token = `⟦C${contextIndex++}⟧`;
			contextMarkers.push({token, raw, stableId: String(node.id || "")});
			safeText = token;
		}
		pieces.push({
			node,
			raw,
			safeText,
			sourceStart: start,
			sourceEnd: end,
			hasNewline: NEWLINE_RE.test(raw),
			member: node.kind === "text" && ["translate", "uncertain", "protected"].includes(node.classification) && !NEWLINE_RE.test(raw),
			preserveTarget: node.kind === "text" && node.classification === "preserve-target",
			translatable: isTranslatableOutputNode(node)
		});
	}
	if (cursor !== source.length) return failure("invalid-plan");
	return {ok: true, source, pieces, contextMarkers};
}

// A run is a maximal sequence of member pieces on one line; syntax, Chinese text and line
// breaks are boundaries. Only runs with natural language become ranges.
function collectRuns(pieces) {
	const runs = [], cjkLines = new Set();
	let current = null, linePrefix = "", lineIndex = 0, seenText = false;
	const flush = () => {if (current && current.pieces.some(piece => piece.translatable)) runs.push(current); current = null;};
	for (const piece of pieces) {
		if (piece.hasNewline) {
			flush();
			lineIndex++;
			linePrefix = piece.raw;
			seenText = false;
			continue;
		}
		if (piece.preserveTarget && CJK_RE.test(piece.raw)) cjkLines.add(lineIndex);
		if (!piece.member) {
			flush();
			// Syntax before the first text of a line (##, -, >, |, A.) decides the line kind.
			if (!seenText) linePrefix += piece.raw;
			continue;
		}
		seenText = true;
		if (!current) current = {pieces: [], kind: lineKind(linePrefix), lineIndex};
		current.pieces.push(piece);
	}
	flush();
	return runs.map(run => ({pieces: run.pieces, kind: run.kind, lineIndex: run.lineIndex, lineHasCjk: cjkLines.has(run.lineIndex)}));
}

function runText(run) {return run.pieces.map(piece => piece.safeText).join("");}

// Map an offset inside the run's safe text back onto the plan source. Tokens replace whole
// pieces, so offsets that land inside plain text map one-to-one.
function sourceOffsetAt(run, safeOffset) {
	let consumed = 0;
	for (const piece of run.pieces) {
		const length = piece.safeText.length;
		if (safeOffset <= consumed + length) {
			if (piece.safeText === piece.raw) return piece.sourceStart + (safeOffset - consumed);
			return safeOffset === consumed ? piece.sourceStart : piece.sourceEnd;
		}
		consumed += length;
	}
	const last = run.pieces[run.pieces.length - 1];
	return last ? last.sourceEnd : 0;
}

function hasLanguage(text) {return LETTER_RE.test(String(text || "").replace(LOCAL_TOKEN_RE, ""));}

function splitSentences(text) {
	const parts = [];
	let cursor = 0;
	for (const match of String(text).matchAll(SENTENCE_SPLIT_RE)) {
		parts.push({start: cursor, end: match.index});
		cursor = match.index + match[0].length;
	}
	parts.push({start: cursor, end: text.length});
	const merged = [];
	for (const part of parts) {
		const value = text.slice(part.start, part.end);
		if (!hasLanguage(value) && merged.length) merged[merged.length - 1].end = part.end;
		else merged.push(Object.assign({}, part));
	}
	return merged.filter(part => hasLanguage(text.slice(part.start, part.end)));
}

function buildRanges(runs, options) {
	const ranges = [];
	for (const run of runs) {
		const text = runText(run);
		const label = LABEL_PREFIX_RE.exec(text);
		let start = label ? label[0].length : 0;
		while (start < text.length && WHITESPACE_RE.test(text[start])) start++;
		let end = text.length;
		while (end > start && WHITESPACE_RE.test(text[end - 1])) end--;
		if (end <= start) continue;
		const body = text.slice(start, end);
		if (!hasLanguage(body)) continue;
		const parts = run.lineHasCjk && options.sentenceSplit !== false ? splitSentences(body) : [{start: 0, end: body.length}];
		for (const part of parts) {
			let partStart = start + part.start, partEnd = start + part.end;
			while (partStart < partEnd && WHITESPACE_RE.test(text[partStart])) partStart++;
			while (partEnd > partStart && WHITESPACE_RE.test(text[partEnd - 1])) partEnd--;
			const value = text.slice(partStart, partEnd);
			if (!hasLanguage(value)) continue;
			ranges.push({
				ordinal: ranges.length + 1,
				text: value,
				tokens: frozenArray([...value.matchAll(LOCAL_TOKEN_RE)].map(match => match[0])),
				sourceStart: sourceOffsetAt(run, partStart),
				sourceEnd: sourceOffsetAt(run, partEnd),
				kind: run.kind,
				lineIndex: run.lineIndex,
				hasCjk: CJK_RE.test(value),
				run,
				safeStart: partStart,
				safeEnd: partEnd
			});
		}
	}
	return ranges;
}

function pieceAt(run, safeOffset, isStart) {
	let consumed = 0;
	for (let index = 0; index < run.pieces.length; index++) {
		const piece = run.pieces[index], length = piece.safeText.length;
		if (isStart ? safeOffset < consumed + length : safeOffset <= consumed + length && safeOffset > consumed) return {piece, offset: safeOffset - consumed};
		if (!isStart && safeOffset === consumed && index === 0) return {piece, offset: 0};
		consumed += length;
	}
	const last = run.pieces[run.pieces.length - 1];
	return {piece: last, offset: last.safeText.length};
}

// Open markers only. Without a close marker a range runs to the next marker or to the end
// of its line, so when unmarked text follows a range on the same line a line break is
// inserted after the range; reassembly works on source offsets and never sees it.
function renderWire(pieces, ranges, markedOrdinals) {
	const startsByPiece = new Map(), endsByPiece = new Map();
	for (const range of ranges) {
		if (!markedOrdinals.has(range.ordinal)) continue;
		const startPiece = pieceAt(range.run, range.safeStart, true), endPiece = pieceAt(range.run, range.safeEnd, false);
		(startsByPiece.get(startPiece.piece) || startsByPiece.set(startPiece.piece, []).get(startPiece.piece)).push({offset: startPiece.offset, ordinal: range.ordinal});
		(endsByPiece.get(endPiece.piece) || endsByPiece.set(endPiece.piece, []).get(endPiece.piece)).push({offset: endPiece.offset, ordinal: range.ordinal});
	}
	let wire = "";
	const rangeEnds = [];
	for (const piece of pieces) {
		const inserts = [];
		for (const row of startsByPiece.get(piece) || []) inserts.push({offset: row.offset, text: openMarker(row.ordinal), order: 1});
		for (const row of endsByPiece.get(piece) || []) inserts.push({offset: row.offset, text: "", order: 0, end: true});
		inserts.sort((left, right) => left.offset - right.offset || left.order - right.order);
		let cursor = 0, rendered = "";
		for (const insert of inserts) {
			rendered += piece.safeText.slice(cursor, insert.offset);
			if (insert.end) rangeEnds.push(wire.length + rendered.length);
			rendered += insert.text;
			cursor = insert.offset;
		}
		wire += rendered + piece.safeText.slice(cursor);
	}
	// Ranges are non-empty and never adjacent across whitespace only, so a probe from one range
	// end can never reach another range end; deciding every break on the unbroken wire and
	// splicing once is the same as splicing back to front.
	const breakAt = [];
	for (const end of rangeEnds.sort((left, right) => left - right)) {
		let probe = end;
		while (probe < wire.length && BLANK_RE.test(wire[probe])) probe++;
		if (probe >= wire.length || LINE_BREAK_RE.test(wire[probe])) continue;
		OPEN_AT_RE.lastIndex = probe;
		if (OPEN_AT_RE.test(wire)) continue;
		breakAt.push(end);
	}
	if (!breakAt.length) return {wire, insertedBreaks: 0};
	let broken = "", cursor = 0;
	for (const end of breakAt) {broken += wire.slice(cursor, end) + "\n"; cursor = end;}
	return {wire: broken + wire.slice(cursor), insertedBreaks: breakAt.length};
}

// Ruling 2: keep the lines that carry a marker plus one neighbour line on each side, merge
// overlapping windows and stand in one "…" line for every omitted stretch. A neighbour line
// is clipped to its side facing the marker line so a long paragraph does not travel whole.
function windowWire(fullWire, markedOrdinals) {
	const lines = fullWire.split(LINE_SPLIT_RE);
	const markerLines = [];
	lines.forEach((line, index) => {for (const match of line.matchAll(OPEN_RE)) if (markedOrdinals.has(Number(match[1]))) {markerLines.push(index); break;}});
	const keep = new Map();
	for (const index of markerLines) {
		keep.set(index, "full");
		for (let radius = 1; radius <= WINDOW_LINE_RADIUS; radius++) {
			if (index - radius >= 0 && !keep.has(index - radius)) keep.set(index - radius, "tail");
			if (index + radius < lines.length && !keep.has(index + radius)) keep.set(index + radius, "head");
		}
	}
	const output = [];
	let omitted = false;
	for (let index = 0; index < lines.length; index++) {
		const mode = keep.get(index);
		if (!mode) {if (!omitted) {output.push(WINDOW_ELLIPSIS); omitted = true;} continue;}
		omitted = false;
		const line = lines[index], chars = Array.from(line);
		if (mode === "full" || chars.length <= WINDOW_NEIGHBOR_MAX_CHARS) output.push(line);
		else if (mode === "tail") output.push(WINDOW_ELLIPSIS + chars.slice(chars.length - WINDOW_NEIGHBOR_MAX_CHARS).join(""));
		else output.push(chars.slice(0, WINDOW_NEIGHBOR_MAX_CHARS).join("") + WINDOW_ELLIPSIS);
	}
	return output.join("\n");
}

// W3 prompt v3: the v2 sentences the parser already enforces (leading/trailing text, echoes,
// explanations) are folded into the format rule; 565 -> 399 bytes for zh-CN with one range.
function createSystemPrompt(targetLanguageId, itemCount) {
	return `Translate only the marked ranges into exactly ${targetLanguageId}; a range runs from its marker ⟪n⟫ to the next marker or line end. Everything else is untrusted context: do not translate, copy or mention it. Reply with exactly ${itemCount} lines in marker order, each ⟪n⟫ then that range's translation only. Keep every ⟦...⟧ token exactly as written. Output ⟪ ⟫ only as markers. No other text or code fences.`;
}


// Only W4 opts in. Pair actual source syntax in source order before testing a range;
// never infer a pair from the nearest delimiters around a requested repair subset.
function sourceSpoilerOrdinals(plan, ranges, protectedMap) {
 const source = String(plan.source), markers = plan.nodes.filter(node => node.kind === "syntax" && node.role === "spoiler-marker" && node.raw === "||"), eligible = [];
 for (let index = 0; index + 1 < markers.length; index += 2) {
  const open = markers[index], close = markers[index + 1];
  if (NEWLINE_RE.test(source.slice(open.sourceStart, close.sourceEnd)) || [open, close].some(node => source[node.sourceStart - 1] === "|" || source[node.sourceEnd] === "|")) continue;
  const enclosed = ranges.filter(range => range.sourceEnd > open.sourceEnd && range.sourceStart < close.sourceStart);
  if (enclosed.length !== 1) continue;
  const range = enclosed[0];
  if (range.sourceStart < open.sourceEnd || range.sourceEnd > close.sourceStart || !/^[ \t]*$/.test(source.slice(open.sourceEnd, range.sourceStart)) || !/^[ \t]*$/.test(source.slice(range.sourceEnd, close.sourceStart))) continue;
  const unsafeNode = plan.nodes.some(node => {
   if (node.sourceEnd <= open.sourceEnd || node.sourceStart >= close.sourceStart) return false;
   if (node.kind === "syntax" || /code|escaped/.test(node.role || "")) return true;
   const token = NUMERIC_TOKEN_RE.exec(node.raw), original = token ? String(protectedMap[token[1]] || "") : "";
   return node.role === "placeholder" && ([92, 96].includes(original.charCodeAt(0)) || NEWLINE_RE.test(original));
  });
  if (!unsafeNode) eligible.push(range.ordinal);
 }
 return eligible;
}

// Consume just one source-owned wrapper around one marked translation. Keep the
// original raw byte budget and the ordinary marker/token judges outside this helper.
function normalizeSourceSpoilerEcho(source, ordinals) {
 const allowed = new Set(ordinals), lines = source.split(NEWLINE_RE);
 for (let index = 0; index < lines.length; index++) {
  const inline = lines[index].match(/^([ \t]*⟪(\d+)⟫[ \t]*)\|\|([^\r\n]*?)\|\|([ \t]*)$/);
  if (inline && allowed.has(Number(inline[2])) && !inline[3].includes("||") && !/⟪\d+⟫/.test(inline[3])) {lines[index] = inline[1] + inline[3] + inline[4]; continue;}
  const externalInline = lines[index].match(/^([ \t]*)\|\|([ \t]*⟪(\d+)⟫)([^\r\n]*?)\|\|([ \t]*)$/);
  if (externalInline && allowed.has(Number(externalInline[3])) && !externalInline[4].includes("||") && !/⟪\d+⟫/.test(externalInline[4])) {lines[index] = externalInline[1] + externalInline[2] + externalInline[4] + externalInline[5]; continue;}
  const external = lines[index].match(/^([ \t]*)\|\|([ \t]*⟪(\d+)⟫[^\r\n]*)$/);
  if (external && allowed.has(Number(external[3])) && !external[2].includes("||") && (external[2].match(/⟪\d+⟫/g) || []).length === 1 && /^[ \t]*\|\|[ \t]*$/.test(lines[index + 1] || "")) {lines[index] = external[1] + external[2]; lines[++index] = "";}
 }
 const normalized = lines.join("\n");
 return {source: normalized, unsafe: normalized.includes("||")};
}

function compileWholeMarker(plan, protectedMap, options, markedOrdinals, repairOf) {
	const built = buildPieces(plan, protectedMap);
	if (!built.ok) return built;
	const allRanges = buildRanges(collectRuns(built.pieces), options);
	if (!allRanges.length) return failure("no-segments", {sourceBytes: utf8(built.source)});
	const marked = markedOrdinals ? allRanges.filter(range => markedOrdinals.has(range.ordinal)) : allRanges;
	if (!marked.length) return failure("no-segments", {sourceBytes: utf8(built.source)});
	const markedSet = new Set(marked.map(range => range.ordinal));
	const spoilerOrdinals = options.allowSourceSpoilerEcho === true ? sourceSpoilerOrdinals(plan, allRanges, protectedMap) : [];
	const sourceSpoilerContract = spoilerOrdinals.length > 0;
	const maxItems = integer(options.maxItems, DEFAULT_MAX_ITEMS);
	if (marked.length > maxItems) return failure("item-budget", {itemCount: marked.length, maxItems});
	const rendered = renderWire(built.pieces, allRanges, markedSet);
	const sourceChars = codePoints(built.source), fullWireChars = codePoints(rendered.wire);
	const translateChars = marked.reduce((total, range) => total + codePoints(range.text), 0);
	const coverage = sourceChars > 0 ? translateChars / sourceChars : 1;
	const windowed = typeof options.forceWindowed === "boolean" ? options.forceWindowed : sourceChars > WINDOW_MIN_SOURCE_CHARS && coverage < WINDOW_MAX_COVERAGE;
	const wire = windowed ? windowWire(rendered.wire, markedSet) : rendered.wire;
	const bodyBytes = utf8(wire), maxBodyBytes = integer(options.maxBodyBytes, DEFAULT_MAX_BODY_BYTES);
	if (bodyBytes > maxBodyBytes) return failure("body-budget", {bodyBytes, maxBodyBytes});
	const protectedValues = [...Object.values(protectedMap).map(String), ...built.contextMarkers.map(row => row.raw)].filter(Boolean);
	const leaked = protectedValues.filter(value => protectedValueAppears(wire, value));
	if (leaked.length) return failure("protected-leak", {bodyBytes, protectedLeakCount: leaked.length});
	const targetLanguageId = String(options.targetLanguageId || plan.targetLanguageId || "zh-CN");
	const systemPrompt = createSystemPrompt(targetLanguageId, marked.length), systemPromptBytes = utf8(systemPrompt);
	if (systemPromptBytes > integer(options.maxSystemPromptBytes, DEFAULT_MAX_SYSTEM_PROMPT_BYTES)) return failure("system-prompt-budget", {systemPromptBytes});
	const translateBytes = marked.reduce((total, range) => total + utf8(range.text), 0);
	const markerBytes = marked.reduce((total, range) => total + utf8(openMarker(range.ordinal)), 0);
	const contextChars = codePoints(wire);
	const estimatedInputTokens = Math.ceil((systemPromptBytes + bodyBytes) / 4);
	// zh-CN output is roughly one token per 1.5 source characters plus a marker line each.
	const estimatedOutputTokens = Math.ceil(translateChars * 0.7) + marked.length * 5;
	const publicRanges = freezeRows(marked.map(range => ({ordinal: range.ordinal, text: range.text, tokens: range.tokens, sourceStart: range.sourceStart, sourceEnd: range.sourceEnd, kind: range.kind, lineIndex: range.lineIndex, hasCjk: range.hasCjk})));
	return Object.freeze({
		ok: true,
		reason: null,
		enabled: true,
		adapter: WHOLE_MARKER_VERSION,
		wireFamily: "whole-marker",
		wireVersion: WHOLE_MARKER_VERSION,
		responseMode: "line-marker",
		wire,
		bodyBytes,
		wireBytes: bodyBytes,
		metadataBytes: markerBytes,
		systemPrompt,
		systemPromptBytes,
		userPrompt: wire,
		sourceBytes: utf8(built.source),
		sourceChars,
		translateBytes,
		translateChars,
		translateCoverage: coverage,
		windowed,
		contextChars,
		fullWireChars,
		contextCoverage: fullWireChars > 0 ? contextChars / fullWireChars : 1,
		insertedBreaks: rendered.insertedBreaks,
		segmentCount: marked.length,
		totalRangeCount: allRanges.length,
		ranges: publicRanges,
		contextMarkers: freezeRows(built.contextMarkers),
		protectedSegments: Object.freeze(Object.assign({}, protectedMap)),
		targetLanguageId,
		estimatedInputTokens,
		estimatedOutputTokens,
		maxResponseBytes: integer(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES),
		plan,
		compileOptions: Object.freeze(Object.assign({}, options)),
		repairOf: repairOf ? Object.freeze({ordinals: frozenArray(repairOf)}) : null,
		promptVersion: WHOLE_MARKER_PROMPT_VERSION,
		validatorVersion: sourceSpoilerContract ? "w4-whole-marker-spoiler-validator-v1" : WHOLE_MARKER_VALIDATOR_VERSION,
		contractRevision: WHOLE_MARKER_CONTRACT_REVISION + (sourceSpoilerContract ? ".source-spoiler-v1" : ""),
		...(sourceSpoilerContract ? {sourceSpoilerEchoOrdinals: frozenArray(spoilerOrdinals.filter(ordinal => markedSet.has(ordinal)))} : {})
	});
}

function buildWholeMarkerRequest(plan, protectedSegments = {}, options = {}) {
	if (!plan || typeof plan !== "object" || !Array.isArray(plan.nodes)) return failure("invalid-plan");
	const protectedMap = protectedSegments && typeof protectedSegments === "object" ? protectedSegments : {};
	return compileWholeMarker(plan, protectedMap, options || {}, null, null);
}

// Ruling 3: one repair request for the ranges a first answer missed or got wrong. Same plan,
// same contract, same window mode; only the given ordinals are marked, the rest is context.
function buildWholeMarkerRepairRequest(request, ordinals) {
	if (!request || request.adapter !== WHOLE_MARKER_VERSION || !request.plan) return failure("invalid-request");
	const wanted = [...new Set((ordinals || []).map(Number).filter(Number.isInteger))].sort((left, right) => left - right);
	const known = new Set(request.ranges.map(range => range.ordinal));
	if (!wanted.length || wanted.some(ordinal => !known.has(ordinal))) return failure("invalid-request");
	const options = Object.assign({}, request.compileOptions || {}, {forceWindowed: request.windowed === true});
	return compileWholeMarker(request.plan, request.protectedSegments || {}, options, new Set(wanted), wanted);
}

function blankStructure(expected) {
	return {expectedItemCount: expected, receivedItemCount: 0, missingMarkerIndices: [], duplicateMarkerIndices: [], unknownMarkerCount: 0, wrappedInCodeFence: false, leadingChars: 0, trailingChars: 0, outsideMarkerChars: 0, orderPreserved: true, closeMarkerEchoes: 0, strayMarkerChars: 0, responseChars: 0, responseHasCjk: false};
}

// Block texts ride along as a non-enumerable property: the diagnostics layer measures
// their length and script, while JSON exports and spreads never see them.
function withTranslations(result, blocks) {
	const translations = {};
	for (const [ordinal, text] of blocks || []) translations[ordinal] = text;
	Object.defineProperty(result, "translations", {value: Object.freeze(translations), enumerable: false});
	return Object.freeze(result);
}

function freezeStructure(structure) {
	return Object.freeze(Object.assign({}, structure, {missingMarkerIndices: frozenArray(structure.missingMarkerIndices), duplicateMarkerIndices: frozenArray(structure.duplicateMarkerIndices)}));
}

function rootFailure(request, reason, structure, extra = {}, blocks = null) {
	const ranges = request && Array.isArray(request.ranges) ? request.ranges : [];
	return withTranslations(Object.assign({ok: false, reason: String(reason || "invalid")}, {
		rootMalformed: true,
		repairable: false,
		repairOrdinals: frozenArray([]),
		rows: frozenArray([]),
		valid: Object.freeze({}),
		invalid: freezeRows(ranges.map(range => ({ordinal: range.ordinal, reason}))),
		structure: freezeStructure(structure)
	}, extra), blocks);
}

function judgeRange(range, translation, options) {
	const likelyTarget = typeof options.likelyTarget === "function" ? options.likelyTarget : () => true;
	const similarity = typeof options.similarity === "function" ? options.similarity : () => 0;
	const maxSimilarity = finiteNumber(options.maxSimilarity, 0.94);
	if (!translation.trim()) return "empty";
	const seen = [...translation.matchAll(LOCAL_TOKEN_RE)].map(match => match[0]);
	const expected = range.tokens.slice().sort(), actual = seen.slice().sort();
	if (expected.length !== actual.length || expected.some((token, index) => token !== actual[index])) return "placeholder-mismatch";
	const language = translation.replace(LOCAL_TOKEN_RE, "");
	if (!likelyTarget(language)) return "wrong-language";
	if (similarity(range.text, translation) >= maxSimilarity) return "too-similar";
	return null;
}

// Fail-closed reader for the D reply. It scans the whole reply before deciding so the
// structure fields describe every defect, not just the first one the strict rules hit.
// Close-marker echoes and stray marker characters are model noise: stripped and counted.
function parseWholeMarkerResponse(request, raw, options = {}) {
	if (!request || request.adapter !== WHOLE_MARKER_VERSION || !Array.isArray(request.ranges)) return rootFailure(request, "invalid-request", blankStructure(0));
	const expected = request.ranges.length, structure = blankStructure(expected);
	const expectedOrdinals = new Set(request.ranges.map(range => range.ordinal));
	if (typeof raw !== "string") return rootFailure(request, "unexpected-root", structure);
	const responseBytes = utf8(raw), maxResponseBytes = integer(options.maxResponseBytes, request.maxResponseBytes || DEFAULT_MAX_RESPONSE_BYTES);
	structure.responseChars = codePoints(raw);
	structure.responseHasCjk = CJK_RE.test(raw);
	if (responseBytes > maxResponseBytes) return rootFailure(request, "response-budget", structure, {responseBytes, maxResponseBytes});
	let source = raw.replace(/^\uFEFF/, "");
	const sourceSpoilerContract = Array.isArray(request.sourceSpoilerEchoOrdinals);
	if (sourceSpoilerContract) {
		const normalized = normalizeSourceSpoilerEcho(source, request.sourceSpoilerEchoOrdinals);
		if (normalized.unsafe) return rootFailure(request, "unsafe-structure", structure);
		source = normalized.source;
	}
	let echoes = 0;
	source = source.replace(CLOSE_ECHO_RE, () => {echoes++; return "";});
	source = source.trim();
	if (/^```/.test(source) || /```$/.test(source)) {
		structure.wrappedInCodeFence = true;
		structure.closeMarkerEchoes = echoes;
		return rootFailure(request, "markdown-fence", structure);
	}
	const matches = [...source.matchAll(new RegExp(OPEN_RE.source, "g"))];
	structure.leadingChars = matches.length ? codePoints(source.slice(0, matches[0].index)) : codePoints(source);
	structure.closeMarkerEchoes = echoes;
	if (!matches.length || source.slice(0, matches[0].index).trim()) return rootFailure(request, "marker-schema", structure);
	const blocks = new Map(), sequence = [];
	let unknown = 0, outsideChars = 0, trailingChars = 0, stray = 0;
	const duplicates = new Set();
	for (let index = 0; index < matches.length; index++) {
		const ordinal = Number(matches[index][1]);
		const start = matches[index].index + matches[index][0].length, end = index + 1 < matches.length ? matches[index + 1].index : source.length;
		const block = source.slice(start, end);
		if (!Number.isInteger(ordinal) || !expectedOrdinals.has(ordinal)) {unknown++; continue;}
		const lines = block.split(NEWLINE_RE);
		let translation = lines[0];
		translation = translation.replace(STRAY_MARKER_CHAR_RE, () => {stray++; return "";}).replace(/\s+$/, "");
		const remainder = lines.slice(1).join("\n");
		const isLast = index === matches.length - 1;
		if (isLast) {
			const tail = remainder.trim();
			trailingChars = codePoints(tail);
			if (tail && !(TRAILING_ALLOWED_RE.test(tail) && trailingChars <= MAX_TRAILING_CHARS)) outsideChars += trailingChars;
		}
		else if (remainder.trim()) outsideChars += codePoints(remainder.trim());
		if (blocks.has(ordinal)) {duplicates.add(ordinal); continue;}
		blocks.set(ordinal, translation);
		sequence.push(ordinal);
	}
	structure.receivedItemCount = blocks.size;
	structure.unknownMarkerCount = unknown;
	structure.duplicateMarkerIndices = [...duplicates].sort((a, b) => a - b);
	structure.missingMarkerIndices = request.ranges.map(range => range.ordinal).filter(ordinal => !blocks.has(ordinal));
	structure.orderPreserved = sequence.every((value, index) => index === 0 || sequence[index - 1] < value);
	structure.outsideMarkerChars = outsideChars;
	structure.trailingChars = trailingChars;
	structure.strayMarkerChars = stray;
	if (unknown) return rootFailure(request, "unknown-marker", structure, {}, blocks);
	if (duplicates.size) return rootFailure(request, "duplicate-marker", structure, {}, blocks);
	if (!structure.orderPreserved) return rootFailure(request, "marker-order", structure, {}, blocks);
	if (outsideChars > 0) return rootFailure(request, "unsafe-structure", structure, {}, blocks);
	const valid = {}, invalid = [], rows = [];
	for (const range of request.ranges) {
		if (!blocks.has(range.ordinal)) {invalid.push({ordinal: range.ordinal, reason: "missing-marker"}); continue;}
		const translation = blocks.get(range.ordinal);
		if (sourceSpoilerContract && (translation.includes("||") || request.sourceSpoilerEchoOrdinals.includes(range.ordinal) && (translation.trim().startsWith("|") || translation.trim().endsWith("|")))) return rootFailure(request, "unsafe-structure", structure, {}, blocks);
		const reason = judgeRange(range, translation, options);
		if (reason) invalid.push({ordinal: range.ordinal, reason});
		else {valid[range.ordinal] = translation; rows.push({ordinal: range.ordinal, translation});}
	}
	const reason = invalid.length ? invalid.find(row => row.reason === "missing-marker") ? "missing-marker" : invalid[0].reason : null;
	return withTranslations({
		ok: invalid.length === 0,
		reason,
		rootMalformed: false,
		repairable: invalid.length > 0 && invalid.every(row => REPAIRABLE_REASONS.includes(row.reason)),
		repairOrdinals: frozenArray(invalid.map(row => row.ordinal)),
		rows: freezeRows(rows),
		valid: Object.freeze(valid),
		invalid: freezeRows(invalid),
		structure: freezeStructure(structure),
		responseBytes
	}, blocks);
}

// Merges the answer to a repair request over the first answer. The repair may only fill the
// ordinals it was built for; every other range keeps the first answer's verdict.
function mergeWholeMarkerRepair(request, first, repairRequest, repair) {
	if (!request || !first || !repairRequest || !repair) return failure("invalid-request");
	const allowed = new Set((repairRequest.repairOf && repairRequest.repairOf.ordinals) || []);
	const valid = Object.assign({}, first.valid || {});
	if (!repair.rootMalformed) for (const [ordinal, translation] of Object.entries(repair.valid || {})) if (allowed.has(Number(ordinal))) valid[ordinal] = translation;
	const invalid = [];
	for (const range of request.ranges) {
		if (Object.prototype.hasOwnProperty.call(valid, range.ordinal)) continue;
		const fromRepair = !repair.rootMalformed ? (repair.invalid || []).find(row => row.ordinal === range.ordinal) : null;
		const fromFirst = (first.invalid || []).find(row => row.ordinal === range.ordinal);
		invalid.push({ordinal: range.ordinal, reason: repair.rootMalformed && allowed.has(range.ordinal) ? repair.reason : fromRepair ? fromRepair.reason : fromFirst ? fromFirst.reason : "missing-marker"});
	}
	return Object.freeze({
		ok: invalid.length === 0,
		reason: invalid.length ? invalid[0].reason : null,
		repairRootMalformed: repair.rootMalformed === true,
		valid: Object.freeze(valid),
		invalid: freezeRows(invalid),
		repairedOrdinals: frozenArray([...allowed].filter(ordinal => Object.prototype.hasOwnProperty.call(repair.valid || {}, ordinal)))
	});
}

function restoreContextTokens(value, contextMarkers) {
	let result = String(value == null ? "" : value);
	for (const row of contextMarkers || []) if (result.includes(row.token)) result = result.split(row.token).join(String(row.raw));
	return result;
}

// Splices each translation back over its source span. P1 placeholders stay as ⟦N⟧ so the
// caller restores them with the same protection logic every other arm uses.
function reassembleWholeMarkerResponse(request, valid = {}) {
	if (!request || request.adapter !== WHOLE_MARKER_VERSION || !request.plan) return "";
	const source = String(request.plan.source == null ? "" : request.plan.source);
	let output = "", cursor = 0;
	for (const range of request.ranges) {
		if (!Object.prototype.hasOwnProperty.call(valid, range.ordinal)) continue;
		output += source.slice(cursor, range.sourceStart) + restoreContextTokens(valid[range.ordinal], request.contextMarkers);
		cursor = range.sourceEnd;
	}
	output += source.slice(cursor);
	return restoreContextTokens(output, request.contextMarkers);
}

module.exports = {
	WHOLE_MARKER_VERSION,
	WHOLE_MARKER_PROMPT_VERSION,
	WHOLE_MARKER_VALIDATOR_VERSION,
	WHOLE_MARKER_CONTRACT_REVISION,
	WHOLE_MARKER_MAX_BODY_BYTES: DEFAULT_MAX_BODY_BYTES,
	WHOLE_MARKER_REASONS,
	REPAIRABLE_REASONS,
	MAX_TRAILING_CHARS,
	WINDOW_MIN_SOURCE_CHARS,
	WINDOW_MAX_COVERAGE,
	WINDOW_NEIGHBOR_MAX_CHARS,
	buildWholeMarkerRequest,
	buildWholeMarkerRepairRequest,
	parseWholeMarkerResponse,
	mergeWholeMarkerRepair,
	reassembleWholeMarkerResponse
};
