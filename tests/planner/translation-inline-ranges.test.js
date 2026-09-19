const test = require("node:test");
const assert = require("node:assert/strict");

const {createProtectionLogic, MESSAGE_PLACES} = require("../../src/protection/protection-logic");
const {planReceivedMarkdown, reassembleReceivedMarkdown, validateReceivedMarkdownPlan} = require("../../src/planner/received-markdown-lossless-planner");
const {compileTypedPlan, isTranslatableOutputNode} = require("../../src/planner/translation-plan-serializer");
const {validateSegmentResponse} = require("../../src/planner/translation-segment-validator");
const {
	INLINE_RANGES_VERSION,
	INLINE_RANGE_ROLE,
	applyInlineProtectedRanges,
	inlineTokens,
	expectedInlinePlaceholders,
	restoreInlineProtectedTranslations
} = require("../../src/planner/translation-inline-ranges");
const {P2_FIXTURES, P2_FIXTURE_HASHES, sha256} = require("../fixtures/p2-inline-protected-fixtures");
const {original14Markdown, targetBodyForeignTitle, allEnglishProtected, fixtureSha256} = require("../fixtures/s8b-m0a-mixed-language-fixtures");

const TOKEN_RE = /⟦(?:DTA)?\d+⟧|⟦C\d+⟧|⟦\/?F\d+⟧/g;
const CJK_RE = /[\p{Script=Han}]/u;

function prepare(source, {protectedTerms = [], wrapperPairs = []} = {}) {
	const settings = {wordStart: ["!"], protectedTerms: [...protectedTerms], wrapperPairs: [...wrapperPairs], protectedTermsForReceived: true, wrapperPairsForReceived: true};
	const plugin = {settings: {exceptions: settings}, getProtectedWrapperRules() {return settings.wrapperPairs.map(value => {const [left, right] = String(value).split("|"); return {left, right};}).filter(row => row.left && row.right);}};
	const logic = createProtectionLogic();
	const protectedSource = logic.prepareSemanticSource(plugin, source, MESSAGE_PLACES.RECEIVED);
	const plan = planReceivedMarkdown(protectedSource.source, {direction: "received", fieldPath: "body", targetLanguageId: "zh-CN"});
	return {plugin, logic, protectedSource, plan, protectedSegments: protectedSource.protectedSegments || {}};
}

function translatable(plan) {return plan.nodes.filter(isTranslatableOutputNode);}

// The production defect: a translatable node that is shorter than its line, carries no
// target-script text and sits directly beside an inline protected node.
function fragmentBesideProtected(plan) {
	const nodes = plan.nodes, rows = [];
	for (let index = 0; index < nodes.length; index++) {
		const node = nodes[index];
		if (!isTranslatableOutputNode(node) || CJK_RE.test(node.raw)) continue;
		const neighbours = [nodes[index - 1], nodes[index + 1]].filter(Boolean);
		const besideProtected = neighbours.some(other => other.kind === "text" && other.classification === "protected" && other.role !== "inline-range-gap" && !/[\r\n]/.test(other.raw));
		const lineStart = Math.max(plan.source.lastIndexOf("\n", node.sourceStart - 1), plan.source.lastIndexOf("\r", node.sourceStart - 1)) + 1;
		const lineEnd = (() => {const at = plan.source.slice(node.sourceStart).search(/[\r\n]/); return at < 0 ? plan.source.length : node.sourceStart + at;})();
		if (besideProtected && node.sourceEnd - node.sourceStart < lineEnd - lineStart) rows.push(node);
	}
	return rows;
}

function identityTranslations(plan) {
	const valid = {};
	for (const node of translatable(plan)) valid[node.id] = node.wireText != null ? node.wireText : node.raw;
	return valid;
}

function chineseRows(plan, mutate = rows => rows) {
	return mutate(translatable(plan).map((node, index) => ({id: node.id, translation: `这是第${index + 1}段译文${inlineTokens(node.wireText != null ? node.wireText : node.raw).map(token => /^⟦F/.test(token) ? token + "格式文字" : token).join("")}。`})));
}

function seededRandom(seed) {let state = seed >>> 0 || 1; return () => {state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296;};}

test("P2 corpus is byte-pinned and reproduces the fragment defect under the P1 planner", () => {
	assert.equal(INLINE_RANGES_VERSION, "inline-ranges-v2");
	assert.equal(INLINE_RANGE_ROLE, "inline-range");
	for (const fixture of P2_FIXTURES) {
		assert.equal(sha256(fixture.source), P2_FIXTURE_HASHES[fixture.id], fixture.id);
		const prepared = prepare(fixture.source, fixture);
		assert.equal(translatable(prepared.plan).length, fixture.p1SegmentCount, `${fixture.id} P1 segment count`);
		assert.ok(fragmentBesideProtected(prepared.plan).length > 0, `${fixture.id} shows placeholder-side fragments under P1`);
	}
});

test("P2 merges only runs with inline protected nodes, keeps the plan lossless and leaks no protected value", () => {
	for (const fixture of P2_FIXTURES) {
		const prepared = prepare(fixture.source, fixture);
		const plan = applyInlineProtectedRanges(prepared.plan);
		assert.equal(plan.inlineRanges && plan.inlineRanges.version, plan.inlineRanges.formatCount ? INLINE_RANGES_VERSION : "inline-ranges-v1");
		const validity = validateReceivedMarkdownPlan(plan);
		assert.deepEqual(validity.errors, [], `${fixture.id}: ${validity.errors.join(",")}`);
		const segments = translatable(plan);
		// The historical fixture remains byte-pinned. Its inline bold heading now
		// joins the following clause, instead of adding a separate word-sized segment.
		assert.equal(segments.length, fixture.id === "f10-markdown-protected-mixed" ? 6 : fixture.p2SegmentCount, `${fixture.id} current segment count`);
		assert.deepEqual(fragmentBesideProtected(plan), [], `${fixture.id} has no placeholder-side fragment left`);
		const ranges = plan.nodes.filter(node => node.role === INLINE_RANGE_ROLE);
		assert.ok(ranges.length > 0, `${fixture.id} produced merged ranges`);
		const leafValues = Object.values(prepared.protectedSegments).map(String);
		for (const range of ranges) {
			assert.equal(range.kind, "text");
			assert.equal(range.classification, "translate");
			assert.equal(range.raw, plan.source.slice(range.sourceStart, range.sourceEnd));
			assert.equal(typeof range.wireText, "string");
			assert.equal(range.wireText.trim(), range.wireText, "ranges carry no edge whitespace");
			assert.doesNotMatch(range.wireText, /^(?:[ \t]*(?:\d{1,3}|[A-Za-z])[.)][ \t]+)/, "label prefixes stay outside the range");
			assert.match(range.wireText.replace(TOKEN_RE, ""), /\p{L}/u, "every range keeps natural language");
			const localTokens = range.inlineProtected.map(row => row.token);
			const leafTokens = localTokens.filter(token => /^⟦C/.test(token));
			assert.deepEqual(leafTokens, leafTokens.map((_, index) => `⟦C${index}⟧`), "local leaves are numbered per range from zero");
			for (const row of range.inlineProtected) {
				assert.equal(range.wireText.split(row.token).length - 1, 1, `${row.token} appears once in the wire text`);
				assert.equal(range.wireText.includes(row.raw), false, `${fixture.id} leaks a protected leaf into the wire text`);
			}
			for (const value of leafValues) assert.equal(range.wireText.includes(value), false, `${fixture.id} leaks ${value.slice(0, 20)} into the wire text`);
			// A P1 placeholder nested inside a local leaf (e.g. inline code around a masked
			// value) travels inside its ⟦Cn⟧ token and is restored with it.
			let outsideLeaves = range.raw;
			for (const row of range.inlineProtected) outsideLeaves = outsideLeaves.replace(row.raw, "");
			assert.deepEqual(inlineTokens(range.wireText).slice().sort(), [...outsideLeaves.matchAll(/⟦(?:DTA)?\d+⟧/g)].map(match => match[0]).concat(localTokens).sort(), "wire tokens are exactly the P1 placeholders plus the local leaves");
		}
		const typed = compileTypedPlan(plan);
		assert.equal(typed.ok, true);
		for (const segment of typed.payload.segments) {
			const node = plan.nodes.find(row => row.id === typed.aliases[segment.id]);
			assert.equal(segment.text, node.wireText != null ? node.wireText : node.raw, "typed segments send the wire text");
		}
		for (const value of leafValues) assert.equal(typed.body.includes(value), false, `${fixture.id} leaks ${value.slice(0, 20)} into the typed body`);
	}
	const f05 = applyInlineProtectedRanges(prepare(P2_FIXTURES[0].source, P2_FIXTURES[0]).plan);
	const f05Ranges = f05.nodes.filter(node => node.role === INLINE_RANGE_ROLE);
	assert.match(f05Ranges[0].wireText, /^Please ask ⟦\d+⟧ to review ⟦\d+⟧ before Friday\.$/);
	assert.match(f05Ranges[1].wireText, /^Email ⟦\d+⟧, visit ⟦\d+⟧, connect to ⟦\d+⟧, run ⟦\d+⟧ and keep ⟦C0⟧ unchanged\.$/);
	assert.equal(f05Ranges[1].inlineProtected[0].raw, "`const flag = true;`");
	assert.match(f05Ranges[2].wireText, /^Notify ⟦\d+⟧ in ⟦\d+⟧ at ⟦\d+⟧\.$/);
	const f10 = applyInlineProtectedRanges(prepare(P2_FIXTURES[1].source, P2_FIXTURES[1]).plan);
	const f10Heading = f10.nodes.filter(node => node.role === INLINE_RANGE_ROLE)[0];
	assert.match(f10Heading.wireText, /^Deployment Notes for ⟦\d+⟧$/, "the heading label 3. stays outside the range");
	assert.equal(f10.nodes[f10.nodes.indexOf(f10Heading) - 1].raw, " 3. ");
	assert.equal(f10.nodes[f10.nodes.indexOf(f10Heading) - 1].classification, "protected");
	assert.ok(f10.nodes.some(node => isTranslatableOutputNode(node) && node.raw === "Read the FAQ first. Then submit the form. " && node.wireText == null), "a run without protected nodes is left exactly as P1 planned it");
	const f12 = applyInlineProtectedRanges(prepare(P2_FIXTURES[3].source, P2_FIXTURES[3]).plan);
	assert.match(f12.nodes.find(node => node.role === INLINE_RANGE_ROLE).wireText, /^Thanks to everyone ⟦C0⟧⟦C1⟧$/);
});

test("P2 is a no-op for plans without inline protected nodes (zero equivalence with P1)", () => {
	assert.equal(sha256(original14Markdown), fixtureSha256.original14Markdown);
	// The embed layout joins field names and values with divider runs on one line; they are
	// structure between fields, not inline protected content, so the plan stays as P1 built it.
	const embedLayout = "Financial Aid body\n__________________ __________________ __________________\nApplication Title\nApplication Description\n\nRequirement__________________Dependent status\nDeadline";
	for (const [label, source] of [["original14Markdown", original14Markdown], ["targetBodyForeignTitle", targetBodyForeignTitle], ["allEnglishProtected", allEnglishProtected], ["plainEnglish", "Please send the final synthetic report before eight tonight."], ["embedLayout", embedLayout]]) {
		const prepared = prepare(source);
		const before = compileTypedPlan(prepared.plan), after = compileTypedPlan(applyInlineProtectedRanges(prepared.plan));
		assert.equal(after.body, before.body, `${label}: typed body is byte-identical`);
		assert.deepEqual(applyInlineProtectedRanges(prepared.plan).nodes.map(node => [node.id, node.raw, node.classification, node.role]), prepared.plan.nodes.map(node => [node.id, node.raw, node.classification, node.role]), `${label}: nodes untouched`);
	}
	const twice = applyInlineProtectedRanges(applyInlineProtectedRanges(prepare(P2_FIXTURES[0].source, P2_FIXTURES[0]).plan));
	assert.equal(twice.nodes.filter(node => node.role === INLINE_RANGE_ROLE).length, 3, "applying the transform twice does not re-merge");
});

test("P2 token multiset validation and local restore keep every protected byte", () => {
	for (const fixture of P2_FIXTURES) {
		const prepared = prepare(fixture.source, fixture);
		const plan = applyInlineProtectedRanges(prepared.plan);
		const expectations = expectedInlinePlaceholders(plan);
		for (const range of plan.nodes.filter(node => node.role === INLINE_RANGE_ROLE)) assert.equal(expectations[range.id].reduce((total, row) => total + row.count, 0), inlineTokens(range.wireText).length);
		const clean = validateSegmentResponse(plan, chineseRows(plan), {likelyTarget: value => CJK_RE.test(value), similarity: () => 0});
		assert.equal(clean.candidateOutcome, "valid", `${fixture.id}: ${JSON.stringify(clean.invalid)}`);
		const rangeIndex = translatable(plan).findIndex(node => node.role === INLINE_RANGE_ROLE && inlineTokens(node.wireText).length > 0);
		const rangeId = translatable(plan)[rangeIndex].id;
		const mutate = fn => validateSegmentResponse(plan, chineseRows(plan, rows => rows.map((row, index) => index === rangeIndex ? Object.assign({}, row, {translation: fn(row.translation)}) : row)), {likelyTarget: value => CJK_RE.test(value), similarity: () => 0});
		assert.deepEqual(mutate(text => text.replace(TOKEN_RE, "")).invalid, [{id: rangeId, reason: "placeholder-mismatch"}], `${fixture.id}: dropped tokens`);
		assert.deepEqual(mutate(text => text + inlineTokens(text)[0]).invalid, [{id: rangeId, reason: "placeholder-mismatch"}], `${fixture.id}: duplicated token`);
		assert.deepEqual(mutate(text => text + "⟦C9⟧").invalid, [{id: rangeId, reason: "placeholder-mismatch"}], `${fixture.id}: unknown local token`);
		assert.deepEqual(mutate(text => text + "⟦77⟧").invalid, [{id: rangeId, reason: "placeholder-mismatch"}], `${fixture.id}: unknown P1 token`);
		assert.deepEqual(mutate(text => text.replace(/⟦(?:C)?\d+⟧/, "⟦C8⟧")).invalid, [{id: rangeId, reason: "placeholder-mismatch"}], `${fixture.id}: altered token`);
		assert.equal(mutate(text => text.replace(/。$/, "")).candidateOutcome, "valid", "text edits that keep the multiset stay valid");

		const valid = restoreInlineProtectedTranslations(plan, clean.valid);
		const masked = reassembleReceivedMarkdown(plan, valid);
		assert.doesNotMatch(masked, /⟦C\d+⟧/, "local tokens never reach the reassembled text");
		const restored = prepared.logic.addSemanticExceptions(prepared.plugin, masked, prepared.protectedSegments);
		assert.doesNotMatch(restored, /⟦(?:DTA)?\d+⟧/);
		for (const literal of fixture.preserveLiterals) assert.equal(restored.split(literal).length - 1, fixture.source.split(literal).length - 1, `${fixture.id} conserves ${literal}`);
		assert.equal(restored.split(/\r\n|\r|\n/).length, fixture.source.split(/\r\n|\r|\n/).length, `${fixture.id} keeps its line structure`);
		const roundTrip = prepared.logic.addSemanticExceptions(prepared.plugin, reassembleReceivedMarkdown(plan, restoreInlineProtectedTranslations(plan, identityTranslations(plan))), prepared.protectedSegments);
		assert.equal(roundTrip, fixture.source, `${fixture.id}: identity translations reproduce the source byte for byte`);
	}
});

test("P2 refuses to merge when the plain text already contains a bracket lookalike", () => {
	const prepared = prepare("Visit https://example.invalid/x now, the ⟦C0⟧ marker is literal text.");
	const plan = applyInlineProtectedRanges(prepared.plan);
	assert.equal(plan.nodes.filter(node => node.role === INLINE_RANGE_ROLE).length, 0);
	assert.deepEqual(plan.nodes.map(node => node.id), prepared.plan.nodes.map(node => node.id));
});

test("P2 fuzz: 10000 synthetic mixed messages stay lossless, leak nothing and round-trip byte for byte", () => {
	const random = seededRandom(20260902);
	const pick = list => list[Math.floor(random() * list.length)];
	const english = ["Please review", "the report", "before Friday", "and ping", "the team", "today", "then open", "the dashboard", "keep", "unchanged", "Backup runs at", "must pass", "Send it to", "first"];
	const chinese = ["请先确认", "谢谢配合", "注意事项", "然后提交", "报名前请注意"];
	const protectedBits = () => pick([
		"https://example.invalid/" + Math.floor(random() * 1000),
		"<@1234567890123456" + Math.floor(random() * 90 + 10) + ">",
		"`cmd" + Math.floor(random() * 100) + "`",
		"user" + Math.floor(random() * 100) + "@example.invalid",
		"192.0.2." + Math.floor(random() * 250) + ":8443",
		"/deploy",
		"🎉",
		"\\*literal"
	]);
	const punctuation = [".", "!", "?", "。", ",", ""];
	let merged = 0, untouched = 0;
	for (let iteration = 0; iteration < 10000; iteration++) {
		const lineCount = 1 + Math.floor(random() * 3), lines = [];
		for (let line = 0; line < lineCount; line++) {
			const prefix = pick(["", "", "- ", "> ", "### ", "1. ", "- A. "]);
			const parts = [];
			const partCount = 1 + Math.floor(random() * 5);
			for (let part = 0; part < partCount; part++) {
				const roll = random();
				parts.push(roll < 0.45 ? pick(english) : roll < 0.75 ? protectedBits() : roll < 0.9 ? pick(chinese) : pick(english) + pick(punctuation));
			}
			lines.push(prefix + parts.join(" ") + pick(punctuation));
		}
		const source = lines.join(pick(["\n", "\n", "\r\n"]));
		const prepared = prepare(source, {protectedTerms: ["Longma"], wrapperPairs: ["\"|\""]});
		let plan;
		assert.doesNotThrow(() => {plan = applyInlineProtectedRanges(prepared.plan);}, source);
		const validity = validateReceivedMarkdownPlan(plan);
		assert.deepEqual(validity.errors, [], `${JSON.stringify(source)}: ${validity.errors.join(",")}`);
		const ranges = plan.nodes.filter(node => node.role === INLINE_RANGE_ROLE);
		if (ranges.length) merged++; else untouched++;
		// P1 masks a value where its detector matched; a second occurrence it left in plain
		// text (e.g. "/deploy?") was already sent by P1 and is not a P2 leak.
		const leafValues = Object.values(prepared.protectedSegments).map(String).filter(value => value.length >= 3 && !prepared.protectedSource.source.includes(value));
		for (const range of ranges) {
			for (const row of range.inlineProtected) assert.equal(range.wireText.includes(row.raw), false, `leaf leaked: ${JSON.stringify(source)}`);
			for (const value of leafValues) assert.equal(range.wireText.includes(value), false, `P1 value leaked: ${JSON.stringify(source)}`);
			assert.match(range.wireText.replace(TOKEN_RE, ""), /\p{L}/u);
			assert.equal(range.wireText, range.wireText.trim());
		}
		assert.deepEqual(fragmentBesideProtected(plan), [], `fragment survived: ${JSON.stringify(source)}`);
		const roundTrip = prepared.logic.addSemanticExceptions(prepared.plugin, reassembleReceivedMarkdown(plan, restoreInlineProtectedTranslations(plan, identityTranslations(plan))), prepared.protectedSegments);
		assert.equal(roundTrip, source, `round trip: ${JSON.stringify(source)}`);
		if (!ranges.length) assert.equal(compileTypedPlan(plan).body, compileTypedPlan(prepared.plan).body, `zero equivalence: ${JSON.stringify(source)}`);
	}
	assert.ok(merged > 3000, `enough merged messages (${merged})`);
	assert.ok(untouched > 500, `enough untouched messages (${untouched})`);
});
