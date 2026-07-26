const MESSAGE_STATUSES = Object.freeze({
	IDLE: "idle",
	PENDING: "pending",
	TRANSLATING: "translating",
	TRANSLATED: "translated",
	SKIPPED: "skipped",
	FAILED: "failed",
	CANCELLED: "cancelled"
});

const RENDER_STATUSES = Object.freeze({
	IDLE: "idle",
	PENDING: "pending",
	CONFIRMED: "confirmed",
	UNCONFIRMED: "unconfirmed"
});

const TERMINAL_STATUSES = new Set([
	MESSAGE_STATUSES.TRANSLATED,
	MESSAGE_STATUSES.SKIPPED,
	MESSAGE_STATUSES.FAILED,
	MESSAGE_STATUSES.CANCELLED
]);
const INVALID_REQUEST_IDENTITY = Symbol("invalid-request-identity");

function freezeValue(value) {
	if (Array.isArray(value)) return Object.freeze(value.map(freezeValue));
	if (!value || typeof value !== "object") return value;
	return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freezeValue(item)])));
}

function normalizeIdentity(value) {
	return value === undefined || value === null ? "" : String(value);
}

function normalizeRequestIdentity(value) {
	if (value === undefined || value === null) return null;
	switch (typeof value) {
		case "string": return value;
		case "number":
		case "bigint":
		case "boolean": return String(value);
		default: return INVALID_REQUEST_IDENTITY;
	}
}

function hasGeneration(value) {
	return value !== undefined && value !== null && !(typeof value === "number" && Number.isNaN(value));
}

const TRANSITIONS_BY_STATUS = Object.freeze({
	[MESSAGE_STATUSES.TRANSLATED]: "state-committed",
	[MESSAGE_STATUSES.SKIPPED]: "skipped",
	[MESSAGE_STATUSES.FAILED]: "failed",
	[MESSAGE_STATUSES.CANCELLED]: "cancelled"
});

function createMessageStateStore({journal = null} = {}) {
	const records = new Map();
	const channelMessageIds = new Map();
	const channelGenerations = new Map();
	let revision = 0;

	function recordTransition(record, transition) {
		if (!journal || !record) return record;
		journal.append({channelId: record.channelId, messageId: record.messageId, revision: record.revision, transition});
		return record;
	}

	function indexRecord(record) {
		if (!channelMessageIds.has(record.channelId)) channelMessageIds.set(record.channelId, new Set());
		channelMessageIds.get(record.channelId).add(record.messageId);
	}

	function update(messageId, changes, {advanceRevision = true} = {}) {
		const current = records.get(normalizeIdentity(messageId));
		if (!current) return null;
		const next = Object.freeze({...current, ...changes, revision: advanceRevision ? ++revision : current.revision});
		records.set(next.messageId, next);
		return next;
	}

	function getCurrentRecord(input) {
		if (!input || typeof input !== "object" || !hasGeneration(input.generation)) return null;
		const messageId = normalizeIdentity(input.messageId);
		const channelId = normalizeIdentity(input.channelId);
		if (!messageId || !channelId) return null;
		const record = records.get(messageId);
		if (!record || record.channelId !== channelId || record.generation !== input.generation) return null;
		if (!channelGenerations.has(channelId) || channelGenerations.get(channelId) !== input.generation) return null;
		return record;
	}

	function getTerminalStatus(result) {
		return result && (result.status || MESSAGE_STATUSES.TRANSLATED);
	}

	function validatesTerminalResult(result) {
		const status = getTerminalStatus(result);
		const record = getCurrentRecord(result);
		if (!record || !TERMINAL_STATUSES.has(status)) return false;
		if (result.sourceSignature === undefined || result.sourceSignature === null || normalizeIdentity(result.sourceSignature) !== record.sourceSignature) return false;
		const requestIdentity = normalizeRequestIdentity(result.requestIdentity);
		if (requestIdentity === INVALID_REQUEST_IDENTITY) return false;
		if (record.requestIdentity !== null && requestIdentity !== record.requestIdentity) return false;
		return status !== MESSAGE_STATUSES.TRANSLATED || !!(result.translation && typeof result.translation.content === "string");
	}

	function applyResult(result) {
		const status = getTerminalStatus(result);
		const translated = status === MESSAGE_STATUSES.TRANSLATED;
		return recordTransition(update(result.messageId, {
			status,
			translation: translated ? freezeValue(result.translation) : null,
			reason: translated ? null : String(result.reason || status),
			origin: result.origin || "automatic",
			requestIdentity: null,
			renderStatus: RENDER_STATUSES.PENDING,
			renderReason: null
		}), TRANSITIONS_BY_STATUS[status]);
	}

	function restoreRecords(recordsToRestore, reason) {
		return recordsToRestore
			.filter(record => record && record.origin === "automatic" && record.status !== MESSAGE_STATUSES.CANCELLED)
			.map(record => recordTransition(update(record.messageId, {
				status: MESSAGE_STATUSES.CANCELLED,
				translation: null,
				reason,
				requestIdentity: null,
				renderStatus: RENDER_STATUSES.PENDING,
				renderReason: null
			}), "restored"));
	}

	function listChannel(channelId) {
		return [...channelMessageIds.get(normalizeIdentity(channelId)) || []]
			.map(messageId => records.get(messageId))
			.filter(Boolean);
	}

	return Object.freeze({
		captureSource(snapshot) {
			if (!snapshot || typeof snapshot !== "object" || !hasGeneration(snapshot.generation)) return null;
			const messageId = normalizeIdentity(snapshot.messageId);
			const channelId = normalizeIdentity(snapshot.channelId);
			if (!messageId || !channelId) return null;
			const current = records.get(messageId);
			if (current && current.channelId !== channelId) return null;
			if (channelGenerations.has(channelId) && channelGenerations.get(channelId) !== snapshot.generation) return null;
			const sourceSignature = normalizeIdentity(snapshot.sourceSignature);
			if (current && current.generation === snapshot.generation && current.sourceSignature === sourceSignature) return current;
			const record = Object.freeze({
				messageId,
				channelId,
				generation: snapshot.generation,
				sourceSignature,
				source: freezeValue(snapshot.source || {}),
				status: MESSAGE_STATUSES.IDLE,
				translation: null,
				reason: null,
				origin: null,
				requestIdentity: null,
				renderStatus: RENDER_STATUSES.IDLE,
				renderReason: null,
				revision: ++revision
			});
			records.set(messageId, record);
			indexRecord(record);
			if (!channelGenerations.has(channelId)) channelGenerations.set(channelId, snapshot.generation);
			return recordTransition(record, "captured");
		},
		setChannelGeneration(channelId, generation) {
			const normalizedChannelId = normalizeIdentity(channelId);
			if (!normalizedChannelId || !hasGeneration(generation)) return null;
			channelGenerations.set(normalizedChannelId, generation);
			return generation;
		},
		getChannelGeneration(channelId) {
			return channelGenerations.get(normalizeIdentity(channelId));
		},
		getDisplayState(messageId) {
			return records.get(normalizeIdentity(messageId)) || null;
		},
		listChannel,
		markPending(request) {
			if (!getCurrentRecord(request) || request.status && request.status !== MESSAGE_STATUSES.PENDING) return null;
			const requestIdentity = normalizeRequestIdentity(request.requestIdentity);
			if (requestIdentity === INVALID_REQUEST_IDENTITY) return null;
			return recordTransition(update(request.messageId, {
				status: MESSAGE_STATUSES.PENDING,
				translation: null,
				reason: null,
				origin: request.origin || "automatic",
				requestIdentity,
				renderStatus: RENDER_STATUSES.PENDING,
				renderReason: null
			}), "pending");
		},
		markTranslating(request) {
			const current = getCurrentRecord(request);
			if (!current || request.status && request.status !== MESSAGE_STATUSES.TRANSLATING) return null;
			const nextRequestIdentity = Object.prototype.hasOwnProperty.call(request, "requestIdentity") ? normalizeRequestIdentity(request.requestIdentity) : null;
			if (nextRequestIdentity === INVALID_REQUEST_IDENTITY) return null;
			const requestIdentity = nextRequestIdentity === null ? current.requestIdentity : nextRequestIdentity;
			return recordTransition(update(request.messageId, {
				status: MESSAGE_STATUSES.TRANSLATING,
				reason: null,
				origin: request.origin || current.origin || "automatic",
				requestIdentity,
				renderStatus: RENDER_STATUSES.PENDING,
				renderReason: null
			}), "translating");
		},
		commitResult(result) {
			return validatesTerminalResult(result) ? applyResult(result) : null;
		},
		commitBatch(results) {
			const channelIds = new Set(results.map(result => normalizeIdentity(result && result.channelId)));
			if (channelIds.size !== 1) return {committed: [], rejected: results.slice()};
			// A result for a message this store never captured cannot display here and must
			// not poison the batch; atomicity covers only results with a tracked record.
			const recordless = results.filter(result => !result || typeof result !== "object" || !records.has(normalizeIdentity(result.messageId)));
			const recorded = results.filter(result => !recordless.includes(result));
			const rejected = recorded.filter(result => !validatesTerminalResult(result));
			if (rejected.length) return {committed: [], rejected: rejected.concat(recordless)};
			return {committed: recorded.map(applyResult), rejected: recordless};
		},
		releasePending(request) {
			if (!request || typeof request !== "object") return null;
			const record = records.get(normalizeIdentity(request.messageId));
			if (!record) return null;
			if (request.channelId !== undefined && normalizeIdentity(request.channelId) !== record.channelId) return null;
			if (record.status !== MESSAGE_STATUSES.PENDING && record.status !== MESSAGE_STATUSES.TRANSLATING) return null;
			const requestIdentity = normalizeRequestIdentity(request.requestIdentity);
			if (requestIdentity === INVALID_REQUEST_IDENTITY || requestIdentity === null) return null;
			if (record.requestIdentity !== requestIdentity) return null;
			return recordTransition(update(record.messageId, {
				status: MESSAGE_STATUSES.IDLE,
				translation: null,
				reason: null,
				requestIdentity: null
			}), "released");
		},
		restoreMessage(messageId, reason = "manual-untranslate") {
			const record = records.get(normalizeIdentity(messageId));
			return restoreRecords(record ? [record] : [], reason);
		},
		restoreChannel(channelId, reason = "channel-disabled") {
			return restoreRecords(listChannel(channelId), reason);
		},
		restoreAll(reason = "plugin-stopped") {
			return restoreRecords([...records.values()], reason);
		},
		markRenderOutcome({confirmedIds = [], missingIds = []} = {}) {
			for (const messageId of confirmedIds) {
				update(messageId, {renderStatus: RENDER_STATUSES.CONFIRMED, renderReason: null}, {advanceRevision: false});
			}
			for (const messageId of missingIds) {
				update(messageId, {renderStatus: RENDER_STATUSES.UNCONFIRMED, renderReason: "render-unconfirmed"}, {advanceRevision: false});
			}
		}
	});
}

module.exports = {MESSAGE_STATUSES, RENDER_STATUSES, createMessageStateStore};
