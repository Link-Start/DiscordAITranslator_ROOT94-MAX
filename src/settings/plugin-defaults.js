// The plugin's settings schema and BDFDB patch-target lists, moved verbatim from
// onLoad in display-unification 5d. Both are registration contracts: a dropped
// key or patch target disables its feature silently, so the contract test pins
// them exactly.
function createPluginDefaults({messageTypes, languageTypes, defaultLanguages}) {
	const defaults = {
		general: {
			translationCacheLimit:		{value: 500, popout: false},
			interfaceLanguage:		{value: "system", 	popout: false},
			sendOriginalMessage:		{value: false, 	popout: false},
			showOriginalMessage:		{value: false, 	popout: false},
			showOriginalInReplyPreview:	{value: false, 	popout: false},
			useSpoilerInSentOriginal:	{value: false, 	popout: false},
			useSpoilerInReceivedOriginal:	{value: false, 	popout: false},
			highlightTranslatedMessages:	{value: true, 	popout: false},
			translatedTextColor:		{value: "#7cc7ff", popout: false},
			customTranslatedTextColors:	{value: [], popout: false},
			useSpoilerInOriginal:		{value: false, 	popout: false,	description: "Use Spoilers instead of Quotes for the original Message Text"}
		},
		choices: {},
		filters: {
			autoTranslateSourceLanguages:	{value: []},
			receivedAutoTranslateScope:	{value: "new_only"},
			receivedAutoTranslateLoadedRangeMode: {value: "count"},
			receivedAutoTranslateLoadedTimeWindow: {value: "1h"},
			receivedAutoTranslateLoadedLimit: {value: "50"},
			continueLoadedAutoTranslateOnScroll: {value: true},
			pauseLoadedAutoTranslateWhileScrolling: {value: true},
			receivedAutoTranslateSourceLanguages: {value: []},
			autoTranslateDecisionMode: {value: "basic"},
			aiAutoTranslatePrompt: {value: ""},
			aiPromptLibraryVersion: {value: 1},
			aiPromptLibrary: {value: []},
			aiPromptSelectedId: {value: "builtin"},
			aiPromptPreferencesEnabled: {value: true},
			languageDetectionStrategy: {value: "local_first"},
			skipMixedReceivedMessages:	{value: false},
			useLocalLanguagePrecheck:	{value: true},
			minimumAutoTranslateLength:	{value: 2},
		},
		exceptions: {
			wordStart:			{value: ["!"],	max: 3},
			protectedTerms:		{value: [],		max: 80},
			protectedTermsForSent:	{value: true},
			protectedTermsForReceived:	{value: true},
			wrapperPairs:		{value: ['"|"', '“|”', '`|`'], max: 20},
			wrapperPairsForSent:	{value: true},
			wrapperPairsForReceived:	{value: true}
		},
		prefixes: {
			translationPrefixData: 		{value: [
				{prefix: "$fr", language: "fr"},
				{prefix: "$de", language: "de"},
				{prefix: "$es", language: "es"},
				{prefix: "$jp", language: "ja"}
			]}
		},
		engines: {
			translator:			{value: "googleapi"},
			backup:				{value: "----"},
			// User-defined OpenAI-compatible providers: [{id: "custom-…"|"oaicompat", name}].
			customProviders:	{value: []}
		},
		performance: {
			historicalConcurrency: {value: "auto"},
			historicalSafetyDownshift: {value: true},
			liveConcurrency: {value: "1"},
			liveStreaming: {value: true},
			// W3 compile shadow of the compact D wire: "off" | "shadow". Internal key, no UI knob.
			compactWireShadow: {value: "off"}
		}
	};
	for (let m in messageTypes) defaults.choices[messageTypes[m]] = {value: Object.keys(languageTypes).reduce((newObj, l) => (newObj[languageTypes[l]] = defaultLanguages[l], newObj), {})};
	return defaults;
}

const MODULE_PATCHES = Object.freeze({
	before: Object.freeze([
		"ChannelTextAreaContainer",
		"ChannelTextAreaEditor",
		"Embed",
		"MessageReply",
		"Messages"
	]),
	after: Object.freeze([
		"ChannelTextAreaButtons",
		"ChannelThreadItem",
		"Embed",
		"HeaderBarChannelName",
		"HeaderBarTitle",
		"MessageReply",
		"MessageButtons",
		"MessageContent",
		"ThreadCard",
		"ThreadSidebar"
	])
});

module.exports = {createPluginDefaults, MODULE_PATCHES};
