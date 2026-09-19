const test = require("node:test");
const assert = require("node:assert/strict");
const {
	LANGUAGE_DIRECTIONS,
	createEmptyChannelEnablementState,
	normalizeStoredChannelEnablementState,
	migrateLegacyChannelEnablementState,
	loadChannelEnablementState,
	getChannelEnablementStateValue,
	channelEnablementStatesEqual,
	createSettingsStore
} = require("../src/settings/settings-store");

const INPUT = LANGUAGE_DIRECTIONS.INPUT;
const OUTPUT = LANGUAGE_DIRECTIONS.OUTPUT;
const RECEIVED = "received";
const SENT = "sent";

test("Baidu split fields preserve legacy credentials and partial edits across reloads", () => {
	for (const key of ["fixture-app fixture-secret", "fixture-app legacy-middle fixture-secret"]) {
		const {store, persisted} = createHarness({persisted: {authKeys: {baidu: {key}, deepl: {key: "unrelated"}}}});
		store.reload();
		assert.equal(store.getCredentialField("baidu", "appId"), "fixture-app");
		assert.equal(store.getCredentialField("baidu", "secretKey"), "fixture-secret");
		assert.equal(persisted.authKeys.baidu.key, key, "reading never rewrites a credential");
		store.setCredentialField("baidu", "appId", " new-app ");
		assert.equal(persisted.authKeys.baidu.key, "new-app fixture-secret");
		store.setCredentialField("baidu", "appId", "");
		store.reload();
		assert.equal(store.getCredentialField("baidu", "appId"), "");
		assert.equal(store.getCredentialField("baidu", "secretKey"), "fixture-secret");
		assert.equal(persisted.authKeys.baidu.key, "", "incomplete configuration is not routable by old builds");
		store.setCredentialField("baidu", "appId", "new-app");
		store.setCredentialField("baidu", "secretKey", " new-secret ");
		assert.equal(persisted.authKeys.baidu.key, "new-app new-secret");
		assert.equal(persisted.authKeys.deepl.key, "unrelated");
	}
});

function clone(value) {
	return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function createLanguageTable() {
	return {
		auto: {id: "auto", name: "Detect", auto: true},
		en: {id: "en", name: "English"},
		"zh-CN": {id: "zh-CN", name: "Chinese"},
		ru: {id: "ru", name: "Russian"}
	};
}

// One harness for every test: a fake profile on "disk", a fake engine catalogue and a
// fake channel-to-guild map. Nothing here needs a plugin instance.
function createHarness(options = {}) {
	const persisted = Object.assign({
		favorites: [],
		authKeys: {},
		channelLanguages: {},
		guildLanguages: {},
		channelPrimaryEngineOverrides: {},
		translationEnabledStates: null,
		receivedAutoTranslationEnabledStates: null,
		choices: {}
	}, options.persisted || {});
	const installedEngines = options.installedEngines || ["googleapi", "deepseek", "deepl"];
	const guildsByChannel = options.guildsByChannel || {};
	const writes = [];

	function record(key, value) {
		persisted[key] = clone(value);
		writes.push({key, value: clone(value)});
	}

	const store = createSettingsStore({
		now: options.now || Date.now,
		isKnownEngine: engineKey => installedEngines.includes(engineKey),
		sortLanguages: options.sortLanguages || (table => table),
		resolveGuildId: channelId => channelId && guildsByChannel[channelId] || null,
		loadFavorites: () => persisted.favorites,
		persistFavorites: value => record("favorites", value),
		loadAuthKeys: () => persisted.authKeys,
		persistAuthKeys: value => record("authKeys", value),
		loadChannelLanguages: () => persisted.channelLanguages,
		persistChannelLanguages: value => record("channelLanguages", value),
		loadGuildLanguages: () => persisted.guildLanguages,
		persistGuildLanguages: value => record("guildLanguages", value),
		loadChannelPrimaryEngineOverrides: () => persisted.channelPrimaryEngineOverrides,
		persistChannelPrimaryEngineOverrides: value => record("channelPrimaryEngineOverrides", value),
		loadTranslationEnabledStates: () => persisted.translationEnabledStates,
		loadReceivedAutoTranslationEnabledStates: () => persisted.receivedAutoTranslationEnabledStates,
		persistChannelEnablementState: value => {
			record("translationEnabledStates", value);
			record("receivedAutoTranslationEnabledStates", value);
		},
		loadGlobalLanguageChoice: (place, direction) => persisted.choices[place] && persisted.choices[place][direction],
		persistGlobalLanguageChoice: (place, direction, choice) => {
			const choices = Object.assign({}, persisted.choices);
			choices[place] = Object.assign({}, choices[place]);
			choices[place][direction] = choice;
			record("choices", choices);
		},
		resolveLegacyDiscordLanguage: options.resolveLegacyDiscordLanguage || (() => "zh-CN")
	});

	if (options.languages !== null) store.setLanguages(options.languages || createLanguageTable());
	return {store, persisted, writes, keysWritten: () => writes.map(entry => entry.key)};
}

test("setLanguages stamps favourite flags and hands the table to the ordering hook", () => {
	const ordered = [];
	const {store} = createHarness({
		persisted: {favorites: ["zh-CN"]},
		languages: null,
		sortLanguages: table => {
			ordered.push(Object.keys(table));
			return Object.fromEntries(Object.entries(table).sort(([, left], [, right]) => left.fav - right.fav));
		}
	});
	store.reload();

	const languages = store.setLanguages(createLanguageTable());

	assert.equal(languages["zh-CN"].fav, 0);
	assert.equal(languages.en.fav, 1);
	assert.equal(languages.auto.fav, 1);
	assert.deepEqual(ordered, [["auto", "en", "zh-CN", "ru"]]);
	assert.equal(store.getFirstLanguageId(), "zh-CN");
	assert.equal(store.getLanguages(), languages);
});

test("setLanguages survives a table entry that is not a language record", () => {
	const {store} = createHarness({languages: null});

	store.setLanguages({en: {id: "en"}, broken: null});

	assert.equal(store.getLanguage("en").fav, 1);
	assert.equal(store.getLanguage("broken"), null);
});

test("the retired Discord language alias is not exposed as a selectable language", () => {
	const {store} = createHarness({languages: null});

	store.setLanguages(Object.assign(createLanguageTable(), {
		$discord: {id: "zh-CN", name: "Discord (Chinese (China))"}
	}));

	assert.equal(store.getLanguage("$discord"), null);
	assert.equal(store.getLanguage("zh-CN").id, "zh-CN");
	assert.equal(store.getLanguageIds().includes("$discord"), false);
});

test("language lookups answer from the current table", () => {
	const {store} = createHarness();

	assert.equal(store.getLanguage("en").name, "English");
	assert.equal(store.getLanguage("xx"), null);
	assert.equal(store.hasLanguage("ru"), true);
	assert.equal(store.hasLanguage("xx"), false);
	assert.deepEqual(store.getLanguageIds(), ["auto", "en", "zh-CN", "ru"]);
	assert.equal(store.getFirstLanguageId(), "auto");
});

test("toggling a favourite persists a sorted list and never duplicates an id", () => {
	const {store, persisted} = createHarness();

	store.setFavorite("ru", true);
	store.setFavorite("en", true);
	store.setFavorite("ru", true);

	assert.deepEqual(persisted.favorites, ["en", "ru"]);
	assert.equal(store.isFavorite("ru"), true);

	store.setFavorite("ru", false);

	assert.deepEqual(persisted.favorites, ["en"]);
	assert.equal(store.isFavorite("ru"), false);
});

test("a favourite toggle without a language id changes nothing", () => {
	const {store, keysWritten} = createHarness();

	store.setFavorite("", true);

	assert.deepEqual(store.getFavorites(), []);
	assert.deepEqual(keysWritten(), []);
});

test("credential text fields are trimmed and persisted on every write", () => {
	const {store, persisted, keysWritten} = createHarness();

	store.setCredentialField("openai", "key", "  sk-secret  ");
	store.setCredentialField("openai", "endpoint", "https://example.invalid/v1  ");

	assert.deepEqual(persisted.authKeys, {openai: {key: "sk-secret", endpoint: "https://example.invalid/v1"}});
	assert.deepEqual(keysWritten(), ["authKeys", "authKeys"]);
	assert.equal(store.getCredentialField("openai", "key"), "sk-secret");
});

test("a credential text field that is cleared is stored as an empty string", () => {
	const {store, persisted} = createHarness();

	store.setCredentialField("openai", "key", null);

	assert.deepEqual(persisted.authKeys, {openai: {key: ""}});
});

test("credential flags are stored raw so a false switch stays false", () => {
	const {store, persisted} = createHarness();

	store.setCredentialFlag("deepl", "paid", true);
	assert.equal(persisted.authKeys.deepl.paid, true);

	store.setCredentialFlag("deepl", "paid", false);
	assert.equal(persisted.authKeys.deepl.paid, false);
	assert.equal(store.getCredentialField("deepl", "paid"), false);
});

test("setCredential replaces one engine record and leaves the others alone", () => {
	const {store, persisted} = createHarness({persisted: {authKeys: {deepl: {key: "old"}, openai: {key: "keep"}}}});
	store.reload();

	store.setCredential("deepl", {key: "new", model: "m"});

	assert.deepEqual(persisted.authKeys, {deepl: {key: "new", model: "m"}, openai: {key: "keep"}});
});

test("deleting a custom provider credential removes its complete per-engine record", () => {
	const {store, persisted} = createHarness({persisted: {authKeys: {
		"custom-a": {key: "secret", endpoint: "https://example.invalid", model: "m", reasoningMode: "off", reasoningProfile: "qwen"},
		openai: {key: "keep"}
	}}});
	store.reload();
	assert.equal(store.deleteCredential("custom-a"), true);
	assert.deepEqual(persisted.authKeys, {openai: {key: "keep"}});
	assert.equal(store.deleteCredential("custom-a"), false, "a missing record does not write again");
});

test("custom interface format and detection are isolated per platform and endpoint changes retire only local evidence", () => {
	let clock = 300;
	const {store, persisted} = createHarness({now: () => ++clock});
	store.setCredentialField("custom-a", "endpoint", "https://a.test/v1");
	store.setCredentialField("custom-a", "interfaceFormat", "openai_responses");
	store.setInterfaceDetection("custom-a", {resolved: "openai_responses", endpointKey: "https://a.test/v1", evidence: "validation", adapterVersion: 1});
	store.setCredentialField("custom-b", "endpoint", "https://b.test/v1/chat/completions");
	store.setCredentialField("custom-b", "interfaceFormat", "auto");
	store.setInterfaceDetection("custom-b", {resolved: "openai_chat", endpointKey: "https://b.test/v1/chat/completions", evidence: "catalog", adapterVersion: 1});

	assert.equal(store.getCredentialField("custom-a", "interfaceFormat"), "openai_responses");
	assert.equal(store.getInterfaceDetection("custom-a").resolved, "openai_responses");
	assert.equal(store.getInterfaceDetection("custom-b").resolved, "openai_chat");
	assert.equal(store.getInterfaceDetection("custom-b").evidence, "catalog");
	store.setCredentialField("custom-b", "interfaceFormat", "openai_chat");
	assert.equal(store.getInterfaceDetection("custom-b"), null, "format changes retire only that platform's evidence");
	store.setInterfaceDetection("custom-b", {resolved: "openai_chat", endpointKey: "https://b.test/v1/chat/completions", evidence: "validation", adapterVersion: 1});

	store.setCredentialField("custom-a", "endpoint", "https://a.test/v2");
	assert.equal(store.getInterfaceDetection("custom-a"), null);
	assert.equal(store.getInterfaceDetection("custom-b").resolved, "openai_chat");
	assert.equal(persisted.authKeys["custom-b"].endpoint, "https://b.test/v1/chat/completions");

	assert.equal(store.deleteCredential("custom-a"), true);
	assert.equal(persisted.authKeys["custom-a"], undefined);
	assert.equal(persisted.authKeys["custom-b"].interfaceDetection.resolved, "openai_chat");
});

test("reasoning model preferences are isolated by exact model id and preserve legacy engine defaults", () => {
	let clock = 100;
	const {store, persisted} = createHarness({now: () => ++clock, persisted: {authKeys: {"custom-a": {
		key: "secret",
		model: "Model-A",
		reasoningMode: "off",
		reasoningProfile: "qwen"
	}}}});
	store.reload();
	assert.equal(store.getReasoningModelPref("custom-a", "Model-A"), null);
	const modelA = store.setReasoningModelPref("custom-a", "Model-A", {mode: "on", profile: "openai", effort: "low"});
	const modelB = store.setReasoningModelPref("custom-a", "model-a", {mode: "follow", profile: "auto", effort: "medium"});
	assert.deepEqual(modelA, {mode: "on", profile: "openai", effort: "low", capability: null, checkedAt: 101, onRaw: "low"}, "the typed raw mirrors the legacy effort until an exact value is chosen");
	assert.deepEqual(modelB, {mode: "follow", profile: "auto", effort: "medium", capability: null, checkedAt: 102, onRaw: "medium"});
	assert.deepEqual(store.getReasoningModelPref("custom-a", "Model-A"), modelA, "model ids remain case-sensitive");
	assert.deepEqual(store.getReasoningModelPref("custom-a", "model-a"), modelB);
	assert.equal(persisted.authKeys["custom-a"].reasoningMode, "off", "legacy defaults remain rollback-readable");
	assert.equal(persisted.authKeys["custom-a"].reasoningProfile, "qwen");
});

test("reasoning capability updates preserve model intent and can be invalidated without deleting it", () => {
	let clock = 200;
	const {store} = createHarness({now: () => ++clock, persisted: {authKeys: {"custom-a": {key: "secret"}}}});
	store.reload();
	store.setReasoningModelPref("custom-a", "gpt-x", {mode: "off", profile: "openai", effort: "low"});
	const withCapability = store.setReasoningModelCapability("custom-a", "gpt-x", {
		support: "accepted",
		candidateId: "openai_none",
		resolvedValue: "none",
		evidence: "confirmed",
		endpointKey: "https://one.test/v1/chat/completions",
		checkedAt: 999,
		rawResponse: "must not persist"
	});
	assert.deepEqual(withCapability, {
		mode: "off",
		profile: "openai",
		effort: "low",
		capability: {
			support: "accepted",
			candidateId: "openai_none",
			resolvedValue: "none",
			evidence: "confirmed",
			endpointKey: "https://one.test/v1/chat/completions",
			checkedAt: 999
		},
		checkedAt: 202,
		onRaw: "low",
		controlProfile: {
			schemaId: "",
			controlKind: "",
			tiers: [{rawKey: "s:none", raw: "none", availability: "supported"}],
			tierStates: {"s:none": {state: "confirmed", evidence: "confirmed", checkedAt: 999}},
			custom: null,
			speed: "idle",
			endpointKey: "https://one.test/v1/chat/completions",
			format: "",
			adapterVersion: 1,
			checkedAt: 999,
			offRaw: "none"
		}
	}, "a legacy capability is also surfaced as its own tier verdict");
	const cleared = store.clearReasoningModelCapability("custom-a", "gpt-x");
	assert.equal(cleared.capability, null);
	assert.equal(cleared.mode, "off");
	assert.equal(cleared.profile, "openai");
});

test("reasoning model preference storage keeps only the fifty most recently touched models", () => {
	let clock = 0;
	const {store, persisted} = createHarness({now: () => ++clock, persisted: {authKeys: {"custom-a": {key: "secret"}}}});
	store.reload();
	for (let index = 0; index < 52; index++) store.setReasoningModelPref("custom-a", `model-${index}`, {mode: "follow"});
	assert.equal(Object.keys(persisted.authKeys["custom-a"].reasoningModels).length, 50);
	assert.equal(store.getReasoningModelPref("custom-a", "model-0"), null);
	assert.equal(store.getReasoningModelPref("custom-a", "model-1"), null);
	assert.equal(store.getReasoningModelPref("custom-a", "model-2").mode, "follow");
	assert.equal(store.clearReasoningModelPrefs("custom-a"), 50);
	assert.equal(persisted.authKeys["custom-a"].reasoningModels, undefined);
});

test("reasoning preference access rejects empty model ids and malformed stored collections", () => {
	const {store, persisted} = createHarness({persisted: {authKeys: {"custom-a": {reasoningModels: []}}}});
	store.reload();
	assert.equal(store.getReasoningModelPref("custom-a", ""), null);
	assert.equal(store.setReasoningModelPref("custom-a", "  ", {mode: "on"}), null);
	assert.equal(store.setReasoningModelCapability("custom-a", "", {support: "accepted"}), null);
	assert.equal(store.clearReasoningModelCapability("custom-a", ""), null);
	assert.equal(store.clearReasoningModelPrefs("custom-a"), 0);
	assert.equal(persisted.authKeys["custom-a"].reasoningModels, undefined);
});

test("replaceAuthKeys persists the non-empty table the provider client hands back", () => {
	const {store, persisted, keysWritten} = createHarness();

	const authKeys = store.getAuthKeys();
	authKeys.gemini = {key: "k", endpoint: "https://normalized.invalid"};
	store.replaceAuthKeys(authKeys);

	assert.deepEqual(persisted.authKeys, {gemini: {key: "k", endpoint: "https://normalized.invalid"}});
	assert.deepEqual(keysWritten(), ["authKeys"]);
});

test("replaceAuthKeys preserves a populated table for non-record payloads", () => {
	for (const nextAuthKeys of [null, [], "invalid"]) {
		const {store, persisted, keysWritten} = createHarness({persisted: {authKeys: {deepl: {key: "old"}}}});
		store.reload();

		store.replaceAuthKeys(nextAuthKeys);

		assert.deepEqual(persisted.authKeys, {deepl: {key: "old"}});
		assert.deepEqual(store.getAuthKeys(), {deepl: {key: "old"}});
		assert.deepEqual(keysWritten(), []);
	}
});

test("replaceAuthKeys preserves a populated current table when the provider client hands back an empty record", () => {
	const {store, persisted, keysWritten} = createHarness({persisted: {authKeys: {deepl: {key: "old"}}}});
	store.reload();

	store.replaceAuthKeys({});

	assert.deepEqual(persisted.authKeys, {deepl: {key: "old"}});
	assert.deepEqual(store.getAuthKeys(), {deepl: {key: "old"}});
	assert.deepEqual(keysWritten(), []);
});

test("replaceAuthKeys reloads persisted credentials before accepting an empty record from a stale store", () => {
	const {store, persisted, keysWritten} = createHarness({persisted: {authKeys: {deepl: {key: "old"}}}});

	store.replaceAuthKeys({});

	assert.deepEqual(persisted.authKeys, {deepl: {key: "old"}});
	assert.deepEqual(store.getAuthKeys(), {deepl: {key: "old"}});
	assert.deepEqual(keysWritten(), []);
});

test("replaceAuthKeys treats an empty record as a harmless no-op when storage is empty", () => {
	const {store, persisted, keysWritten} = createHarness();

	store.replaceAuthKeys({});

	assert.deepEqual(persisted.authKeys, {});
	assert.deepEqual(store.getAuthKeys(), {});
	assert.deepEqual(keysWritten(), []);
});

test("credential reads report nothing for an engine that was never configured", () => {
	const {store} = createHarness();

	assert.equal(store.getCredential("openai"), null);
	assert.equal(store.getCredential(""), null);
	assert.equal(store.getCredentialField("openai", "key"), undefined);
	assert.equal(store.setCredentialField("", "key", "x"), null);
	assert.equal(store.setCredentialFlag("openai", "", true), null);
	assert.equal(store.setCredential("", {}), null);
});

test("channel scope wins over guild scope and guild scope over the global choice", () => {
	const {store} = createHarness({
		guildsByChannel: {"channel-1": "guild-1", "channel-2": "guild-1", "channel-3": "@me"},
		persisted: {
			channelLanguages: {"channel-1": {received: {input: "ru", output: "en"}}},
			guildLanguages: {"guild-1": {received: {input: "en", output: "zh-CN"}}},
			choices: {received: {input: "auto", output: "ru"}}
		}
	});
	store.reload();

	assert.equal(store.getLanguageChoice(INPUT, RECEIVED, "channel-1"), "ru");
	assert.equal(store.getLanguageChoice(OUTPUT, RECEIVED, "channel-1"), "en");
	assert.equal(store.getLanguageChoice(INPUT, RECEIVED, "channel-2"), "en");
	assert.equal(store.getLanguageChoice(OUTPUT, RECEIVED, "channel-2"), "zh-CN");
	assert.equal(store.getLanguageChoice(INPUT, RECEIVED, "channel-3"), "auto");
	assert.equal(store.getLanguageChoice(OUTPUT, RECEIVED, "channel-3"), "ru");
	assert.equal(store.hasChannelLanguageScope("channel-1", RECEIVED), true);
	assert.equal(store.hasChannelLanguageScope("channel-2", RECEIVED), false);
	assert.equal(store.hasGuildLanguageScope("guild-1", RECEIVED), true);
	assert.equal(store.hasGuildLanguageScope("guild-2", RECEIVED), false);
});

test("a scope stored for another place does not leak across places", () => {
	const {store} = createHarness({
		guildsByChannel: {"channel-1": "guild-1"},
		persisted: {
			channelLanguages: {"channel-1": {sent: {input: "ru", output: "ru"}}},
			choices: {received: {input: "en", output: "zh-CN"}, sent: {input: "auto", output: "en"}}
		}
	});
	store.reload();

	assert.equal(store.getLanguageChoice(INPUT, RECEIVED, "channel-1"), "en");
	assert.equal(store.getLanguageChoice(OUTPUT, SENT, "channel-1"), "ru");
});

test("a stored choice that the current engines no longer offer falls back to the first language", () => {
	const {store} = createHarness({
		persisted: {choices: {received: {input: "kl", output: "kl"}}}
	});

	assert.equal(store.getLanguageChoice(INPUT, RECEIVED, "channel-1"), "auto");
	assert.equal(store.getLanguageChoice(OUTPUT, RECEIVED, "channel-1"), "en");
});

test("the output direction never resolves to auto", () => {
	const {store} = createHarness({
		persisted: {choices: {received: {input: "auto", output: "auto"}}}
	});

	assert.equal(store.getLanguageChoice(INPUT, RECEIVED, "channel-1"), "auto");
	assert.equal(store.getLanguageChoice(OUTPUT, RECEIVED, "channel-1"), "en");
});

test("reload migrates every legacy Discord output choice to the current concrete language", () => {
	const {store, persisted, keysWritten} = createHarness({
		guildsByChannel: {"channel-1": "guild-1"},
		persisted: {
			choices: {
				received: {input: "auto", output: "$discord"},
				sent: {input: "auto", output: "$discord"}
			},
			channelLanguages: {
				"channel-1": {
					received: {input: "auto", output: "$discord"},
					sent: {input: "auto", output: "$discord"}
				}
			},
			guildLanguages: {
				"guild-1": {
					received: {input: "auto", output: "$discord"},
					sent: {input: "auto", output: "$discord"}
				}
			}
		},
		resolveLegacyDiscordLanguage: () => "zh-CN"
	});

	store.reload();

	assert.equal(persisted.choices.received.output, "zh-CN");
	assert.equal(persisted.choices.sent.output, "zh-CN");
	assert.equal(persisted.channelLanguages["channel-1"].received.output, "zh-CN");
	assert.equal(persisted.channelLanguages["channel-1"].sent.output, "zh-CN");
	assert.equal(persisted.guildLanguages["guild-1"].received.output, "zh-CN");
	assert.equal(persisted.guildLanguages["guild-1"].sent.output, "zh-CN");
	assert.equal(store.getLanguageChoice(OUTPUT, RECEIVED, "channel-1"), "zh-CN");
	assert.equal(store.getLanguageChoice(OUTPUT, SENT, "channel-1"), "zh-CN");
	assert.deepEqual(keysWritten(), ["channelLanguages", "guildLanguages", "choices", "choices"]);
});

test("saving a choice writes into the narrowest scope that already exists", () => {
	const {store, persisted, keysWritten} = createHarness({
		guildsByChannel: {"channel-1": "guild-1", "channel-2": "guild-1"},
		persisted: {
			channelLanguages: {"channel-1": {received: {input: "ru", output: "en"}}},
			guildLanguages: {"guild-1": {received: {input: "en", output: "zh-CN"}}}
		}
	});
	store.reload();

	assert.equal(store.saveLanguageChoice("zh-CN", INPUT, RECEIVED, "channel-1"), "channel");
	assert.equal(store.saveLanguageChoice("ru", INPUT, RECEIVED, "channel-2"), "guild");

	assert.deepEqual(persisted.channelLanguages, {"channel-1": {received: {input: "zh-CN", output: "en"}}});
	assert.deepEqual(persisted.guildLanguages, {"guild-1": {received: {input: "ru", output: "zh-CN"}}});
	assert.deepEqual(keysWritten(), ["channelLanguages", "guildLanguages"]);
});

test("saving a choice with no channel or guild scope updates the global plugin choice", () => {
	const {store, persisted} = createHarness({
		guildsByChannel: {"channel-1": "guild-1"},
		persisted: {choices: {received: {input: "auto", output: "en"}}}
	});

	assert.equal(store.saveLanguageChoice("zh-CN", OUTPUT, RECEIVED, "channel-1"), "global");

	assert.deepEqual(persisted.choices, {received: {input: "auto", output: "zh-CN"}});
	assert.deepEqual(persisted.channelLanguages, {});
	assert.deepEqual(persisted.guildLanguages, {});
});

test("ensureChannelLanguageChoiceScope creates the scope once and returns the same object", () => {
	const {store, keysWritten} = createHarness({
		persisted: {choices: {sent: {input: "ru", output: "ru"}}}
	});

	const scope = store.ensureChannelLanguageChoiceScope("channel-1", SENT);
	scope.output = "zh-CN";
	const again = store.ensureChannelLanguageChoiceScope("channel-1", SENT);

	assert.equal(again, scope);
	assert.equal(again.output, "zh-CN");
	// Creating a scope is not by itself a settings change, so nothing is written until
	// a caller actually saves a choice into it.
	assert.deepEqual(keysWritten(), []);
	assert.equal(store.ensureChannelLanguageChoiceScope("", SENT), null);
	assert.equal(store.ensureChannelLanguageChoiceScope("channel-1", ""), null);
});

test("a scope created by ensureChannelLanguageChoiceScope seeds from the language table, not from the inherited choice", () => {
	// Legacy behaviour, pinned deliberately: the empty scope is inserted before the
	// seed is read back, so it shadows the guild and global choices it should inherit.
	const {store} = createHarness({
		guildsByChannel: {"channel-1": "guild-1"},
		persisted: {
			guildLanguages: {"guild-1": {sent: {input: "ru", output: "ru"}}},
			choices: {sent: {input: "ru", output: "ru"}}
		}
	});
	store.reload();

	const scope = store.ensureChannelLanguageChoiceScope("channel-1", SENT);

	assert.deepEqual(scope, {input: "auto", output: "en"});
});

test("setChannelLanguageChoice pins one direction and persists the channel record", () => {
	const {store, persisted, keysWritten} = createHarness({
		persisted: {choices: {sent: {input: "auto", output: "en"}}}
	});

	const scope = store.setChannelLanguageChoice("channel-1", SENT, OUTPUT, "ru");

	assert.equal(scope.output, "ru");
	assert.deepEqual(persisted.channelLanguages, {"channel-1": {sent: {input: "auto", output: "ru"}}});
	assert.deepEqual(keysWritten(), ["channelLanguages"]);
	assert.equal(store.getLanguageChoice(OUTPUT, SENT, "channel-1"), "ru");
	assert.equal(store.setChannelLanguageChoice("", SENT, OUTPUT, "ru"), null);
	assert.equal(store.setChannelLanguageChoice("channel-1", SENT, "", "ru"), null);
});

test("cycling the scope of a place walks global, guild, channel and back to global", () => {
	const {store, persisted} = createHarness({
		guildsByChannel: {"channel-1": "guild-1"},
		persisted: {choices: {received: {input: "ru", output: "zh-CN"}}}
	});

	assert.equal(store.cycleLanguageChoiceScope("channel-1", "guild-1", RECEIVED), "guild");
	assert.deepEqual(persisted.guildLanguages, {"guild-1": {received: {input: "ru", output: "zh-CN"}}});
	assert.equal(store.getLanguageChoice(INPUT, RECEIVED, "channel-1"), "ru");

	assert.equal(store.cycleLanguageChoiceScope("channel-1", "guild-1", RECEIVED), "channel");
	// The guild record was emptied by the step, so it is removed rather than left as
	// an empty object in the saved file.
	assert.deepEqual(persisted.guildLanguages, {});
	assert.deepEqual(persisted.channelLanguages, {"channel-1": {received: {input: "ru", output: "zh-CN"}}});

	assert.equal(store.cycleLanguageChoiceScope("channel-1", "guild-1", RECEIVED), "global");
	assert.deepEqual(persisted.channelLanguages, {});
	assert.equal(store.getLanguageChoice(OUTPUT, RECEIVED, "channel-1"), "zh-CN");
});

test("the mainline scope cycle keeps a channel pair across another channel and a store reload", () => {
	const first = createHarness({
		guildsByChannel: {"channel-1": "guild-1"},
		persisted: {choices: {received: {input: "ru", output: "zh-CN"}}}
	});
	assert.equal(typeof first.store.setLanguageChoiceScope, "undefined", "the segmented UI must not create a second scope owner beside the mainline cycle");
	assert.equal(first.store.cycleLanguageChoiceScope("channel-1", "guild-1", RECEIVED), "guild");
	assert.equal(first.store.cycleLanguageChoiceScope("channel-1", "guild-1", RECEIVED), "channel");
	assert.equal(first.store.saveLanguageChoice("ru", OUTPUT, RECEIVED, "channel-1"), "channel");
	assert.deepEqual(first.persisted.channelLanguages, {"channel-1": {received: {input: "ru", output: "ru"}}});
	assert.equal(first.store.getLanguageChoice(OUTPUT, RECEIVED, "channel-2"), "zh-CN", "another channel still uses the default");

	const second = createHarness({
		guildsByChannel: {"channel-1": "guild-1", "channel-2": "guild-1"},
		persisted: {
			choices: {received: {input: "ru", output: "zh-CN"}},
			channelLanguages: JSON.parse(JSON.stringify(first.persisted.channelLanguages)),
			guildLanguages: JSON.parse(JSON.stringify(first.persisted.guildLanguages))
		}
	});
	second.store.reload();
	assert.equal(second.store.getLanguageChoice(OUTPUT, RECEIVED, "channel-2"), "zh-CN");
	assert.equal(second.store.getLanguageChoice(OUTPUT, RECEIVED, "channel-1"), "ru", "returning to channel A restores its locked pair");
	assert.equal(second.store.hasChannelLanguageScope("channel-1", RECEIVED), true);
});

test("cycling one place leaves the other places of the same channel untouched", () => {
	const {store, persisted} = createHarness({
		guildsByChannel: {"channel-1": "guild-1"},
		persisted: {
			channelLanguages: {"channel-1": {sent: {input: "ru", output: "ru"}}},
			choices: {received: {input: "auto", output: "en"}, sent: {input: "ru", output: "ru"}}
		}
	});
	store.reload();

	assert.equal(store.cycleLanguageChoiceScope("channel-1", "guild-1", RECEIVED), "guild");
	assert.deepEqual(persisted.channelLanguages, {"channel-1": {sent: {input: "ru", output: "ru"}}});

	assert.equal(store.cycleLanguageChoiceScope("channel-1", "guild-1", SENT), "global");
	assert.deepEqual(persisted.channelLanguages, {});
	assert.deepEqual(persisted.guildLanguages, {"guild-1": {received: {input: "auto", output: "en"}}});
});

test("stored channel engine overrides drop channels whose engine is not installed", () => {
	const {store} = createHarness({installedEngines: ["googleapi", "deepseek"]});

	assert.deepEqual(store.normalizeStoredChannelPrimaryEngineOverrides({
		"channel-1": "deepseek",
		"channel-2": "removed-engine",
		"channel-3": 7,
		"": "deepseek"
	}), {"channel-1": "deepseek"});
	assert.deepEqual(store.normalizeStoredChannelPrimaryEngineOverrides(null), {});
	assert.deepEqual(store.normalizeStoredChannelPrimaryEngineOverrides(["deepseek"]), {});
});

test("setting and clearing a channel primary engine persists the override record", () => {
	const {store, persisted} = createHarness();

	assert.equal(store.setChannelPrimaryEngine("channel-1", "deepseek"), true);
	assert.equal(store.getChannelPrimaryEngineOverride("channel-1"), "deepseek");
	assert.equal(store.hasChannelPrimaryEngineOverride("channel-1"), true);
	assert.deepEqual(persisted.channelPrimaryEngineOverrides, {"channel-1": "deepseek"});
	assert.deepEqual(store.listChannelPrimaryEngines(), ["deepseek"]);

	assert.equal(store.clearChannelPrimaryEngineOverride("channel-1"), true);
	assert.equal(store.getChannelPrimaryEngineOverride("channel-1"), null);
	assert.equal(store.hasChannelPrimaryEngineOverride("channel-1"), false);
	assert.deepEqual(persisted.channelPrimaryEngineOverrides, {});
	assert.equal(store.clearChannelPrimaryEngineOverride("channel-1"), false);
});

test("a channel primary engine is refused when the engine or the channel is unknown", () => {
	const {store, keysWritten} = createHarness();

	assert.equal(store.setChannelPrimaryEngine("channel-1", "not-an-engine"), false);
	assert.equal(store.setChannelPrimaryEngine("", "deepseek"), false);
	assert.equal(store.getChannelPrimaryEngineOverride(""), null);
	assert.deepEqual(keysWritten(), []);
});

test("an override that survived in the file but lost its engine stops applying", () => {
	const {store} = createHarness({
		installedEngines: ["googleapi"],
		persisted: {channelPrimaryEngineOverrides: {"channel-1": "deepseek"}}
	});
	store.reload();

	assert.equal(store.getChannelPrimaryEngineOverride("channel-1"), null);
	assert.equal(store.hasChannelPrimaryEngineOverride("channel-1"), false);
	assert.deepEqual(store.getChannelPrimaryEngineOverrides(), {});
});

test("saveChannelPrimaryEngineOverrides writes the record the caller already mutated", () => {
	const {store, persisted} = createHarness();

	store.getChannelPrimaryEngineOverrides()["channel-9"] = "deepl";
	store.saveChannelPrimaryEngineOverrides();

	assert.deepEqual(persisted.channelPrimaryEngineOverrides, {"channel-9": "deepl"});
});

test("enablement normalization rejects everything that is not the current shape", () => {
	assert.equal(normalizeStoredChannelEnablementState(null), null);
	assert.equal(normalizeStoredChannelEnablementState(["channel-1"]), null);
	assert.equal(normalizeStoredChannelEnablementState("on"), null);
	assert.deepEqual(normalizeStoredChannelEnablementState({}), {globalDefault: false, channelOverrides: {}});
	assert.deepEqual(normalizeStoredChannelEnablementState({globalDefault: 1, channelOverrides: "x"}), {globalDefault: true, channelOverrides: {}});
	assert.deepEqual(normalizeStoredChannelEnablementState({
		globalDefault: false,
		channelOverrides: {"channel-1": true, "channel-2": "yes", "": true}
	}), {globalDefault: false, channelOverrides: {"channel-1": true}});
});

test("a legacy array of channel ids migrates to per-channel overrides and drops the global sentinel", () => {
	assert.deepEqual(migrateLegacyChannelEnablementState(["channel-1", "global", "", 7, "channel-2"]), {
		globalDefault: false,
		channelOverrides: {"channel-1": true, "channel-2": true}
	});
	assert.deepEqual(migrateLegacyChannelEnablementState(null), createEmptyChannelEnablementState(false));
});

test("the primary enablement record wins over the compatibility record and the global default is forced off", () => {
	const merged = loadChannelEnablementState(
		{globalDefault: true, channelOverrides: {"channel-conflict": false}},
		{globalDefault: true, channelOverrides: {"channel-compat-only": true, "channel-compat-false": false, "channel-conflict": true}}
	);

	assert.deepEqual(merged, {
		globalDefault: false,
		channelOverrides: {
			"channel-compat-only": true,
			"channel-compat-false": false,
			"channel-conflict": false
		}
	});
});

test("a legacy array in the primary key still outranks the compatibility key", () => {
	assert.deepEqual(loadChannelEnablementState(["channel-1"], ["global"]), {
		globalDefault: false,
		channelOverrides: {"channel-1": true}
	});
});

test("an enablement value falls back to the global default when the channel has no record", () => {
	const state = {globalDefault: true, channelOverrides: {"channel-1": false}};

	assert.equal(getChannelEnablementStateValue("channel-1", state), false);
	assert.equal(getChannelEnablementStateValue("channel-2", state), true);
	assert.equal(getChannelEnablementStateValue(null, state), true);
	assert.equal(getChannelEnablementStateValue("channel-1", "garbage"), false);
});

test("enablement equality compares the normalized shape", () => {
	assert.equal(channelEnablementStatesEqual(
		{globalDefault: false, channelOverrides: {"channel-1": true}},
		{globalDefault: false, channelOverrides: {"channel-1": true, "channel-2": "not a boolean"}}
	), true);
	assert.equal(channelEnablementStatesEqual(
		{globalDefault: false, channelOverrides: {"channel-1": true}},
		{globalDefault: false, channelOverrides: {"channel-1": false}}
	), false);
	assert.equal(channelEnablementStatesEqual(
		{globalDefault: false, channelOverrides: {}},
		{globalDefault: true, channelOverrides: {}}
	), false);
	assert.equal(channelEnablementStatesEqual(null, undefined), true);
});

test("toggling a channel stores only the channels that differ from the default", () => {
	const {store, persisted} = createHarness();

	store.setChannelEnablementStateValue("channel-1", true);

	assert.equal(store.isTranslationEnabled("channel-1"), true);
	assert.equal(store.isTranslationEnabled("channel-2"), false);
	assert.deepEqual(persisted.translationEnabledStates, {globalDefault: false, channelOverrides: {"channel-1": true}});
	assert.deepEqual(persisted.receivedAutoTranslationEnabledStates, persisted.translationEnabledStates);

	store.setChannelEnablementStateValue("channel-1", false);

	assert.equal(store.isTranslationEnabled("channel-1"), false);
	assert.deepEqual(persisted.translationEnabledStates, {globalDefault: false, channelOverrides: {}});
});

test("an enablement toggle without a channel id changes nothing", () => {
	const {store, keysWritten} = createHarness();

	const state = store.setChannelEnablementStateValue("", true);

	assert.deepEqual(state, {globalDefault: false, channelOverrides: {}});
	assert.deepEqual(keysWritten(), []);
});

test("saveChannelEnablementState replaces the live state and writes both keys", () => {
	const {store, persisted, keysWritten} = createHarness();

	store.saveChannelEnablementState({globalDefault: false, channelOverrides: {"channel-7": true}});

	assert.equal(store.isTranslationEnabled("channel-7"), true);
	assert.deepEqual(store.getChannelEnablementState(), {globalDefault: false, channelOverrides: {"channel-7": true}});
	assert.deepEqual(keysWritten(), ["translationEnabledStates", "receivedAutoTranslationEnabledStates"]);
	assert.deepEqual(persisted.receivedAutoTranslationEnabledStates, {globalDefault: false, channelOverrides: {"channel-7": true}});
});

test("reload migrates legacy arrays and repairs both stored keys", () => {
	const {store, persisted} = createHarness({
		persisted: {
			translationEnabledStates: ["channel-1"],
			receivedAutoTranslationEnabledStates: ["global"]
		}
	});

	store.reload();

	assert.equal(store.isTranslationEnabled("channel-1"), true);
	assert.equal(store.isTranslationEnabled("channel-2"), false);
	assert.deepEqual(persisted.translationEnabledStates, {globalDefault: false, channelOverrides: {"channel-1": true}});
	assert.deepEqual(persisted.receivedAutoTranslationEnabledStates, {globalDefault: false, channelOverrides: {"channel-1": true}});
});

test("reload keeps a channel that only the compatibility key knows about", () => {
	const {store, persisted} = createHarness({
		persisted: {
			translationEnabledStates: {globalDefault: true, channelOverrides: {"channel-conflict": false}},
			receivedAutoTranslationEnabledStates: {
				globalDefault: true,
				channelOverrides: {"channel-compat-only": true, "channel-compat-false": false, "channel-conflict": true}
			}
		}
	});

	store.reload();

	assert.equal(store.isTranslationEnabled("channel-compat-only"), true);
	assert.equal(store.isTranslationEnabled("channel-compat-false"), false);
	assert.equal(store.isTranslationEnabled("channel-conflict"), false);
	assert.deepEqual(persisted.translationEnabledStates, {
		globalDefault: false,
		channelOverrides: {"channel-compat-only": true, "channel-compat-false": false, "channel-conflict": false}
	});
});

test("reload does not rewrite an enablement state that is already migrated", () => {
	const {store, keysWritten} = createHarness({
		persisted: {
			translationEnabledStates: {globalDefault: false, channelOverrides: {"channel-1": true}},
			receivedAutoTranslationEnabledStates: {globalDefault: false, channelOverrides: {"channel-1": true}}
		}
	});

	store.reload();

	assert.equal(store.isTranslationEnabled("channel-1"), true);
	assert.deepEqual(keysWritten(), []);
});

test("reload keeps the live enablement state and writes nothing when neither key can be read", () => {
	// The stale-reload guard: a read that returned nothing is not the user turning
	// every channel off, and the state a migration would produce here is empty by
	// construction, so writing it could only erase per-channel toggles.
	const {store, persisted, keysWritten} = createHarness();
	store.setChannelEnablementStateValue("channel-1", true);
	persisted.translationEnabledStates = null;
	persisted.receivedAutoTranslationEnabledStates = null;
	const writesBefore = keysWritten().length;

	store.reload();

	assert.equal(store.isTranslationEnabled("channel-1"), true);
	assert.equal(keysWritten().length, writesBefore);
});

test("reload still migrates when only one of the two enablement keys is readable", () => {
	const {store, persisted} = createHarness({
		persisted: {
			translationEnabledStates: null,
			receivedAutoTranslationEnabledStates: {globalDefault: false, channelOverrides: {"channel-1": true}}
		}
	});

	store.reload();

	assert.equal(store.isTranslationEnabled("channel-1"), true);
	assert.deepEqual(persisted.translationEnabledStates, {globalDefault: false, channelOverrides: {"channel-1": true}});
});

test("reload keeps the records it already has when a loader returns nothing", () => {
	const {store, persisted} = createHarness();
	store.setCredentialField("openai", "key", "sk-secret");
	store.setChannelLanguageChoice("channel-1", SENT, OUTPUT, "ru");
	store.setChannelPrimaryEngine("channel-1", "deepseek");
	store.setFavorite("ru", true);

	persisted.authKeys = undefined;
	persisted.channelLanguages = null;
	persisted.guildLanguages = undefined;
	persisted.channelPrimaryEngineOverrides = null;
	persisted.favorites = "not an array";
	store.reload();

	assert.equal(store.getCredentialField("openai", "key"), "sk-secret");
	assert.equal(store.getLanguageChoice(OUTPUT, SENT, "channel-1"), "ru");
	assert.equal(store.getChannelPrimaryEngineOverride("channel-1"), "deepseek");
	assert.deepEqual(store.getFavorites(), ["ru"]);
});

test("reload adopts an empty record when that is genuinely what is stored", () => {
	const {store, persisted} = createHarness();
	store.setCredentialField("openai", "key", "sk-secret");

	persisted.authKeys = {};
	store.reload();

	assert.equal(store.getCredentialField("openai", "key"), undefined);
	assert.deepEqual(store.getAuthKeys(), {});
});

test("reload normalizes the stored engine overrides before they are used", () => {
	const {store} = createHarness({
		installedEngines: ["googleapi", "deepseek"],
		persisted: {channelPrimaryEngineOverrides: {"channel-1": "deepseek", "channel-2": "gone"}}
	});

	store.reload();

	assert.deepEqual(store.getChannelPrimaryEngineOverrides(), {"channel-1": "deepseek"});
});

test("reload does not persist anything it merely read", () => {
	const {store, keysWritten} = createHarness({
		persisted: {
			favorites: ["ru"],
			authKeys: {openai: {key: "sk"}},
			channelLanguages: {"channel-1": {sent: {input: "auto", output: "ru"}}},
			guildLanguages: {"guild-1": {sent: {input: "auto", output: "en"}}},
			channelPrimaryEngineOverrides: {"channel-1": "deepseek"},
			translationEnabledStates: {globalDefault: false, channelOverrides: {}},
			receivedAutoTranslationEnabledStates: {globalDefault: false, channelOverrides: {}}
		}
	});

	store.reload();

	assert.deepEqual(keysWritten(), []);
});

test("a reloaded favourite list is applied the next time the language table is built", () => {
	const {store, persisted} = createHarness();

	persisted.favorites = ["ru"];
	store.reload();
	store.setLanguages(createLanguageTable());

	assert.equal(store.getLanguage("ru").fav, 0);
	assert.equal(store.getLanguage("en").fav, 1);
});

test("per-model thinking state stores a typed raw and a capability profile without touching legacy keys", () => {
	let clock = 0;
	const {store, persisted} = createHarness({now: () => ++clock, persisted: {authKeys: {"custom-a": {key: "secret", model: "m"}}}});
	store.reload();
	store.setReasoningModelPref("custom-a", "m", {mode: "on", profile: "openai", effort: "high"});
	// legacy shape is untouched: same keys, same types
	const legacy = store.getReasoningModelPref("custom-a", "m");
	assert.equal(legacy.mode, "on");
	assert.equal(typeof legacy.profile, "string");
	assert.equal(legacy.profile, "openai");
	assert.equal(legacy.effort, "high");

	store.setReasoningModelOnRaw("custom-a", "m", 12000);
	const numeric = store.getReasoningModelPref("custom-a", "m");
	assert.equal(numeric.onRaw, 12000, "a numeric budget survives as a number");
	assert.equal(typeof numeric.onRaw, "number");
	assert.equal(numeric.effort, "high", "an out-of-enum raw leaves the legacy mirror alone");
	assert.equal(typeof persisted.authKeys["custom-a"].reasoningModels.m.onRaw, "number", "the persisted payload keeps the type too");

	store.setReasoningModelOnRaw("custom-a", "m", "low");
	const enumRaw = store.getReasoningModelPref("custom-a", "m");
	assert.equal(enumRaw.onRaw, "low");
	assert.equal(enumRaw.effort, "low", "a legacy-range raw is mirrored so an older build still reads the intent");

	store.setReasoningModelOnRaw("custom-a", "m", true);
	assert.equal(store.getReasoningModelPref("custom-a", "m").onRaw, true);
	assert.equal(store.getReasoningModelPref("custom-a", "m").effort, "low", "the mirror only follows values the old enum could express");
});

test("capability tiers are addressed by tagged raw key so a number and its spelling never share a slot", () => {
	let clock = 0;
	const {store, persisted} = createHarness({now: () => ++clock, persisted: {authKeys: {"custom-a": {key: "secret"}}}});
	store.reload();
	store.setReasoningModelControlProfile("custom-a", "m", {
		schemaId: "gemini/thinkingBudget/v1",
		controlKind: "budget_numeric",
		tiers: [{raw: 0}, {raw: -1}, {raw: 12000}, {raw: "12000"}],
		offRaw: 0,
		custom: {kind: "number", min: 0, max: 32768, step: 128, specialValues: [-1]},
		endpointKey: "https://host.test/v1beta/models",
		format: "gemini_native",
		adapterVersion: 1
	});
	const profile = store.getReasoningModelPref("custom-a", "m").controlProfile;
	assert.equal(profile.schemaId, "gemini/thinkingBudget/v1");
	assert.deepEqual(profile.tiers.map(tier => tier.rawKey), ["n:0", "n:-1", "n:12000", "s:12000"]);
	assert.equal(profile.tiers[2].raw, 12000);
	assert.equal(profile.tiers[3].raw, "12000");
	assert.equal(profile.offRaw, 0);
	assert.deepEqual(profile.custom, {kind: "number", min: 0, max: 32768, step: 128, specialValues: [-1]});

	store.setReasoningModelTierState("custom-a", "m", 12000, {state: "confirmed", evidence: "confirmed"});
	store.setReasoningModelTierState("custom-a", "m", "12000", {state: "rejected", evidence: "none"});
	const states = store.getReasoningModelPref("custom-a", "m").controlProfile.tierStates;
	assert.equal(states["n:12000"].state, "confirmed");
	assert.equal(states["s:12000"].state, "rejected", "the string spelling carries its own verdict");
	assert.equal(Object.keys(states).length, 2);
	assert.equal(typeof persisted.authKeys["custom-a"].reasoningModels.m.controlProfile.tierStates["n:12000"].checkedAt, "number");
	// an unknown state name is not a verdict
	assert.equal(store.setReasoningModelTierState("custom-a", "m", 12000, {state: "made-up"}), null);
	assert.equal(store.getReasoningModelPref("custom-a", "m").controlProfile.tierStates["n:12000"].state, "confirmed");
});

test("the tier verdict table is bounded and drops the least recently checked value", () => {
	let clock = 0;
	const {store} = createHarness({now: () => ++clock, persisted: {authKeys: {"custom-a": {key: "secret"}}}});
	store.reload();
	for (let index = 0; index < 18; index++) store.setReasoningModelTierState("custom-a", "m", index, {state: "pending"});
	const states = store.getReasoningModelPref("custom-a", "m").controlProfile.tierStates;
	assert.equal(Object.keys(states).length, 16);
	assert.equal(states["n:0"], undefined, "the oldest verdict makes room");
	assert.equal(states["n:1"], undefined);
	assert.equal(states["n:17"].state, "pending");
});

test("a record written by the previous build is read without losing or inventing anything", () => {
	let clock = 0;
	const legacyRecord = {mode: "off", profile: "qwen", effort: "medium", capability: {support: "accepted", candidateId: "qwen_enable_thinking", resolvedValue: "enable_thinking=false", evidence: "confirmed", endpointKey: "https://host.test/v1/chat/completions", format: "openai_chat", checkedAt: 7}};
	const {store} = createHarness({now: () => ++clock, persisted: {authKeys: {"custom-a": {key: "secret", reasoningModels: {m: legacyRecord}}}}});
	store.reload();
	const read = store.getReasoningModelPref("custom-a", "m");
	// 1. legacy fields survive verbatim
	assert.equal(read.mode, "off");
	assert.equal(read.profile, "qwen");
	assert.equal(read.effort, "medium");
	assert.deepEqual(read.capability, legacyRecord.capability);
	// 2. the legacy effort is the fallback source for the typed raw
	assert.equal(read.onRaw, "medium", "an older record still knows which strength was chosen");
	// 3. the legacy single-value capability reads as the first tier verdict, without a schemaId
	assert.equal(read.controlProfile.schemaId, "");
	assert.equal(read.controlProfile.tierStates["s:enable_thinking=false"].state, "confirmed", "an accepted field with confirming evidence is a confirmed tier");
	assert.equal(read.controlProfile.tierStates["s:enable_thinking=false"].evidence, "confirmed");
	assert.equal(read.controlProfile.offRaw, "enable_thinking=false", "off mode remembers the value that closed thinking");
	assert.equal(read.controlProfile.format, "openai_chat");
});

test("writing new thinking state keeps the legacy capability readable for a rollback", () => {
	let clock = 0;
	const {store, persisted} = createHarness({now: () => ++clock, persisted: {authKeys: {"custom-a": {key: "secret"}}}});
	store.reload();
	store.setReasoningModelPref("custom-a", "m", {mode: "off", profile: "openai"});
	store.setReasoningModelTierState("custom-a", "m", "none", {state: "confirmed", evidence: "confirmed", schemaId: "openai_chat/reasoning_effort/v1", endpointKey: "https://host.test/v1/chat/completions", format: "openai_chat"});
	const stored = persisted.authKeys["custom-a"].reasoningModels.m;
	assert.equal(stored.capability.support, "accepted", "an older build still sees a usable capability");
	assert.equal(stored.capability.resolvedValue, "none");
	assert.equal(stored.capability.evidence, "confirmed");
	assert.equal(stored.capability.format, "openai_chat");
	assert.equal(stored.controlProfile.tierStates["s:none"].state, "confirmed");
});

test("T3 an explicit raw is marked so a legacy record stays readable as what it sent", () => {
	const {store} = createHarness({persisted: {authKeys: {"custom-a": {key: "secret", model: "m"}}}});
	store.reload();
	// a record written before exact raws existed carries no mark
	store.setReasoningModelPref("custom-a", "m", {mode: "on", profile: "auto", effort: "low"});
	const legacy = store.getReasoningModelPref("custom-a", "m");
	assert.equal(legacy.onRaw, "low", "the legacy word is still readable as a raw");
	assert.equal(legacy.rawExplicit, undefined, "but it was never chosen as an exact raw");

	// a deliberate exact-raw write is marked and keeps the legacy mirror legal
	store.setReasoningModelOnRaw("custom-a", "m", 12000);
	const explicit = store.getReasoningModelPref("custom-a", "m");
	assert.equal(explicit.onRaw, 12000);
	assert.equal(explicit.rawExplicit, true);
	assert.equal(explicit.effort, "low", "a custom raw never lands in the legacy enum field");

	store.setReasoningModelOnRaw("custom-a", "m", "high");
	assert.equal(store.getReasoningModelPref("custom-a", "m").effort, "high", "one of the four words does mirror");
	assert.equal(store.getReasoningModelPref("custom-a", "m").rawExplicit, true);
	// an unknown provenance value is not a mark
	store.setReasoningModelPref("custom-a", "m2", {mode: "on", effort: "low", onRaw: "xhigh", rawExplicit: "yes"});
	assert.equal(store.getReasoningModelPref("custom-a", "m2").rawExplicit, undefined);
});
