"use strict";

const crypto = require("node:crypto");
const http = require("node:http");
const https = require("node:https");
const {performance} = require("node:perf_hooks");

const SIDE_EFFECT_ERROR = "W1 offline benchmark forbids Provider, cache, and DOM access";

function forbidden() {throw new Error(SIDE_EFFECT_ERROR);}
function forbiddenObject() {return new Proxy(Object.create(null), {get: forbidden, set: forbidden});}

// Install the sentinels before any project module is loaded. The benchmark is a
// serializer-only harness: a dependency that tries to reach the host, a Provider,
// browser storage, or the DOM must fail immediately rather than polluting a run.
global.fetch = forbidden;
global.XMLHttpRequest = class ForbiddenXMLHttpRequest {constructor() {forbidden();}};
global.BDFDB = Object.freeze({LibraryRequires: Object.freeze({request: forbidden})});
global.document = forbiddenObject();
global.localStorage = forbiddenObject();
global.sessionStorage = forbiddenObject();
http.request = http.get = forbidden;
https.request = https.get = forbidden;

const {original14Markdown, fixtureSha256} = require("../tests/fixtures/s8b-m0a-mixed-language-fixtures");
const {planReceivedMarkdown} = require("../src/planner/received-markdown-lossless-planner");
const {
	CORE_SYSTEM_PROMPT,
	compileTypedPlan,
	isTranslatableOutputNode
} = require("../src/planner/translation-plan-serializer");
const {createProtectionLogic, MESSAGE_PLACES} = require("../src/protection/protection-logic");

let w1;
try {w1 = require("../src/planner/translation-compact-wire");}
catch (error) {
	const expected = error && error.code === "MODULE_NOT_FOUND"
		&& /translation-compact-wire/.test(String(error.message || ""));
	if (!expected) throw error;
	throw new Error("W1 compact wire pure functions are not implemented yet");
}
if (!w1 || w1.W1_IMPLEMENTED !== true) throw new Error("W1 compact wire pure functions are not implemented yet");

const FIXTURE_SOURCES = Object.freeze({
	exact: original14Markdown,
	short95: "A".repeat(95),
	long2000: "B".repeat(2000),
	protected: "Contact john.doe@example.com at https://api.example.com/a or docs.example.org and 192.168.1.5:8443 via /help about Longma and \"KEEP\". Use `inline code`, <@123>, and <:wave:456>. GED and Non-Degree remain translatable.",
	mixed: "这是申请表的中文说明，以下英文标题和选项需要翻译。\n### Degree of Interest\n- A. Undergraduate\n- B. Graduate\n- C. Non-Degree / Certificate\n已经是中文的内容保持原样。"
});

// These values make fixture drift fail closed. short95/long2000 are generated from
// literal repetitions, but their digests are still fixed to catch accidental edits.
const FIXTURE_SHA256 = Object.freeze({
	exact: fixtureSha256.original14Markdown,
	short95: "6121F27B52C1F17DDCE365143BA58A720FA303707FAA32A4E5E89029F34AC618",
	long2000: "E102CC048A84AB60402D04294D30BFD8A7D02FBEC6DEE1288D7025751975286B",
	protected: "4F2BBF157718B93778335283072FC21D7DD08D120090D31777C21CA1813612C6",
	mixed: "D00F3C1DD0E9D53ACB67638F58198D5C4CA209F4485987DC5959E2144A3CB876"
});

function sha256(value) {
	return crypto.createHash("sha256").update(String(value)).digest("hex").toUpperCase();
}

function utf8(value) {return Buffer.byteLength(String(value == null ? "" : value));}

function parsePositiveInteger(name, value, {allowZero = false, maximum = 1_000_000} = {}) {
	if (!/^\d+$/.test(String(value || ""))) throw new Error(`${name} must be an integer`);
	const number = Number(value);
	if (!Number.isSafeInteger(number) || number > maximum || number < (allowZero ? 0 : 1)) {
		throw new Error(`${name} must be between ${allowZero ? 0 : 1} and ${maximum}`);
	}
	return number;
}

function parseArguments(argv) {
	const options = {warmup: 100, iterations: 1000};
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		const match = String(argument).match(/^--(warmup|iterations)(?:=(\d+))?$/);
		if (!match) throw new Error(`unknown argument: ${argument}`);
		const raw = match[2] == null ? argv[++index] : match[2];
		if (raw == null) throw new Error(`missing value for --${match[1]}`);
		options[match[1]] = parsePositiveInteger(match[1], raw, {allowZero: match[1] === "warmup"});
	}
	return Object.freeze(options);
}

function nearestRank(samples, percentile) {
	const ordered = samples.slice().sort((left, right) => left - right);
	const index = Math.max(0, Math.min(ordered.length - 1, Math.ceil(ordered.length * percentile) - 1));
	return ordered[index] || 0;
}

function round(value, places = 6) {
	const scale = 10 ** places;
	return Math.round(Number(value || 0) * scale) / scale;
}

function resultWire(result) {
	if (typeof result && result && typeof result.wire === "string") return result.wire;
	if (result && typeof result.body === "string") return result.body;
	throw new Error("serializer returned no wire");
}

function assertSuccessful(label, result) {
	if (!result || result.ok === false || result.enabled === false || result.reason && !result.wire) {
		throw new Error(`${label} failed: ${result && (result.reason || result.fallbackReason) || "unknown"}`);
	}
	resultWire(result);
	return result;
}

function timeSerializer(label, factory, warmup, iterations) {
	let referenceSha = null;
	for (let index = 0; index < warmup; index++) {
		const result = assertSuccessful(label, factory());
		const wireSha = sha256(resultWire(result));
		if (referenceSha == null) referenceSha = wireSha;
		else if (referenceSha !== wireSha) throw new Error(`${label} is nondeterministic during warmup`);
	}
	const samples = [];
	let last = null;
	for (let index = 0; index < iterations; index++) {
		const started = performance.now();
		last = assertSuccessful(label, factory());
		const elapsed = performance.now() - started;
		samples.push(elapsed);
		const wireSha = sha256(resultWire(last));
		if (referenceSha == null) referenceSha = wireSha;
		else if (referenceSha !== wireSha) throw new Error(`${label} is nondeterministic`);
	}
	return Object.freeze({
		result: last,
		wireSha256: referenceSha,
		serializerMs: Object.freeze({
			p50: round(nearestRank(samples, 0.5)),
			p95: round(nearestRank(samples, 0.95))
		})
	});
}

function createProtectionFixture() {
	const settings = Object.freeze({
		protectedTerms: Object.freeze(["Longma"]),
		wrapperPairs: Object.freeze(['"|"']),
		protectedTermsForReceived: true,
		wrapperPairsForReceived: true
	});
	const plugin = {
		settings: {exceptions: settings},
		getProtectedWrapperRules() {
			return settings.wrapperPairs.map(value => {
				const [left, right] = value.split("|");
				return {left, right};
			});
		}
	};
	return Object.freeze({plugin, logic: createProtectionLogic()});
}

function prepareFixture(name, source) {
	const actualSha = sha256(source);
	if (actualSha !== FIXTURE_SHA256[name]) throw new Error(`${name} fixture SHA drift: ${actualSha}`);
	const fixture = createProtectionFixture();
	const protectedSource = fixture.logic.prepareSemanticSource(fixture.plugin, source, MESSAGE_PLACES.RECEIVED);
	const plan = planReceivedMarkdown(protectedSource.source, {
		direction: "received",
		fieldPath: "body",
		targetLanguageId: "zh-CN"
	});
	const safeContext = w1.buildSafeContext(plan, protectedSource.protectedSegments, {rawSourceBytes: utf8(source)});
	if (!safeContext || safeContext.ok !== true) throw new Error(`${name} safeContext failed`);
	return Object.freeze({name, source, sourceBytes: utf8(source), inputSha256: actualSha, plan, safeContext, protectedSegments: protectedSource.protectedSegments});
}

function armSummary(arm, measured, fixture, fallbackSegmentCount, fallbackContextIncluded) {
	const result = measured.result;
	const wire = resultWire(result);
	const wireBytes = result.bodyBytes == null ? utf8(wire) : Number(result.bodyBytes);
	const systemPromptBytes = result.systemPromptBytes == null ? 0 : Number(result.systemPromptBytes);
	const segmentCount = result.segmentCount == null
		? Array.isArray(result.mapping) ? result.mapping.length : fallbackSegmentCount
		: Number(result.segmentCount);
	const contextIncluded = result.contextIncluded == null ? !!fallbackContextIncluded : result.contextIncluded === true;
	return Object.freeze({
		arm,
		wireFamily: arm === "A" ? "typed-json" : String(result.wireFamily || "unknown"),
		bytes: Object.freeze({
			source: fixture.sourceBytes,
			wire: wireBytes,
			systemPrompt: systemPromptBytes,
			totalProviderInput: wireBytes + systemPromptBytes
		}),
		amplification: Object.freeze({
			wire: round(wireBytes / Math.max(1, fixture.sourceBytes)),
			totalProviderInput: round((wireBytes + systemPromptBytes) / Math.max(1, fixture.sourceBytes))
		}),
		segmentCount,
		contextIncluded,
		serializerMs: measured.serializerMs,
		wireSha256: measured.wireSha256
	});
}

function benchmarkFixture(fixture, options) {
	const translatedNodes = (fixture.plan.nodes || []).filter(isTranslatableOutputNode);
	const aPrompt = `${CORE_SYSTEM_PROMPT} The exact targetLanguageId for this request is zh-CN.`;
	const a = timeSerializer(`${fixture.name}/A`, () => compileTypedPlan(fixture.plan), options.warmup, options.iterations);
	const array = timeSerializer(`${fixture.name}/B-array`, () => w1.buildCompactOrderRequest(fixture.plan, fixture.safeContext, {
		targetLanguageId: "zh-CN",
		responseMode: "array",
		rawSourceBytes: fixture.sourceBytes,
		protectedSegments: fixture.protectedSegments
	}), options.warmup, options.iterations);
	const marker = timeSerializer(`${fixture.name}/B-marker`, () => w1.buildCompactOrderRequest(fixture.plan, fixture.safeContext, {
		targetLanguageId: "zh-CN",
		responseMode: "marker",
		rawSourceBytes: fixture.sourceBytes,
		protectedSegments: fixture.protectedSegments
	}), options.warmup, options.iterations);
	const whole = timeSerializer(`${fixture.name}/C`, () => w1.buildWholeMessageRequest(fixture.plan, fixture.safeContext, {
		targetLanguageId: "zh-CN",
		rawSourceBytes: fixture.sourceBytes,
		protectedSegments: fixture.protectedSegments
	}), options.warmup, options.iterations);
	const aResult = Object.assign({}, a.result, {systemPromptBytes: utf8(aPrompt)});
	return Object.freeze({
		inputSha256: fixture.inputSha256,
		sourceBytes: fixture.sourceBytes,
		arms: Object.freeze({
			A: armSummary("A", Object.assign({}, a, {result: aResult}), fixture, translatedNodes.length, a.result.contextCount > 0),
			B_array: armSummary("B-array", array, fixture, translatedNodes.length, false),
			B_marker: armSummary("B-marker", marker, fixture, translatedNodes.length, false),
			C: armSummary("C", whole, fixture, translatedNodes.length, true)
		})
	});
}

function main() {
	const options = parseArguments(process.argv.slice(2));
	const fixtures = {};
	for (const [name, source] of Object.entries(FIXTURE_SOURCES)) {
		const fixture = prepareFixture(name, source);
		fixtures[name] = benchmarkFixture(fixture, options);
	}
	process.stdout.write(`${JSON.stringify({
		schemaVersion: "w1-wire-offline-benchmark-v1",
		mode: "offline-pure-functions",
		warmup: options.warmup,
		iterations: options.iterations,
		fixtures
	}, null, 2)}\n`);
}

try {main();}
catch (error) {
	process.stderr.write(`${JSON.stringify({error: String(error && error.message || error)})}\n`);
	process.exitCode = 1;
}
