// The settings panel is hosted by BetterDiscord's addon settings modal
// (Modals.showAddonSettingsModal): BetterDiscord renders the frame, hard-codes the
// header "<name> Settings" and labels the single footer button with its own
// "Modals.done" string in Discord's language. The plugin cannot pass a label in, so
// the title follows the effective plugin language once the panel sits in the modal.
// The footer is relabelled only for a pinned language; with "follow Discord" its
// original host label is restored. No other addon or panel content is changed.

// BetterDiscord's own translations of Modals.done (betterdiscord.asar, 2026-09). Only a
// button that currently shows one of these (or one of ours) is ever touched.
const HOST_DONE_LABELS = new Set(["Done", "完成", "Готово", "Fertig", "Terminé", "Hecho", "Feito", "Fatto", "Dokončiť", "Hotovo", "Kész", "Gata", "Bitti", "Valmis", "Xong", "Ολοκληρώθηκε", "완료", "Potwierdź"]);
const PLUGIN_DONE_LABELS = Object.freeze({"zh-CN": "完成", "zh-TW": "完成", zh: "完成", en: "Done", ru: "Готово"});
const PLUGIN_SETTINGS_TITLES = Object.freeze({zh: "DiscordAITranslator 设置", en: "DiscordAITranslator Settings", ru: "DiscordAITranslator — Настройки"});
const HOST_MODAL_CLASS = "bd-addon-modal";
// Caption node -> the label BetterDiscord rendered before the first relabel.
const originalLabels = new WeakMap();

function getSettingsDoneLabel(uiLanguageId) {
	return PLUGIN_DONE_LABELS[String(uiLanguageId || "")] || null;
}

function hasClass(node, className) {
	const value = node && typeof node.className == "string" ? node.className : "";
	return value.split(/\s+/).includes(className);
}

function findSettingsHostModal(root) {
	let node = root || null;
	while (node) {
		if (hasClass(node, HOST_MODAL_CLASS)) return node;
		node = node.parentElement || null;
	}
	return null;
}

function isKnownDoneLabel(text) {
	return HOST_DONE_LABELS.has(text) || Object.values(PLUGIN_DONE_LABELS).includes(text);
}

// Discord's button keeps its caption in a nested contents element; write to the deepest
// element that carries exactly the caption so the button's own layout stays intact.
function findCaptionNode(button, caption) {
	let target = button;
	const descendants = typeof button.querySelectorAll == "function" ? Array.from(button.querySelectorAll("*")) : [];
	for (const node of descendants) {
		if (String(node.textContent || "").trim() != caption) continue;
		if (node.children && node.children.length) continue;
		target = node;
	}
	return target;
}

function hostButtons(modal, root) {
	if (!modal || typeof modal.querySelectorAll != "function") return [];
	const insidePanel = root && typeof root.contains == "function" ? node => root.contains(node) : () => false;
	return Array.from(modal.querySelectorAll("button")).filter(button => !insidePanel(button));
}

function relabelButton(button, label) {
	const current = String(button.textContent || "").trim();
	if (!current || !isKnownDoneLabel(current)) return false;
	if (current == label) return true;
	const target = findCaptionNode(button, current);
	if (!originalLabels.has(target)) originalLabels.set(target, current);
	target.textContent = label;
	return true;
}

function restoreButton(button) {
	const current = String(button.textContent || "").trim();
	if (!current) return false;
	const target = findCaptionNode(button, current);
	if (!originalLabels.has(target)) return false;
	target.textContent = originalLabels.get(target);
	originalLabels.delete(target);
	return true;
}

// Returns true when a host button now carries the plugin-language label (already or
// after relabelling), false when there was nothing to do or nothing safe to touch.
// With followsDiscord any earlier relabel is undone and false is returned.
function localizeSettingsHostModal(root, uiLanguageId, {followsDiscord = false} = {}) {
	if (!root) return false;
	const modal = findSettingsHostModal(root);
	if (!modal) return false;
	const title = PLUGIN_SETTINGS_TITLES[["zh", "zh-CN", "zh-TW"].includes(uiLanguageId) ? "zh" : uiLanguageId == "ru" ? "ru" : "en"];
	if (typeof modal.querySelectorAll == "function") for (const node of modal.querySelectorAll("*")) {
		if (root.contains && root.contains(node) || node.children && node.children.length) continue;
		if (Object.values(PLUGIN_SETTINGS_TITLES).includes(String(node.textContent || "").trim())) node.textContent = title;
	}
	if (followsDiscord) {
		for (const button of hostButtons(modal, root)) restoreButton(button);
		return false;
	}
	const label = getSettingsDoneLabel(uiLanguageId);
	if (!label) return false;
	let localized = false;
	for (const button of hostButtons(modal, root)) if (relabelButton(button, label)) localized = true;
	return localized;
}

module.exports = {
	HOST_MODAL_CLASS,
	findSettingsHostModal,
	getSettingsDoneLabel,
	localizeSettingsHostModal
};
