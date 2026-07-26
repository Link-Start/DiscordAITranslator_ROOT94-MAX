const test = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const {createPluginInstance} = require("./helpers/createPluginInstance");

const root = path.resolve(__dirname, "..");
const buildScript = path.join(root, "scripts", "build-plugin.mjs");
const releasePath = path.join(root, "DiscordAITranslator.plugin.js");

test("the committed BetterDiscord plugin matches the deterministic source build", async () => {
	const {createPluginBundle} = await import("../scripts/build-plugin.mjs");
	const firstGenerated = await createPluginBundle();
	const secondGenerated = await createPluginBundle();
	const committed = fs.readFileSync(releasePath, "utf8");

	assert.equal(firstGenerated, secondGenerated);
	assert.equal(committed, firstGenerated);
});

test("the generated plugin keeps metadata and excludes development artifacts", async () => {
	const {createPluginBundle} = await import("../scripts/build-plugin.mjs");
	const generated = await createPluginBundle();
	const debugGenerated = await createPluginBundle({debug: true});
	const releaseBeforeDebug = fs.readFileSync(releasePath);
	const debugResult = childProcess.spawnSync(process.execPath, [buildScript, "--debug"], {
		cwd: root,
		encoding: "utf8"
	});
	const conflictingFlagsResult = childProcess.spawnSync(process.execPath, [buildScript, "--debug", "--check"], {
		cwd: root,
		encoding: "utf8"
	});
	const packageLock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
	const activeEsbuildPackage = packageLock.packages[`node_modules/@esbuild/${process.platform}-${process.arch}`];
	const plugin = createPluginInstance({callSetLanguages: false});

	assert.match(generated, /^\/\*\*[\s\S]*@name DiscordAITranslator/);
	assert.match(generated, /@version 0\.3\.36/);
	assert.doesNotMatch(generated, /sourceMappingURL=/);
	assert.doesNotMatch(generated, /tests\//);
	assert.doesNotMatch(generated, /TRANSLATOR_DISPLAY_DEBUG_JOURNAL/);
	assert.equal(plugin.constructor.name, "Translator");
	assert.equal(debugResult.status, 0, debugResult.stderr);
	assert.equal(debugResult.stdout, debugGenerated);
	assert.deepEqual(fs.readFileSync(releasePath), releaseBeforeDebug);
	assert.notEqual(conflictingFlagsResult.status, 0);
	assert.equal(conflictingFlagsResult.stdout, "");
	assert.equal(conflictingFlagsResult.stderr.trim(), "--debug and --check are mutually exclusive.");
	assert.ok(activeEsbuildPackage);
	assert.match(activeEsbuildPackage.resolved, /^https:\/\/registry\.npmjs\.org\/@esbuild\/[^/]+\/-\/[^/]+\.tgz$/);
	assert.match(activeEsbuildPackage.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
});

test("the generated plugin stays inside the first-milestone size budget", () => {
	const pluginBytes = fs.statSync(releasePath).size;
	assert.ok(pluginBytes <= 700 * 1024, `generated plugin unexpectedly exceeds 700 KB: ${pluginBytes} bytes`);
});
