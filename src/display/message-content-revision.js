// Discord's MessageContent memo comparator ignores message identity and compares
// content/state/flags/edit time. Same-text translations and spinner removal still
// need a render. Track the display version associated with each immutable props
// object; keep the native comparator for unchanged versions and unrelated rows.
function createMessageContentRevisionGuard({getView}) {
	const versions = new WeakMap();
	return (previous, next, equal) => {
		const message = next && next.message;
		if (!message || message.__DiscordAITranslatorReplyPreview || !previous || !next) return equal;
		const view = getView(message.id);
		const version = view ? view.revision : null;
		const known = versions.has(previous), oldVersion = versions.get(previous);
		versions.set(next, version);
		if (known ? oldVersion !== version : version != null) return false;
		return equal;
	};
}

function installMessageContentRevisionGuard({plugin, BDFDB, Webpack}) {
	if (!Webpack || typeof Webpack.getModule !== "function") return false;
	const component = Webpack.getModule(value => {
		if (!value || typeof value.type !== "function" || typeof value.compare !== "function") return false;
		const compare = String(value.compare);
		return ["editedTimestamp", ".content", ".state", ".flags", '"message"'].every(part => compare.includes(part));
	}, {searchExports: true});
	const guard = createMessageContentRevisionGuard({getView: id => plugin.getReceivedDisplayRuntimeView(id)});
	if (component) BDFDB.PatchUtils.patch(plugin, component, "compare", {after: event => {
		event.returnValue = guard(event.methodArguments[0], event.methodArguments[1], event.returnValue);
	}});
	// Forwarded bodies live below MessageAccessories. Its native update gate ignores
	// snapshot content and our display state, so the inner body comparator alone is
	// never reached. Open that gate only for a forward whose revision changed.
	const accessories = Webpack.getModule(value => typeof value?.prototype?.renderForwardedMessage === "function"
		&& typeof value.prototype.shouldComponentUpdate === "function", {searchExports: true});
	const forwardGuard = createMessageContentRevisionGuard({getView: id => plugin.getReceivedDisplayRuntimeView(id)});
	if (accessories) BDFDB.PatchUtils.patch(plugin, accessories.prototype, "shouldComponentUpdate", {after: event => {
		const next = event.methodArguments[0], message = next && next.message;
		if (!(message && (message.messageSnapshots || message.message_snapshots)?.length)) return;
		event.returnValue = !forwardGuard(event.instance.props, next, !event.returnValue);
	}});
	return !!(component || accessories);
}

module.exports = {createMessageContentRevisionGuard, installMessageContentRevisionGuard};
