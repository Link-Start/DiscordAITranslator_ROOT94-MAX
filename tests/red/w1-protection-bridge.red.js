const test = require("node:test");
const {assert, requireW1, planFor, createProtectionFixture} = require("../helpers/w1-compact-wire-test-kit");

const FIELD_DIVIDER = "__________________ __________________ __________________";
const SOURCE = `Contact john.doe@example.com at https://api.example.com/a or docs.example.org and 192.168.1.5:8443 via /help about Longma and "KEEP". Use inline_code and \\*literal\\*.\n${FIELD_DIVIDER}\n\`inline code\` <@123> <:wave:456> GED Non-Degree Spouse/Dependent In-state Out-of-state Self-Pay “4-3”`;

test("W1 safeContext removes P1 values and planner protected text while retaining structure and target prose", () => {
	const w1 = requireW1(), fixture = createProtectionFixture({wrapperPairs: ['"|"']}), protectedSource = fixture.protect(SOURCE), plan = planFor(protectedSource.source), safe = w1.buildSafeContext(plan, protectedSource.protectedSegments);
	assert.equal(safe.ok, true);
	for (const value of ["john.doe@example.com","https://api.example.com/a","docs.example.org","192.168.1.5:8443","/help","Longma",'"KEEP"',FIELD_DIVIDER,"`inline code`","“4-3”"]) assert.equal(safe.context.includes(value), false, value);
	assert.match(safe.context, /GED/);
	assert.match(safe.context, /Non-Degree/);
	assert.match(safe.context, /Spouse\/Dependent/);
	assert.ok(safe.markerBytes > 0);
	assert.equal(safe.context.includes("\n"), true);
});

test("W1 B and C provider inputs contain zero hard-protected originals and restore exact values locally", () => {
	const w1 = requireW1(), fixture = createProtectionFixture({wrapperPairs: ['"|"']}), protectedSource = fixture.protect(SOURCE), plan = planFor(protectedSource.source), safe = w1.buildSafeContext(plan, protectedSource.protectedSegments);
	const compact = w1.buildCompactOrderRequest(plan, safe, {protectedSegments: protectedSource.protectedSegments});
	const whole = w1.buildWholeMessageRequest(plan, safe, {protectedSegments: protectedSource.protectedSegments});
	const hardValues = [...Object.values(protectedSource.protectedSegments), FIELD_DIVIDER, "`inline code`", "“4-3”"];
	for (const wire of [compact.wire, whole.wire]) for (const value of hardValues) assert.equal(wire.includes(value), false, value);
	const restored = w1.restoreProtectedContext(safe.context, safe, protectedSource.protectedSegments);
	assert.equal(restored, SOURCE);
});

test("W1 P1/context/ordinal markers own three disjoint namespaces and collisions fail closed", () => {
	const w1 = requireW1(), fixture = createProtectionFixture({wrapperPairs: ['"|"']}), protectedSource = fixture.protect(SOURCE), plan = planFor(protectedSource.source), safe = w1.buildSafeContext(plan, protectedSource.protectedSegments), request = w1.buildCompactOrderRequest(plan, safe, {responseMode: "marker", protectedSegments: protectedSource.protectedSegments});
	assert.match(safe.context, /⟦\d+⟧/);
	assert.ok(safe.contextMarkers.every(row => /^⟦C\d+⟧$/.test(row.token)));
	assert.match(request.systemPrompt, /⟦W0⟧/);
	assert.doesNotMatch(request.systemPrompt, /⟦0⟧|⟦C0⟧/);
	const collisionSource = "Translate this natural token ⟦W0⟧ please";
	assert.equal(w1.buildCompactOrderRequest(planFor(collisionSource), collisionSource, {responseMode: "marker"}).reason, "marker-collision");
});

test("W1 received protection scope off exposes only configured/wrapper values while hard protections remain hidden", () => {
	const w1 = requireW1(), fixture = createProtectionFixture({protectedTermsForReceived: false, wrapperPairsForReceived: false, wrapperPairs: ['"|"']}), protectedSource = fixture.protect(SOURCE), plan = planFor(protectedSource.source), safe = w1.buildSafeContext(plan, protectedSource.protectedSegments);
	assert.match(safe.context, /Longma/);
	assert.match(safe.context, /KEEP/);
	for (const value of ["john.doe@example.com","https://api.example.com/a","docs.example.org","192.168.1.5:8443","/help"]) assert.equal(safe.context.includes(value), false, value);
});

test("W1 never restores old blanket technical masking for admissions language", () => {
	const w1 = requireW1(), text = "GED Non-Degree Spouse/Dependent In-state Out-of-state Self-Pay Degree of Interest Military Affiliation", plan = planFor(text), request = w1.buildCompactOrderRequest(plan, text, {}), joined = JSON.parse(request.wire).x.join(" ");
	for (const term of ["GED","Non-Degree","Spouse/Dependent","In-state","Out-of-state","Self-Pay","Degree of Interest","Military Affiliation"]) assert.match(joined, new RegExp(term.replace("/", "\\/")));
});

test("W1 technical golden preserves narrow literals but still translates academic language", () => {
	const w1 = requireW1(), text = "Windows 11 API HTTP 429 “4-3” GED Non-Degree", plan = planFor(text), safe = w1.buildSafeContext(plan, {}), request = w1.buildCompactOrderRequest(plan, safe, {}), joined = JSON.parse(request.wire).x.join(" ");
	for (const literal of ["Windows 11", "API", "HTTP 429", "“4-3”"]) assert.equal(joined.includes(literal), false, literal);
	for (const term of ["GED", "Non-Degree"]) assert.equal(joined.includes(term), true, term);
});

test("W1 P1 short configured terms do not collide with legal marker bytes", () => {
	const w1 = requireW1();
	for (const term of ["0", "⟦", "a"]) {
		const fixture = createProtectionFixture({protectedTerms: [term], wrapperPairs: []}), source = `Keep ${term} here and translate English`, protectedSource = fixture.protect(source), plan = planFor(protectedSource.source), safe = w1.buildSafeContext(plan, protectedSource.protectedSegments);
		assert.equal(safe.ok, true, term);
		const request = w1.buildCompactOrderRequest(plan, safe, {protectedSegments: protectedSource.protectedSegments, rawSourceBytes: Buffer.byteLength(source)});
		assert.equal(request.ok, true, term);
		assert.equal(w1.restoreProtectedContext(safe.context, safe, protectedSource.protectedSegments), source, term);
	}
});

test("W1 supplied safe context keeps raw source bytes for coverage and source budget", () => {
	const w1 = requireW1(), source = `"${"X".repeat(5000)}" English`, fixture = createProtectionFixture({protectedTerms: [], wrapperPairs: ['"|"']}), protectedSource = fixture.protect(source), plan = planFor(protectedSource.source), rawSourceBytes = Buffer.byteLength(source), safe = w1.buildSafeContext(plan, protectedSource.protectedSegments, {rawSourceBytes});
	const request = w1.buildCompactOrderRequest(plan, safe, {rawSourceBytes, protectedSegments: protectedSource.protectedSegments});
	assert.equal(request.sourceBytes, rawSourceBytes);
	assert.ok(request.coverageRatio < 0.01, request.coverageRatio);
	assert.equal(request.contextIncluded, true);
	assert.equal(w1.buildCompactOrderRequest(plan, safe, {rawSourceBytes, maxSourceBytes: 1000, protectedSegments: protectedSource.protectedSegments}).reason, "source-budget");
});
