// Builds bounded, anonymous measurements for the exact text a provider can see.
// This module is deliberately stateless: source/prompt/protected values are consumed
// synchronously and only numeric fields leave either public function.

const WIRE_OBSERVATION_SCHEMA_VERSION = "w0-1";
const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_PROMPT_BYTES = 1024 * 1024;
const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;
const MAX_COUNT = 4096;
const MAX_AMPLIFICATION = 1024;
const MAX_SCANNER_VALUES_PER_CLASS = 4096;
const MAX_SCANNED_TEXT_CODE_UNITS = 1024 * 1024;
const MAX_SCANNER_VALUE_CODE_UNITS = 4096;
const MAX_SCANNER_PATTERN_CODE_UNITS = 65536;

const WIRE_FAMILIES = new Set([
	"typed",
	"typed-json",
	"native",
	"native-multi",
	"classic",
	"classic-marked",
	"classic-tagged",
	"legacy",
	"legacy-single",
	"legacy-batch",
	// Reserved W-series families. Keeping the finite vocabulary here lets W1/W2 use
	// the same producer without weakening W0's public schema.
	"compact-order",
	"compact-marker", "whole-marker",
	"whole",
	"unknown"
]);

const LEAK_FIELDS = Object.freeze([
	["configuredTerms", "configuredTermLeakCount"],
	["wrapperContents", "wrapperContentLeakCount"],
	["emails", "emailLeakCount"],
	["bareDomains", "bareDomainLeakCount"],
	["ipPorts", "ipPortLeakCount"],
	["commands", "commandLeakCount"]
]);
const probePrivate = new WeakMap();

function utf8Bytes(value) {
	try {return Buffer.byteLength(String(value == null ? "" : value), "utf8");}
	catch (error) {return 0;}
}

function boundedWhole(value, maximum = MAX_COUNT, fallback = 0) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.max(0, Math.min(maximum, Math.floor(number))) : fallback;
}

function boundedBytes(value, maximum) {
	return Math.min(maximum, utf8Bytes(value));
}

function safeWireFamily(value) {
	const family = String(value || "").toLowerCase();
	return WIRE_FAMILIES.has(family) ? family : "unknown";
}

function safeWireVersion(value) {
	const version = String(value || "");
	return /^[A-Za-z0-9._:-]{1,32}$/.test(version) ? version : null;
}

function normalizeLeakCounts(value) {
	const source = value && typeof value == "object" && !Array.isArray(value) ? value : {};
	const output = {};
	let total = 0;
	for (const [, field] of LEAK_FIELDS) {
		output[field] = boundedWhole(source[field]);
		total += output[field];
	}
	const requestedIntegrity = String(source.protectedIntegrity || "").toLowerCase();
	output.protectedIntegrity = ["pass", "fail", "unknown"].includes(requestedIntegrity)
		? requestedIntegrity
		: total ? "fail" : "unknown";
	return Object.freeze(output);
}

function createWireObservation(options = {}) {
	const sourceBytes = options.sourceBytes == null ? boundedBytes(options.source, MAX_SOURCE_BYTES) : boundedWhole(options.sourceBytes, MAX_SOURCE_BYTES);
	const wireBytes = options.wireBytes == null ? boundedBytes(options.wire, MAX_REQUEST_BODY_BYTES) : boundedWhole(options.wireBytes, MAX_REQUEST_BODY_BYTES);
	const visibleTexts = Array.isArray(options.providerVisibleTexts) ? options.providerVisibleTexts : [];
	const translateSegments = Array.isArray(options.translateSegments) ? options.translateSegments : [];
	const promptBytes = options.promptBytes == null ? Math.min(MAX_PROMPT_BYTES, visibleTexts.reduce((total, value) => total + utf8Bytes(value), 0)) : boundedWhole(options.promptBytes, MAX_PROMPT_BYTES);
	const translateBytes = options.translateBytes == null ? Math.min(MAX_SOURCE_BYTES, translateSegments.reduce((total, value) => total + utf8Bytes(value), 0)) : boundedWhole(options.translateBytes, MAX_SOURCE_BYTES);
	const contextBytes = options.contextBytes == null ? boundedBytes(options.contextText, MAX_SOURCE_BYTES) : boundedWhole(options.contextBytes, MAX_SOURCE_BYTES);
	const markerText = options.protectedMarkerText == null ? visibleTexts.flatMap(value => String(value || "").match(/⟦\d+⟧/g) || []).join("") : options.protectedMarkerText;
	const protectedMarkerBytes = boundedBytes(markerText, MAX_SOURCE_BYTES);
	const leakCounts = normalizeLeakCounts(options.leakCounts);
	const wireAmplification = sourceBytes > 0 ? Math.min(MAX_AMPLIFICATION, wireBytes / sourceBytes) : null;
	return Object.freeze({
		schemaVersion: WIRE_OBSERVATION_SCHEMA_VERSION,
		wireFamily: safeWireFamily(options.wireFamily),
		wireVersion: safeWireVersion(options.wireVersion),
		sourceBytes,
		translateBytes,
		wireBytes,
		promptBytes,
		metadataBytes: Math.min(MAX_PROMPT_BYTES, Math.max(0, promptBytes - translateBytes)),
		requestBodyBytes: options.requestBodyBytes == null ? options.requestBody == null ? null : boundedBytes(options.requestBody, MAX_REQUEST_BODY_BYTES) : boundedWhole(options.requestBodyBytes, MAX_REQUEST_BODY_BYTES),
		wireAmplification,
		segmentCount: boundedWhole(options.segmentCount == null ? translateSegments.length : options.segmentCount),
		itemCount: boundedWhole(options.itemCount, MAX_COUNT, 1),
		contextIncluded: options.contextIncluded === true,
		contextBytes,
		protectedMarkerBytes,
		prohibitedFieldCount: boundedWhole(options.prohibitedFieldCount),
		danglingContextRefCount: options.danglingContextRefCount == null ? null : boundedWhole(options.danglingContextRefCount),
		danglingContextRefBytes: options.danglingContextRefBytes == null ? null : boundedWhole(options.danglingContextRefBytes, MAX_SOURCE_BYTES),
		configuredTermLeakCount: leakCounts.configuredTermLeakCount,
		wrapperContentLeakCount: leakCounts.wrapperContentLeakCount,
		emailLeakCount: leakCounts.emailLeakCount,
		bareDomainLeakCount: leakCounts.bareDomainLeakCount,
		ipPortLeakCount: leakCounts.ipPortLeakCount,
		commandLeakCount: leakCounts.commandLeakCount,
		protectedIntegrity: leakCounts.protectedIntegrity
	});
}

function escapeRegExp(value) {return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");}

function scannerValues(value) {
	const input = Array.isArray(value) ? value : [];
	const unique = new Set();
	let patternCodeUnits = 0;
	for (const item of input) {
		const text = String(item == null ? "" : item).slice(0, MAX_SCANNER_VALUE_CODE_UNITS);
		if (!text || unique.has(text)) continue;
		if (patternCodeUnits + text.length > MAX_SCANNER_PATTERN_CODE_UNITS) break;
		unique.add(text);
		patternCodeUnits += text.length;
		if (unique.size >= MAX_SCANNER_VALUES_PER_CLASS) break;
	}
	return [...unique].sort((left, right) => right.length - left.length);
}

function encodedVariants(value) {
	const variants = [value];
	try {
		const encoded = JSON.stringify(value);
		const inner = encoded && encoded.length >= 2 ? encoded.slice(1, -1) : "";
		if (inner && inner !== value) variants.push(inner);
	}
	catch (error) {}
	return variants;
}

function createCounter(values) {
	const alternatives = new Set();
	for (const value of scannerValues(values)) for (const variant of encodedVariants(value)) alternatives.add(escapeRegExp(variant));
	if (!alternatives.size) return () => 0;
	const regex = new RegExp([...alternatives].sort((left, right) => right.length - left.length).join("|"), "gi");
	return value => {
		const text = String(value == null ? "" : value).slice(0, MAX_SCANNED_TEXT_CODE_UNITS);
		let count = 0;
		regex.lastIndex = 0;
		while (regex.exec(text)) {
			count++;
			if (count >= MAX_COUNT) break;
			if (regex.lastIndex === 0) regex.lastIndex++;
		}
		return count;
	};
}

function createProtectionLeakScanner(protectedValues = {}) {
	const counters = LEAK_FIELDS.map(([sourceField, outputField]) => [outputField, createCounter(protectedValues[sourceField])]);
	function scan(providerVisibleTexts) {
		const texts = Array.isArray(providerVisibleTexts) ? providerVisibleTexts : [providerVisibleTexts];
		const result = {}, totals = Object.fromEntries(counters.map(([field]) => [field, 0]));
		for (const text of texts) for (const [field, count] of counters) totals[field] = Math.min(MAX_COUNT, totals[field] + count(text));
		let total = 0;
		for (const [, field] of LEAK_FIELDS) {result[field] = totals[field]; total += totals[field];}
		result.protectedIntegrity = total ? "fail" : "pass";
		return Object.freeze(result);
	}
	return Object.freeze({scan});
}

function parseBody(value) {
	try {return typeof value == "string" ? JSON.parse(value) : value;}
	catch (error) {return null;}
}

function collectTextParts(value, output) {
	if (typeof value == "string") {output.push(value); return;}
	if (Array.isArray(value)) {for (const item of value) collectTextParts(item, output); return;}
	if (!value || typeof value != "object") return;
	if (typeof value.text == "string") output.push(value.text);
	else if (Array.isArray(value.text)) collectTextParts(value.text, output);
	if (typeof value.Text == "string") output.push(value.Text);
	else if (Array.isArray(value.Text)) collectTextParts(value.Text, output);
	if (typeof value.content == "string") output.push(value.content);
	else if (Array.isArray(value.content)) collectTextParts(value.content, output);
	if (Array.isArray(value.parts)) collectTextParts(value.parts, output);
}

function providerVisibleTextsFromBody(requestBody) {
	const parsed = parseBody(requestBody);
	if (!parsed || typeof parsed != "object") return [String(requestBody || "")];
	const output = [];
	if (Array.isArray(parsed)) {collectTextParts(parsed, output); return output;}
	for (const key of ["instructions", "input", "system", "prompt", "q", "text", "Text"]) if (parsed[key] != null) collectTextParts(parsed[key], output);
	for (const key of ["messages", "contents", "system_instruction"]) if (parsed[key] != null) collectTextParts(parsed[key], output);
	return output;
}

function countProhibitedFields(value) {
	const prohibited = new Set(["id", "contextIds", "contexts", "schemaVersion", "semanticRevision", "document", "direction", "fieldPath", "plannerVersion", "sourceLength"]);
	let count = 0;
	const visit = item => {
		if (Array.isArray(item)) {for (const child of item) visit(child); return;}
		if (!item || typeof item != "object") return;
		for (const [key, child] of Object.entries(item)) {if (prohibited.has(key)) count++; visit(child);}
	};
	visit(value);
	return Math.min(MAX_COUNT, count);
}

function analyzeWire(request) {
	const wire = String(request && request.wire || "");
	const parsed = parseBody(wire);
	const order = new Set([].concat(request && request.segmentOrder || []).map(String));
	const nodes = request && request.plan && Array.isArray(request.plan.nodes) ? request.plan.nodes : [];
	const translateSegments = nodes.filter(node => order.has(String(node && node.id))).map(node => String(node && node.raw || ""));
	const contexts = parsed && (parsed.contexts || parsed.context) || [];
	const segments = parsed && Array.isArray(parsed.segments) ? parsed.segments : [];
	const refs = segments.flatMap(segment => Array.isArray(segment && segment.contextIds) ? segment.contextIds : []);
	return {
		wire,
		translateSegments,
		contextIncluded: Array.isArray(contexts) && contexts.length > 0,
		contextText: Array.isArray(contexts) ? JSON.stringify(contexts) : "",
		prohibitedFieldCount: parsed ? countProhibitedFields(parsed) : 0,
		danglingContextRefCount: refs.length,
		danglingContextRefBytes: refs.reduce((total, id) => total + utf8Bytes(JSON.stringify(id)), 0)
	};
}

function classifyProtectedValues({source = "", protectedSegments = {}, configuredTerms = [], wrapperRules = []} = {}) {
	const values = Object.values(protectedSegments || {}).map(value => String(value || "")).filter(Boolean);
	const sourceText = String(source || "");
	const configured = [];
	const boundaryChars = "A-Za-z0-9_";
	for (const term of scannerValues(configuredTerms)) {
		const startsWithWord = new RegExp(`^[${boundaryChars}]`).test(term), endsWithWord = new RegExp(`[${boundaryChars}]$`).test(term);
		const pattern = term.split(/\s+/).filter(Boolean).map(escapeRegExp).join("\\s*");
		const regex = new RegExp(`${startsWithWord ? `(^|[^${boundaryChars}])` : `()`}(${pattern})${endsWithWord ? `(?=$|[^${boundaryChars}])` : ""}`, "gi");
		for (const match of sourceText.matchAll(regex)) if (match[2]) configured.push(match[2]);
	}
	const wrapped = values.filter(value => [].concat(wrapperRules || []).some(rule => rule && value.startsWith(String(rule.left || "")) && value.endsWith(String(rule.right || ""))));
	const emails = values.filter(value => /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,24}$/i.test(value));
	const ipPorts = values.filter(value => /^(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?$/.test(value));
	const commands = values.filter(value => /^\/[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(value));
	const bareDomains = values.filter(value => !emails.includes(value) && !ipPorts.includes(value) && /^(?:https?:\/\/|www\.)?[a-z0-9.-]+\.[a-z]{2,24}(?::\d{1,5})?(?:[/?#].*)?$/i.test(value));
	return {configuredTerms: configured, wrapperContents: wrapped, emails, bareDomains, ipPorts, commands};
}

function createWireObservationProbe({source = "", request = null, wireFamily = null, wireVersion = null, wire = null, translateSegments = null, itemCount = 1, protectedSegments = {}, configuredTerms = [], wrapperRules = []} = {}) {
	const analysis = request ? analyzeWire(request) : {wire: String(wire || ""), translateSegments: [].concat(translateSegments || []), contextIncluded: false, contextText: "", prohibitedFieldCount: 0, danglingContextRefCount: null, danglingContextRefBytes: null};
	const family = wireFamily || request && request.adapter || "legacy-single";
	const version = wireVersion || request && (request.wireVersion || request.semanticRevision) || "legacy";
	const protectedValues = classifyProtectedValues({source, protectedSegments, configuredTerms, wrapperRules});
	const scanner = createProtectionLeakScanner(protectedValues);
	const numericSeed = Object.freeze({
		sourceBytes: boundedBytes(source, MAX_SOURCE_BYTES),
		wireBytes: boundedBytes(analysis.wire, MAX_REQUEST_BODY_BYTES),
		translateBytes: Math.min(MAX_SOURCE_BYTES, analysis.translateSegments.reduce((total, value) => total + utf8Bytes(value), 0)),
		segmentCount: analysis.translateSegments.length,
		itemCount: boundedWhole(itemCount, MAX_COUNT, 1),
		contextIncluded: analysis.contextIncluded,
		contextBytes: boundedBytes(analysis.contextText, MAX_SOURCE_BYTES),
		prohibitedFieldCount: analysis.prohibitedFieldCount,
		danglingContextRefCount: analysis.danglingContextRefCount,
		danglingContextRefBytes: analysis.danglingContextRefBytes
	});
	const scan = providerVisibleTexts => scanner.scan(providerVisibleTexts);
	const observe = requestBody => {
		const providerVisibleTexts = providerVisibleTextsFromBody(requestBody);
		const parsedRequest = parseBody(requestBody), physicalText = parsedRequest && typeof parsedRequest.q == "string" ? parsedRequest.q : null;
		const markerPattern = /__DTA_(\d+)__|⟦(\d+)⟧/g;
		const physicalMarkers = family === "classic-marked" && physicalText != null ? [...physicalText.matchAll(markerPattern)] : [];
		const terminalMarkerPresent = physicalMarkers.some(match => Number(match[1] == null ? match[2] : match[1]) === numericSeed.segmentCount);
		const physicalTranslateText = family === "classic-marked" && physicalText != null ? physicalText.replace(/\r?\n(?=(?:__DTA_\d+__|⟦\d+⟧))/g, "").replace(/(?:__DTA_\d+__|⟦\d+⟧)\r?\n?/g, "") : "";
		const physical = family === "classic-marked" && physicalText != null ? {
			wireBytes: utf8Bytes(physicalText),
			translateBytes: utf8Bytes(physicalTranslateText),
			segmentCount: Math.max(0, physicalMarkers.length - (terminalMarkerPresent ? 1 : 0))
		} : {};
		return createWireObservation(Object.assign({}, numericSeed, physical, {wireFamily: family, wireVersion: version, providerVisibleTexts, requestBody, leakCounts: scan(providerVisibleTexts)}));
	};
	const local = () => createWireObservation(Object.assign({}, numericSeed, {wireFamily: family, wireVersion: version, providerVisibleTexts: [], requestBody: null, leakCounts: scan([])}));
	const probe = Object.freeze({seed: numericSeed, scan, observe, local});
	probePrivate.set(probe, {protectedValues});
	return probe;
}

function combineWireObservationProbes(probes, {wireFamily = "legacy-batch", wireVersion = "legacy", wire = "", translateSegments = [], itemCount = null} = {}) {
	const list = [].concat(probes || []).filter(probe => probe && probe.seed && typeof probe.scan == "function");
	const protectedValues = Object.fromEntries(LEAK_FIELDS.map(([field]) => [field, []]));
	for (const probe of list) {const state = probePrivate.get(probe); for (const [field] of LEAK_FIELDS) protectedValues[field].push(...[].concat(state && state.protectedValues && state.protectedValues[field] || []));}
	const scanner = createProtectionLeakScanner(protectedValues);
	const parsedWire = parseBody(wire);
	const seed = Object.freeze({
		sourceBytes: list.reduce((total, probe) => total + boundedWhole(probe.seed.sourceBytes, MAX_SOURCE_BYTES), 0),
		wireBytes: boundedBytes(wire, MAX_REQUEST_BODY_BYTES),
		translateBytes: translateSegments.length ? translateSegments.reduce((total, value) => total + utf8Bytes(value), 0) : list.reduce((total, probe) => total + boundedWhole(probe.seed.translateBytes, MAX_SOURCE_BYTES), 0),
		segmentCount: translateSegments.length || list.reduce((total, probe) => total + boundedWhole(probe.seed.segmentCount, MAX_COUNT), 0),
		itemCount: itemCount == null ? list.length : boundedWhole(itemCount, MAX_COUNT),
		contextIncluded: list.some(probe => probe.seed.contextIncluded),
		contextBytes: list.reduce((total, probe) => total + boundedWhole(probe.seed.contextBytes, MAX_SOURCE_BYTES), 0),
		prohibitedFieldCount: parsedWire ? countProhibitedFields(parsedWire) : list.reduce((total, probe) => total + boundedWhole(probe.seed.prohibitedFieldCount, MAX_COUNT), 0),
		danglingContextRefCount: list.reduce((total, probe) => total + boundedWhole(probe.seed.danglingContextRefCount, MAX_COUNT), 0),
		danglingContextRefBytes: list.reduce((total, probe) => total + boundedWhole(probe.seed.danglingContextRefBytes, MAX_SOURCE_BYTES), 0)
	});
	const observe = requestBody => {
		const providerVisibleTexts = providerVisibleTextsFromBody(requestBody);
		return createWireObservation(Object.assign({}, seed, {wireFamily, wireVersion, providerVisibleTexts, requestBody, leakCounts: scanner.scan(providerVisibleTexts)}));
	};
	return Object.freeze({seed, observe});
}

module.exports = {createWireObservation, createProtectionLeakScanner, createWireObservationProbe, combineWireObservationProbes, providerVisibleTextsFromBody};
