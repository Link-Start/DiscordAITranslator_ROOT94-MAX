// P3 soft validation. Segment validation reports why a translated segment was rejected; P3
// distinguishes valid name preservation from unresolved translation failures. Recognised
// names and verified technical labels can stay unchanged. Other rejected segments use
// the existing bounded repair budget; exhaustion fails the whole message, never commits
// its successful fragments mixed with failed source text. Pure functions only.
//
// Current policy: docs/product.md, validation-and-experimental-policies.

const {stripInlineTokens} = require("./translation-inline-ranges");
const {hasTargetTextOnLine} = require("./translation-source-context");

const SOFT_VALIDATION_VERSION = "p3-soft-validation-v4";
const VALIDATOR_FAMILY = "segment-validator-v3";
const SOFT_REASONS = Object.freeze(["wrong-language", "too-similar"]);
const HARD_REASONS = Object.freeze(["missing-id", "empty", "duplicate-id", "placeholder-mismatch", "malformed", "unknown-id"]);
const NAME_LIKE_CASED_SHARE = 0.6;
const WORD_RE = /[\p{L}\p{N}]/u;
const LETTER_RE = /\p{L}/u;
const UPPER_START_RE = /^\p{Lu}/u;
const EDGE_PUNCTUATION_RE = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

function isSoftReason(reason) {return SOFT_REASONS.includes(String(reason || ""));}
function isHardReason(reason) {return !isSoftReason(reason);}

function segmentLanguageText(node) {
	if (!node) return "";
	return typeof node.wireText === "string" ? stripInlineTokens(node.wireText) : String(node.raw == null ? "" : node.raw);
}

// The text a kept segment contributes to reassembly: the wire form, so P2 ⟦Cn⟧ leaves and P1
// placeholders are restored by the same code path a real translation goes through.
function segmentKeepText(node) {
	if (!node) return "";
	return typeof node.wireText === "string" ? node.wireText : String(node.raw == null ? "" : node.raw);
}

function words(text) {return String(text || "").trim().split(/\s+/).filter(word => WORD_RE.test(word));}

// Length alone is not evidence of a name: everyday chat instructions are often short.
// Keep the existing title/name casing heuristic, but reject sentence punctuation first.
// Uncertain text uses the existing bounded repair rounds, never another request budget.
function isNameLikeText(text) {
	if (/[.!?。！？][\p{Pe}\p{Pf}"'_*~|\s]*$/u.test(String(text || "").trim())) return false;
	const list = words(text);
	const lettered = list.map(word => word.replace(EDGE_PUNCTUATION_RE, "")).filter(word => LETTER_RE.test(word));
	if (!lettered.length) return false;
	const cased = lettered.filter(word => UPPER_START_RE.test(word) || (word === word.toUpperCase() && word !== word.toLowerCase()));
	return cased.length / lettered.length >= NAME_LIKE_CASED_SHARE;
}

function isNameLikeSegment(plan, node) {
	// A footer can contain ordinary prose too; position must not override its text.
	return !!node && !hasTargetTextOnLine(plan, node) && isNameLikeText(segmentLanguageText(node));
}

const VERSION_LABEL_RE = /^[A-Za-z][A-Za-z0-9_.-]*[ \t]+v\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/;
const RELEASE_HEADING_RE = /^(?:⟦C\d+⟧\s*)?⟦F(\d+)⟧([^⟦\r\n]+)⟦\/F\1⟧\s*·\s*\d{4}-\d{2}-\d{2}$/;

// A version number alone does not make "Delete v1.2.3" a product name. Require
// both a dated, formatted release heading and its repeated standalone label in
// this same local plan. No vocabulary, context or extra fields go to the provider.
function isReleaseLabel(plan, node) {
	const text = segmentKeepText(node).trim(), heading = RELEASE_HEADING_RE.exec(text);
	const label = (heading ? heading[2] : text).trim();
	if (!VERSION_LABEL_RE.test(label)) return false;
	const key = label.toLowerCase();
	let hasHeading = false, hasLabel = false;
	for (const part of plan && plan.nodes || []) {
		const value = segmentKeepText(part).trim(), match = RELEASE_HEADING_RE.exec(value);
		if (match && match[2].trim().toLowerCase() === key) hasHeading = true;
		else if (value.toLowerCase() === key) hasLabel = true;
		if (hasHeading && hasLabel) return true;
	}
	return false;
}

// The captured line is a transport trace, not an English instruction. Verify the
// placeholder really protects a URL; mentions or arbitrary protected prose do not
// qualify. A longer error explanation still takes the normal translation path.
function isHttpOperation(node, protectedSegments) {
	const match = /^HTTP\s+⟦(?:DTA)?(\d+)⟧\s*>\s*initialize$/.exec(segmentKeepText(node).trim());
	return !!match && /^https?:\/\/[^\s]+$/i.test(String(protectedSegments[match[1]] || ""));
}

// P3-b, whole-message arm. The legacy batch wire (the root-malformed compatibility fallback and
// engines without typed json) has no segments, so its validator judges the whole message. Rule
// 2(a) then applies line by line: the message is name-like when every lettered line left after
// removing P1 placeholders and the embed and field dividers is name-like. Its reasons use the
// legacy spelling; the kept label is the P3 one.
const LEGACY_PLACEHOLDER_RE = /⟦\s*(?:DTA\s*)?\d+\s*⟧/g;
const LEGACY_DIVIDER_RE = /_{18}/g;
const LEGACY_SOFT_LABELS = Object.freeze({wrong_language: "wrong-language", too_similar: "too-similar", same_as_source: "too-similar"});

function messageTextLines(text) {
	return String(text || "").replace(/\[NEWLINE\]/g, "\n").replace(LEGACY_DIVIDER_RE, "\n").split("\n").map(line => line.replace(LEGACY_PLACEHOLDER_RE, " ").trim()).filter(line => LETTER_RE.test(line));
}

function isNameLikeMessage(text) {
	const lines = messageTextLines(text);
	return lines.length > 0 && lines.every(line => isNameLikeText(line));
}

function legacySoftReasonLabel(reason) {return LEGACY_SOFT_LABELS[String(reason || "")] || null;}

// Only source evidence permits preservation; exhausting repairs is not such evidence.
function resolveSoftFailures({plan, invalid = [], rows = [], declaredNameIds = [], protectedSegments = {}} = {}) {
	const nodes = new Map((plan && plan.nodes || []).map(node => [String(node.id), node]));
	const kept = {}, remaining = [];
	for (const row of invalid || []) {
		const id = String(row && row.id || ""), reason = String(row && row.reason || "");
		const node = nodes.get(id);
		if (node && isSoftReason(reason) && (declaredNameIds.includes(id) || isNameLikeSegment(plan, node) ||
			(rows.some(answer => answer && String(answer.id) === id && String(answer.translation).trim() === segmentKeepText(node).trim()) &&
				(isHttpOperation(node, protectedSegments) || isReleaseLabel(plan, node))))) {kept[id] = reason; continue;}
		remaining.push(row);
	}
	return Object.freeze({kept: Object.freeze(kept), remaining: Object.freeze(remaining)});
}

function summarizeKept(kept) {
	const reasons = {};
	for (const reason of Object.values(kept || {})) {const label = isSoftReason(reason) ? reason : "unknown"; reasons[label] = (reasons[label] || 0) + 1;}
	return Object.freeze({keptCount: Object.keys(kept || {}).length, keptReasons: Object.freeze(reasons)});
}

module.exports = {SOFT_VALIDATION_VERSION, VALIDATOR_FAMILY, SOFT_REASONS, HARD_REASONS, isSoftReason, isHardReason, segmentLanguageText, segmentKeepText, isNameLikeText, isNameLikeSegment, resolveSoftFailures, summarizeKept, messageTextLines, isNameLikeMessage, legacySoftReasonLabel};
