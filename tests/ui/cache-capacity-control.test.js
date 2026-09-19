const test = require("node:test");
const assert = require("node:assert/strict");
const {createPluginInstance} = require("../helpers/createPluginInstance");
const {renderSettingsPanel} = require("../../src/ui/settings-panel");

function find(node, predicate) {
	if (!node) return [];
	if (Array.isArray(node)) return node.flatMap(child => find(child, predicate));
	if (typeof node !== "object") return [];
	return [...(predicate(node) ? [node] : []), ...find(node.props?.children, predicate)];
}

test("cache settings save a validated capacity, preserve newest entries and offer only the clear action", () => {
	const disk = {}, requests = [];
	const plugin = createPluginInstance({callSetLanguages: false, bdfdb: {
		PluginUtils: {createSettingsPanel: (_plugin, config) => config.children(), refreshSettingsPanel() {}},
		DataUtils: {load: (_plugin, key) => disk[key] || {}, save(value, _plugin, key, field) {if (field) (disk[key] ||= {})[field] = value; else disk[key] = JSON.parse(JSON.stringify(value));}},
		TimeUtils: {timeout: () => null, clear() {}},
		PatchUtils: {forceAllUpdates() {}},
		MessageUtils: {rerenderAll() {}}
	}});
	try {plugin.onLoad();} catch {}
	for (const [section, fields] of Object.entries(plugin.defaults)) {
		plugin.settings[section] ||= {};
		for (const [key, field] of Object.entries(fields)) if (plugin.settings[section][key] === undefined) plugin.settings[section][key] = field.value;
	}
	plugin.settingsUiState = {activeTab: "advanced"};
	global.document ||= {getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], body: {}, documentElement: {}, createElement: () => ({style: {}})};
	global.requestAnimationFrame ||= fn => fn();
	global.BdApi = {React: {Component: class {}}, UI: {}, Net: {fetch: (...args) => requests.push(args)}};
	const render = () => renderSettingsPanel(plugin, {}, {BDFDB: plugin._testBdfdb});
	let panel = render();
	const input = find(panel, node => node.props?.["data-cache-setting"] === "capacity")[0];
	assert.ok(input, "Advanced exposes a cache capacity input");
	assert.equal(input.props.defaultValue, 500);
	const help = find(panel, node => node.type === "button" && String(node.props?.className).split(/\s+/).includes("translator-info-tip"));
	assert.ok(help.some(node => /Default 500|默认 500/.test(node.props["aria-label"])), "capacity rules remain available through a help button");
	assert.ok(help.some(node => /provider charges|服务费用/.test(node.props["aria-label"])), "clear-cache consequences remain available through a help button");
	// Complete first-open prompt migration before measuring a capacity-only edit.
	plugin.onSettingsClosed();
	const store = plugin.ensureTranslationCacheStore();
	const queue = plugin.ensureLiveTranslationQueue();
	queue.setBusyTranslating(true);
	queue.enqueueLiveItem({message: {id: "queued-synthetic", content: "fixture"}, channelId: "fixture-channel"});
	assert.equal(queue.getQueueLength(), 1, "fixture waits behind an active translation");
	for (let i = 0; i < 150; i++) store.persistTranslation(`paid-${i}`, "sig", {translatedContent: `result-${i}`});
	input.props.onBlur({currentTarget: {value: "100"}});
	assert.equal(plugin.settings.general.translationCacheLimit, 100);
	assert.equal(disk.general.translationCacheLimit, 100);
	assert.equal(store.getEntryCount(), 100);
	assert.equal(store.hasEntry("paid-0"), false);
	assert.equal(store.hasEntry("paid-149"), true);
	for (const value of ["", "99", "10001", "500.5", "invalid"]) {
		input.props.onBlur({currentTarget: {value}});
		assert.equal(disk.general.translationCacheLimit, 100, "invalid input must not evict or overwrite the setting");
	}
	input.props.onBlur({currentTarget: {value: "1000"}});
	assert.equal(store.getCapacity(), 1000);
	assert.equal(store.getEntryCount(), 100);
	panel = render();
	assert.equal(find(panel, node => node.props?.["data-cache-setting"] === "capacity")[0].props.defaultValue, 1000);
	assert.deepEqual(find(panel, node => node.props?.["data-performance-action"]).map(node => node.props["data-performance-action"]), ["clear-translation-cache"]);
	assert.deepEqual(requests, [], "capacity changes do not contact a provider");
	plugin.onSettingsClosed();
	assert.equal(queue.getQueueLength(), 1, "closing after a capacity edit preserves queued translation work");
	store.cancelPendingSave();
});
