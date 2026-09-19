const test = require("node:test");
const assert = require("node:assert/strict");
const {
	AI_PROMPT_LIBRARY_VERSION,
	BUILTIN_PROMPT_ID,
	ensureAiPromptLibrary,
	getSelectedAiPrompt,
	addAiPrompt,
	updateAiPrompt,
	deleteAiPrompt,
	selectAiPrompt
} = require("../src/settings/prompt-library");

test("a legacy custom prompt migrates once and remains selected", () => {
	const filters = {aiAutoTranslatePrompt: "translate this custom way", aiPromptLibraryVersion: AI_PROMPT_LIBRARY_VERSION, aiPromptLibrary: [], aiPromptSelectedId: BUILTIN_PROMPT_ID};
	const first = ensureAiPromptLibrary(filters, {legacyPrompts: ["old built in"], migratedName: "Migrated", createId: () => "migrated-one"});
	assert.equal(first.changed, true);
	assert.equal(filters.aiPromptLibraryVersion, AI_PROMPT_LIBRARY_VERSION);
	assert.deepEqual(filters.aiPromptLibrary, [{id: "migrated-one", name: "Migrated", body: "translate this custom way"}]);
	assert.equal(filters.aiPromptSelectedId, "migrated-one");
	const second = ensureAiPromptLibrary(filters, {createId: () => "must-not-run"});
	assert.equal(second.changed, false);
	assert.equal(getSelectedAiPrompt(filters, "default"), "translate this custom way");
});

test("legacy built-in prompts migrate to the current read-only built-in", () => {
	const filters = {aiAutoTranslatePrompt: "old built in"};
	ensureAiPromptLibrary(filters, {legacyPrompts: ["old built in"]});
	assert.deepEqual(filters.aiPromptLibrary, []);
	assert.equal(filters.aiPromptSelectedId, BUILTIN_PROMPT_ID);
	assert.equal(getSelectedAiPrompt(filters, "current built in"), "current built in");
});

test("a new prompt may start blank, survives reload, and falls back to the built-in at runtime", () => {
	const filters = {};
	ensureAiPromptLibrary(filters);
	// The + button creates an empty draft; rejecting it made the button a no-op.
	const created = addAiPrompt(filters, {id: "draft-1", name: "Draft", body: ""});
	assert.deepEqual(created, {id: "draft-1", name: "Draft", body: ""});
	assert.equal(filters.aiPromptSelectedId, "draft-1");
	const reloaded = ensureAiPromptLibrary(filters, {createId: () => "must-not-run"});
	assert.deepEqual(reloaded.items, [{id: "draft-1", name: "Draft", body: ""}]);
	assert.equal(getSelectedAiPrompt(filters, "built-in default"), "built-in default");
	assert.equal(updateAiPrompt(filters, "draft-1", {body: "now written"}).body, "now written");
	assert.equal(getSelectedAiPrompt(filters, "built-in default"), "now written");
});

test("custom prompts support add update select and delete without deleting the built-in", () => {
	const filters = {};
	ensureAiPromptLibrary(filters);
	assert.deepEqual(addAiPrompt(filters, {id: "custom-1", name: "One", body: "Body"}), {id: "custom-1", name: "One", body: "Body"});
	assert.equal(updateAiPrompt(filters, "custom-1", {name: "Renamed"}).name, "Renamed");
	assert.equal(selectAiPrompt(filters, BUILTIN_PROMPT_ID), true);
	assert.equal(filters.aiAutoTranslatePrompt, "");
	assert.equal(deleteAiPrompt(filters, BUILTIN_PROMPT_ID), false);
	assert.equal(deleteAiPrompt(filters, "custom-1"), true);
	assert.deepEqual(filters.aiPromptLibrary, []);
});

test("the sending switch lives next to the selection: off keeps the selected prompt and defaults to on", () => {
	const {ensureAiPromptLibrary, isAiPromptSendingEnabled, setAiPromptSendingEnabled, selectAiPrompt, addAiPrompt} = require("../src/settings/prompt-library");
	const filters = {};
	ensureAiPromptLibrary(filters);
	assert.equal(filters.aiPromptPreferencesEnabled, true, "a fresh library normalises the flag to on");
	assert.equal(isAiPromptSendingEnabled(filters), true);
	assert.equal(isAiPromptSendingEnabled(null), true, "no filters means on");
	addAiPrompt(filters, {id: "mine", name: "Mine", body: "keep gg"});
	assert.equal(setAiPromptSendingEnabled(filters, false), false);
	assert.equal(isAiPromptSendingEnabled(filters), false);
	assert.equal(filters.aiPromptSelectedId, "mine", "turning sending off never touches the selection");
	assert.equal(ensureAiPromptLibrary(filters).changed, false, "normalisation keeps an explicit off");
	assert.equal(selectAiPrompt(filters, "builtin"), true);
	assert.equal(isAiPromptSendingEnabled(filters), false, "selecting a prompt alone does not flip the switch; the panel does that explicitly");
	assert.equal(setAiPromptSendingEnabled(filters, true), true);
	assert.throws(() => setAiPromptSendingEnabled(null, true), TypeError);
});
