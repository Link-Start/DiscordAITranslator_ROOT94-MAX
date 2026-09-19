// The provider list both settings surfaces read: which stock engines sit in which
// group, which stock rows are archived, and the order rows appear in. The settings
// panel draws the groups with headers; the channel popout flattens the same rows
// into one select. Sharing the rules keeps the two pickers showing the same rows.

const PROVIDER_GROUPS = Object.freeze([
	Object.freeze({id: "ai", keys: Object.freeze(["deepseek", "openai", "gemini", "oaicompat"]), pinned: Object.freeze([])}),
	Object.freeze({id: "machine", keys: Object.freeze(["googleapi", "microsoft", "baidu", "deepl", "googlecloud", "papago"]), pinned: Object.freeze(["googleapi"])})
]);

// Archived stock platforms: the engine code stays intact, the row just leaves every
// picker. A developer restores one by removing its key from this list.
const ARCHIVED_PROVIDER_KEYS = Object.freeze(["openai", "papago"]);

function isArchivedProviderKey(engineKey) {
	return ARCHIVED_PROVIDER_KEYS.includes(engineKey);
}

// Custom providers expand where the static "oaicompat" slot sits, so they belong to
// the AI group; every other key belongs to the group that lists it.
function resolveProviderGroupId(engineKey) {
	const group = PROVIDER_GROUPS.find(candidate => candidate.keys.includes(engineKey));
	return group ? group.id : "ai";
}

// Rows for one group: pinned providers first, the remaining presets alphabetical by
// display label, then custom providers in creation order. Archived rows leave unless
// a caller keeps them, and any kept key the group owns is appended when it would
// otherwise be missing, so an existing setup never points at an invisible provider.
function resolveProviderGroupKeys(group, {engines = {}, customProviderIds = [], getLabel = engineKey => engineKey, keepKeys = []} = {}) {
	const kept = keepKeys.filter(engineKey => engineKey && engines[engineKey]);
	const pinned = group.pinned.filter(engineKey => group.keys.includes(engineKey));
	const presets = group.keys.filter(engineKey => engineKey != "oaicompat" && !pinned.includes(engineKey))
		.sort((a, b) => String(getLabel(a)).localeCompare(String(getLabel(b))));
	const customs = group.keys.includes("oaicompat") ? customProviderIds : [];
	const rows = pinned.concat(presets, customs).filter(engineKey => engines[engineKey] && (!isArchivedProviderKey(engineKey) || kept.includes(engineKey)));
	for (const engineKey of kept) {
		if (!rows.includes(engineKey) && resolveProviderGroupId(engineKey) == group.id) rows.push(engineKey);
	}
	return rows;
}

function resolveVisibleProviderKeys(options = {}) {
	return PROVIDER_GROUPS.flatMap(group => resolveProviderGroupKeys(group, options));
}

module.exports = {
	PROVIDER_GROUPS,
	ARCHIVED_PROVIDER_KEYS,
	isArchivedProviderKey,
	resolveProviderGroupId,
	resolveProviderGroupKeys,
	resolveVisibleProviderKeys
};
