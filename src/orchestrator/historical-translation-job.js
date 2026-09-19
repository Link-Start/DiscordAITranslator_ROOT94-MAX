// Owns one historical (loaded-message) translation job: the per-message records, the
// state machine those records move through, and the run pipeline that carries a whole
// channel snapshot from "collecting" to a final atomic commit.
//
// Without commitProgress, the job retains its single atomic display commit. The
// optional progress sink accepts validated primary blocks while slower siblings or
// repairs remain pending; it never exposes unvalidated or partial-message content.
//
// The module knows nothing about Discord, providers, caches or the display store. Every
// side effect - preparing an item, calling the provider, validating a result, repairing
// a leftover, waiting for the right moment to commit, committing and repainting -
// arrives as an injected dependency, defaulted so the class is constructible alone.
//
// Two invariants hold the whole thing together:
//
// - A record only ever leaves a non-terminal state. cancel() stamps "cancelled" over
//   every non-terminal record, and every later write path re-checks both record.status
//   and this.state before touching a record. That is what makes a provider result which
//   lands after a cancel a no-op rather than a resurrection.
// - createSummary is derived from the records on demand, never accumulated alongside
//   them, so a cancelled job and a committed job report through the same code path.
//
// The pipeline is: prepare every record, translate the survivors in ONE batch, validate
// each result, hand the failures to an optional chunked repair batch, then fall back to
// per-item repair with bounded concurrency. Each stage is a funnel - it only ever sees
// what the previous stage could not resolve - which is why the expensive per-item path
// normally runs on nothing at all.

// The states a record can never be moved out of. "cancelled" is in here so that a
// cancel cannot be overwritten by a late result, and "skipped"/"failed" are in here so
// that a decision already reached is not paid for twice.
const HISTORICAL_TERMINAL_ITEM_STATES = new Set(["translated", "skipped", "failed", "cancelled"]);
const {MAX_HISTORICAL_ITEMS_PER_ATTEMPT, MAX_HISTORICAL_PROTECTED_CHARS_PER_ATTEMPT} = require("./historical-provider-budget-owner");

// The hard ceiling on how many loaded messages one historical AI batch may carry,
// whatever the user configured as their loaded-message limit. The job class does not
// read it - the plugin clamps its own limit against this before handing items to a job -
// but it is a historical-job number, so it lives with them rather than in the runtime.
const HISTORICAL_AI_BATCH_ITEM_LIMIT_MAX = 100;

function safeTimestamp(now) {
	try {
		const value = Number(now());
		if (Number.isFinite(value)) return Math.max(0, value);
	}
	catch (error) {}
	try {return Math.max(0, Number(Date.now()) || 0);}
	catch (error) {return 0;}
}

function normalizeBatchOutcome(outcome) {
	const detailed = !!(outcome && typeof outcome == "object" && Object.prototype.hasOwnProperty.call(outcome, "translations") && Object.prototype.hasOwnProperty.call(outcome, "failureKind"));
	return detailed ? outcome : {translations: outcome, failureKind: null, statusCode: null};
}

function isTerminalProviderFailure(failureKind) {
	return ["auth", "configuration", "schema", "semantic_schema", "permanent", "request_budget", "attempt_budget"].includes(failureKind);
}

function partitionHistoricalRepairRecords(records, itemLimit, charLimit = MAX_HISTORICAL_PROTECTED_CHARS_PER_ATTEMPT) {
	const chunks = [];
	let chunk = [];
	let characters = 0;
	for (const record of records || []) {
		const recordCharacters = String(record && record.prepared && record.prepared.protectedText || "").length;
		if (chunk.length && (chunk.length >= itemLimit || characters + recordCharacters > charLimit)) {
			chunks.push(chunk);
			chunk = [];
			characters = 0;
		}
		chunk.push(record);
		characters += recordCharacters;
		if (chunk.length >= itemLimit || recordCharacters > charLimit) {
			chunks.push(chunk);
			chunk = [];
			characters = 0;
		}
	}
	if (chunk.length) chunks.push(chunk);
	return chunks;
}

class HistoricalTranslationJob {
	constructor(config = {}) {
		this.id = config.id || `historical-${Date.now()}`;
		this.channelId = config.channelId || null;
		this.generation = config.generation || 0;
		this.configurationSignature = config.configurationSignature || null;
		this.dependencies = Object.assign({
			prepare: item => ({status: "pending", prepared: item}),
			translateBatch: () => Promise.resolve(null),
			repairBatch: null,
			validate: (_item, translatedText) => translatedText == null ? {ok: false} : {ok: true, translation: translatedText},
			repair: () => Promise.resolve({status: "failed", reason: "unresolved"}),
			waitForCommit: () => Promise.resolve(),
			isCurrent: () => true,
			commit: () => {},
			onCancel: () => {},
			onInvalidate: () => {},
			onStateChange: () => {}
		}, config.dependencies || {});
		this.items = new Map();
		this.progressCommittedIds = new Set();
		this.state = "collecting";
		this.sealed = false;
		this.cancelReason = null;
		this.started = false;
		this.now = typeof config.now == "function" ? config.now : Date.now;
		this.sealedAt = null;
		this.repairConcurrency = Math.max(1, parseInt(config.repairConcurrency, 10) || 4);
		this.repairBatchSize = Math.max(1, parseInt(config.repairBatchSize, 10) || 10);
	}

	add(item) {
		if (this.state != "collecting" || this.sealed) return false;
		const source = item && item.message ? item : {message: item};
		const messageId = source.message && source.message.id;
		if (!messageId || this.items.has(String(messageId))) return false;
		this.items.set(String(messageId), {
			source,
			prepared: null,
			status: "pending",
			translation: null,
			reason: null
		});
		this.dependencies.onStateChange(this);
		return true;
	}

	seal() {
		if (this.state != "collecting" || this.sealed) return false;
		this.sealed = true;
		this.sealedAt = safeTimestamp(this.now);
		this.dependencies.onStateChange(this);
		return true;
	}

	// Merges a not-yet-started sibling batch into this one (cadence audit 2026-08-19):
	// batches sealed behind a running job used to start one-by-one, each with its own
	// atomic commit and whole-layer rebuild. Returns the moved message ids so the
	// caller can repoint queue markers, or null when nothing may move.
	absorb(other) {
		if (this.state != "collecting" || this.started) return null;
		if (!other || other === this || other.state != "collecting" || other.started) return null;
		const movedMessageIds = [];
		for (const [messageId, record] of other.items) {
			if (this.items.has(messageId)) continue;
			this.items.set(messageId, record);
			movedMessageIds.push(messageId);
		}
		// The records now belong to this job; emptying the sibling first keeps its
		// cancelled state from flipping the moved records to cancelled.
		other.items = new Map();
		other.state = "cancelled";
		other.cancelReason = "merged";
		if (other.sealedAt != null) this.sealedAt = this.sealedAt == null ? other.sealedAt : Math.min(this.sealedAt, other.sealedAt);
		other.dependencies.onStateChange(other);
		if (movedMessageIds.length) this.dependencies.onStateChange(this);
		return movedMessageIds;
	}

	cancel(reason = "cancelled") {
		if (this.state == "committed" || this.state == "cancelled") return false;
		this.cancelReason = reason;
		this.state = "cancelled";
		for (const record of this.items.values()) if (!HISTORICAL_TERMINAL_ITEM_STATES.has(record.status)) record.status = "cancelled";
		try {this.dependencies.onCancel(this, reason);}
		catch (error) {}
		this.dependencies.onStateChange(this);
		return true;
	}

	invalidateMessage(messageId, reason = "source-changed") {
		if (this.state == "committed" || this.state == "cancelled") return false;
		const record = this.items.get(String(messageId));
		if (!record || record.status == "cancelled") return false;
		record.status = "cancelled";
		record.translation = null;
		record.reason = reason;
		try {this.dependencies.onInvalidate(this, String(messageId), reason);}
		catch (error) {}
		this.dependencies.onStateChange(this);
		return true;
	}

	isMessagePending(messageId) {
		const record = this.items.get(String(messageId));
		return !!record && this.state != "cancelled" && !HISTORICAL_TERMINAL_ITEM_STATES.has(record.status);
	}

	setPreparedOutcome(record, outcome) {
		outcome = outcome || {status: "failed", reason: "prepare_failed"};
		if (outcome.status == "translated") {
			record.status = "translated";
			record.translation = outcome.translation;
		}
		else if (outcome.status == "skipped") {
			record.status = "skipped";
			record.reason = outcome.reason || "skipped";
		}
		else if (outcome.status == "failed") {
			record.status = "failed";
			record.reason = outcome.reason || "failed";
		}
		else {
			record.status = "translating";
			record.prepared = outcome.prepared || record.source;
		}
	}

	createSummary() {
		const summary = {jobId: this.id, channelId: this.channelId, generation: this.generation, translated: [], skipped: [], failed: []};
		for (const record of this.items.values()) {
			const item = Object.assign({}, record.source, {translation: record.translation, reason: record.reason});
			if (record.prepared && record.prepared.wholeMarkerBatchFinal) Object.defineProperty(item, "wholeMarkerBatchFinal", {value: true, enumerable: false});
			if (record.prepared && record.prepared.semanticCompatibilityFallback) Object.defineProperty(item, "semanticCompatibilityFallback", {value: record.prepared.semanticCompatibilityFallback, enumerable: false});
			if (record.status == "translated") summary.translated.push(item);
			else if (record.status == "skipped") summary.skipped.push(item);
			else if (record.status == "failed") summary.failed.push(item);
		}
		return summary;
	}

	async start() {
		if (this.started) return this.runningPromise;
		this.sealed = true;
		if (this.sealedAt == null) this.sealedAt = safeTimestamp(this.now);
		this.started = true;
		this.state = "translating";
		this.dependencies.onStateChange(this);
		this.runningPromise = this.run();
		return this.runningPromise;
	}

	async run() {
		const progressive = typeof this.dependencies.commitProgress == "function";
		const validationCache = new Map(), progressOfferedIds = new Set();
		let progressChain = Promise.resolve(), progressStopped = false, primaryClosed = false;
		const sourceCurrent = record => {
			try {return this.state != "cancelled" && this.dependencies.isCurrent(this) && (!record || record.status != "cancelled");}
			catch (error) {return false;}
		};
		const resultCurrent = record => {
			try {return sourceCurrent(record) && !(record.prepared && record.prepared.wholeMarkerBatchFinal && !record.prepared.wholeMarkerBatchIsCurrent());}
			catch (error) {return false;}
		};
		const progressCurrent = event => {
			try {return !progressStopped && sourceCurrent() && (!event || !event.isCurrent || event.isCurrent());}
			catch (error) {return false;}
		};
		const commitProgress = async (records, event = null) => {
			if (!progressCurrent(event)) return;
			const proposed = records.filter(record => resultCurrent(record) && record.status == "translated" && !progressOfferedIds.has(String(record.source.message.id)));
			if (!proposed.length) return;
			const ids = new Set(proposed.map(record => String(record.source.message.id)));
			const summary = this.createSummary();
			summary.translated = summary.translated.filter(item => ids.has(String(item.message.id)));
			summary.skipped = []; summary.failed = [];
			Object.defineProperty(summary, "isCurrent", {value: () => progressCurrent(event) && proposed.every(resultCurrent), enumerable: false});
			for (const id of ids) progressOfferedIds.add(id);
			let ack;
			try {ack = await this.dependencies.commitProgress(summary, this);}
			catch (error) {return;}
			// A later global failure does not erase an accepted result. Cancellation
			// and source invalidation, unlike that failure, still reject a late ACK.
			// W5 grant currentness fences the proposal, not an already accepted store ACK.
			if (!progressStopped && !progressCurrent(event)) return;
			const accepted = new Set(ack && Array.isArray(ack.committedIds) ? ack.committedIds.map(String) : []);
			for (const record of proposed) if (sourceCurrent(record) && accepted.has(String(record.source.message.id))) this.progressCommittedIds.add(String(record.source.message.id));
		};
		const onChunkOutcome = event => {
			if (!progressive || primaryClosed || !event) return;
			const outcome = normalizeBatchOutcome(event.outcome);
			if (isTerminalProviderFailure(outcome.failureKind)) {
				if (outcome.failureKind !== "semantic_schema") progressStopped = true;
				return;
			}
			progressChain = progressChain.then(async () => {
				const records = [];
				for (const prepared of event.preparedItems || []) {
					const id = prepared && prepared.message && String(prepared.message.id), record = this.items.get(id);
					if (!progressCurrent(event) || !record || record.prepared !== prepared || !resultCurrent(record) || record.status !== "translating" || !outcome.translations || !Object.prototype.hasOwnProperty.call(outcome.translations, id)) continue;
					const raw = outcome.translations[id], cached = validationCache.get(record);
					let validation = cached && Object.is(cached.raw, raw) ? cached.validation : {ok: false};
					if (!cached || !Object.is(cached.raw, raw)) {
						try {validation = await this.dependencies.validate(prepared, raw, this) || {ok: false};}
						catch (error) {}
					}
					if (!progressCurrent(event) || !resultCurrent(record) || record.prepared !== prepared) continue;
					validationCache.set(record, {raw, validation});
					if (validation.ok) {record.status = "translated"; record.translation = validation.translation; records.push(record);}
					else if (validation.skipped) {record.status = "skipped"; record.reason = validation.reason || "skipped";}
				}
				await commitProgress(records, event);
			}).catch(() => {});
		};
		for (const record of this.items.values()) {
			if (this.state == "cancelled") return this.createSummary();
			if (record.status == "cancelled") continue;
			try {
				this.setPreparedOutcome(record, await this.dependencies.prepare(record.source, this));
			}
			catch (error) {
				this.setPreparedOutcome(record, {status: "failed", reason: "prepare_failed"});
			}
		}

		const translatingRecords = [...this.items.values()].filter(record => record.status == "translating");
		if (translatingRecords.length && this.state != "cancelled") {
			// Preparation can resolve cache hits before the remaining rows need a
			// provider. Publish that group on the existing display chain, without
			// making provider dispatch wait for its display acknowledgement.
			if (progressive) {
				const preparedTranslations = [...this.items.values()].filter(record => record.status == "translated");
				if (preparedTranslations.length) progressChain = progressChain.then(() => commitProgress(preparedTranslations));
			}
			let batchOutcome = null;
			try {
				batchOutcome = progressive ? await this.dependencies.translateBatch(translatingRecords.map(record => record.prepared), this, onChunkOutcome) : await this.dependencies.translateBatch(translatingRecords.map(record => record.prepared), this);
			}
			catch (error) {}
			primaryClosed = true;
			if (progressive) {
				const {failureKind} = normalizeBatchOutcome(batchOutcome);
				const scoped = failureKind === "semantic_schema" && (batchOutcome && batchOutcome.historicalFailureBlocks || []).some(block => block.failureKind === "semantic_schema");
				if (isTerminalProviderFailure(failureKind) && !scoped) progressStopped = true;
				await progressChain;
			}
			if (this.state == "cancelled") return this.createSummary();
			const {translations: resultMap, failureKind} = normalizeBatchOutcome(batchOutcome);
			const failureBlockById = new Map();
			// Only explicit block metadata localizes an exhausted typed/legacy response.
			// An unrelated missing row must not inherit that block's terminal failure.
			const inheritedFailureKind = failureKind === "semantic_schema" ? null : failureKind;
			for (const block of batchOutcome && batchOutcome.historicalFailureBlocks || []) for (const messageId of block && block.messageIds || []) failureBlockById.set(String(messageId), {blockId: block.blockId, failureKind: block.failureKind || inheritedFailureKind || null, physicalSettled: block.physicalSettled === true});
			const blockLocalSchemaFailure = failureKind === "semantic_schema" && [...failureBlockById.values()].some(block => block.failureKind === "semantic_schema");
			for (const record of translatingRecords) {
				if (record.status == "cancelled") continue;
				if (progressive && !sourceCurrent(record)) continue;
				if (progressive && this.progressCommittedIds.has(String(record.source.message.id))) continue;
				if (isTerminalProviderFailure(failureKind) && !blockLocalSchemaFailure) {
					if (progressive) record.translation = null;
					record.status = "failed";
					record.reason = `provider_${failureKind}`;
					continue;
				}
				if (progressive && (record.status == "translated" || record.status == "skipped")) continue;
				const messageId = String(record.source.message.id);
				const primaryFailureBlock = failureBlockById.get(messageId);
				if (failureKind == "transient" || primaryFailureBlock && primaryFailureBlock.failureKind === "transient") record.transientRetry = true;
				if (primaryFailureBlock && primaryFailureBlock.failureKind === "semantic_schema") {
					record.status = "failed";
					record.reason = "provider_semantic_schema";
					continue;
				}
				const rawTranslation = resultMap && Object.prototype.hasOwnProperty.call(resultMap, messageId) ? resultMap[messageId] : null;
				const cached = progressive && validationCache.get(record);
				let validation = cached && Object.is(cached.raw, rawTranslation) ? cached.validation : {ok: false};
				if (!cached || !Object.is(cached.raw, rawTranslation)) {
					try {validation = await this.dependencies.validate(record.prepared, rawTranslation, this) || {ok: false};}
					catch (error) {}
				}
				if (progressive && !sourceCurrent(record)) continue;
				if (validation.ok) {
					record.status = "translated";
					record.translation = validation.translation;
				}
				// A skip verdict is terminal. Sending it to "repairing" left the message showing
				// a spinner and bought a second serial request for an answer we already had.
				else if (validation.skipped) {
					record.status = "skipped";
					record.reason = validation.reason || "skipped";
				}
				else if (record.prepared && record.prepared.wholeMarkerBatchFinal) {record.status = "failed"; record.reason = validation.reason || record.prepared.wholeMarkerBatchFailureReason || "w5-unresolved";}
				else {
					const failureBlock = failureBlockById.get(messageId) || {blockId: "default", failureKind: failureKind || null, physicalSettled: false};
					record.status = "repairing";
					record.failureBlockId = failureBlock.blockId;
					record.failureKind = failureBlock.failureKind;
					record.timeoutSplitEligible = failureBlock.failureKind === "timeout" && failureBlock.physicalSettled;
					record.bypassBatchRepair = failureBlock.failureKind === "rate_limit" || failureBlock.failureKind === "server" || !!(record.prepared && record.prepared.classicPrimaryDispatched);
				}
			}
		}

		if (this.state == "cancelled") return this.createSummary();
		if (progressive) await commitProgress([...this.items.values()]);
		if (this.state == "cancelled") return this.createSummary();
		const unresolvedBatchRecords = [...this.items.values()].filter(record => record.status == "repairing");
		const batchRepairRecords = unresolvedBatchRecords.filter(record => !record.bypassBatchRepair);
		if (batchRepairRecords.length === 1 && batchRepairRecords[0].timeoutSplitEligible) {batchRepairRecords[0].status = "failed"; batchRepairRecords[0].reason = "provider_timeout";}
		if (batchRepairRecords.length > 1 && typeof this.dependencies.repairBatch == "function") {
			// A repair remains inside the primary block which failed. Transient blocks retry
			// intact within S3H limits; partial/malformed blocks keep the smaller repair size.
			const groups = [];
			const groupsByBlock = new Map();
			for (const record of batchRepairRecords) {
				const blockId = record.failureBlockId == null ? "default" : record.failureBlockId;
				let group = groupsByBlock.get(blockId);
				if (!group) {group = []; groupsByBlock.set(blockId, group); groups.push(group);}
				group.push(record);
			}
			const ordinaryChunkSize = Math.min(MAX_HISTORICAL_ITEMS_PER_ATTEMPT, this.repairBatchSize, Math.max(1, Math.ceil(translatingRecords.length / 2)));
			const repairChunks = groups.flatMap(group => {
				if (group.some(record => record.timeoutSplitEligible)) {
					if (group.length < 2) {for (const record of group) {record.status = "failed"; record.reason = "provider_timeout";} return [];}
					for (const record of group) record.timeoutSplitAttempted = true;
					const middle = Math.ceil(group.length / 2);
					return [group.slice(0, middle), group.slice(middle)].filter(chunk => chunk.length);
				}
				return partitionHistoricalRepairRecords(group, group.some(record => record.transientRetry) ? Math.min(MAX_HISTORICAL_ITEMS_PER_ATTEMPT, group.length) : ordinaryChunkSize);
			});
			for (const sourceChunk of repairChunks) {
				if (this.state == "cancelled") break;
				const chunk = sourceChunk.filter(record => record.status == "repairing");
				if (!chunk.length) continue;
				let repairOutcome = null;
				try {repairOutcome = await this.dependencies.repairBatch(chunk.map(record => record.prepared), this);}
				catch (error) {}
				if (this.state == "cancelled") return this.createSummary();
				const {translations: repairResultMap, failureKind: repairFailureKind} = normalizeBatchOutcome(repairOutcome);
				for (const record of chunk) {
					if (record.status == "cancelled") continue;
					if (isTerminalProviderFailure(repairFailureKind) || repairFailureKind == "transient") {
						record.status = "failed";
						record.reason = `provider_${repairFailureKind}`;
						continue;
					}
					if (repairFailureKind == "timeout") {record.status = "failed"; record.reason = "provider_timeout"; continue;}
					const messageId = String(record.source.message.id);
					const rawTranslation = repairResultMap && Object.prototype.hasOwnProperty.call(repairResultMap, messageId) ? repairResultMap[messageId] : null;
					let validation = {ok: false};
					try {validation = await this.dependencies.validate(record.prepared, rawTranslation, this) || {ok: false};}
					catch (error) {}
					if (validation.ok) {
						record.status = "translated";
						record.translation = validation.translation;
					}
					else if (validation.skipped) {
						record.status = "skipped";
						record.reason = validation.reason || "skipped";
					}
					else if (record.transientRetry) {
						record.status = "failed";
						record.reason = "provider_transient";
					}
				}
			}
		}

		if (this.state == "cancelled") return this.createSummary();
		this.state = "repairing";
		this.dependencies.onStateChange(this);
		const repairingRecords = [...this.items.values()].filter(record => record.status == "repairing");
		let repairIndex = 0;
		const repairNext = async () => {
			while (repairIndex < repairingRecords.length && this.state != "cancelled") {
				const record = repairingRecords[repairIndex++];
				if (!record || record.status == "cancelled") continue;
				let repairOutcome;
				try {repairOutcome = await this.dependencies.repair(record.prepared || record.source, this);}
				catch (error) {repairOutcome = {status: "failed", reason: "repair_failed"};}
				if (record.status == "cancelled") continue;
				this.setPreparedOutcome(record, repairOutcome);
				if (!HISTORICAL_TERMINAL_ITEM_STATES.has(record.status)) {
					record.status = "failed";
					record.reason = "repair_failed";
				}
			}
		};
		await Promise.all(Array.from({length: Math.min(this.repairConcurrency, repairingRecords.length)}, () => repairNext()));

		if (this.state == "cancelled") return this.createSummary();
		this.state = "ready";
		this.dependencies.onStateChange(this);
		await this.dependencies.waitForCommit(this);
		if (this.state == "cancelled" || !this.dependencies.isCurrent(this)) {
			this.cancel("stale_generation");
			return this.createSummary();
		}

		// Completed W5 blocks use the same display ACK ownership as typed blocks.
		// A later grant revoke cannot retract an accepted display; per-message source
		// invalidation and the finalizer's current view/source fences still apply.
		for (const record of this.items.values()) if (record.prepared && record.prepared.wholeMarkerBatchFinal && !this.progressCommittedIds.has(String(record.source.message.id)) && !record.prepared.wholeMarkerBatchIsCurrent()) {record.status = "cancelled"; record.translation = null;}
		const summary = this.createSummary();
		await this.dependencies.commit(summary, this);
		if (this.state == "cancelled") return this.createSummary();
		if (!this.dependencies.isCurrent(this)) {
			this.cancel("stale_after_commit");
			return this.createSummary();
		}
		this.state = "committed";
		this.dependencies.onStateChange(this);
		return summary;
	}
}

module.exports = {
	normalizeBatchOutcome,
	HISTORICAL_TERMINAL_ITEM_STATES,
	HISTORICAL_AI_BATCH_ITEM_LIMIT_MAX,
	// How long a collecting snapshot waits for more scroll-mounted rows before it
	// seals (cadence audit 2026-08-19). Historical rows have no 200ms display
	// contract - that ceiling protects live translations only.
	HISTORICAL_COLLECT_QUIET_MS: 500,
	HistoricalTranslationJob
};
