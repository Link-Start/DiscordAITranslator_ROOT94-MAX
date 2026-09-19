const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// BetterDiscord 1.14.x resolves a plugin's `require(name)` through a whitelist switch; every
// other name (including "node:"-prefixed core modules) is treated as a file inside the plugins
// folder and the plugin fails with "Cannot find module". W3's first real load hit exactly that
// through require("node:crypto"). This contract keeps the built bundle inside the whitelist and
// loads it once through a require that behaves like BetterDiscord's.
const BETTERDISCORD_REQUIRE_WHITELIST = Object.freeze(["request", "https", "original-fs", "fs", "path", "events", "electron", "process", "vm", "module", "buffer", "crypto"]);
const BUNDLE = process.env.DTA_PLUGIN_PATH ? path.resolve(process.env.DTA_PLUGIN_PATH) : path.resolve(__dirname, "../DiscordAITranslator.plugin.js");
const REQUIRE_RE = /\brequire\(\s*(["'])([^"'\n]+)\1\s*\)/g;

function bareRequires(source) {
	const names = new Set();
	for (const match of source.matchAll(REQUIRE_RE)) if (!/^[./]/.test(match[2])) names.add(match[2]);
	return [...names].sort();
}

function createBetterDiscordRequire(seen) {
	return name => {
		seen.push(String(name));
		if (!BETTERDISCORD_REQUIRE_WHITELIST.includes(name)) throw new Error(`Cannot find module '${name}'`);
		if (name === "request") return () => {throw new Error("request transport is not available in the load contract");};
		if (name === "electron") return {ipcRenderer: {}, shell: {}};
		if (name === "process") return process;
		if (name === "original-fs") return require("fs");
		return require(name);
	};
}

// Anything BDFDB-shaped answers with a callable, property-bearing stand-in so the load contract
// exercises the module graph rather than the library. Only the load is under test here.
function permissiveStub() {
	const target = function stub() {return stub;};
	const proxy = new Proxy(target, {
		get: (_, key) => key === Symbol.toPrimitive ? () => "" : key === "then" ? undefined : key === "length" ? 0 : proxy,
		apply: () => proxy,
		construct: () => ({}),
		has: () => true
	});
	return proxy;
}

function loadBundle(source, {bdfdbLoaded}) {
	const seen = [];
	const bdfdb = permissiveStub();
	const window = {BDFDB_Global: bdfdbLoaded ? {loaded: true, started: true, PluginUtils: {buildPlugin: () => [class BasePlugin {}, bdfdb]}} : undefined};
	const sandbox = {
		window,
		document: permissiveStub(),
		BdApi: {version: "1.14.1", Plugins: {folder: path.join(__dirname, "..")}, Net: {fetch: () => Promise.reject(new Error("no network"))}, React: {Component: class Component {}}, UI: {showToast() {}, alert() {}}, Data: {load: () => null, save() {}}},
		console: {log() {}, info() {}, warn() {}, error() {}, debug() {}},
		setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate, queueMicrotask,
		Buffer, process, TextEncoder, TextDecoder, URL, URLSearchParams, AbortController, performance, structuredClone,
		Intl, Symbol, WeakRef, FinalizationRegistry
	};
	sandbox.globalThis = sandbox;
	sandbox.global = sandbox;
	sandbox.self = sandbox;
	const context = vm.createContext(sandbox);
	const wrapper = vm.compileFunction(source, ["exports", "require", "module", "__filename", "__dirname"], {parsingContext: context, filename: "DiscordAITranslator.plugin.js"});
	const module = {exports: {}};
	wrapper.call(module.exports, module.exports, createBetterDiscordRequire(seen), module, BUNDLE, path.dirname(BUNDLE));
	return {exports: module.exports, seen};
}

test("the built bundle only requires names BetterDiscord's plugin require whitelists, and never a node: module", () => {
	const source = fs.readFileSync(BUNDLE, "utf8");
	const names = bareRequires(source);
	assert.ok(names.length > 0, "the bundle requires at least fs/path for the library download path");
	const outside = names.filter(name => !BETTERDISCORD_REQUIRE_WHITELIST.includes(name));
	assert.deepEqual(outside, [], `bare requires outside the BetterDiscord whitelist: ${outside.join(", ")}`);
	assert.doesNotMatch(source, /require\(\s*["']node:/, "node:-prefixed requires are unresolvable inside BetterDiscord");
	assert.doesNotMatch(source, /\bimport\s*\(\s*["'][^"']*["']\s*\)/, "dynamic import is not part of the BetterDiscord plugin contract");
});

test("the built bundle loads through a BetterDiscord-shaped require with BDFDB missing and with BDFDB loaded", () => {
	const source = fs.readFileSync(BUNDLE, "utf8");
	const missing = loadBundle(source, {bdfdbLoaded: false});
	assert.equal(typeof missing.exports, "function", "with BDFDB missing the module returns the placeholder plugin class");
	const placeholder = new missing.exports({name: "DiscordAITranslator", version: "0.0.1", author: "x", description: "d"});
	assert.equal(placeholder.getName(), "DiscordAITranslator");
	assert.match(placeholder.getDescription(), /Library Plugin needed/);
	assert.deepEqual(missing.seen.filter(name => !BETTERDISCORD_REQUIRE_WHITELIST.includes(name)), []);
	// The BDFDB-loaded branch is where the whole module graph is evaluated; a non-whitelisted
	// require anywhere in it throws here exactly as it did in BetterDiscord.
	const loaded = loadBundle(source, {bdfdbLoaded: true});
	assert.equal(typeof loaded.exports, "function", "with BDFDB loaded the module returns the plugin class");
	assert.equal(typeof loaded.exports.prototype.translateText, "function", "the real runtime class came back, so the whole module graph was evaluated");
	assert.equal(typeof loaded.exports.prototype.createProtectedSemanticRequest, "function");
	assert.deepEqual(loaded.seen.filter(name => !BETTERDISCORD_REQUIRE_WHITELIST.includes(name)), [], "every require the module graph made at load was whitelisted");
});
