// Owns the last stretch of the received-translation path: turning a stored translation
// record into the text, watermark and decorations Discord actually renders, and putting
// the original back when the translation goes away. Every method used to sit in the
// plugin factory closure in runtime.js, between receivedTranslationRuntime and
// foreignLanguageDecisionRuntime, where it could reach the whole 5600-line file.
//
// This is the hot path for "did my translation show up". Three groups live here:
//
// - Composition. buildReceivedDisplayContent and refreshTranslationDisplay decide what
//   the message body reads as, including whether the original is appended inline.
// - Reply previews. The stripReplyPreview / getStableReplyPreview / getReplyPreview
//   family projects a stored translation into the small quoted preview above a reply.
//   getStableReplyPreviewOriginalContent is what stops a preview from echoing an
//   already-translated body back as if it were the original.
// - Render hooks. processMessageReply, prepareMessageContentDisplay, processEmbed and
//   the decoration helpers are called straight from the BDFDB message patches.
//
// Everything else in the runtime is reached through `plugin`, so the only injected
// dependency is BDFDB itself (DiscordObjects.Message, ReactUtils, DOMUtils,
// LibraryComponents, disCN). Most of the object touches it, which is why this exports a
// factory rather than a plain object: a test can drive it with a stub BDFDB.
//
// Every method keeps `plugin` as its first parameter exactly as the legacy runtime had
// it: the plugin class methods are one-line delegations and the render patches call in
// with `this`. The plugin still owns normalizeStoredTranslationData,
// ensureReceivedDisplayRuntime, extractOriginalContentData and the rest.

// Same values as the legacy messageTypes map in runtime.js and as MESSAGE_DIRECTIONS in
// language-heuristics.js. Kept as a local copy because this is runtime-wide vocabulary,
// not something the display module should own on everyone else's behalf.
const MESSAGE_DIRECTIONS = Object.freeze({RECEIVED: "received", SENT: "sent"});

function createTranslationDisplayLogic({BDFDB} = {}) {
	const translationDisplayLogic = {
		buildReceivedDisplayContent(plugin, translatedContent, originalContent, forceInlineOriginal = false) {
			let content = (translatedContent || "").trim();
			const shouldInlineOriginal = !!(originalContent && (forceInlineOriginal || plugin.settings.general.showOriginalMessage && !plugin.settings.general.showOriginalDirectly));
			if (shouldInlineOriginal) content += plugin.formatOriginalTextForMessage(originalContent, plugin.shouldUseSpoilerInReceivedOriginal());
			return content;
		},
		refreshTranslationDisplay(plugin, translation) {
			if (!translation) return null;
			translation = Object.assign(translation, plugin.normalizeStoredTranslationData(translation));
			const inlineOriginalBySetting = !!(translation.originalContent && plugin.settings.general.showOriginalMessage && !plugin.settings.general.showOriginalDirectly);
			translation.content = translationDisplayLogic.buildReceivedDisplayContent(plugin, translation.translatedContent || translation.content, translation.originalContent, false);
			translation.contentIncludesOriginal = inlineOriginalBySetting;
			return translation;
		},
		getReplyPreviewDisplayContent(plugin, translation) {
			if (!translation) return "";
			translation = plugin.normalizeStoredTranslationData(translation);
			const originalContent = (translation.originalContent || "").trim();
			const translatedContent = (translation.translatedContent || translation.content || "").trim();
			return plugin.settings.general.showOriginalInReplyPreview ? (translatedContent || originalContent) : originalContent;
		},
		stripReplyPreviewOriginalSuffix(_plugin, content) {
			content = (content || "").trim();
			if (!content) return "";
			if (/\n\|\|[\s\S]*\|\|$/.test(content)) return content.replace(/\n\|\|[\s\S]*\|\|$/, "").trim();
			const lines = content.split("\n");
			let boundaryIndex = lines.length;
			while (boundaryIndex > 0 && /^\s*>\s?/.test(lines[boundaryIndex - 1])) boundaryIndex--;
			if (boundaryIndex < lines.length) return lines.slice(0, boundaryIndex).join("\n").trim();
			return content;
		},
		getStableReplyPreviewOriginalContent(plugin, message) {
			if (!message) return "";
			const currentContent = (message.content || "").trim();
			const storedTranslations = plugin.ensureReceivedDisplayRuntime().getPreviewCandidates(message.id).filter(Boolean);
			for (const storedTranslation of storedTranslations) {
				const normalizedTranslation = plugin.normalizeStoredTranslationData(storedTranslation);
				const originalContent = (normalizedTranslation.originalContent || "").trim();
				const translatedContent = (normalizedTranslation.translatedContent || normalizedTranslation.content || "").trim();
				const displayContent = translationDisplayLogic.getReplyPreviewDisplayContent(plugin, normalizedTranslation).trim();
				if (!originalContent) continue;
				if (!currentContent || currentContent == originalContent || currentContent == translatedContent || currentContent == displayContent || currentContent == translationDisplayLogic.stripReplyPreviewOriginalSuffix(plugin, displayContent)) return originalContent;
			}
			return currentContent;
		},
		getStableReplyPreviewMessage(plugin, message) {
			if (!message) return message;
			const stableMessage = new BDFDB.DiscordObjects.Message(message);
			stableMessage.content = translationDisplayLogic.getStableReplyPreviewOriginalContent(plugin, message);
			return stableMessage;
		},
		getReplyPreviewFallbackContent(plugin, message) {
			if (!message) return "";
			return translationDisplayLogic.stripReplyPreviewOriginalSuffix(plugin, message.content || "");
		},
		getReplyPreviewDisplayContentForMessage(plugin, message, channelId = null) {
			if (!message) return "";
			const originalContent = translationDisplayLogic.getStableReplyPreviewOriginalContent(plugin, message) || (message.content || "").trim();
			// The projection wraps the winning translation with its provenance; the callers
			// below only need the translation itself.
			const previewProjection = plugin.ensureReceivedDisplayRuntime().getReplyPreviewProjection(message.id, {channelId});
			const storedTranslation = previewProjection && previewProjection.translation;
			if (storedTranslation && translationDisplayLogic.shouldDisplayStoredTranslation(plugin, storedTranslation, channelId || translationDisplayLogic.getStoredTranslationChannelId(plugin, message.id))) {
				const normalizedTranslation = plugin.normalizeStoredTranslationData(storedTranslation);
				const translatedContent = (normalizedTranslation.translatedContent || normalizedTranslation.content || "").trim();
				if (!normalizedTranslation.auto || plugin.settings.general.showOriginalInReplyPreview) return translatedContent || originalContent;
			}
			return originalContent;
		},
		applyStoredTranslationToMessage(plugin, message, translation, originalContentData = null) {
			if (!message || !translation) return null;
			const storedTranslation = translationDisplayLogic.refreshTranslationDisplay(plugin, Object.assign({
				channelId: translation.channelId || message.channel_id || null,
				auto: !!translation.auto
			}, translation));
			plugin.ensureReceivedDisplayRuntime().clearSuppression(message.id);
			plugin.ensureReceivedDisplayRuntime().commitManualTranslation({
				messageId: message.id,
				channelId: storedTranslation.channelId,
				translation: storedTranslation,
				manualOptions: {independentOfTextAreaSwitch: !!storedTranslation.independentOfTextAreaSwitch},
				archive: {message: new BDFDB.DiscordObjects.Message(message), originalContentData: originalContentData || plugin.extractOriginalContentData(message)}
			});
			return storedTranslation;
		},
		clearDisplayedTranslationState(plugin, messageId, options = {}) {
			if (!messageId) return;
			const config = Object.assign({
				clearReplyPreview: false,
				preserveSuppressed: false
			}, options);
			plugin.ensureReceivedDisplayRuntime().clearDisplayedTranslation(messageId, {preserveArchive: true, preserveSuppressed: config.preserveSuppressed, clearPreview: config.clearReplyPreview});
			// preserveArchive is not an optimisation: a rendered message whose props still
			// carry translated text needs the archived source on its next render to restore
			// the original, and the render path consumes the archive once it has done so.
			if (!config.preserveSuppressed) plugin.ensureReceivedDisplayRuntime().clearSuppression(messageId);
			if (config.clearReplyPreview) {
				plugin.ensureReceivedDisplayRuntime().clearPreview(messageId);
			}
		},
		getStoredTranslationChannelId(plugin, messageId, fallbackChannelId = null, translation = null) {
			if (fallbackChannelId) return fallbackChannelId;
			if (translation && translation.channelId) return translation.channelId;
			const displayedTranslation = plugin.ensureReceivedDisplayRuntime().getDisplayState(messageId);
			if (displayedTranslation && displayedTranslation.channelId) return displayedTranslation.channelId;
			const replyPreviewTranslation = plugin.ensureReceivedDisplayRuntime().getPreviewTranslation(messageId);
			if (replyPreviewTranslation && replyPreviewTranslation.channelId) return replyPreviewTranslation.channelId;
			const archive = plugin.ensureReceivedDisplayRuntime().peekSourceArchive(messageId);
			return archive && archive.message.channel_id || null;
		},
		shouldDisplayStoredTranslation(plugin, translation, channelId = null) {
			if (!translation) return false;
			const normalizedTranslation = plugin.normalizeStoredTranslationData(translation);
			if (normalizedTranslation.manual && normalizedTranslation.independentOfTextAreaSwitch) return true;
			const resolvedChannelId = channelId || normalizedTranslation.channelId || null;
			if (normalizedTranslation.auto && resolvedChannelId && !plugin.isTranslationEnabled(resolvedChannelId)) return false;
			return true;
		},
		getStoredTranslationOriginalContent(plugin, translation, fallbackContent = "") {
			if (!translation) return fallbackContent;
			const normalizedTranslation = plugin.normalizeStoredTranslationData(translation);
			return normalizedTranslation.originalContent != null ? String(normalizedTranslation.originalContent) : fallbackContent;
		},
		getActiveMessageTranslation(plugin, message, channelId = null, expectedSignature = null) {
			if (!message || !message.id) return null;
			const displayRecord = plugin.ensureReceivedDisplayRuntime().getDisplayState(message.id);
			// Store records are frozen, and refreshTranslationDisplay recomposes in place,
			// so every read that reaches it works on a detached copy.
			let translation = displayRecord && displayRecord.status == "translated" && displayRecord.translation ? Object.assign({}, displayRecord.translation) : null;
			if (!translation) return null;
			const resolvedChannelId = translationDisplayLogic.getStoredTranslationChannelId(plugin, message.id, channelId, translation);
			if (!translationDisplayLogic.shouldDisplayStoredTranslation(plugin, translation, resolvedChannelId)) {
				translationDisplayLogic.clearDisplayedTranslationState(plugin, message.id);
				return null;
			}
			if (expectedSignature && translation.signature && translation.signature != expectedSignature) {
				translationDisplayLogic.clearDisplayedTranslationState(plugin, message.id);
				return null;
			}
			translation = translationDisplayLogic.refreshTranslationDisplay(plugin, translation);
			if (translation.auto && plugin.isTranslationResultTooSimilar(translation)) {
				translationDisplayLogic.clearDisplayedTranslationState(plugin, message.id);
				plugin.clearCachedTranslation(message.id);
				return null;
			}
			// The refreshed projection is display-only; the record itself is unchanged.
			return translation;
		},
		getActiveReplyPreviewTranslation(plugin, message, channelId) {
			if (!message || !message.id) return null;
			const translation = plugin.getReplyPreviewTranslation(message, channelId);
			if (!translation) return null;
			if (!translationDisplayLogic.shouldDisplayStoredTranslation(plugin, translation, channelId)) {
				plugin.ensureReceivedDisplayRuntime().clearPreview(message.id);
				return null;
			}
			return translation;
		},
		processMessageReply(plugin, e) {
			if (!e.instance.props.referencedMessage || !e.instance.props.referencedMessage.message) return;
			const referencedMessage = e.instance.props.referencedMessage.message;
			const stableReferencedMessage = translationDisplayLogic.getStableReplyPreviewMessage(plugin, referencedMessage);
			const baseMessage = e.instance.props.baseMessage || null;
			const channelId = plugin.getMessageChannelId(baseMessage || stableReferencedMessage);
			const baseProjection = plugin.ensureReceivedDisplayRuntime().getReplyPreviewProjection(stableReferencedMessage.id, {channelId});
			const storedMessageTranslation = baseProjection && baseProjection.translation;
			const hasVisibleStoredTranslation = storedMessageTranslation && translationDisplayLogic.shouldDisplayStoredTranslation(plugin, storedMessageTranslation, channelId) || translationDisplayLogic.getActiveReplyPreviewTranslation(plugin, stableReferencedMessage, channelId);
			if (!hasVisibleStoredTranslation && plugin.shouldAutoTranslateReplyPreview(baseMessage, stableReferencedMessage, channelId)) plugin.queueReplyPreviewTranslation(stableReferencedMessage, channelId, {baseMessage});
			const fallbackContent = translationDisplayLogic.getReplyPreviewDisplayContentForMessage(plugin, stableReferencedMessage, channelId) || translationDisplayLogic.getReplyPreviewFallbackContent(plugin, stableReferencedMessage) || (stableReferencedMessage.content || "").trim();
			e.instance.props.referencedMessage = Object.assign({}, e.instance.props.referencedMessage);
			const previewMessage = new BDFDB.DiscordObjects.Message(stableReferencedMessage);
			previewMessage.content = fallbackContent;
			plugin.markReplyPreviewRenderMessage(previewMessage);
			e.instance.props.referencedMessage.message = previewMessage;
			if (e.returnvalue && e.returnvalue.props) {
				e.returnvalue = plugin.wrapReplyPreviewJumpPause(plugin.stripTranslatorStylingFromReplyPreviewNode(e.returnvalue));
			}
		},
		resolveLoadedMessageContentTranslation(plugin, message, channelId) {
			if (plugin.getReceivedAutoTranslateScope() != "loaded_messages" || !plugin.isTranslationEnabled(channelId) || plugin.isOwnMessage(message) || plugin.ensureReceivedDisplayRuntime().isSuppressed(message.id) || plugin.ensureLiveTranslationQueue().isMessageQueued(message.id)) return null;
			// A store record that is already translated or has an active request must not
			// re-enter the queue on every render; that would loop commit -> repaint -> requeue.
			const storeView = plugin.getReceivedDisplayRuntimeView(message.id);
			if (storeView && (storeView.translated || storeView.showLoading)) return null;
			const originalContentData = plugin.extractOriginalContentData(message);
			const cachedTranslation = plugin.getCachedReceivedTranslation(message, channelId, originalContentData);
			const liveMessage = plugin.isLikelyLiveAutoTranslateMessage(message, channelId);
			// Cached live results also queue: the acknowledged display commit repaints text
			// and decoration atomically instead of decorating a still-original render.
			if (cachedTranslation || plugin.shouldAutoTranslateReceivedMessage(message, {id: channelId}, originalContentData)) {
				plugin.queueAutoTranslateMessage(message, {id: channelId}, originalContentData, {
					historicalLoad: !liveMessage,
					deferWhileReading: false,
					cachedTranslation
				});
			}
			return null;
		},
		prepareMessageContentDisplay(plugin, e) {
			let message = e.instance.props.message;
			const channelId = plugin.getMessageChannelId(message);
			let translation = translationDisplayLogic.getActiveMessageTranslation(plugin, message, channelId);
			if (!translation && plugin.ensureReceivedDisplayRuntime().hasSourceArchive(message.id)) {
				message = e.instance.props.message = new BDFDB.DiscordObjects.Message(plugin.ensureReceivedDisplayRuntime().consumeSourceArchive(message.id).message);
			}
			if (!translation) translation = translationDisplayLogic.resolveLoadedMessageContentTranslation(plugin, message, channelId);
			return {message, channelId, translation};
		},
		createTranslationWatermarkNode(plugin, translation, key) {
			if (!translation || !translation.content) return null;
			return BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.TooltipContainer, {
				key,
				text: plugin.getTranslationTooltipText(translation.input, translation.output),
				tooltipConfig: {style: "max-width: 400px"},
				children: BDFDB.ReactUtils.createElement("span", {
					className: BDFDB.DOMUtils.formatClassName(BDFDB.disCN.messagetimestamp, BDFDB.disCN.messagetimestampinline, BDFDB.disCN._translatortranslated),
					children: BDFDB.ReactUtils.createElement("span", {
						className: BDFDB.disCN.messageedited,
						children: `(${plugin.labels.translated_watermark})`
					})
				})
			});
		},
		createTranslationLoadingNode(plugin, message) {
			if (!message || !plugin.isMessageTranslationPending(message.id, plugin.getMessageChannelId(message))) return null;
			return BDFDB.ReactUtils.createElement("span", {
				key: "translator-translation-loading",
				className: "translator-translation-loading",
				"aria-label": plugin.isChineseUiLanguage() ? "正在翻译" : "Translating"
			});
		},
		clearTranslatedRenderDecorations(_plugin, e) {
			if (!e || !e.returnvalue || !e.returnvalue.props) return;
			const className = String(e.returnvalue.props.className || "")
				.split(/\s+/)
				.filter(name => name && name != "translator-translated-message")
				.join(" ");
			e.returnvalue.props.className = className;
			const style = Object.assign({}, e.returnvalue.props.style || {});
			delete style["--translator-accent-color"];
			delete style["--translator-text-color"];
			e.returnvalue.props.style = style;
		},
		applyMessageContentRenderDecorations(plugin, e, message, translation) {
			let children = plugin.ensureElementChildrenArray(e.returnvalue);
			plugin.cleanupInjectedMessageChildren(children);
			translationDisplayLogic.clearTranslatedRenderDecorations(plugin, e);
			const translationPlace = plugin.isOwnMessage(message) ? MESSAGE_DIRECTIONS.SENT : MESSAGE_DIRECTIONS.RECEIVED;
			if (translation && plugin.shouldProtectWrappedTextForPlace(translationPlace)) {
				e.returnvalue.props.children = plugin.highlightProtectedWrappedTextInNode(e.returnvalue.props.children, message.id);
				children = plugin.ensureElementChildrenArray(e.returnvalue);
			}
			if (translation && plugin.settings.general.highlightTranslatedMessages) e.returnvalue.props.className = BDFDB.DOMUtils.formatClassName(e.returnvalue.props.className, "translator-translated-message");
			if (translation) e.returnvalue.props.style = Object.assign({}, e.returnvalue.props.style, {
				"--translator-accent-color": plugin.getTranslatedTextColor(),
				"--translator-text-color": plugin.getTranslatedTextColor()
			});
			const watermarkNode = translationDisplayLogic.createTranslationWatermarkNode(plugin, translation, "translator-translated-watermark");
			if (watermarkNode) children.push(watermarkNode);
			const loadingNode = !translation && translationDisplayLogic.createTranslationLoadingNode(plugin, message);
			if (loadingNode) children.push(loadingNode);
			if (translation && translation.originalContent && plugin.settings.general.showOriginalMessage && plugin.settings.general.showOriginalDirectly && !translation.contentIncludesOriginal) children.push(plugin.createOriginalMessageBlock(translation.originalContent));
		},
		processEmbed(plugin, e) {
			if (!e.instance.props.embed || !e.instance.props.embed.message_id) return;
			let translation = translationDisplayLogic.getActiveMessageTranslation(plugin, {id: e.instance.props.embed.message_id}, plugin.getDisplayedTranslationChannelId(e.instance.props.embed.message_id));
			if (!translation) {
				const storeView = plugin.getReceivedDisplayRuntimeView(e.instance.props.embed.message_id);
				if (storeView && storeView.translated && storeView.translation && storeView.translation.embeds) translation = storeView.translation;
			}
			if (translation && Object.keys(translation.embeds).length) {
				if (!e.returnvalue) e.instance.props.embed = Object.assign({}, e.instance.props.embed, {
					rawDescription: translation.embeds[e.instance.props.embed.id].description,
					rawTitle: translation.embeds[e.instance.props.embed.id].title,
					footer: Object.assign({}, e.instance.props.embed.footer || {}, {
						text: translation.embeds[e.instance.props.embed.id].footerText || ""
					}),
					fields: translation.embeds[e.instance.props.embed.id].fields.map(n => ({rawName: n.name, rawValue: n.value})),
					originalDescription: e.instance.props.embed.originalDescription || e.instance.props.embed.rawDescription,
					originalTitle: e.instance.props.embed.originalTitle || e.instance.props.embed.rawTitle,
					originalFields: e.instance.props.embed.originalFields || e.instance.props.embed.fields,
					originalFooter: e.instance.props.embed.originalFooter || Object.assign({}, e.instance.props.embed.footer)
				});
				else {
					let [children, index] = BDFDB.ReactUtils.findParent(e.returnvalue, {props: [["className", BDFDB.disCN.embeddescription]]});
					if (index > -1) {
						if (!Array.isArray(children[index].props.children)) {
							children[index].props.children = [children[index].props.children];
						}
						plugin.cleanupInjectedMessageChildren(children[index].props.children);
						const watermarkNode = translationDisplayLogic.createTranslationWatermarkNode(plugin, translation, "translator-embed-watermark");
						if (watermarkNode) children[index].props.children.push(watermarkNode);
					}
				}
			}
			else if (!e.returnvalue && e.instance.props.embed.originalDescription) {
				e.instance.props.embed = Object.assign({}, e.instance.props.embed, {
					rawDescription: e.instance.props.embed.originalDescription,
					rawTitle: e.instance.props.embed.originalTitle,
					fields: e.instance.props.embed.originalFields,
					footer: e.instance.props.embed.originalFooter
				});
				delete e.instance.props.embed.originalDescription;
				delete e.instance.props.embed.originalTitle;
				delete e.instance.props.embed.originalFields;
				delete e.instance.props.embed.originalFooter;
			}
		}
	};

	return translationDisplayLogic;
}

module.exports = {MESSAGE_DIRECTIONS, createTranslationDisplayLogic};
