const AI_PROMPT_LIBRARY_VERSION = 1;
const BUILTIN_PROMPT_ID = "builtin";
const MAX_CUSTOM_PROMPTS = 20;
const MAX_PROMPT_NAME_LENGTH = 80;
const MAX_PROMPT_BODY_LENGTH = 12000;

function normalizePromptId(value) {
	const id = String(value || "").trim();
	return /^[a-z0-9][a-z0-9._-]{0,79}$/i.test(id) && id != BUILTIN_PROMPT_ID ? id : "";
}

function normalizePromptEntry(value) {
	if (!value || typeof value != "object" || Array.isArray(value)) return null;
	const id = normalizePromptId(value.id);
	const name = String(value.name || "").trim().slice(0, MAX_PROMPT_NAME_LENGTH);
	const body = String(value.body || "").slice(0, MAX_PROMPT_BODY_LENGTH);
	// An empty body is a valid draft ("new prompt" starts blank); runtime
	// falls back to the built-in template until the user writes one.
	if (!id || !name) return null;
	return {id, name, body};
}

function normalizePromptEntries(value) {
	const items = [];
	const ids = new Set();
	for (const raw of Array.isArray(value) ? value : []) {
		const item = normalizePromptEntry(raw);
		if (!item || ids.has(item.id)) continue;
		ids.add(item.id);
		items.push(item);
		if (items.length >= MAX_CUSTOM_PROMPTS) break;
	}
	return items;
}

function ensureAiPromptLibrary(filters, {legacyPrompts = [], migratedName = "Migrated prompt", createId = () => `prompt-${Date.now().toString(36)}`} = {}) {
	if (!filters || typeof filters != "object" || Array.isArray(filters)) throw new TypeError("filters record required");
	const before = JSON.stringify({version: filters.aiPromptLibraryVersion, items: filters.aiPromptLibrary, selectedId: filters.aiPromptSelectedId, enabled: filters.aiPromptPreferencesEnabled});
	let items = normalizePromptEntries(filters.aiPromptLibrary);
	const legacyBody = typeof filters.aiAutoTranslatePrompt == "string" ? filters.aiAutoTranslatePrompt : "";
	let migratedSelectedId = "";
	if (!items.length && legacyBody.trim() && !legacyPrompts.some(prompt => String(prompt || "").trim() == legacyBody.trim())) {
		const migrated = normalizePromptEntry({id: normalizePromptId(createId()) || "migrated-prompt", name: migratedName, body: legacyBody});
		if (migrated) {items = [migrated]; migratedSelectedId = migrated.id;}
	}
	let selectedId = migratedSelectedId || String(filters.aiPromptSelectedId || "").trim();
	if (selectedId != BUILTIN_PROMPT_ID && !items.some(item => item.id == selectedId)) selectedId = items.length ? items[0].id : BUILTIN_PROMPT_ID;
	filters.aiPromptLibraryVersion = AI_PROMPT_LIBRARY_VERSION;
	filters.aiPromptLibrary = items;
	filters.aiPromptSelectedId = selectedId || BUILTIN_PROMPT_ID;
	filters.aiPromptPreferencesEnabled = filters.aiPromptPreferencesEnabled !== false;
	const selected = items.find(item => item.id == filters.aiPromptSelectedId);
	filters.aiAutoTranslatePrompt = selected ? selected.body : "";
	const after = JSON.stringify({version: filters.aiPromptLibraryVersion, items: filters.aiPromptLibrary, selectedId: filters.aiPromptSelectedId, enabled: filters.aiPromptPreferencesEnabled});
	return {changed: before != after, items, selectedId: filters.aiPromptSelectedId};
}

function getSelectedAiPrompt(filters, defaultPrompt, options) {
	const state = ensureAiPromptLibrary(filters, options);
	const selected = state.items.find(item => item.id == state.selectedId);
	// A blank draft must never reach the AI as an empty instruction.
	return selected && selected.body.trim() ? selected.body : defaultPrompt;
}

function addAiPrompt(filters, {id, name, body}, options) {
	const state = ensureAiPromptLibrary(filters, options);
	if (state.items.length >= MAX_CUSTOM_PROMPTS) return null;
	const item = normalizePromptEntry({id, name, body});
	if (!item || state.items.some(entry => entry.id == item.id)) return null;
	filters.aiPromptLibrary = state.items.concat(item);
	filters.aiPromptSelectedId = item.id;
	filters.aiAutoTranslatePrompt = item.body;
	return item;
}

function updateAiPrompt(filters, id, patch, options) {
	const state = ensureAiPromptLibrary(filters, options);
	const index = state.items.findIndex(item => item.id == id);
	if (index < 0) return null;
	const item = normalizePromptEntry(Object.assign({}, state.items[index], patch, {id}));
	if (!item) return null;
	filters.aiPromptLibrary = state.items.map((entry, itemIndex) => itemIndex == index ? item : entry);
	if (filters.aiPromptSelectedId == id) filters.aiAutoTranslatePrompt = item.body;
	return item;
}

function deleteAiPrompt(filters, id, options) {
	const state = ensureAiPromptLibrary(filters, options);
	const next = state.items.filter(item => item.id != id);
	if (next.length == state.items.length) return false;
	filters.aiPromptLibrary = next;
	if (filters.aiPromptSelectedId == id) filters.aiPromptSelectedId = BUILTIN_PROMPT_ID;
	filters.aiAutoTranslatePrompt = filters.aiPromptSelectedId == BUILTIN_PROMPT_ID ? "" : (next.find(item => item.id == filters.aiPromptSelectedId) || {}).body || "";
	return true;
}

// Whether the selected prompt is sent at all. The dropdown offers an "off" entry that
// flips this flag without touching the selection, so switching back restores the same
// prompt. A missing flag means on.
function isAiPromptSendingEnabled(filters) {
	return !(filters && typeof filters == "object" && filters.aiPromptPreferencesEnabled === false);
}

function setAiPromptSendingEnabled(filters, enabled) {
	if (!filters || typeof filters != "object" || Array.isArray(filters)) throw new TypeError("filters record required");
	filters.aiPromptPreferencesEnabled = enabled !== false;
	return filters.aiPromptPreferencesEnabled;
}

function selectAiPrompt(filters, id, options) {
	const state = ensureAiPromptLibrary(filters, options);
	if (id != BUILTIN_PROMPT_ID && !state.items.some(item => item.id == id)) return false;
	filters.aiPromptSelectedId = id;
	filters.aiAutoTranslatePrompt = id == BUILTIN_PROMPT_ID ? "" : state.items.find(item => item.id == id).body;
	return true;
}

module.exports = {
	AI_PROMPT_LIBRARY_VERSION,
	BUILTIN_PROMPT_ID,
	MAX_CUSTOM_PROMPTS,
	normalizePromptEntries,
	ensureAiPromptLibrary,
	getSelectedAiPrompt,
	isAiPromptSendingEnabled,
	setAiPromptSendingEnabled,
	addAiPrompt,
	updateAiPrompt,
	deleteAiPrompt,
	selectAiPrompt
};
