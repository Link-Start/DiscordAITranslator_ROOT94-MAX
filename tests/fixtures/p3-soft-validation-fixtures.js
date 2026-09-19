"use strict";

// P3 soft-validation fixtures (synthetic; nothing here is a real message). Each row describes a
// received message the way the runtime sees it (content + embeds -> buildTranslationRequestText)
// and the way a provider might answer it: names, titles and site names echoed unchanged.

const EMBED_DIVIDER = "__________________ __________________ __________________";
const FIELD_VALUE_DIVIDER = "__________________";

const P3_FIXTURES = Object.freeze([
	Object.freeze({
		id: "f14-forward-embed-title-footer",
		shape: "embed-forward",
		content: "Forwarded from the community showcase: https://higgsfield.invalid/showcase/echoes",
		embeds: Object.freeze([Object.freeze({
			title: "ECHOES OF TOMORROW | Higgsfield Community",
			description: "A short film about memory and loss made with generative tools over one weekend.",
			fields: Object.freeze([]),
			footerText: "Higgsfield Community"
		})]),
		// Segments the provider is expected to echo unchanged (name-like: kept without repair).
		echoed: Object.freeze(["ECHOES OF TOMORROW", "Higgsfield Community"])
	}),
	Object.freeze({
		id: "f15-channel-name-line-with-link",
		shape: "text",
		content: "Atomic Gains\nhttps://www.youtube.invalid/watch?v=p3fixture\nThe new episode explains how creatine loading works for beginners.",
		embeds: Object.freeze([]),
		echoed: Object.freeze(["Atomic Gains"])
	}),
	Object.freeze({
		id: "f16-plain-sentence-echoed",
		shape: "text",
		content: "The committee will publish the revised financial aid requirements before the end of the month.",
		embeds: Object.freeze([]),
		// Not name-like: one repair is allowed, then the source text is kept.
		echoed: Object.freeze(["The committee will publish the revised financial aid requirements before the end of the month."])
	}),
	Object.freeze({
		id: "f17-missing-segment-hard-failure",
		shape: "text",
		content: "Hello world.\nFinancial aid requirements changed again this week.",
		embeds: Object.freeze([]),
		echoed: Object.freeze([])
	}),
	// Probe-only shapes closer to the field ledger: an embed with a title and a footer but no body
	// text, and a channel name posted on its own.
	Object.freeze({
		id: "f19-embed-title-footer-only",
		shape: "embed-forward",
		content: "https://higgsfield.invalid/showcase/echoes",
		embeds: Object.freeze([Object.freeze({title: "ECHOES OF TOMORROW | Higgsfield Community", description: "", fields: Object.freeze([]), footerText: "Higgsfield Community"})]),
		echoed: Object.freeze(["ECHOES OF TOMORROW", "Higgsfield Community"]),
		probeOnly: true
	}),
	Object.freeze({
		id: "f20-channel-name-only",
		shape: "text",
		content: "Atomic Gains",
		embeds: Object.freeze([]),
		echoed: Object.freeze(["Atomic Gains"]),
		probeOnly: true
	}),
	Object.freeze({
		id: "f18-all-protected-reply",
		shape: "text",
		content: "https://example.invalid/only-a-link <@123456789012345678>",
		embeds: Object.freeze([]),
		echoed: Object.freeze([])
	})
]);

function requestTextFor(fixture) {
	let text = fixture.content || "";
	for (const embed of fixture.embeds || []) {
		text += `\n${EMBED_DIVIDER}\n`;
		text += `${embed.title}\n${embed.description}`;
		for (const field of embed.fields || []) text += `\n\n${field.name}${FIELD_VALUE_DIVIDER}${field.value}`;
		if (embed.footerText) text += `\n${embed.footerText}`;
	}
	return text.trim();
}

function fixtureById(id) {
	const fixture = P3_FIXTURES.find(row => row.id === id);
	if (!fixture) throw new Error(`unknown P3 fixture ${id}`);
	return fixture;
}

module.exports = {EMBED_DIVIDER, FIELD_VALUE_DIVIDER, P3_FIXTURES, requestTextFor, fixtureById};
