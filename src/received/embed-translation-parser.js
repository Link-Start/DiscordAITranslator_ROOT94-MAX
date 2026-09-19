function useTranslatedValue(translated, original) {
	return translated != null && String(translated).trim() ? translated : original || "";
}

function hasValue(value) {
	return value != null && !!String(value).trim();
}

function parseFields(lines, originalFields) {
	const groups = lines.join("\n").trim().split(/\n\s*\n/).filter(Boolean);
	const parsed = groups.map(group => {
		const delimiterIndex = group.indexOf("__________________");
		return delimiterIndex < 0
			? {name: group, value: ""}
			: {name: group.slice(0, delimiterIndex), value: group.slice(delimiterIndex + 18)};
	});
	const complete = !originalFields.length || parsed.length === originalFields.length && originalFields.every((field, index) => (
		(!hasValue(field.name) || hasValue(parsed[index] && parsed[index].name))
		&& (!hasValue(field.value) || hasValue(parsed[index] && parsed[index].value))
	));
	if (!complete) return {fields: originalFields.map(field => ({name: field.name || "", value: field.value || ""})), complete, hasTranslatedContent: false};
	const fieldCount = originalFields.length || parsed.length;
	return {fields: Array.from({length: fieldCount}, (_, index) => ({
		name: useTranslatedValue(parsed[index] && parsed[index].name, originalFields[index] && originalFields[index].name),
		value: useTranslatedValue(parsed[index] && parsed[index].value, originalFields[index] && originalFields[index].value)
	})), complete, hasTranslatedContent: parsed.some(field => hasValue(field.name) || hasValue(field.value))};
}

function parseStoredEmbedTranslations({messageEmbeds = [], originalEmbeds = [], segments = []} = {}) {
	return messageEmbeds.reduce((translations, messageEmbed, index) => {
		if (!messageEmbed || !messageEmbed.id || index >= segments.length) return translations;
		const original = originalEmbeds[index] || {};
		const originalFields = Array.isArray(original.fields) ? original.fields : [];
		const lines = String(segments[index] || "").split("\n");
		const translatedTitle = lines.shift();
		const translatedDescription = lines.shift();
		const title = useTranslatedValue(translatedTitle, original.title);
		const description = useTranslatedValue(translatedDescription, original.description);
		const lastLine = lines[lines.length - 1] || "";
		const hasFieldLine = lines.some(line => line.includes("__________________"));
		const translatedFooter = original.footerText && (!originalFields.length || hasFieldLine && !lastLine.includes("__________________")) ? lines.pop() : "";
		const footerText = original.footerText ? useTranslatedValue(translatedFooter, original.footerText) : "";
		const parsedFields = parseFields(lines, originalFields);
		const complete = (!hasValue(original.title) || hasValue(translatedTitle))
			&& (!hasValue(original.description) || hasValue(translatedDescription))
			&& (!hasValue(original.footerText) || hasValue(translatedFooter))
			&& parsedFields.complete;
		const hasTranslatedContent = hasValue(translatedTitle) || hasValue(translatedDescription) || hasValue(translatedFooter) || parsedFields.hasTranslatedContent;
		translations[messageEmbed.id] = {title, description, fields: parsedFields.fields, footerText, complete, hasTranslatedContent};
		return translations;
	}, {});
}

module.exports = {parseStoredEmbedTranslations};
