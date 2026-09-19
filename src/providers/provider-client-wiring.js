const {compileWholeMarkerSingle} = require("../orchestrator/whole-marker-single-canary");
const {createProviderClient} = require("./provider-client");
const {observeCompactWireShadowBatch} = require("../diagnostics/compact-wire-shadow-wiring");
const {createReasoningRawKey} = require("../settings/reasoning-raw-value");
const {createProviderLatencyStore} = require("../diagnostics/provider-latency-store");
const {createProviderAttemptOwner} = require("./provider-attempt-owner");
const {createAbortableProviderTransport} = require("./abortable-provider-transport");

// Owns the plugin/BDFDB adapter for provider transport. The provider client keeps
// HTTP contracts, backoff, credentials and parsing behaviour; this module only maps
// its ports to the plugin's established runtime owners.
function createPluginProviderClient({
	plugin,
	BDFDB,
	now = Date.now,
	// Deliberately raw: a BDFDB-managed backoff sleep would be cancelled on stop and
	// leave the awaiting provider promise pending forever.
	sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
	fetchFunction = null,
	createClient = createProviderClient,
	createLatencyStore = createProviderLatencyStore,
	createAttemptOwner = createProviderAttemptOwner,
	createStreamTransport = createAbortableProviderTransport
}) {
	const latencyStore = createLatencyStore({now});
	const providerAttemptOwner = createAttemptOwner({clearTimeout: timer => BDFDB.TimeUtils.clear(timer)});
	const nativeFetch = typeof fetchFunction == "function" ? fetchFunction
		: globalThis.BdApi && globalThis.BdApi.Net && typeof globalThis.BdApi.Net.fetch == "function"
			? (url, options) => globalThis.BdApi.Net.fetch(url, options)
			: null;
	const streamTransport = nativeFetch ? createStreamTransport({
		fetchFunction: nativeFetch,
		attemptOwner: providerAttemptOwner,
		setTimeout: (callback, delay) => BDFDB.TimeUtils.timeout(callback, delay)
	}) : null;

	const client = createClient({
		request: (url, options, callback) => BDFDB.LibraryRequires.request(url, options, callback),
		setTimeout: (callback, delay) => BDFDB.TimeUtils.timeout(callback, delay),
		clearTimeout: timer => BDFDB.TimeUtils.clear(timer),
		sleep,
		now,
		getAuthKeys: () => plugin.ensureSettingsStore().getAuthKeys(),
		saveAuthKeys: value => plugin.ensureSettingsStore().replaceAuthKeys(value),
		createReasoningRawKey,
		getReasoningModelPref: (engineKey, modelId) => plugin.ensureSettingsStore().getReasoningModelPref(engineKey, modelId),
		setReasoningModelPref: (engineKey, modelId, preference) => plugin.ensureSettingsStore().setReasoningModelPref(engineKey, modelId, preference),
		setReasoningModelCapability: (engineKey, modelId, capability) => plugin.ensureSettingsStore().setReasoningModelCapability(engineKey, modelId, capability),
		setReasoningModelTierState: (engineKey, modelId, raw, tierState) => plugin.ensureSettingsStore().setReasoningModelTierState(engineKey, modelId, raw, tierState),
		clearReasoningModelCapability: (engineKey, modelId) => plugin.ensureSettingsStore().clearReasoningModelCapability(engineKey, modelId),
		setInterfaceDetection: (engineKey, detection) => plugin.ensureSettingsStore().setInterfaceDetection(engineKey, detection),
		clearInterfaceDetection: engineKey => plugin.ensureSettingsStore().clearInterfaceDetection(engineKey),
		loadModelCatalogs: () => BDFDB.DataUtils.load(plugin, "modelCatalogs"),
		saveModelCatalogs: value => BDFDB.DataUtils.save(value, plugin, "modelCatalogs"),
		getLanguages: () => plugin.ensureSettingsStore().getLanguages(),
		notify: (message, options) => BDFDB.NotificationUtils.toast(message, options),
		getLabels: () => plugin.labels,
		getCustomText: key => plugin.getCustomText(key),
		getEngineLabel: engineKey => plugin.getEngineLabel(engineKey),
		shouldUseAiAutoTranslateDecision: channelId => plugin.shouldUseAiAutoTranslateDecision(channelId),
		getAiAutoTranslatePrompt: translationData => plugin.getAiAutoTranslatePrompt(translationData),
		isLiveStreamingEnabled: () => !plugin.settings.performance || plugin.settings.performance.liveStreaming !== false,
		// W3: the history batch seam reports typed batch bytes so the compact-wire shadow can sum
		// its per-message D compiles against them. Observation only; the batch body is untouched.
		observeCompactWireShadowBatch: event => observeCompactWireShadowBatch(plugin, event),
		compileWholeMarkerBatchItem: item => compileWholeMarkerSingle(plugin, item.semanticRequest),
		wholeMarkerBatchValidation: item => ({likelyTarget: value => plugin.isTranslationLikelyInTargetLanguage(value, item.output.id), similarity: (source, value) => plugin.getTextSimilarityScore(source, value), maxSimilarity: 0.94}),
		isWholeMarkerBatchItemCurrent: item => {
			const store = BDFDB.LibraryStores && BDFDB.LibraryStores.MessageStore, current = store && typeof store.getMessage === "function" && store.getMessage(item.channelId, item.message.id) || item.message;
			return plugin.isTranslationEnabled(item.channelId) && plugin.createReceivedTranslationSignature(current, item.channelId, plugin.extractOriginalContentData(current)) === item.signature;
		},
		beginLatencyRequest: options => latencyStore.beginLatencyRequest(options),
		recordLatencyEvent: event => latencyStore.recordLatencyEvent(event),
		recordSemanticObservation: event => latencyStore.recordSemanticObservation(event),
		recordAttemptOutcome: event => latencyStore.recordAttemptOutcome(event),
		providerAttemptOwner,
		streamTransport
	});

	return Object.freeze(Object.assign({}, client, {
		beginLatencyRequest: options => latencyStore.beginLatencyRequest(options),
		recordLatencyEvent: event => latencyStore.recordLatencyEvent(event),
		recordSemanticObservation: event => latencyStore.recordSemanticObservation(event),
		recordWireObservationEvent: event => latencyStore.recordWireObservationEvent(event),
		recordDisplayObservation: event => latencyStore.recordDisplayObservation(event),
		recordAttemptOutcome: event => latencyStore.recordAttemptOutcome(event),
		recordCompactWireShadow: record => latencyStore.recordCompactWireShadow(record),
		recordCompactWireShadowBatch: record => latencyStore.recordCompactWireShadowBatch(record),
		getCompactWireShadowSnapshot: () => latencyStore.getCompactWireShadowSnapshot(),
		resetCompactWireShadow: () => latencyStore.resetCompactWireShadow(),
		beginW2Session: options => latencyStore.beginW2Session(options),
		recordW2Trial: (token, event) => latencyStore.recordW2Trial(token, event),
		finishW2Session: token => latencyStore.finishW2Session(token),
		cancelW2Session: token => latencyStore.cancelW2Session(token),
		failW2Session: (token, reason) => latencyStore.failW2Session(token, reason),
		resetW2Session: () => latencyStore.resetW2Session(),
		getW2Snapshot: () => latencyStore.getW2Snapshot(),
		getLatencySnapshot: options => latencyStore.getLatencySnapshot(options),
		getWireObservationSnapshot: () => latencyStore.getWireObservationSnapshot(),
		getLatencyGeneration: () => latencyStore.getGeneration(),
		resetLatency: () => latencyStore.resetLatency(),
		abortProviderAttempts: reason => providerAttemptOwner.abortAll(reason || "cancelled"),
		drainProviderAttempts: () => providerAttemptOwner.drain(),
		getProviderAttemptSnapshot: () => providerAttemptOwner.getSnapshot()
	}));
}

module.exports = {createPluginProviderClient};
