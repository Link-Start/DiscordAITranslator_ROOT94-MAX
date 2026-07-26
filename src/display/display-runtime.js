const {createMessageStateStore} = require("./message-state-store");
const {createTranslationDisplayController} = require("./translation-display-controller");
const {createDiscordRenderAdapter} = require("./discord-render-adapter");

function createDisplayRuntime(dependencies) {
	const store = createMessageStateStore();
	const renderAdapter = createDiscordRenderAdapter(dependencies);
	const controller = createTranslationDisplayController({store, renderAdapter});
	return Object.freeze({
		captureSource: snapshot => store.captureSource(snapshot),
		setChannelGeneration: (channelId, generation) => store.setChannelGeneration(channelId, generation),
		getChannelGeneration: channelId => store.getChannelGeneration(channelId),
		getDisplayView: messageId => controller.getDisplayView(messageId),
		markPending: (request, options) => controller.markPending(request, options),
		releasePending: request => store.releasePending(request),
		commitMessageResult: (result, options) => controller.commitMessageResult(result, options),
		commitHistoricalBatch: results => controller.commitHistoricalBatch(results),
		restoreMessage: (messageId, options) => controller.restoreMessage(messageId, options),
		restoreChannel: channelId => controller.restoreChannel(channelId),
		restoreAll: options => controller.restoreAll(options)
	});
}

module.exports = {createDisplayRuntime};
