const {createPluginInstance} = require("./createPluginInstance");

function createHarness({confirmDirectly = true, confirmAfterFallback = true} = {}) {
	const originalDocument = global.document;
	const originalRequestAnimationFrame = global.requestAnimationFrame;
	const calls = {forceUpdate: 0, rerenderAll: 0};
	let confirmed = false;
	const messageElement = {querySelector: () => confirmed ? {} : null};
	const scroller = {
		scrollTop: 100,
		scrollHeight: 1000,
		clientHeight: 400,
		addEventListener: () => {},
		removeEventListener: () => {},
		getBoundingClientRect: () => ({top: 0, bottom: 400, height: 400})
	};
	global.document = {
		querySelector(selector) {
			if (selector === ".messages-scroller") return scroller;
			if (typeof selector == "string" && selector.includes("message-")) return messageElement;
			return null;
		},
		getElementById: () => null
	};
	global.requestAnimationFrame = callback => callback();
	const plugin = createPluginInstance({
		callSetLanguages: false,
		bdfdb: {
			dotCN: {messagesscroller: ".messages-scroller"},
			disCN: {messagetimestamp: "timestamp", messagetimestampinline: "inline", _translatortranslated: "translated", messageedited: "edited"},
			DOMUtils: {formatClassName: (...names) => names.filter(Boolean).join(" ")},
			LanguageUtils: {getName: language => language && language.name || ""},
			LibraryComponents: {TooltipContainer: "TooltipContainer"},
			ReactUtils: {
				createElement: (type, props) => ({type, key: props && props.key, props: props || {}}),
				findOwner: () => ({props: {channelStream: []}}),
				forceUpdate: () => {
					calls.forceUpdate++;
					if (confirmDirectly) confirmed = true;
				}
			},
			MessageUtils: {
				rerenderAll: () => {
					calls.rerenderAll++;
					if (confirmAfterFallback) confirmed = true;
				}
			}
		}
	});
	plugin.settings.general.highlightTranslatedMessages = true;
	plugin.labels.translated_watermark = "Translated";
	plugin.getTranslatedTextColor = () => "#12a594";
	plugin.shouldProtectWrappedTextForPlace = () => false;
	return {
		plugin,
		calls,
		scroller,
		restore() {
			global.document = originalDocument;
			global.requestAnimationFrame = originalRequestAnimationFrame;
		}
	};
}

function sourceSnapshot() {
	return {messageId: "message-1", channelId: "channel-1", generation: 1, sourceSignature: "signature-1", source: {content: "Original", embeds: []}};
}

function translatedResult() {
	return {
		messageId: "message-1",
		channelId: "channel-1",
		generation: 1,
		sourceSignature: "signature-1",
		origin: "automatic",
		status: "translated",
		translation: {content: "译文", input: {id: "en"}, output: {id: "zh-CN"}}
	};
}

module.exports = {createHarness, sourceSnapshot, translatedResult};
