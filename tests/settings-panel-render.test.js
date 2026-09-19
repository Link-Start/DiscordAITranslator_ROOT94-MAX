const test = require("node:test");
const assert = require("node:assert/strict");
const {createPluginInstance} = require("./helpers/createPluginInstance");
const {
	formatLatencyDuration,
	createModelValidationView,
	createCustomProviderStatusView,
	isBenchmarkSlower,
	createReasoningStatusView,
	shouldShowReasoningProfile,
	shouldShowReasoningEffort,
	formatBenchmarkCompare,
	createBenchmarkResultView,
	createAiPerformanceRows,
	createAiLatencyDiagnosticsPayload
} = require("../src/ui/settings-panel");
const {getCustomTextValue} = require("../src/i18n/text");
const {getRegisteredCustomProtocolAdapters} = require("../src/providers/provider-client");

const getEnglishText = key => getCustomTextValue(key, false, false);
const getChineseText = key => getCustomTextValue(key, true, false);
const read = file => require("node:fs").readFileSync(require("node:path").join(__dirname, "..", file), "utf8");

function findByClassName(node, className, matches = []) {
	if (!node) return matches;
	if (Array.isArray(node)) {
		for (const child of node) findByClassName(child, className, matches);
		return matches;
	}
	if (typeof node != "object") return matches;
	const props = node.props || {};
	if (String(props.className || "").split(/\s+/).includes(className)) matches.push(node);
	findByClassName(props.children, className, matches);
	return matches;
}

function findByProp(node, name, value, matches = []) {
	if (!node) return matches;
	if (Array.isArray(node)) {
		for (const child of node) findByProp(child, name, value, matches);
		return matches;
	}
	if (typeof node != "object") return matches;
	const props = node.props || {};
	if (Object.prototype.hasOwnProperty.call(props, name) && (value === undefined || props[name] === value)) matches.push(node);
	findByProp(props.children, name, value, matches);
	return matches;
}

// LibraryComponents, ReactUtils, DOMUtils, disCN and disCNS come from the shared
// harness. They must NOT be repeated here: the harness merges this object into its
// defaults key by key, and a Proxy on both sides is flattened into an empty object by
// that merge, which silently strips every component the panel asks for.
const bdfdb = {
	PluginUtils: {
		createSettingsPanel: (instance, config) => {
			const children = config && config.children;
			return typeof children === "function" ? children() : children;
		},
		refreshSettingsPanel: () => {}
	},
	LanguageUtils: {
		getName: () => "English",
		languages: {en: {id: "en", name: "English"}, "zh-CN": {id: "zh-CN", name: "Chinese"}}
	},
	ModalUtils: {open: () => {}},
	NotificationUtils: {toast: () => {}},
	TimeUtils: {timeout: (fn) => fn && fn(), clear: () => {}},
	ColorUtils: {convert: value => value},
	ObjectUtils: {
		sort: table => table,
		filter: (table, fn) => {
			const out = {};
			for (const k in table) if (fn(table[k], k)) out[k] = table[k];
			return out;
		},
		isEmpty: obj => !obj || !Object.keys(obj).length,
		deepAssign: (...args) => Object.assign({}, ...args),
		toArray: obj => Object.keys(obj || {}).map(k => obj[k]),
		map: (obj, fn) => {
			const out = {};
			for (const k in obj) out[k] = fn(obj[k], k);
			return out;
		}
	}
};

test("the settings panel builds its whole tree without throwing", () => {
	// The panel is 1275 lines of render tree in its own module, and nothing else in the
	// suite calls getSettingsPanel. When it moved out of the plugin class every test
	// still passed while the panel was the one thing that could not open.
	//
	// BDFDB is stubbed permissively on purpose: this is not asserting what Discord
	// renders, it is asserting that every branch of the tree can be constructed - that
	// no identifier the panel reads went out of scope when the module moved.
	global.document = global.document || {
		querySelector: () => null, querySelectorAll: () => [], body: {}, documentElement: {},
		createElement: () => ({style: {}, setAttribute() {}, appendChild() {}})
	};
	global.requestAnimationFrame = global.requestAnimationFrame || (fn => fn());

	const plugin = createPluginInstance({callSetLanguages: true, bdfdb});
	// onLoad assigns this.defaults, which the panel reads for field limits.
	try {plugin.onLoad();} catch (error) {/* patching needs a real Discord; defaults are set first */}
	plugin.settings = plugin.settings || {};
	for (const section in plugin.defaults || {}) {
		plugin.settings[section] = plugin.settings[section] || {};
		for (const key in plugin.defaults[section]) {
			if (plugin.settings[section][key] === undefined) plugin.settings[section][key] = plugin.defaults[section][key].value;
		}
	}
	plugin.settings.choices = plugin.settings.choices || {received: {input: "auto", output: "zh-CN"}, sent: {input: "auto", output: "en"}};

	assert.ok(plugin.defaults && plugin.defaults.exceptions, "onLoad must have assigned defaults for this test to mean anything");
	const panel = plugin.getSettingsPanel({});
	assert.ok(panel, "the panel tree must be constructible");
	assert.equal(findByClassName(panel, "translator-provider-performance").length, 0, "built-in providers do not receive the custom performance card");
});

test("the settings panel returns a waiting view while BDFDB is still loading", () => {
	const originalDocument = global.document;
	let createSettingsPanelCalls = 0;
	global.document = {
		createElement: tagName => ({tagName, style: {}, textContent: ""})
	};

	try {
		const plugin = createPluginInstance({
			callSetLanguages: false,
			bdfdb: {
				PluginUtils: {
					createSettingsPanel: () => {
						createSettingsPanelCalls++;
						throw new TypeError("Cannot read properties of undefined (reading 'ColorsCSS')");
					}
				}
			}
		});
		global.window.BDFDB_Global.loaded = false;

		const panel = plugin.getSettingsPanel({});

		assert.ok(panel, "the early settings click must still receive a panel");
		assert.equal(createSettingsPanelCalls, 0, "the incomplete BDFDB settings API must not be called");
		assert.match(panel.textContent, /BDFDB/);
	}
	finally {
		global.document = originalDocument;
	}
});

// Shared custom-provider panel fixture: one engine, one model, live provider client
// wrapped so the tests can count the UI preference writer and stub capability state.
function createCustomProviderFixture({auth = {}, bdfdbBase} = {}) {
	global.document = global.document || {querySelector: () => null, querySelectorAll: () => [], body: {}, documentElement: {}, createElement: () => ({style: {}, setAttribute: () => {}, appendChild: () => {}}), addEventListener: () => {}, removeEventListener: () => {}};
	global.requestAnimationFrame = global.requestAnimationFrame || (fn => fn());
	const stored = Object.assign({key: "k", endpoint: "https://host.test/v1/chat/completions", model: "m", reasoningMode: "off", reasoningProfile: "auto"}, auth);
	let saves = 0;
	const plugin = createPluginInstance({callSetLanguages: false, bdfdb: Object.assign({}, bdfdbBase, {DataUtils: {
		load: (_plugin, key) => key == "authKeys" ? {oaicompat: stored} : {},
		save: () => {saves++;}
	}})});
	try {plugin.onLoad();} catch (error) {}
	plugin.settings = plugin.settings || {};
	for (const section in plugin.defaults || {}) {
		plugin.settings[section] = plugin.settings[section] || {};
		for (const key in plugin.defaults[section]) if (plugin.settings[section][key] === undefined) plugin.settings[section][key] = plugin.defaults[section][key].value;
	}
	plugin.settings.engines = {translator: "oaicompat", backup: "----", customProviders: [{id: "oaicompat", name: "Fixture"}]};
	plugin.settings.choices = plugin.settings.choices || {received: {input: "auto", output: "zh-CN"}, sent: {input: "auto", output: "en"}};
	plugin.setLanguages();
	const store = plugin.ensureSettingsStore();
	for (const field of Object.keys(stored)) store.setCredentialField("oaicompat", field, stored[field]);
	saves = 0;
	const liveClient = plugin.ensureProviderClient();
	const spies = {preferenceWrites: 0, benchmarkCancels: 0, get saves() {return saves;}};
	let reasoningOverride = null;
	let tierOptionsOverride = null;
	const observedClient = Object.assign({}, liveClient, {
		setReasoningModelPreference: (...args) => {spies.preferenceWrites++; return liveClient.setReasoningModelPreference(...args);},
		cancelSyntheticBenchmark: (...args) => {spies.benchmarkCancels++; return liveClient.cancelSyntheticBenchmark(...args);},
		getReasoningControlStatus: engineKey => Object.assign({}, liveClient.getReasoningControlStatus(engineKey), reasoningOverride || {}),
		getReasoningTierOptions: engineKey => tierOptionsOverride || liveClient.getReasoningTierOptions(engineKey)
	});
	plugin.ensureProviderClient = () => observedClient;
	plugin.settingsUiState = {provider: "oaicompat", activeTab: "providers"};
	return {
		plugin,
		spies,
		client: observedClient,
		setReasoning: override => {reasoningOverride = override;},
		setTierOptions: options => {tierOptionsOverride = options;},
		render: () => plugin.getSettingsPanel({}),
		resetSaves: () => {saves = 0;}
	};
}

test("Baidu exposes separate fields and flushes both edits without overwriting either credential", () => {
	const {plugin, render} = createCustomProviderFixture({bdfdbBase: bdfdb});
	plugin.settingsUiState.provider = "baidu";
	plugin.isChineseUiLanguage = () => true;
	plugin.ensureSettingsStore().setCredential("baidu", {key: "fixture-app legacy-middle fixture-secret"});
	let panel = render();
	const app = findByProp(panel, "aria-label", "APP ID")[0];
	const secret = findByProp(panel, "aria-label", "密钥")[0];
	assert.equal(app.props.defaultValue, "fixture-app");
	assert.equal(secret.props.defaultValue, "fixture-secret");
	assert.equal(secret.props.type, "password");
	app.props.onChange({target: {value: "updated-app"}});
	secret.props.onChange({target: {value: "updated-secret"}});
	app.props.onBlur();
	secret.props.onBlur();
	assert.equal(plugin.ensureSettingsStore().getCredentialField("baidu", "key"), "updated-app updated-secret");
	panel = render();
	assert.equal(findByProp(panel, "aria-label", "APP ID")[0].props.defaultValue, "updated-app");
	assert.equal(findByProp(panel, "aria-label", "密钥")[0].props.defaultValue, "updated-secret");
});

test("Cloud Translation exposes the default model and validation in one row without advanced settings", () => {
	for (const model of ["", "nmt"]) {
		const {plugin, render} = createCustomProviderFixture({bdfdbBase: bdfdb});
		plugin.settingsUiState.provider = "googlecloud";
		plugin.ensureSettingsStore().setCredential("googlecloud", {key: "fixture-key", model});
		const panel = render();
		assert.equal(findByClassName(panel, "translator-provider-card-title")[0].props.children, "Cloud Translation");
		assert.equal(plugin.getEngineLabel("googlecloud"), "Google Cloud");
		assert.equal(findByProp(panel, "data-provider-action", "advanced").length, 0);
		const row = findByClassName(panel, "translator-model-row")[0];
		const field = findByProp(row, "key", "googlecloud-model")[0];
		assert.equal(field.props.value, model);
		assert.equal(field.props.placeholder, "nmt");
		assert.equal(field.props.ariaLabel, getEnglishText("model_id_label"));
		const validate = findByClassName(row, "translator-btn").filter(node => node.props.children.includes(getEnglishText("validate_config")));
		assert.equal(validate.length, 1);
		assert.equal(validate[0].props.disabled, false);
		assert.equal(plugin.ensureSettingsStore().getCredentialField("googlecloud", "model"), model);
	}
});

test("Cloud Translation direct model input preserves overrides and saves clearing or editing", () => {
	const {plugin, render} = createCustomProviderFixture({bdfdbBase: bdfdb});
	plugin.settingsUiState.provider = "googlecloud";
	const store = plugin.ensureSettingsStore();
	const model = "projects/example-project/locations/global/models/general/translation-llm";
	store.setCredential("googlecloud", {key: "fixture-key", model});
	let panel = render();
	assert.equal(findByProp(panel, "data-provider-action", "advanced").length, 0);
	assert.equal(findByProp(panel, "key", "googlecloud-model")[0].props.value, model);
	assert.equal(store.getCredentialField("googlecloud", "model"), model);
	const field = findByProp(panel, "key", "googlecloud-model")[0];
	field.props.onChange("");
	field.props.onBlur();
	panel = render();
	assert.equal(store.getCredentialField("googlecloud", "model"), "");
	const cleared = findByProp(panel, "key", "googlecloud-model")[0];
	assert.equal(cleared.props.value, "");
	cleared.props.onChange(model);
	cleared.props.onBlur();
	assert.equal(store.getCredentialField("googlecloud", "model"), model);
});

test("M3b custom provider renders five main slots and moves benchmark behind two closed disclosures", () => {
	global.document = global.document || {querySelector: () => null, querySelectorAll: () => [], body: {}, documentElement: {}, createElement: () => ({style: {}, setAttribute() {}, appendChild() {}})};
	global.requestAnimationFrame = global.requestAnimationFrame || (fn => fn());
	const plugin = createPluginInstance({callSetLanguages: false, bdfdb: Object.assign({}, bdfdb, {DataUtils: {
		load: (_plugin, key) => key == "authKeys" ? {oaicompat: {key: "k", endpoint: "https://host.test/v1/chat/completions", model: "m", reasoningMode: "off", reasoningProfile: "auto"}} : {},
		save: () => {}
	}})});
	try {plugin.onLoad();} catch (error) {}
	plugin.settings = plugin.settings || {};
	for (const section in plugin.defaults || {}) {
		plugin.settings[section] = plugin.settings[section] || {};
		for (const key in plugin.defaults[section]) if (plugin.settings[section][key] === undefined) plugin.settings[section][key] = plugin.defaults[section][key].value;
	}
	plugin.settings.engines = {translator: "oaicompat", backup: "----", customProviders: [{id: "oaicompat", name: "Fixture"}]};
	plugin.settings.choices = plugin.settings.choices || {received: {input: "auto", output: "zh-CN"}, sent: {input: "auto", output: "en"}};
	plugin.setLanguages();
	plugin.ensureSettingsStore().setCredentialField("oaicompat", "reasoningMode", "off");
	plugin.ensureSettingsStore().setCredentialField("oaicompat", "reasoningProfile", "auto");
	const liveClient = plugin.ensureProviderClient();
	let preferenceWrites = 0;
	const observedClient = Object.assign({}, liveClient, {setReasoningModelPreference: (...args) => {preferenceWrites++; return liveClient.setReasoningModelPreference(...args);}});
	plugin.ensureProviderClient = () => observedClient;
	plugin.settingsUiState = {provider: "oaicompat", activeTab: "providers"};
	let panel = plugin.getSettingsPanel({});
	assert.deepEqual(findByProp(panel, "data-provider-main-slot").map(node => node.props["data-provider-main-slot"]), ["endpoint", "key", "model", "thinking", "status-actions"]);
	assert.equal(findByProp(panel, "data-provider-action", "validate-config").length, 1);
	assert.equal(findByProp(panel, "data-provider-action", "advanced").length, 1);
	assert.equal(findByClassName(panel, "translator-provider-main-status").length, 1);
	assert.equal(findByClassName(panel, "translator-provider-performance").length, 0);
	assert.equal(findByClassName(panel, "translator-model-validation-status").length, 0);
	assert.equal(findByClassName(panel, "translator-provider-advanced-body").length, 0);
	assert.equal(findByClassName(panel, "translator-provider-speed-body").length, 0);
	findByProp(findByProp(panel, "data-provider-main-slot", "thinking")[0], "options")[0].props.onChange("off");
	assert.equal(preferenceWrites, 0, "reselecting the mode already in force must preserve accepted capability evidence");

	findByProp(panel, "data-provider-action", "advanced")[0].props.onClick();
	panel = plugin.getSettingsPanel({});
	assert.equal(findByClassName(panel, "translator-provider-advanced-body").length, 1);
	const formatField = findByProp(panel, "data-provider-advanced-field", "format")[0];
	assert.ok(formatField);
	const formatSelect = findByProp(formatField, "options")[0];
	assert.deepEqual(formatSelect.props.options.map(option => option.value), ["auto", "openai_chat", "openai_responses", "ollama_native", "gemini_native", "anthropic_messages"]);
	formatSelect.props.onChange("openai_responses");
	assert.equal(plugin.ensureSettingsStore().getCredentialField("oaicompat", "interfaceFormat"), "openai_responses");
	panel = plugin.getSettingsPanel({});
	assert.equal(findByProp(panel, "data-provider-advanced-field", "protocol").length, 0);
	assert.equal(findByClassName(panel, "translator-provider-speed-body").length, 0);
	const thinkingSlot = findByProp(panel, "data-provider-main-slot", "thinking")[0];
	findByProp(thinkingSlot, "options")[0].props.onChange("on");
	assert.equal(preferenceWrites, 1, "turning thinking on is saved the moment it is chosen");
	panel = plugin.getSettingsPanel({});
	assert.equal(findByProp(panel, "data-provider-advanced-field", "protocol").length, 0, "the compatibility method is retired");
	assert.equal(findByProp(panel, "data-provider-advanced-field", "effort").length, 0, "so is the advanced effort row");
	assert.equal(findByProp(panel, "data-provider-main-slot", "strength").length, 1, "the strength lives on the main surface now");
	findByProp(findByProp(panel, "data-provider-main-slot", "strength")[0], "options")[0].props.onChange("s:medium");
	assert.equal(preferenceWrites, 2, "and choosing a strength is saved as well");
	panel = plugin.getSettingsPanel({});
	findByProp(panel, "data-provider-action", "speed")[0].props.onClick();
	panel = plugin.getSettingsPanel({});
	assert.equal(findByClassName(panel, "translator-provider-speed-body").length, 1);
	assert.equal(findByClassName(panel, "translator-reasoning-benchmark").length, 1);
	findByProp(panel, "data-provider-action", "advanced")[0].props.onClick();
	panel = plugin.getSettingsPanel({});
	assert.equal(findByClassName(panel, "translator-provider-advanced-body").length, 0);
	assert.equal(plugin.settingsUiState.customProviderSpeedExpanded.oaicompat, false);
});

test("M4 Ollama UI keeps the five-slot surface while deriving optional key and model-specific native strengths", () => {
	global.document = global.document || {querySelector: () => null, querySelectorAll: () => [], body: {}, documentElement: {}, createElement: () => ({style: {}, setAttribute() {}, appendChild() {}})};
	global.requestAnimationFrame = global.requestAnimationFrame || (fn => fn());
	const plugin = createPluginInstance({callSetLanguages: false, bdfdb: Object.assign({}, bdfdb, {DataUtils: {
		load: (_plugin, key) => key == "authKeys" ? {oaicompat: {key: "", endpoint: "http://localhost:11434", model: "qwen3:8b", reasoningMode: "off", reasoningProfile: "auto"}} : {},
		save: () => {}
	}})});
	try {plugin.onLoad();} catch (error) {}
	plugin.settings = plugin.settings || {};
	for (const section in plugin.defaults || {}) {
		plugin.settings[section] = plugin.settings[section] || {};
		for (const key in plugin.defaults[section]) if (plugin.settings[section][key] === undefined) plugin.settings[section][key] = plugin.defaults[section][key].value;
	}
	plugin.settings.engines = {translator: "oaicompat", backup: "----", customProviders: [{id: "oaicompat", name: "Ollama"}]};
	plugin.settings.choices = plugin.settings.choices || {received: {input: "auto", output: "zh-CN"}, sent: {input: "auto", output: "en"}};
	plugin.setLanguages();
	plugin.ensureSettingsStore().setCredentialField("oaicompat", "endpoint", "http://localhost:11434");
	plugin.ensureSettingsStore().setCredentialField("oaicompat", "model", "qwen3:8b");
	plugin.ensureSettingsStore().setCredentialField("oaicompat", "interfaceFormat", "auto");
	plugin.ensureSettingsStore().setCredentialField("oaicompat", "reasoningMode", "off");
	plugin.ensureSettingsStore().setCredentialField("oaicompat", "reasoningProfile", "auto");
	plugin.settingsUiState = {provider: "oaicompat", activeTab: "providers", customProviderAdvancedExpanded: {oaicompat: true}, customProviderManualIntent: {oaicompat: true}};
	assert.equal(plugin.ensureProviderClient().getCustomInterfaceStatus("oaicompat").resolved, "ollama_native");
	let panel = plugin.getSettingsPanel({});
	const keySlot = findByProp(panel, "data-provider-main-slot", "key")[0];
	assert.equal(findByProp(keySlot, "type", "password")[0].props.placeholder, "Optional locally; enter a Bearer key for cloud");
	// the boolean transport offers exactly one on value, and GPT-OSS offers its enum
	plugin.ensureSettingsStore().setReasoningModelPref("oaicompat", "qwen3:8b", {mode: "on", profile: "auto", effort: "low", onRaw: true, rawExplicit: true});
	panel = plugin.getSettingsPanel({});
	assert.deepEqual(findByProp(findByProp(panel, "data-provider-main-slot", "strength")[0], "options")[0].props.options.map(option => option.label), ["true"]);

	plugin.ensureSettingsStore().setCredentialField("oaicompat", "model", "gpt-oss:20b");
	plugin.ensureSettingsStore().setReasoningModelPref("oaicompat", "gpt-oss:20b", {mode: "on", profile: "auto", effort: "low", onRaw: "low", rawExplicit: true});
	panel = plugin.getSettingsPanel({});
	assert.deepEqual(findByProp(findByProp(panel, "data-provider-main-slot", "strength")[0], "options")[0].props.options.map(option => option.label), ["low", "medium", "high"]);
});

test("M5a Gemini UI derives budget versus level choices without changing the five-slot surface", () => {
	global.document = global.document || {querySelector: () => null, querySelectorAll: () => [], body: {}, documentElement: {}, createElement: () => ({style: {}, setAttribute() {}, appendChild() {}})};
	global.requestAnimationFrame = global.requestAnimationFrame || (fn => fn());
	const plugin = createPluginInstance({callSetLanguages: false, bdfdb});
	try {plugin.onLoad();} catch (error) {}
	plugin.settings = plugin.settings || {};
	for (const section in plugin.defaults || {}) {
		plugin.settings[section] = plugin.settings[section] || {};
		for (const key in plugin.defaults[section]) if (plugin.settings[section][key] === undefined) plugin.settings[section][key] = plugin.defaults[section][key].value;
	}
	plugin.settings.engines = {translator: "oaicompat", backup: "----", customProviders: [{id: "oaicompat", name: "Gemini relay"}]};
	plugin.settings.choices = plugin.settings.choices || {received: {input: "auto", output: "zh-CN"}, sent: {input: "auto", output: "en"}};
	plugin.setLanguages();
	for (const [field, value] of Object.entries({key: "gem-key", endpoint: "https://generativelanguage.googleapis.com/v1beta/models", model: "gemini-2.5-flash", interfaceFormat: "auto", reasoningMode: "off", reasoningProfile: "auto"})) plugin.ensureSettingsStore().setCredentialField("oaicompat", field, value);
	plugin.settingsUiState = {provider: "oaicompat", activeTab: "providers", customProviderAdvancedExpanded: {oaicompat: true}, customProviderManualIntent: {oaicompat: true}};
	let panel = plugin.getSettingsPanel({});
	assert.deepEqual(findByProp(panel, "data-provider-main-slot").map(node => node.props["data-provider-main-slot"]), ["endpoint", "key", "model", "thinking", "status-actions"]);
	assert.equal(findByProp(findByProp(panel, "data-provider-main-slot", "key")[0], "type", "password")[0].props.placeholder, "Gemini API key");
	// 2.5 speaks a budget, 3.x speaks a level, and both show the value that is sent
	plugin.ensureSettingsStore().setReasoningModelPref("oaicompat", "gemini-2.5-flash", {mode: "on", profile: "auto", effort: "low", onRaw: -1, rawExplicit: true});
	panel = plugin.getSettingsPanel({});
	assert.deepEqual(findByProp(findByProp(panel, "data-provider-main-slot", "strength")[0], "options")[0].props.options.map(option => option.label), ["dynamic (-1)", getEnglishText("thinking_strength_custom")]);

	plugin.ensureSettingsStore().setCredentialField("oaicompat", "model", "gemini-3.1-pro");
	plugin.ensureSettingsStore().setReasoningModelPref("oaicompat", "gemini-3.1-pro", {mode: "on", profile: "auto", effort: "low", onRaw: "low", rawExplicit: true});
	panel = plugin.getSettingsPanel({});
	assert.deepEqual(findByProp(findByProp(panel, "data-provider-main-slot", "strength")[0], "options")[0].props.options.map(option => option.label), ["low", "medium", "high", getEnglishText("thinking_strength_custom")], "Pro never offers the level it rejects");

	plugin.ensureSettingsStore().setCredentialField("oaicompat", "key", "");
	panel = plugin.getSettingsPanel({});
	assert.equal(findByProp(panel, "data-provider-action", "validate-config")[0].props.disabled, true, "Gemini detection waits for its required API key");
});

test("M5b Anthropic UI keeps explicit off for supported models and hides it for always-on models", () => {
	global.document = global.document || {querySelector: () => null, querySelectorAll: () => [], body: {}, documentElement: {}, createElement: () => ({style: {}, setAttribute() {}, appendChild() {}})};
	global.requestAnimationFrame = global.requestAnimationFrame || (fn => fn());
	const plugin = createPluginInstance({callSetLanguages: false, bdfdb});
	try {plugin.onLoad();} catch (error) {}
	plugin.settings = plugin.settings || {};
	for (const section in plugin.defaults || {}) {
		plugin.settings[section] = plugin.settings[section] || {};
		for (const key in plugin.defaults[section]) if (plugin.settings[section][key] === undefined) plugin.settings[section][key] = plugin.defaults[section][key].value;
	}
	plugin.settings.engines = {translator: "oaicompat", backup: "----", customProviders: [{id: "oaicompat", name: "Anthropic relay"}]};
	plugin.settings.choices = plugin.settings.choices || {received: {input: "auto", output: "zh-CN"}, sent: {input: "auto", output: "en"}};
	plugin.setLanguages();
	for (const [field, value] of Object.entries({key: "ant-key", endpoint: "https://api.anthropic.com/v1/messages", model: "claude-sonnet-5", interfaceFormat: "auto", reasoningMode: "off", reasoningProfile: "auto"})) plugin.ensureSettingsStore().setCredentialField("oaicompat", field, value);
	plugin.settingsUiState = {provider: "oaicompat", activeTab: "providers", customProviderAdvancedExpanded: {oaicompat: true}, customProviderManualIntent: {oaicompat: true}};
	let panel = plugin.getSettingsPanel({});
	assert.deepEqual(findByProp(panel, "data-provider-main-slot").map(node => node.props["data-provider-main-slot"]), ["endpoint", "key", "model", "thinking", "status-actions"]);
	assert.equal(findByProp(findByProp(panel, "data-provider-main-slot", "key")[0], "type", "password")[0].props.placeholder, "Anthropic API key");
	plugin.ensureSettingsStore().setReasoningModelPref("oaicompat", "claude-sonnet-5", {mode: "on", profile: "auto", effort: "low", onRaw: "low", rawExplicit: true});
	panel = plugin.getSettingsPanel({});
	assert.deepEqual(findByProp(findByProp(panel, "data-provider-main-slot", "strength")[0], "options")[0].props.options.map(option => option.label), ["low", "medium", "high", getEnglishText("thinking_strength_custom")], "Messages has no minimal tier in any generation");

	plugin.ensureSettingsStore().setCredentialField("oaicompat", "model", "claude-fable-5");
	plugin.ensureSettingsStore().setReasoningModelPref("oaicompat", "claude-fable-5", {mode: "on", profile: "auto", effort: "low", onRaw: "low", rawExplicit: true});
	panel = plugin.getSettingsPanel({});
	assert.deepEqual(findByProp(findByProp(panel, "data-provider-main-slot", "strength")[0], "options")[0].props.options.map(option => option.label), ["low", "medium", "high", getEnglishText("thinking_strength_custom")], "an always-on model keeps the same three levels; whether thinking runs at all is the mode above");

	plugin.ensureSettingsStore().setCredentialField("oaicompat", "key", "");
	panel = plugin.getSettingsPanel({});
	assert.equal(findByProp(panel, "data-provider-action", "validate-config")[0].props.disabled, true);
});

test("P1 model validation formats transport duration and two-line success or failure copy", () => {
	assert.equal(formatLatencyDuration(820, getEnglishText), "820 ms");
	assert.equal(formatLatencyDuration(1820, getEnglishText), "1.82 s");

	assert.deepEqual(createModelValidationView({ok: true, durationMs: 1820, httpStatus: 200, errorClass: null}, "model-a", getEnglishText), {
		tone: "ok",
		main: "Verified · model-a",
		detail: "Response 1.82 s",
		detailTone: "neutral"
	});
	assert.deepEqual(createModelValidationView({ok: false, durationMs: 4210, httpStatus: 429, errorClass: "rate_limit"}, "model-a", getEnglishText), {
		tone: "fail",
		main: "Verification failed · HTTP 429",
		detail: "Failed after 4.21 s · Rate limited",
		detailTone: "neutral"
	});
	assert.deepEqual(createModelValidationView({ok: false, durationMs: 92, httpStatus: 400, errorClass: "unsupported_value", errorParameter: "reasoning_effort"}, "model-a", getEnglishText), {
		tone: "fail",
		main: "Verification failed · HTTP 400",
		detail: "Failed after 92 ms · Parameter value unsupported · reasoning_effort",
		detailTone: "neutral"
	});
	assert.deepEqual(createModelValidationView({loading: true}, "model-a", getEnglishText), {
		tone: "neutral",
		main: "Validating configuration…",
		detail: ""
	});
	assert.deepEqual(createModelValidationView({ok: false, durationMs: null, httpStatus: null, errorClass: null}, "model-a", getEnglishText), {
		tone: "fail",
		main: "Verification failed",
		detail: "See the toast for details",
		detailTone: "neutral"
	});
	assert.deepEqual(createModelValidationView({ok: true, durationMs: 900, reasoningSupport: "reduced", reasoningResolvedValue: "low", reasoningEvidence: "none"}, "model-a", getEnglishText), {
		tone: "ok",
		main: "Verified · model-a",
		detail: "Response 900 ms · Field accepted · low (reduced)",
		detailTone: "ok"
	});
});

test("S1 custom provider status speaks plain language and keeps technical values in the title", () => {
	const getFormatLabel = id => ({openai_chat: "OpenAI Chat Completions", openai_responses: "OpenAI Responses"})[id] || id;
	const view = patch => createCustomProviderStatusView(Object.assign({validation: {ok: true, durationMs: 900}, interfaceStatus: {resolved: "openai_responses"}, model: "m"}, patch), getEnglishText, getFormatLabel);
	const confirmed = view({reasoningState: {mode: "off", support: "accepted", resolvedValue: "none", dispatchedRaw: "none", evidence: "confirmed"}});
	assert.equal(confirmed.text, "Thinking confirmed off \u00b7 none", "the sentence names the value that was sent");
	assert.equal(confirmed.latency, "Response 900 ms", "the probe's timing is its own second line, one format for every state");
	assert.equal(confirmed.tone, "ok");
	assert.match(confirmed.title, /OpenAI Responses/, "the full format name stays in the safe title");
	assert.match(confirmed.title, /none/);
	const unconfirmed = view({reasoningState: {mode: "off", support: "accepted", resolvedValue: "none", dispatchedRaw: "none", evidence: "none"}});
	assert.equal(unconfirmed.text, "Verified \u00b7 none sent");
	assert.equal(unconfirmed.latency, "Response 900 ms", "every fresh probe result carries its round-trip time");
	assert.equal(unconfirmed.tone, "ok");
	assert.match(unconfirmed.title, /Response 900 ms/, "the timing also rides the title");
	assert.notEqual(unconfirmed.text, confirmed.text, "accepted-without-evidence never reuses the confirmed sentence");
	assert.equal(view({reasoningState: {mode: "off", support: "reduced", resolvedValue: "low", dispatchedRaw: "128", evidence: "none"}}).text, "Reduced to the value this endpoint accepts \u00b7 128", "a reduced value is reported as the number that was accepted, not as a tier word");
	assert.equal(view({reasoningState: {mode: "on", support: "accepted", resolvedValue: "xhigh", dispatchedRaw: "xhigh", evidence: "confirmed"}}).text, "Sent xhigh \u00b7 response confirms thinking", "the sentence separates the sent raw from the observed effect");
	assert.equal(view({reasoningState: {mode: "off", support: "accepted", evidence: "contradicted"}}).text, "Off not applied · the relay or provider substituted another thinking level", "a failed off names the culprit instead of implying the model chose to think");
	assert.equal(view({reasoningState: {mode: "off", support: "accepted", evidence: "contradicted"}}).tone, "fail", "an off value that provably kept thinking reads as an error");
	assert.equal(view({reasoningState: {mode: "on", support: "accepted", evidence: "contradicted"}}).text, "Effort sent · this reply used no thinking");
	assert.equal(view({reasoningState: {mode: "on", support: "accepted", evidence: "contradicted"}}).latency, "Response 900 ms", "a failed effect still reports how fast the probe came back");
	assert.equal(view({reasoningState: {mode: "off", support: "unsupported"}}).text, "Provider rejected the reasoning setting");
	assert.equal(view({validation: null, reasoningState: {support: "pending"}}).text, "Not verified \u00b7 Verify setup");
	assert.equal(view({validation: null, reasoningState: {support: "pending"}}).latency, "", "no probe, no timing line");
	assert.equal(view({reasoningState: {mode: "follow"}}).text, "Using provider reasoning settings");
	assert.equal(view({reasoningState: {mode: "follow"}}).latency, "Response 900 ms", "following the provider still reports the probe's timing");
	assert.equal(view({validation: {ok: true, durationMs: 900, reasoningTokens: 0}, reasoningState: {mode: "off", support: "accepted", resolvedValue: "none", dispatchedRaw: "none", evidence: "confirmed"}}).latency, "Response 900 ms · 0 thinking tokens", "the provider's own thinking bill prints next to the timing");
	const compatibleZero = view({validation: {ok: true, durationMs: 900, reasoningTokens: 0}, interfaceStatus: {resolved: "openai_chat"}, reasoningState: {mode: "on", support: "accepted", dispatchedRaw: "low", evidence: "none"}});
	assert.equal(compatibleZero.text, "Verified · low sent");
	assert.match(compatibleZero.title, /Compatible APIs may rewrite requests/, "the title explains why a visible zero stays unconfirmed");
	assert.equal(view({validation: {ok: true, durationMs: 900, reasoningTokens: 37}, reasoningState: {mode: "off", support: "accepted", evidence: "contradicted"}}).latency, "Response 900 ms · 37 thinking tokens");
	const offActual = view({validation: {ok: true, durationMs: 900, reasoningTokens: 37, reasoningEchoRaw: "low"}, reasoningState: {mode: "off", support: "accepted", evidence: "contradicted"}});
	assert.equal(offActual.text, "Off not applied · the provider actually used low", "the Responses echo names the substituted level instead of hinting at an unnamed one");
	assert.equal(offActual.tone, "fail");
	assert.match(offActual.latency, /Provider level low/, "the echoed level rides the telemetry line");
	const substituted = view({validation: {ok: true, durationMs: 900, reasoningTokens: 121, reasoningEchoRaw: "low"}, reasoningState: {mode: "on", support: "accepted", resolvedValue: "xhigh", dispatchedRaw: "xhigh", evidence: "confirmed"}});
	assert.equal(substituted.text, "Sent xhigh · the provider substituted low", "an on-mode echo that differs from the sent raw reads as a substitution warning");
	assert.equal(substituted.tone, "warn");
	assert.equal(view({validation: {ok: true, durationMs: 900, reasoningTokens: 121, reasoningEchoRaw: "high"}, reasoningState: {mode: "on", support: "accepted", resolvedValue: "high", dispatchedRaw: "high", evidence: "confirmed"}}).text, "Sent high · response confirms thinking", "a matching echo keeps the confirmed sentence");
	assert.equal(view({stale: true, reasoningState: {mode: "off", support: "accepted", evidence: "confirmed"}}).text, "Setup changed \u00b7 Verify setup again");
	assert.equal(view({interfaceStatus: {resolved: ""}, reasoningState: {}}).text, "API type not detected \u00b7 Choose it in Advanced");
	assert.equal(view({benchmarkResult: {baseline: {successCount: 6, p50Ms: 1000, p95Ms: 1200}, controlled: {successCount: 6, p50Ms: 1300, p95Ms: 1500}}, reasoningState: {mode: "off", support: "accepted", evidence: "confirmed"}}).text, "Speed test is slower \u00b7 Use provider default");
	assert.equal(view({stale: true, reasoningState: {mode: "follow"}}).text, "Using provider reasoning settings");
	assert.equal(view({interfaceStatus: {resolved: ""}, reasoningState: {mode: "follow"}}).text, "API type not detected \u00b7 Choose it in Advanced");
	const failed = view({validation: {ok: false, durationMs: 92, httpStatus: 400, errorClass: "unsupported_value", errorParameter: "reasoning_effort"}, interfaceStatus: {resolved: "openai_chat"}, reasoningState: {}});
	assert.equal(failed.tone, "fail");
	assert.equal(failed.text, "Verification failed · Parameter value unsupported", "the failure line is the result plus the human reason");
	assert.match(failed.title, /HTTP 400/, "the status code rides in the title");
	for (const candidate of [confirmed, unconfirmed, view({reasoningState: {mode: "off", support: "unsupported"}}), view({reasoningState: {mode: "off", support: "reduced", resolvedValue: "low"}})]) {
		assert.doesNotMatch(candidate.text, /openai_chat|openai_responses|ollama_native|gemini_native|anthropic_messages|reasoning_effort|enable_thinking|chat_template_kwargs|thinkingBudget|thinkingLevel|budget=|level=|adaptive=/);
	}
	assert.equal(isBenchmarkSlower({baseline: {successCount: 6, p50Ms: 1000, p95Ms: 1200}, controlled: {successCount: 6, p50Ms: 1300, p95Ms: 1500}}), true);
	assert.equal(isBenchmarkSlower({baseline: {successCount: 6, p50Ms: 1000, p95Ms: 1200}, controlled: {successCount: 6, p50Ms: 900, p95Ms: 1500}}), false);
});


test("S1 status sentences are literal in all three locales and never infer model properties", () => {
	const locales = [[true, false], [false, false], [false, true]];
	const expected = {
		custom_status_off_not_applied: ["关闭未生效 · 中转或上游改用了其他思考等级", "Off not applied · the relay or provider substituted another thinking level", "Выключение не сработало · шлюз или провайдер подставил другой уровень рассуждений"],
		custom_status_on_not_applied: ["已发送思考强度 · 本次回复未产生思考", "Effort sent · this reply used no thinking", "Интенсивность отправлена · в этом ответе рассуждений не было"],
		custom_status_setting_rejected: ["当前接口未接受思考设置", "Provider rejected the reasoning setting", "API отклонил настройку"],
		custom_status_upstream: ["跟随上游思考设置", "Using provider reasoning settings", "Используются настройки API"],
		custom_status_interface_unknown: ["未识别接口类型 · 请在高级设置选择", "API type not detected · Choose it in Advanced", "Тип API не определён · Выберите в расширенных"],
		custom_status_benchmark_slower: ["速度测试较慢 · 建议跟随上游", "Speed test is slower · Use provider default", "Тест медленнее · Используйте значение API"]
	};
	for (const [key, values] of Object.entries(expected)) {
		locales.forEach(([isChinese, isRussian], index) => assert.equal(getCustomTextValue(key, isChinese, isRussian), values[index], key + " locale " + index));
	}
	for (const [isChinese, isRussian] of locales) {
		// every sentence that reports a value must have a slot for the exact raw
		for (const key of ["custom_status_effort_reduced", "custom_status_thinking_on_confirmed", "custom_status_thinking_off_confirmed", "custom_status_setting_sent_unconfirmed", "custom_status_invalid_strength"]) assert.match(getCustomTextValue(key, isChinese, isRussian), /\{raw\}/, key);
		for (const key of ["custom_status_effort_reduced", "custom_status_thinking_on_confirmed"]) assert.doesNotMatch(getCustomTextValue(key, isChinese, isRussian), /\{level\}/, key + " must not localize the value");
	}
	assert.doesNotMatch(getCustomTextValue("custom_status_setting_rejected", true, false), /无需|不需要|模型.*不支持思考/);
	assert.doesNotMatch(getCustomTextValue("custom_status_setting_rejected", false, false), /does not need|model.*does not support reasoning/i);
	assert.doesNotMatch(getCustomTextValue("custom_status_setting_rejected", false, true), /не требуется|модель.*не поддерживает.*рассужден/i);
	// every locale explains the visible changes this rebuild brings (the relabelling
	// note retired once the tier menu grew its own per-row glosses)
	for (const [isChinese, isRussian] of locales) {
		for (const key of ["thinking_migration_rejected_note", "thinking_migration_invalid_note"]) {
			assert.ok(getCustomTextValue(key, isChinese, isRussian).length > 8, key);
		}
	}
	assert.doesNotMatch(read("src/ui/settings-panel.js"), /custom_status_manual_choose/);
	assert.doesNotMatch(read("src/i18n/text.js"), /custom_status_manual_choose|custom_status_auto_success|custom_status_manual_success|custom_status_low_only|custom_status_field_ignored/);
});

test("S1 a failed model test never leaks wire parameters or a stale reasoning verdict into the visible line", () => {
	const getFormatLabel = id => id === "openai_chat" ? "OpenAI Chat Completions" : id;
	const validation = {ok: false, durationMs: 92, httpStatus: 400, errorClass: "unsupported_value", errorParameter: "reasoning_effort", reasoningSupport: "accepted", reasoningResolvedValue: "none", reasoningEvidence: "confirmed", reasoningMode: "off"};
	const reasoningState = {mode: "off", support: "accepted", resolvedValue: "none", evidence: "confirmed"};
	const cases = [[false, false, "Parameter value unsupported", "92 ms"], [true, false, "当前参数值不受支持", "92 毫秒"], [false, true, "Значение параметра не поддерживается", "92 мс"]];
	for (const [isChinese, isRussian, errorPhrase, durationPhrase] of cases) {
		const getText = key => getCustomTextValue(key, isChinese, isRussian);
		const view = createCustomProviderStatusView({strategy: "auto", validation, interfaceStatus: {resolved: "openai_chat"}, reasoningState, model: "m"}, getText, getFormatLabel);
		assert.equal(view.tone, "fail");
		assert.equal(view.text.includes(errorPhrase), true, errorPhrase);
		assert.doesNotMatch(view.text, /HTTP 400/, "the status code rides in the title, not the sentence");
		assert.equal(view.text.includes(durationPhrase), false, "timing detail stays out of the visible line");
		assert.doesNotMatch(view.text, /reasoning_effort|OpenAI Chat|openai_chat/, "wire parameter and API type stay out of the visible line");
		assert.doesNotMatch(view.text, /(^|[^a-z])none([^a-z]|$)/i, "the previously resolved value never reaches the visible line");
		assert.doesNotMatch(view.text, /Reasoning disabled|已确认关闭|отключён/, "a failure never carries the previous confirmed verdict");
		assert.match(view.title, /HTTP 400/, "the safe title keeps the status code");
		assert.equal(view.title.includes(durationPhrase), true, "the safe title keeps the timing");
		assert.match(view.title, /reasoning_effort/, "the safe title keeps the parameter name");
		assert.match(view.title, /OpenAI Chat Completions/);
	}
});

test("S2 following the provider hides every reasoning control and resets a stale speed disclosure", () => {
	const fixture = createCustomProviderFixture({bdfdbBase: bdfdb});
	const {plugin} = fixture;
	let panel = fixture.render();
	findByProp(panel, "data-provider-action", "advanced")[0].props.onClick();
	panel = fixture.render();
	findByProp(panel, "data-provider-action", "speed")[0].props.onClick();
	panel = fixture.render();
	assert.equal(findByClassName(panel, "translator-provider-speed-body").length, 1, "the speed disclosure starts open for this fixture");

	findByProp(findByProp(panel, "data-provider-main-slot", "thinking")[0], "options")[0].props.onChange("follow");
	panel = fixture.render();
	assert.equal(findByProp(panel, "data-provider-advanced-field", "format").length, 1, "the API type stays reachable while following the provider");
	assert.equal(findByProp(panel, "data-provider-main-slot", "strength").length, 0, "following the provider has no strength to offer");
	assert.equal(findByProp(panel, "data-provider-action", "speed").length, 0, "the speed toggle itself disappears, not just its body");
	assert.equal(findByClassName(panel, "translator-provider-speed-body").length, 0);
	assert.equal(findByClassName(panel, "translator-reasoning-benchmark").length, 0);
	assert.equal(plugin.settingsUiState.customProviderSpeedExpanded.oaicompat, false, "the disclosure state is reset, not merely hidden");
	assert.equal(findByProp(panel, "data-provider-action", "validate-config")[0].props.disabled, false, "connectivity can still be verified while following the provider");
	assert.equal(findByProp(panel, "data-provider-main-slot", "thinking").length, 1);

	findByProp(findByProp(panel, "data-provider-main-slot", "thinking")[0], "options")[0].props.onChange("off");
	panel = fixture.render();
	assert.equal(findByClassName(panel, "translator-provider-speed-body").length, 0, "switching back never revives the old disclosure");
	assert.equal(plugin.settingsUiState.customProviderSpeedExpanded.oaicompat, false);
});




test("S2 gating expressions stay where the review can see them", () => {
	const source = read("src/ui/settings-panel.js");
	assert.match(source, /const locallyRefused = reasoningState\.availability === "unsupported";/, "the local verdict is named once and reused");
	assert.match(source, /: locallyRefused \? "custom_status_invalid_strength"/, "a value the model refuses disables the one validate action");
	assert.match(source, /customProviderSpeedExpanded\[engineKey\] = false/);
	assert.match(source, /reasoningState\.mode !== "follow" && el\("div", \{className: "translator-provider-speed"/, "following the provider hides the whole speed block");
	assert.match(source, /const diagnosticsVisible = !locallyRefused && \(validationErrorVisible \|\| reasoningState\.support === "unsupported"\);/, "a local verdict gets no technical detail line; failures and refusals print theirs directly");
	assert.match(source, /getCustomInterfaceStatus\(engineKey\);[\s\S]{0,600}getModelCatalogEndpoint\(engineKey, normalizedEndpoint, options\)/, "the visible-catalog key is computed with the resolved wire format, so Responses/Ollama/Gemini fetches stay visible");
	assert.doesNotMatch(source, /model_fetch_loading"\)\}\)\)/, "fetch progress rides the refresh button, never a separate banner that jolts the layout");
	assert.doesNotMatch(source, /"data-provider-advanced-field": "protocol"|"data-provider-advanced-field": "effort"/, "the retired advanced rows are gone");
	const guard = source.slice(source.indexOf("const updateReasoningPreference = patch =>"));
	assert.match(guard.slice(0, 260), /if \(!keys\.some\(key => reasoningState\[key\] !== patch\[key\]\)\) return false;/, "the no-op guard stays ahead of every side effect");
});


test("S3 the API type row shows short names, keeps full names in the title, and explains itself", () => {
	const fixture = createCustomProviderFixture({bdfdbBase: bdfdb});
	const {plugin} = fixture;
	let panel = fixture.render();
	const endpointSlot = findByProp(panel, "data-provider-main-slot", "endpoint")[0];
	assert.equal(JSON.stringify(endpointSlot.props).includes(plugin.getCustomText("api_endpoint_auto_type_tip")), true, "the endpoint explains that the API type is detected from it");

	findByProp(panel, "data-provider-action", "advanced")[0].props.onClick();
	panel = fixture.render();
	const formatRow = findByProp(panel, "data-provider-advanced-field", "format")[0];
	assert.equal(JSON.stringify(formatRow.props).includes(plugin.getCustomText("api_type")), true, "the row is labelled API type");
	assert.equal(JSON.stringify(formatRow.props).includes(plugin.getCustomText("api_type_tip")), true);
	const select = findByProp(formatRow, "options")[0];
	assert.deepEqual(select.props.options.map(option => option.label), [
		plugin.getCustomText("api_type_auto"),
		plugin.getCustomText("api_type_openai_chat_short"),
		plugin.getCustomText("api_type_openai_responses_short"),
		plugin.getCustomText("api_type_ollama_native_short"),
		plugin.getCustomText("api_type_gemini_native_short"),
		plugin.getCustomText("api_type_anthropic_messages_short")
	], "the trigger stays short enough for the 196px control");
	assert.equal(select.props.triggerTitle, plugin.getCustomText("api_format_openai_chat"), "hovering still reveals the full protocol name");
	for (const label of select.props.options.map(option => option.label)) assert.equal(label.length <= 18, true, `${label} fits the trigger`);
});

test("S3 validation keeps the same secondary style before and after model verification", () => {
	const fixture = createCustomProviderFixture({bdfdbBase: bdfdb});
	let panel = fixture.render();
	const pendingDetect = findByProp(panel, "data-provider-action", "validate-config")[0];
	assert.match(pendingDetect.props.className, /translator-btn-sec/, "an untested model uses the shared dark action style");
	assert.doesNotMatch(pendingDetect.props.className, /translator-btn-primary/);
	assert.match(findByProp(panel, "data-provider-action", "advanced")[0].props.className, /translator-provider-advanced-toggle/, "advanced is a quiet disclosure row, never a competing button");

	fixture.setReasoning({support: "accepted", evidence: "confirmed", resolvedValue: "none"});
	panel = fixture.render();
	assert.equal(findByProp(panel, "data-provider-action", "validate-config")[0].props.className, pendingDetect.props.className, "model verification does not change the button style");
});

test("S3 the advanced disclosure turns its own chevron and the panel metrics stay put", () => {
	const styles = read("src/ui/styles.js");
	// live copy must not send the user to an action that no longer exists, in any locale
	for (const locale of [[true, false], [false, false], [false, true]]) {
		for (const key of ["custom_status_unknown_model", "custom_status_stale", "custom_status_detecting", "custom_status_error", "model_validation_loading", "benchmark_need_mode", "model_id_label"]) {
			assert.doesNotMatch(getCustomTextValue(key, locale[0], locale[1]), /检测模型|模型检测|Test model|Model test|Testing model|test the model|Проверьте модель|Проверить модель|Проверка модели|проверьте модель/i, key);
		}
	}
	const panelSource = read("src/ui/settings-panel.js");
	// a dedicated hook: rotating every button icon would spin the trash and refresh glyphs too
	assert.match(panelSource, /"data-provider-action": "advanced"[\s\S]{0,400}translator-provider-advanced-chevron/);
	assert.match(styles, /\.translator-provider-advanced-chevron \{[^}]*transition: transform/);
	assert.match(styles, /\[data-provider-action="advanced"\]\[aria-expanded="true"\] \.translator-provider-advanced-chevron \{transform: rotate\(180deg\);\}/);
	assert.doesNotMatch(styles, /\.translator-btn svg \{transform: rotate/);
	// the speed disclosure keeps the rule it already had
	assert.match(styles, /\.translator-provider-speed-toggle\[aria-expanded="true"\] svg \{transform: rotate\(180deg\);\}/);

	// regression fence: S3 is a copy and hierarchy pass, not a re-style
	assert.match(styles, /\.translator-field-label \{[\s\S]{0,220}margin: 14px 0 6px;[\s\S]{0,120}font-size: 16px;[\s\S]{0,60}font-weight: 500;/);
	assert.match(styles, /\.translator-input \{[\s\S]{0,120}height: 32px;/);
	assert.match(styles, /\.translator-provider-detail \.translator-input \{height: 38px;\}/);
	assert.match(styles, /\.translator-provider-status-actions \{min-height: 40px; margin-top: 8px;[\s\S]{0,120}gap: 8px;/);
	assert.match(panelSource, /createSelectIn\(196,/);
	assert.doesNotMatch(styles.slice(styles.indexOf(".translator-provider-advanced-chevron")), /overflow: (?:auto|scroll)/);
});

test("S3 the thinking tip describes the rules the panel actually follows", () => {
	const locales = [[true, false], [false, false], [false, true]];
	const expected = {
		thinking_mode_tip: [
			"按模型分别保存。关闭思考适合大多数用户；跟随上游不发送任何思考字段；开启思考后可选强度，强度名就是发给上游的原值。",
			"Saved per model. Thinking off suits most people, following the provider sends no thinking field at all, and thinking on adds a strength whose name is the value sent upstream.",
			"Хранится для каждой модели. Выключение подходит большинству, режим провайдера не отправляет поле рассуждений, а при включении появляется интенсивность, название которой и есть значение для API."
		],
		advanced_settings_tip: [
			"接口类型通常由插件自动识别；只有上游文档明确要求时才手动选择。",
			"The plugin normally detects the API type; choose one manually only when the provider documentation requires it.",
			"Обычно тип API определяется автоматически; выбирайте его вручную только по документации провайдера."
		]
	};
	for (const [key, values] of Object.entries(expected)) {
		locales.forEach(([isChinese, isRussian], index) => assert.equal(getCustomTextValue(key, isChinese, isRussian), values[index], key + " locale " + index));
	}
	for (const [isChinese, isRussian] of locales) {
		for (const key of ["thinking_mode_follow", "thinking_mode_off", "thinking_mode_on", "thinking_strength_label"]) {
			assert.ok(getCustomTextValue(key, isChinese, isRussian).length > 2, key);
		}
		assert.doesNotMatch(getCustomTextValue("thinking_mode_tip", isChinese, isRussian), /自动适配|Auto-configure|Автонастройка/, "the retired strategy names are gone");
		for (const key of ["thinking_mode_tip", "advanced_settings_tip", "api_type_tip", "thinking_strength_tip"]) {
			assert.doesNotMatch(getCustomTextValue(key, isChinese, isRussian), /协议|protocol|протокол/i, key);
		}
		assert.doesNotMatch(getCustomTextValue("advanced_settings_tip", isChinese, isRussian), /接口格式|API format|формат API/i);
	}
});


test("cache-free A/B result view reports plain-language comparisons, partial results and cancellation", () => {
	assert.equal(formatBenchmarkCompare(1000, 700, getEnglishText), "Current setting is 30% faster");
	assert.equal(formatBenchmarkCompare(1000, 1300, getEnglishText), "Current setting is 30% slower");
	assert.equal(formatBenchmarkCompare(1000, 1004, getEnglishText), "About the same");
	const complete = createBenchmarkResultView({
		mode: "off",
		support: "reduced",
		resolvedValue: "low",
		evidence: "none",
		completed: 10,
		baseline: {successCount: 6, p50Ms: 1000, p95Ms: 1400, reasoningTokens: 12},
		controlled: {successCount: 6, p50Ms: 700, p95Ms: 900, reasoningTokens: 0},
		reason: null
	}, getEnglishText);
	assert.deepEqual(complete.rows.map(row => row.key), ["Provider default", "Reduced thinking", "Comparison"]);
	assert.match(complete.rows[0].value, /Reasoning 12/);
	assert.match(complete.rows[0].value, /typical 1 s · slowest 1\.4 s/, "P50/P95 jargon stays out of the rows");
	assert.equal(complete.rows[2].value, "Current setting is 30% faster");
	assert.equal(complete.tone, "ok");
	assert.equal(complete.status, "Current setting is faster - keep it");

	const confirmed = createBenchmarkResultView({mode: "off", support: "accepted", resolvedValue: "none", evidence: "confirmed", completed: 12, baseline: {successCount: 6, p50Ms: 1000, p95Ms: 1200}, controlled: {successCount: 6, p50Ms: 600, p95Ms: 800}}, getEnglishText);
	assert.equal(confirmed.rows[1].key, "Thinking off (confirmed)");
	const contradicted = createBenchmarkResultView({mode: "off", support: "accepted", resolvedValue: "none", evidence: "contradicted", completed: 12, baseline: {successCount: 6, p50Ms: 1000, p95Ms: 1200}, controlled: {successCount: 6, p50Ms: 1000, p95Ms: 1200}}, getEnglishText);
	assert.equal(contradicted.rows[1].key, "Thinking off (not applied)");
	assert.equal(contradicted.status, "About the same - nothing to change");
	const mixed = createBenchmarkResultView({mode: "on", effort: "low", support: "accepted", completed: 12, baseline: {successCount: 6, p50Ms: 1000, p95Ms: 1200}, controlled: {successCount: 6, p50Ms: 900, p95Ms: 1500}}, getEnglishText);
	assert.equal(mixed.rows[1].key, "Current setting · low");
	assert.equal(mixed.status, "Mixed results - little difference either way");
	const partial = createBenchmarkResultView({support: "accepted", resolvedValue: "none", evidence: "none", completed: 4, baseline: {successCount: 2}, controlled: {successCount: 2}, reason: "provider_failed"}, getEnglishText);
	assert.equal(partial.rows[2].value, "Too few successful requests to compare");
	assert.equal(partial.status, "A request failed; the test stopped early");
	const cancelled = createBenchmarkResultView({support: "accepted", total: 12, completed: 3, baseline: {}, controlled: {}, cancelled: true, reason: "cancelled"}, getEnglishText);
	assert.equal(cancelled.status, "Stopped · 3/12 sent");
});

test("P1 AI performance rows preserve queue wait zero and gate P50/P95 until five translation samples", () => {
	const base = {
		latestTranslation: {engineKey: "openai", kind: "live", transportMs: 4210, queueWaitMs: 0, status: "ok", httpStatus: 200, errorClass: null, inputChars: 428, outputChars: 336, messageCount: 4},
		latestDetect: {engineKey: "openai", kind: "detect", transportMs: 1820, queueWaitMs: null, status: "ok", httpStatus: 200, errorClass: null},
		sampleCount: 4,
		sufficient: false,
		p50Ms: null,
		p95Ms: null,
		queueSampleCount: 4,
		queueSufficient: false,
		queueP50Ms: null,
		queueP95Ms: null,
		failoverCount: 1,
		timeoutCount: 0,
		rateLimitCount: 0,
		queueWaitMs: 0
	};
	let rows = createAiPerformanceRows(base, key => key == "openai" ? "OpenAI" : key, getEnglishText);
	assert.deepEqual(rows.map(row => row.value), ["OpenAI · 4.21 s", "OpenAI · 1.82 s", "0 ms", "Not enough samples (0)", "Not enough samples (0)", "Not enough samples (0)", "0 / 0 / 0 / 0", "0 / 0 / 0", "Not enough samples (4)", "Not enough samples (4)", "428 / 336 / 4 msgs", "1", "0 / 0", "— total / — batch"]);

	rows = createAiPerformanceRows(Object.assign({}, base, {sampleCount: 5, sufficient: true, p50Ms: 900, p95Ms: 2400, queueSampleCount: 5, queueSufficient: true, queueP50Ms: 20, queueP95Ms: 80}), key => key, getEnglishText);
	assert.equal(rows[8].value, "5 / P50 900 ms / P95 2.4 s");
	assert.equal(rows[9].value, "5 / P50 20 ms / P95 80 ms");
	assert.equal(rows[1].tone, "neutral", "detect timing is a neutral observation");

	rows = createAiPerformanceRows(Object.assign({}, base, {
		latestTranslation: {engineKey: "openai", kind: "live", transportMs: 4210, queueWaitMs: 0, status: "http_429", httpStatus: 429, errorClass: "rate_limit", role: "backup", inputChars: 12, outputChars: null, messageCount: 1}
	}), key => key == "openai" ? "OpenAI" : key, getEnglishText);
	assert.equal(rows[0].value, "OpenAI · Failed after 4.21 s (backup) · HTTP 429 · Rate limited");
	assert.equal(rows[0].tone, "fail");
});

test("F2 field diagnostics expose live TTFT lead, stream counters and idle resources", () => {
	const snapshot = {
		liveSampleCount: 5, liveSufficient: true, liveP50Ms: 2000, liveP95Ms: 4200,
		liveTtftSampleCount: 5, liveTtftSufficient: true, liveTtftP50Ms: 600, liveTtftP95Ms: 1100,
		streamAttemptCount: 6, streamChunkCount: 18, streamFallbackCount: 1, streamCancelCount: 0
	};
	const rows = createAiPerformanceRows(snapshot, key => key, getEnglishText, {active: 0, readerCount: 0, timerCount: 0});
	assert.equal(rows[3].value, "5 / P50 2 s / P95 4.2 s");
	assert.equal(rows[4].value, "5 / P50 600 ms / P95 1.1 s");
	assert.equal(rows[5].value, "1.4 s faster / 30% of total / Gate met");
	assert.equal(rows[5].tone, "ok");
	assert.equal(rows[6].value, "6 / 18 / 1 / 0");
	assert.equal(rows[7].value, "0 / 0 / 0");
	assert.equal(rows[7].tone, "neutral");
	const busy = createAiPerformanceRows(snapshot, key => key, getEnglishText, {active: 1, readerCount: 1, timerCount: 1});
	assert.equal(busy[7].tone, "neutral", "active streaming resources are an observation, not a leak failure");
	const shortLead = createAiPerformanceRows(Object.assign({}, snapshot, {liveP50Ms: 1000, liveTtftP50Ms: 600}), key => key, getEnglishText);
	assert.equal(shortLead[5].value, "400 ms faster / 60% of total / Gate not met", "both the ratio and absolute 500 ms lead are required");
	assert.equal(shortLead[5].tone, "fail");
});

test("P1 copied AI diagnostics use a strict aggregate whitelist", () => {
	const snapshot = {
		latestTranslation: {
			engineKey: "openai", kind: "live", transportMs: 250, queueWaitMs: 10,
			status: "ok", httpStatus: 200, errorClass: null, role: "primary", attempt: 1,
			messageCount: 2, inputChars: 30, outputChars: 20, streaming: true, ttftMs: 80, streamChunkCount: 3, streamFallback: false, requestId: 99, endpoint: "https://secret.invalid", prompt: "secret", rawError: "secret"
		},
		latestDetect: {engineKey: "openai", kind: "detect", transportMs: 50, queueWaitMs: null, status: "ok", httpStatus: 200, errorClass: null, role: "primary", attempt: 1, messageCount: 1, inputChars: 12, outputChars: null},
		sampleCount: 5, sufficient: true, p50Ms: 200, p95Ms: 450,
		queueSampleCount: 5, queueSufficient: true, queueP50Ms: 5, queueP95Ms: 20,
		liveSampleCount: 5, liveSufficient: true, liveP50Ms: 2000, liveP95Ms: 4500,
		liveTtftSampleCount: 5, liveTtftSufficient: true, liveTtftP50Ms: 800, liveTtftP95Ms: 1200,
		streamAttemptCount: 5, streamChunkCount: 15, streamFallbackCount: 1, streamCancelCount: 0,
		failoverCount: 0, timeoutCount: 0, rateLimitCount: 0, queueWaitMs: 10
	};
	const payload = createAiLatencyDiagnosticsPayload(snapshot, {active: 0, readerCount: 0, decoderCount: 0, timerCount: 0, logicalSignalCount: 0, bufferBytes: 0});
	assert.deepEqual(Object.keys(payload.latestTranslation), ["engineKey", "kind", "durationMs", "queueWaitMs", "status", "httpStatus", "errorClass", "role", "attempt", "messageCount", "inputChars", "outputChars", "streaming", "ttftMs", "streamChunkCount", "streamFallback", "lane", "engineFamily", "providerMs", "leaseWaitMs", "enqueueToDomMs", "promptTokens", "completionTokens", "reasoningTokens", "requestCount", "repairCount", "fallbackCount", "outcome", "stage", "reason", "schemaVersion", "wireFamily", "wireVersion", "sourceBytes", "translateBytes", "wireBytes", "promptBytes", "metadataBytes", "requestBodyBytes", "wireAmplification", "segmentCount", "itemCount", "contextIncluded", "contextBytes", "protectedMarkerBytes", "prohibitedFieldCount", "danglingContextRefCount", "danglingContextRefBytes", "configuredTermLeakCount", "wrapperContentLeakCount", "emailLeakCount", "bareDomainLeakCount", "ipPortLeakCount", "commandLeakCount", "protectedIntegrity"]);
	assert.equal(payload.latestDetect.kind, "detect");
	assert.deepEqual(payload.translation, {sampleCount: 5, p50Ms: 200, p95Ms: 450});
	assert.deepEqual(payload.queue, {latestMs: 10, sampleCount: 5, p50Ms: 5, p95Ms: 20});
	assert.deepEqual(payload.live, {sampleCount: 5, p50Ms: 2000, p95Ms: 4500});
	assert.deepEqual(payload.ttft, {sampleCount: 5, p50Ms: 800, p95Ms: 1200});
	assert.deepEqual(payload.ttftGate, {ready: true, passed: true, leadMs: 1200, ratioPercent: 40});
	assert.deepEqual(payload.stream, {attemptCount: 5, chunkCount: 15, fallbackCount: 1, cancelCount: 0});
	assert.deepEqual(payload.resources, {active: 0, controllerCount: 0, readerCount: 0, decoderCount: 0, timerCount: 0, logicalSignalCount: 0, bufferBytes: 0});
	const serialized = JSON.stringify(payload);
	assert.doesNotMatch(serialized, /"(?:requestId|endpoint|prompt|rawError)"\s*:/);
	assert.doesNotMatch(serialized, /secret\.invalid/);
});

test("built diagnostics copy includes TTFT gate and exact idle resource snapshot", () => {
	let copied = "";
	const plugin = createPluginInstance({callSetLanguages: false, bdfdb: Object.assign({}, bdfdb, {LibraryModules: {WindowUtils: {copy: value => {copied = value;}}}})});
	try {plugin.onLoad();} catch (error) {}
	plugin.settings = plugin.settings || {};
	for (const section in plugin.defaults || {}) {
		plugin.settings[section] = plugin.settings[section] || {};
		for (const key in plugin.defaults[section]) if (plugin.settings[section][key] === undefined) plugin.settings[section][key] = plugin.defaults[section][key].value;
	}
	plugin.settings.engines = plugin.settings.engines || {translator: "googleapi", backup: "----", customProviders: []};
	plugin.settingsUiState = {activeTab: "diagnostics"};
	const realClient = plugin.ensureProviderClient();
	plugin.ensureProviderClient = () => Object.assign({}, realClient, {
		getLatencySnapshot: () => ({
			liveSampleCount: 5, liveSufficient: true, liveP50Ms: 2000, liveP95Ms: 4200,
			liveTtftSampleCount: 5, liveTtftSufficient: true, liveTtftP50Ms: 600, liveTtftP95Ms: 1100,
			streamAttemptCount: 6, streamChunkCount: 18, streamFallbackCount: 1, streamCancelCount: 0
		}),
		getProviderAttemptSnapshot: () => ({active: 0, readerCount: 0, decoderCount: 0, timerCount: 0, logicalSignalCount: 0, bufferBytes: 0})
	});
	const routeId = plugin.beginTranslationTerminalRoute({lane: "manual", engineFamily: "custom", promptFamily: "single-manual", validatorFamily: "manual-received"});
	plugin.finishTranslationTerminalRoute(routeId, {outcome: "skipped", stage: "similarity", reason: "too_similar"});
	const panel = plugin.getSettingsPanel({});
	const copyButton = findByClassName(panel, "translator-copy-diagnostics")[0];
	assert.ok(copyButton);
	copyButton.props.onClick();
	const copiedRoot = JSON.parse(copied);
	const payload = copiedRoot.aiPerformance;
	assert.equal(payload.ttftGate.passed, true);
	assert.deepEqual(payload.stream, {attemptCount: 6, chunkCount: 18, fallbackCount: 1, cancelCount: 0});
	assert.equal(payload.resources.active, 0);
	// W3: the compact-wire shadow flag is an internal key (default off) that the copy reports but the UI never renders.
	assert.deepEqual(copiedRoot.performanceControls.settings, {historicalConcurrency: "auto", historicalSafetyDownshift: true, liveConcurrency: "1", liveStreaming: true, compactWireShadow: "off"});
	assert.equal(copiedRoot.performanceControls.live.capacity, 1);
	assert.equal(typeof copiedRoot.performanceControls.historical.configuredConcurrency, "number");
	assert.equal(copiedRoot.performanceControls.terminalLedger.routeCount, 1);
	assert.equal(copiedRoot.performanceControls.terminalLedger.currentBehaviorMatrix.schemaVersion, 1);
	assert.ok(copiedRoot.performanceControls.terminalLedger.currentBehaviorMatrix.rowCount >= 3);
	assert.deepEqual(copiedRoot.performanceControls.terminalLedger.recent.map(item => [item.lane, item.outcome, item.stage, item.reason]), [["manual", "skipped", "similarity", "too_similar"]]);
	assert.equal(copiedRoot.performanceControls.translationPlanShadow.schemaVersion, 1);
	assert.equal(copiedRoot.performanceControls.translationPlanShadow.desiredIncluded, false);
	assert.doesNotMatch(JSON.stringify(copiedRoot.performanceControls.terminalLedger), /message content|prompt body|endpoint|authorization/i);
	assert.equal(findByClassName(panel, "translator-ai-performance-table").length, 1);
});

test("performance experiment UI persists and immediately applies history live and streaming controls", () => {
	global.document = global.document || {querySelector: () => null, querySelectorAll: () => [], body: {}, documentElement: {}, createElement: () => ({style: {}, setAttribute() {}, appendChild() {}})};
	const plugin = createPluginInstance({callSetLanguages: false, bdfdb});
	try {plugin.onLoad();} catch (error) {}
	plugin.settings = plugin.settings || {};
	for (const section in plugin.defaults || {}) {
		plugin.settings[section] = plugin.settings[section] || {};
		for (const key in plugin.defaults[section]) if (plugin.settings[section][key] === undefined) plugin.settings[section][key] = plugin.defaults[section][key].value;
	}
	plugin.settingsUiState = {activeTab: "advanced"};
	const applied = [];
	const liveQueue = plugin.ensureLiveTranslationQueue();
	const providerClient = plugin.ensureProviderClient();
	plugin.setHistoricalBatchExperimentConcurrency = value => {applied.push(["history", value]); return value === "auto" ? 2 : Number(value);};
	plugin.ensureLiveTranslationQueue = () => Object.assign({}, liveQueue, {setLiveSlotCapacity: value => {applied.push(["live", value]); return Number(value);}});
	plugin.ensureProviderClient = () => Object.assign({}, providerClient, {
		resetLatency: () => applied.push(["reset-latency"]),
		resetOpenAiChatStreamCapabilities: () => applied.push(["reset-stream"])
	});
	let panel = plugin.getSettingsPanel({});
	const history = findByProp(findByProp(panel, "data-performance-setting", "history-concurrency")[0], "options")[0];
	const live = findByProp(findByProp(panel, "data-performance-setting", "live-concurrency")[0], "options")[0];
	const streaming = findByProp(findByProp(panel, "data-performance-setting", "live-streaming")[0], "options")[0];
	const safety = findByProp(findByProp(panel, "data-performance-setting", "history-safety-downshift")[0], "role", "switch")[0];
	assert.deepEqual(history.props.options.map(option => option.value), ["auto", "1", "2", "3", "4"]);
	assert.deepEqual(live.props.options.map(option => option.value), ["1", "2"]);
	assert.deepEqual(streaming.props.options.map(option => option.value), ["on", "off"]);
	assert.equal(safety.props["aria-checked"], true);
	// W3: the compact-wire shadow is flag-only; the performance section renders no control for it.
	assert.deepEqual(findByProp(panel, "data-performance-setting").map(node => node.props["data-performance-setting"]).sort(), ["history-concurrency", "history-runtime", "history-safety-downshift", "live-concurrency", "live-streaming"]);
	assert.doesNotMatch(JSON.stringify(panel), /compactWireShadow|compact-wire-shadow/);
	history.props.onChange("3");
	live.props.onChange("2");
	streaming.props.onChange("off");
	panel = plugin.getSettingsPanel({});
	findByProp(findByProp(panel, "data-performance-setting", "history-safety-downshift")[0], "role", "switch")[0].props.onClick();
	assert.deepEqual(plugin.settings.performance, {historicalConcurrency: "3", historicalSafetyDownshift: false, liveConcurrency: "2", liveStreaming: false, compactWireShadow: "off"});
	assert.deepEqual(applied, [["history", "3"], ["reset-latency"], ["live", "2"], ["reset-latency"], ["reset-stream"], ["reset-latency"], ["history", "3"], ["reset-latency"]]);
	panel = plugin.getSettingsPanel({});
	assert.equal(findByProp(findByProp(panel, "data-performance-setting", "live-concurrency")[0], "options")[0].props.value, "2");
	assert.equal(findByClassName(panel, "translator-performance-card").length, 1);
	assert.equal(findByClassName(panel, "translator-performance-control-grid").length, 1);
});

test("performance UI exposes the pressure limiter and clears cache plus displayed state", async () => {
	global.document = global.document || {querySelector: () => null, querySelectorAll: () => [], body: {}, documentElement: {}, createElement: () => ({style: {}, setAttribute() {}, appendChild() {}})};
	const plugin = createPluginInstance({callSetLanguages: false, bdfdb});
	try {plugin.onLoad();} catch (error) {}
	plugin.settings = plugin.settings || {};
	for (const section in plugin.defaults || {}) {
		plugin.settings[section] = plugin.settings[section] || {};
		for (const key in plugin.defaults[section]) if (plugin.settings[section][key] === undefined) plugin.settings[section][key] = plugin.defaults[section][key].value;
	}
	plugin.settings.performance = {historicalConcurrency: "4", historicalSafetyDownshift: true, liveConcurrency: "1", liveStreaming: true};
	plugin.settingsUiState = {activeTab: "advanced"};
	const calls = [];
	const realClient = plugin.ensureProviderClient();
	plugin.getHistoricalBatchPerformanceSnapshot = () => ({configuredConcurrency: 4, adaptiveMode: false, learnedTier: 4, promotionEvidence: 1, effectiveCap: 1, effectiveReason: "rate_limit", cooldownRemainingMs: 2400, pressureLocked: true, pressureReason: "rate_limit", s8Gate: {sampleCount: 42, ready: false, blockedReason: "insufficient_clean_samples"}, physical: {capacity: 1, active: 0, waiting: 0}});
	plugin.setHistoricalBatchExperimentConcurrency = (value, options) => calls.push(["reset-limit", value, options]);
	plugin.ensureProviderClient = () => Object.assign({}, realClient, {resetLatency: () => calls.push(["reset-latency"]), resetOpenAiChatStreamCapabilities: () => {}});
	plugin.ensureTranslationCacheStore = () => ({getEntryCount: () => 12, clearAll: () => (calls.push(["clear-cache"]), 12), flushPendingSave: () => calls.push(["flush-cache"])});
	plugin.clearAutoTranslationQueue = () => calls.push(["clear-queue"]);
	plugin.clearHistoricalTranslationFailures = () => (calls.push(["clear-failures"]), 2);
	plugin.restoreAllReceivedDisplay = async () => calls.push(["restore-display"]);
	plugin.clearDisplayedTranslations = () => calls.push(["clear-display"]);
	plugin.resetHistoricalPrimarySamples = () => (calls.push(["reset-samples"]), true);
	const panel = plugin.getSettingsPanel({});
	const runtimeState = findByProp(panel, "data-performance-setting", "history-runtime")[0];
	assert.match(JSON.stringify(runtimeState.props), /Active 1|当前生效 1/i);
	assert.doesNotMatch(JSON.stringify(runtimeState.props), /rate_limit|S8|learned|effective/i);
	assert.match(JSON.stringify(runtimeState.props), /provider protection|服务保护中/i);
	assert.equal(findByProp(panel, "data-performance-action", "reset-history-limit").length, 0);
	assert.equal(findByProp(panel, "data-performance-action", "reset-history-samples").length, 0);
	await findByProp(panel, "data-performance-action", "clear-translation-cache")[0].props.onClick();
	assert.deepEqual(calls, [
		["clear-queue"], ["clear-failures"], ["restore-display"], ["clear-display"], ["clear-cache"], ["flush-cache"], ["reset-limit", "4", {resetTrace: true}], ["reset-latency"]
	]);
});

// --- T5: the final thinking surface ---

const modeControl = panel => findByProp(findByProp(panel, "data-provider-main-slot", "thinking")[0], "options")[0];
const strengthControl = panel => {
	const slot = findByProp(panel, "data-provider-main-slot", "strength")[0];
	return slot ? findByProp(slot, "options")[0] : null;
};

test("T5 the thinking mode is three states written straight through, with strength only when on", () => {
	const fixture = createCustomProviderFixture({bdfdbBase: bdfdb});
	const store = fixture.plugin.ensureSettingsStore();
	let panel = fixture.render();
	assert.deepEqual(modeControl(panel).props.options.map(option => option.value), ["follow", "off", "on"], "three states, no derived strategy");
	assert.equal(modeControl(panel).props.value, "off");
	assert.equal(strengthControl(panel), null, "closing thinking needs no strength");

	modeControl(panel).props.onChange("on");
	panel = fixture.render();
	assert.equal(store.getReasoningModelPref("oaicompat", "m").mode, "on", "the mode is written straight through");
	assert.ok(strengthControl(panel), "on is the only mode with a strength row");

	strengthControl(panel).props.onChange("s:high");
	panel = fixture.render();
	assert.equal(store.getReasoningModelPref("oaicompat", "m").onRaw, "high");

	modeControl(panel).props.onChange("follow");
	panel = fixture.render();
	assert.equal(strengthControl(panel), null);
	assert.equal(modeControl(panel).props.value, "follow");

	modeControl(panel).props.onChange("on");
	panel = fixture.render();
	assert.equal(strengthControl(panel).props.value, "s:high", "switching modes keeps the strength that was chosen");
});

test("T5 strength options show the exact upstream value with its own verdict and Custom last", () => {
	const fixture = createCustomProviderFixture({bdfdbBase: bdfdb, auth: {model: "gemini-3-flash", endpoint: "https://relay.test/v1beta/models"}});
	fixture.plugin.ensureSettingsStore().setReasoningModelPref("oaicompat", "gemini-3-flash", {mode: "on", profile: "auto", effort: "medium", onRaw: "medium", rawExplicit: true, controlProfile: {tierStates: {"s:medium": {state: "confirmed", evidence: "confirmed", raw: "medium", checkedAt: 1}, "n:12000": {state: "rejected", evidence: "none", raw: 12000, checkedAt: 2}}}});
	const panel = fixture.render();
	const control = strengthControl(panel);
	assert.deepEqual(control.props.options.map(option => option.label), ["minimal", "low", "medium", "high", "12000", getEnglishText("thinking_strength_custom")], "the label is the upstream value itself, Custom last");
	assert.equal(control.props.value, "s:medium");
	const rendered = JSON.stringify(control.props.options);
	for (const technical of ["thinkingLevel", "generationConfig", "gemini_native", "schemaId"]) assert.equal(rendered.includes(technical), false, technical + " must never reach a menu row");
});

test("T5 the model row carries the only validate action and the thinking area has none", () => {
	const fixture = createCustomProviderFixture({bdfdbBase: bdfdb});
	const panel = fixture.render();
	assert.equal(findByProp(panel, "data-provider-action", "validate-config").length, 1, "one validate action in the whole panel");
	assert.equal(findByProp(panel, "data-provider-action", "detect").length, 0, "the detect button that used to sit in the thinking area is gone");
	assert.equal(findByProp(findByClassName(panel, "translator-model-row")[0], "data-provider-action", "validate-config").length, 1, "and it sits in the model row");
});

test("T5 advanced settings hold nothing but the API type and the speed test", () => {
	const fixture = createCustomProviderFixture({bdfdbBase: bdfdb});
	let panel = fixture.render();
	findByProp(panel, "data-provider-action", "advanced")[0].props.onClick();
	panel = fixture.render();
	assert.deepEqual(findByProp(panel, "data-provider-advanced-field").map(node => node.props["data-provider-advanced-field"]), ["format"], "no protocol row, no compatibility method, no template");
	assert.equal(findByProp(panel, "data-provider-action", "speed").length, 1);

	modeControl(panel).props.onChange("follow");
	panel = fixture.render();
	assert.equal(findByProp(panel, "data-provider-action", "speed").length, 0, "following the provider has nothing to compare, so the whole block goes");
	assert.deepEqual(findByProp(panel, "data-provider-advanced-field").map(node => node.props["data-provider-advanced-field"]), ["format"]);
});

test("T5 the speed test accepts any sendable selection and gates only what cannot be sent", () => {
	// 2026-08-25 report: a relay that reports zero thinking tokens can never
	// confirm an off request, and every tier switch reset the old confirmation,
	// so the test was permanently locked. Sendable selections now measure as sent.
	const fixture = createCustomProviderFixture({bdfdbBase: bdfdb});
	fixture.setReasoning({mode: "on", availability: "supported", support: "accepted", evidence: "none", onRaw: "high", effort: "high", dispatchedRaw: "high"});
	let panel = fixture.render();
	findByProp(panel, "data-provider-action", "advanced")[0].props.onClick();
	panel = fixture.render();
	findByProp(panel, "data-provider-action", "speed")[0].props.onClick();
	panel = fixture.render();
	let speed = findByClassName(findByClassName(panel, "translator-reasoning-benchmark")[0], "translator-btn")[0];
	assert.equal(speed.props.disabled, false, "a sent-but-unconfirmed value measures as sent");
	assert.match(speed.props.title, new RegExp(getEnglishText("benchmark_tip").slice(0, 24)));

	fixture.setReasoning({mode: "off", availability: "supported", support: "pending", evidence: "none", onRaw: "high", effort: "high", dispatchedRaw: "none"});
	panel = fixture.render();
	speed = findByClassName(findByClassName(panel, "translator-reasoning-benchmark")[0], "translator-btn")[0];
	assert.equal(speed.props.disabled, false, "a freshly switched selection needs no re-validation first");

	fixture.setReasoning({mode: "off", availability: "supported", support: "unsupported", evidence: "none", onRaw: "high", effort: "high", dispatchedRaw: "none"});
	panel = fixture.render();
	speed = findByClassName(findByClassName(panel, "translator-reasoning-benchmark")[0], "translator-btn")[0];
	assert.equal(speed.props.disabled, true, "an interface that rejected the field has nothing to measure");
	assert.match(speed.props.title, new RegExp(getEnglishText("benchmark_error_reasoning_unsupported").slice(0, 24)));
});

test("T5 a locally rejected strength disables validation and the speed test and says why", () => {
	const fixture = createCustomProviderFixture({bdfdbBase: bdfdb, auth: {model: "claude-opus-5", endpoint: "https://relay.test/v1/messages"}});
	fixture.setReasoning({mode: "on", availability: "unsupported", support: "pending", evidence: "none", onRaw: "minimal", effort: "minimal", dispatchedRaw: "minimal"});
	let panel = fixture.render();
	const status = findByClassName(panel, "translator-provider-main-status")[0];
	assert.equal(status.props["data-status-state"], "invalid-strength", "the state is named on a stable seam");
	assert.equal(JSON.stringify(status.props.children).includes("minimal"), true, "the sentence names the value that is refused");
	const validate = findByProp(panel, "data-provider-action", "validate-config")[0];
	assert.equal(validate.props.disabled, true, "there is nothing to ask the endpoint");
	assert.equal(validate.props["aria-describedby"], status.props.id, "the button points at the sentence that explains it");

	findByProp(panel, "data-provider-action", "advanced")[0].props.onClick();
	panel = fixture.render();
	const speed = findByProp(panel, "data-provider-action", "speed")[0];
	assert.equal(speed.props.disabled, true, "measuring a value that cannot be sent would only burn requests");
	assert.equal(findByProp(panel, "data-provider-action", "revalidate").length, 0, "a local verdict has no re-validation to offer");
	assert.equal(findByProp(panel, "data-provider-action", "diagnostics").length, 0);
});

test("T5 an interface rejection prints its diagnostics line and a failed effect retries through the one validate action", () => {
	const fixture = createCustomProviderFixture({bdfdbBase: bdfdb});
	fixture.setReasoning({mode: "on", availability: "supported", support: "unsupported", evidence: "none", onRaw: "high", effort: "high", dispatchedRaw: "high"});
	let panel = fixture.render();
	assert.equal(findByProp(panel, "data-provider-diagnostics", "reasoning").length, 1, "the endpoint refused it, so the reason prints right under the sentence");
	assert.equal(findByProp(panel, "data-provider-action", "diagnostics").length, 0, "the detail line needs no disclosure button");
	assert.equal(findByProp(panel, "data-provider-action", "revalidate").length, 0, "the retry always lives in the one validate action, never a second button");
	assert.equal(findByProp(panel, "data-provider-action", "validate-config")[0].props.disabled, false, "the endpoint can still be asked again after a change");

	// a setting that was accepted but never took effect retries with another known
	// spelling through the same validate button instead of growing a duplicate action
	fixture.setReasoning({mode: "on", availability: "supported", support: "accepted", evidence: "contradicted", onRaw: "high", effort: "high", dispatchedRaw: "high"});
	panel = fixture.render();
	assert.equal(findByProp(panel, "data-provider-action", "revalidate").length, 0);
	assert.equal(findByProp(panel, "data-provider-diagnostics", "reasoning").length, 0, "a contradiction is explained on the validate button, not by a technical detail line");
	const validate = findByProp(panel, "data-provider-action", "validate-config")[0];
	assert.match(validate.props.title, new RegExp(getEnglishText("thinking_not_applied_tip").slice(0, 24)), "the button explains the clear contradiction and equivalent retry");
	assert.match(read("src/ui/settings-panel.js"), /statusState === "ignored" \? \{rewrite: true\}/, "the respelling retry rides the validate action");
});

test("T5 the retired manual editor leaves no orphan copy behind", () => {
	const source = read("src/i18n/text.js");
	for (const retired of ["thinking_setting_auto", "thinking_setting_manual", "thinking_setting_upstream", "compat_method", "manual_setting_draft_status", "manual_setting_draft_tip", "manual_setting_detect_hint", "thinking_setting_label", "thinking_setting_tip", "thinking_effort", "reasoning_profile_", "model_detect_button", "custom_status_setting_not_applied", "thinking_action_revalidate", "thinking_action_diagnostics", "thinking_migration_label_note", "benchmark_need_off", "benchmark_need_validation", "benchmark_error_reasoning_unconfirmed", "benchmark_baseline", "benchmark_optimized_", "benchmark_controlled_"]) {
		assert.equal(source.includes(retired), false, retired + " is no longer reachable, so its copy must be gone");
	}
	const panelSource = read("src/ui/settings-panel.js");
	for (const retired of ["manualIntent", "shouldShowReasoningProfile", "getManualReasoningProfiles", "getManualStrengthValues", "deriveThinkingStrategy", "applyThinkingStrategy", "applyManualStrength"]) {
		assert.equal(panelSource.includes(retired), false, retired + " is retired");
	}
	// the visible changes are not just written, they are shown where they happen
	const panelText = read("src/ui/settings-panel.js");
	for (const key of ["thinking_migration_rejected_note", "thinking_migration_invalid_note"]) {
		assert.match(panelText, new RegExp(key), key + " must be rendered somewhere, not left as orphan copy");
		for (const locale of [[true, false], [false, false], [false, true]]) assert.ok(getCustomTextValue(key, locale[0], locale[1]).length > 8, key);
	}
});

test("T5 legacy capability read-through does not reset the thinking UI to pending after upgrade", () => {
	const capability = {support: "accepted", candidateId: "openai_none", resolvedValue: "none", evidence: "confirmed", endpointKey: "https://host.test/v1/chat/completions", format: "openai_chat", checkedAt: 5};
	const fixture = createCustomProviderFixture({bdfdbBase: bdfdb, auth: {reasoningModels: {m: {mode: "off", profile: "auto", effort: "low", capability}}}});
	const panel = fixture.render();
	const status = findByClassName(panel, "translator-provider-main-status")[0];
	assert.equal(status.props["data-status-state"], "confirmed", "the earned verdict is the state the seam reports");
	assert.equal(findByClassName(status, "translator-status-main")[0].props.children, getEnglishText("custom_status_thinking_off_confirmed").replace("{raw}", "none"), "an upgrade keeps the verdict it already earned, and names the value it confirmed");
	assert.equal(findByProp(panel, "data-provider-action", "validate-config")[0].props.className.includes("translator-btn-primary"), false, "nothing is asking to be validated again");
});

test("T5 a short option list drops the search box in the rendered popout", () => {
	const fixture = createCustomProviderFixture({bdfdbBase: bdfdb});
	const panel = fixture.render();
	// the panel passes the threshold, and the component genuinely honours it: the two
	// facts are asserted together so neither can go stale alone
	assert.equal(modeControl(panel).props.searchThreshold, 8);
	const {createSearchableSelectComponent} = require("../src/ui/searchable-select");
	class Component {
		constructor(props) {this.props = props; this.state = {};}
		setState(update) {this.state = Object.assign({}, this.state, update);}
	}
	const Select = createSearchableSelectComponent({Component}, (type, props) => ({type, props: props || {}}));
	const instance = new Select(Object.assign({}, modeControl(panel).props, {onChange: () => {}}));
	instance.state = {open: true, query: "", activeIndex: 0, favoriteValues: []};
	const walk = (node, out = []) => {
		if (!node) return out;
		if (Array.isArray(node)) {node.forEach(child => walk(child, out)); return out;}
		if (typeof node != "object") return out;
		out.push(node);
		walk(node.props && node.props.children, out);
		return out;
	};
	assert.equal(walk(instance.render()).filter(node => node.type == "input").length, 0, "three modes render no search field");
});

test("T5 a choice is saved when it is made and a no-op writes nothing", () => {
	const fixture = createCustomProviderFixture({bdfdbBase: bdfdb});
	const {plugin, spies} = fixture;
	const store = plugin.ensureSettingsStore();
	let panel = fixture.render();

	// reselecting the mode already in force touches nothing at all
	fixture.resetSaves();
	modeControl(panel).props.onChange("off");
	assert.equal(spies.preferenceWrites, 0, "the same value is a no-op");
	assert.equal(spies.benchmarkCancels, 0);
	assert.equal(spies.saves, 0, "no settings payload is written for a no-op");
	assert.equal(store.getReasoningModelPref("oaicompat", "m"), null, "a no-op never materialises a per-model record");
	assert.equal(findByProp(panel, "data-provider-action", "validate-config")[0].props.disabled, false, "the value on screen stays testable");

	// a real change is persisted immediately, with no draft state in between
	modeControl(panel).props.onChange("on");
	assert.equal(spies.preferenceWrites, 1);
	panel = fixture.render();
	assert.equal(store.getReasoningModelPref("oaicompat", "m").mode, "on");
	assert.ok(strengthControl(panel), "and the strength it unlocks is on screen right away");
	assert.equal(findByProp(panel, "data-provider-action", "validate-config")[0].props.disabled, false);
});

test("T5 the thinking surface keeps the frozen type scale", () => {
	const css = read("src/ui/styles.js");
	assert.match(css, /\.translator-field-label \{[\s\S]{0,220}font-size: 16px;/, "section field labels stay at 16");
	assert.match(css, /\.translator-provider-main-slot \.translator-row-label,[\s\S]{0,160}font-size: 14px;\}/, "the provider rows use 14");
	assert.match(css, /\.translator-tier-raw \{[^}]*font-size: 13px;/, "the upstream value reads at control size");
	assert.match(css, /\.translator-tier-sub \{[^}]*font-size: 12px;/, "its verdict is a side note");
	assert.match(css, /\.translator-row-note \{[^}]*font-size: 12px;/);
	assert.match(css, /\.translator-provider-diagnostics \{[^}]*font-size: 12px;/);
});

test("T5 each upgrade note reaches the control whose behaviour changed", () => {
	const fixture = createCustomProviderFixture({bdfdbBase: bdfdb, auth: {model: "claude-opus-5", endpoint: "https://relay.test/v1/messages"}});
	fixture.setReasoning({mode: "on", availability: "unsupported", support: "pending", evidence: "none", onRaw: "minimal", effort: "minimal", dispatchedRaw: "minimal"});
	let panel = fixture.render();
	assert.match(findByProp(panel, "data-provider-action", "validate-config")[0].props.title, new RegExp(getEnglishText("thinking_migration_invalid_note").slice(0, 24)), "the disabled button explains why it is disabled");

	// and the refusal note rides the diagnostics line that explains the refusal
	fixture.setReasoning({mode: "on", availability: "supported", support: "unsupported", evidence: "none", onRaw: "high", effort: "high", dispatchedRaw: "high"});
	panel = fixture.render();
	const diagnostics = findByProp(panel, "data-provider-diagnostics", "reasoning")[0];
	assert.match(diagnostics.props.title, new RegExp(getEnglishText("thinking_migration_rejected_note").slice(0, 24)), "the note explains the new behaviour on the line that shows it");
	// the printed line stays one plain sentence with a pointer, never a raw payload
	const revealed = diagnostics.props.children;
	assert.match(revealed, /Diagnostics page/, "it points at the full answer without inventing a status code");
	assert.equal(revealed.indexOf(String.fromCharCode(10)), -1, "one line, not a payload dump");
	assert.doesNotMatch(revealed, /reasoning_effort|enable_thinking|budget_tokens|thinkingConfig|generationConfig|output_config|[{}]/, "a plain sentence names no wire field and dumps no payload");
});

test("T5 the custom strength applies explicitly and says why it cannot", () => {
	const fixture = createCustomProviderFixture({bdfdbBase: bdfdb, auth: {model: "gemini-2.5-flash", endpoint: "https://relay.test/v1beta/models"}});
	const store = fixture.plugin.ensureSettingsStore();
	store.setReasoningModelPref("oaicompat", "gemini-2.5-flash", {mode: "on", profile: "auto", effort: "low", onRaw: -1, rawExplicit: true});
	let panel = fixture.render();
	strengthControl(panel).props.onChange("custom");
	panel = fixture.render();
	const customField = () => findByProp(panel, "data-thinking-field", "custom")[0];
	const input = () => findByProp(customField(), "data-raw-value", "custom-input")[0];
	const apply = () => findByProp(customField(), "data-status-action", "apply-custom")[0];
	assert.ok(input(), "choosing Custom opens the entry row");
	assert.equal(apply().props.disabled, true, "an empty draft cannot be applied");

	// an out-of-range number explains itself instead of going quiet
	input().props.onChange({target: {value: "99999"}});
	panel = fixture.render();
	assert.equal(apply().props.disabled, true);
	assert.equal(input().props["aria-invalid"], true);
	const error = findByProp(customField(), "role", "alert")[0];
	assert.ok(error, "the reason is said out loud");
	assert.equal(input().props["aria-describedby"], error.props.id, "and the field points at it");
	const writesBefore = fixture.spies.preferenceWrites;
	apply().props.onClick();
	assert.equal(fixture.spies.preferenceWrites, writesBefore, "an invalid draft never writes");

	// a valid number applies on click and lands as the exact typed raw
	input().props.onChange({target: {value: "12000"}});
	panel = fixture.render();
	assert.equal(apply().props.disabled, false);
	apply().props.onClick();
	assert.equal(store.getReasoningModelPref("oaicompat", "gemini-2.5-flash").onRaw, 12000, "the exact number is what got written");
	panel = fixture.render();
	assert.equal(findByProp(panel, "data-thinking-field", "custom").length, 0, "the entry row closes after a successful apply");

	// Enter is the keyboard form of the same explicit apply
	strengthControl(panel).props.onChange("custom");
	panel = fixture.render();
	input().props.onChange({target: {value: "4096"}});
	input().props.onKeyDown({key: "Enter", preventDefault: () => {}});
	assert.equal(store.getReasoningModelPref("oaicompat", "gemini-2.5-flash").onRaw, 4096);
});

test("T5 every frozen seam is present on the rendered surface", () => {
	const fixture = createCustomProviderFixture({bdfdbBase: bdfdb});
	fixture.plugin.ensureSettingsStore().setReasoningModelPref("oaicompat", "m", {mode: "on", profile: "auto", effort: "high", onRaw: "high", rawExplicit: true});
	let panel = fixture.render();
	findByProp(panel, "data-provider-action", "advanced")[0].props.onClick();
	panel = fixture.render();
	assert.equal(findByProp(panel, "data-thinking-group").length, 1, "the model and thinking rows form one group");
	const group = findByProp(panel, "data-thinking-group")[0];
	assert.deepEqual(findByProp(group, "data-provider-main-slot").map(node => node.props["data-provider-main-slot"]), ["model", "thinking", "strength", "status-actions"], "the group holds exactly those four slots");
	assert.equal(findByProp(group, "data-provider-action", "fetch-models").length, 1);
	assert.equal(findByProp(group, "data-provider-action", "validate-config").length, 1);
	assert.equal(findByProp(group, "data-thinking-field", "mode").length, 1);
	assert.equal(findByProp(group, "data-thinking-field", "strength").length, 1);
	assert.equal(findByProp(group, "data-status-state").length, 1);
	assert.equal(findByClassName(group, "translator-status-main").length, 1);
	assert.equal(findByProp(group, "data-raw-value").length >= 1, true, "the dispatched raw is machine-readable");
	assert.equal(findByProp(panel, "data-provider-select", "api-type").length, 1);
	assert.equal(findByProp(panel, "data-speed-state").length, 1);
	assert.equal(findByClassName(group, "translator-provider-advanced-body").length, 1, "the advanced disclosure opens inside the same group card");
});

test("T5 the group, narrow rules and verdict colours are pinned in the stylesheet", () => {
	const css = read("src/ui/styles.js");
	assert.match(css, /\.translator-thinking-group \{[^}]*border: 1px solid var\(--translator-border\)/, "the group reads as one container");
	assert.match(css, /\.translator-provider-detail \{container-type: inline-size;\}/, "the detail pane is the width reference, not the viewport");
	assert.match(css, /@container \(max-width: 430px\) \{[\s\S]{0,400}\.translator-model-row \{flex-wrap: wrap;\}/, "the model row folds by its real container");
	assert.match(css, /\.translator-model-row \.translator-model-combo \{flex: 1 1 100%; min-width: 150px;\}/, "the input keeps the first line");
	assert.match(css, /\.translator-model-row \.translator-provider-validate \{flex: 1 1 auto; min-width: 80px;\}/, "verify stays fully visible");
	// 07-4: the verdict column carries semantic colour without a chip background
	assert.match(css, /\.translator-tier-sub\.is-confirmed \{color: var\(--translator-ok\); font-weight: 600;\}/);
	assert.match(css, /\.translator-tier-sub\.is-rejected \{color: var\(--translator-danger\); font-weight: 600;\}/);
	assert.match(css, /\.translator-tier-sub\.is-invalid \{color: var\(--translator-text-muted\); font-weight: 600;\}/);
	assert.doesNotMatch(css, /\.translator-tier-sub[^}]*background/, "coloured text, never a chip");
	// 07-4: the mode note breathes at 6px/18px
	assert.match(css, /\.translator-row-note \{[^}]*margin-top: 6px;[^}]*line-height: 18px;/);
	// 07-4: the note wraps to its own full-width line instead of crushing the label
	assert.match(css, /\.translator-thinking-group \.translator-row \{flex-wrap: wrap;\}/);
	// 07-4: rows breathe at the artboard rhythm instead of the 6-8px cramming red-circled in the audit
	assert.match(css, /\.translator-provider-main-slot\[data-provider-main-slot="thinking"\] > \.translator-row \{margin-top: 10px;\}/);
	assert.match(css, /\.translator-tier-custom-control \.translator-input \{flex: 1 1 150px; min-width: 150px;\}/, "the custom input never collapses below 150px");
});

test("T5 the diagnostics line is one sentence that clears when the situation changes", () => {
	const fixture = createCustomProviderFixture({bdfdbBase: bdfdb});
	fixture.setReasoning({mode: "on", availability: "supported", support: "unsupported", evidence: "none", onRaw: "high", effort: "high", dispatchedRaw: "high"});
	let panel = fixture.render();
	assert.equal(findByProp(panel, "data-provider-diagnostics", "reasoning").length, 1, "the refusal explains itself without a disclosure click");
	// changing the setting closes the stale explanation
	modeControl(panel).props.onChange("off");
	fixture.setReasoning(null);
	panel = fixture.render();
	assert.equal(findByProp(panel, "data-provider-diagnostics", "reasoning").length, 0, "a changed setting clears the old answer");
});

test("T5 the group header, the mode label and the pinned action wording are rendered", () => {
	const fixture = createCustomProviderFixture({bdfdbBase: bdfdb});
	const panel = fixture.render();
	const group = findByProp(panel, "data-thinking-group")[0];
	assert.equal(findByClassName(group, "translator-thinking-group-title")[0].props.children, getEnglishText("thinking_group_title"), "the group announces what it holds");
	assert.equal(getEnglishText("thinking_group_title"), "Model and reasoning");
	assert.match(JSON.stringify(findByProp(group, "data-thinking-field", "mode")[0].props), new RegExp(getEnglishText("thinking_mode_label")), "the mode row wears the frozen label");
	assert.equal(getEnglishText("thinking_mode_label"), "Reasoning mode");
	assert.equal(getEnglishText("validate_config"), "Validate configuration");
	assert.equal(getCustomTextValue("validate_config", false, true), "Проверить конфигурацию");
	const css = read("src/ui/styles.js");
	assert.match(css, /\.translator-thinking-group-title \{font-size: 14px; font-weight: 700;[^}]*var\(--translator-text-muted\)/, "the header reads as a muted group header, one tier under the field labels, the way the artboard draws it");
});

test("T5 the safe title carries the exact raw and never a wire spelling", () => {
	const view = createCustomProviderStatusView({
		validation: {ok: true, durationMs: 900},
		interfaceStatus: {resolved: "gemini_native"},
		reasoningState: {mode: "off", support: "reduced", resolvedValue: "budget=128", dispatchedRaw: "128", evidence: "none"}
	}, getEnglishText, id => id);
	assert.match(view.title, /128/, "the title names the accepted value");
	assert.doesNotMatch(view.title, /budget=|think=|adaptive=|level=/, "wire spellings stay out of the ordinary surface");
	assert.doesNotMatch(view.text, /budget=|think=|adaptive=|level=/);
});

test("T5 a changed custom error message repaints on its own", () => {
	let refreshes = 0;
	const countingBdfdb = Object.assign({}, bdfdb, {PluginUtils: Object.assign({}, bdfdb.PluginUtils, {refreshSettingsPanel: () => {refreshes++;}})});
	const fixture = createCustomProviderFixture({bdfdbBase: countingBdfdb, auth: {model: "gemini-2.5-flash", endpoint: "https://relay.test/v1beta/models"}});
	fixture.plugin.ensureSettingsStore().setReasoningModelPref("oaicompat", "gemini-2.5-flash", {mode: "on", profile: "auto", effort: "low", onRaw: -1, rawExplicit: true});
	let panel = fixture.render();
	strengthControl(panel).props.onChange("custom");
	panel = fixture.render();
	const input = () => findByProp(panel, "data-raw-value", "custom-input")[0];
	input().props.onChange({target: {value: ""}});
	const afterEmpty = refreshes;
	// empty and out-of-range are both errors: the message change alone must repaint
	input().props.onChange({target: {value: "99999"}});
	assert.equal(refreshes, afterEmpty + 1, "the production path repaints without the test rendering for it");
	panel = fixture.render();
	const error = findByProp(findByProp(panel, "data-thinking-field", "custom")[0], "role", "alert")[0];
	assert.match(error.props.children, /between|之间|от/i, "and the message now names the range, not the empty field");
});

test("T5 the capability badge names the control shape in one redacted phrase", () => {
	// no verdict yet: the badge says so instead of guessing
	const pending = createCustomProviderFixture({bdfdbBase: bdfdb});
	let panel = pending.render();
	const badge = () => findByProp(panel, "data-capability-badge")[0];
	assert.equal(badge().props["data-capability-badge"], "pending");
	assert.equal(badge().props.children, getEnglishText("capability_badge_pending"));

	// a boolean control reads as a switch once something is known about it
	const ollama = createCustomProviderFixture({bdfdbBase: bdfdb, auth: {model: "qwen3:8b", endpoint: "http://localhost:11434/api/chat"}});
	ollama.plugin.ensureSettingsStore().setReasoningModelPref("oaicompat", "qwen3:8b", {mode: "on", profile: "auto", effort: "low", onRaw: true, rawExplicit: true, controlProfile: {tierStates: {"b:true": {state: "confirmed", evidence: "confirmed", raw: true, checkedAt: 1}}}});
	panel = ollama.render();
	assert.equal(badge().props["data-capability-badge"], "switch");

	// a word ladder counts its levels, even while following the provider
	const gemini = createCustomProviderFixture({bdfdbBase: bdfdb, auth: {model: "gemini-3-flash", endpoint: "https://relay.test/v1beta/models"}});
	gemini.plugin.ensureSettingsStore().setReasoningModelPref("oaicompat", "gemini-3-flash", {mode: "follow", profile: "auto", effort: "low", controlProfile: {tierStates: {"s:medium": {state: "confirmed", evidence: "confirmed", raw: "medium", checkedAt: 1}}}});
	panel = gemini.render();
	assert.equal(badge().props["data-capability-badge"], "tiers");
	assert.equal(badge().props.children, getEnglishText("capability_badge_tiers").replace("{n}", "4"), "the count is the model's own ladder");

	// a numeric-only control is a budget
	const budget = createCustomProviderFixture({bdfdbBase: bdfdb, auth: {model: "gemini-2.5-flash", endpoint: "https://relay.test/v1beta/models"}});
	budget.plugin.ensureSettingsStore().setReasoningModelPref("oaicompat", "gemini-2.5-flash", {mode: "on", profile: "auto", effort: "low", onRaw: -1, rawExplicit: true, controlProfile: {tierStates: {"n:-1": {state: "confirmed", evidence: "confirmed", raw: -1, checkedAt: 1}}}});
	panel = budget.render();
	assert.equal(badge().props["data-capability-badge"], "budget");

	// redacted by contract: no field path, schema or wire spelling in text or title
	for (const fixture of [pending, ollama, gemini, budget]) {
		panel = fixture.render();
		const rendered = JSON.stringify(badge().props);
		for (const technical of ["reasoning_effort", "budget_tokens", "thinkingConfig", "generationConfig", "schemaId", "candidateId", "think="]) {
			assert.equal(rendered.includes(technical), false, technical);
		}
	}
});

test("advanced performance controls explain bounded recovery and separate the cache card", () => {
	const fixture = createCustomProviderFixture({bdfdbBase: bdfdb, auth: {model: "gemini-2.5-flash"}});
	fixture.plugin.settingsUiState.activeTab = "advanced";
	const panel = fixture.render();
	const safety = findByProp(panel, "data-performance-setting", "history-safety-downshift")[0];
	const safetyTip = findByProp(safety, "text")[0].props.text;
	assert.match(safetyTip, /recover/i, "errors impose bounded recovery, not a lock for the entire launch");
	assert.doesNotMatch(safetyTip, /for this launch|session-level|锁到|本次启动/);
	assert.match(safetyTip, /backoff.*live priority/i);
	assert.equal(findByClassName(panel, "translator-cache-card").length, 1);
	assert.equal(findByClassName(findByClassName(panel, "translator-performance-card")[0], "translator-cache-card").length, 0);
	const cache = findByProp(panel, "data-performance-action", "clear-translation-cache")[0];
	assert.match(cache.props.title, /retranslation.*billed/i, "clearing cache warns about later paid retranslation");
	assert.equal(findByProp(panel, "data-performance-action", "reset-history-limit").length, 0);
	assert.equal(findByProp(panel, "data-performance-action", "reset-history-samples").length, 0);
});
test("custom Gemini reasoning comparison explains its paid synthetic scope rather than claiming translation-pipeline speed", () => {
	const fixture = createCustomProviderFixture({bdfdbBase: bdfdb, auth: {model: "gemini-2.5-flash"}});
	let panel = fixture.render();
	findByProp(panel, "data-provider-action", "advanced")[0].props.onClick();
	panel = fixture.render();
	findByProp(panel, "data-provider-action", "speed")[0].props.onClick();
	panel = fixture.render();
	const benchmark = findByClassName(panel, "translator-reasoning-benchmark");
	assert.equal(benchmark.length, 1, "the current provider reasoning comparison remains available");
	const description = findByClassName(benchmark[0], "translator-benchmark-desc")[0].props.children;
	assert.match(description, /12 real billed requests/);
	assert.match(description, /not.*end-to-end/i, "provider reasoning comparison is not the new translation rule performance gate");
	assert.match(description, /Diagnostics page/i, "actual message latency has one daily observation entry");
	assert.equal(findByProp(panel, "data-w2-action").length, 0);
});
