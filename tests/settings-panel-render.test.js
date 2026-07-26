const test = require("node:test");
const assert = require("node:assert/strict");
const {createPluginInstance} = require("./helpers/createPluginInstance");

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
});
