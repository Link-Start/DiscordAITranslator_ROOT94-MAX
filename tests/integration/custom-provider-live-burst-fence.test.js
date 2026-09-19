const test = require("node:test");
const assert = require("node:assert/strict");
const {createPluginInstance} = require("../helpers/createPluginInstance");

const CUSTOM_ENGINE_KEY = "custom-f05a";
const CUSTOM_CHANNEL_ID = "f05-custom-channel";
const MACHINE_CHANNEL_ID = "f05-machine-channel";

function clone(value) {
	return JSON.parse(JSON.stringify(value));
}

function createPersistedCustomProviderPlugin() {
	const persisted = {
		authKeys: {
			googlecloud: {key: "f05-googlecloud-key"},
			[CUSTOM_ENGINE_KEY]: {
				key: "f05-test-key",
				endpoint: "https://relay.test/v1",
				model: "f05-test-model"
			}
		},
		channelPrimaryEngineOverrides: {
			[CUSTOM_CHANNEL_ID]: CUSTOM_ENGINE_KEY,
			[MACHINE_CHANNEL_ID]: "googlecloud"
		}
	};
	const plugin = createPluginInstance({
		callSetLanguages: false,
		settings: {
			engines: {
				translator: "googleapi",
				backup: "----",
				customProviders: [{id: CUSTOM_ENGINE_KEY, name: "F0.5 test relay"}]
			},
			filters: {
				receivedAutoTranslateScope: "new_only",
				minimumAutoTranslateLength: 2
			},
			choices: {
				received: {input: "auto", output: "zh-CN"},
				sent: {input: "auto", output: "en"}
			}
		},
		bdfdb: {
			DataUtils: {
				load: (_plugin, key) => persisted[key] == null ? {} : clone(persisted[key]),
				save: (value, _plugin, key) => {persisted[key] = clone(value);}
			},
			PatchUtils: {patch: () => {}, forceAllUpdates: () => {}},
			MessageUtils: {rerenderAll: () => {}}
		}
	});
	// setLanguages registers the persisted custom engine in the shared provider table;
	// reload then proves the runtime reads the persisted channel override and auth record.
	plugin.setLanguages();
	plugin.ensureSettingsStore().reload();
	return {plugin, persisted};
}

function createLiveMessage(id) {
	return {
		id,
		channel_id: CUSTOM_CHANNEL_ID,
		content: `F0.5 burst message ${id} with enough source text`,
		embeds: [],
		attachments: [],
		author: {id: "other-user"}
	};
}

async function waitFor(predicate, timeoutMs = 1000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise(resolve => setTimeout(resolve, 5));
	}
	return predicate();
}

test("persisted custom provider crosses the runtime gate and live queue wiring into one multi-item burst", async () => {
	const {plugin, persisted} = createPersistedCustomProviderPlugin();

	assert.equal(plugin.getEffectivePrimaryEngine(CUSTOM_CHANNEL_ID), CUSTOM_ENGINE_KEY, "the real settings store reloads the persisted custom override");
	assert.equal(plugin.getHistoricalAiBatchEngineKey(CUSTOM_CHANNEL_ID), CUSTOM_ENGINE_KEY, "legacy/runtime.js returns the exact eligible custom engine key");
	const machineInput = plugin.ensureSettingsStore().getLanguage(plugin.getLanguageChoice("input", "received", MACHINE_CHANNEL_ID));
	const machineOutput = plugin.ensureSettingsStore().getLanguage(plugin.getLanguageChoice("output", "received", MACHINE_CHANNEL_ID));
	assert.equal(plugin.isEngineConfiguredForRuntime("googlecloud"), true, "the machine-engine fixture is configured before reaching the runtime gate");
	assert.equal(plugin.engineSupportsLanguagePair("googlecloud", machineInput, machineOutput), true, "the machine-engine fixture uses a compatible received-language pair");
	assert.equal(plugin.getHistoricalAiBatchEngineKey(MACHINE_CHANNEL_ID), null, "a configured, language-compatible machine engine is rejected by the same runtime gate");
	assert.deepEqual(persisted.channelPrimaryEngineOverrides, {
		[CUSTOM_CHANNEL_ID]: CUSTOM_ENGINE_KEY,
		[MACHINE_CHANNEL_ID]: "googlecloud"
	});

	// onStart is the only production transition that marks the runtime active. The
	// request below is captured at the provider boundary; it never touches HTTP.
	plugin.onStart();
	plugin.getReceivedDisplayCommitGeneration = () => 1;
	plugin.markReceivedDisplayPending = () => null;
	plugin.releaseReceivedDisplayPending = () => null;
	plugin.ensureMessageViewportStore = () => ({preserveHistoryOnLiveMessage: () => {}});
	plugin.ensureReceivedDisplayRuntime = () => ({pruneChannel: () => {}, peekSourceArchive: () => null});
	plugin.getReceivedAutoTranslateScope = () => "loaded_messages";
	plugin.shouldAutoTranslateReceivedMessage = () => true;
	plugin.extractOriginalContentData = message => ({content: message.content, embeds: []});
	plugin.getCachedReceivedSkipDecision = () => null;
	plugin.validateHistoricalTranslationJobResult = (_preparedItem, translation) => ({ok: true, translation: {content: translation}});
	plugin.persistTranslationCacheEntry = () => {};
	plugin.createReceivedDisplayCommitResult = (message, channelId, result) => ({message, channelId, result});
	plugin.commitReceivedDisplayResult = () => Promise.resolve(null);
	let singleCalls = 0;
	plugin.translateMessage = () => {
		singleCalls++;
		return Promise.resolve(null);
	};

	const bursts = [];
	plugin.requestAiBatchTranslation = (engineKey, preparedItems) => {
		bursts.push({engineKey, messageCount: preparedItems.length, ids: preparedItems.map(item => String(item.message.id))});
		return Promise.resolve(Object.fromEntries(preparedItems.map(item => [String(item.message.id), `translated:${item.message.id}`])));
	};

	const queue = plugin.ensureLiveTranslationQueue();
	queue.setBusyTranslating(true);
	for (const id of ["f05-1", "f05-2", "f05-3"]) {
		const message = createLiveMessage(id);
		assert.equal(plugin.queueAutoTranslateMessage(message, {id: CUSTOM_CHANNEL_ID}, {content: message.content, embeds: []}), true);
	}
	queue.setBusyTranslating(false);
	queue.processQueue();

	assert.equal(await waitFor(() => bursts.length === 1 && !queue.isLiveAutoTranslating()), true, "the real queue must complete the captured burst");
	assert.deepEqual(bursts, [{
		engineKey: CUSTOM_ENGINE_KEY,
		messageCount: 3,
		ids: ["f05-3", "f05-2", "f05-1"]
	}], "live-translation-queue-wiring.js forwards one multi-item request through the custom runtime gate");
	assert.equal(singleCalls, 0, "the three queued live messages must not fall through to the single-item path");
	assert.equal(queue.getQueueLength(), 0);
});
