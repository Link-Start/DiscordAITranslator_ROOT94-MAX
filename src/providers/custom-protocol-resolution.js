// Pure custom-provider interface-format resolver. It performs no requests and owns
// no settings; callers decide when a persisted detection may be written.

const CUSTOM_INTERFACE_FORMATS = Object.freeze(["auto", "openai_chat", "openai_responses", "ollama_native", "gemini_native", "anthropic_messages"]);
const PERSISTED_DETECTION_EVIDENCE = new Set(["catalog", "validation"]);

function normalizeCustomInterfaceFormat(value) {
	if (value === undefined || value === null || value === "") return "auto";
	value = String(value).trim();
	return CUSTOM_INTERFACE_FORMATS.includes(value) ? value : "auto";
}

function getInterfaceEndpointKey(value) {
	return typeof value == "string" ? value.trim().slice(0, 2048) : "";
}

function createInterfaceDetection({resolved, endpointKey, evidence, adapterVersion = 1, checkedAt = 0} = {}) {
	resolved = CUSTOM_INTERFACE_FORMATS.includes(resolved) && resolved !== "auto" ? resolved : "openai_chat";
	return Object.freeze({
		resolved,
		endpointKey: getInterfaceEndpointKey(endpointKey),
		evidence: PERSISTED_DETECTION_EVIDENCE.has(evidence) ? evidence : "validation",
		adapterVersion: Math.max(1, Number(adapterVersion) || 1),
		checkedAt: Number.isFinite(Number(checkedAt)) ? Number(checkedAt) : 0
	});
}

function resolveCustomProtocol({endpoint = "", interfaceFormat, interfaceDetection = null, registry} = {}) {
	const requested = normalizeCustomInterfaceFormat(interfaceFormat);
	const endpointKey = getInterfaceEndpointKey(endpoint);
	const getAdapter = id => registry && typeof registry.get == "function" ? registry.get(id) : null;
	const chat = getAdapter("openai_chat");
	const fallback = (evidence = "legacy") => {
		const adapter = chat;
		return Object.freeze({requested, resolved: adapter && adapter.id || "openai_chat", evidence, endpointKey, adapterVersion: adapter && adapter.version || 1});
	};

	if (requested !== "auto") {
		const adapter = getAdapter(requested);
		return adapter ? Object.freeze({requested, resolved: adapter.id, evidence: "manual", endpointKey, adapterVersion: adapter.version || 1}) : fallback("legacy");
	}

	try {
		const parsed = new URL(endpointKey);
		const path = parsed.pathname.replace(/\/+$/, "").toLowerCase();
		if (/\/api\/(?:chat|tags)$/.test(path) || parsed.port === "11434" && !path) {
			const adapter = getAdapter("ollama_native");
			if (adapter) return Object.freeze({requested, resolved: adapter.id, evidence: "path", endpointKey, adapterVersion: adapter.version || 1});
		}
		if (/:generatecontent$/.test(path) || /\/v1beta\/models(?:\/|$)/.test(path) || parsed.hostname.toLowerCase() === "generativelanguage.googleapis.com") {
			const adapter = getAdapter("gemini_native");
			if (adapter) return Object.freeze({requested, resolved: adapter.id, evidence: "path", endpointKey, adapterVersion: adapter.version || 1});
		}
		if (/\/v1\/messages$/.test(path) || parsed.hostname.toLowerCase() === "api.anthropic.com") {
			const adapter = getAdapter("anthropic_messages");
			if (adapter) return Object.freeze({requested, resolved: adapter.id, evidence: "path", endpointKey, adapterVersion: adapter.version || 1});
		}
		if (/\/responses$/.test(path)) {
			const adapter = getAdapter("openai_responses");
			if (adapter) return Object.freeze({requested, resolved: adapter.id, evidence: "path", endpointKey, adapterVersion: adapter.version || 1});
		}
		if (/\/chat\/completions$/.test(path)) return fallback("path");
	}
	catch (error) {}

	if (interfaceDetection && typeof interfaceDetection == "object") {
		const detected = getAdapter(interfaceDetection.resolved);
		const detectedKey = getInterfaceEndpointKey(interfaceDetection.endpointKey);
		if (detected && endpointKey && detectedKey === endpointKey && Number(interfaceDetection.adapterVersion) === Number(detected.version || 1) && PERSISTED_DETECTION_EVIDENCE.has(interfaceDetection.evidence)) {
			return Object.freeze({requested, resolved: detected.id, evidence: interfaceDetection.evidence, endpointKey, adapterVersion: detected.version || 1});
		}
	}
	return fallback("legacy");
}

module.exports = {
	CUSTOM_INTERFACE_FORMATS,
	normalizeCustomInterfaceFormat,
	getInterfaceEndpointKey,
	createInterfaceDetection,
	resolveCustomProtocol
};
