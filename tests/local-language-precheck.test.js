const test = require("node:test");
const assert = require("node:assert/strict");
const {createLocalLanguagePrecheckPluginInstance: createPluginInstance} = require("./helpers/createPluginInstance");

test("identifyLatinLanguage detects English with high confidence", () => {
	const plugin = createPluginInstance();
	const result = plugin.identifyLatinLanguage("hello there my friend, how are you doing today");
	assert.equal(result.languageId, "en");
	assert.equal(result.confident, true);
});

test("identifyLatinLanguage detects French and distinguishes it from English", () => {
	const plugin = createPluginInstance();
	const result = plugin.identifyLatinLanguage("je ne sais pas ce que tu veux dire avec ce mot");
	assert.equal(result.languageId, "fr");
	assert.equal(result.confident, true);
});

test("identifyLatinLanguage is not confident on short messages", () => {
	const plugin = createPluginInstance();
	const result = plugin.identifyLatinLanguage("ok hello");
	assert.equal(result.confident, false);
});

test("detectMessageLanguageLocal identifies a confident Latin language only for Latin targets", () => {
	const plugin = createPluginInstance();
	const text = "je ne sais pas ce que tu veux dire avec ce mot";
	const latinAnalysis = plugin.analyzeTextForAutoTranslate(text, "en");
	const nonLatinAnalysis = plugin.analyzeTextForAutoTranslate(text, "zh-CN");
	const latinResult = plugin.detectMessageLanguageLocal(text, latinAnalysis, "en");
	const nonLatinResult = plugin.detectMessageLanguageLocal(text, nonLatinAnalysis, "zh-CN");

	assert.equal(latinResult.languageId, "fr");
	assert.equal(latinResult.confident, true);
	assert.equal(nonLatinResult.languageId, null);
	assert.equal(nonLatinResult.confident, false);
});

test("local precheck skips a same-language English message before requesting translation", () => {
	const plugin = createPluginInstance();
	const message = {
		id: "msg-en-same",
		content: "hello there my friend, how are you doing today",
		embeds: [],
		author: {id: "other-user"}
	};
	// Target language is English; an English message should be skipped locally.
	assert.equal(plugin.shouldAutoTranslateReceivedMessage(message, {id: "channel-1"}, null, true), false);
});

test("local precheck does not skip a foreign-language message that needs translation", () => {
	const plugin = createPluginInstance();
	const message = {
		id: "msg-fr-foreign",
		content: "je ne sais pas ce que tu veux dire avec ce mot",
		embeds: [],
		author: {id: "other-user"}
	};
	assert.equal(plugin.shouldAutoTranslateReceivedMessage(message, {id: "channel-2"}, null, true), true);
});

test("disabling useLocalLanguagePrecheck lets a same-language English message through", () => {
	const plugin = createPluginInstance();
	plugin.settings.filters.useLocalLanguagePrecheck = false;
	const message = {
		id: "msg-en-precheck-off",
		content: "hello there my friend, how are you doing today",
		embeds: [],
		author: {id: "other-user"}
	};
	// With the precheck off, the Latin same-language case is not caught locally.
	assert.equal(plugin.shouldAutoTranslateReceivedMessage(message, {id: "channel-3"}, null, true), true);
});

test("requestWithTimeout fires a 504 callback when the underlying request hangs", async () => {
	const plugin = createPluginInstance();
	plugin._testBdfdb.LibraryRequires.request = () => {}; // hung: never calls back
	await new Promise(resolve => {
		plugin.requestWithTimeout("https://example.invalid", {}, (error, response, body) => {
			assert.equal(error, null);
			assert.equal(response && response.statusCode, 504);
			assert.equal(body, "");
			resolve();
		}, 40);
	});
});

test("requestWithTimeout triggers backoff on a 429 response", () => {
	const plugin = createPluginInstance();
	let backoffMs = null;
	plugin.scheduleAutoTranslationBackoff = ms => { backoffMs = ms; };
	plugin._testBdfdb.LibraryRequires.request = (url, opts, cb) => cb(null, {statusCode: 429}, "");
	plugin.requestWithTimeout("https://example.invalid", {}, () => {}, 1000);
	assert.equal(backoffMs, 5000);
});

test("requestWithTimeout triggers backoff on a 5xx response", () => {
	const plugin = createPluginInstance();
	let backoffMs = null;
	plugin.scheduleAutoTranslationBackoff = ms => { backoffMs = ms; };
	plugin._testBdfdb.LibraryRequires.request = (url, opts, cb) => cb(null, {statusCode: 503}, "");
	plugin.requestWithTimeout("https://example.invalid", {}, () => {}, 1000);
	assert.equal(backoffMs, 2000);
});

test("requestWithTimeout does not double-fire when the real response arrives late", async () => {
	const plugin = createPluginInstance();
	let calls = 0;
	let lateCallback = null;
	plugin._testBdfdb.LibraryRequires.request = (url, opts, cb) => { lateCallback = cb; };
	plugin.requestWithTimeout("https://example.invalid", {}, () => { calls++; }, 40);
	await new Promise(resolve => setTimeout(resolve, 120)); // timeout fires first
	if (lateCallback) lateCallback(null, {statusCode: 200}, "late"); // late real response ignored
	assert.equal(calls, 1);
});

test("isClearlyForeignLanguageMessage: English sentence to Chinese target is clearly foreign", () => {
	const plugin = createPluginInstance();
	assert.equal(plugin.isClearlyForeignLanguageMessage("hello there my friend how are you doing today", "zh-CN"), true);
});

test("isClearlyForeignLanguageMessage: all-caps English to Chinese target is clearly foreign (varun regression)", () => {
	const plugin = createPluginInstance();
	assert.equal(plugin.isClearlyForeignLanguageMessage("I THINK IF U USE 2 HIGGS ACCOUNTS THEN UR ACCOUNTS WOULD BE BANNED", "zh-CN"), true);
});

test("isClearlyForeignLanguageMessage: Chinese sentence to Chinese target is not foreign", () => {
	const plugin = createPluginInstance();
	assert.equal(plugin.isClearlyForeignLanguageMessage("今天天气真好我们一起出去玩吧", "zh-CN"), false);
});

test("isClearlyForeignLanguageMessage: French sentence to English target is clearly foreign", () => {
	const plugin = createPluginInstance();
	assert.equal(plugin.isClearlyForeignLanguageMessage("je ne sais pas ce que tu veux dire avec ce mot", "en"), true);
});

test("isClearlyForeignLanguageMessage: short token to Chinese target is not clearly foreign", () => {
	const plugin = createPluginInstance();
	assert.equal(plugin.isClearlyForeignLanguageMessage("ok", "zh-CN"), false);
});

test("isClearlyForeignLanguageMessage: Chinese with English proper noun is not clearly foreign", () => {
	const plugin = createPluginInstance();
	assert.equal(plugin.isClearlyForeignLanguageMessage("我用 Dropbox 同步文件没问题", "zh-CN"), false);
});

test("isTranslationLikelyInTargetLanguage rejects an obvious wrong-script translation", () => {
	const plugin = createPluginInstance();
	assert.equal(plugin.isTranslationLikelyInTargetLanguage("hello there my friend", "zh-CN"), false);
	assert.equal(plugin.isTranslationLikelyInTargetLanguage("你好朋友", "zh-CN"), true);
});

test("isTranslationLikelyInTargetLanguage rejects confident wrong Latin languages", () => {
	const plugin = createPluginInstance();

	assert.equal(plugin.isTranslationLikelyInTargetLanguage("hello there my friend, how are you doing today", "fr"), false);
	assert.equal(plugin.isTranslationLikelyInTargetLanguage("je ne sais pas ce que tu veux dire avec ce mot", "en"), false);
	assert.equal(plugin.isTranslationLikelyInTargetLanguage("no se que hacer porque esto es para todos los que estan aqui", "en"), false);
	assert.equal(plugin.isTranslationLikelyInTargetLanguage("je ne sais pas ce que tu veux dire avec ce mot", "fr"), true);
	assert.equal(plugin.isTranslationLikelyInTargetLanguage("ok hello", "fr"), true);
});

test("isTranslationLikelyInTargetLanguage rejects high-confidence wrong-language short Latin words", () => {
	const plugin = createPluginInstance();
	const mismatches = [
		["oui", "en"],
		["bonjour", "en"],
		["hola", "en"],
		["gracias", "en"],
		["yes", "fr"],
		["oui", "zh-CN"]
	];
	for (const [text, target] of mismatches) assert.equal(plugin.isTranslationLikelyInTargetLanguage(text, target), false, `${text} should not be accepted as ${target}`);

	assert.equal(plugin.isTranslationLikelyInTargetLanguage("oui", "fr"), true);
	assert.equal(plugin.isTranslationLikelyInTargetLanguage("hola", "es"), true);
	assert.equal(plugin.isTranslationLikelyInTargetLanguage("yes", "en"), true);
});

test("isTranslationLikelyInTargetLanguage keeps ambiguous and unknown short Latin words", () => {
	const plugin = createPluginInstance();

	for (const text of ["ok", "no", "Rin", "Codex"]) {
		assert.equal(plugin.isTranslationLikelyInTargetLanguage(text, "fr"), true, `${text} should remain conservative`);
	}
});

test("detectLanguage: empty text short-circuits without calling Google", () => {
	const plugin = createPluginInstance();
	let requestCalls = 0;
	plugin._testBdfdb.LibraryRequires.request = () => { requestCalls++; };
	return new Promise(resolve => {
		plugin.detectLanguage("   ", languageId => {
			assert.equal(languageId, null);
			assert.equal(requestCalls, 0);
			resolve();
		});
	});
});

test("detectLanguage: successful Google response returns src and uses trimmed encoded text", () => {
	const plugin = createPluginInstance();
	let seenUrl = null;
	let seenQuery = null;
	plugin._testBdfdb.LibraryRequires.request = (url, opts, cb) => {
		seenUrl = url;
		seenQuery = opts && opts.form && opts.form.q;
		cb(null, {statusCode: 200}, JSON.stringify({src: "fr"}));
	};
	return new Promise(resolve => {
		plugin.detectLanguage("  bonjour  ", languageId => {
			assert.equal(seenUrl, "https://translate.googleapis.com/translate_a/single");
			assert.equal(seenQuery, encodeURIComponent("bonjour"));
			assert.equal(languageId, "fr");
			resolve();
		});
	});
});

test("detectLanguage: invalid Google JSON resolves null", () => {
	const plugin = createPluginInstance();
	plugin._testBdfdb.LibraryRequires.request = (url, opts, cb) => cb(null, {statusCode: 200}, "{not-json");
	return new Promise(resolve => {
		plugin.detectLanguage("bonjour", languageId => {
			assert.equal(languageId, null);
			resolve();
		});
	});
});

test("language detection local-first strategy avoids the network on confident text", async () => {
	const plugin = createPluginInstance();
	plugin.settings.filters.languageDetectionStrategy = "local_first";
	plugin._testBdfdb.LibraryRequires.request = () => {
		throw new Error("network should not be used for confident local detection");
	};

	const detected = await new Promise(resolve => plugin.detectLanguage("the quick brown fox and the small dog are here", resolve));
	assert.equal(detected, "en");
});

test("language detection local-only strategy returns null when local evidence is uncertain", async () => {
	const plugin = createPluginInstance();
	plugin.settings.filters.languageDetectionStrategy = "local_only";
	let requestCalls = 0;
	plugin._testBdfdb.LibraryRequires.request = () => {
		requestCalls++;
	};

	const detected = await new Promise(resolve => plugin.detectLanguage("bonjour", resolve));
	assert.equal(detected, null);
	assert.equal(requestCalls, 0);
});

test("language detection Google strategy bypasses a confident local result", async () => {
	const plugin = createPluginInstance();
	plugin.settings.filters.languageDetectionStrategy = "google_free";
	let requestCalls = 0;
	plugin._testBdfdb.LibraryRequires.request = (_url, _options, callback) => {
		requestCalls++;
		callback(null, {statusCode: 200}, JSON.stringify({src: "fr"}));
	};

	const detected = await new Promise(resolve => plugin.detectLanguage("the quick brown fox and the small dog are here", resolve));
	assert.equal(detected, "fr");
	assert.equal(requestCalls, 1);
});

test("isReceivedMessageForeignAsync: local fast-path returns true without calling Google", () => {
	const plugin = createPluginInstance();
	plugin._testBdfdb.LibraryRequires.request = () => { throw new Error("Google detect should not be called"); };
	return new Promise(resolve => {
		plugin.isReceivedMessageForeignAsync("hello there my friend how are you doing today", "zh-CN", isForeign => {
			assert.equal(isForeign, true);
			resolve();
		});
	});
});

test("isReceivedMessageForeignAsync: auto target short-circuits false without detectLanguage", () => {
	const plugin = createPluginInstance();
	let detectCalls = 0;
	plugin.detectLanguage = () => { detectCalls++; };
	return new Promise(resolve => {
		plugin.isReceivedMessageForeignAsync("bonjour", "auto", isForeign => {
			assert.equal(isForeign, false);
			assert.equal(detectCalls, 0);
			resolve();
		});
	});
});

test("isReceivedMessageForeignAsync: falls through the public detectLanguage seam when local check is inconclusive", () => {
	const plugin = createPluginInstance();
	let detectCalls = 0;
	plugin.isClearlyForeignLanguageMessage = () => false;
	plugin.detectLanguage = (_text, callback) => {
		detectCalls++;
		callback("fr");
	};
	return new Promise(resolve => {
		plugin.isReceivedMessageForeignAsync("bonjour", "en", isForeign => {
			assert.equal(isForeign, true);
			assert.equal(detectCalls, 1);
			resolve();
		});
	});
});

test("isReceivedMessageForeignAsync: Google detects a different language -> foreign", () => {
	const plugin = createPluginInstance();
	plugin._testBdfdb.LibraryRequires.request = (url, opts, cb) => cb(null, {statusCode: 200}, JSON.stringify({src: "fr"}));
	return new Promise(resolve => {
		plugin.isReceivedMessageForeignAsync("bonjour", "en", isForeign => {
			assert.equal(isForeign, true);
			resolve();
		});
	});
});

test("isReceivedMessageForeignAsync: Google detects the same language -> not foreign", () => {
	const plugin = createPluginInstance();
	plugin._testBdfdb.LibraryRequires.request = (url, opts, cb) => cb(null, {statusCode: 200}, JSON.stringify({src: "en"}));
	return new Promise(resolve => {
		plugin.isReceivedMessageForeignAsync("bonjour", "en", isForeign => {
			assert.equal(isForeign, false);
			resolve();
		});
	});
});

test("isReceivedMessageForeignAsync: Google unreachable -> not foreign (honors skip)", () => {
	const plugin = createPluginInstance();
	plugin._testBdfdb.LibraryRequires.request = (url, opts, cb) => cb(new Error("net"), null, "");
	return new Promise(resolve => {
		plugin.isReceivedMessageForeignAsync("bonjour", "en", isForeign => {
			assert.equal(isForeign, false);
			resolve();
		});
	});
});
