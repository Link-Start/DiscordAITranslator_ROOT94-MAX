const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {getCustomTextValue} = require("../../src/i18n/text");
const {resolveDetectLanguageLabel} = require("../../src/i18n/labels");
const {createPluginInstance} = require("../helpers/createPluginInstance");

const root = path.resolve(__dirname, "..", "..");

function listJavaScriptFiles(directory) {
	const files = [];
	for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
		const entryPath = path.join(directory, entry.name);
		if (entry.isDirectory()) files.push(...listJavaScriptFiles(entryPath));
		else if (entry.isFile() && entry.name.endsWith(".js")) files.push(entryPath);
	}
	return files;
}

function getLiteralCustomTextKeys() {
	const keys = new Set();
	for (const file of listJavaScriptFiles(path.join(root, "src"))) {
		const source = fs.readFileSync(file, "utf8");
		for (const match of source.matchAll(/getCustomText\(\s*["']([^"']+)["']\s*\)/g)) keys.add(match[1]);
	}
	return [...keys].sort();
}

test("detect-language prompt label resolves in every supported interface language", () => {
	assert.equal(getCustomTextValue("detect_language_label", true, false), "检测语言");
	assert.equal(getCustomTextValue("detect_language_label", false, false), "Detect Language");
	assert.equal(getCustomTextValue("detect_language_label", false, true), "Определить язык");
});

test("every literal getCustomText key resolves in Chinese English and Russian", () => {
	const missing = [];
	for (const key of getLiteralCustomTextKeys()) {
		for (const [language, value] of [
			["zh", getCustomTextValue(key, true, false)],
			["en", getCustomTextValue(key, false, false)],
			["ru", getCustomTextValue(key, false, true)]
		]) if (value === key) missing.push(`${language}:${key}`);
	}
	assert.deepEqual(missing, []);
});

test("auto input prompt name is localized without changing the received cache signature", () => {
	const plugin = createPluginInstance({settings: {general: {interfaceLanguage: "en"}}});
	const sourceData = {content: "hello", embeds: []};
	const message = {id: "localized-auto-input", channel_id: "channel-localized-auto", content: sourceData.content, embeds: []};
	const englishSignature = plugin.createReceivedTranslationSignature(message, "channel-localized-auto", sourceData);
	assert.equal(plugin.getLanguagePromptName({id: "auto", auto: true}), "Detect Language");

	plugin.settings.general.interfaceLanguage = "zh-CN";
	assert.equal(plugin.getLanguagePromptName({id: "auto", auto: true}), "检测语言");
	assert.equal(plugin.createReceivedTranslationSignature(message, "channel-localized-auto", sourceData), englishSignature);
	assert.doesNotMatch(plugin.getAiAutoTranslatePrompt({input: {id: "auto", auto: true}, output: {id: "en", name: "English"}}), /detect_language_label/);
});

test("the auto entry's display name follows the plugin interface language without rebuilding the language table", () => {
	// Field report: Discord in Chinese, plugin language switched to English in General;
	// every dropdown read English except the pinned first entry, which still said 检测语言.
	const plugin = createPluginInstance({settings: {general: {interfaceLanguage: "zh-CN"}}, labels: {detect_language: "检测语言"}});
	assert.equal(plugin.ensureSettingsStore().getLanguage("auto").name, "检测语言");
	assert.equal(plugin.getLanguageDisplayName("auto"), "检测语言");

	plugin.settings.general.interfaceLanguage = "en";
	assert.equal(plugin.getLanguageDisplayName("auto"), "Detect Language", "neither the stale labels nor the baked table name may reach the dropdown");
	assert.equal(plugin.getLanguageDisplayName({id: "auto", auto: true}), "Detect Language");
	assert.equal(plugin.getLanguageDisplayName("en"), "English", "other entries keep their names");

	for (const [uiLanguageId, expected] of [["de", "Sprache erkennen"], ["ru", "Определить язык"], ["zh-TW", "檢測語言"], ["ja", "言語を検出"], ["zh-CN", "检测语言"]]) {
		plugin.settings.general.interfaceLanguage = uiLanguageId;
		assert.equal(plugin.getLanguageDisplayName("auto"), expected, uiLanguageId);
		plugin.setLanguages();
		assert.equal(plugin.ensureSettingsStore().getLanguage("auto").name, expected, `${uiLanguageId}: the rebuilt table carries the same name`);
	}
});

test("resolveDetectLanguageLabel prefers the interface language table, then the loaded labels, then English", () => {
	assert.equal(resolveDetectLanguageLabel("de", {detect_language: "stale"}), "Sprache erkennen");
	assert.equal(resolveDetectLanguageLabel("xx", {detect_language: "stale"}), "Detect Language", "unknown ids fall through to the English table");
	assert.equal(resolveDetectLanguageLabel(null, {detect_language: "loaded"}), "loaded");
	assert.equal(resolveDetectLanguageLabel(null, null), "Detect Language");
});
