const {BATCH_ANSWER_SHAPES, BATCH_ANSWER_ENVELOPES, BATCH_JSON_SOURCES, BATCH_STRUCTURE_COUNTS} = require("../planner/semantic-batch-answer");
const {TYPED_BATCH_PROMPT_VERSION} = require("../planner/translation-plan-serializer");

const MAX_RECENT_BATCH_ANSWERS = 20;
const count = (value, max = 4096) => Number.isFinite(Number(value)) ? Math.max(0, Math.min(max, Math.floor(Number(value)))) : 0;

// Used at ingestion and again when copying diagnostics. No arbitrary strings, ids,
// property names or response fragments pass either boundary.
function sanitizeBatchAnswerObservation(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return Object.freeze(Object.assign({
		schemaVersion: "batch-answer-v1",
		requestId: count(value.requestId, Number.MAX_SAFE_INTEGER),
		promptVersion: value.promptVersion === TYPED_BATCH_PROMPT_VERSION ? TYPED_BATCH_PROMPT_VERSION : "unknown",
		envelope: BATCH_ANSWER_ENVELOPES.includes(value.envelope) ? value.envelope : "none",
		jsonSource: BATCH_JSON_SOURCES.includes(value.jsonSource) ? value.jsonSource : "none",
		malformed: value.malformed == null ? null : BATCH_ANSWER_SHAPES.includes(value.malformed) && value.malformed.startsWith("malformed-") ? value.malformed : "unknown",
		fallbackStarted: value.fallbackStarted === true
	}, Object.fromEntries(BATCH_STRUCTURE_COUNTS.map(key => [key, count(value[key])]))));
}

module.exports = {MAX_RECENT_BATCH_ANSWERS, sanitizeBatchAnswerObservation};
