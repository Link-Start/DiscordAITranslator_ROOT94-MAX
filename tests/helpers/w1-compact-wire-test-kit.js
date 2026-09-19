const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {performance} = require("node:perf_hooks");
const {original14Markdown} = require("../fixtures/s8b-m0a-mixed-language-fixtures");
const {planReceivedMarkdown} = require("../../src/planner/received-markdown-lossless-planner");
const {compileTypedPlan, isTranslatableOutputNode} = require("../../src/planner/translation-plan-serializer");
const {createProtectionLogic, MESSAGE_PLACES} = require("../../src/protection/protection-logic");

let implementation = null;
const implementationRequest = "../../src/planner/translation-compact-wire";
try {implementation = require(implementationRequest);}
catch (error) {
	const firstLine = String(error && error.message || "").split(/\r?\n/, 1)[0];
	const expected = error && error.code === "MODULE_NOT_FOUND"
		&& firstLine === `Cannot find module '${implementationRequest}'`;
	if (!expected) throw error;
}

function requireW1() {
	assert.ok(implementation && implementation.W1_IMPLEMENTED === true,
		"missing capability: compact-order-v1 pure functions are not implemented");
	return implementation;
}

function utf8(value) {return Buffer.byteLength(String(value == null ? "" : value));}
function sha256(value) {return crypto.createHash("sha256").update(value).digest("hex").toUpperCase();}
function planFor(source, targetLanguageId = "zh-CN") {return planReceivedMarkdown(String(source), {targetLanguageId});}
function translatable(plan) {return (plan.nodes || []).filter(isTranslatableOutputNode);}

function createProtectionFixture(overrides = {}) {
	const settings = Object.assign({
		wordStart: ["!"],
		protectedTerms: ["Longma"],
		wrapperPairs: ['"|"', "`|`"],
		protectedTermsForReceived: true,
		protectedTermsForSent: true,
		wrapperPairsForReceived: true,
		wrapperPairsForSent: true
	}, overrides);
	const plugin = {
		settings: {exceptions: settings},
		getProtectedWrapperRules() {
			return (settings.wrapperPairs || []).map(value => {
				const [left, right] = String(value).split("|");
				return {left, right};
			}).filter(row => row.left && row.right);
		}
	};
	const logic = createProtectionLogic();
	return {plugin, logic, protect(source, place = MESSAGE_PLACES.RECEIVED) {
		return logic.prepareSemanticSource(plugin, String(source), place);
	}, restore(source, map) {return logic.addSemanticExceptions(plugin, String(source), map);}};
}

function exactBaseline() {
	const plan = planFor(original14Markdown), typed = compileTypedPlan(plan), segments = translatable(plan);
	return Object.freeze({
		source: original14Markdown,
		plan,
		typed,
		segments,
		chars: original14Markdown.length,
		sourceBytes: utf8(original14Markdown),
		translateBytes: utf8(segments.map(row => row.raw).join(""))
	});
}

function validArray(request, prefix = "译文") {
	return request.mapping.map((row, index) => `${prefix}${index}-${row.text.length}`);
}

function validMarker(request, prefix = "译文") {
	return request.mapping.map((row, index) => `⟦W${index}⟧${prefix}${index}-${row.text.length}`).join("\n") + `\n⟦W${request.mapping.length}⟧`;
}

function withNoSideEffects(run) {
	const priorFetch = global.fetch;
	const priorBdfdb = global.BDFDB;
	let fetchCount = 0, requestCount = 0;
	global.fetch = () => {fetchCount++; throw new Error("W1 network call");};
	global.BDFDB = {LibraryRequires: {request: () => {requestCount++; throw new Error("W1 request call");}}};
	try {
		const value = run();
		assert.equal(fetchCount, 0, "W1 pure functions must not call fetch");
		assert.equal(requestCount, 0, "W1 pure functions must not call host request");
		return value;
	}
	finally {global.fetch = priorFetch; global.BDFDB = priorBdfdb;}
}

function p95(samples) {
	const sorted = samples.slice().sort((a, b) => a - b);
	return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] || 0;
}

module.exports = {
	assert,
	performance,
	original14Markdown,
	requireW1,
	utf8,
	sha256,
	planFor,
	translatable,
	createProtectionFixture,
	exactBaseline,
	validArray,
	validMarker,
	withNoSideEffects,
	p95
};
