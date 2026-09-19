// Sentence-level ranges around inline protected nodes and formatting for the typed wire.
//
// The lossless planner splits a line such as "Please ask ⟦8⟧ to review ⟦3⟧ before Friday."
// into five nodes and the serializer sends the three text fragments as separate segments.
// Models then move the meaning of a tail fragment into its neighbour and the punctuation
// left behind fails the target-language check. This module merges such a run back into one
// translatable segment, keeps every protected node inside it, and sends non-placeholder
// protected leaves as local ⟦Cn⟧ tokens that are restored before reassembly. Paired
// ⟦Fn⟧...⟦/Fn⟧ boundaries keep emphasis and link labels in that same sentence; their
// original delimiters and link destinations are restored locally, after validation.
//
// Source note: the range and token rules follow the W2b diagnostics arm D whole-marker
// wire module (branch perf/w2b-whole-marker-wire, commit c31d36a: buildRanges / judgeRange /
// ⟦Cn⟧ local leaves / token-multiset conservation). They are re-implemented here for the
// production contract: only runs that contain a protected leaf or formatting merge, tokens are
// numbered per segment, and nothing from the diagnostics tree or the arm D module is
// imported. Plans without such runs come out byte-identical.

const {hashReceivedMarkdownSource} = require("./received-markdown-lossless-planner");
const {isTranslatableOutputNode} = require("./translation-plan-serializer");

const INLINE_RANGES_VERSION = "inline-ranges-v2";
const INLINE_RANGE_ROLE = "inline-range";
const INLINE_RANGE_GAP_ROLE = "inline-range-gap";
const INLINE_TOKEN_RE = /⟦(?:DTA)?\d+⟧|⟦C\d+⟧|⟦\/?F\d+⟧/g;
const INLINE_FORMAT_ROLES = new Set(["emphasis-marker", "spoiler-marker", "strikethrough-marker", "link-open", "link-middle", "link-close", "link-end"]);
const P1_PLACEHOLDER_RE = /^⟦(?:DTA)?\d+⟧$/;
const LOOKALIKE_RE = /⟦[^⟧\r\n]{0,16}⟧/;
const LABEL_PREFIX_RE = /^(?:[ \t]*(?:\d{1,3}|[A-Za-z])[.)][ \t]+)+/;
const SENTENCE_SPLIT_RE = /(?<=[.!?。！？])[ \t]+(?=\S)/g;
const LETTER_RE = /\p{L}/u;
const NEWLINE_RE = /[\r\n]/;
const MEMBER_CLASSIFICATIONS = new Set(["translate", "uncertain", "protected"]);
// Embed layouts glue field names and values with divider runs on one line; those are
// structure between separate fields, so they end a run like a line ending does.
const RUN_BREAK_ROLES = new Set(["field-divider", "field-value-divider"]);

function inlineTokens(text) {return [...String(text == null ? "" : text).matchAll(INLINE_TOKEN_RE)].map(match => match[0]);}
function stripInlineTokens(text) {return String(text == null ? "" : text).replace(INLINE_TOKEN_RE, "");}
function isInlineFormat(node) {return !!node && node.kind === "syntax" && INLINE_FORMAT_ROLES.has(node.role);}
function isProtectedLeaf(node) {return !!node && (node.kind === "text" || isInlineFormat(node)) && node.classification === "protected" && node.role !== INLINE_RANGE_GAP_ROLE;}
function isP1Placeholder(node) {return isProtectedLeaf(node) && (node.role === "placeholder" || P1_PLACEHOLDER_RE.test(String(node.raw || "")));}
function isMember(node) {return !!node && (node.kind === "text" || isInlineFormat(node)) && MEMBER_CLASSIFICATIONS.has(node.classification) && !RUN_BREAK_ROLES.has(node.role) && !NEWLINE_RE.test(String(node.raw || ""));}
function unionContexts(nodes) {const seen = new Set(), output = []; for (const node of nodes) for (const id of node.contextIds || []) if (!seen.has(id)) {seen.add(id); output.push(id);} return output;}

// Node ids keep the planner's `${prefix}${start}:${end}|${hash}` shape so the lossless plan
// validator and every id-keyed consumer treat merged ranges like planner nodes.
function identityPrefix(node) {
	const suffix = `${node.sourceStart}:${node.sourceEnd}|${node.textHash}`;
	const id = String(node.id || "");
	return id.endsWith(suffix) ? id.slice(0, id.length - suffix.length) : null;
}

function createNode(prefix, source, start, end, kind, classification, role, contextIds, extra = null) {
	const raw = source.slice(start, end), hash = hashReceivedMarkdownSource(raw);
	return Object.assign({id: `${prefix}${start}:${end}|${hash}`, kind, classification, role, sourceStart: start, sourceEnd: end, raw, textHash: hash, contextIds: contextIds.slice()}, extra || {});
}

function collectRuns(nodes, inlineFormatting) {
	const runs = [], preserveLines = new Set();
	let current = null, lineIndex = 0;
	const flush = () => {if (current) runs.push(current); current = null;};
	for (let index = 0; index < nodes.length; index++) {
		const node = nodes[index];
		if (NEWLINE_RE.test(String(node && node.raw || ""))) {flush(); lineIndex++; continue;}
		if (node && node.kind === "text" && node.classification === "preserve-target" && LETTER_RE.test(String(node.raw || ""))) preserveLines.add(lineIndex);
		if (!isMember(node) || !inlineFormatting && isInlineFormat(node)) {flush(); continue;}
		if (!current) current = {startIndex: index, nodes: [], lineIndex};
		current.nodes.push(node);
	}
	flush();
	return runs.map(run => Object.assign(run, {lineHasPreserve: preserveLines.has(run.lineIndex)}));
}

function qualifies(run) {
	const hasLeaf = run.nodes.some(isProtectedLeaf), hasTranslatable = run.nodes.some(isTranslatableOutputNode);
	if (!hasLeaf || !hasTranslatable) return false;
	return !run.nodes.some(node => !isProtectedLeaf(node) && LOOKALIKE_RE.test(String(node.raw || "")));
}

// Offsets are run-relative; because the run's raws are contiguous source slices, a
// run-relative offset plus the run start is the source offset.
function pieceBoundaries(run) {
	const pieces = [];
	let offset = 0;
	for (let index = 0; index < run.nodes.length; index++) {
		let node = run.nodes[index];
		if (node.role === "link-middle") {
			const destination = run.nodes[index + 1], closeIndex = index + (destination && destination.role === "link-destination" ? 2 : 1), close = run.nodes[closeIndex];
			if (!close || close.role !== "link-close") return null;
			// The whole ](destination) suffix stays local as the closing boundary.
			node = Object.assign({}, node, {raw: run.nodes.slice(index, closeIndex + 1).map(part => part.raw).join(""), role: "link-end"});
			index = closeIndex;
		}
		const previous = pieces[pieces.length - 1];
		// Collect a contiguous delimiter run first. Pairing below can consume a
		// closing *** as * then ** when the source nests italic inside bold.
		if (isInlineFormat(node) && node.role === "emphasis-marker" && previous && previous.node.role === node.role && previous.node.raw[0] === node.raw[0]) {
			previous.node = Object.assign({}, previous.node, {raw: previous.node.raw + node.raw});
			previous.end += node.raw.length;
		}
		else pieces.push({node, start: offset, end: offset + node.raw.length, leaf: isProtectedLeaf(node)});
		offset += node.raw.length;
	}
	const stack = [], paired = []; let formatId = 0;
	const pair = piece => {
		paired.push(piece);
		if (!isInlineFormat(piece.node)) return true;
		const openingLink = piece.node.role === "link-open", closingLink = piece.node.role === "link-end";
		if (piece.node.role === "link-close") return false;
		const raw = openingLink || closingLink ? "link" : piece.node.raw, top = stack[stack.length - 1];
		if (!openingLink && top && top.raw === raw) {
			piece.format = {id: top.id, closing: true};
			top.piece.formatEnd = piece.start;
			stack.pop();
		}
		else {
			if (closingLink || !openingLink && stack.some(entry => entry.raw === raw)) return false;
			piece.format = {id: formatId, closing: false};
			stack.push({raw, id: formatId++, piece});
		}
		return true;
	};
	for (const piece of pieces) {
		if (piece.node.role !== "emphasis-marker") {if (!pair(piece)) return null; continue;}
		const raw = piece.node.raw;
		if (raw.length > 3) return null; // Ambiguous delimiter runs keep the lossless plan.
		for (let consumed = 0; consumed < raw.length;) {
			const top = stack[stack.length - 1], remaining = raw.length - consumed;
			const width = top && top.raw[0] === raw[0] && top.raw.length <= remaining ? top.raw.length : Math.min(2, remaining);
			const part = Object.assign({}, piece, {node: Object.assign({}, piece.node, {raw: raw.slice(consumed, consumed + width)}), start: piece.start + consumed, end: piece.start + consumed + width});
			if (!pair(part)) return null;
			consumed += width;
		}
	}
	if (stack.length) return null;
	return paired;
}

function insideLeaf(pieces, offset) {return pieces.some(piece => piece.leaf && offset > piece.start && offset < piece.end);}
function charInLeaf(pieces, offset) {return pieces.some(piece => piece.leaf && offset >= piece.start && offset < piece.end);}
function insideFormat(pieces, offset) {return pieces.some(piece => piece.format && !piece.format.closing && offset >= piece.end && offset <= piece.formatEnd);}

// Letters inside a protected leaf travel as a token, so only the plain pieces decide whether
// a span still carries language once it is on the wire.
function wireHasLanguage(text, pieces, start, end) {
	for (const piece of pieces) {
		if (piece.leaf) continue;
		const from = Math.max(piece.start, start), to = Math.min(piece.end, end);
		if (to > from && LETTER_RE.test(text.slice(from, to).replace(INLINE_TOKEN_RE, ""))) return true;
	}
	return false;
}

function leadingPlainLength(pieces) {let length = 0; for (const piece of pieces) {if (piece.leaf) break; length = piece.end;} return length;}
function trailingPlainStart(pieces) {let start = pieces.length ? pieces[pieces.length - 1].end : 0; for (let index = pieces.length - 1; index >= 0; index--) {if (pieces[index].leaf) break; start = pieces[index].start;} return start;}

function splitParts(text, bodyStart, bodyEnd, pieces, sentenceSplit) {
	const body = text.slice(bodyStart, bodyEnd), cuts = [];
	if (sentenceSplit) for (const match of body.matchAll(SENTENCE_SPLIT_RE)) {
		const cutStart = bodyStart + match.index, cutEnd = cutStart + match[0].length;
		if (!insideLeaf(pieces, cutStart) && !insideLeaf(pieces, cutEnd) && !insideFormat(pieces, cutStart) && !insideFormat(pieces, cutEnd)) cuts.push({start: cutStart, end: cutEnd});
	}
	const parts = [];
	let cursor = bodyStart;
	for (const cut of cuts) {parts.push({start: cursor, end: cut.start}); cursor = cut.end;}
	parts.push({start: cursor, end: bodyEnd});
	// A sentence made only of leaves and punctuation has nothing to translate; it stays a gap.
	return parts.filter(part => part.end > part.start && wireHasLanguage(text, pieces, part.start, part.end));
}

function buildWireText(text, pieces, start, end) {
	let wire = "", tokenIndex = 0;
	const inlineProtected = [], formatIds = new Map();
	for (const piece of pieces) {
		const from = Math.max(piece.start, start), to = Math.min(piece.end, end);
		if (to <= from) continue;
		if (piece.leaf && !isP1Placeholder(piece.node)) {
			let token;
			if (piece.format) {
				if (!formatIds.has(piece.format.id)) formatIds.set(piece.format.id, formatIds.size);
				token = `⟦${piece.format.closing ? "/" : ""}F${formatIds.get(piece.format.id)}⟧`;
			}
			else token = `⟦C${tokenIndex++}⟧`;
			inlineProtected.push({token, raw: piece.node.raw, role: String(piece.node.role || "")});
			wire += token;
		}
		else wire += text.slice(from, to);
	}
	return {wire, inlineProtected};
}

function replaceRun(plan, prefix, run) {
	const source = String(plan.source == null ? "" : plan.source), runStart = run.nodes[0].sourceStart, text = run.nodes.map(node => node.raw).join("");
	const pieces = pieceBoundaries(run), contextIds = unionContexts(run.nodes);
	if (!pieces) return null;
	const plainHead = leadingPlainLength(pieces), plainTail = trailingPlainStart(pieces);
	const label = LABEL_PREFIX_RE.exec(text.slice(0, plainHead));
	let bodyStart = label ? label[0].length : 0;
	while (bodyStart < plainHead && /[ \t]/.test(text[bodyStart])) bodyStart++;
	let bodyEnd = text.length;
	while (bodyEnd > Math.max(bodyStart, plainTail) && /[ \t]/.test(text[bodyEnd - 1])) bodyEnd--;
	if (bodyEnd <= bodyStart || !wireHasLanguage(text, pieces, bodyStart, bodyEnd)) return null;
	const parts = splitParts(text, bodyStart, bodyEnd, pieces, run.lineHasPreserve);
	if (!parts.length) return null;
	const output = [];
	let cursor = 0;
	for (const part of parts) {
		let start = part.start, end = part.end;
		while (start < end && /[ \t]/.test(text[start]) && !charInLeaf(pieces, start)) start++;
		while (end > start && /[ \t]/.test(text[end - 1]) && !charInLeaf(pieces, end - 1)) end--;
		if (end <= start) continue;
		if (start > cursor) output.push(createNode(prefix, source, runStart + cursor, runStart + start, "text", "protected", INLINE_RANGE_GAP_ROLE, contextIds));
		const {wire, inlineProtected} = buildWireText(text, pieces, start, end);
		output.push(createNode(prefix, source, runStart + start, runStart + end, "text", "translate", INLINE_RANGE_ROLE, contextIds, {wireText: wire, inlineProtected: Object.freeze(inlineProtected.map(row => Object.freeze(row)))}));
		cursor = end;
	}
	if (cursor < text.length) output.push(createNode(prefix, source, runStart + cursor, runStart + text.length, "text", "protected", INLINE_RANGE_GAP_ROLE, contextIds));
	return output;
}

function applyInlineProtectedRanges(plan, {inlineFormatting = true} = {}) {
	if (!plan || typeof plan !== "object" || !Array.isArray(plan.nodes) || !plan.nodes.length) return plan;
	if (plan.inlineRanges) return plan;
	const prefix = identityPrefix(plan.nodes[0]);
	if (prefix == null) return plan;
	const replacements = new Map();
	let mergedRuns = 0, rangeCount = 0;
	const mergeRun = run => {
		if (!qualifies(run)) return false;
		const replaced = replaceRun(plan, prefix, run);
		if (!replaced) return false;
		replacements.set(run.startIndex, {length: run.nodes.length, nodes: replaced});
		mergedRuns++;
		rangeCount += replaced.filter(node => node.role === INLINE_RANGE_ROLE).length;
		return true;
	};
	for (const run of collectRuns(plan.nodes, inlineFormatting)) {
		if (mergeRun(run) || !inlineFormatting || !run.nodes.some(isInlineFormat)) continue;
		// An ambiguous/unclosed format must not undo the existing P2 sentence
		// ranges around protected leaves. Retry those subruns locally without formats.
		for (const part of collectRuns(run.nodes, false)) mergeRun(Object.assign({}, part, {startIndex: run.startIndex + part.startIndex, lineHasPreserve: run.lineHasPreserve}));
	}
	if (!replacements.size) return plan;
	const nodes = [];
	for (let index = 0; index < plan.nodes.length; index++) {
		const replacement = replacements.get(index);
		if (!replacement) {nodes.push(plan.nodes[index]); continue;}
		nodes.push(...replacement.nodes);
		index += replacement.length - 1;
	}
	const formatCount = nodes.reduce((total, node) => total + (node.inlineProtected || []).filter(row => /^⟦F\d+⟧$/.test(row.token)).length, 0);
	// Keep the previous identity when no formatting was merged, including historical
	// response replays. Plain/protected-only plans retain their paid cache entries.
	const metadata = formatCount ? {version: INLINE_RANGES_VERSION, mergedRuns, rangeCount, formatCount} : {version: "inline-ranges-v1", mergedRuns, rangeCount};
	return Object.assign({}, plan, {nodes, inlineRanges: Object.freeze(metadata)});
}

function expectedInlinePlaceholders(plan) {
	const output = {};
	for (const node of plan && plan.nodes || []) {
		if (node.role !== INLINE_RANGE_ROLE || typeof node.wireText !== "string") continue;
		const counts = new Map();
		for (const token of inlineTokens(node.wireText)) counts.set(token, (counts.get(token) || 0) + 1);
		output[node.id] = [...counts.entries()].map(([token, count]) => ({token, count}));
	}
	return output;
}

// Local ⟦Cn⟧ tokens are numbered per segment, so they are restored per segment before the
// plan is reassembled; P1 placeholders stay for the shared addSemanticExceptions pass.
function restoreInlineProtectedTranslations(plan, valid) {
	if (!plan || !Array.isArray(plan.nodes) || !valid || typeof valid !== "object") return valid;
	const output = Object.assign({}, valid);
	for (const node of plan.nodes) {
		if (node.role !== INLINE_RANGE_ROLE || !Array.isArray(node.inlineProtected) || !Object.prototype.hasOwnProperty.call(output, node.id)) continue;
		const originals = new Map(node.inlineProtected.map(row => [row.token, String(row.raw)]));
		// Only tokens in the original response are interpreted. Local raw values
		// may themselves contain lookalikes, which must never be rescanned.
		output[node.id] = String(output[node.id]).replace(INLINE_TOKEN_RE, token => originals.has(token) ? originals.get(token) : token);
	}
	return output;
}

module.exports = {
	INLINE_RANGES_VERSION,
	INLINE_RANGE_ROLE,
	INLINE_RANGE_GAP_ROLE,
	applyInlineProtectedRanges,
	inlineTokens,
	stripInlineTokens,
	expectedInlinePlaceholders,
	restoreInlineProtectedTranslations
};
