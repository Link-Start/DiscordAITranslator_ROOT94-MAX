// W3-fix: BetterDiscord resolves any non-whitelisted require (including "node:crypto") as a
// plugin-folder file and refuses to load the plugin; digests come from the pure JS SHA-256.
const {sha256Hex} = require("./sha256");
const {createProtectionLogic, MESSAGE_PLACES} = require("../protection/protection-logic");
const {planReceivedMarkdown, reassembleReceivedMarkdown} = require("../planner/received-markdown-lossless-planner");
const {
	CORE_SYSTEM_PROMPT,
	compileTypedPlan,
	parseTypedPlanResponse,
	resolveTypedRowAliases,
	isTranslatableOutputNode
} = require("../planner/translation-plan-serializer");
const {validateSegmentResponse} = require("../planner/translation-segment-validator");
// W2c: arm A is compiled and validated through the production typed-json path.
const {createSemanticRequest, validateSemanticResponse} = require("../planner/translation-semantic-runtime");
const {capabilityFor} = require("../planner/translation-plan-adapters");
const {
	buildSafeContext,
	buildCompactOrderRequest,
	parseCompactOrderResponse,
	reassembleCompactResponse
} = require("../planner/translation-compact-wire");
const {
	buildWholeMarkerRequest,
	buildWholeMarkerRepairRequest,
	parseWholeMarkerResponse,
	mergeWholeMarkerRepair,
	reassembleWholeMarkerResponse
} = require("../planner/translation-whole-marker-wire");
const {
	W2_FIXTURE_REVISION,
	W2_FIXTURE_MANIFEST_SHA256,
	W2B_FIXTURE_REVISION,
	W2B_FIXTURE_MANIFEST_SHA256,
	W2_ARMS,
	W2_BALANCED_ORDERS,
	W2_WARMUP_FIXTURE,
	W2_MEASURED_FIXTURES,
	W2_ALL_FIXTURES
} = require("./w2-wire-benchmark-fixtures");

const W2_SCHEMA_VERSION = "w2-1";
const W2_MAX_REQUESTS = 165;
const W2_MAX_OUTPUT_TOKENS = 4096;
const W2_MAX_BODY_BYTES = 65536;
const W2_DEFAULT_SAMPLES_PER_FIXTURE = 6;
// D (whole-marker) is selectable next to the frozen W2 arms; it is never in the default plan.
const W2B_ARM_KEYS = Object.freeze([...W2_ARMS, "D"]);
const ARM_FAMILIES = Object.freeze({A: "typed-json", Ba: "compact-order", Bm: "compact-marker", D: "whole-marker"});
const CJK_RE = /[\p{Script=Han}\p{Script=Bopomofo}]/u;
const LOCAL_MARKER_RE = /⟦(?:[CW])?\d+⟧/;
const COMPACT_MARKER_SCAN_RE = /⟦W(\d+)⟧/g;
const LIST_LINE_RE = /^\s*(?:[-*+]|\d+[.)])\s+/;
const RAW_LIST_RE = /^\s*(?:[-*+]|\d+[.)]|[A-Za-z][.)])\s+/;
const HEADING_LINE_RE = /^\s*#{1,6}\s/;

function utf8(value) {return Buffer.byteLength(String(value == null ? "" : value));}
function sha256(value) {return sha256Hex(String(value)).toUpperCase();}
function shortDigest(value) {return sha256Hex(String(value)).slice(0, 24);}
function freezeRows(rows) {return Object.freeze((rows || []).map(row => Object.freeze(Object.assign({}, row))));}
function nearestRank(values, percentile) {
	if (!values.length) return null;
	const sorted = values.slice().sort((a, b) => a - b);
	return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * percentile) - 1))];
}

function permutations(values) {
	if (values.length <= 1) return [values.slice()];
	const output = [];
	values.forEach((value, index) => {
		const rest = values.slice(0, index).concat(values.slice(index + 1));
		for (const tail of permutations(rest)) output.push([value, ...tail]);
	});
	return output;
}

function balancedOrdersFor(arms) {
	if (arms.length === W2_ARMS.length && arms.every((arm, index) => arm === W2_ARMS[index])) return W2_BALANCED_ORDERS;
	return Object.freeze(permutations(arms).map(order => Object.freeze(order)));
}

// The frozen W2 plan is the default (3 arms x 9 fixtures x 6 samples + 3 warm-ups = 165).
// W2b-0 subsets keep the same fixture bytes, warm-up rule and 165 hard cap; arms and
// fixtures are canonicalized so the preview identity does not depend on argument order.
// W2b may add arm D and the three extra fixtures explicitly.
function normalizeW2ScheduleOptions(options = {}) {
	const source = options && typeof options === "object" ? options : {};
	const fail = reason => Object.freeze({ok: false, reason});
	const requestedArms = source.arms == null ? W2_ARMS.slice() : Array.isArray(source.arms) ? source.arms.map(String) : null;
	if (!requestedArms || !requestedArms.length || requestedArms.some(arm => !W2B_ARM_KEYS.includes(arm))) return fail("arm");
	const arms = Object.freeze(W2B_ARM_KEYS.filter(arm => requestedArms.includes(arm)));
	const defaultFixtureIds = W2_MEASURED_FIXTURES.map(row => row.id), allFixtureIds = W2_ALL_FIXTURES.map(row => row.id);
	const requestedFixtures = source.fixtureIds == null ? defaultFixtureIds : Array.isArray(source.fixtureIds) ? source.fixtureIds.map(String) : null;
	if (!requestedFixtures || !requestedFixtures.length || requestedFixtures.some(id => !allFixtureIds.includes(id))) return fail("fixture");
	const fixtureIds = Object.freeze(allFixtureIds.filter(id => requestedFixtures.includes(id)));
	const samplesPerFixture = source.samplesPerFixture == null ? W2_DEFAULT_SAMPLES_PER_FIXTURE : Number(source.samplesPerFixture);
	if (!Number.isInteger(samplesPerFixture) || samplesPerFixture < 1) return fail("samples");
	const warmupRequests = arms.length, measuredRequests = arms.length * fixtureIds.length * samplesPerFixture, totalRequests = warmupRequests + measuredRequests;
	if (totalRequests > W2_MAX_REQUESTS) return fail("request-budget");
	return Object.freeze({ok: true, reason: null, arms, fixtureIds, samplesPerFixture, orders: balancedOrdersFor(arms), warmupRequests, measuredRequests, totalRequests, samplesPerArm: fixtureIds.length * samplesPerFixture});
}

function createW2Schedule(options) {
	const normalized = options && options.ok === true && Array.isArray(options.orders) ? options : normalizeW2ScheduleOptions(options);
	if (!normalized.ok) throw new TypeError(`w2-schedule-${normalized.reason}`);
	const rows = [];
	let trialId = 0;
	for (const arm of normalized.arms) rows.push(Object.freeze({trialId: trialId++, fixtureId: W2_WARMUP_FIXTURE.id, arm, warmup: true, orderId: null, position: null}));
	for (const fixtureId of normalized.fixtureIds) for (let orderId = 0; orderId < normalized.samplesPerFixture; orderId++) {
		const order = normalized.orders[orderId % normalized.orders.length];
		for (let position = 0; position < order.length; position++) rows.push(Object.freeze({trialId: trialId++, fixtureId, arm: order[position], warmup: false, orderId, position}));
	}
	return freezeRows(rows);
}

function fixtureById(id) {
	if (id === W2_WARMUP_FIXTURE.id) return W2_WARMUP_FIXTURE;
	return W2_ALL_FIXTURES.find(row => row.id === id) || null;
}

function createFixtureProtection(fixture) {
	const settings = {
		wordStart: ["!"],
		protectedTerms: [...(fixture.protectedTerms || [])],
		wrapperPairs: [...(fixture.wrapperPairs || [])],
		protectedTermsForReceived: true,
		wrapperPairsForReceived: true
	};
	const plugin = {
		settings: {exceptions: settings},
		getProtectedWrapperRules() {
			return settings.wrapperPairs.map(value => {
				const [left, right] = String(value).split("|");
				return {left, right};
			}).filter(row => row.left && row.right);
		}
	};
	return {plugin, logic: createProtectionLogic()};
}

function prepareFixture(fixture) {
	if (!fixture || fixture.synthetic !== true || sha256(fixture.source) !== fixture.sha256) return {ok: false, reason: "fixture-identity"};
	const protection = createFixtureProtection(fixture);
	const protectedSource = protection.logic.prepareSemanticSource(protection.plugin, fixture.source, MESSAGE_PLACES.RECEIVED);
	const plan = planReceivedMarkdown(protectedSource.source, {direction: "received", fieldPath: "body", targetLanguageId: fixture.targetLanguageId});
	const safe = buildSafeContext(plan, protectedSource.protectedSegments, {rawSourceBytes: utf8(fixture.source)});
	if (!safe.ok) return safe;
	return {ok: true, fixture, protection, protectedSource, plan, safe};
}

function wireObservation(request) {
	return Object.freeze({
		schemaVersion: "w0-1",
		wireFamily: request.wireFamily,
		wireVersion: request.wireVersion,
		sourceBytes: request.sourceBytes,
		translateBytes: request.translateBytes,
		wireBytes: request.wireBytes,
		promptBytes: request.systemPromptBytes,
		metadataBytes: request.metadataBytes,
		segmentCount: request.segmentCount,
		itemCount: request.segmentCount,
		contextBytes: request.contextIncluded ? utf8(request.safeContext || "") : 0,
		protectedMarkerBytes: request.contextMarkers ? request.contextMarkers.reduce((total, row) => total + utf8(row.token), 0) : 0,
		wireAmplification: request.sourceBytes > 0 ? request.wireBytes / request.sourceBytes : 0,
		contextIncluded: request.contextIncluded === true,
		protectedIntegrity: "unknown"
	});
}

function compileW2FixtureArm(fixture, arm, {maxOutputTokens = W2_MAX_OUTPUT_TOKENS, engineKey = "oaicompat"} = {}) {
	if (!W2B_ARM_KEYS.includes(arm)) return Object.freeze({ok: false, reason: "arm"});
	let prepared = prepareFixture(fixture);
	if (!prepared.ok) return Object.freeze(Object.assign({arm}, prepared));
	let request;
	if (arm === "D") {
		const whole = buildWholeMarkerRequest(prepared.plan, protectedSourceMap(prepared), {targetLanguageId: fixture.targetLanguageId, maxBodyBytes: W2_MAX_BODY_BYTES});
		if (!whole.ok) return Object.freeze(Object.assign({arm}, whole));
		request = Object.assign({}, whole, {arm, systemPrompt: whole.systemPrompt, userPrompt: whole.wire, contextIncluded: true, safeContext: whole.wire, sourceBytes: utf8(fixture.source)});
	}
	else if (arm === "A") {
		// The production wire: createSemanticRequest plans, merges inline protected ranges (P2)
		// and serializes exactly what the plugin sends; the harness never compiles the plan itself.
		// Every typed-json engine shares one wire; a harness engine key without that adapter
		// (fixture engines in tests) compiles through the generic OpenAI-compatible key.
		const typedEngine = capabilityFor(engineKey).adapter === "typed-json" ? engineKey : "oaicompat";
		const semantic = createSemanticRequest({engineKey: typedEngine, source: prepared.protectedSource.source, direction: "received", fieldPath: "body", inputLanguageId: "auto", targetLanguageId: fixture.targetLanguageId, maxBodyBytes: W2_MAX_BODY_BYTES});
		if (!semantic.enabled || semantic.adapter !== "typed-json") return Object.freeze({ok: false, reason: semantic.fallbackReason || "capability-unverified", arm});
		prepared = Object.assign({}, prepared, {plan: semantic.plan});
		const wireText = node => typeof node.wireText === "string" ? node.wireText : String(node.raw == null ? "" : node.raw);
		const translateBytes = semantic.plan.nodes.filter(isTranslatableOutputNode).reduce((total, node) => total + utf8(wireText(node)), 0);
		request = {
			ok: true,
			arm,
			wireFamily: "typed-json",
			wireVersion: semantic.semanticRevision,
			systemPrompt: semantic.systemPrompt,
			systemPromptBytes: utf8(semantic.systemPrompt),
			userPrompt: semantic.wire,
			wireBytes: semantic.bodyBytes,
			metadataBytes: semantic.bodyBytes - translateBytes,
			sourceBytes: utf8(fixture.source),
			translateBytes,
			segmentCount: semantic.segmentOrder.length,
			contextIncluded: Array.isArray(semantic.plan.contexts) && semantic.plan.contexts.length > 0,
			safeContext: prepared.safe.value,
			contextMarkers: prepared.safe.contextMarkers,
			plan: semantic.plan,
			protectedSegments: protectedSourceMap(prepared),
			semantic
		};
	}
	else {
		const compact = buildCompactOrderRequest(prepared.plan, prepared.safe, {
			responseMode: arm === "Bm" ? "marker" : "array",
			targetLanguageId: fixture.targetLanguageId,
			rawSourceBytes: utf8(fixture.source),
			protectedSegments: protectedSourceMap(prepared)
		});
		if (!compact.ok) return Object.freeze(Object.assign({arm}, compact));
		request = Object.assign({}, compact, {arm, systemPrompt: compact.systemPrompt, userPrompt: compact.wire});
	}
	const estimatedInputTokens = Math.ceil((utf8(request.systemPrompt) + utf8(request.userPrompt)) / 4);
	const publicRequest = {
		ok: true,
		reason: null,
		arm,
		wireFamily: ARM_FAMILIES[arm],
		wireVersion: request.wireVersion,
		sourceIdentity: fixture.sha256,
		systemPrompt: request.systemPrompt,
		userPrompt: request.userPrompt,
		estimatedInputTokens,
		estimatedOutputTokens: Number.isInteger(request.estimatedOutputTokens) ? request.estimatedOutputTokens : null,
		segmentCount: request.segmentCount,
		maxOutputTokens,
		wireObservation: wireObservation(Object.assign({}, request, {wireFamily: ARM_FAMILIES[arm]}))
	};
	Object.defineProperty(publicRequest, "local", {value: Object.freeze({prepared, request}), enumerable: false});
	return Object.freeze(publicRequest);
}

function protectedSourceMap(prepared) {return prepared.protectedSource.protectedSegments || Object.freeze({});}

function likelyTarget(value) {return /[\p{Script=Han}\p{Script=Bopomofo}]/u.test(String(value || ""));}
function similarity(source, target) {return String(source || "").trim() === String(target || "").trim() ? 1 : 0;}

function restoreTyped(prepared, valid) {
	const masked = reassembleReceivedMarkdown(prepared.plan, valid);
	return prepared.protection.logic.addSemanticExceptions(prepared.protection.plugin, masked, protectedSourceMap(prepared));
}

function checkFixtureOracle(fixture, translation) {
	for (const literal of fixture.preserveLiterals || []) if (!String(translation).includes(String(literal))) return "protected-integrity";
	if (fixture.orderOracle) {
		const sourceLines = String(fixture.source).split(/\r\n|\r|\n/), targetLines = String(translation).split(/\r\n|\r|\n/);
		for (const row of fixture.orderOracle) {
			const index = sourceLines.findIndex(line => line.toLowerCase().includes(String(row.source).toLowerCase()));
			if (index < 0 || !targetLines[index] || !(row.targetAny || []).some(value => targetLines[index].includes(value))) return "fixture-oracle";
		}
	}
	return null;
}

function validateW2ArmResponse(compiled, response) {
	if (!compiled || !compiled.ok || !compiled.local) return Object.freeze({ok: false, reason: "invalid-request"});
	const {prepared, request} = compiled.local;
	let translation = null, reason = null;
	if (compiled.arm === "D") {
		const parsed = parseWholeMarkerResponse(request, response, {likelyTarget, similarity, maxSimilarity: 0.94});
		if (!parsed.ok) reason = parsed.reason || "malformed";
		else translation = prepared.protection.logic.addSemanticExceptions(prepared.protection.plugin, reassembleWholeMarkerResponse(request, parsed.valid), protectedSourceMap(prepared));
		return finishValidation(compiled, prepared, translation, reason, {parsed});
	}
	else if (compiled.arm === "A") {
		// Production validation: typed row recovery, token multiset, restore of P2 local tokens.
		// softKeep off: the harness scores the wire strictly (P2 verdict); production keeps soft failures (P3).
		const outcome = validateSemanticResponse(request.semantic, response, {likelyTarget, similarity, maxSimilarity: 0.94, softKeep: false});
		if (!outcome.ok) reason = outcome.reason || "malformed";
		else translation = prepared.protection.logic.addSemanticExceptions(prepared.protection.plugin, outcome.translation, protectedSourceMap(prepared));
	}
	else {
		const parsed = parseCompactOrderResponse(request, response, {likelyTarget, similarity, maxSimilarity: 0.94});
		if (!parsed.ok) reason = parsed.reason || "malformed";
		else translation = reassembleCompactResponse(request, parsed.valid);
	}
	return finishValidation(compiled, prepared, translation, reason);
}

function finishValidation(compiled, prepared, translation, reason, hidden = {}, {forceIntegrityFail = false} = {}) {
	if (!reason && !translation) reason = "empty";
	if (!reason) reason = checkFixtureOracle(prepared.fixture, translation);
	const protectedIntegrity = forceIntegrityFail || reason === "protected-integrity" || reason === "placeholder-mismatch"
		? "fail"
		: translation != null ? "pass" : "unknown";
	const result = {ok: !reason, reason, valid: !reason, protectedIntegrity, orderDetectable: compiled.arm !== "Ba"};
	if (translation != null) Object.defineProperty(result, "translation", {value: String(translation), enumerable: false});
	for (const [key, value] of Object.entries(hidden)) Object.defineProperty(result, key, {value, enumerable: false});
	return Object.freeze(result);
}

// W2c ruling 3: when the first D answer is repairable (sound envelope, ranges missing or
// judged invalid) one repair request for exactly those ranges is dispatched and merged. A
// placeholder mismatch in the first answer keeps protectedIntegrity "fail": repair may fill
// the range, it may not hide that protected content was damaged once.
async function repairWholeMarkerTrial(compiled, provider, first, session, canDispatch) {
	const {prepared, request} = compiled.local;
	const parsed = first && first.parsed;
	const info = {requested: false, valid: null, reason: null, providerMs: null, usage: null, ordinals: parsed ? parsed.repairOrdinals : []};
	if (!parsed || first.ok || !parsed.repairable || !canDispatch()) return {validation: first, repair: info, repairProvider: null};
	const repairRequest = buildWholeMarkerRepairRequest(request, parsed.repairOrdinals);
	if (!repairRequest.ok) return {validation: first, repair: Object.assign(info, {requested: false, reason: repairRequest.reason || "request-build"}), repairProvider: null};
	const repairProvider = await session.dispatch({systemPrompt: repairRequest.systemPrompt, userPrompt: repairRequest.wire, wireObservation: {wireFamily: "whole-marker", wireVersion: repairRequest.wireVersion, wireBytes: repairRequest.bodyBytes, segmentCount: repairRequest.segmentCount}});
	info.requested = true;
	info.providerMs = repairProvider && Number.isFinite(Number(repairProvider.providerMs)) ? Math.max(0, Number(repairProvider.providerMs)) : null;
	info.usage = repairProvider && repairProvider.usage ? repairProvider.usage : null;
	if (!repairProvider || !repairProvider.ok) return {validation: first, repair: Object.assign(info, {valid: false, reason: repairProvider && repairProvider.reason || "provider-failed"}), repairProvider};
	const repairParsed = parseWholeMarkerResponse(repairRequest, repairProvider.text, {likelyTarget, similarity, maxSimilarity: 0.94});
	const merged = mergeWholeMarkerRepair(request, parsed, repairRequest, repairParsed);
	let reason = merged.ok ? null : merged.reason || "malformed", translation = null;
	if (!reason) translation = prepared.protection.logic.addSemanticExceptions(prepared.protection.plugin, reassembleWholeMarkerResponse(request, merged.valid), protectedSourceMap(prepared));
	const firstDamaged = first.protectedIntegrity === "fail" || (parsed.invalid || []).some(row => row.reason === "placeholder-mismatch");
	const validation = finishValidation(compiled, prepared, translation, reason, {parsed, repairParsed}, {forceIntegrityFail: firstDamaged});
	return {validation, repair: Object.assign(info, {valid: merged.ok, reason: merged.ok ? null : merged.reason || "malformed"}), repairProvider};
}

function codePoints(value) {return Array.from(String(value == null ? "" : value)).length;}
function wordCount(value) {return String(value == null ? "" : value).trim().split(/\s+/).filter(Boolean).length;}
function lineCount(value) {return String(value == null ? "" : value).split(/\r\n|\r|\n/).length;}
function nullableLength(value) {return typeof value === "string" ? codePoints(value) : null;}
function nullableCjk(value) {return typeof value === "string" ? CJK_RE.test(value) : null;}

function unwrapDiagnosticFence(raw) {
	const source = String(raw == null ? "" : raw).replace(/^\uFEFF/, "").trim();
	const fenced = /^```/.test(source) || /```$/.test(source);
	if (!fenced) return {source, fenced: false};
	return {source: source.replace(/^```[^\r\n]*\r?\n?/, "").replace(/\r?\n?```\s*$/, "").trim(), fenced: true};
}

// Segment inventory shared by every arm: the translatable plan nodes in plan order.
// Only lengths, flags and the containing line's Markdown role leave this function.
function segmentInventory(prepared, mapping) {
	const source = String(prepared.plan.source == null ? "" : prepared.plan.source);
	const nodes = prepared.plan.nodes.filter(isTranslatableOutputNode);
	const useMapping = Array.isArray(mapping) && mapping.length !== nodes.length;
	const rows = useMapping ? mapping.map(row => ({id: String(row.id || ""), raw: String(row.text == null ? "" : row.text), start: -1})) : nodes.map(node => ({id: String(node.id || ""), raw: String(node.raw == null ? "" : node.raw), start: Number.isInteger(node.sourceStart) ? node.sourceStart : -1}));
	return rows.map((row, index) => {
		let line = "";
		if (row.start >= 0) {
			const lineStart = Math.max(source.lastIndexOf("\n", row.start - 1), source.lastIndexOf("\r", row.start - 1)) + 1;
			const ends = [source.indexOf("\n", row.start), source.indexOf("\r", row.start)].filter(value => value >= 0);
			line = source.slice(lineStart, ends.length ? Math.min(...ends) : source.length);
		}
		return {
			index,
			id: row.id,
			raw: row.raw,
			sourceChars: codePoints(row.raw),
			sourceHasCjk: CJK_RE.test(row.raw),
			sourceLineCount: lineCount(row.raw),
			sourceWordCount: wordCount(row.raw),
			isListItem: RAW_LIST_RE.test(row.raw) || LIST_LINE_RE.test(line),
			isHeading: HEADING_LINE_RE.test(line)
		};
	});
}

function judgeSegmentText(sourceText, text) {
	if (typeof text !== "string") return "non-string-item";
	if (!text.trim()) return "empty";
	if (LOCAL_MARKER_RE.test(text)) return "placeholder-mismatch";
	if (!likelyTarget(text)) return "wrong-language";
	if (similarity(sourceText, text) >= 0.94) return "too-similar";
	return "ok";
}

function segmentRow(item, reason, text) {
	return Object.freeze({
		index: item.index,
		reason,
		sourceChars: item.sourceChars,
		targetChars: nullableLength(text),
		sourceHasCjk: item.sourceHasCjk,
		targetHasCjk: nullableCjk(text),
		sourceLineCount: item.sourceLineCount,
		sourceWordCount: item.sourceWordCount,
		isListItem: item.isListItem,
		isHeading: item.isHeading
	});
}

function structureRow(fields) {
	return Object.freeze({
		expectedItemCount: fields.expectedItemCount,
		receivedItemCount: fields.receivedItemCount,
		missingMarkerIndices: Object.freeze(fields.missing || []),
		duplicateMarkerIndices: Object.freeze(fields.duplicates || []),
		unknownMarkerCount: fields.unknown || 0,
		wrappedInCodeFence: fields.fenced === true,
		leadingChars: fields.leadingChars || 0,
		trailingChars: fields.trailingChars || 0,
		orderPreserved: fields.orderPreserved !== false,
		terminalMarkerPresent: fields.terminalMarkerPresent == null ? null : fields.terminalMarkerPresent === true,
		terminalMarkerLast: fields.terminalMarkerLast == null ? null : fields.terminalMarkerLast === true,
		outsideMarkerChars: Number.isInteger(fields.outsideMarkerChars) ? fields.outsideMarkerChars : null,
		closeMarkerEchoes: Number.isInteger(fields.closeMarkerEchoes) ? fields.closeMarkerEchoes : null,
		strayMarkerChars: Number.isInteger(fields.strayMarkerChars) ? fields.strayMarkerChars : null,
		windowed: fields.windowed == null ? null : fields.windowed === true,
		contextChars: Number.isInteger(fields.contextChars) ? fields.contextChars : null,
		contextCoveragePermille: Number.isInteger(fields.contextCoveragePermille) ? fields.contextCoveragePermille : null,
		firstPassValid: fields.firstPassValid == null ? null : fields.firstPassValid === true,
		repairRequested: fields.repairRequested === true,
		repairValid: fields.repairValid == null ? null : fields.repairValid === true,
		repairReason: fields.repairReason == null ? null : String(fields.repairReason),
		repairProviderMs: Number.isInteger(fields.repairProviderMs) ? fields.repairProviderMs : null,
		repairPromptTokens: Number.isInteger(fields.repairPromptTokens) ? fields.repairPromptTokens : null,
		repairCompletionTokens: Number.isInteger(fields.repairCompletionTokens) ? fields.repairCompletionTokens : null,
		responseChars: codePoints(fields.response),
		responseHasCjk: CJK_RE.test(String(fields.response == null ? "" : fields.response))
	});
}

function ascending(sequence) {return sequence.every((value, index) => index === 0 || sequence[index - 1] < value);}

function diagnoseTypedResponse(inventory, response, plan = null, aliases = null) {
	const {source, fenced} = unwrapDiagnosticFence(response);
	// The typed wire carries short labels; the inventory is keyed by plan ids.
	const rows = resolveTypedRowAliases(parseTypedPlanResponse(response), aliases);
	// With the P2 plan the per-segment verdict comes from the production validator (tokens are
	// expected inside translations); without it the W2b-0 heuristic stays for the other arms.
	const validated = plan && rows ? validateSegmentResponse(plan, rows, {likelyTarget, similarity, maxSimilarity: 0.94}) : null;
	const validatorReason = id => {if (!validated) return null; const invalid = validated.invalid.find(row => row.id === id); return invalid ? invalid.reason : Object.prototype.hasOwnProperty.call(validated.valid, id) ? "ok" : "missing-id";};
	const rootStart = source.search(/[{[]/), rootEnd = Math.max(source.lastIndexOf("}"), source.lastIndexOf("]"));
	const leadingChars = rootStart < 0 ? codePoints(source) : codePoints(source.slice(0, rootStart)), trailingChars = rootEnd < 0 ? 0 : codePoints(source.slice(rootEnd + 1));
	if (rows === null) return {segments: inventory.map(item => segmentRow(item, "malformed", null)), structure: structureRow({expectedItemCount: inventory.length, receivedItemCount: 0, fenced, leadingChars, trailingChars, response})};
	const byId = new Map(inventory.map(item => [item.id, item])), firstText = new Map(), duplicates = new Set(), sequence = [];
	let unknown = 0;
	for (const row of rows) {
		const id = String(row && row.id || "");
		const item = byId.get(id);
		if (!item) {unknown++; continue;}
		if (firstText.has(id)) {duplicates.add(item.index); continue;}
		firstText.set(id, String(row && row.translation || ""));
		sequence.push(item.index);
	}
	const segments = inventory.map(item => duplicates.has(item.index)
		? segmentRow(item, "duplicate-id", firstText.get(item.id))
		: !firstText.has(item.id) ? segmentRow(item, "missing-id", null) : segmentRow(item, validated ? validatorReason(item.id) : judgeSegmentText(item.raw, firstText.get(item.id)), firstText.get(item.id)));
	return {segments, structure: structureRow({expectedItemCount: inventory.length, receivedItemCount: firstText.size, missing: inventory.filter(item => !firstText.has(item.id)).map(item => item.index), duplicates: [...duplicates].sort((a, b) => a - b), unknown, fenced, leadingChars, trailingChars, orderPreserved: ascending(sequence), response})};
}

function diagnoseArrayResponse(inventory, response) {
	const {source, fenced} = unwrapDiagnosticFence(response);
	const rootStart = source.indexOf("["), rootEnd = source.lastIndexOf("]");
	const leadingChars = rootStart < 0 ? codePoints(source) : codePoints(source.slice(0, rootStart)), trailingChars = rootEnd < 0 ? 0 : codePoints(source.slice(rootEnd + 1));
	let parsed;
	try {parsed = JSON.parse(source);} catch {parsed = undefined;}
	const rootReason = parsed === undefined ? "malformed" : !Array.isArray(parsed) ? "unexpected-root" : null;
	if (rootReason) return {segments: inventory.map(item => segmentRow(item, rootReason, null)), structure: structureRow({expectedItemCount: inventory.length, receivedItemCount: 0, fenced, leadingChars, trailingChars, response})};
	const segments = inventory.map(item => item.index >= parsed.length ? segmentRow(item, "item-count", null) : segmentRow(item, judgeSegmentText(item.raw, parsed[item.index]), typeof parsed[item.index] === "string" ? parsed[item.index] : null));
	return {segments, structure: structureRow({expectedItemCount: inventory.length, receivedItemCount: Math.min(parsed.length, inventory.length), missing: inventory.filter(item => item.index >= parsed.length).map(item => item.index), unknown: Math.max(0, parsed.length - inventory.length), fenced, leadingChars, trailingChars, response})};
}

function diagnoseMarkerResponse(inventory, response) {
	const {source, fenced} = unwrapDiagnosticFence(response);
	const matches = [...source.matchAll(new RegExp(COMPACT_MARKER_SCAN_RE.source, "g"))], expected = inventory.length;
	const blocks = new Map(), duplicates = new Set(), sequence = [];
	let unknown = 0;
	for (let index = 0; index < matches.length; index++) {
		const ordinal = Number(matches[index][1]);
		if (!Number.isInteger(ordinal) || ordinal > expected) {unknown++; continue;}
		const start = matches[index].index + matches[index][0].length, end = index + 1 < matches.length ? matches[index + 1].index : source.length;
		const text = source.slice(start, end).replace(/\r?\n$/, "");
		if (blocks.has(ordinal)) {duplicates.add(ordinal); continue;}
		blocks.set(ordinal, text);
		if (ordinal < expected) sequence.push(ordinal);
	}
	const segments = inventory.map(item => duplicates.has(item.index)
		? segmentRow(item, "duplicate-marker", blocks.get(item.index))
		: !blocks.has(item.index) ? segmentRow(item, "missing-marker", null) : segmentRow(item, judgeSegmentText(item.raw, blocks.get(item.index)), blocks.get(item.index)));
	const terminalMarkerPresent = blocks.has(expected);
	// The strict parser also demands that the terminal marker be the final marker; a
	// terminal emitted before the last block shows up here as present-but-not-last.
	const terminalMarkerLast = matches.length > 0 && Number(matches[matches.length - 1][1]) === expected;
	return {segments, structure: structureRow({
		expectedItemCount: expected,
		receivedItemCount: sequence.length,
		missing: inventory.filter(item => !blocks.has(item.index)).map(item => item.index),
		duplicates: [...duplicates].filter(ordinal => ordinal < expected).sort((a, b) => a - b),
		unknown,
		fenced,
		leadingChars: matches.length ? codePoints(source.slice(0, matches[0].index)) : codePoints(source),
		trailingChars: terminalMarkerPresent ? codePoints(String(blocks.get(expected)).trim()) : 0,
		orderPreserved: ascending(sequence),
		terminalMarkerPresent,
		terminalMarkerLast,
		response
	})};
}

// D ranges are the inventory: one row per marked range, indexed from zero like the other
// arms. The parser already scanned the whole reply, so its structure fields are reused.
function diagnoseWholeMarkerResponse(request, response) {
	const parsed = parseWholeMarkerResponse(request, response, {likelyTarget, similarity, maxSimilarity: 0.94});
	const translations = parsed.translations || {};
	const invalidByOrdinal = new Map((parsed.invalid || []).map(row => [row.ordinal, row.reason]));
	const segments = request.ranges.map(range => {
		const text = Object.prototype.hasOwnProperty.call(translations, range.ordinal) ? translations[range.ordinal] : null;
		const reason = parsed.rootMalformed ? parsed.reason : invalidByOrdinal.get(range.ordinal) || "ok";
		return Object.freeze({
			index: range.ordinal - 1,
			reason,
			sourceChars: codePoints(range.text),
			targetChars: nullableLength(text),
			sourceHasCjk: range.hasCjk === true,
			targetHasCjk: nullableCjk(text),
			sourceLineCount: 1,
			sourceWordCount: wordCount(range.text),
			isListItem: range.kind === "list",
			isHeading: range.kind === "heading"
		});
	});
	const structure = parsed.structure || {};
	return {segments, structure: structureRow({
		expectedItemCount: request.ranges.length,
		receivedItemCount: structure.receivedItemCount || 0,
		missing: (structure.missingMarkerIndices || []).map(ordinal => ordinal - 1),
		duplicates: (structure.duplicateMarkerIndices || []).map(ordinal => ordinal - 1),
		unknown: structure.unknownMarkerCount || 0,
		fenced: structure.wrappedInCodeFence === true,
		leadingChars: structure.leadingChars || 0,
		trailingChars: structure.trailingChars || 0,
		orderPreserved: structure.orderPreserved !== false,
		terminalMarkerPresent: null,
		terminalMarkerLast: null,
		outsideMarkerChars: Number.isInteger(structure.outsideMarkerChars) ? structure.outsideMarkerChars : 0,
		closeMarkerEchoes: Number.isInteger(structure.closeMarkerEchoes) ? structure.closeMarkerEchoes : 0,
		strayMarkerChars: Number.isInteger(structure.strayMarkerChars) ? structure.strayMarkerChars : 0,
		windowed: request.windowed === true,
		contextChars: Number.isInteger(request.contextChars) ? request.contextChars : null,
		contextCoveragePermille: Number.isFinite(request.contextCoverage) ? Math.round(request.contextCoverage * 1000) : null,
		firstPassValid: parsed.ok === true,
		response
	})};
}

// Anonymous per-segment view of one provider response. Unlike the strict validator it
// keeps scanning after the first structural defect so a failed trial still explains
// which items were missing, duplicated, untranslated or wrapped. No text leaves here.
function diagnoseW2ArmResponse(compiled, response) {
	if (!compiled || !compiled.ok || !compiled.local) return Object.freeze({segments: Object.freeze([]), structure: null});
	const {prepared, request} = compiled.local;
	if (compiled.arm === "D") {
		const diagnosed = diagnoseWholeMarkerResponse(request, response);
		return Object.freeze({segments: Object.freeze(diagnosed.segments), structure: diagnosed.structure});
	}
	const inventory = segmentInventory(prepared, compiled.arm === "A" ? null : request.mapping);
	const diagnosed = compiled.arm === "A"
		? diagnoseTypedResponse(inventory, response, request.plan, request.semantic && request.semantic.segmentAliases || null)
		: compiled.arm === "Ba" ? diagnoseArrayResponse(inventory, response) : diagnoseMarkerResponse(inventory, response);
	return Object.freeze({segments: Object.freeze(diagnosed.segments), structure: diagnosed.structure});
}

function createArmCounter(arm, planned) {
	return {arm, planned, attempted: 0, succeeded: 0, failed: 0, timeout: 0, cancelled: 0, repairRequested: 0, repairValid: 0, providerMs: [], promptUsage: [], completionUsage: [], reasoningUsage: [], usageComplete: true, p50Ms: null, p95Ms: null, promptTokens: null, completionTokens: null, reasoningTokens: null, orderDetectable: arm !== "Ba"};
}

function finalizeArm(arm) {
	arm.p50Ms = arm.providerMs.length >= 20 ? nearestRank(arm.providerMs, 0.50) : null;
	arm.p95Ms = arm.providerMs.length >= 50 ? nearestRank(arm.providerMs, 0.95) : null;
	arm.promptTokens = arm.usageComplete && arm.promptUsage.length === arm.attempted ? arm.promptUsage.reduce((a, b) => a + b, 0) : null;
	arm.completionTokens = arm.usageComplete && arm.completionUsage.length === arm.attempted ? arm.completionUsage.reduce((a, b) => a + b, 0) : null;
	arm.reasoningTokens = arm.reasoningUsage.length === arm.attempted ? arm.reasoningUsage.reduce((a, b) => a + b, 0) : null;
	return Object.freeze({arm: arm.arm, planned: arm.planned, attempted: arm.attempted, succeeded: arm.succeeded, failed: arm.failed, timeout: arm.timeout, cancelled: arm.cancelled, repairRequested: arm.repairRequested, repairValid: arm.repairValid, p50Ms: arm.p50Ms, p95Ms: arm.p95Ms, promptTokens: arm.promptTokens, completionTokens: arm.completionTokens, reasoningTokens: arm.reasoningTokens, orderDetectable: arm.orderDetectable});
}

function withRepairDiagnostics(diagnostics, repair) {
	if (!diagnostics || !diagnostics.structure || !repair) return diagnostics;
	const usage = repair.usage && typeof repair.usage === "object" ? repair.usage : {};
	const structure = Object.freeze(Object.assign({}, diagnostics.structure, {
		repairRequested: repair.requested === true,
		repairValid: repair.requested ? repair.valid === true : null,
		repairReason: repair.requested && repair.valid !== true ? String(repair.reason || "unknown") : null,
		repairProviderMs: repair.requested && Number.isFinite(Number(repair.providerMs)) ? Math.round(Number(repair.providerMs)) : null,
		repairPromptTokens: repair.requested && usage.promptTokens != null ? Math.max(0, Math.round(Number(usage.promptTokens) || 0)) : null,
		repairCompletionTokens: repair.requested && usage.completionTokens != null ? Math.max(0, Math.round(Number(usage.completionTokens) || 0)) : null
	}));
	return Object.freeze({segments: diagnostics.segments, structure});
}

function sanitizeEvent(row, compiled, provider, validation, status, reason, diagnostics = null, requestCount = 1) {
	const usage = provider && provider.usage && typeof provider.usage === "object" ? Object.freeze({
		promptTokens: provider.usage.promptTokens == null ? null : Math.max(0, Number(provider.usage.promptTokens) || 0),
		completionTokens: provider.usage.completionTokens == null ? null : Math.max(0, Number(provider.usage.completionTokens) || 0),
		reasoningTokens: provider.usage.reasoningTokens == null ? null : Math.max(0, Number(provider.usage.reasoningTokens) || 0)
	}) : null;
	return Object.freeze({
		schemaVersion: W2_SCHEMA_VERSION,
		trialId: row.trialId,
		fixtureId: row.fixtureId,
		orderId: row.orderId,
		position: row.position,
		arm: compiled.wireFamily,
		warmup: row.warmup,
		providerMs: provider && Number.isFinite(Number(provider.providerMs)) ? Math.max(0, Number(provider.providerMs)) : null,
		status,
		httpStatus: provider && provider.httpStatus == null ? null : Math.max(0, Number(provider.httpStatus) || 0),
		errorClass: provider && provider.errorClass || null,
		valid: validation && validation.ok === true,
		protectedIntegrity: validation && validation.protectedIntegrity || "unknown",
		orderDetectable: validation ? validation.orderDetectable !== false : compiled.arm !== "Ba",
		requestCount: Math.max(1, Number(requestCount) || 1),
		wireBytes: compiled.wireObservation.wireBytes,
		usage,
		reason: reason || null,
		segmentDiagnostics: diagnostics ? diagnostics.segments : Object.freeze([]),
		structureDiagnostics: diagnostics ? diagnostics.structure : null
	});
}

function createW2WireBenchmark({providerClient, observationStore = null, now = Date.now} = {}) {
	if (!providerClient || typeof providerClient.getWireExperimentCapability !== "function" || typeof providerClient.createWireExperimentSession !== "function") throw new TypeError("W2 benchmark requires provider experiment client");
	let generation = 0, preview = null, confirmation = null, running = null, lastResult = null;

	function compileSchedule(schedule, maxOutputTokens, engineKey) {
		return createW2Schedule(schedule).map(row => {
			const fixture = fixtureById(row.fixtureId), request = compileW2FixtureArm(fixture, row.arm, {maxOutputTokens, engineKey});
			return {row, request};
		});
	}

	function prepare(engineKey, {maxOutputTokens = W2_MAX_OUTPUT_TOKENS, inputPricePerMillion = null, outputPricePerMillion = null, arms = null, fixtureIds = null, samplesPerFixture = null} = {}) {
		const capability = providerClient.getWireExperimentCapability(engineKey);
		if (!capability || !capability.ok) return Object.freeze({ok: false, reason: capability && capability.reason || "configuration"});
		const schedule = normalizeW2ScheduleOptions({arms, fixtureIds, samplesPerFixture});
		if (!schedule.ok) return Object.freeze({ok: false, reason: schedule.reason});
		const compiled = compileSchedule(schedule, maxOutputTokens, engineKey);
		const failed = compiled.find(row => !row.request.ok);
		if (failed) return Object.freeze({ok: false, reason: failed.request.reason || "compile"});
		const estimatedInputTokens = compiled.reduce((total, row) => total + row.request.estimatedInputTokens, 0), hardOutputTokenCap = compiled.length * maxOutputTokens;
		const outputEstimates = compiled.map(row => row.request.estimatedOutputTokens).filter(value => Number.isInteger(value));
		const estimatedOutputTokens = outputEstimates.length ? outputEstimates.reduce((total, value) => total + value, 0) : null;
		const knownPrice = inputPricePerMillion != null && outputPricePerMillion != null && Number.isFinite(Number(inputPricePerMillion)) && Number(inputPricePerMillion) >= 0 && Number.isFinite(Number(outputPricePerMillion)) && Number(outputPricePerMillion) >= 0;
		const maxCost = knownPrice ? (estimatedInputTokens * Number(inputPricePerMillion) + hardOutputTokenCap * Number(outputPricePerMillion)) / 1_000_000 : null;
		const identity = JSON.stringify({engineKey, configDigest: capability.configDigest, fixtureRevision: W2_FIXTURE_REVISION, fixtureManifest: W2_FIXTURE_MANIFEST_SHA256, extraFixtureRevision: W2B_FIXTURE_REVISION, extraFixtureManifest: W2B_FIXTURE_MANIFEST_SHA256, maxOutputTokens, arms: schedule.arms, fixtureIds: schedule.fixtureIds, samplesPerFixture: schedule.samplesPerFixture, requests: compiled.map(row => [row.row.trialId, row.request.sourceIdentity, row.request.arm, row.request.estimatedInputTokens])});
		const previewId = `w2p1:${shortDigest(identity)}`;
		preview = {ok: true, previewId, engineKey, capability, schedule, compiled, maxOutputTokens, estimatedInputTokens, hardOutputTokenCap, maxCost, identity};
		confirmation = null;
		return Object.freeze({ok: true, previewId, fixtureRevision: W2_FIXTURE_REVISION, fixtureManifestSha256: W2_FIXTURE_MANIFEST_SHA256, extraFixtureRevision: W2B_FIXTURE_REVISION, extraFixtureManifestSha256: W2B_FIXTURE_MANIFEST_SHA256, arms: schedule.arms, fixtureIds: schedule.fixtureIds, samplesPerFixture: schedule.samplesPerFixture, fixtureCount: schedule.fixtureIds.length, warmupRequests: schedule.warmupRequests, measuredRequests: schedule.measuredRequests, samplesPerArm: schedule.samplesPerArm, maxRequests: schedule.totalRequests, maxPhysicalRequests: schedule.totalRequests, hardRequestCap: W2_MAX_REQUESTS, maxOutputTokensPerRequest: maxOutputTokens, estimatedInputTokens, estimatedOutputTokens, hardOutputTokenCap, estimatedTotalTokenCap: estimatedInputTokens + hardOutputTokenCap, inputPricePerMillion: knownPrice ? Number(inputPricePerMillion) : null, outputPricePerMillion: knownPrice ? Number(outputPricePerMillion) : null, maxCost, currency: knownPrice ? "session-input" : null, concurrency: 1, cacheBypass: true, syntheticOnly: true, configDigest: capability.configDigest});
	}

	function confirm(previewId) {
		if (!preview || preview.previewId !== previewId || running) return null;
		confirmation = `w2-confirm:${shortDigest(`${preview.identity}:${++generation}`)}`;
		return confirmation;
	}

	function cancel(reason = "cancelled") {
		generation++;
		if (!running) return false;
		try {running.controller.abort(reason);} catch {}
		try {running.session.cancel(reason);} catch {}
		return true;
	}

	async function run(token, {onProgress = () => {}} = {}) {
		const accepted = !!(preview && confirmation && token === confirmation && !running);
		confirmation = null;
		if (!accepted) return Object.freeze({status: "failed", reason: "confirmation-required", completedRequests: 0, gateReady: false});
		const currentCapability = providerClient.getWireExperimentCapability(preview.engineKey);
		if (!currentCapability || !currentCapability.ok || currentCapability.configDigest !== preview.capability.configDigest) return Object.freeze({status: "stale", reason: "stale", completedRequests: 0, gateReady: false});
		const runGeneration = ++generation, controller = new AbortController(), schedule = preview.schedule;
		// Repairs share the 165-request hard cap with the planned trials.
		const session = providerClient.createWireExperimentSession(preview.engineKey, {maxRequests: W2_MAX_REQUESTS, maxOutputTokens: preview.maxOutputTokens, maxBodyBytes: W2_MAX_BODY_BYTES, signal: controller.signal});
		if (!session || !session.capability || !session.capability.ok) return Object.freeze({status: "failed", reason: session && session.capability && session.capability.reason || "configuration", completedRequests: 0, gateReady: false});
		let storeToken = null;
		if (observationStore && typeof observationStore.beginW2Session === "function") storeToken = observationStore.beginW2Session({fixtureSetVersion: W2_FIXTURE_REVISION, fixtureCount: schedule.fixtureIds.length, plannedArms: schedule.arms.map(arm => ARM_FAMILIES[arm]), plannedSamplesPerArm: schedule.samplesPerArm, plannedWarmupCount: schedule.warmupRequests, plannedLogicalRequests: schedule.totalRequests, plannedPhysicalRequests: schedule.totalRequests, estimatedPromptTokenCap: preview.estimatedInputTokens, completionTokenCap: preview.hardOutputTokenCap, estimatedCostMicrounits: preview.maxCost == null ? null : Math.round(preview.maxCost * 1_000_000)});
		const counters = Object.fromEntries(W2B_ARM_KEYS.map(arm => [arm, createArmCounter(arm, schedule.arms.includes(arm) ? schedule.samplesPerArm : 0)]));
		let completedRequests = 0, physicalRequests = 0, repairRequests = 0, consecutiveFailures = 0, status = "running", reason = null;
		const canDispatch = () => physicalRequests < W2_MAX_REQUESTS;
		running = {controller, session, runGeneration};
		try {
			for (const compiledRow of preview.compiled) {
				const {row, request} = compiledRow;
				if (generation !== runGeneration || controller.signal.aborted) {status = "cancelled"; reason = "cancelled"; break;}
				const capability = providerClient.getWireExperimentCapability(preview.engineKey);
				if (!capability || !capability.ok || capability.configDigest !== preview.capability.configDigest) {status = "stale"; reason = "stale"; break;}
				if (!canDispatch()) {status = "failed"; reason = "attempt-budget"; break;}
				const dispatchInput = {systemPrompt: request.systemPrompt, userPrompt: request.userPrompt, wireObservation: request.wireObservation};
				Object.defineProperty(dispatchInput, "localRequest", {value: request, enumerable: false});
				const provider = await session.dispatch(dispatchInput);
				completedRequests++;
				physicalRequests++;
				const first = provider && provider.ok ? validateW2ArmResponse(request, provider.text) : null;
				let validation = first, repair = null, requestCount = 1;
				if (row.arm === "D" && first && !first.ok && !row.warmup) {
					const settled = await repairWholeMarkerTrial(request, provider, first, session, canDispatch);
					validation = settled.validation;
					repair = settled.repair;
					if (repair.requested) {physicalRequests++; repairRequests++; requestCount = 2;}
				}
				const diagnostics = provider && provider.ok ? withRepairDiagnostics(diagnoseW2ArmResponse(request, provider.text), repair) : null;
				let trialStatus = provider && provider.ok && validation && validation.ok ? "ok" : provider && provider.reason === "timeout" ? "timeout" : provider && provider.reason === "cancelled" ? "cancelled" : "failed";
				const trialReason = trialStatus === "ok" ? null : validation && validation.reason || provider && provider.reason || "provider-failed";
				const event = sanitizeEvent(row, request, provider, validation, trialStatus, trialReason, diagnostics, requestCount);
				if (storeToken && observationStore && typeof observationStore.recordW2Trial === "function") observationStore.recordW2Trial(storeToken, event);
				if (observationStore && typeof observationStore.recordW2BenchmarkEvent === "function") observationStore.recordW2BenchmarkEvent(event);
				if (!row.warmup) {
					const arm = counters[row.arm]; arm.attempted++;
					if (event.providerMs != null) arm.providerMs.push(event.providerMs);
					if (trialStatus === "ok") arm.succeeded++; else {arm.failed++; if (trialStatus === "timeout") arm.timeout++; if (trialStatus === "cancelled") arm.cancelled++;}
					// Repair usage is added to the trial so arm totals count every request sent for it.
					const repairUsage = repair && repair.requested && repair.usage ? repair.usage : null;
					if (provider && provider.usage && provider.usage.promptTokens != null) arm.promptUsage.push(Number(provider.usage.promptTokens) + (repairUsage && repairUsage.promptTokens != null ? Number(repairUsage.promptTokens) : 0)); else arm.usageComplete = false;
					if (provider && provider.usage && provider.usage.completionTokens != null) arm.completionUsage.push(Number(provider.usage.completionTokens) + (repairUsage && repairUsage.completionTokens != null ? Number(repairUsage.completionTokens) : 0)); else arm.usageComplete = false;
					if (repair && repair.requested) arm.repairRequested++;
					if (repair && repair.requested && repair.valid === true) arm.repairValid++;
					if (provider && provider.usage && provider.usage.reasoningTokens != null) arm.reasoningUsage.push(Number(provider.usage.reasoningTokens));
				}
				if (provider && provider.ok) consecutiveFailures = 0; else consecutiveFailures++;
				try {onProgress(Object.freeze({completed: completedRequests, total: schedule.totalRequests, fixtureId: row.fixtureId, arm: row.arm, orderId: row.orderId, position: row.position, warmup: row.warmup}));} catch {}
				if (trialStatus === "cancelled") {status = "cancelled"; reason = "cancelled"; break;}
				if (consecutiveFailures >= 2) {status = "failed"; reason = "consecutive-failures"; break;}
			}
			if (status === "running") status = completedRequests === schedule.totalRequests ? "complete" : "failed";
		}
		finally {
			try {await session.drain();} catch {}
			if (storeToken && observationStore) {
				if (status === "complete" && typeof observationStore.finishW2Session === "function") observationStore.finishW2Session(storeToken);
				else if (status === "cancelled" && typeof observationStore.cancelW2Session === "function") observationStore.cancelW2Session(storeToken);
				else if (typeof observationStore.failW2Session === "function") observationStore.failW2Session(storeToken, reason || "unknown");
			}
			running = null;
		}
		// The frozen three-arm gate is unchanged: only the full 3 x 54 plan can ready it. D is
		// reported next to the W2 arms but judged by the W2b analysis, not by this gate.
		const arms = Object.freeze(Object.fromEntries(W2B_ARM_KEYS.map(arm => [arm, finalizeArm(counters[arm])]))), gateReady = status === "complete" && W2_ARMS.every(arm => arms[arm].attempted === 54 && arms[arm].p95Ms != null && arms[arm].promptTokens != null && arms[arm].completionTokens != null);
		lastResult = Object.freeze({schemaVersion: W2_SCHEMA_VERSION, status, reason, completedRequests, physicalRequests, repairRequests, maxRequests: schedule.totalRequests, hardRequestCap: W2_MAX_REQUESTS, gateReady, configDigest: preview.capability.configDigest, arms});
		return lastResult;
	}

	function getSnapshot() {return lastResult || Object.freeze({schemaVersion: W2_SCHEMA_VERSION, status: running ? "running" : "idle", reason: null, completedRequests: 0, maxRequests: W2_MAX_REQUESTS, gateReady: false});}
	return Object.freeze({prepare, confirm, run, cancel, getSnapshot});
}

module.exports = {
	W2_SCHEMA_VERSION,
	W2_MAX_REQUESTS,
	W2_MAX_OUTPUT_TOKENS,
	W2_DEFAULT_SAMPLES_PER_FIXTURE,
	W2B_ARM_KEYS,
	normalizeW2ScheduleOptions,
	createW2Schedule,
	compileW2FixtureArm,
	validateW2ArmResponse,
	diagnoseW2ArmResponse,
	createW2WireBenchmark
};
