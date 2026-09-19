// Tolerant reader for history-batch answers. The canonical answer is
// {"messages":[{"id":"m1","segments":[{"id":"s1","translation":"..."}]}]}. Configured
// models also mirror the request ({"id":"m1","plan":{"segments":[...]}}), use another
// list key (translations/items/results/data/output), key the object by message id, or
// send one translation string per message. Before this reader every such answer was
// "root-malformed" and the whole batch was re-sent on the legacy wire (9 of 84 batches
// in the 2026-09-13 field session). Every recovered shape is named so the diagnostics
// can count what the configured model actually produces; the segment validator still
// decides whether the rows are usable, and unknown ids are still reported as before.
const {parseJsonPayloadCandidates, parseTypedPlanResponse} = require("./translation-plan-serializer");

const LIST_KEYS = Object.freeze(["messages", "translations", "items", "results", "data", "output", "response", "result"]);
const ROW_LIST_KEYS = Object.freeze(["translations", "items", "output"]);
const ROW_STRING_KEYS = Object.freeze(["translation", "translatedText", "text"]);

// Closed vocabulary shared by the latency store counters and the diagnostics sanitizer.
const BATCH_ANSWER_SHAPES = Object.freeze([
	"plan-nested", "alt-list", "bare-array", "id-keyed", "translation-string", "segment-map", "alt-row-list", "message-objects",
	"malformed-empty", "malformed-not-json", "malformed-no-rows", "malformed-unknown-ids", "malformed-no-segments",
	"malformed-empty-list", "malformed-missing-id-fields", "malformed-segment-root", "malformed-invalid-rows", "unknown"
]);
const BATCH_ANSWER_ENVELOPES = Object.freeze(["messages", "alt-list", "bare-array", "id-keyed", "segment-root", "none"]);
const BATCH_JSON_SOURCES = Object.freeze(["whole", "fenced", "fragment", "none"]);
const BATCH_STRUCTURE_COUNTS = Object.freeze([
	"expectedMessageCount", "rowCount", "recognizedMessageCount", "parsedMessageCount", "missingMessageCount",
	"unreadableMessageCount", "missingIdRowCount", "unknownIdRowCount", "duplicateMessageRowCount", "invalidRowCount", "missingSegmentCount",
	"rootRowCount", "rootMessageIdRowCount", "rootSegmentIdRowCount"
]);

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isRecord = value => !!value && typeof value === "object" && !Array.isArray(value);

function rowFromEntry(id, value) {
	if (Array.isArray(value)) return {id, segments: value};
	if (typeof value === "string") return {id, translation: value};
	if (isRecord(value)) return Object.assign({}, value, {id});
	return null;
}

// Finds the list of per-message rows in a parsed answer, or null when there is none.
function readRows(parsed, isKnownId, depth = 0) {
	if (Array.isArray(parsed)) return {rows: parsed, shape: "bare-array"};
	if (!isRecord(parsed)) return null;
	for (const key of LIST_KEYS) {
		if (!hasOwn(parsed, key)) continue;
		if (Array.isArray(parsed[key])) return {rows: parsed[key], shape: key === "messages" ? null : "alt-list"};
		if (isRecord(parsed[key]) && depth === 0) {
			const nested = readRows(parsed[key], isKnownId, depth + 1);
			if (nested) return {rows: nested.rows, shape: "alt-list"};
		}
	}
	const entries = Object.entries(parsed).filter(([key]) => isKnownId(key));
	if (entries.length) {
		const rows = entries.map(([key, value]) => rowFromEntry(key, value)).filter(Boolean);
		if (rows.length) return {rows, shape: "id-keyed"};
	}
	return null;
}

// Finds the segment rows inside one message row. A lone translation string is only
// accepted when the message has exactly one segment, so the mapping is unambiguous.
function readRowSegments(row, planSegmentIds) {
	if (!isRecord(row)) return null;
	if (Array.isArray(row.segments)) return {segments: row.segments, shape: null};
	if (isRecord(row.plan) && Array.isArray(row.plan.segments)) return {segments: row.plan.segments, shape: "plan-nested"};
	for (const key of ROW_LIST_KEYS) if (Array.isArray(row[key])) return {segments: row[key], shape: "alt-row-list"};
	if (isRecord(row.segments)) {
		const segments = Object.entries(row.segments).map(([id, value]) => rowFromEntry(id, value)).filter(Boolean);
		if (segments.length) return {segments, shape: "segment-map"};
	}
	if (Array.isArray(planSegmentIds) && planSegmentIds.length === 1) {
		for (const key of ROW_STRING_KEYS) if (typeof row[key] === "string") return {segments: [{id: planSegmentIds[0], translation: row[key]}], shape: "translation-string"};
	}
	return null;
}

// A valid answer can split one message across several rows. Join only complete,
// disjoint, explicitly labelled canonical segments. Ambiguity repairs that message;
// neither first-row-wins nor positional matching may silently choose a translation.
function joinComplementaryRows(rows, planSegmentIds) {
	const expected = new Set(planSegmentIds || []), seen = new Set(), segments = [];
	if (!expected.size) return [];
	for (const row of rows) {
		if (row.id !== rows[0].id || !Array.isArray(row.segments) || !row.segments.length) return [];
		for (const segment of row.segments) {
			if (!isRecord(segment) || !expected.has(segment.id) || seen.has(segment.id) || typeof segment.translation !== "string" || !segment.translation.trim()) return [];
			seen.add(segment.id);
			segments.push({id: segment.id, translation: segment.translation});
		}
	}
	return seen.size === expected.size ? segments : [];
}

// A malformed outer container can still contain every complete message object.
// Recover only full, unambiguous message-ID coverage; never join by row position,
// repair JSON text, or combine conflicting aliases. Segment validation stays downstream.
function recoverMessageObjects(content, expected, resolveId) {
	if (typeof content !== "string" || !expected.size) return null;
	const opening = /^\s*\{\s*"messages"\s*:\s*\[\s*/.exec(content);
	if (!opening) return null;
	const rows = [], seen = new Set();
	let offset = opening[0].length;
	while (rows.length < expected.size && content[offset] === "{") {
		// Read one direct member in place. Never restart inside a malformed member:
		// its translation may itself contain JSON examples with matching message IDs.
		let end = offset, depth = 0, quoted = false, escaped = false;
		for (; end < content.length; end++) {
			const character = content[end];
			if (quoted) {if (escaped) escaped = false; else if (character === "\\") escaped = true; else if (character === '"') quoted = false; continue;}
			if (character === '"') quoted = true;
			else if (character === "{" || character === "[") depth++;
			else if ((character === "}" || character === "]") && --depth === 0) {end++; break;}
		}
		let row;
		try {row = JSON.parse(content.slice(offset, end));} catch {return null;}
		if (!isRecord(row) || !hasOwn(row, "id") || !(Array.isArray(row.segments) || isRecord(row.plan) && Array.isArray(row.plan.segments))) return null;
		const id = resolveId(String(row.id));
		if (!expected.has(id) || seen.has(id)) return null;
		seen.add(id); rows.push(row); offset = end;
		// Captured answers may add one extra } between otherwise complete members.
		const separator = /^\s*(?:,|\}\s*,|\]\s*\}\s*,)\s*/.exec(content.slice(offset));
		if (!separator) break;
		offset += separator[0].length;
	}
	return rows.length === expected.size && /^\s*\]\s*\}\s*$/.test(content.slice(offset)) ? {messages: rows} : null;
}

// Structure contains only counts and a closed envelope name, never ids or source/output
// text. Missing message rows and unreadable segment containers are separate observations;
// the existing validator and repair scheduler still decide which messages to retry.
function readSemanticBatchAnswer(content, {expectedIds, resolveId = id => id, planSegmentIdsFor = () => null} = {}) {
	const expected = expectedIds instanceof Set ? expectedIds : new Set([].concat(expectedIds || []).map(String));
	const isKnownId = key => expected.has(resolveId(String(key)));
	const jsonObservation = {source: "none"};
	const emptyStructure = envelope => Object.assign(Object.fromEntries(BATCH_STRUCTURE_COUNTS.map(key => [key, 0])), {envelope, jsonSource: jsonObservation.source, expectedMessageCount: expected.size, missingMessageCount: expected.size});
	const failure = (malformed, structure = emptyStructure("none")) => ({translations: null, shapes: [], malformed, structure: Object.freeze(structure)});
	if (!String(content == null ? "" : content).trim()) return failure("malformed-empty");
	const candidates = parseJsonPayloadCandidates(content, jsonObservation);
	if (!candidates.length) return failure("malformed-not-json");
	const recovered = jsonObservation.source === "fragment" && (readRows(candidates[0], isKnownId)?.rows.length || 0) < expected.size ? recoverMessageObjects(content, expected, resolveId) : null;
	if (recovered) candidates.unshift(recovered);
	let firstFailure = null;
	for (const parsed of candidates) {
		const list = readRows(parsed, isKnownId);
		if (!list) {
			if (!firstFailure && isRecord(parsed) && hasOwn(parsed, "segments")) {
				const structure = emptyStructure("segment-root");
				if (Array.isArray(parsed.segments)) {
					const segmentIds = new Set([...expected].flatMap(id => planSegmentIdsFor(id) || []).map(String));
					structure.rootRowCount = parsed.segments.length;
					for (const row of parsed.segments) if (isRecord(row) && row.id != null) {
						if (isKnownId(row.id)) structure.rootMessageIdRowCount++;
						if (segmentIds.has(String(row.id))) structure.rootSegmentIdRowCount++;
					}
				}
				firstFailure = failure("malformed-segment-root", structure);
			}
			continue;
		}
		const shapes = new Set(parsed === recovered ? ["message-objects"] : list.shape ? [list.shape] : []);
		const structure = emptyStructure(list.shape || "messages");
		structure.rowCount = list.rows.length;
		const recognized = new Set();
		const rowsById = new Map();
		const result = {};
		for (const row of list.rows) {
			if (!isRecord(row)) {structure.invalidRowCount++; continue;}
			if (!hasOwn(row, "id") || row.id == null || String(row.id).trim() === "") {structure.missingIdRowCount++; continue;}
			const id = resolveId(String(row.id == null ? "" : row.id));
			if (!expected.has(id)) {structure.unknownIdRowCount++; continue;}
			if (recognized.has(id)) structure.duplicateMessageRowCount++;
			recognized.add(id);
			if (!rowsById.has(id)) rowsById.set(id, []);
			rowsById.get(id).push(row);
		}
		for (const [id, rows] of rowsById) {
			const planSegmentIds = planSegmentIdsFor(id);
			const read = rows.length > 1
				? {segments: jsonObservation.source === "fragment" ? [] : joinComplementaryRows(rows, planSegmentIds), shape: null}
				: readRowSegments(rows[0], planSegmentIds);
			if (!read) continue;
			const segments = parseTypedPlanResponse(read.segments);
			if (!Array.isArray(segments)) continue;
			if (read.shape) shapes.add(read.shape);
			result[id] = {semanticSegments: segments};
			const returnedIds = new Set(segments.map(segment => String(segment.id == null ? "" : segment.id)));
			structure.missingSegmentCount += (planSegmentIds || []).filter(segmentId => !returnedIds.has(String(segmentId))).length;
		}
		structure.recognizedMessageCount = recognized.size;
		structure.parsedMessageCount = Object.keys(result).length;
		structure.missingMessageCount = expected.size - recognized.size;
		structure.unreadableMessageCount = recognized.size - structure.parsedMessageCount;
		if (structure.parsedMessageCount) return {translations: result, shapes: [...shapes], malformed: null, structure: Object.freeze(structure)};
		// Keep the first recognized envelope's failure: balanced JSON extraction also
		// yields nested segment arrays, whose s1 ids are not unknown message ids.
		if (!firstFailure) firstFailure = failure(!list.rows.length ? "malformed-empty-list" : recognized.size ? "malformed-no-segments" : structure.unknownIdRowCount ? "malformed-unknown-ids" : structure.missingIdRowCount ? "malformed-missing-id-fields" : "malformed-invalid-rows", structure);
	}
	return firstFailure || failure("malformed-no-rows");
}

module.exports = {BATCH_ANSWER_SHAPES, BATCH_ANSWER_ENVELOPES, BATCH_JSON_SOURCES, BATCH_STRUCTURE_COUNTS, readSemanticBatchAnswer};
