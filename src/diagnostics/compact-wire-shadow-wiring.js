// W3 compact-wire shadow glue between the plugin runtime and the pure D compile shadow.
// Gate: performance.compactWireShadow === "shadow" (internal key, default "off", no UI).
// Called by the two typed-json dispatch sites (single message pipeline, history queue item)
// and by the history batch seam. Every path is observation only and swallows its own errors:
// the real request, cache and display never see the shadow.

const {compileTypedRequestShadow, summarizeTypedBatchShadow} = require("../planner/translation-whole-marker-shadow");

function isCompactWireShadowEnabled(plugin) {
	return !!(plugin && plugin.settings && plugin.settings.performance && plugin.settings.performance.compactWireShadow === "shadow");
}

// The D candidate is compiled from the typed plan's own masked source and the P1 placeholder
// map attached to the request, so the shadow input identity is the request's, not a re-read.
function observeCompactWireShadow(plugin, request) {
	try {
		if (!isCompactWireShadowEnabled(plugin) || !request || request.enabled !== true || request.adapter !== "typed-json") return null;
		const state = plugin.getAtomicSemanticLocalState(request), plan = request.rootPlan || request.plan;
		const record = compileTypedRequestShadow({request, source: plan && plan.source, protectedSegments: state && state.protectedSegments || {}});
		if (record) plugin.ensureProviderClient().recordCompactWireShadow(record);
		return record;
	}
	catch (error) {return null;}
}

function observeCompactWireShadowBatch(plugin, event) {
	try {
		if (!isCompactWireShadowEnabled(plugin)) return null;
		const summary = summarizeTypedBatchShadow(event || {});
		if (summary) plugin.ensureProviderClient().recordCompactWireShadowBatch(summary);
		return summary;
	}
	catch (error) {return null;}
}

module.exports = {isCompactWireShadowEnabled, observeCompactWireShadow, observeCompactWireShadowBatch};
