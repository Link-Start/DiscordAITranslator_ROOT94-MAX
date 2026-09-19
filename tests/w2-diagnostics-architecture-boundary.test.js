const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

function filesUnder(relativeDirectory) {
	const absolute = path.join(root, relativeDirectory);
	if (!fs.existsSync(absolute)) return [];
	const files = [];
	for (const entry of fs.readdirSync(absolute, {withFileTypes: true})) {
		const relative = path.join(relativeDirectory, entry.name);
		if (entry.isDirectory()) files.push(...filesUnder(relative));
		else if (/\.(?:c?js|mjs)$/.test(entry.name)) files.push(relative.replaceAll("\\", "/"));
	}
	return files;
}

function read(relativePath) {
	return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function localRequires(source) {
	return [...source.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map(match => match[1]);
}

const W2_RUNTIME_SYMBOL = /(?:\bw2-wire-benchmark(?:-fixtures|-store)?\b|\b(?:create|get|begin|record|finish|cancel|fail|reset)W2[A-Za-z0-9_$]*\b|\b(?:create|get)WireExperiment[A-Za-z0-9_$]*\b|\bwireExperiment[A-Za-z0-9_$]*\b|\bW2_(?:FIXTURE|ARMS|BALANCED|WARMUP|MEASURED|MAX|SCHEMA))/;

test("W2 diagnostics stays out of translation, history, live, cache, and message DOM paths", () => {
	const forbiddenRoots = [
		"src/cache",
		"src/display",
		"src/received",
		"src/orchestrator",
		"src/sent",
		"src/channel-title",
		"src/viewport"
	];
	const violations = [];
	for (const relativePath of forbiddenRoots.flatMap(filesUnder)) {
		const source = relativePath === "src/orchestrator/translation-pipeline.js" ? read(relativePath).replace(/\.getWireExperimentCapability\(engineKey\)/g, "") : read(relativePath);
		if (W2_RUNTIME_SYMBOL.test(source)) violations.push(relativePath);
	}
	assert.deepEqual(violations, [], "the manually confirmed benchmark must never enter production translation/history/live/cache/display code");
});

test("W2 corpus and store remain diagnostic-only and published settings import no experiment owner", () => {
	const sourceFiles = filesUnder("src");
	const imports = [];
	for (const relativePath of sourceFiles) {
		for (const request of localRequires(read(relativePath))) {
			if (/w2-wire-benchmark/.test(request)) imports.push({relativePath, request});
		}
	}
	imports.sort((left, right) => `${left.relativePath}:${left.request}`.localeCompare(`${right.relativePath}:${right.request}`));
	assert.deepEqual(imports, [
		{relativePath: "src/diagnostics/provider-latency-store.js", request: "./w2-wire-benchmark-store"},
		{relativePath: "src/diagnostics/w2-wire-benchmark.js", request: "./w2-wire-benchmark-fixtures"}
	]);
});

test("W2 production fixtures are self-contained and never import test fixtures", () => {
	for (const relativePath of [
		"src/diagnostics/w2-wire-benchmark-fixtures.js",
		"src/diagnostics/w2-wire-benchmark.js",
		"scripts/run-w2-provider-benchmark.js"
	]) {
		const source = read(relativePath);
		assert.doesNotMatch(source, /(?:^|[\\/])tests(?:[\\/]|$)/m, `${relativePath} must not acquire mutable test corpus data`);
		assert.doesNotMatch(source, /s8b-m0a-mixed-language-fixtures/, `${relativePath} must not alias the historical regression fixture`);
	}
});

test("the W2 orchestrator depends on pure planner/protection code, not production runtime owners", () => {
	const requests = localRequires(read("src/diagnostics/w2-wire-benchmark.js"));
	const forbidden = requests.filter(request => /(?:^|[\\/])(?:cache|display|received|orchestrator|legacy|ui|providers)(?:[\\/]|$)/.test(request));
	assert.deepEqual(forbidden, []);
	assert.ok(requests.includes("../planner/translation-compact-wire"));
	assert.ok(requests.includes("../protection/protection-logic"));
});

test("the external W2 runner cannot reach translation, cache, display, or UI modules", () => {
	const source = read("scripts/run-w2-provider-benchmark.js");
	const forbidden = localRequires(source).filter(request => /src[\\/](?:cache|display|received|orchestrator|legacy|ui)[\\/]/.test(request));
	assert.deepEqual(forbidden, []);
	assert.match(source, /callback-transport-forbidden/);
	assert.match(source, /settings-write-blocked/);
	assert.match(source, /output-target-protected/);
});

const D_WIRE_SYMBOL = /translation-whole-marker-wire|\b(?:build|parse|reassemble)WholeMarker[A-Za-z0-9_$]*\b|\bWHOLE_MARKER_(?:VERSION|PROMPT_VERSION|VALIDATOR_VERSION|REASONS)\b/;

// W5 adds only its bounded batch owner and pure tuple codec to W4/W3.
// No production owner reaches experiment execution; sent and DOM remain excluded.
const D_CANARY_MODULE = "src/orchestrator/whole-marker-single-canary.js";
const D_BATCH_MODULE = "src/orchestrator/whole-marker-batch-canary.js";
const D_BATCH_CODEC = "src/planner/translation-whole-marker-batch.js";
const D_CANARY_PIPELINE = "src/orchestrator/translation-pipeline.js";
const D_SHADOW_MODULE = "src/planner/translation-whole-marker-shadow.js";
const D_SHADOW_WIRING = "src/diagnostics/compact-wire-shadow-wiring.js";
const TRANSPORT_SYMBOL = /\bfetch\b|BdApi|XMLHttpRequest|WebSocket|LibraryRequires|streamTransport|requestText|\brequest\s*\(|https?:\/\//;

test("the D wire enters production only through bounded W4/W5 owners and W3 shadow", () => {
	const roots = ["src/cache", "src/display", "src/received", "src/orchestrator", "src/sent", "src/channel-title", "src/viewport", "src/legacy", "src/providers", "src/ui", "src/protection", "src/settings", "src/history", "src/live"];
	const violations = roots.flatMap(filesUnder).filter(relativePath => D_WIRE_SYMBOL.test(read(relativePath)));
	assert.deepEqual(violations.sort(), [D_CANARY_PIPELINE, D_CANARY_MODULE, D_BATCH_MODULE].sort(), "D dispatch/reassembly stays in the explicit W4/W5 owners");
	const plannerFiles = filesUnder("src/planner").filter(relativePath => relativePath !== "src/planner/translation-whole-marker-wire.js" && relativePath !== D_SHADOW_MODULE && relativePath !== D_BATCH_CODEC);
	assert.deepEqual(plannerFiles.filter(relativePath => D_WIRE_SYMBOL.test(read(relativePath))), [], "only the shadow and pure W5 envelope depend on D");
	const importers = filesUnder("src").filter(relativePath => localRequires(read(relativePath)).some(request => /translation-whole-marker-wire/.test(request))).sort();
	assert.deepEqual(importers, ["src/diagnostics/w2-wire-benchmark.js", D_CANARY_MODULE, D_BATCH_MODULE, D_SHADOW_MODULE, D_BATCH_CODEC].sort(), "only the explicit W2/W3/W4/W5 modules may import D");
	const requests = localRequires(read("src/planner/translation-whole-marker-wire.js"));
	assert.deepEqual(requests, ["./translation-plan-serializer"], "D depends on the pure serializer helpers only");
});

test("the W3 compile shadow depends on pure planner code and never on a transport", () => {
	const shadow = read(D_SHADOW_MODULE);
	assert.deepEqual(localRequires(shadow).sort(), ["./received-markdown-lossless-planner", "./translation-whole-marker-wire"], "the shadow compiles from the planner and D only");
	assert.doesNotMatch(shadow, TRANSPORT_SYMBOL, "the shadow owns no way to send what it compiles");
	assert.doesNotMatch(shadow, /translationCache|persistTranslationCacheEntry|document\.|DOM|BDFDB/, "the shadow touches neither cache nor DOM");
	const wiring = read(D_SHADOW_WIRING);
	assert.deepEqual(localRequires(wiring), ["../planner/translation-whole-marker-shadow"], "the wiring only reaches the shadow");
	assert.doesNotMatch(wiring, TRANSPORT_SYMBOL, "the wiring owns no transport either");
	const shadowImporters = filesUnder("src").filter(relativePath => localRequires(read(relativePath)).some(request => /translation-whole-marker-shadow/.test(request))).sort();
	assert.deepEqual(shadowImporters, [D_SHADOW_WIRING], "only the wiring module imports the shadow");
	const wiringImporters = filesUnder("src").filter(relativePath => localRequires(read(relativePath)).some(request => /compact-wire-shadow-wiring/.test(request))).sort();
	assert.deepEqual(wiringImporters, ["src/orchestrator/historical-queue-item-wiring.js", "src/orchestrator/translation-pipeline.js", "src/providers/provider-client-wiring.js"], "the two typed dispatch sites and the batch seam are the only shadow callers");
	for (const relativePath of wiringImporters.filter(path => path !== D_CANARY_PIPELINE)) assert.doesNotMatch(read(relativePath), D_WIRE_SYMBOL, relativePath + " must not reference D directly");
});

test("the provider experiment seam stays single-dispatch and bypasses production translation/cache/retry paths", () => {
	const source = read("src/providers/provider-client.js");
	const start = source.indexOf("// W2 owns no credentials");
	const end = source.indexOf("\n\tfunction fetchModelCatalog", start);
	assert.ok(start >= 0 && end > start, "the W2 provider seam remains a reviewable bounded region");
	const seam = source.slice(start, end);
	assert.match(seam, /streamTransport\.requestText\s*\(/);
	assert.match(seam, /let tail = Promise\.resolve\(\)/, "one promise tail owns physical concurrency=1");
	assert.match(seam, /dispatchCount\s*>=\s*requestLimit/);
	assert.match(seam, /requestBodyBytes\s*>\s*bodyLimit/);
	for (const forbidden of [
		/\btranslateText\b/,
		/\brequestAiBatchTranslation(?:Detailed)?\b/,
		/\bpersistTranslationCacheEntry\b/,
		/\btranslationCache\b/,
		/\bretryProviderRequest\b/,
		/\bscheduleProviderRetry\b/
	]) assert.doesNotMatch(seam, forbidden);
});

test("the W5 tuple codec owns no transport, cache, UI or mutable plugin state", () => {
 const codec = read(D_BATCH_CODEC);
 assert.deepEqual(localRequires(codec), ["./translation-whole-marker-wire"]);
 assert.doesNotMatch(codec, TRANSPORT_SYMBOL);
 assert.doesNotMatch(codec, /persistTranslationCacheEntry|translationCache|document\.|BDFDB|plugin\./);
 const importers = filesUnder("src").filter(relativePath => localRequires(read(relativePath)).some(request => /translation-whole-marker-batch$/.test(request)));
 assert.deepEqual(importers, [D_BATCH_MODULE], "only the bounded batch owner may invoke the codec");
 const owner = read(D_BATCH_MODULE);
 assert.doesNotMatch(owner, TRANSPORT_SYMBOL, "dispatch is injected; this owner creates no HTTP client");
 assert.doesNotMatch(owner, /persistTranslationCacheEntry|document\.|BDFDB/, "display and persistence keep their existing owners");
});
