const MATRIX_SCHEMA_VERSION = 1;
const MATRIX_ROW_LIMIT = 48;
const ELIGIBILITY = new Set(["eligible", "filtered", "not-applicable", "unknown"]);

function whole(value) {const number = Number(value); return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;}
function label(value, fallback = null, max = 64) {if (value == null || value === "") return fallback; const text = String(value).toLowerCase(); return text.length <= max && /^[a-z0-9_.:-]+$/.test(text) ? text : fallback;}
function digest(value) {const text = String(value || ""); let hash = 2166136261; for (let index = 0; index < text.length; index++) {hash ^= text.charCodeAt(index); hash = Math.imul(hash, 16777619);} return (hash >>> 0).toString(16).padStart(8, "0");}
function counts(value) {const result = {}; for (const [key, count] of Object.entries(value || {})) {const safe = label(key); if (safe) result[safe] = whole(count);} return result;}
function identity(value) {const safe = label(value, null, 80); return safe && /^(?:bi|tk|wk|ri|pi)\d?:[a-z0-9]{8,64}$/.test(safe) ? safe : null;}
function normalizeRepairTrajectory(value, laneTags = {}) {
	const items = Array.isArray(value) ? value : ["batch-repair", "item-repair"].filter(role => whole(laneTags[role])).map(role => ({role, count: whole(laneTags[role])}));
	return items.slice(0, 8).map(item => ({role: label(item && item.role, "unknown"), count: whole(item && item.count)}));
}
function deriveDisplayCommit(row) {
	const explicit = label(row.displayCommit); if (explicit) return explicit;
	if (row.outcome === "translated" && row.stage === "display-currentness") return "applied";
	if (row.outcome === "translated" && row.stage === "cache") return "cache-applied";
	if (row.stage === "display-currentness" && row.outcome === "failed") return "failed";
	return "not-applied";
}
function normalizeRow(raw = {}, index = 0) {
	const laneTags = counts(raw.laneTags), providerRoles = counts(raw.providerRoles), ruleCounts = counts(raw.ruleCounts);
	const request = raw.request || {};
	const row = {
		matrixId: label(raw.matrixId, `cbm1:${digest(JSON.stringify([raw.entry, raw.lane, raw.engineFamily, raw.decisionApplied, raw.promptFamily, raw.validatorFamily, raw.cacheRead, raw.outcome, raw.stage, raw.reason, index]))}`, 80),
		sampleCount: Math.max(1, whole(raw.sampleCount) || 1),
		entry: label(raw.entry, "unknown"),
		eligibility: ELIGIBILITY.has(String(raw.eligibility || "").toLowerCase()) ? String(raw.eligibility).toLowerCase() : "unknown",
		sourceFilterReason: label(raw.sourceFilterReason),
		lane: label(raw.lane, "unknown"), laneTags,
		shape: label(raw.shape, "text"), engineFamily: label(raw.engineFamily, "unknown"), decisionApplied: raw.decisionApplied == null ? null : !!raw.decisionApplied,
		promptFamily: label(raw.promptFamily, "unknown"), validatorFamily: label(raw.validatorFamily, "unknown"),
		placeholderOccurrences: whole(raw.placeholderOccurrences), ruleCounts,
		cacheRead: label(raw.cacheRead, "none"), cacheWrite: label(raw.cacheWrite, "none"),
		outcome: label(raw.outcome, "unknown"), stage: label(raw.stage, "unknown"), reason: label(raw.reason, "unknown"),
		providerDispatchCount: whole(raw.providerDispatchCount), providerRoles,
		request: {
			providerFamily: label(request.providerFamily, label(raw.engineFamily, "unknown")),
			role: label(request.role), promptFamily: label(request.promptFamily, label(raw.promptFamily, "unknown")),
			bodyBytes: request.bodyBytes == null ? null : whole(request.bodyBytes), bodyIdentity: identity(request.bodyIdentity)
		},
		repairTrajectory: normalizeRepairTrajectory(raw.repairTrajectory, laneTags),
		displayCommit: deriveDisplayCommit(raw)
	};
	return Object.freeze(Object.assign(row, {laneTags: Object.freeze(laneTags), ruleCounts: Object.freeze(ruleCounts), providerRoles: Object.freeze(providerRoles), request: Object.freeze(row.request), repairTrajectory: Object.freeze(row.repairTrajectory.map(item => Object.freeze(item)))}));
}
function createTranslationCurrentBehaviorMatrix(observations = [], {limit = MATRIX_ROW_LIMIT} = {}) {
	const cap = Math.max(1, Math.min(MATRIX_ROW_LIMIT, whole(limit) || MATRIX_ROW_LIMIT)), cells = new Map(); let rejectedRowCount = 0;
	for (let index = 0; index < [].concat(observations || []).length; index++) {
		const raw = [].concat(observations || [])[index]; if (!raw || typeof raw !== "object") {rejectedRowCount++; continue;}
		const row = normalizeRow(raw, index), prior = cells.get(row.matrixId);
		if (prior) cells.set(row.matrixId, normalizeRow(Object.assign({}, prior, row, {sampleCount: prior.sampleCount + row.sampleCount}), index)); else cells.set(row.matrixId, row);
	}
	const all = [...cells.values()], evictedRowCount = Math.max(0, all.length - cap), rows = all.slice(-cap);
	return Object.freeze({schemaVersion: MATRIX_SCHEMA_VERSION, rowLimit: cap, rowCount: rows.length, evictedRowCount, rejectedRowCount, desiredIncluded: false, rows: Object.freeze(rows)});
}
function buildMatrixRowsFromTerminalLedger(snapshot = {}) {
	const cells = new Map();
	for (const route of [].concat(snapshot.recent || [])) {
		const key = [route.entry, route.eligibility, route.sourceFilterReason, route.lane, route.shape, route.engineFamily, route.decisionApplied, route.promptFamily, route.validatorFamily, route.placeholderOccurrences, route.cacheRead, route.cacheWrite, route.outcome, route.stage, route.reason].join("|");
		const roles = route.providerRoles || {}, roleNames = Object.keys(roles), matrixId = `cbm1:${digest(key)}`, prior = cells.get(matrixId); cells.set(matrixId, {
			matrixId, sampleCount: (prior && prior.sampleCount || 0) + 1, entry: route.entry, eligibility: route.eligibility, sourceFilterReason: route.sourceFilterReason,
			lane: route.lane, laneTags: route.laneTags, shape: route.shape, engineFamily: route.engineFamily, decisionApplied: route.decisionApplied,
			promptFamily: route.promptFamily, validatorFamily: route.validatorFamily, placeholderOccurrences: route.placeholderOccurrences, ruleCounts: route.ruleCounts,
			cacheRead: route.cacheRead, cacheWrite: route.cacheWrite, outcome: route.outcome, stage: route.stage, reason: route.reason,
			providerDispatchCount: route.providerDispatchCount, providerRoles: roles,
			request: {providerFamily: route.engineFamily, role: roleNames.length === 1 ? roleNames[0] : roleNames.length ? "mixed" : null, promptFamily: route.promptFamily, bodyBytes: route.requestBodyBytes, bodyIdentity: route.requestBodyIdentity},
			repairTrajectory: null, displayCommit: route.displayCommit
		});
	}
	return [...cells.values()].map((route, index) => normalizeRow(route, index));
}

module.exports = {MATRIX_SCHEMA_VERSION, MATRIX_ROW_LIMIT, createTranslationCurrentBehaviorMatrix, buildMatrixRowsFromTerminalLedger};
