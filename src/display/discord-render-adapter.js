function createDiscordRenderAdapter({BDFDB, document, requestAnimationFrame, setTimeout, getUserScrollIntentSequence, captureScrollState, restoreScrollState}) {
	function escapeAttributeValue(value) {
		return String(value).replace(/(["\\])/g, "\\$1");
	}

	function findMessageElement(messageId) {
		const escapedId = escapeAttributeValue(messageId);
		try {
			return document.querySelector(`[id="chat-messages-${escapedId}"], [data-list-item-id="chat-messages-${escapedId}"], [data-list-item-id="chat-messages___chat-messages-${escapedId}"]`);
		}
		catch (err) {
			return null;
		}
	}

	function findStreamOwner(scroller) {
		return BDFDB.ReactUtils.findOwner(scroller, {
			up: true,
			unlimited: true,
			filter: instance => {
				const props = instance && (instance.stateNode && instance.stateNode.props || instance.props || instance.memoizedProps);
				return !!(props && Array.isArray(props.channelStream));
			}
		});
	}

	function waitForPaint() {
		return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
	}

	function waitForFallbackPaint() {
		return new Promise(resolve => setTimeout(() => waitForPaint().then(resolve), 0));
	}

	function getUniqueMessageIds(messageIds) {
		const seen = new Set();
		return messageIds.filter(messageId => {
			const key = String(messageId);
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
	}

	function getViewsByMessageId(views) {
		const viewsByMessageId = new Map();
		for (const view of views) {
			if (!view) continue;
			const key = String(view.messageId);
			if (!viewsByMessageId.has(key)) {
				viewsByMessageId.set(key, view);
				continue;
			}
			const existingView = viewsByMessageId.get(key);
			if (!existingView || String(existingView.revision) !== String(view.revision)) viewsByMessageId.set(key, null);
		}
		return viewsByMessageId;
	}

	function confirmViews(messageIds, viewsByMessageId) {
		return messageIds.filter(messageId => {
			const view = viewsByMessageId.get(String(messageId));
			const element = view && findMessageElement(messageId);
			if (!element || typeof element.querySelector != "function") return false;
			try {
				return !!element.querySelector(`[data-translator-revision="${escapeAttributeValue(view.revision)}"]`);
			}
			catch (err) {
				return false;
			}
		});
	}

	return {
		async refreshMessages({messageIds = [], views = []}) {
			const uniqueMessageIds = getUniqueMessageIds(messageIds);
			const viewsByMessageId = getViewsByMessageId(views);
			const scroller = document.querySelector(BDFDB.dotCN.messagesscroller);
			const intentSequence = getUserScrollIntentSequence();
			const scrollState = scroller ? captureScrollState() : null;
			let outcome;
			let renderError;
			let hasRenderError = false;
			try {
				const owner = scroller && findStreamOwner(scroller);
				if (owner) BDFDB.ReactUtils.forceUpdate(owner);
				await waitForPaint();
				let confirmedIds = confirmViews(uniqueMessageIds, viewsByMessageId);
				let fallbackUsed = false;
				if (confirmedIds.length !== uniqueMessageIds.length) {
					fallbackUsed = true;
					BDFDB.MessageUtils.rerenderAll(true);
					await waitForFallbackPaint();
					confirmedIds = confirmViews(uniqueMessageIds, viewsByMessageId);
				}
				const confirmedIdSet = new Set(confirmedIds.map(String));
				outcome = {
					confirmedIds,
					missingIds: uniqueMessageIds.filter(messageId => !confirmedIdSet.has(String(messageId))),
					fallbackUsed
				};
			}
			catch (err) {
				renderError = err;
				hasRenderError = true;
			}
			finally {
				try {
					if (scrollState && intentSequence === getUserScrollIntentSequence()) restoreScrollState(scrollState);
				}
				catch (err) {
					if (!hasRenderError) {
						renderError = err;
						hasRenderError = true;
					}
				}
			}
			if (hasRenderError) throw renderError;
			return outcome;
		}
	};
}

module.exports = {createDiscordRenderAdapter};
