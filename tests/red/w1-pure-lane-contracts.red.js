const test = require("node:test");
const {assert, requireW1, planFor, original14Markdown, sha256, createProtectionFixture} = require("../helpers/w1-compact-wire-test-kit");

test("W1 pure lane contracts cover received shapes while sent and classic history remain legacy", () => {
	const w1 = requireW1();
	for (const lane of ["manual","auto-single","reply","live-single","live-burst","history","embed","forward","title","selection"]) {
		const contract = w1.describePureLaneContract({lane,direction:"received",engineFamily:"ai"});
		assert.equal(contract.productionDispatches, 0, lane);
		assert.equal(contract.candidate, lane === "live-burst" || lane === "history" ? "w5-batch-pending" : "single", lane);
	}
	assert.equal(w1.describePureLaneContract({lane:"sent",direction:"sent",engineFamily:"ai"}).candidate, "legacy");
	assert.equal(w1.describePureLaneContract({lane:"history",direction:"received",engineFamily:"classic"}).candidate, "classic-marked");
});

test("W1 property fuzz is deterministic and lossless for plan mapping without external effects", () => {
	const w1 = requireW1(), seeds = ["\r\n","Cafe\u0301","😀","مرحبا","\uD800","\uDC00","`unclosed","||spoiler||","[link](https://example.com)","\\*escape","中文 English"], cases = Math.max(1, Number(process.env.W1_FUZZ_CASES || 1000));
	for (let index = 0; index < cases; index++) {
		const source = `${seeds[index % seeds.length]}-${index}-${seeds[(index * 7) % seeds.length]}`;
		const plan = planFor(source), first = w1.buildCompactOrderRequest(plan, source, {}), second = w1.buildCompactOrderRequest(plan, source, {});
		assert.equal(first.ok, second.ok);
		assert.equal(first.reason, second.reason);
		assert.equal(first.wire, second.wire);
		assert.equal(first.mappingIdentity, second.mappingIdentity);
	}
});

test("W1 candidate construction never changes production bundle or installed-plugin fixture", t => {
	const w1 = requireW1(), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "w1-installed-fixture-"));
	const installed = path.join(directory, "DiscordAITranslator.plugin.js");
	fs.copyFileSync("DiscordAITranslator.plugin.js", installed);
	t.after(() => { fs.unlinkSync(installed); fs.rmdirSync(directory); });
	const bundleBefore = sha256(fs.readFileSync("DiscordAITranslator.plugin.js")), installedBefore = sha256(fs.readFileSync(installed));
	for (let index = 0; index < 50; index++) w1.buildCompactOrderRequest(planFor(original14Markdown), original14Markdown, {});
	assert.equal(sha256(fs.readFileSync("DiscordAITranslator.plugin.js")), bundleBefore);
	assert.equal(sha256(fs.readFileSync(installed)), installedBefore);
});

test("W1 fixed-seed fuzz exercises real P1 protection spans, safe context and exact restore", t => {
	const w1 = requireW1(), fixture = createProtectionFixture(), cases = Math.max(1, Number(process.env.W1_FUZZ_CASES || 500)), seed = 0x5EED1234;
	let state = seed >>> 0, protectedSpanCount = 0; const shapes = new Set(), next = limit => {state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % limit;};
	const atoms = ["中文", "English", "Longma", "name@example.com", "https://example.com/a", "/help", '"KEEP"', "`code`", "<@123>", "<:wave:456>", "مرحبا", "Cafe\u0301", "😀", "\\*escape", "⟦C0⟧", "\uD800"];
	const separators = [" ", "\n", "\r\n", " - ", " | "];
	for (let index = 0; index < cases; index++) {
		const count = 3 + next(8), parts = [];
		for (let part = 0; part < count; part++) {parts.push(atoms[next(atoms.length)]); if (part + 1 < count) parts.push(separators[next(separators.length)]);}
		const source = parts.join(""), protectedSource = fixture.protect(source), plan = planFor(protectedSource.source), safe = w1.buildSafeContext(plan, protectedSource.protectedSegments, {rawSourceBytes: Buffer.byteLength(source)});
		assert.equal(safe.ok, true, index);
		assert.equal(w1.restoreProtectedContext(safe.context, safe, protectedSource.protectedSegments), source, index);
		const compact = w1.buildCompactOrderRequest(plan, safe, {rawSourceBytes: Buffer.byteLength(source), protectedSegments: protectedSource.protectedSegments});
		assert.ok(compact.ok || compact.reason === "no-segments", `${index}:${compact.reason}`);
		assert.equal(w1.buildWholeMessageRequest(plan, safe, {rawSourceBytes: Buffer.byteLength(source), protectedSegments: protectedSource.protectedSegments}).ok, true, index);
		protectedSpanCount += Object.keys(protectedSource.protectedSegments).length + safe.contextMarkers.length;
		shapes.add(plan.nodes.map(node => `${node.kind[0]}${node.classification[0]}:${node.role}`).join("|"));
	}
	assert.ok(shapes.size >= Math.min(100, Math.floor(cases / 4)), shapes.size);
	assert.ok(protectedSpanCount >= cases, protectedSpanCount);
	t.diagnostic(JSON.stringify({seed:`0x${seed.toString(16)}`,caseCount:cases,independentShapeCount:shapes.size,protectedSpanCount}));
});

test("W1 document entry fixtures keep field boundaries local and leave batch wrapping to W5", () => {
	const w1 = requireW1(), {planTranslationDocument} = require("../../src/planner/translation-document-plan"), document = planTranslationDocument({
		body: "Body English",
		embeds: [{title:"Title English",description:"Description English",footer:{text:"Footer English"},fields:[{name:"Field Name",value:"Field Value"}]}],
		forwarded: [{body:"Forward English"}],
		reply: {body:"Reply English",documentIdentity:"dp1:prior"}
	}, {direction:"received",targetLanguageId:"zh-CN"});
	for (const path of ["body","embeds.0.title","embeds.0.description","embeds.0.footer.text","embeds.0.fields.0.name","embeds.0.fields.0.value","forwarded.0.body","reply.body"]) {
		const field = document.fields.find(row => row.fieldPath === path); assert.ok(field, path);
		const request = w1.buildCompactOrderRequest(field.plan, field.plan.source, {});
		assert.equal(request.ok, true, path);
		assert.equal(request.wire.includes(path), false, path);
		assert.doesNotMatch(request.wire, /m3i-v1\||ctx\||dp1:/, path);
	}
	assert.equal(document.fields.find(row => row.fieldPath === "forwarded.0.body").relation.documentType, "forwarded");
	assert.equal(document.fields.find(row => row.fieldPath === "reply.body").relation.reuseDocumentIdentity, "dp1:prior");
	for (const lane of ["live-burst","history"]) assert.equal(w1.describePureLaneContract({lane,direction:"received",engineFamily:"ai"}).candidate, "w5-batch-pending");
	for (const lane of ["title","selection"]) assert.equal(w1.buildCompactOrderRequest(planFor("Short English"), "Short English", {}).mapping.length, 1, lane);
});
