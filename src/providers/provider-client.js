const {NAME_REPAIR_INSTRUCTION} = require("../planner/translation-source-context");
// Owns provider transport and credentials. Before this module the engine catalog,
// the authKeys map, every provider adapter and the 429/5xx backoff window all lived
// in the plugin factory closure, so any of the 9000 surrounding lines could reach a
// wire contract. Everything below talks to live third-party services: request shapes,
// headers, prompt text and response parsing are contracts, not implementation
// details. Changing a byte here silently breaks translation for real users.
//
// A client instance is per plugin instance, so a plugin restart drops the backoff
// window. Model catalog snapshots are restored through explicit persistence ports.

const {createWholeMarkerBatchCanary} = require("../orchestrator/whole-marker-batch-canary");
const {readBaiduCredentials, isBaiduCredentialComplete} = require("../settings/baidu-credentials");
const AI_SKIP_TRANSLATION_TOKEN = "__SKIP_TRANSLATION__";
const SYNTHETIC_BENCHMARK_TEXTS = Object.freeze([
	"Good morning! Are we still meeting at eight tonight?",
	"Please keep the API name, model ID, URL, and @mention unchanged.",
	"The update finished successfully, but I will check the logs once more before we continue.",
	"No worries — send me the final version when you are ready. 🙂",
	"This fixed benchmark uses the same synthetic chat messages in every run so response times can be compared fairly.",
	"Please translate this release note while keeping v2.4.1, #general, and the URL unchanged."
]);
const {
	normalizeReasoningMode,
	normalizeReasoningModelMode,
	resolveReasoningOnRaw,
	getReasoningRawAvailability,
	reconcileLegacyReasoningRaw,
	isLegacyReasoningEffort,
	deriveReasoningTierState,
	buildReasoningTierOptions,
	normalizeReasoningProfile,
	inferReasoningProfile,
	getReasoningProfileSpec,
	getReasoningProfileCandidates,
	isEquivalentReasoningCandidate,
	createReasoningCapabilityKey,
	createLegacyReasoningCapabilityKey,
	createReasoningSchemaId,
	createReasoningCapabilityCache,
	isUnsupportedReasoningFieldError,
	isUnsupportedReasoningValueError
} = require("./reasoning-control");
const {createOpenAiChatAdapter, createOpenAiResponsesAdapter, createOllamaNativeAdapter, createGeminiNativeAdapter, createAnthropicMessagesAdapter, createProtocolAdapterRegistry} = require("./protocol-adapters");
const {resolveCustomProtocol, createInterfaceDetection, getInterfaceEndpointKey} = require("./custom-protocol-resolution");
const {createOpenAiChatStreamRequest} = require("./openai-chat-stream-request");
const {TYPED_BATCH_PROMPT_VERSION, buildTypedBatchSystemPrompt, parseJsonPayloadCandidates, parseTypedPlanResponse, typedBatchItemPayload} = require("../planner/translation-plan-serializer");
const {readSemanticBatchAnswer} = require("../planner/semantic-batch-answer");
const {buildTranslationPreferenceBlock, LEGACY_DECISION_RULES} = require("../settings/translation-preferences");
const {combineWireObservationProbes} = require("../diagnostics/wire-observation-producer");

// Providers occasionally accept a request and then never answer. Without this window
// the queue's watchdog was the only thing that ever moved, minutes later.
const PROVIDER_REQUEST_TIMEOUT_MS = 30000;
// Base pauses for the two pressure signals; a 429 is a harder no than a 5xx.
const PROVIDER_RATE_LIMIT_BACKOFF_MS = 5000;
// The free web endpoint carries q in a form field. This is an encoded-length limit,
// not a JavaScript-character limit: one CJK character expands to nine characters
// when the request helper performs the single required form encoding.
const FREE_ENGINE_CHUNK_LIMIT = 1200;

// Lossless split: chunks always concatenate back to the exact input. Paragraph
// boundaries first, sentence boundaries inside an oversized paragraph, hard cuts
// only for a single sentence longer than the limit.
function splitTextIntoTranslationChunks(text, limit = FREE_ENGINE_CHUNK_LIMIT) {
	const value = String(text == null ? "" : text);
	const encodedLength = part => encodeURIComponent(part).length;
	const boundedLimit = Math.max(16, Number(limit) || FREE_ENGINE_CHUNK_LIMIT);
	if (encodedLength(value) <= boundedLimit) return [value];
	const units = [];
	const addHardSplit = part => {
		let hardPart = "";
		let hardLength = 0;
		// Wire-only DTA tokens are indivisible. A hard cut through one recreates the
		// exact missing-placeholder failure this splitter is meant to prevent.
		const symbols = part.match(/__DTA_\d+__|⟦\d+⟧|[\s\S]/gu) || [];
		for (const symbol of symbols) {
			const symbolLength = encodedLength(symbol);
			if (hardPart && hardLength + symbolLength > boundedLimit) {
				units.push(hardPart);
				hardPart = "";
				hardLength = 0;
			}
			hardPart += symbol;
			hardLength += symbolLength;
		}
		if (hardPart) units.push(hardPart);
	};
	for (const paragraphPart of value.split(/(\r?\n+)/)) {
		if (!paragraphPart) continue;
		if (encodedLength(paragraphPart) <= boundedLimit) {
			units.push(paragraphPart);
			continue;
		}
		for (const sentence of paragraphPart.split(/(?<=[.!?。！？；;])/)) {
			if (!sentence) continue;
			if (encodedLength(sentence) <= boundedLimit) units.push(sentence);
			else addHardSplit(sentence);
		}
	}
	const chunks = [];
	let current = "";
	let currentLength = 0;
	for (const unit of units) {
		const unitLength = encodedLength(unit);
		if (current && currentLength + unitLength > boundedLimit) {
			chunks.push(current);
			current = "";
			currentLength = 0;
		}
		current += unit;
		currentLength += unitLength;
	}
	if (current) chunks.push(current);
	return chunks.length ? chunks : [value];
}

function encodeGoogleFreeProtectionTokens(text) {
	return String(text == null ? "" : text).replace(/⟦(\d+)⟧/g, "__DTA_$1__");
}

function decodeGoogleFreeProtectionTokens(text) {
	return String(text == null ? "" : text).replace(/__\s*DTA\s*_\s*(\d+)\s*__/g, "⟦$1⟧");
}
const PROVIDER_SERVER_ERROR_BACKOFF_MS = 2000;
// Consecutive pressure doubles the pause; four doublings of the 429 base already
// exceed the ceiling, so the step cannot usefully grow past that.
const PROVIDER_BACKOFF_MAX_STEP = 4;
const PROVIDER_BACKOFF_MAX_MS = 60000;

const googleLanguages = ["af","am","ar","az","be","bg","bn","bs","ca","ceb","co","cs","cy","da","de","el","en","eo","es","et","eu","fa","fi","fr","fy","ga","gd","gl","gu","ha","haw","hi","hmn","hr","ht","hu","hy","id","ig","is","it","iw","ja","jw","ka","kk","km","kn","ko","ku","ky","la","lb","lo","lt","lv","mg","mi","mk","ml","mn","mr","ms","mt","my","ne","nl","no","ny","or","pa","pl","ps","pt","ro","ru","rw","sd","si","sk","sl","sm","sn","so","sq","sr","st","su","sv","sw","ta","te","tg","th","tk","tl","tr","tt","ug","uk","ur","uz","vi","xh","yi","yo","zh-CN","zh-TW","zu"];
const papagoLanguagePairs = Object.freeze([
	["ko", "en"], ["ko", "zh-CN"], ["ko", "zh-TW"], ["ko", "es"], ["ko", "fr"],
	["ko", "vi"], ["ko", "th"], ["ko", "id"], ["en", "ja"], ["en", "fr"]
].map(pair => Object.freeze(pair)));

function normalizePapagoLanguageCode(languageId) {
	const normalized = String(languageId || "").trim();
	if (/^zh[-_]cn$/i.test(normalized)) return "zh-CN";
	if (/^zh[-_]tw$/i.test(normalized)) return "zh-TW";
	return normalized.toLowerCase();
}

function isPapagoLanguagePairSupported(sourceLanguageId, targetLanguageId) {
	const source = normalizePapagoLanguageCode(sourceLanguageId);
	const target = normalizePapagoLanguageCode(targetLanguageId);
	return !!source && !!target && source !== target && papagoLanguagePairs.some(pair => pair[0] == source && pair[1] == target || pair[0] == target && pair[1] == source);
}

const translationEngines = {
	googleapi: {
		name: "Google",
		auto: true,
		funcName: "googleApiTranslate",
		languages: googleLanguages
	},
	googlecloud: {
		name: "Google Cloud Translation",
		auto: true,
		funcName: "googleCloudTranslate",
		languages: googleLanguages,
		key: "AIza...",
		endpoint: "https://translation.googleapis.com/language/translate/v2",
		model: "nmt"
	},
	microsoft: {
		name: "Azure Translator",
		auto: true,
		funcName: "microsoftTranslate",
		languages: ["af","am","ar","az","ba","bg","bn","bs","ca","cs","cy","da","de","el","en","es","et","eu","fa","fi","fil","fr","fr-CA","ga","gl","gu","ha","he","hi","hr","ht","hu","hy","id","ig","is","it","ja","ka","kk","km","kn","ko","ku","ky","lo","lt","lv","mg","mi","mk","ml","mr","ms","mt","my","ne","nl","or","pa","pl","ps","pt","pt-PT","ro","ru","rw","sd","si","sk","sl","sm","sn","so","sq","st","sv","sw","ta","te","th","tk","tr","tt","ug","uk","ur","uz","vi","xh","yo","zh-CN","zh-TW","zu"],
		parser: {
			"zh-CN": "zh-Hans",
			"zh-TW": "zh-Hant"
		},
		key: "Azure Translator key",
		endpoint: "https://api.cognitive.microsofttranslator.com/translate"
	},
	deepl: {
		name: "DeepL",
		auto: true,
		funcName: "deepLTranslate",
		languages: ["bg","cs","da","de","en","el","es","et","fi","fr","hu","id","it","ja","ko","lt","lv","nl","no","pl","pt","ro","ru","sk","sl","sv","tr","uk","zh"],
		premium: true,
		key: "DeepL API key"
	},
	deepseek: {
		name: "DeepSeek",
		auto: true,
		funcName: "deepSeekTranslate",
		languages: googleLanguages,
		key: "sk-...",
		endpoint: "https://api.deepseek.com/chat/completions",
		// deepseek-chat and deepseek-reasoner were retired; v4-flash is the cheap tier.
		model: "deepseek-v4-flash"
	},
	openai: {
		name: "OpenAI",
		auto: true,
		funcName: "openAiTranslate",
		languages: googleLanguages,
		key: "sk-...",
		endpoint: "https://api.openai.com/v1/responses",
		model: "gpt-5.6-luna"
	},
	gemini: {
		name: "Google Gemini",
		auto: true,
		funcName: "geminiTranslate",
		languages: googleLanguages,
		key: "AIza...",
		endpoint: "https://generativelanguage.googleapis.com/v1beta/models",
		model: "gemini-2.5-flash"
	},
	oaicompat: {
		name: "OpenAI Compatible",
		auto: true,
		funcName: "openAiCompatibleTranslate",
		languages: googleLanguages,
		key: "sk-...",
		endpoint: "https://your-provider.example/v1/chat/completions",
		model: "your-model-id"
	},
	papago: {
		name: "Papago",
		auto: true,
		funcName: "papagoTranslate",
		languages: ["en","es","fr","id","ja","ko","th","vi","zh-CN","zh-TW"],
		languagePairs: papagoLanguagePairs,
		key: "CLIENT_ID CLIENT_SECRET"
	},
	baidu: {
		name: "Baidu",
		auto: true,
		funcName: "baiduTranslate",
		languages: ["ar","bg","cs","da","de","el","en","es","et","fi","fr","hu","it","ja","ko","nl","pl","pt","ro","ru","sl","sv","th","vi","zh","zh-CN","zh-TW"],
		parser: {
			"ar": "ara",
			"bg": "bul",
			"da": "dan",
			"es": "spa",
			"et": "est",
			"fi": "fin",
			"fr": "fra",
			"ja": "jp",
			"ko": "kor",
			"ro": "rom",
			"sl": "slo",
			"sv": "swe",
			"vi": "vie",
			"zh": "zh",
			"zh-CN": "zh",
			"zh-TW": "cht"
		},
		key: "APP_ID SECRET_KEY"
	}
};

// Where a user goes to obtain the credential each engine asks for. Provider metadata,
// not plugin chrome: it changes when a provider changes its signup flow.
const enginePortals = {
	googleapi: {
		primaryUrl: "https://translate.google.com/",
		primaryLabelZh: "Google 翻译",
		primaryLabelEn: "Google Translate",
		hintZh: "Google 默认模式无需单独购买 API，可直接使用。",
		hintEn: "Google default mode does not require a separate paid API."
	},
	googlecloud: {
		primaryUrl: "https://cloud.google.com/free?hl=zh-cn",
		primaryLabelZh: "注册开通",
		primaryLabelEn: "Sign up",
		secondaryUrl: "https://cloud.google.com/translate?hl=zh-cn",
		secondaryLabelZh: "文档",
		secondaryLabelEn: "Docs"
	},
	microsoft: {
		primaryUrl: "https://azure.microsoft.com/zh-cn/free/",
		primaryLabelZh: "注册开通",
		primaryLabelEn: "Sign up",
		secondaryUrl: "https://azure.microsoft.com/zh-cn/products/ai-foundry/tools/translator",
		secondaryLabelZh: "文档",
		secondaryLabelEn: "Docs"
	},
	deepl: {
		primaryUrl: "https://www.deepl.com/pro-api",
		primaryLabelZh: "获取 API Key",
		primaryLabelEn: "Get API Key",
		secondaryUrl: "https://www.deepl.com/pro-api",
		secondaryLabelZh: "定价",
		secondaryLabelEn: "Pricing"
	},
	deepseek: {
		primaryUrl: "https://platform.deepseek.com/api_keys",
		primaryLabelZh: "获取 API Key",
		primaryLabelEn: "Get API Key",
		secondaryUrl: "https://api-docs.deepseek.com/zh-cn/",
		secondaryLabelZh: "文档",
		secondaryLabelEn: "Docs"
	},
	openai: {
		primaryUrl: "https://platform.openai.com/api-keys",
		primaryLabelZh: "获取 API Key",
		primaryLabelEn: "Get API Key",
		secondaryUrl: "https://developers.openai.com/api/docs/guides/migrate-to-responses",
		secondaryLabelZh: "文档",
		secondaryLabelEn: "Docs"
	},
	gemini: {
		primaryUrl: "https://aistudio.google.com/app/apikey",
		primaryLabelZh: "获取 API Key",
		primaryLabelEn: "Get API Key",
		secondaryUrl: "https://ai.google.dev/gemini-api/docs",
		secondaryLabelZh: "文档",
		secondaryLabelEn: "Docs"
	},
	oaicompat: {
		hintZh: "填写你自建或第三方 OpenAI 兼容服务的 API Key、接口地址和模型名。",
		hintEn: "Enter the API key, endpoint, and model for your self-hosted or third-party OpenAI-compatible service."
	},
	papago: {
		primaryUrl: "https://developers.naver.com/main/",
		primaryLabelZh: "开发者中心",
		primaryLabelEn: "Developers"
	},
	baidu: {
		primaryUrl: "https://fanyi-api.baidu.com/",
		secondaryUrl: "https://api.fanyi.baidu.com/doc/23",
		secondaryLabelZh: "文档",
		secondaryLabelEn: "Docs",
		primaryLabelZh: "开放平台",
		primaryLabelEn: "Open Platform"
	}
};

// Engines whose credentials must be present before the runtime will route to them.
const CREDENTIAL_REQUIRED_ENGINES = ["microsoft", "googlecloud", "deepl", "deepseek", "openai", "gemini", "oaicompat", "papago", "baidu"];
// Engines the settings panel can test with a live sample request.
const VALIDATABLE_ENGINES = ["googlecloud", "microsoft", "deepl", "deepseek", "openai", "gemini", "oaicompat"];
// LLM engines: they need an explicit model id and can list their models.
const AI_MODEL_ENGINES = ["deepseek", "openai", "gemini", "oaicompat"];

// User-defined OpenAI-compatible providers (the reference plugin's ai.custom
// pattern): each settings entry {id: "custom-…", name} becomes a live engine that
// behaves exactly like oaicompat but keeps its own credentials, model catalog and
// display name. "oaicompat" itself doubles as the migrated first slot, so existing
// selections and stored credentials keep working without any remapping.
const CUSTOM_ENGINE_ID_PATTERN = /^custom-[a-z0-9]+$/;
const OAICOMPAT_DEFAULT_NAME = "OpenAI Compatible";

function isCustomEngineKey(engineKey) {
	return CUSTOM_ENGINE_ID_PATTERN.test(String(engineKey || ""));
}

function isOpenAiCompatibleEngineKey(engineKey) {
	return engineKey == "oaicompat" || isCustomEngineKey(engineKey);
}

// Batch eligibility is a capability of AI engines, not a built-in whitelist.
// Custom AI platforms route through the same batch request machinery via their
// protocol adapters; machine translation engines have no JSON batch contract.
function isAiBatchCapableEngineKey(engineKey) {
	return ["deepseek", "openai", "gemini", "oaicompat"].includes(engineKey) || isCustomEngineKey(engineKey);
}

function createCustomEngineId() {
	return `custom-${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

function normalizeCustomProviders(value) {
	if (!Array.isArray(value)) return [];
	const seen = new Set();
	const entries = [];
	for (const entry of value) {
		if (!entry || typeof entry != "object") continue;
		const id = String(entry.id || "");
		if (id != "oaicompat" && !isCustomEngineKey(id)) continue;
		if (seen.has(id)) continue;
		seen.add(id);
		entries.push({id, name: typeof entry.name == "string" ? entry.name.trim().slice(0, 60) : ""});
	}
	return entries;
}

// Mutates the shared engine tables in place so every existing consumer - request
// dispatch, language building, configured checks, catalogs - sees custom engines
// through plain key lookups. Idempotent; called from setLanguages() on every
// engine-settings change.
function syncCustomEngines(enginesSettings) {
	const entries = normalizeCustomProviders(enginesSettings && enginesSettings.customProviders);
	const wantedIds = new Set(entries.map(entry => entry.id));
	for (const engineKey of Object.keys(translationEngines)) {
		if (!isCustomEngineKey(engineKey) || wantedIds.has(engineKey)) continue;
		delete translationEngines[engineKey];
		for (const list of [CREDENTIAL_REQUIRED_ENGINES, VALIDATABLE_ENGINES, AI_MODEL_ENGINES]) {
			const index = list.indexOf(engineKey);
			if (index >= 0) list.splice(index, 1);
		}
	}
	const oaicompatEntry = entries.find(entry => entry.id == "oaicompat");
	// An entry with no name stays empty so the UI can localize the fallback label.
	translationEngines.oaicompat.name = oaicompatEntry ? oaicompatEntry.name : OAICOMPAT_DEFAULT_NAME;
	translationEngines.oaicompat.custom = !!oaicompatEntry;
	for (const entry of entries) {
		if (entry.id == "oaicompat") continue;
		const existing = translationEngines[entry.id];
		translationEngines[entry.id] = Object.assign(existing || {}, {
			id: entry.id,
			name: entry.name,
			auto: true,
			custom: true,
			funcName: "openAiCompatibleTranslate",
			languages: googleLanguages,
			key: translationEngines.oaicompat.key,
			endpoint: translationEngines.oaicompat.endpoint,
			model: translationEngines.oaicompat.model
		});
		for (const list of [CREDENTIAL_REQUIRED_ENGINES, VALIDATABLE_ENGINES, AI_MODEL_ENGINES]) {
			if (!list.includes(entry.id)) list.push(entry.id);
		}
	}
	return entries;
}

// DeepSeek's v4 models think by default, and every thinking token is billed as output
// and waited on before the first character of the answer arrives. Translation gains
// nothing from a chain of thought, so the plugin asks for the non-thinking mode.
// Deepseek-only on purpose: "oaicompat" points at arbitrary OpenAI-compatible servers,
// and some reject a request carrying an unknown top-level field.
// https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
function engineRequestExtras(engineKey) {
	return engineKey === "deepseek" ? {thinking: {type: "disabled"}} : {};
}

// Baidu signs every request with MD5(appid + text + salt + secret); no dependency is
// worth adding for one signature, so the historical implementation moves verbatim.
function MD5(e) {
	function h(a, b) {
		var e = a & 2147483648, f = b & 2147483648, c = a & 1073741824, d = b & 1073741824, g = (a & 1073741823) + (b & 1073741823);
		return c & d ? g ^ 2147483648 ^ e ^ f : c | d ? g & 1073741824 ? g ^ 3221225472 ^ e ^ f : g ^ 1073741824 ^ e ^ f : g ^ e ^ f;
	}
	function k(a, b, c, d, e, f, g) {
		a = h(a, h(h(b & c | ~b & d, e), g));
		return h(a << f | a >>> 32 - f, b);
	}
	function l(a, b, c, d, e, f, g) {
		a = h(a, h(h(b & d | c & ~d, e), g));
		return h(a << f | a >>> 32 - f, b);
	}
	function m(a, b, d, c, e, f, g) {
		a = h(a, h(h(b ^ d ^ c, e), g));
		return h(a << f | a >>> 32 - f, b);
	}
	function n(a, b, d, c, e, f, g) {
		a = h(a, h(h(d ^ (b | ~c), e), g));
		return h(a << f | a >>> 32 - f, b);
	}
	function p(a) {
		var b = "", d = "", c;
		for (c = 0; 3 >= c; c++) d = a >>> 8 * c & 255, d = "0" + d.toString(16), b += d.substr(d.length - 2, 2);
		return b;
	}

	var f = [], q, r, s, t, a, b, c, d;
	e = function(a) {
		a = a.replace(/\r\n/g, "\n");
		for (var b = "", d = 0; d < a.length; d++) {
			var c = a.charCodeAt(d);
			128 > c ? b += String.fromCharCode(c) : (127 < c && 2048 > c ? b += String.fromCharCode(c >> 6 | 192) : (b += String.fromCharCode(c >> 12 | 224), b += String.fromCharCode(c >> 6 & 63 | 128)), b += String.fromCharCode(c & 63 | 128));
		}
		return b;
	}(e);
	f = function(b) {
		var a, c = b.length;
		a = c + 8;
		for (var d = 16 * ((a - a % 64) / 64 + 1), e = Array(d - 1), f = 0, g = 0; g < c;) a = (g - g % 4) / 4, f = g % 4 * 8, e[a] |= b.charCodeAt(g) << f, g++;
		a = (g - g % 4) / 4;
		e[a] |= 128 << g % 4 * 8;
		e[d - 2] = c << 3;
		e[d - 1] = c >>> 29;
		return e;
	}(e);
	a = 1732584193, b = 4023233417, c = 2562383102, d = 271733878;
	for (e = 0; e < f.length; e += 16) q = a, r = b, s = c, t = d, a = k(a, b, c, d, f[e + 0], 7, 3614090360), d = k(d, a, b, c, f[e + 1], 12, 3905402710), c = k(c, d, a, b, f[e + 2], 17, 606105819), b = k(b, c, d, a, f[e + 3], 22, 3250441966), a = k(a, b, c, d, f[e + 4], 7, 4118548399), d = k(d, a, b, c, f[e + 5], 12, 1200080426), c = k(c, d, a, b, f[e + 6], 17, 2821735955), b = k(b, c, d, a, f[e + 7], 22, 4249261313), a = k(a, b, c, d, f[e + 8], 7, 1770035416), d = k(d, a, b, c, f[e + 9], 12, 2336552879), c = k(c, d, a, b, f[e + 10], 17, 4294925233), b = k(b, c, d, a, f[e + 11], 22, 2304563134), a = k(a, b, c, d, f[e + 12], 7, 1804603682), d = k(d, a, b, c, f[e + 13], 12, 4254626195), c = k(c, d, a, b, f[e + 14], 17, 2792965006), b = k(b, c, d, a, f[e + 15], 22, 1236535329), a = l(a, b, c, d, f[e + 1], 5, 4129170786), d = l(d, a, b, c, f[e + 6], 9, 3225465664), c = l(c, d, a, b, f[e + 11], 14, 643717713), b = l(b, c, d, a, f[e + 0], 20, 3921069994), a = l(a, b, c, d, f[e + 5], 5, 3593408605), d = l(d, a, b, c, f[e + 10], 9, 38016083), c = l(c, d, a, b, f[e + 15], 14, 3634488961), b = l(b, c, d, a, f[e + 4], 20, 3889429448), a = l(a, b, c, d, f[e + 9], 5, 568446438), d = l(d, a, b, c, f[e + 14], 9, 3275163606), c = l(c, d, a, b, f[e + 3], 14, 4107603335), b = l(b, c, d, a, f[e + 8], 20, 1163531501), a = l(a, b, c, d, f[e + 13], 5, 2850285829), d = l(d, a, b, c, f[e + 2], 9, 4243563512), c = l(c, d, a, b, f[e + 7], 14, 1735328473), b = l(b, c, d, a, f[e + 12], 20, 2368359562), a = m(a, b, c, d, f[e + 5], 4, 4294588738), d = m(d, a, b, c, f[e + 8], 11, 2272392833), c = m(c, d, a, b, f[e + 11], 16, 1839030562), b = m(b, c, d, a, f[e + 14], 23, 4259657740), a = m(a, b, c, d, f[e + 1], 4, 2763975236), d = m(d, a, b, c, f[e + 4], 11, 1272893353), c = m(c, d, a, b, f[e + 7], 16, 4139469664), b = m(b, c, d, a, f[e + 10], 23, 3200236656), a = m(a, b, c, d, f[e + 13], 4, 681279174), d = m(d, a, b, c, f[e + 0], 11, 3936430074), c = m(c, d, a, b, f[e + 3], 16, 3572445317), b = m(b, c, d, a, f[e + 6], 23, 76029189), a = m(a, b, c, d, f[e + 9], 4, 3654602809), d = m(d, a, b, c, f[e + 12], 11, 3873151461), c = m(c, d, a, b, f[e + 15], 16, 530742520), b = m(b, c, d, a, f[e + 2], 23, 3299628645), a = n(a, b, c, d, f[e + 0], 6, 4096336452), d = n(d, a, b, c, f[e + 7], 10, 1126891415), c = n(c, d, a, b, f[e + 14], 15, 2878612391), b = n(b, c, d, a, f[e + 5], 21, 4237533241), a = n(a, b, c, d, f[e + 12], 6, 1700485571), d = n(d, a, b, c, f[e + 3], 10, 2399980690), c = n(c, d, a, b, f[e + 10], 15, 4293915773), b = n(b, c, d, a, f[e + 1], 21, 2240044497), a = n(a, b, c, d, f[e + 8], 6, 1873313359), d = n(d, a, b, c, f[e + 15], 10, 4264355552), c = n(c, d, a, b, f[e + 6], 15, 2734768916), b = n(b, c, d, a, f[e + 13], 21, 1309151649), a = n(a, b, c, d, f[e + 4], 6, 4149444226), d = n(d, a, b, c, f[e + 11], 10, 3174756917), c = n(c, d, a, b, f[e + 2], 15, 718787259), b = n(b, c, d, a, f[e + 9], 21, 3951481745), a = h(a, q), b = h(b, r), c = h(c, s), d = h(d, t);
	return (p(a) + p(b) + p(c) + p(d)).toLowerCase();
}

// H1 exports equality keys, never the configuration values which produced them. The
// canonical serializer makes object insertion order irrelevant; the domain prefix keeps
// these digests distinct from provider signatures and persisted translation-cache keys.
function canonicalHistoricalKeyValue(value) {
	if (value == null) return null;
	if (Array.isArray(value)) return value.map(canonicalHistoricalKeyValue);
	if (typeof value == "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalHistoricalKeyValue(value[key])]));
	if (typeof value == "number") return Number.isFinite(value) ? value : null;
	if (typeof value == "boolean") return value;
	return String(value);
}

function historicalAnonymousDigest(domain, value) {
	return MD5(`discord-ai-translator:h1:${domain}:v1\u0000${JSON.stringify(canonicalHistoricalKeyValue(value))}`).slice(0, 20);
}

function historicalItemSizeBucket(value) {
	const count = Math.max(0, Math.floor(Number(value)) || 0);
	if (!count) return "0";
	if (count === 1) return "1";
	if (count <= 4) return "2-4";
	if (count <= 10) return "5-10";
	if (count <= 25) return "11-25";
	if (count <= 50) return "26-50";
	if (count <= 100) return "51-100";
	return "101+";
}

function historicalMagnitudeBucket(value) {
	const count = Math.max(0, Math.floor(Number(value)) || 0);
	if (!count) return "0";
	if (count <= 1000) return "1-1k";
	if (count <= 4000) return "1k-4k";
	if (count <= 12000) return "4k-12k";
	if (count <= 32000) return "12k-32k";
	return "32k+";
}

function createHistoricalRequestKeyContract({
	engine = "",
	endpoint = "",
	credential = "",
	model = "",
	protocol = "",
	adapterVersion = 0,
	schemaVersion = 1,
	reasoningWire = null,
	promptVersion = "historical-batch-v1",
	languageRules = null,
	itemCount = 0,
	inputChars = 0,
	promptChars = 0
} = {}) {
	const transport = Object.freeze({
		engine: String(engine || "unknown"),
		endpointDigest: `ep1:${historicalAnonymousDigest("endpoint", endpoint)}`,
		credentialRevision: `cr1:${historicalAnonymousDigest("credential", credential)}`,
		modelDigest: `md1:${historicalAnonymousDigest("model", model)}`,
		protocol: String(protocol || "unknown"),
		adapterVersion: Math.max(0, Math.floor(Number(adapterVersion)) || 0),
		schemaVersion: Math.max(1, Math.floor(Number(schemaVersion)) || 1),
		reasoningWireDigest: `rw1:${historicalAnonymousDigest("reasoning-wire", reasoningWire)}`
	});
	const transportKey = `tk1:${historicalAnonymousDigest("transport", transport)}`;
	const workload = Object.freeze({
		promptVersionDigest: `pv1:${historicalAnonymousDigest("prompt-version", promptVersion)}`,
		languageRulesDigest: `lr1:${historicalAnonymousDigest("language-rules", languageRules)}`,
		itemSizeBucket: historicalItemSizeBucket(itemCount),
		charSizeBucket: historicalMagnitudeBucket(inputChars),
		tokenSizeBucket: historicalMagnitudeBucket(Math.ceil(Math.max(0, Number(promptChars) || 0) / 4))
	});
	const workloadKey = `wk1:${historicalAnonymousDigest("workload", {transportKey, workload})}`;
	return Object.freeze({transportKey, workloadKey, transport, workload});
}

function historicalUtf8ByteLength(value) {
	const text = String(value == null ? "" : value);
	try {if (typeof TextEncoder == "function") return new TextEncoder().encode(text).byteLength;}
	catch (error) {}
	try {return unescape(encodeURIComponent(text)).length;}
	catch (error) {return text.length;}
}

function diagnosticFreeTimingContext(value) {const copy = Object.assign({}, value || {}); for (const key of ["diagnosticRequestObserver", "diagnosticStageObserver", "wireObservationProbe", "usageFromBody", "historicalUsageFromBody"]) delete copy[key]; return copy;}

function ignoreObserverPromise(value) {if (value && typeof value.then == "function") Promise.resolve(value).catch(() => {}); return value;}

// Terminal request diagnostics share the existing anonymous digest and run only at dispatch.
function observeDiagnosticRequest(timingContext, body, role = timingContext && timingContext.role || "primary") {
 if (!timingContext || typeof timingContext.diagnosticRequestObserver != "function") return;
 try {const text = String(body == null ? "" : body); ignoreObserverPromise(timingContext.diagnosticRequestObserver({bodyBytes: historicalUtf8ByteLength(text), bodyIdentity: `bi1:${historicalAnonymousDigest("body", text)}`, role}));}
 catch (error) {}
}

function observeDiagnosticStage(timingContext, event) {
 if (!timingContext || typeof timingContext.diagnosticStageObserver != "function") return;
 try {ignoreObserverPromise(timingContext.diagnosticStageObserver(Object.freeze(event)));}
 catch (error) {}
}

function observePhysicalWire(timingContext, requestBody, {bodyBytesKnown = true} = {}) {
	const probe = timingContext && timingContext.wireObservationProbe;
	if (!probe || typeof probe.observe != "function") return null;
	try {const observation = probe.observe(typeof requestBody == "string" ? requestBody : JSON.stringify(requestBody == null ? "" : requestBody)); if (observation && typeof observation.then == "function") {ignoreObserverPromise(observation); return null;} return bodyBytesKnown ? observation : Object.freeze(Object.assign({}, observation, {requestBodyBytes: null}));}
	catch (error) {return null;}
}

function parseTimingUsage(timingContext, body) {
	const parser = timingContext && (timingContext.usageFromBody || timingContext.historicalUsageFromBody);
	if (typeof parser != "function") return null;
	try {const parsed = parser(body); if (parsed && typeof parsed.then == "function") {ignoreObserverPromise(parsed); return null;} return normalizeHistoricalUsage(parsed);}
	catch (error) {return null;}
}

function parseHistoricalResponseBody(body) {
	try {return typeof body == "string" ? JSON.parse(body) : body && typeof body == "object" ? body : null;}
	catch (error) {return null;}
}

function extractHistoricalReasoningWire(body) {
	const parsed = parseHistoricalResponseBody(body);
	if (!parsed) return null;
	const fields = {};
	for (const key of ["reasoning", "reasoning_effort", "effort", "enable_thinking", "thinking", "chat_template_kwargs"]) {
		if (Object.prototype.hasOwnProperty.call(parsed, key)) fields[key] = parsed[key];
	}
	if (parsed.generationConfig && Object.prototype.hasOwnProperty.call(parsed.generationConfig, "thinkingConfig")) fields.thinkingConfig = parsed.generationConfig.thinkingConfig;
	if (parsed.options && Object.prototype.hasOwnProperty.call(parsed.options, "think")) fields.think = parsed.options.think;
	return Object.keys(fields).length ? fields : null;
}

function parseHistoricalFinishReason(body) {
	const parsed = parseHistoricalResponseBody(body);
	if (!parsed) return null;
	const value = parsed.choices && parsed.choices[0] && parsed.choices[0].finish_reason != null ? parsed.choices[0].finish_reason
		: parsed.candidates && parsed.candidates[0] && parsed.candidates[0].finishReason != null ? parsed.candidates[0].finishReason
			: parsed.stop_reason != null ? parsed.stop_reason
				: parsed.done_reason != null ? parsed.done_reason
					: parsed.incomplete_details && parsed.incomplete_details.reason != null ? parsed.incomplete_details.reason
						: parsed.status != null ? parsed.status : null;
	if (value == null || value === "") return null;
	const text = String(value).toLowerCase();
	return /^[a-z0-9_.:-]{1,40}$/.test(text) ? text : "other";
}

function normalizeHistoricalUsage(usage) {
	if (!usage || typeof usage != "object") return null;
	const numberOrNull = value => value == null || !Number.isFinite(Number(value)) ? null : Math.max(0, Number(value));
	const normalized = {
		promptTokens: numberOrNull(usage.promptTokens),
		completionTokens: numberOrNull(usage.completionTokens),
		reasoningTokens: numberOrNull(usage.reasoningTokens)
	};
	return normalized.promptTokens == null && normalized.completionTokens == null && normalized.reasoningTokens == null ? null : normalized;
}

function isValidatableEngine(engineKey) {
	return VALIDATABLE_ENGINES.includes(engineKey);
}

function supportsModelCatalog(engineKey) {
	return AI_MODEL_ENGINES.includes(engineKey);
}

function isLocalOaiCompatibleHostname(hostname) {
	hostname = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
	if (hostname == "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) return true;
	if (hostname == "::1" || /^fe[89ab][0-9a-f]:/i.test(hostname)) return true;
	const octets = hostname.split(".");
	if (octets.length != 4 || octets.some(octet => !/^\d+$/.test(octet) || Number(octet) > 255)) return false;
	const first = Number(octets[0]);
	const second = Number(octets[1]);
	return first == 127 || first == 10 || first == 192 && second == 168 || first == 172 && second >= 16 && second <= 31 || first == 169 && second == 254;
}

function isAllowedOaiCompatibleEndpoint(endpoint) {
	try {
		const parsed = new URL(endpoint);
		if (parsed.protocol == "https:") return true;
		return parsed.protocol == "http:" && isLocalOaiCompatibleHostname(parsed.hostname);
	}
	catch (err) {
		return false;
	}
}

// Users paste whatever their provider's docs show them: a bare host, a `/v1` root, a
// full chat URL, sometimes with a trailing slash or a stray query. Each provider is
// coerced to the one path its adapter actually posts to.
function normalizeApiEndpoint(engineKey, endpoint, {format = null} = {}) {
	let normalized = (endpoint || "").trim() || translationEngines[engineKey] && translationEngines[engineKey].endpoint || "";
	if (!normalized) return "";
	if (/\s/.test(normalized)) return "";
	normalized = normalized.replace(/\/+$/, "");

	if (engineKey == "deepseek") {
		if (/\/v1$/i.test(normalized)) normalized = normalized.slice(0, -3);
		if (/\/v1\/chat\/completions$/i.test(normalized)) return normalized.replace(/\/v1\/chat\/completions$/i, "/chat/completions");
		if (/\/chat\/completions$/i.test(normalized)) return normalized;
		return `${normalized}/chat/completions`;
	}
	if (isOpenAiCompatibleEngineKey(engineKey)) {
		if (!isAllowedOaiCompatibleEndpoint(normalized)) return "";
		if (format == "anthropic_messages") {
			if (/\/v1\/messages$/i.test(normalized)) return normalized;
			if (/\/v1\/models$/i.test(normalized)) return normalized.replace(/\/v1\/models$/i, "/v1/messages");
			if (/\/v1$/i.test(normalized)) return `${normalized}/messages`;
			if (/^https?:\/\/[^/]+$/i.test(normalized)) return `${normalized}/v1/messages`;
			return normalized;
		}
		if (format == "gemini_native") {
			if (/\/models\/[^/]+:generateContent$/i.test(normalized)) return normalized.replace(/\/models\/[^/]+:generateContent$/i, "/models");
			if (/\/models\/[^/]+$/i.test(normalized)) return normalized.replace(/\/models\/[^/]+$/i, "/models");
			if (/\/models$/i.test(normalized)) return normalized;
			if (/\/v1beta$/i.test(normalized)) return `${normalized}/models`;
			if (/^https?:\/\/[^/]+$/i.test(normalized)) return `${normalized}/v1beta/models`;
			return normalized;
		}
		if (format == "ollama_native") {
			if (/\/api\/chat$/i.test(normalized)) return normalized;
			if (/\/api\/tags$/i.test(normalized)) return normalized.replace(/\/api\/tags$/i, "/api/chat");
			if (/\/api$/i.test(normalized)) return `${normalized}/chat`;
			if (/^https?:\/\/[^/]+$/i.test(normalized)) return `${normalized}/api/chat`;
			return normalized;
		}
		if (format == "openai_responses") {
			// The two OpenAI wire suffixes are the plugin's own derivations, so an explicit
			// format swaps in its sibling instead of posting the wrong protocol to it.
			// Unknown custom paths still pass through untouched.
			if (/\/chat\/completions$/i.test(normalized)) return normalized.replace(/\/chat\/completions$/i, "/responses");
			if (/\/responses$/i.test(normalized)) return normalized;
			if (/\/v1$/i.test(normalized)) return `${normalized}/responses`;
			if (/^https?:\/\/[^/]+$/i.test(normalized)) return `${normalized}/v1/responses`;
			return normalized;
		}
		if (format == "openai_chat" && /\/responses$/i.test(normalized)) return normalized.replace(/\/responses$/i, "/chat/completions");
		if (/\/chat\/completions$/i.test(normalized)) return normalized;
		if (/\/v1$/i.test(normalized)) return `${normalized}/chat/completions`;
		if (/^https?:\/\/[^/]+$/i.test(normalized)) return `${normalized}/v1/chat/completions`;
		return normalized;
	}
	if (engineKey == "openai") {
		if (/\/responses$/i.test(normalized)) return normalized;
		if (/\/v1$/i.test(normalized)) return `${normalized}/responses`;
		if (/^https?:\/\/[^/]+$/i.test(normalized)) return `${normalized}/v1/responses`;
		return normalized;
	}
	if (engineKey == "gemini") {
		return normalized.replace(/\/[^/]+:generateContent$/i, "").replace(/\/models\/[^/]+$/i, "/models");
	}
	if (engineKey == "microsoft") {
		normalized = normalized.replace(/\?.*$/, "");
		if (/\/translate$/i.test(normalized)) return normalized;
		return `${normalized}/translate`;
	}
	return normalized;
}

function getModelCatalogEndpoint(engineKey, endpoint, options = {}) {
	const normalized = normalizeApiEndpoint(engineKey, endpoint, options);
	if (!normalized) return "";
	if (options.format == "anthropic_messages" && /\/v1\/messages$/i.test(normalized)) return normalized.replace(/\/v1\/messages$/i, "/v1/models");
	if (options.format == "gemini_native") return normalized;
	if (options.format == "ollama_native" && /\/api\/chat$/i.test(normalized)) return normalized.replace(/\/api\/chat$/i, "/api/tags");
	if ((engineKey == "openai" || options.format == "openai_responses") && /\/responses$/i.test(normalized)) return normalized.replace(/\/responses$/i, "/models");
	if (engineKey == "gemini") return normalized;
	if (/\/chat\/completions$/i.test(normalized)) return normalized.replace(/\/chat\/completions$/i, "/models");
	return `${normalized.replace(/\/+$/, "")}/models`;
}

function isSameEndpointOrigin(left, right) {
	try {return new URL(String(left || "")).origin === new URL(String(right || "")).origin;}
	catch (error) {return false;}
}

function mapLanguageCodeForEngine(engineKey, languageId) {
	if (!languageId) return languageId;
	if (engineKey == "deepl") {
		if (languageId == "zh-CN" || languageId == "zh") return "ZH";
		if (languageId == "zh-TW") return "ZH-HANT";
		return languageId.toUpperCase();
	}
	return translationEngines[engineKey] && translationEngines[engineKey].parser && translationEngines[engineKey].parser[languageId] || languageId;
}

function getValidationRequestForEngine(_engineKey) {
	const request = {
		source: "en",
		target: "de",
		text: "Good morning"
	};
	return request;
}

// Providers disagree on where the human-readable reason lives; the panel shows
// whichever field this finds, and the raw prefix when the body is not even JSON.
function getValidationErrorDetails(body) {
	if (!body) return "";
	try {
		body = typeof body == "string" ? JSON.parse(body) : body;
	}
	catch (err) {
		return typeof body == "string" ? body.slice(0, 160) : "";
	}
	return body && body.error && (body.error.message || body.error.code) || body.message || body.error_msg || body.msg || "";
}

function stringifyProviderErrorBody(body) {
	if (!body) return "";
	if (typeof body == "string") return body.slice(0, 4000);
	try {return JSON.stringify(body).slice(0, 4000);}
	catch (error) {return "";}
}

function classifyInvalidRequestBody(body) {
	const text = stringifyProviderErrorBody(body);
	const rejectsFieldOrValue = /unknown\s+(?:parameter|field|argument)|unrecognized(?:\s+request)?\s+(?:parameter|field|argument)|unsupported\s+(?:parameter|field|argument|value)|not\s+(?:a\s+)?valid|not\s+supported|invalid\s+(?:value|enum)|must\s+be\s+one\s+of|unexpected\s+keyword|extra inputs are not permitted|extra_forbidden/i;
	if (/\b(?:temperature|top[_ -]?p|top[_ -]?k|max[_ -]?(?:tokens|output[_ -]?tokens))\b/i.test(text) && rejectsFieldOrValue.test(text)) return "sampling_conflict";
	if (/invalid\s+(?:value|enum)|unsupported\s+value|must\s+be\s+one\s+of|not\s+(?:a\s+)?valid(?:\s+(?:value|enum))?|value\s+is\s+not\s+permitted/i.test(text)) return "unsupported_value";
	if (/unknown\s+(?:parameter|field|argument)|unrecognized(?:\s+request)?\s+(?:parameter|field|argument)|unsupported\s+(?:parameter|field|argument)|unexpected\s+keyword|extra inputs are not permitted|extra_forbidden/i.test(text)) return "unsupported_field";
	if (/invalid\s+(?:request\s+)?(?:body|schema|format)|schema\s+(?:error|validation)|(?:messages?|contents?|input)\s+(?:is\s+)?(?:missing|required|invalid|malformed)/i.test(text)) return "schema";
	return "invalid_request";
}

const SAFE_PROVIDER_ERROR_PARAMETERS = Object.freeze([
	"reasoning_effort", "reasoning", "effort", "enable_thinking", "chat_template_kwargs", "thinking",
	"temperature", "top_p", "top_k", "max_tokens", "max_output_tokens",
	"messages", "contents", "instructions", "input", "system", "model"
]);

function getSafeProviderErrorParameter(body) {
	const text = stringifyProviderErrorBody(body);
	for (const parameter of SAFE_PROVIDER_ERROR_PARAMETERS) {
		const escaped = parameter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		if (new RegExp(`(^|[^A-Za-z0-9_])${escaped}(?=$|[^A-Za-z0-9_])`, "i").test(text)) return parameter;
	}
	return "";
}

function classifyProviderRequestError(error, response, body, {timedOut = false, treatHttp504AsTimeout = false} = {}) {
	const statusCode = response && Number(response.statusCode) || null;
	if (timedOut || statusCode == 408 || treatHttp504AsTimeout && statusCode == 504) return "timeout";
	if (statusCode == 401 || statusCode == 403) return "auth";
	if (statusCode == 404) return "not_found";
	if (statusCode == 400 || statusCode == 422) return classifyInvalidRequestBody(body);
	if (statusCode == 429) return "rate_limit";
	if (statusCode && statusCode >= 500) return "server";
	if (statusCode && statusCode != 200) return "invalid_request";
	if (error) return "network";
	return null;
}

function getCredentialRedactionValues(authKeys) {
	const values = [];
	for (const auth of Object.values(authKeys || {})) {
		for (const field of ["appId", "secretKey"]) if (auth && typeof auth[field] == "string") values.push(auth[field].trim());
		const credential = auth && typeof auth.key == "string" ? auth.key.trim() : "";
		if (!credential) continue;
		values.push(credential, ...credential.split(/\s+/));
	}
	return Array.from(new Set(values.filter(Boolean))).sort((left, right) => right.length - left.length);
}

function redactProviderCredentials(value, authKeys) {
	let redacted = value == null ? "" : String(value);
	for (const credential of getCredentialRedactionValues(authKeys)) {
		if (credential.length >= 4) redacted = redacted.split(credential).join("[REDACTED]");
		else {
			const escaped = credential.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			redacted = redacted.replace(new RegExp(`(^|[^A-Za-z0-9_-])${escaped}(?=$|[^A-Za-z0-9_-])`, "g"), (_match, prefix) => `${prefix}[REDACTED]`);
		}
	}
	return redacted;
}

// The leading tabs inside these template literals are part of the prompt the provider
// receives. They came from the class-body indentation this code used to sit at, so
// they are pinned here by hand rather than by the surrounding indentation.
function buildAiProviderTranslationPrompt(data) {
	if (data && data.semanticRequest && data.semanticRequest.wire) return {system: String(data.semanticRequest.systemPrompt || ""), prompt: String(data.semanticRequest.wire)};
	const decisionInstruction = data.autoDecision ? `
				Auto-translate decision rules:
				${data.decisionPrompt || ""}
				If the message should not be translated, return exactly ${AI_SKIP_TRANSLATION_TOKEN}.
				` : "";
	const targetLanguageName = data.output.name || data.output.id;
	const translationModeInstruction = data.autoDecision ? `
				Auto-translate mode: translate only natural-language content that is not already in ${targetLanguageName}; already-target-language content may stay unchanged according to the decision rules.
				` : `
				Manual translation mode: translate the entire natural-language message into ${targetLanguageName}. Do not keep non-target natural-language text as-is. Preserve only URLs, code, mentions, emoji, IDs, and protected placeholders.
				`;
	return {
		system: data.autoDecision ? "You are a senior bilingual localization specialist and Discord chat translation decision assistant" : "You are a senior bilingual localization specialist",
		prompt: `
				You are a professional localization expert. The target language is exactly ${targetLanguageName}. Do not infer the target language from the source text or from existing bilingual/spoiler content.
				${translationModeInstruction}
				Rules:
				1. Return ONLY the translation without any explanations
				2. Output language must be exactly ${targetLanguageName}; do not output any other language except preserved protected content
				3. Use natural, fluent language
				4. Maintain consistent terminology for technical/game terms
				5. Keep proper nouns/product/game/model names as-is by default; use official/common names in ${targetLanguageName} when clearly established
				6. Preserve the original tone and style
				7. Do not omit any source content, including short interjections, laughter, particles, repeated words, or standalone short lines; translate or preserve them naturally in the target language.
				8. Use concise sentence structures
				9. Convert [NEWLINE] markers to actual line breaks (don't show them literally)
				10. Preserve placeholders like ⟦0⟧, ⟦1⟧ exactly; they are protected mentions/links/emoji/code.
				${decisionInstruction}${buildTranslationPreferenceBlock(data.preferencePrompt)}
				Text to translate:
				${data.text.replace(/\n/g, " [NEWLINE] ").replace(/\s+/g, " ")}
				`
	};
}

// Responses API, chat completions and the odd proxy that only sets output_text all
// answer here; the first shape that yields text wins.
function parseOpenAiResponseText(body) {
	try {body = typeof body == "string" ? JSON.parse(body) : body;}
	catch (error) {return "";}
	if (body && typeof body.output_text == "string") return body.output_text.trim();
	const outputParts = [];
	for (const item of body && body.output || []) for (const content of item && item.content || []) if (content && typeof content.text == "string") outputParts.push(content.text);
	if (outputParts.length) return outputParts.join("").trim();
	return body && body.choices && body.choices[0] && body.choices[0].message && typeof body.choices[0].message.content == "string" ? body.choices[0].message.content.trim() : "";
}

function parseOpenAiResponseUsage(body) {
	try {body = typeof body == "string" ? JSON.parse(body) : body;}
	catch (error) {return null;}
	const usage = body && body.usage;
	if (!usage || typeof usage != "object") return null;
	const numberOrNull = value => value == null || !Number.isFinite(Number(value)) ? null : Math.max(0, Number(value));
	const promptTokens = numberOrNull(usage.prompt_tokens != null ? usage.prompt_tokens : usage.input_tokens);
	const completionTokens = numberOrNull(usage.completion_tokens != null ? usage.completion_tokens : usage.output_tokens);
	const reasoningTokens = numberOrNull(
		usage.completion_tokens_details && usage.completion_tokens_details.reasoning_tokens != null
			? usage.completion_tokens_details.reasoning_tokens
			: usage.output_tokens_details && usage.output_tokens_details.reasoning_tokens
	);
	if (promptTokens == null && completionTokens == null && reasoningTokens == null) return null;
	return Object.freeze({promptTokens, completionTokens, reasoningTokens});
}

function parseGeminiResponseText(body) {
	try {body = typeof body == "string" ? JSON.parse(body) : body;}
	catch (error) {return "";}
	return ((body && body.candidates && body.candidates[0] && body.candidates[0].content && body.candidates[0].content.parts) || [])
		.map(part => part && typeof part.text == "string" ? part.text : "")
		.join("")
		.trim();
}

// Models wrap the array in prose or a fence no matter how the prompt is worded, so the
// array is cut out before parsing. An id the batch never asked for, or one answered
// twice, is dropped rather than guessed at: a wrong translation would be pasted onto
// somebody else's message.
function parseAiBatchTranslationResponse(content, expectedIds = null) {
	content = (content || "").trim();
	if (!content) return null;
	content = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
	const firstArray = content.indexOf("[");
	const lastArray = content.lastIndexOf("]");
	if (firstArray > -1 && lastArray > firstArray) content = content.slice(firstArray, lastArray + 1);
	try {
		let parsed = JSON.parse(content);
		if (parsed && Array.isArray(parsed.translations)) parsed = parsed.translations;
		if (!Array.isArray(parsed)) return null;
		const expectedIdSet = expectedIds ? new Set(Array.from(expectedIds, id => String(id))) : null;
		const duplicateIds = new Set();
		return parsed.reduce((dict, item) => {
			if (!item || item.id == null) return dict;
			const id = String(item.id);
			if (expectedIdSet && !expectedIdSet.has(id)) return dict;
			if (duplicateIds.has(id) || Object.prototype.hasOwnProperty.call(dict, id)) {
				duplicateIds.add(id);
				delete dict[id];
				return dict;
			}
			const value = item.translation != null ? item.translation : item.text;
			dict[id] = value == null ? "" : String(value);
			return dict;
		}, {});
	}
	catch (err) {return null;}
}

const MODEL_CATALOG_MAX_ITEMS = 250;
const MODEL_CATALOG_MAX_ID_LENGTH = 240;

function getModelCatalogPersistenceKey(value) {
	try {
		const url = new URL(String(value || ""));
		url.username = "";
		url.password = "";
		url.search = "";
		url.hash = "";
		return url.toString();
	}
	catch (error) {return "";}
}

function normalizeStoredModelCatalogs(value) {
	if (!value || typeof value != "object" || Array.isArray(value)) return {};
	const normalized = {};
	for (const engineKey of Object.keys(value)) {
		if (!AI_MODEL_ENGINES.includes(engineKey) && !isCustomEngineKey(engineKey)) continue;
		const entry = value[engineKey];
		if (!entry || typeof entry != "object" || Array.isArray(entry)) continue;
		const items = [...new Set((Array.isArray(entry.items) ? entry.items : [])
			.filter(item => typeof item == "string")
			.map(item => item.trim())
			.filter(item => item && item.length <= MODEL_CATALOG_MAX_ID_LENGTH))]
			.slice(0, MODEL_CATALOG_MAX_ITEMS);
		if (!items.length) continue;
		const endpoint = getModelCatalogPersistenceKey(entry.endpoint).slice(0, 2048);
		const fetchedAt = Number.isFinite(Number(entry.fetchedAt)) ? Number(entry.fetchedAt) : 0;
		normalized[engineKey] = {loading: false, items, endpoint, fetchedAt};
	}
	return normalized;
}

const openAiChatProtocolAdapter = createOpenAiChatAdapter({
	normalizeEndpoint: endpoint => normalizeApiEndpoint("oaicompat", endpoint, {format: "openai_chat"}),
	getCatalogEndpoint: endpoint => getModelCatalogEndpoint("oaicompat", endpoint, {format: "openai_chat"}),
	parseText: parseOpenAiResponseText,
	parseUsage: parseOpenAiResponseUsage,
	parseBatch: (body, expectedIds) => parseAiBatchTranslationResponse(parseOpenAiResponseText(body), expectedIds)
});
const openAiResponsesProtocolAdapter = createOpenAiResponsesAdapter({
	normalizeEndpoint: endpoint => normalizeApiEndpoint("oaicompat", endpoint, {format: "openai_responses"}),
	getCatalogEndpoint: endpoint => getModelCatalogEndpoint("oaicompat", endpoint, {format: "openai_responses"}),
	parseText: parseOpenAiResponseText,
	parseUsage: parseOpenAiResponseUsage,
	parseBatch: (body, expectedIds) => parseAiBatchTranslationResponse(parseOpenAiResponseText(body), expectedIds)
});
const ollamaNativeProtocolAdapter = createOllamaNativeAdapter({
	normalizeEndpoint: endpoint => normalizeApiEndpoint("oaicompat", endpoint, {format: "ollama_native"}),
	getCatalogEndpoint: endpoint => getModelCatalogEndpoint("oaicompat", endpoint, {format: "ollama_native"}),
	parseBatch: (body, expectedIds) => parseAiBatchTranslationResponse(ollamaNativeProtocolAdapter.parseText(body), expectedIds)
});
const geminiNativeProtocolAdapter = createGeminiNativeAdapter({
	normalizeEndpoint: endpoint => normalizeApiEndpoint("oaicompat", endpoint, {format: "gemini_native"}),
	getCatalogEndpoint: endpoint => getModelCatalogEndpoint("oaicompat", endpoint, {format: "gemini_native"}),
	parseBatch: (body, expectedIds) => parseAiBatchTranslationResponse(geminiNativeProtocolAdapter.parseText(body), expectedIds)
});
const anthropicMessagesProtocolAdapter = createAnthropicMessagesAdapter({
	normalizeEndpoint: endpoint => normalizeApiEndpoint("oaicompat", endpoint, {format: "anthropic_messages"}),
	getCatalogEndpoint: endpoint => getModelCatalogEndpoint("oaicompat", endpoint, {format: "anthropic_messages"}),
	parseBatch: (body, expectedIds) => parseAiBatchTranslationResponse(anthropicMessagesProtocolAdapter.parseText(body), expectedIds)
});
const customProtocolAdapterRegistry = createProtocolAdapterRegistry([openAiChatProtocolAdapter, openAiResponsesProtocolAdapter, ollamaNativeProtocolAdapter, geminiNativeProtocolAdapter, anthropicMessagesProtocolAdapter]);

function getCustomProtocolResolution(engineKey, auth = {}) {
	if (!isOpenAiCompatibleEngineKey(engineKey)) return null;
	return resolveCustomProtocol({
		endpoint: auth.endpoint || translationEngines[engineKey] && translationEngines[engineKey].endpoint || "",
		interfaceFormat: auth.interfaceFormat,
		interfaceDetection: auth.interfaceDetection,
		registry: customProtocolAdapterRegistry
	});
}

function getCustomProtocolAdapter(engineKey, auth = {}) {
	const resolution = getCustomProtocolResolution(engineKey, auth);
	return resolution ? customProtocolAdapterRegistry.get(resolution.resolved) || openAiChatProtocolAdapter : null;
}

function getRegisteredCustomProtocolAdapterIds() {
	return customProtocolAdapterRegistry.list().map(adapter => adapter.id);
}

function getRegisteredCustomProtocolAdapters({uiReadyOnly = false} = {}) {
	return customProtocolAdapterRegistry.list({uiReadyOnly}).map(adapter => Object.freeze({
		id: adapter.id,
		version: adapter.version || 1,
		uiReady: !!adapter.uiReady,
		labelKey: adapter.ui && adapter.ui.labelKey || "",
		credentialPlaceholderKey: adapter.ui && adapter.ui.credentialPlaceholderKey || "",
		capabilities: adapter.capabilities || Object.freeze({}),
		credentialPolicy: adapter.credentialPolicy || "required",
		reasoningFamilies: adapter.reasoningFamilies || Object.freeze([]),
		supportedEfforts: adapter.supportedEfforts || Object.freeze([]),
		reasoningControl: adapter.reasoningControl || null
	}));
}

function createProviderClient({
	// The HTTP function, shaped like BDFDB.LibraryRequires.request:
	// (url, options, (error, response, body) => void).
	request = (_url, _options, callback) => callback(new Error("no request function"), null, ""),
	// Plugin-scoped timers (BDFDB.TimeUtils.timeout/clear) so a plugin stop cancels an
	// in-flight request window.
	setTimeout = (callback, delay) => globalThis.setTimeout(callback, delay),
	clearTimeout = timer => globalThis.clearTimeout(timer),
	// Deliberately NOT the plugin-scoped timer: a backoff wait that a plugin stop
	// cancelled would leave its awaiting promise pending forever.
	sleep = ms => new Promise(resolve => globalThis.setTimeout(resolve, ms)),
	now = Date.now,
	getAuthKeys = () => ({}),
	saveAuthKeys = () => {},
	// The settings store owns raw-value tagging; it is injected rather than duplicated
	// so a number and its spelling can never disagree between storage and cache keys.
	createReasoningRawKey = () => "",
	getReasoningModelPref = () => null,
	setReasoningModelPref = () => null,
	setReasoningModelCapability = () => null,
	setReasoningModelTierState = () => null,
	clearReasoningModelCapability = () => null,
	setInterfaceDetection = () => null,
	clearInterfaceDetection = () => false,
	loadModelCatalogs = () => ({}),
	saveModelCatalogs = () => {},
	// The plugin's language table, used to name the source language a provider detected.
	getLanguages = () => ({}),
	notify = () => null,
	getLabels = () => ({}),
	getCustomText = () => "",
	getEngineLabel = engineKey => translationEngines[engineKey] && translationEngines[engineKey].name || engineKey,
	shouldUseAiAutoTranslateDecision = () => false,
	getAiAutoTranslatePrompt = () => "",
	beginLatencyRequest = () => null,
	recordLatencyEvent = () => null,
	recordSemanticObservation = () => null,
	recordAttemptOutcome = () => null,
	// Prewired in F2a: the first production stream adapter consumes this exact owner.
	// Existing callback transports remain unchanged until that adapter is enabled.
	providerAttemptOwner = null,
	streamTransport = null,
	isLiveStreamingEnabled = () => true,
	// W3 compact-wire shadow: receives {requests, typedBatchBytes, typedPromptBytes, itemCount}
	// for each semantic history batch. Never influences the request.
	observeCompactWireShadowBatch = null,
	compileWholeMarkerBatchItem = () => null,
	wholeMarkerBatchValidation = () => ({}),
	isWholeMarkerBatchItemCurrent = () => true,
	generateId = () => String(Date.now()),
	// The settings panel must know an endpoint was rewritten under it.
	onEndpointNormalized = () => {},
	// Opening a backoff window is also the queue's cue to re-arm its retry.
	onBackoffScheduled = () => {}
} = {}) {
	const wholeMarkerBatchCanary = createWholeMarkerBatchCanary({now, setTimeout, clearTimeout, compile: compileWholeMarkerBatchItem, validation: wholeMarkerBatchValidation, itemCurrent: isWholeMarkerBatchItemCurrent});
	let backoffUntil = 0;
	let backoffStep = 0;
	let modelCatalogState = normalizeStoredModelCatalogs(loadModelCatalogs());
	const reasoningCapabilityCache = createReasoningCapabilityCache({capacity: 20, now});
	let syntheticBenchmarkGeneration = 0;
	const openAiChatStreamRequest = streamTransport && providerAttemptOwner ? createOpenAiChatStreamRequest({transport: streamTransport, attemptOwner: providerAttemptOwner, now}) : null;
	const openAiChatStreamCapabilities = new Map();

	function toast(message, options) {
		const safeMessage = options && options.type == "danger" ? redactProviderCredentials(message, getAuthKeys()) : message;
		return notify(safeMessage, options);
	}

	// A chunked batch hitting a dead provider fails every chunk with the same error;
	// the user needs the message once, not once per chunk (2026-08-19: three
	// identical quota popups). Only exact repeats inside the window stay silent.
	const DANGER_TOAST_DEDUP_MS = 10000;
	let lastDangerToast = {message: "", at: 0};

	function dangerToast(message) {
		message = redactProviderCredentials(message, getAuthKeys());
		const timestamp = now();
		if (message === lastDangerToast.message && timestamp - lastDangerToast.at < DANGER_TOAST_DEDUP_MS) return null;
		lastDangerToast = {message, at: timestamp};
		return toast(message, {type: "danger", position: "center"});
	}

	// Escalates while a window is already open (consecutive provider pressure) and
	// starts over once a window has fully expired. There is no success signal: a good
	// response does not shorten an open window, it just stops extending it.
	function scheduleBackoff(ms) {
		if (!ms) return;
		const timestamp = now();
		if (backoffUntil > timestamp) backoffStep = Math.min(backoffStep + 1, PROVIDER_BACKOFF_MAX_STEP);
		else backoffStep = 0;
		const scaledMs = Math.min(ms * Math.pow(2, backoffStep), PROVIDER_BACKOFF_MAX_MS);
		backoffUntil = Math.max(backoffUntil || 0, timestamp + scaledMs);
		onBackoffScheduled();
	}

	function retryAfterMsFromResponse(response) {
		let raw = "";
		try {raw = String(response && response.headers && typeof response.headers.get == "function" ? response.headers.get("retry-after") || "" : response && response.headers && response.headers["retry-after"] || "").trim();}
		catch (error) {raw = "";}
		if (!raw) return null;
		if (/^\d+(?:\.\d+)?$/.test(raw)) return Math.max(0, Math.ceil(Number(raw) * 1000));
		const date = Date.parse(raw);
		return Number.isFinite(date) ? Math.max(0, Math.ceil(date - now())) : null;
	}

	function awaitBackoff() {
		const waitMs = (backoffUntil || 0) - now();
		if (waitMs <= 0) return Promise.resolve();
		return sleep(waitMs);
	}

	// Wraps the HTTP function with a hard timeout and centralized 429/5xx backoff. On
	// timeout it synthesizes a 504 response (no error) so existing statusCode-based
	// handlers keep working, and guards against double callbacks.
	function requestWithTimeout(url, options, callback, timeoutMs = PROVIDER_REQUEST_TIMEOUT_MS, timingContext = null) {
		let done = false;
		let timer = null;
		let startedAt = now();
		let historicalObserver = null;
		let admissionLease = null;
		let wireObservation = null;
		const historicalAdmission = timingContext && timingContext.historicalAdmission;
		const historicalEnabled = !!(historicalAdmission || timingContext && (timingContext.historicalObserver || timingContext.historicalAttemptFactory));
		const seed = timingContext && timingContext.historicalKeySeed || (historicalEnabled ? createFallbackHistoricalKeySeed(url, options, timingContext) : {});
		const bodyBytes = historicalEnabled ? historicalRequestPayloadBytes(options) : 0;
		const contract = historicalEnabled ? createHistoricalRequestKeyContract(Object.assign({}, seed, {reasoningWire: extractHistoricalReasoningWire(options && options.body)})) : null;
		if (contract && timingContext && typeof timingContext.historicalContractObserver == "function") {
			try {ignoreObserverPromise(timingContext.historicalContractObserver(contract));}
			catch (error) {}
		}
		if (contract && timingContext && timingContext.historicalSampleObserver && typeof timingContext.historicalSampleObserver.onContract == "function") {
			try {ignoreObserverPromise(timingContext.historicalSampleObserver.onContract(contract, {bodyBytes, promptChars: Math.max(0, Number(seed.promptChars) || 0), inputChars: Math.max(0, Number(seed.inputChars) || 0)}));}
			catch (error) {}
		}
		const requestObservation = contract && Object.freeze({
			transportKey: contract.transportKey,
			workloadKey: contract.workloadKey,
			transport: contract.transport,
			workload: contract.workload,
			bodyBytes,
			promptChars: Math.max(0, Number(seed.promptChars) || 0),
			inputChars: Math.max(0, Number(seed.inputChars) || 0),
			headers: null,
			ttftMs: null,
			physicalAbort: null
		});
		const finish = (error, response, body, timedOut = false) => {
			if (done) return;
			done = true;
			const settledAt = now();
			if (timer) clearTimeout(timer);
			const statusCode = response && response.statusCode;
			if (!historicalAdmission) {
				if (statusCode == 429) scheduleBackoff(PROVIDER_RATE_LIMIT_BACKOFF_MS);
				else if (statusCode && statusCode >= 500) scheduleBackoff(PROVIDER_SERVER_ERROR_BACKOFF_MS);
			}
			const providerUsage = !error && statusCode == 200 ? parseTimingUsage(timingContext, body) : null;
			let latencyRecord = null;
			let measuredOutputChars = null;
			let normalizedStatus = "unknown";
			let normalizedErrorClass = null;
			if (timingContext && timingContext.token) {
				const errorClass = classifyProviderRequestError(error, response, body, {timedOut});
				let status = "ok";
				if (errorClass == "timeout") status = "timeout";
				else if (statusCode && statusCode != 200) status = `http_${statusCode}`;
				else if (error) status = "network";
				let outputChars = null;
				if (!error && statusCode == 200 && typeof timingContext.outputCharsFromBody == "function") {
					try {
						const measured = timingContext.outputCharsFromBody(body);
						if (measured != null) outputChars = Math.max(0, Number(measured) || 0);
					}
					catch (err) {outputChars = null;}
				}
				latencyRecord = recordLatencyEvent(Object.assign(diagnosticFreeTimingContext(timingContext), {
					transportMs: Math.max(0, settledAt - startedAt),
					status,
					httpStatus: statusCode || null,
					errorClass,
					outputChars,
					finishedAt: settledAt
				}, providerUsage ? {usage: providerUsage} : {}, wireObservation ? {wireObservation} : {}));
				measuredOutputChars = outputChars;
				normalizedStatus = status;
				normalizedErrorClass = errorClass;
			}
			const historicalUsage = providerUsage;
			const historicalSettleEvent = Object.freeze({
						providerRequestId: latencyRecord && latencyRecord.requestId != null ? latencyRecord.requestId : timingContext && timingContext.token && timingContext.token.requestId != null ? timingContext.token.requestId : null,
						providerAttempt: latencyRecord && latencyRecord.attempt != null ? latencyRecord.attempt : null,
						status: normalizedStatus,
						httpStatus: statusCode == null ? null : Number(statusCode),
						errorClass: normalizedErrorClass,
						outputChars: measuredOutputChars,
						usage: historicalUsage,
						finishReason: !error && statusCode == 200 ? parseHistoricalFinishReason(body) : null,
					durationMs: Math.max(0, settledAt - startedAt),
						headers: null,
						ttftMs: null,
						physicalAbort: null
					});
			if (historicalObserver && typeof historicalObserver.onSettle == "function") try {ignoreObserverPromise(historicalObserver.onSettle(historicalSettleEvent));} catch (observerError) {}
			if (timingContext && timingContext.historicalSampleObserver && typeof timingContext.historicalSampleObserver.onSettle == "function") try {ignoreObserverPromise(timingContext.historicalSampleObserver.onSettle(historicalSettleEvent));} catch (observerError) {}
			if (timingContext && typeof timingContext.diagnosticStageObserver == "function") try {ignoreObserverPromise(timingContext.diagnosticStageObserver(historicalSettleEvent));} catch (observerError) {}
			if (admissionLease && historicalAdmission && typeof historicalAdmission.releaseAttempt == "function") {
				try {historicalAdmission.releaseAttempt(admissionLease, Object.freeze({logicalOnlyBeforeS4: true, timedOut: !!timedOut, statusCode: statusCode == null ? null : Number(statusCode), errorClass: normalizedErrorClass, retryAfterMs: retryAfterMsFromResponse(response), error: !!error}));}
				catch (releaseError) {}
				admissionLease = null;
			}
			callback(error, response, body);
		};
		const dispatch = () => {
			if (done) return null;
			startedAt = now();
			wireObservation = observePhysicalWire(timingContext, options && options.body != null ? options.body : options && options.form, {bodyBytesKnown: !!(options && options.body != null)});
			observeDiagnosticRequest(timingContext, String(options && options.body || ""));
			historicalObserver = timingContext && timingContext.historicalObserver;
			if (timingContext && typeof timingContext.historicalAttemptFactory == "function") {
				try {historicalObserver = timingContext.historicalAttemptFactory(timingContext.role) || historicalObserver;}
				catch (error) {}
			}
			if (historicalObserver && typeof historicalObserver.onRequest == "function") {
				try {ignoreObserverPromise(historicalObserver.onRequest(requestObservation));}
				catch (error) {}
			}
			timer = setTimeout(_ => finish(null, {statusCode: 504}, "", true), timeoutMs);
			try {request(url, options, finish);}
			catch (err) {finish(err, null, "");}
			return timer;
		};
		if (historicalAdmission && typeof historicalAdmission.acquireAttempt == "function") {
			const role = timingContext && timingContext.role === "backup" ? "backup" : timingContext && timingContext.role === "retry" ? "repair" : "primary";
			let admission;
			try {admission = historicalAdmission.acquireAttempt(Object.freeze({transportKey: contract.transportKey, workloadKey: contract.workloadKey, role, itemCount: Math.max(1, Number(seed.itemCount || timingContext && timingContext.messageCount) || 1), protectedChars: Math.max(0, Number(seed.inputChars) || 0), bodyBytes, estimatedTokens: Math.ceil(bodyBytes / 4)}));}
			catch (error) {admission = Promise.reject(error);}
			Promise.resolve(admission).then(lease => {
				if (done) return;
				if (!lease || lease.granted !== true) {
					done = true;
					const reason = lease && lease.reason || "attempt_budget";
					const statusCode = reason === "request_budget" ? 413 : reason === "rate_limit" ? 429 : reason === "server_cooldown" ? 503 : 409;
					const error = new Error(`Historical admission ${reason}`);
					error.historicalFailureKind = reason === "provider_unhealthy" ? "configuration" : reason;
					error.retryAfterMs = lease && lease.retryAfterMs != null ? Number(lease.retryAfterMs) : null;
					callback(error, {statusCode}, "");
					return;
				}
				admissionLease = lease;
				if (typeof historicalAdmission.isCurrent == "function") {
					let current = false;
					try {current = historicalAdmission.isCurrent() === true;}
					catch (error) {}
					if (!current) {
						try {historicalAdmission.releaseAttempt(admissionLease, Object.freeze({logicalOnlyBeforeS4: true, cancelledBeforeDispatch: true}));}
						catch (error) {}
						admissionLease = null;
						done = true;
						callback(null, {statusCode: 409}, "");
						return;
					}
				}
				dispatch();
			}, error => {
				if (done) return;
				done = true;
				callback(error, null, "");
			});
			return null;
		}
		return dispatch();
	}

	function getAuth(engineKey) {
		const authKeys = getAuthKeys() || {};
		return authKeys[engineKey] || {};
	}

	function historicalTimingEnabled(timingContext) {
		return !!(timingContext && (timingContext.historicalAdmission || timingContext.historicalObserver || timingContext.historicalAttemptFactory));
	}

	function countHistoricalPromptChars(value, key = "") {
		if (value == null) return 0;
		if (typeof value == "string") return key === "model" || key === "id" ? 0 : value.length;
		if (Array.isArray(value)) return value.reduce((total, item) => total + countHistoricalPromptChars(item), 0);
		if (typeof value == "object") return Object.entries(value).reduce((total, [childKey, child]) => total + countHistoricalPromptChars(child, childKey), 0);
		return 0;
	}

	function enrichHistoricalTimingContext(engineKey, timingContext, {endpoint = null, model = null, adapter = null, payload = null, promptVersion = "historical-single-v1"} = {}) {
		if (!historicalTimingEnabled(timingContext)) return timingContext;
		const auth = getAuth(engineKey);
		const engine = translationEngines[engineKey] || {};
		const protocolAdapter = adapter || (engineKey === "openai" ? openAiResponsesProtocolAdapter : engineKey === "gemini" ? geminiNativeProtocolAdapter : openAiChatProtocolAdapter);
		const normalizedEndpoint = endpoint || (protocolAdapter && typeof protocolAdapter.normalizeEndpoint == "function" ? protocolAdapter.normalizeEndpoint(auth.endpoint || engine.endpoint || "") : normalizeApiEndpoint(engineKey, auth.endpoint || engine.endpoint || ""));
		const modelId = model == null ? auth.model || engine.model || "" : model;
		const existingSeed = timingContext.historicalKeySeed;
		return Object.assign({}, timingContext, {
			historicalUsageFromBody: timingContext.historicalUsageFromBody || (protocolAdapter && typeof protocolAdapter.parseUsage == "function" ? body => protocolAdapter.parseUsage(body) : parseOpenAiResponseUsage),
			historicalKeySeed: existingSeed || Object.freeze({
				engine: engineKey,
				endpoint: normalizedEndpoint,
				credential: auth.key || "",
				model: modelId,
				protocol: protocolAdapter && protocolAdapter.id || "openai_chat",
				adapterVersion: protocolAdapter && protocolAdapter.version || 1,
				schemaVersion: 1,
				promptVersion,
				languageRules: {mode: "single"},
				itemCount: Math.max(1, Number(timingContext.messageCount) || 1),
				inputChars: timingContext.token && timingContext.token.inputChars != null ? Math.max(0, Number(timingContext.token.inputChars) || 0) : 0,
				promptChars: countHistoricalPromptChars(payload)
			})
		});
	}

	function historicalRequestPayloadBytes(options) {
		if (!options || typeof options != "object") return 0;
		if (options.body != null) return historicalUtf8ByteLength(options.body);
		const fields = options.form && typeof options.form == "object" ? options.form : options.qs && typeof options.qs == "object" ? options.qs : null;
		if (!fields) return 0;
		const encoded = Object.entries(fields).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value == null ? "" : String(value))}`).join("&");
		return historicalUtf8ByteLength(encoded);
	}

	function createFallbackHistoricalKeySeed(url, options, timingContext) {
		const engineKey = String(timingContext && timingContext.engineKey || "unknown");
		const auth = getAuth(engineKey);
		const engine = translationEngines[engineKey] || {};
		const endpoint = String(url || auth.endpoint || engine.endpoint || "").replace(/[?#].*$/, "");
		const inputChars = timingContext && timingContext.token && timingContext.token.inputChars != null ? Math.max(0, Number(timingContext.token.inputChars) || 0) : 0;
		return Object.freeze({
			engine: engineKey,
			endpoint,
			credential: auth.key || "",
			model: auth.model || engine.model || "",
			protocol: `callback_${String(engine.funcName || engineKey || "unknown").replace(/[^a-z0-9_-]/gi, "_")}`,
			adapterVersion: 1,
			schemaVersion: 1,
			promptVersion: "historical-classic-single-v1",
			languageRules: {mode: "classic"},
			itemCount: Math.max(1, Number(timingContext && timingContext.messageCount) || 1),
			inputChars,
			promptChars: inputChars
		});
	}

	function storeAuth(engineKey, auth) {
		const authKeys = getAuthKeys() || {};
		authKeys[engineKey] = auth;
		saveAuthKeys(authKeys);
	}

	function getCustomProtocolContext(engineKey, auth = getAuth(engineKey)) {
		const resolution = getCustomProtocolResolution(engineKey, auth);
		const adapter = resolution && customProtocolAdapterRegistry.get(resolution.resolved) || null;
		const rawEndpoint = auth.endpoint || translationEngines[engineKey] && translationEngines[engineKey].endpoint || "";
		return resolution && adapter ? Object.freeze({resolution, adapter, endpoint: adapter.normalizeEndpoint(rawEndpoint)}) : null;
	}

	function persistCustomProtocolEvidence(engineKey, context, evidence) {
		if (!context || !context.endpoint) return null;
		return setInterfaceDetection(engineKey, createInterfaceDetection({
			resolved: context.adapter.id,
			endpointKey: getInterfaceEndpointKey(getAuth(engineKey).endpoint || ""),
			evidence,
			adapterVersion: context.adapter.version,
			checkedAt: now()
		}));
	}
	const persistCustomProtocolValidation = (engineKey, context) => persistCustomProtocolEvidence(engineKey, context, "validation");

	function resolveReasoningPreference(engineKey, auth, model, protocol = null) {
		const stored = model ? getReasoningModelPref(engineKey, model) : null;
		if (stored) {
			// The exact value the user picked, kept typed. Nothing is folded on the way
			// in: a raw this build has never heard of still reaches the wire as itself.
			const storedRaw = resolveReasoningOnRaw(stored.onRaw !== undefined && stored.onRaw !== null ? stored.onRaw : stored.effort);
			const mode = normalizeReasoningModelMode(stored.mode);
			// Pre-exact-raw Chat records may still carry minimal from the version that
			// successfully sent it through compatible relays. Documentation for a direct
			// model must not silently turn that saved value into low or prevent a real probe.
			const legacyRawProbe = stored.rawExplicit !== true && mode === "on" && storedRaw === "minimal" && protocol && protocol.adapter && protocol.adapter.id === "openai_chat"
				&& getReasoningRawAvailability(protocol.adapter.reasoningControl, {model, raw: storedRaw, mode}) === "unsupported";
			// A record without that mark predates exact raws, so it is read as the value
			// the old build actually dispatched for it rather than as a new choice.
			const raw = stored.rawExplicit === true || legacyRawProbe ? storedRaw : reconcileLegacyReasoningRaw(protocol && protocol.adapter.reasoningControl, {model, raw: storedRaw});
			return {
				stored: true,
				mode,
				profile: normalizeReasoningProfile(stored.profile),
				effort: raw,
				onRaw: raw,
				legacyRawProbe,
				controlProfile: stored.controlProfile || null,
				capability: stored.capability || null
			};
		}
		return {
			stored: false,
			mode: normalizeReasoningMode(auth.reasoningMode) === "off" ? "off" : "follow",
			profile: normalizeReasoningProfile(auth.reasoningProfile),
			effort: "low",
			capability: null
		};
	}

	// The wire identity of what this selection would actually send: which candidate,
	// hence which field path, plus the typed raw that rides in it.
	function getReasoningWireIdentity(engineKey, auth, protocol, reasoning, model) {
		const format = protocol && protocol.adapter.id || "openai_chat";
		const effectiveProfile = reasoning.profile === "auto"
			? format === "openai_responses" ? "openai" : format === "ollama_native" ? "ollama" : format === "gemini_native" ? "gemini" : format === "anthropic_messages" ? "anthropic" : inferReasoningProfile({endpoint: auth.endpoint || "", model})
			: reasoning.profile;
		const spec = getReasoningProfileSpec(effectiveProfile, reasoning.capability && reasoning.capability.candidateId || null, {mode: reasoning.mode, effort: reasoning.effort, model})
			|| getReasoningProfileCandidates(effectiveProfile, {mode: reasoning.mode, effort: reasoning.effort, model})[0]
			|| null;
		const onRaw = reasoning.onRaw !== undefined && reasoning.onRaw !== null ? reasoning.onRaw : reasoning.effort;
		return {
			schemaId: createReasoningSchemaId({format, spec}),
			rawKey: reasoning.mode === "on" ? createReasoningRawKey(onRaw) : ""
		};
	}

	function getEngineConfigFingerprint(engineKey) {
		const auth = getAuth(engineKey);
		const engine = translationEngines[engineKey] || {};
		const protocol = getCustomProtocolContext(engineKey, auth);
		const endpoint = protocol ? protocol.endpoint : normalizeApiEndpoint(engineKey, auth.endpoint || engine.endpoint || "");
		const model = String(auth.model || engine.model || "").trim();
		const reasoning = isOpenAiCompatibleEngineKey(engineKey) ? resolveReasoningPreference(engineKey, auth, model, protocol) : {mode: "follow", profile: "auto", effort: "low"};
		const identity = isOpenAiCompatibleEngineKey(engineKey) ? getReasoningWireIdentity(engineKey, auth, protocol, reasoning, model) : {schemaId: "", rawKey: ""};
		return [engineKey, getModelCatalogPersistenceKey(endpoint), model, protocol && protocol.adapter.id || "", protocol && protocol.adapter.version || 0, reasoning.mode, reasoning.profile, reasoning.effort, identity.schemaId, identity.rawKey].join("\u0000");
	}

	function getBenchmarkFingerprint(engineKey) {
		const auth = getAuth(engineKey);
		const engine = translationEngines[engineKey] || {};
		const protocol = getCustomProtocolContext(engineKey, auth);
		const endpoint = protocol ? protocol.endpoint : normalizeApiEndpoint(engineKey, auth.endpoint || engine.endpoint || "");
		const model = String(auth.model || engine.model || "").trim();
		const reasoning = isOpenAiCompatibleEngineKey(engineKey) ? resolveReasoningPreference(engineKey, auth, model, protocol) : {mode: "follow", profile: "auto", effort: "low"};
		const identity = isOpenAiCompatibleEngineKey(engineKey) ? getReasoningWireIdentity(engineKey, auth, protocol, reasoning, model) : {schemaId: "", rawKey: ""};
		// A different wire schema or typed raw is a different benchmark subject, so an
		// old result goes stale instead of being compared across them.
		return [engineKey, getModelCatalogPersistenceKey(endpoint), model, protocol && protocol.adapter.id || "", protocol && protocol.adapter.version || 0, identity.schemaId, identity.rawKey].join("\u0000");
	}

	function getReasoningControlStatus(engineKey) {
		if (!isOpenAiCompatibleEngineKey(engineKey)) return Object.freeze({available: false, mode: "follow", profile: "auto", effectiveProfile: null, effort: "low", support: "provider_default", candidateId: null, resolvedValue: null, evidence: "none", fingerprint: getEngineConfigFingerprint(engineKey)});
		const auth = getAuth(engineKey);
		const engine = translationEngines[engineKey] || {};
		const protocol = getCustomProtocolContext(engineKey, auth);
		const endpoint = protocol ? protocol.endpoint : normalizeApiEndpoint(engineKey, auth.endpoint || engine.endpoint || "");
		const model = String(auth.model || engine.model || "").trim();
		const endpointKey = getModelCatalogPersistenceKey(endpoint);
		const preference = resolveReasoningPreference(engineKey, auth, model, protocol);
		const {mode, profile, effort} = preference;
		const format = protocol && protocol.adapter.id || "openai_chat";
		const effectiveProfile = profile === "auto" ? format === "openai_responses" ? "openai" : format === "ollama_native" ? "ollama" : format === "gemini_native" ? "gemini" : format === "anthropic_messages" ? "anthropic" : inferReasoningProfile({endpoint, model}) : profile;
		const familySupported = !protocol || protocol.adapter.reasoningFamilies.includes(effectiveProfile);
		const hasEquivalentCandidate = mode === "follow" || getReasoningProfileCandidates(effectiveProfile, {mode, effort, model})
			.some(candidate => isEquivalentReasoningCandidate(candidate, {mode, raw: preference.onRaw !== undefined ? preference.onRaw : effort}));
		// A local verdict, not evidence: this model is documented to reject this exact
		// raw, so there is nothing to probe and nothing to bill for.
		const declaredAvailability = mode === "on" && protocol ? getReasoningRawAvailability(protocol.adapter.reasoningControl, {model, raw: effort, mode}) : "supported";
		const availability = preference.legacyRawProbe && declaredAvailability === "unsupported" ? "supported" : declaredAvailability;
		const identity = getReasoningWireIdentity(engineKey, auth, protocol, preference, model);
		const keyOptions = {engineKey, endpoint: endpointKey, model, profile, mode, effort, resolvedValue: mode === "on" ? effort : "", format, rawKey: identity.rawKey, schemaId: identity.schemaId};
		const capabilityKey = createReasoningCapabilityKey(keyOptions);
		let capability = mode === "follow" ? null : reasoningCapabilityCache.get(capabilityKey);
		// A record written before wire identities existed lives under the eight-segment
		// key. Migrating it in costs nothing: an upgrade must never reset a confirmed
		// capability to "not tested", and must never probe to find out.
		if (!capability && mode !== "follow") {
			const legacyEntry = reasoningCapabilityCache.get(createLegacyReasoningCapabilityKey(keyOptions));
			if (legacyEntry) capability = reasoningCapabilityCache.set(capabilityKey, legacyEntry.support, legacyEntry);
		}
		const persistedFormatCompatible = preference.capability && (preference.capability.format ? preference.capability.format === format : format === "openai_chat");
		if (!capability && mode !== "follow" && preference.capability && preference.capability.endpointKey === endpointKey && persistedFormatCompatible) {
			const persistedSpec = getReasoningProfileSpec(effectiveProfile, preference.capability.candidateId, {mode, effort, model});
			if (persistedSpec && persistedSpec.resolvedValue === preference.capability.resolvedValue) capability = reasoningCapabilityCache.set(capabilityKey, preference.capability.support, preference.capability);
		}
		return Object.freeze({
			available: true,
			mode,
			profile,
			effectiveProfile,
			effort,
			support: mode === "follow" ? "provider_default" : !familySupported || !hasEquivalentCandidate ? "unsupported" : capability && capability.support || "pending",
			candidateId: mode !== "follow" && capability && capability.candidateId || null,
			resolvedValue: mode !== "follow" && capability && capability.resolvedValue || null,
			evidence: mode !== "follow" && capability && capability.evidence || "none",
			availability,
			legacyRawProbe: preference.legacyRawProbe === true,
			onRaw: preference.onRaw !== undefined && preference.onRaw !== null ? preference.onRaw : effort,
			// The value this configuration puts on the wire, in both directions: the chosen
			// raw when thinking is on, and the off ladder's own value when it is off. The
			// status line names it, so it can never be a localized stand-in.
			dispatchedRaw: mode === "follow" ? "" : mode === "on" ? effort : (() => {
				const spec = capability && getReasoningProfileSpec(effectiveProfile, capability.candidateId, {mode, effort, model})
					|| getReasoningProfileCandidates(effectiveProfile, {mode, effort, model})[0] || null;
				return spec && spec.values && spec.values.length ? spec.values[0] : "";
			})(),
			capabilityKey,
			endpointKey,
			format,
			schemaId: identity.schemaId,
			adapterVersion: protocol && protocol.adapter.version || 1,
			model,
			preferenceStored: preference.stored,
			fingerprint: getEngineConfigFingerprint(engineKey)
		});
	}

	// What the strength control offers: the declared ladder for this model, the exact raw
	// already saved and every value that carries a verdict, deduped by type. Redacted by
	// construction - no field paths, adapter ids or schema strings travel with it.
	function getReasoningTierOptions(engineKey) {
		const state = getReasoningControlStatus(engineKey);
		if (!state.available || !state.model) return Object.freeze([]);
		const auth = getAuth(engineKey);
		const protocol = getCustomProtocolContext(engineKey, auth);
		const stored = getReasoningModelPref(engineKey, state.model);
		const tierStates = stored && stored.controlProfile && stored.controlProfile.tierStates || {};
		const evidenceRaws = Object.keys(tierStates).map(key => tierStates[key] && tierStates[key].raw).filter(raw => raw !== undefined && raw !== null);
		return buildReasoningTierOptions(protocol && protocol.adapter.reasoningControl || null, {
			model: state.model,
			savedRaw: state.mode === "on" ? state.onRaw : null,
			evidenceRaws,
			tierStates,
			createRawKey: createReasoningRawKey,
			mode: state.mode
		});
	}

	function setReasoningModelPreference(engineKey, preference = {}) {
		const current = getReasoningControlStatus(engineKey);
		if (!current.available || !current.model) return current;
		const nextRaw = resolveReasoningOnRaw(preference.onRaw !== undefined ? preference.onRaw : preference.effort !== undefined ? preference.effort : current.onRaw);
		const next = {
			mode: normalizeReasoningModelMode(preference.mode !== undefined ? preference.mode : current.mode),
			profile: normalizeReasoningProfile(preference.profile !== undefined ? preference.profile : current.profile),
			// The legacy field keeps its legacy meaning: only one of the four enum words
			// is ever mirrored into it, so an older build reads a value it understands
			// instead of a custom string it would silently fold.
			effort: isLegacyReasoningEffort(nextRaw) ? nextRaw : isLegacyReasoningEffort(current.effort) ? current.effort : "low",
			onRaw: nextRaw,
			rawExplicit: true,
			capability: null,
			checkedAt: now()
		};
		reasoningCapabilityCache.delete(current.capabilityKey);
		setReasoningModelPref(engineKey, current.model, next);
		return getReasoningControlStatus(engineKey);
	}

	function invalidateReasoningCapabilities(engineKey) {
		const current = getReasoningControlStatus(engineKey);
		const removed = reasoningCapabilityCache.deleteEngine(engineKey);
		if (current.available && current.model) clearReasoningModelCapability(engineKey, current.model);
		return removed;
	}

	function getCustomInterfaceStatus(engineKey) {
		if (!isOpenAiCompatibleEngineKey(engineKey)) return Object.freeze({available: false});
		const context = getCustomProtocolContext(engineKey);
		if (!context) return Object.freeze({available: true, requested: "auto", resolved: "openai_chat", evidence: "legacy", endpointKey: "", adapterVersion: 1});
		return Object.freeze(Object.assign({available: true}, context.resolution));
	}

	function getCustomReasoningPlan(engineKey, {probe = false, override = null, rewrite = false} = {}) {
		const state = getReasoningControlStatus(engineKey);
		const candidates = state.available ? getReasoningProfileCandidates(state.effectiveProfile, {mode: state.mode, effort: state.effort, model: state.model})
			.filter(candidate => isEquivalentReasoningCandidate(candidate, {mode: state.mode, raw: state.onRaw})) : [];
		// Known-illegal raw: no request in any mode, including the benchmark's baseline
		// leg. Nothing is rewritten either, so the stored choice stays the user's.
		if (state.available && state.availability === "unsupported") return {state, spec: null, candidates: [], blocked: "invalid-strength"};
		if (override === "baseline") return {state, spec: null, candidates};
		if (!state.available || state.mode === "follow") return {state, spec: null, candidates};
		if (!probe && state.support === "unsupported") return {state, spec: null, candidates, blocked: "unsupported-control"};
		const capabilityReady = state.support === "accepted" || state.support === "reduced";
		if (probe) {
			// Closing thinking may walk its ladder: those candidates are different ways to
			// ask for the same thing. An explicit strength is one value on one schema, so
			// validation asks once; trying another schema for it is a separate request the
			// user makes on purpose, and it starts after the schema already recorded.
			if (!rewrite && state.mode === "off") return {state, spec: candidates[0] || null, candidates};
			const currentIndex = candidates.findIndex(candidate => candidate.candidateId === state.candidateId);
			const start = rewrite && currentIndex >= 0 ? currentIndex + 1 : 0;
			let scoped = candidates.slice(start, rewrite ? candidates.length : start + 1);
			// Exhausting the equivalent schema list is never permission to drop the
			// control. Re-send the current exact request so a second validation remains
			// an honest test (the common OpenAI path has exactly one candidate).
			if (rewrite && !scoped.length) {
				const repeat = currentIndex >= 0 ? candidates[currentIndex] : candidates[0] || null;
				scoped = repeat ? [repeat] : [];
			}
			return {state, spec: scoped[0] || null, candidates: scoped};
		}
		// Validation governs what we claim, not what the user asked us to send. A new
		// explicit on/off selection therefore rides every ordinary request immediately,
		// and the synthetic benchmark's controlled arm dispatches it the same way.
		if (!capabilityReady) return {state, spec: candidates[0] || null, candidates};
		return {state, spec: state.candidateId ? getReasoningProfileSpec(state.effectiveProfile, state.candidateId, {mode: state.mode, effort: state.effort, model: state.model}) : null, candidates};
	}

	function getReasoningProbeEvidence(body, sentSpec, reportedTokens = undefined) {
		if (!sentSpec || !sentSpec.closesThinking && !sentSpec.opensThinking) return "none";
		let parsed = null;
		try {parsed = typeof body == "string" ? JSON.parse(body) : body;}
		catch (error) {return "none";}
		const choice = parsed && parsed.choices && parsed.choices[0];
		const message = choice && choice.message;
		const hasReasoningContent = !!(message && typeof message.reasoning_content == "string" && message.reasoning_content.trim());
		const reasoningTokens = reportedTokens === undefined ? getReasoningProbeUsageTokens(parsed) : reportedTokens;
		const hasThinking = hasReasoningContent || reasoningTokens != null && reasoningTokens > 0;
		if (sentSpec.opensThinking) return hasThinking ? "confirmed" : "none";
		if (hasThinking) return "contradicted";
		// Compatible relays may print zero regardless of the route they actually used.
		// Keep zero as visible telemetry, but do not turn it into a claim that thinking
		// was closed. Native adapters with authoritative zero semantics may still return
		// their own confirmed verdict from getReasoningEvidence.
		return "none";
	}

	function hasAuthoritativeReasoningUsage(state) {
		if (!state || state.format !== "openai_chat" && state.format !== "openai_responses") return false;
		try {
			const endpoint = new URL(String(state.endpointKey || ""));
			return endpoint.protocol === "https:" && endpoint.hostname.toLowerCase() === "api.openai.com";
		}
		catch (error) {return false;}
	}

	// The response's own thinking bill, when the wire reports one: chat and Responses
	// count it under usage, Gemini under usageMetadata. Null means "not reported".
	function getReasoningProbeUsageTokens(body) {
		let parsed = null;
		try {parsed = typeof body == "string" ? JSON.parse(body) : body;}
		catch (error) {return null;}
		if (!parsed || typeof parsed != "object") return null;
		const chat = parsed.usage && parsed.usage.completion_tokens_details && parsed.usage.completion_tokens_details.reasoning_tokens;
		const responses = parsed.usage && parsed.usage.output_tokens_details && parsed.usage.output_tokens_details.reasoning_tokens;
		const hasGeminiUsage = !!(parsed.usageMetadata && typeof parsed.usageMetadata == "object");
		const gemini = hasGeminiUsage && parsed.usageMetadata.thoughtsTokenCount != null ? parsed.usageMetadata.thoughtsTokenCount : hasGeminiUsage ? 0 : null;
		const normalize = raw => {
			if (typeof raw == "string" && !raw.trim() || typeof raw != "string" && typeof raw != "number") return null;
			const value = Number(raw);
			return Number.isFinite(value) && value >= 0 ? value : null;
		};
		const values = [chat, responses, gemini].map(normalize).filter(value => value != null);
		return values.length ? Math.max(...values) : null;
	}

	function persistReasoningCapability(state, support, sentSpec, evidence = "none") {
		if (!state || !state.model || !sentSpec) return null;
		if (!state.preferenceStored) setReasoningModelPref(state.engineKey, state.model, {mode: state.mode, profile: state.profile, effort: state.effort, capability: null, checkedAt: now()});
		const capability = {
			support,
			candidateId: sentSpec.candidateId,
			resolvedValue: sentSpec.resolvedValue,
			evidence,
			format: state.format || "openai_chat",
			endpointKey: state.endpointKey,
			checkedAt: now()
		};
		reasoningCapabilityCache.set(state.capabilityKey, support, capability);
		setReasoningModelCapability(state.engineKey, state.model, capability);
		// A verdict is about one exact value: a confirmed "high" says nothing about
		// "minimal". The off ladder has no single user-chosen raw, so it keeps to the
		// capability record above.
		if (state.mode === "on" && state.onRaw !== undefined && state.onRaw !== null) {
			setReasoningModelTierState(state.engineKey, state.model, state.onRaw, {state: deriveReasoningTierState(support, evidence), evidence});
		}
		return capability;
	}

	// Per-engine record of the latest probe's reported thinking usage, so the status
	// line can print the provider's own bill instead of asking anyone to trust a verdict.
	const lastReasoningProbeUsage = new Map();
	// The latest probe's echoed effort (Responses wire only): the server's statement of
	// the level actually in force, so the status line can name a substituted level.
	const lastReasoningProbeEcho = new Map();

	function openAiChatStreamCapabilityKey({engineKey, endpoint, model, format = "openai_chat", adapterVersion = 1} = {}) {
		return JSON.stringify([String(engineKey || ""), String(endpoint || ""), String(model || ""), String(format || "openai_chat"), Math.max(1, Number(adapterVersion) || 1)]);
	}

	function getOpenAiChatStreamCapability(key) {
		const entry = key && openAiChatStreamCapabilities.get(key);
		return entry && entry.state || "unknown";
	}

	function setOpenAiChatStreamCapability(key, state) {
		if (!key || !["supported", "unsupported"].includes(state)) return false;
		if (openAiChatStreamCapabilities.has(key)) openAiChatStreamCapabilities.delete(key);
		openAiChatStreamCapabilities.set(key, Object.freeze({state, checkedAt: now()}));
		while (openAiChatStreamCapabilities.size > 20) openAiChatStreamCapabilities.delete(openAiChatStreamCapabilities.keys().next().value);
		return true;
	}

	function resolveProviderRequestContext(timingContext, requestContext) {
		return requestContext || timingContext && timingContext.requestContext || null;
	}

	function isOpenAiChatLiveIntent({timingContext, requestContext, probe} = {}) {
		const context = resolveProviderRequestContext(timingContext, requestContext);
		if (!openAiChatStreamRequest || probe || !context || !context.logicalRequestId || typeof context.isCurrent != "function") return false;
		try {if (!isLiveStreamingEnabled()) return false;}
		catch (error) {return false;}
		if (!timingContext || !timingContext.token || timingContext.token.kind !== "live" || Math.max(1, Number(timingContext.messageCount) || 1) !== 1) return false;
		return true;
	}

	function isOpenAiChatLiveRequest({timingContext, requestContext, probe} = {}) {
		if (!isOpenAiChatLiveIntent({timingContext, requestContext, probe})) return false;
		const context = resolveProviderRequestContext(timingContext, requestContext);
		try {if (!context.isCurrent()) return false;}
		catch (error) {return false;}
		return true;
	}

	function shouldUseOpenAiChatStream({timingContext, requestContext, probe, capabilityKey} = {}) {
		const context = resolveProviderRequestContext(timingContext, requestContext);
		// W5 uses bounded nonstream envelopes, including a one-item batch repair.
		if (context && context.wholeMarkerBatchCanary === true) return false;
		if (!isOpenAiChatLiveRequest({timingContext, requestContext, probe})) return false;
		return getOpenAiChatStreamCapability(capabilityKey) !== "unsupported";
	}

	function isValidJson200(result) {
		if (!result || result.mode !== "response" || result.status !== 200 || !String(result.contentType || "").toLowerCase().includes("json")) return false;
		try {JSON.parse(String(result.body || "")); return true;}
		catch (error) {return false;}
	}

	function isStreamUnsupportedResponse(result) {
		if (!result || result.mode !== "response" || ![400, 404, 405, 406, 415, 422, 501].includes(Number(result.status))) return false;
		const details = String(getValidationErrorDetails(result.body) || result.body || "").toLowerCase();
		return /\bstream(?:ing)?\b/.test(details) && /(unsupported|not supported|does not support|unknown|unrecognized|not allowed|not permitted|invalid|extra input)/.test(details);
	}

	function streamResponseBody(result) {
		return JSON.stringify({
			choices: [{message: {content: String(result && result.text || "")}, finish_reason: result && result.finishReason || null}],
			usage: result && result.usage || undefined
		});
	}

	function recordOpenAiChatStreamLatency(timingContext, result, {streamFallback = false, outputCharsFromBody = null, wireObservation = null} = {}) {
		if (!timingContext || !result) return null;
		const httpStatus = Number(result.status) || null;
		let status = "ok", errorClass = null, outputChars = null;
		if (result.mode === "stream") outputChars = String(result.text || "").length;
		else if (result.mode === "response" && httpStatus === 200 && typeof outputCharsFromBody == "function") {
			try {outputChars = Math.max(0, Number(outputCharsFromBody(result.body)) || 0);}
			catch (error) {outputChars = null;}
		}
		if (result.mode === "error") {
			errorClass = result.errorKind === "abort" ? "abort" : result.errorKind === "timeout" ? "timeout" : result.errorKind === "network" ? "network" : "invalid";
			status = errorClass === "abort" ? "cancelled" : errorClass === "timeout" ? "timeout" : "error";
		}
		else if (httpStatus && httpStatus !== 200) {
			errorClass = classifyProviderRequestError(null, {statusCode: httpStatus}, result.body);
			status = `http_${httpStatus}`;
		}
		const usageBody = result.mode === "stream" ? streamResponseBody(result) : result.body;
		const usage = httpStatus === 200 ? parseTimingUsage(timingContext, usageBody) : null;
		const latencyRecord = timingContext.token ? recordLatencyEvent(Object.assign(diagnosticFreeTimingContext(timingContext), {
			transportMs: Math.max(0, Number(result.transportMs) || 0),
			status,
			httpStatus,
			errorClass,
			outputChars,
			streaming: true,
			ttftMs: result.ttftMs == null ? null : Math.max(0, Number(result.ttftMs) || 0),
			streamChunkCount: Math.max(0, Number(result.streamChunkCount) || 0),
			streamFallback: !!streamFallback,
			finishedAt: now()
		}, usage ? {usage} : {}, wireObservation ? {wireObservation} : {})) : null;
		observeDiagnosticStage(timingContext, {status, httpStatus, errorClass, outputChars, durationMs: Math.max(0, Number(result.transportMs) || 0), headers: null, ttftMs: result.ttftMs == null ? null : Math.max(0, Number(result.ttftMs) || 0), physicalAbort: result.errorKind === "abort" || result.errorKind === "timeout"});
		return latencyRecord;
	}

	function requestAbortableOpenAiChatText({url, requestOptions, payload, timingContext, requestContext, outputCharsFromBody, diagnosticRequestRole, diagnosticSettleOwnedByHistory = false}) {
		const context = resolveProviderRequestContext(timingContext, requestContext);
		const startedAt = now();
		const token = providerAttemptOwner.begin({
			logicalRequestId: context && context.logicalRequestId,
			role: timingContext && timingContext.role || "primary",
			signal: context && context.signal || null
		});
		const current = () => {
			if (!providerAttemptOwner.owns(token) || !context || typeof context.isCurrent != "function") return false;
			try {return !!context.isCurrent();}
			catch (error) {return false;}
		};
		const completed = (fields, latencyRecord = null, physicalAbort = false) => {
			const value = Object.assign({}, fields || {});
			Object.defineProperty(value, "historicalLatencyRecord", {value: latencyRecord, enumerable: false});
			Object.defineProperty(value, "historicalPhysicalAbort", {value: !!physicalAbort, enumerable: false});
			Object.defineProperty(value, "historicalPhysicalSettled", {value: true, enumerable: false});
			return Object.freeze(value);
		};
		if (!current()) {
			providerAttemptOwner.abort(token, "stale-before-text");
			return Promise.resolve(completed({ok: false, errorKind: "abort", status: 0, body: "", transportMs: 0}, null, true));
		}
		const textPayload = Object.assign({}, payload || {});
		delete textPayload.stream;
		const textBody = JSON.stringify(textPayload);
		const wireObservation = observePhysicalWire(timingContext, textBody);
		observeDiagnosticRequest(timingContext, textBody, diagnosticRequestRole);
		return streamTransport.requestText({
			token,
			url,
			options: Object.assign({}, requestOptions || {}, {body: textBody}),
			timeoutMs: PROVIDER_REQUEST_TIMEOUT_MS
		}).then(result => {
			const transportMs = Math.max(0, Number(now() - startedAt) || 0);
			const statusCode = Number(result && result.status) || null;
			let status = "ok", errorClass = null, outputChars = null;
			if (!result || !result.ok) {
				errorClass = result && result.errorKind === "abort" ? "abort" : result && result.errorKind === "timeout" ? "timeout" : "network";
				status = errorClass === "abort" ? "cancelled" : errorClass === "timeout" ? "timeout" : "network";
			}
			else if (statusCode && statusCode !== 200) {
				errorClass = classifyProviderRequestError(null, {statusCode}, result.body);
				status = `http_${statusCode}`;
			}
			else if (typeof outputCharsFromBody == "function") {
				try {outputChars = Math.max(0, Number(outputCharsFromBody(result.body)) || 0);}
				catch (error) {outputChars = null;}
			}
			const usage = result && result.ok && statusCode === 200 ? parseTimingUsage(timingContext, result.body) : null;
			const latencyRecord = timingContext && timingContext.token ? recordLatencyEvent(Object.assign(diagnosticFreeTimingContext(timingContext), {transportMs, status, httpStatus: statusCode, errorClass, outputChars, streaming: false, ttftMs: null, streamChunkCount: 0, streamFallback: false, finishedAt: now()}, usage ? {usage} : {}, wireObservation ? {wireObservation} : {})) : null;
			const physicalAbort = !!(result && (result.errorKind === "abort" || result.errorKind === "timeout"));
			if (!diagnosticSettleOwnedByHistory) observeDiagnosticStage(timingContext, {status, httpStatus: statusCode, errorClass, outputChars, durationMs: transportMs, headers: null, ttftMs: null, physicalAbort});
			return completed(Object.assign({}, result || {}, {transportMs}), latencyRecord, physicalAbort);
		}, error => {
			providerAttemptOwner.abort(token, "text-transport-error");
			if (!diagnosticSettleOwnedByHistory) observeDiagnosticStage(timingContext, {status: "network", httpStatus: null, errorClass: "network", outputChars: null, durationMs: Math.max(0, Number(now() - startedAt) || 0), headers: null, ttftMs: null, physicalAbort: true});
			return completed({ok: false, errorKind: "network", status: 0, body: "", transportMs: Math.max(0, Number(now() - startedAt) || 0)});
		});
	}

	async function requestHistoricalAbortableCustomText({adapter, url, requestOptions, payload, timingContext, requestContext, outputCharsFromBody}) {
		const options = Object.assign({}, requestOptions || {}, {body: JSON.stringify(payload || {})});
		const seed = timingContext && timingContext.historicalKeySeed || createFallbackHistoricalKeySeed(url, options, timingContext);
		const bodyBytes = historicalRequestPayloadBytes(options);
		const contract = createHistoricalRequestKeyContract(Object.assign({}, seed, {reasoningWire: extractHistoricalReasoningWire(options.body)}));
		if (timingContext && typeof timingContext.historicalContractObserver == "function") {
			try {ignoreObserverPromise(timingContext.historicalContractObserver(contract));}
			catch (error) {}
		}
		if (timingContext && timingContext.historicalSampleObserver && typeof timingContext.historicalSampleObserver.onContract == "function") {
			try {ignoreObserverPromise(timingContext.historicalSampleObserver.onContract(contract, {bodyBytes, promptChars: Math.max(0, Number(seed.promptChars) || 0), inputChars: Math.max(0, Number(seed.inputChars) || 0)}));}
			catch (error) {}
		}
		const admission = timingContext && timingContext.historicalAdmission;
		const role = timingContext && timingContext.role === "backup" ? "backup" : timingContext && timingContext.role === "retry" ? "repair" : "primary";
		let lease = null;
		if (admission && typeof admission.acquireAttempt == "function") {
			try {lease = await admission.acquireAttempt(Object.freeze({transportKey: contract.transportKey, workloadKey: contract.workloadKey, role, itemCount: Math.max(1, Number(seed.itemCount || timingContext && timingContext.messageCount) || 1), protectedChars: Math.max(0, Number(seed.inputChars) || 0), bodyBytes, estimatedTokens: Math.ceil(bodyBytes / 4)}));}
			catch (error) {return Object.freeze({ok: false, errorKind: "network", status: 0, body: "", transportMs: 0});}
			if (!lease || lease.granted !== true) {
				const reason = lease && lease.reason || "attempt_budget";
				return Object.freeze({ok: false, errorKind: reason === "provider_unhealthy" ? "configuration" : reason, status: reason === "request_budget" ? 413 : reason === "rate_limit" ? 429 : reason === "server_cooldown" ? 503 : 409, body: "", transportMs: 0, retryAfterMs: lease && lease.retryAfterMs != null ? Number(lease.retryAfterMs) : null});
			}
			if (typeof admission.isCurrent == "function") {
				let current = false;
				try {current = admission.isCurrent() === true;}
				catch (error) {}
				if (!current) {
					try {admission.releaseAttempt(lease, Object.freeze({physicalSettled: true, cancelledBeforeDispatch: true}));}
					catch (error) {}
					return Object.freeze({ok: false, errorKind: "abort", status: 0, body: "", transportMs: 0});
				}
			}
		}
		let observer = timingContext && timingContext.historicalObserver;
		if (timingContext && typeof timingContext.historicalAttemptFactory == "function") {
			try {observer = timingContext.historicalAttemptFactory(timingContext.role) || observer;}
			catch (error) {}
		}
		if (observer && typeof observer.onRequest == "function") {
			try {ignoreObserverPromise(observer.onRequest(Object.freeze({transportKey: contract.transportKey, workloadKey: contract.workloadKey, transport: contract.transport, workload: contract.workload, bodyBytes, promptChars: Math.max(0, Number(seed.promptChars) || 0), inputChars: Math.max(0, Number(seed.inputChars) || 0), headers: null, ttftMs: null, physicalAbort: null})));}
			catch (error) {}
		}
		let result;
		try {result = await requestAbortableOpenAiChatText({url, requestOptions, payload, timingContext, requestContext, outputCharsFromBody, diagnosticRequestRole: role, diagnosticSettleOwnedByHistory: true});}
		catch (error) {result = Object.freeze({ok: false, errorKind: "network", status: 0, body: "", transportMs: 0});}
		const latencyRecord = result && result.historicalLatencyRecord || null;
		const physicalAbort = !!(result && result.historicalPhysicalAbort);
		const historicalStatusCode = Number(result && result.status) || null;
		let historicalUsage = null;
		try {historicalUsage = result && result.ok && historicalStatusCode === 200 && adapter && typeof adapter.parseUsage == "function" ? normalizeHistoricalUsage(adapter.parseUsage(result.body)) : null;}
		catch (error) {historicalUsage = null;}
		const historicalSettleEvent = Object.freeze({
					providerRequestId: latencyRecord && latencyRecord.requestId != null ? latencyRecord.requestId : timingContext && timingContext.token && timingContext.token.requestId != null ? timingContext.token.requestId : null,
					providerAttempt: latencyRecord && latencyRecord.attempt != null ? latencyRecord.attempt : null,
					status: latencyRecord && latencyRecord.status || (result && result.ok ? "ok" : result && result.errorKind === "timeout" ? "timeout" : result && result.errorKind === "abort" ? "cancelled" : "network"),
					httpStatus: historicalStatusCode,
					errorClass: latencyRecord && latencyRecord.errorClass || result && result.errorKind || null,
					outputChars: latencyRecord && latencyRecord.outputChars != null ? latencyRecord.outputChars : null,
					usage: historicalUsage,
					finishReason: result && result.ok && historicalStatusCode === 200 ? parseHistoricalFinishReason(result.body) : null,
					durationMs: Math.max(0, Number(result && result.transportMs) || 0),
					headers: null,
					ttftMs: null,
					physicalAbort
				});
		if (observer && typeof observer.onSettle == "function") try {ignoreObserverPromise(observer.onSettle(historicalSettleEvent));} catch (error) {}
		if (timingContext && timingContext.historicalSampleObserver && typeof timingContext.historicalSampleObserver.onSettle == "function") try {ignoreObserverPromise(timingContext.historicalSampleObserver.onSettle(historicalSettleEvent));} catch (error) {}
		if (timingContext && typeof timingContext.diagnosticStageObserver == "function") try {ignoreObserverPromise(timingContext.diagnosticStageObserver(historicalSettleEvent));} catch (error) {}
		if (lease && admission && typeof admission.releaseAttempt == "function") {
			try {admission.releaseAttempt(lease, Object.freeze({physicalSettled: true, physicalAbort, statusCode: Number(result && result.status) || null, errorClass: latencyRecord && latencyRecord.errorClass || result && result.errorKind || null, retryAfterMs: result && result.retryAfterMs != null ? Number(result.retryAfterMs) : null}));}
			catch (error) {}
		}
		return result;
	}

	function requestCustomChatCompletion({engineKey, adapter = openAiChatProtocolAdapter, url, requestOptions, payload, timingContext = null, requestContext = null, probe = false, reasoningOverride = null, reasoningRewrite = false, outputCharsFromBody = null, onResponseMetrics = null}, callback) {
		const rawPlan = getCustomReasoningPlan(engineKey, {probe, override: reasoningOverride, rewrite: reasoningRewrite});
		const candidates = rawPlan.candidates.filter(spec => !!adapter.getReasoningWireSpec(spec));
		const selected = rawPlan.spec && candidates.find(spec => spec.candidateId === rawPlan.spec.candidateId) || null;
		const plan = {state: rawPlan.state, spec: selected, candidates};
		plan.state = Object.freeze(Object.assign({engineKey}, plan.state));
		if (rawPlan.blocked) {
			const sentence = rawPlan.blocked === "invalid-strength"
				? String(getCustomText("custom_status_invalid_strength") || "").replace("{raw}", String(plan.state.onRaw))
				: String(getCustomText("benchmark_error_reasoning_unsupported") || getCustomText("reasoning_status_unsupported") || "Reasoning control unsupported");
			return callback(new Error(sentence), null, JSON.stringify({error: {message: sentence}}), plan.state);
		}
		if (reasoningOverride !== "baseline" && (plan.state.mode === "on" || plan.state.mode === "off") && !plan.spec) {
			const sentence = String(getCustomText("benchmark_error_reasoning_unsupported") || getCustomText("reasoning_status_unsupported") || "Reasoning control unsupported");
			return callback(new Error(sentence), null, JSON.stringify({error: {message: sentence}}), plan.state);
		}
		const effectiveRequestContext = resolveProviderRequestContext(timingContext, requestContext);
		const capabilityKey = openAiChatStreamCapabilityKey({
			engineKey,
			endpoint: plan.state.endpointKey || url,
			model: plan.state.model,
			format: adapter.id,
			adapterVersion: adapter.version
		});
		let send = null;
		const handleResponse = (requestPayload, sentSpec, context, options, error, response, body) => {
			const {retried = false, candidateIndex = 0} = options || {};
				const statusCode = response && response.statusCode || null;
				const wireSpec = sentSpec && adapter.getReasoningWireSpec(sentSpec);
				const classificationSpec = wireSpec && Object.assign({}, sentSpec, {fields: wireSpec.fields, values: wireSpec.values});
				const fieldUnsupported = !retried && sentSpec && isUnsupportedReasoningFieldError(statusCode, body, classificationSpec && classificationSpec.fields || []);
				const valueUnsupported = !retried && sentSpec && isUnsupportedReasoningValueError(statusCode, body, classificationSpec);
				if (probe && sentSpec && !retried) {
					const nextCandidate = plan.candidates[candidateIndex + 1] || null;
					if (nextCandidate && (valueUnsupported || fieldUnsupported && sentSpec.continueOnFieldUnsupported)) {
						const retryContext = context ? Object.assign({}, context, {role: "retry"}) : null;
						return send(adapter.applyReasoning(payload, adapter.getReasoningWireSpec(nextCandidate)), nextCandidate, retryContext, {candidateIndex: candidateIndex + 1});
					}
					if (fieldUnsupported || valueUnsupported) {
						persistReasoningCapability(plan.state, "unsupported", sentSpec, "none");
						return callback(error, response, body, getReasoningControlStatus(engineKey));
					}
				}
				else if (sentSpec && !retried && (fieldUnsupported || valueUnsupported)) {
					persistReasoningCapability(plan.state, "unsupported", sentSpec, "none");
					return callback(error, response, body, getReasoningControlStatus(engineKey));
				}
				if (probe && !error && statusCode == 200) {
					const reportedTokens = getReasoningProbeUsageTokens(body);
					lastReasoningProbeUsage.set(engineKey, reportedTokens);
					lastReasoningProbeEcho.set(engineKey, typeof adapter.getReasoningEchoRaw == "function" ? adapter.getReasoningEchoRaw(body) : null);
					if (sentSpec) {
						const adapterEvidence = adapter.getReasoningEvidence(body, sentSpec);
						let evidence = adapterEvidence == null ? getReasoningProbeEvidence(body, sentSpec, reportedTokens) : adapterEvidence;
						// Direct official usage is authoritative for an explicit off request. Other
						// compatible endpoints keep zero unconfirmed because they may rewrite or erase it.
						if (evidence === "none" && sentSpec.closesThinking && reportedTokens === 0 && hasAuthoritativeReasoningUsage(plan.state)) evidence = "confirmed";
						persistReasoningCapability(plan.state, sentSpec.success, sentSpec, evidence);
					}
				}
				if (!error && statusCode == 200 && typeof onResponseMetrics == "function") {
					const usage = adapter.parseUsage(body);
					if (usage) try {ignoreObserverPromise(onResponseMetrics(usage));} catch (metricsError) {}
				}
				callback(error, response, body, getReasoningControlStatus(engineKey));
		};
		send = (requestPayload, sentSpec, context, {retried = false, candidateIndex = 0, forceNonstream = false} = {}) => {
			if (effectiveRequestContext && effectiveRequestContext.wholeMarkerBatchCanary === true && historicalUtf8ByteLength(JSON.stringify(requestPayload)) > 65536) return handleResponse(requestPayload, sentSpec, context, {retried, candidateIndex}, new Error("W5 request budget"), {statusCode: 413}, "");
			const historicalContext = enrichHistoricalTimingContext(engineKey, context, {endpoint: plan.state.endpointKey || url, model: plan.state.model, adapter, payload: requestPayload});
			const measuredContext = historicalContext ? Object.assign({}, historicalContext, {outputCharsFromBody, usageFromBody: body => adapter.parseUsage(body)}) : null;
			const nativeLiveIntent = adapter.id === "openai_chat" && isOpenAiChatLiveIntent({timingContext: context, requestContext: effectiveRequestContext, probe});
			const nativeLiveRequest = adapter.id === "openai_chat" && isOpenAiChatLiveRequest({timingContext: context, requestContext: effectiveRequestContext, probe});
			const useStream = !forceNonstream && adapter.id === "openai_chat" && shouldUseOpenAiChatStream({timingContext: context, requestContext: effectiveRequestContext, probe, capabilityKey});
			if (nativeLiveIntent && !nativeLiveRequest) return handleResponse(requestPayload, sentSpec, context, {retried, candidateIndex}, new Error("OpenAI Chat request cancelled"), null, "");
			const historicalAbortableBatch = !probe && !!(streamTransport && providerAttemptOwner && context && context.historicalBatch === true && context.token && context.token.kind === "historical");
			if (historicalAbortableBatch) return requestHistoricalAbortableCustomText({adapter, url, requestOptions, payload: requestPayload, timingContext: measuredContext, requestContext: effectiveRequestContext, outputCharsFromBody}).then(result => {
				const error = result && result.ok ? null : new Error(`Historical text ${result && result.errorKind || "failed"}`);
				if (error) {error.historicalFailureKind = result && result.errorKind || "transient"; error.physicalSettled = !!(result && result.historicalPhysicalSettled); error.retryAfterMs = result && result.retryAfterMs != null ? Number(result.retryAfterMs) : null;}
				const response = result && result.status ? {statusCode: result.status} : null;
				handleResponse(requestPayload, sentSpec, context, {retried, candidateIndex}, error, response, result && result.body || "");
			});
			const canaryAbortableSingle = !probe && adapter.id === "openai_chat" && !!(streamTransport && providerAttemptOwner && effectiveRequestContext && (effectiveRequestContext.wholeMarkerCanary === true || effectiveRequestContext.wholeMarkerBatchCanary === true));
			if (!useStream && !nativeLiveIntent && !canaryAbortableSingle) {
				return requestWithTimeout(url, Object.assign({}, requestOptions, {body: JSON.stringify(requestPayload)}), (error, response, body) => {
					handleResponse(requestPayload, sentSpec, context, {retried, candidateIndex}, error, response, body);
				}, PROVIDER_REQUEST_TIMEOUT_MS, measuredContext);
			}
			if (!useStream) return requestAbortableOpenAiChatText({url, requestOptions, payload: requestPayload, timingContext: context, requestContext: effectiveRequestContext, outputCharsFromBody}).then(result => {
				if (result.status == 429) scheduleBackoff(PROVIDER_RATE_LIMIT_BACKOFF_MS);
				else if (result.status >= 500) scheduleBackoff(PROVIDER_SERVER_ERROR_BACKOFF_MS);
				const error = result.ok ? null : new Error(`OpenAI Chat text ${result.errorKind || "failed"}`);
				const response = result.status ? {statusCode: result.status} : null;
				handleResponse(requestPayload, sentSpec, context, {retried, candidateIndex}, error, response, result.body || "");
			});
			let streamWireObservation = null;
			return openAiChatStreamRequest.request({
				url,
				requestOptions,
				payload: requestPayload,
				timeoutMs: PROVIDER_REQUEST_TIMEOUT_MS,
				logicalRequestId: effectiveRequestContext.logicalRequestId,
				role: context && context.role || "primary",
				signal: effectiveRequestContext.signal || null,
				isCurrent: effectiveRequestContext.isCurrent,
				onDispatch: body => {streamWireObservation = observePhysicalWire(measuredContext, body); observeDiagnosticRequest(measuredContext, body);}
			}).then(result => {
				const json200 = isValidJson200(result);
				const streamUnsupported = isStreamUnsupportedResponse(result);
				let retryNonstream = false;
				if (streamUnsupported && effectiveRequestContext.compatibilityBudget && typeof effectiveRequestContext.compatibilityBudget.consume == "function") {
					retryNonstream = effectiveRequestContext.compatibilityBudget.consume("stream_to_nonstream");
				}
				recordOpenAiChatStreamLatency(measuredContext, result, {streamFallback: json200 || retryNonstream, outputCharsFromBody, wireObservation: streamWireObservation});
				if (result.status == 429) scheduleBackoff(PROVIDER_RATE_LIMIT_BACKOFF_MS);
				else if (result.status >= 500) scheduleBackoff(PROVIDER_SERVER_ERROR_BACKOFF_MS);
				if (json200) {
					setOpenAiChatStreamCapability(capabilityKey, "unsupported");
					return handleResponse(requestPayload, sentSpec, context, {retried, candidateIndex}, null, {statusCode: 200}, result.body);
				}
				if (streamUnsupported) {
					setOpenAiChatStreamCapability(capabilityKey, "unsupported");
					if (retryNonstream) return send(requestPayload, sentSpec, context, {retried, candidateIndex, forceNonstream: true});
				}
				if (result.mode === "stream") {
					setOpenAiChatStreamCapability(capabilityKey, "supported");
					return handleResponse(requestPayload, sentSpec, context, {retried, candidateIndex}, null, {statusCode: result.status || 200}, streamResponseBody(result));
				}
				const response = result.status ? {statusCode: result.status} : null;
				return handleResponse(requestPayload, sentSpec, context, {retried, candidateIndex}, new Error(`OpenAI Chat stream ${result.errorKind || "failed"}`), response, result.body || "");
			}, error => {
				recordOpenAiChatStreamLatency(measuredContext, {mode: "error", errorKind: "network", status: 0, transportMs: 0, ttftMs: null, streamChunkCount: 0}, {wireObservation: streamWireObservation});
				handleResponse(requestPayload, sentSpec, context, {retried, candidateIndex}, error, null, "");
			});
		};
		const firstPayload = plan.spec ? adapter.applyReasoning(payload, adapter.getReasoningWireSpec(plan.spec)) : payload;
		return send(firstPayload, plan.spec, timingContext);
	}

	function isEngineConfiguredForRuntime(engineKey) {
		if (!translationEngines[engineKey]) return false;
		if (!CREDENTIAL_REQUIRED_ENGINES.includes(engineKey)) return true;
		const auth = getAuth(engineKey);
		if (engineKey == "baidu") return isBaiduCredentialComplete(readBaiduCredentials(auth));
		const key = (auth.key || "").trim();
		if (isOpenAiCompatibleEngineKey(engineKey)) {
			// The shipped oaicompat endpoint and model are placeholders, so leaving them
			// untouched means the engine was never actually configured.
			const endpoint = (auth.endpoint || "").trim();
			const model = (auth.model || "").trim();
			const protocol = getCustomProtocolContext(engineKey, auth);
			const keyOptional = !!(protocol && protocol.adapter.credentialPolicy === "optional");
			return !!(protocol && protocol.endpoint) && !!model && (keyOptional || !!key) && endpoint != translationEngines.oaicompat.endpoint && model != translationEngines.oaicompat.model;
		}
		if (!key) return false;
		const credentialParts = key.split(/\s+/);
		if (engineKey == "papago") return credentialParts.length == 2;
		return true;
	}

	// W2 owns no credentials and never calls the production translation pipeline. This
	// seam keeps the live auth record, normalized endpoint, model and headers inside the
	// provider client while exposing only a digest and anonymous transport metrics to the
	// diagnostics runner. It deliberately bypasses requestWithTimeout: that callback
	// transport cannot physically cancel an in-flight request and mutates global backoff.
	const WIRE_EXPERIMENT_PROTOCOLS = new Set(["openai_chat", "openai_responses", "ollama_native", "gemini_native", "anthropic_messages"]);
	const WIRE_EXPERIMENT_FAMILIES = new Set(["typed-json", "compact-order", "compact-marker"]);
	const WIRE_EXPERIMENT_OBSERVATION_NUMBERS = Object.freeze([
		"sourceBytes", "translateBytes", "wireBytes", "promptBytes", "metadataBytes",
		"requestBodyBytes", "segmentCount", "itemCount", "contextBytes",
		"protectedMarkerBytes", "prohibitedFieldCount", "danglingContextRefCount",
		"danglingContextRefBytes", "configuredTermLeakCount", "wrapperContentLeakCount",
		"emailLeakCount", "bareDomainLeakCount", "ipPortLeakCount", "commandLeakCount"
	]);

	function sanitizeWireExperimentObservation(value) {
		if (!value || typeof value != "object" || Array.isArray(value)) return null;
		const output = {};
		if (WIRE_EXPERIMENT_FAMILIES.has(String(value.wireFamily || ""))) output.wireFamily = String(value.wireFamily);
		if (/^[A-Za-z0-9._:-]{1,32}$/.test(String(value.wireVersion || ""))) output.wireVersion = String(value.wireVersion);
		for (const field of WIRE_EXPERIMENT_OBSERVATION_NUMBERS) {
			if (value[field] == null || !Number.isFinite(Number(value[field]))) continue;
			output[field] = Math.max(0, Math.floor(Number(value[field])));
		}
		if (value.wireAmplification != null && Number.isFinite(Number(value.wireAmplification))) output.wireAmplification = Math.max(0, Number(value.wireAmplification));
		if (value.contextIncluded === true) output.contextIncluded = true;
		if (["pass", "fail", "unknown"].includes(String(value.protectedIntegrity || ""))) output.protectedIntegrity = String(value.protectedIntegrity);
		return Object.keys(output).length ? Object.freeze(output) : null;
	}

	function applyWireExperimentOutputCap(adapter, payload, maxOutputTokens) {
		const cap = Math.max(1, Math.floor(Number(maxOutputTokens)) || 1);
		const next = Object.assign({}, payload || {});
		if (adapter.id === "openai_chat") next.max_tokens = cap;
		else if (adapter.id === "openai_responses") next.max_output_tokens = cap;
		else if (adapter.id === "gemini_native") next.generationConfig = Object.assign({}, next.generationConfig || {}, {maxOutputTokens: cap});
		else if (adapter.id === "anthropic_messages") next.max_tokens = cap;
		else if (adapter.id === "ollama_native") next.options = Object.assign({}, next.options || {}, {num_predict: cap});
		return next;
	}

	function wireExperimentTemperature(adapter, payload) {
		const raw = adapter.id === "gemini_native" ? payload && payload.generationConfig && payload.generationConfig.temperature
			: adapter.id === "ollama_native" ? payload && payload.options && payload.options.temperature
			: payload && payload.temperature;
		return raw == null || !Number.isFinite(Number(raw)) ? null : Number(raw);
	}

	function resolveWireExperimentConfig(engineKey) {
		engineKey = String(engineKey || "");
		const failed = reason => ({ok: false, reason, engineKey});
		if (!streamTransport || !providerAttemptOwner || typeof streamTransport.requestText != "function") return failed("abort-transport-unavailable");
		if (!isAiBatchCapableEngineKey(engineKey)) return failed("capability-unverified");
		if (!isEngineConfiguredForRuntime(engineKey)) return failed("configuration");
		const auth = getAuth(engineKey), engine = translationEngines[engineKey] || {};
		const apiKey = auth.key || "", model = String(auth.model || engine.model || "").trim();
		let adapter = null, endpoint = "", protocol = null;
		if (isOpenAiCompatibleEngineKey(engineKey)) {
			protocol = getCustomProtocolContext(engineKey, auth);
			adapter = protocol && protocol.adapter || null;
			endpoint = protocol && protocol.endpoint || "";
		}
		else if (engineKey === "openai") {
			adapter = openAiResponsesProtocolAdapter;
			endpoint = normalizeApiEndpoint(engineKey, auth.endpoint || engine.endpoint || "");
		}
		else if (engineKey === "gemini") {
			adapter = geminiNativeProtocolAdapter;
			endpoint = normalizeApiEndpoint(engineKey, auth.endpoint || engine.endpoint || "");
		}
		else if (engineKey === "deepseek") {
			adapter = openAiChatProtocolAdapter;
			endpoint = normalizeApiEndpoint(engineKey, auth.endpoint || engine.endpoint || "");
		}
		if (!adapter || !WIRE_EXPERIMENT_PROTOCOLS.has(String(adapter.id || "")) || !adapter.capabilities || adapter.capabilities.batch !== true || typeof adapter.buildBatchRequest != "function" || typeof adapter.parseText != "function" || typeof adapter.parseUsage != "function") return failed("capability-unverified");
		if (!endpoint || !model) return failed("configuration");

		let reasoningSpec = null, reasoningState = {mode: "follow", effectiveProfile: null};
		if (isOpenAiCompatibleEngineKey(engineKey)) {
			const plan = getCustomReasoningPlan(engineKey);
			reasoningState = plan.state || reasoningState;
			if (plan.blocked) return failed(plan.blocked === "invalid-strength" ? "reasoning-invalid" : "reasoning-unsupported");
			const candidates = (plan.candidates || []).filter(spec => !!adapter.getReasoningWireSpec(spec));
			reasoningSpec = plan.spec && candidates.find(spec => spec.candidateId === plan.spec.candidateId) || null;
			if ((reasoningState.mode === "on" || reasoningState.mode === "off") && !reasoningSpec) return failed("reasoning-unsupported");
		}
		const reasoningWire = reasoningSpec && adapter.getReasoningWireSpec(reasoningSpec) || null;
		const configDigest = `w2c1:${historicalAnonymousDigest("w2-config", {
			engineKey,
			endpoint,
			credential: apiKey,
			model,
			protocol: adapter.id,
			adapterVersion: adapter.version || 1,
			reasoningWire
		})}`;
		return {
			ok: true,
			reason: null,
			engineKey,
			apiKey,
			endpoint,
			model,
			adapter,
			reasoningSpec,
			reasoningState,
			configDigest
		};
	}

	function buildWireExperimentRequest(config, {systemPrompt = "", userPrompt = ""} = {}, maxOutputTokens) {
		const request = config.adapter.buildBatchRequest({
			endpoint: config.endpoint,
			apiKey: config.apiKey,
			model: config.model,
			systemPrompt: String(systemPrompt || ""),
			userPrompt: String(userPrompt || ""),
			maxTokens: maxOutputTokens
		});
		let payload = Object.assign({}, request && request.payload || {}, engineRequestExtras(config.engineKey));
		payload = applyWireExperimentOutputCap(config.adapter, payload, maxOutputTokens);
		if (config.reasoningSpec) payload = config.adapter.applyReasoning(payload, config.adapter.getReasoningWireSpec(config.reasoningSpec));
		return {url: request && request.url || "", requestOptions: request && request.requestOptions || {}, payload};
	}

	function publicWireExperimentCapability(config) {
		if (!config || !config.ok) return Object.freeze({ok: false, reason: config && config.reason || "configuration", engineKey: config && config.engineKey || ""});
		let temperature = null;
		try {temperature = wireExperimentTemperature(config.adapter, buildWireExperimentRequest(config, {}, 4096).payload);}
		catch (error) {}
		return Object.freeze({
			ok: true,
			reason: null,
			engineKey: config.engineKey,
			protocolFamily: config.adapter.id,
			adapterVersion: Math.max(1, Math.floor(Number(config.adapter.version)) || 1),
			temperature,
			temperatureMode: temperature == null ? "provider-default" : "fixed",
			reasoningMode: String(config.reasoningState && config.reasoningState.mode || "follow"),
			reasoningProfile: config.reasoningState && config.reasoningState.effectiveProfile || null,
			outputCapSupported: true,
			configDigest: config.configDigest
		});
	}

	function getWireExperimentCapability(engineKey) {
		return publicWireExperimentCapability(resolveWireExperimentConfig(engineKey));
	}

	function createWireExperimentSession(engineKey, {maxRequests = 1, maxOutputTokens = 4096, maxBodyBytes = 65536, signal = null} = {}) {
		const initialConfig = resolveWireExperimentConfig(engineKey);
		const capability = publicWireExperimentCapability(initialConfig);
		const requestLimit = Math.max(1, Math.min(10000, Math.floor(Number(maxRequests)) || 1));
		const outputLimit = Math.max(1, Math.min(65536, Math.floor(Number(maxOutputTokens)) || 4096));
		const bodyLimit = Math.max(1, Math.min(1024 * 1024, Math.floor(Number(maxBodyBytes)) || 65536));
		const runController = new AbortController();
		const attemptGeneration = providerAttemptOwner && typeof providerAttemptOwner.getSnapshot == "function" ? providerAttemptOwner.getSnapshot().generation : null;
		let cancelled = false, stale = false, dispatchCount = 0, settledCount = 0, failedCount = 0, cancelledCount = 0, waiting = 0, active = 0, activeHighWater = 0, activeToken = null;
		let tail = Promise.resolve();
		const externalSignal = signal && typeof signal.addEventListener == "function" ? signal : null;
		let externalAbort = null;

		const snapshot = () => Object.freeze({
			schemaVersion: "w2-provider-v1",
			capability,
			maxRequests: requestLimit,
			maxOutputTokens: outputLimit,
			maxBodyBytes: bodyLimit,
			dispatchCount,
			settledCount,
			failedCount,
			cancelledCount,
			waiting,
			active,
			activeHighWater,
			cancelled,
			stale
		});
		const detachExternal = () => {
			if (!externalSignal || !externalAbort) return;
			try {externalSignal.removeEventListener("abort", externalAbort);} catch (error) {}
			externalAbort = null;
		};
		const cancel = (reason = "w2-cancelled") => {
			if (cancelled) return false;
			cancelled = true;
			try {if (!runController.signal.aborted) runController.abort(String(reason || "w2-cancelled"));} catch (error) {}
			if (activeToken && providerAttemptOwner.owns(activeToken)) providerAttemptOwner.abort(activeToken, String(reason || "w2-cancelled"));
			detachExternal();
			return true;
		};
		if (externalSignal) {
			externalAbort = () => cancel(externalSignal.reason || "w2-external-cancelled");
			try {externalSignal.addEventListener("abort", externalAbort, {once: true});} catch (error) {externalAbort = null;}
			if (externalSignal.aborted) externalAbort && externalAbort();
		}

		const resultWithTransientText = (fields, text = "") => {
			const result = Object.assign({}, fields || {});
			// The validator needs the answer in memory, while diagnostics/export must never
			// acquire source or response text through an innocent object spread.
			Object.defineProperty(result, "text", {value: String(text || ""), enumerable: false});
			return Object.freeze(result);
		};
		const failure = (reason, fields = {}) => resultWithTransientText(Object.assign({ok: false, reason, usage: null, providerMs: 0, httpStatus: null, errorClass: reason}, fields));
		const execute = async input => {
			if (!capability.ok) {failedCount++; return failure(capability.reason);}
			if (cancelled || runController.signal.aborted) {cancelledCount++; return failure("cancelled", {errorClass: "abort"});}
			if (attemptGeneration != null && providerAttemptOwner.getSnapshot().generation !== attemptGeneration) {cancelled = true; cancelledCount++; return failure("cancelled", {errorClass: "abort"});}
			const current = resolveWireExperimentConfig(engineKey);
			if (!current.ok || current.configDigest !== initialConfig.configDigest) {stale = true; failedCount++; return failure("stale", {errorClass: "stale"});}
			let built;
			try {built = buildWireExperimentRequest(initialConfig, input || {}, outputLimit);}
			catch (error) {failedCount++; return failure("request-build", {errorClass: "invalid"});}
			if (!built.url) {failedCount++; return failure("configuration");}
			let body = "";
			try {body = JSON.stringify(built.payload);}
			catch (error) {failedCount++; return failure("request-build", {errorClass: "invalid"});}
			const requestBodyBytes = historicalUtf8ByteLength(body);
			const wireObservation = sanitizeWireExperimentObservation(input && input.wireObservation);
			if (requestBodyBytes > bodyLimit) {failedCount++; return failure("body-budget", {requestBodyBytes, wireObservation});}
			if (dispatchCount >= requestLimit) {failedCount++; return failure("attempt-budget", {requestBodyBytes, wireObservation});}

			dispatchCount++;
			active++;
			activeHighWater = Math.max(activeHighWater, active);
			const startedAt = now();
			activeToken = providerAttemptOwner.begin({logicalRequestId: `w2-${initialConfig.configDigest}-${dispatchCount}`, role: "benchmark", signal: runController.signal});
			let result = null;
			try {
				result = await streamTransport.requestText({
					token: activeToken,
					url: built.url,
					options: Object.assign({}, built.requestOptions || {}, {body}),
					timeoutMs: PROVIDER_REQUEST_TIMEOUT_MS
				});
			}
			catch (error) {
				if (providerAttemptOwner.owns(activeToken)) providerAttemptOwner.abort(activeToken, "w2-transport-error");
				result = {ok: false, errorKind: "network", status: 0, body: ""};
			}
			finally {
				if (activeToken && providerAttemptOwner.owns(activeToken)) providerAttemptOwner.finish(activeToken);
				activeToken = null;
				active--;
				settledCount++;
			}
			const providerMs = Math.max(0, Number(now() - startedAt) || 0);
			const httpStatus = Number(result && result.status) || null;
			if (!result || !result.ok) {
				const errorClass = result && result.errorKind === "abort" ? "abort" : result && result.errorKind === "timeout" ? "timeout" : "network";
				const reason = errorClass === "abort" ? "cancelled" : errorClass;
				if (reason === "cancelled") cancelledCount++; else failedCount++;
				return failure(reason, {providerMs, httpStatus, errorClass, requestBodyBytes, wireObservation});
			}
			if (httpStatus !== 200) {
				failedCount++;
				const errorClass = classifyProviderRequestError(null, {statusCode: httpStatus}, result.body);
				return failure("provider", {providerMs, httpStatus, errorClass, requestBodyBytes, wireObservation});
			}
			let text = "", usage = null;
			try {text = String(initialConfig.adapter.parseText(result.body) || "");} catch (error) {text = "";}
			try {usage = initialConfig.adapter.parseUsage(result.body) || null;} catch (error) {usage = null;}
			if (!text) {failedCount++; return failure("malformed", {providerMs, httpStatus, errorClass: "malformed", requestBodyBytes, usage, wireObservation});}
			return resultWithTransientText({ok: true, reason: null, usage, providerMs, httpStatus, errorClass: null, requestBodyBytes, wireObservation}, text);
		};

		const dispatch = input => {
			waiting++;
			const run = () => {waiting--; return execute(input);};
			const task = tail.then(run, run);
			tail = task.then(() => undefined, () => undefined);
			return task;
		};
		const drain = () => tail.then(() => {detachExternal(); return snapshot();});
		return Object.freeze({capability, dispatch, cancel, drain, snapshot});
	}

	function fetchModelCatalog(engineKey, onUpdate = null) {
		return new Promise(resolve => {
			if (!supportsModelCatalog(engineKey)) return resolve({ok: false, items: []});

			const updateState = patch => {
				modelCatalogState[engineKey] = Object.assign({}, modelCatalogState[engineKey], patch);
				if (typeof onUpdate == "function") onUpdate();
			};

			const engineLabel = getEngineLabel(engineKey);
			const auth = getAuth(engineKey);
			const protocol = getCustomProtocolContext(engineKey, auth);
			const apiKey = (auth.key || "").trim();
			if (!apiKey && !(protocol && protocol.adapter.credentialPolicy === "optional")) {
				dangerToast(`${engineLabel}: ${getCustomText("validate_missing_key")}`);
				return resolve({ok: false, items: []});
			}
			if (isOpenAiCompatibleEngineKey(engineKey) && (!(auth.endpoint || "").trim() || (auth.endpoint || "").trim() == translationEngines.oaicompat.endpoint)) {
				dangerToast(`${engineLabel}: ${getCustomText("validate_missing_endpoint")}`);
				return resolve({ok: false, items: []});
			}

			const normalizedEndpoint = protocol ? protocol.endpoint : normalizeApiEndpoint(engineKey, auth.endpoint || translationEngines[engineKey] && translationEngines[engineKey].endpoint || "");
			if (!normalizedEndpoint) {
				dangerToast(`${engineLabel}: ${getCustomText("validate_missing_endpoint")}`);
				return resolve({ok: false, items: []});
			}

			// Single-protocol engines still get their endpoint tidied in place. A custom
			// provider's suffix belongs to the chosen wire format, so its stored address
			// stays exactly what the user typed and the full path is derived per request -
			// writing the derived path back would wedge the address on one protocol.
			if (!isOpenAiCompatibleEngineKey(engineKey) && auth.endpoint && normalizedEndpoint != auth.endpoint) {
				delete auth.interfaceDetection;
				auth.endpoint = normalizedEndpoint;
				storeAuth(engineKey, auth);
				onEndpointNormalized();
			}

			const customAdapter = protocol && protocol.adapter;
			const catalogRequest = customAdapter && customAdapter.buildCatalogRequest({endpoint: normalizedEndpoint, apiKey});
			const requestUrl = catalogRequest ? catalogRequest.url : getModelCatalogEndpoint(engineKey, normalizedEndpoint);
			if (customAdapter && !isSameEndpointOrigin(normalizedEndpoint, requestUrl)) {
				dangerToast(`${engineLabel}: ${getCustomText("validate_missing_endpoint")}`);
				return resolve({ok: false, items: []});
			}
			updateState({loading: true, endpoint: requestUrl});

			const requestHeaders = {"Content-Type": "application/json"};
			if (engineKey == "gemini") requestHeaders["x-goog-api-key"] = apiKey;
			else requestHeaders.Authorization = `Bearer ${apiKey}`;
			requestWithTimeout(requestUrl, catalogRequest ? catalogRequest.requestOptions : {
				method: "get",
				headers: requestHeaders
			}, (error, response, body) => {
				if (!error && body && response && response && response.statusCode == 200) {
					try {
						body = JSON.parse(body);
						const distinctiveCatalog = !!(customAdapter && customAdapter.catalogDistinctive && typeof customAdapter.isCatalogResponse == "function" && customAdapter.isCatalogResponse(body));
						const rawItems = engineKey == "gemini" ? ((body && body.models) || []).filter(item => !item || !Array.isArray(item.supportedGenerationMethods) || item.supportedGenerationMethods.includes("generateContent")) : customAdapter ? customAdapter.parseCatalog(body) : ((body && body.data) || []);
						const items = rawItems
							.map(item => typeof item == "string" ? item : engineKey == "gemini" ? item && item.name && item.name.replace(/^models\//, "") : item && item.id)
							.filter(item => typeof item == "string" && item.trim())
							.sort((modelA, modelB) => modelA.localeCompare(modelB));
						if (distinctiveCatalog) persistCustomProtocolEvidence(engineKey, protocol, "catalog");
						updateState({
							loading: false,
							items,
							endpoint: requestUrl,
							fetchedAt: now()
						});
						saveModelCatalogs(normalizeStoredModelCatalogs(modelCatalogState));
						toast(
							items.length
								? `${engineLabel}: ${getCustomText("model_catalog_loaded").replace("{count}", items.length)}`
								: `${engineLabel}: ${getCustomText("model_catalog_empty")}`,
							{
								type: items.length ? "success" : "warning",
								position: "center"
							}
						);
						return resolve({ok: true, items});
					}
					catch (err) {}
				}

				updateState({loading: false, items: Array.isArray(modelCatalogState[engineKey] && modelCatalogState[engineKey].items) ? modelCatalogState[engineKey].items : []});
				const details = getValidationErrorDetails(body);
				dangerToast(`${engineLabel}: ${getCustomText("validate_failed")}${response && response.statusCode ? ` (${response.statusCode})` : ""}${details ? ` - ${details}` : ""}`);
				return resolve({ok: false, items: []});
			});
		});
	}

	// Sends one real sample translation so the user finds out here, not on their next
	// message, that a key or endpoint is wrong.
	function validateEngineConfig(engineKey, {rewrite = false} = {}) {
		return new Promise(resolve => {
			if (!isValidatableEngine(engineKey)) return resolve({ok: false, normalized: false});

			const engineLabel = getEngineLabel(engineKey);
			let runningToast = null;
			let validationStartedAt = null;
			let validationHttpStatus = null;
			let validationErrorClass = null;
			let validationErrorParameter = "";
			let validationTimingContext = null;
			const finish = (ok, message, normalized = false, errorClass = validationErrorClass) => {
				if (runningToast) runningToast.close();
				toast(message, {
					type: ok ? "success" : "danger",
					position: "center"
				});
				const result = {ok, normalized};
				if (validationStartedAt != null) {
					Object.assign(result, {
						durationMs: Math.max(0, now() - validationStartedAt),
						httpStatus: validationHttpStatus,
						errorClass: errorClass || null
					});
					if ((validationHttpStatus == 400 || validationHttpStatus == 422) && validationErrorParameter) result.errorParameter = validationErrorParameter;
				}
				resolve(result);
			};
			const auth = getAuth(engineKey);
			let customProtocol = getCustomProtocolContext(engineKey, auth);
			const apiKey = (auth.key || "").trim();
			if (!apiKey && !(customProtocol && customProtocol.adapter.credentialPolicy === "optional")) return finish(false, `${engineLabel}: ${getCustomText("validate_missing_key")}`);
			if (isOpenAiCompatibleEngineKey(engineKey) && (!(auth.endpoint || "").trim() || (auth.endpoint || "").trim() == translationEngines.oaicompat.endpoint)) return finish(false, `${engineLabel}: ${getCustomText("validate_missing_endpoint")}`);
			if (isOpenAiCompatibleEngineKey(engineKey) && (!(auth.model || "").trim() || (auth.model || "").trim() == translationEngines.oaicompat.model)) return finish(false, `${engineLabel}: ${getCustomText("validate_missing_model")}`);

			let normalized = false;
			let apiEndpoint = "";
			if (translationEngines[engineKey] && translationEngines[engineKey].endpoint) {
				apiEndpoint = customProtocol ? customProtocol.endpoint : normalizeApiEndpoint(engineKey, auth.endpoint || translationEngines[engineKey].endpoint);
				// Same rule as the catalog fetch: a custom provider's stored address is the
				// user's text, never the per-format path this one request derived from it.
				if (!isOpenAiCompatibleEngineKey(engineKey) && auth.endpoint && apiEndpoint && apiEndpoint != auth.endpoint) {
					delete auth.interfaceDetection;
					auth.endpoint = apiEndpoint;
					storeAuth(engineKey, auth);
					customProtocol = getCustomProtocolContext(engineKey, auth);
					onEndpointNormalized();
					normalized = true;
				}
				if (!apiEndpoint) return finish(false, `${engineLabel}: ${getCustomText("validate_missing_endpoint")}`, normalized);
			}

			const modelId = (auth.model || translationEngines[engineKey] && translationEngines[engineKey].model || "").trim();
			if (AI_MODEL_ENGINES.includes(engineKey) && !modelId) return finish(false, `${engineLabel}: ${getCustomText("validate_missing_model")}`, normalized);

			const sample = getValidationRequestForEngine(engineKey);
			validationStartedAt = now();
			if (AI_MODEL_ENGINES.includes(engineKey) || isCustomEngineKey(engineKey)) {
				const token = beginLatencyRequest({kind: "detect", messageCount: 1, inputChars: sample.text.length});
				if (token) validationTimingContext = {token, role: "primary", engineKey, messageCount: 1};
			}
			const captureValidationStatus = (error, response, body) => {
				validationHttpStatus = response && response.statusCode || null;
				// This callback cannot see requestWithTimeout's local timedOut flag. Its
				// historical 504=>timeout label therefore intentionally covers both the
				// synthetic timeout and an upstream gateway timeout.
				validationErrorClass = classifyProviderRequestError(error, response, body, {treatHttp504AsTimeout: true});
				validationErrorParameter = validationHttpStatus == 400 || validationHttpStatus == 422 ? getSafeProviderErrorParameter(body) : "";
			};
			const requestValidation = (url, requestOptions, handler) => requestWithTimeout(url, requestOptions, (error, response, body) => {
				captureValidationStatus(error, response, body);
				handler(error, response, body);
			}, PROVIDER_REQUEST_TIMEOUT_MS, validationTimingContext);
			runningToast = toast(`${getCustomText("validate_running")} ${engineLabel}...`, {
				timeout: 0,
				ellipsis: true,
				position: "center"
			});
			const successMessage = translatedText => {
				const suffix = normalized ? ` ${getCustomText("validate_saved_endpoint")}` : "";
				const preview = translatedText ? ` (${translatedText.slice(0, 48)})` : "";
				return `${engineLabel}: ${getCustomText("validate_success")}.${suffix}${preview}`;
			};
			const failMessage = (statusCode, body) => {
				// A 400/422 body may echo arbitrary request material. Only a strict,
				// allowlisted parameter name is safe to surface; other statuses keep the
				// established credential-redacted provider reason.
				const details = statusCode == 400 || statusCode == 422 ? getSafeProviderErrorParameter(body) : getValidationErrorDetails(body);
				return `${engineLabel}: ${getCustomText("validate_failed")}${statusCode ? ` (${statusCode})` : ""}${details ? ` - ${details}` : ""}`;
			};
			const handleChatValidation = (error, response, body, adapter = null) => {
				if (!error && body && response && response.statusCode == 200) {
					try {
						const rawBody = body;
						body = JSON.parse(body);
						const choice = body && body.choices && body.choices[0];
						const message = choice && choice.message;
						const translation = adapter ? adapter.parseText(rawBody) : message && message.content;
						if (translation && translation.trim()) {
							if (customProtocol) persistCustomProtocolValidation(engineKey, customProtocol);
							return finish(true, successMessage(translation.trim()), normalized);
						}
						const adapterUsage = adapter && adapter.parseUsage(rawBody);
						const answeredWithoutContent = adapter ? !!(body && body.status == "incomplete") || !!(adapterUsage && adapterUsage.reasoningTokens) : !!(message && message.reasoning_content) || !!(choice && choice.finish_reason == "length");
						if (answeredWithoutContent && customProtocol) persistCustomProtocolValidation(engineKey, customProtocol);
						return finish(answeredWithoutContent, answeredWithoutContent ? successMessage("") : failMessage(response && response.statusCode, body), normalized);
					}
					catch (err) {}
				}
				return finish(false, failMessage(response && response.statusCode, body), normalized);
			};

			switch (isCustomEngineKey(engineKey) ? "oaicompat" : engineKey) {
				case "googlecloud": {
					const model = (auth.model || "").trim();
					const form = {
						key: apiKey,
						q: sample.text,
						source: sample.source,
						target: sample.target,
						format: "text"
					};
					if (model) form.model = model;
					return requestValidation(apiEndpoint, {
						method: "post",
						form
					}, (error, response, body) => {
						if (!error && body && response && response && response.statusCode == 200) {
							try {
								body = JSON.parse(body);
								const translation = body && body.data && body.data.translations && body.data.translations[0] && body.data.translations[0].translatedText;
								return finish(!!translation, translation ? successMessage(translation) : failMessage(response && response.statusCode, body), normalized);
							}
							catch (err) {}
						}
						return finish(false, failMessage(response && response.statusCode, body), normalized);
					});
				}
				case "microsoft": {
					const headers = {
						"Content-Type": "application/json",
						"Ocp-Apim-Subscription-Key": apiKey
					};
					const region = (auth.region || "").trim();
					if (region && region != "global") headers["Ocp-Apim-Subscription-Region"] = region;
					return requestValidation(apiEndpoint, {
						method: "post",
						headers,
						body: JSON.stringify([{Text: sample.text}]),
						form: {
							"api-version": "3.0",
							"from": mapLanguageCodeForEngine("microsoft", sample.source),
							"to": mapLanguageCodeForEngine("microsoft", sample.target)
						}
					}, (error, response, body) => {
						if (!error && body && response && response && response.statusCode == 200) {
							try {
								body = JSON.parse(body);
								const translation = body && body[0] && body[0].translations && body[0].translations[0] && body[0].translations[0].text;
								return finish(!!translation, translation ? successMessage(translation) : failMessage(response && response.statusCode, body), normalized);
							}
							catch (err) {}
						}
						return finish(false, failMessage(response && response.statusCode, body), normalized);
					});
				}
				case "deepl": {
					const translateEndpoint = auth.paid ? "https://api.deepl.com/v2/translate" : "https://api-free.deepl.com/v2/translate";
					return requestValidation(translateEndpoint, {
						method: "post",
						headers: {
							"Content-Type": "application/json",
							"Authorization": `DeepL-Auth-Key ${apiKey}`
						},
						body: JSON.stringify({
							text: [sample.text],
							source_lang: mapLanguageCodeForEngine("deepl", sample.source),
							target_lang: mapLanguageCodeForEngine("deepl", sample.target)
						})
					}, (error, response, body) => {
						if (!error && body && response && response && response.statusCode == 200) {
							try {
								body = JSON.parse(body);
								const translation = body && body.translations && body.translations[0] && body.translations[0].text;
								return finish(!!translation, translation ? successMessage(translation) : failMessage(response && response.statusCode, body), normalized);
							}
							catch (err) {}
						}
						return finish(false, failMessage(response && response.statusCode, body), normalized);
					});
				}
				case "openai": {
					return requestValidation(apiEndpoint, {
						method: "post",
						headers: {"Content-Type": "application/json", "Authorization": `Bearer ${apiKey}`},
						body: JSON.stringify({
							model: modelId,
							instructions: "You are a translation validator. Return only the translation.",
							input: `Translate the following text from English to German.\n\n${sample.text}`,
							store: false
						})
					}, (error, response, body) => {
						const translation = !error && response && response && response.statusCode == 200 ? parseOpenAiResponseText(body) : "";
						return finish(!!translation, translation ? successMessage(translation) : failMessage(response && response.statusCode, body), normalized);
					});
				}
				case "gemini": {
					const geminiModelId = modelId.replace(/^models\//, "");
					const requestUrl = `${apiEndpoint}/${encodeURIComponent(geminiModelId)}:generateContent`;
					return requestValidation(requestUrl, {
						method: "post",
						headers: {"Content-Type": "application/json", "x-goog-api-key": apiKey},
						body: JSON.stringify({
							system_instruction: {parts: [{text: "You are a translation validator. Return only the translation."}]},
							contents: [{role: "user", parts: [{text: `Translate the following text from English to German.\n\n${sample.text}`}]}]
						})
					}, (error, response, body) => {
						const translation = !error && response && response && response.statusCode == 200 ? parseGeminiResponseText(body) : "";
						return finish(!!translation, translation ? successMessage(translation) : failMessage(response && response.statusCode, body), normalized);
					});
				}
				case "deepseek": {
					return requestValidation(apiEndpoint, {
						method: "post",
						headers: {
							"Content-Type": "application/json",
							"Authorization": `Bearer ${apiKey}`
						},
						body: JSON.stringify({
							model: modelId,
							messages: [{
								role: "system",
								content: "You are a translation validator."
							}, {
								role: "user",
								content: `Translate the following text from English to German. Return only the translation.\n\n${sample.text}`
							}],
							temperature: 0,
							// Room for a reasoning model to think and still answer. At 32 the
							// whole budget went to reasoning_content, content came back empty,
							// and a perfectly good configuration reported validate_failed.
							max_tokens: 512,
							...engineRequestExtras(engineKey)
						})
					}, handleChatValidation);
				}
				case "oaicompat": {
					const adapter = customProtocol && customProtocol.adapter || openAiChatProtocolAdapter;
					const adapterRequest = adapter.buildValidationRequest({
						endpoint: apiEndpoint,
						apiKey,
						model: modelId,
						systemPrompt: "You are a translation validator.",
						userPrompt: `Translate the following text from English to German. Return only the translation.\n\n${sample.text}`,
						maxTokens: 512
					});
					return requestCustomChatCompletion({
						engineKey,
						adapter,
						url: adapterRequest.url,
						requestOptions: adapterRequest.requestOptions,
						payload: adapterRequest.payload,
						timingContext: validationTimingContext,
						probe: true,
						reasoningRewrite: rewrite,
						outputCharsFromBody: body => adapter.parseText(body).length
					}, (error, response, body) => {
						captureValidationStatus(error, response, body);
						handleChatValidation(error, response, body, adapter);
					});
				}
			}
			return finish(false, `${engineLabel}: ${getCustomText("validate_failed")}`, normalized);
		});
	}

	// Each adapter writes the language a provider reports back onto data.input, because
	// the caller renders "translated from X" from that same object.
	// The free endpoint takes the text in the request URL, so a long message used to
	// fail as one oversized request (field 2026-08-19: long messages never translated
	// on the free engine). The text now travels in bounded chunks; any chunk failing
	// fails the whole translation so a partial paint can never look complete.
	function googleApiTranslate(data, callback) {
		// Google sometimes drops the compact corner-bracket placeholder entirely
		// (field reproduction: ⟦4⟧ disappeared from an otherwise valid 200 reply).
		// A wire-only ASCII sentinel survives the same request and is reversed before
		// the shared strict placeholder guard sees the translation.
		const chunks = splitTextIntoTranslationChunks(encodeGoogleFreeProtectionTokens(data.text), FREE_ENGINE_CHUNK_LIMIT);
		const translatedParts = [];
		const requestChunk = index => {
			if (index >= chunks.length) return callback(decodeGoogleFreeProtectionTokens(translatedParts.join("")));
			requestWithTimeout("https://translate.googleapis.com/translate_a/single", {
				form: {
					"client": "gtx",
					"dt": "t",
					"dj": "1",
					"source": "input",
					"sl": data.input.id,
					"tl": data.output.id,
					"q": chunks[index]
				}
			}, (error, response, body) => {
				const labels = getLabels();
				const languages = getLanguages();
				if (!error && body && response && response && response.statusCode == 200) {
					try {
						body = JSON.parse(body);
						// The detected language comes from the first chunk only; later
						// chunks of the same message cannot disagree meaningfully.
						if (index === 0 && !data.specialCase && body.src && body.src && languages[body.src]) {
							data.input.id = body.src;
							data.input.name = languages[body.src].name;
							data.input.ownlang = languages[body.src].ownlang;
						}
						const translated = body.sentences.map(n => n && n.trans).filter(n => n).join("");
						if (!translated) return callback("");
						translatedParts.push(translated);
						requestChunk(index + 1);
					}
					catch (err) {callback("");}
				}
				else {
					if (!data.silent && response && response && response.statusCode == 429) dangerToast(`${labels.toast_translating_failed}. ${labels.toast_translating_tryanother}. ${labels.error_hourlylimit}`);
					else if (!data.silent) dangerToast(`${labels.toast_translating_failed}. ${labels.toast_translating_tryanother}. ${labels.error_serverdown}`);
					callback("");
				}
			}, PROVIDER_REQUEST_TIMEOUT_MS, data.timingContext || null);
		};
		requestChunk(0);
	}

	function googleCloudTranslate(data, callback) {
		const auth = getAuth("googlecloud");
		const apiKey = auth.key || "";
		const apiEndpoint = auth.endpoint || translationEngines.googlecloud.endpoint;
		const modelId = auth.model || translationEngines.googlecloud.model;

		requestWithTimeout(apiEndpoint, {
			method: "post",
			form: Object.assign({
				"key": apiKey,
				"q": data.text,
				"target": data.output.id,
				"format": "text",
				"model": modelId
			}, data.input.auto ? {} : {"source": data.input.id})
		}, (error, response, body) => {
			const labels = getLabels();
			const languages = getLanguages();
			if (!error && body && response && response && response.statusCode == 200) {
				try {
					body = JSON.parse(body);
					const translations = body && body.data && body.data.translations || [];
					if (!data.specialCase && translations[0] && translations[0].detectedSourceLanguage && languages[translations[0].detectedSourceLanguage]) {
						data.input.id = translations[0].detectedSourceLanguage;
						data.input.name = languages[translations[0].detectedSourceLanguage].name;
						data.input.ownlang = languages[translations[0].detectedSourceLanguage].ownlang;
					}
					callback(translations.map(n => n && n.translatedText).filter(n => n).join(""));
				}
				catch (err) {callback("");}
			}
			else {
				if (response && (response.statusCode == 401 || response && response && response.statusCode == 403)) dangerToast(`${labels.toast_translating_failed}. ${labels.toast_translating_tryanother}. ${labels.error_keyoutdated}`);
				else if (response && response && response.statusCode == 429) dangerToast(`${labels.toast_translating_failed}. ${labels.toast_translating_tryanother}. ${labels.error_hourlylimit}`);
				else dangerToast(`${labels.toast_translating_failed}. ${labels.toast_translating_tryanother}. ${labels.error_serverdown}`);
				callback("");
			}
		}, PROVIDER_REQUEST_TIMEOUT_MS, data.timingContext || null);
	}

	function microsoftTranslate(data, callback) {
		const auth = getAuth("microsoft");
		const apiEndpoint = normalizeApiEndpoint("microsoft", auth.endpoint || translationEngines.microsoft.endpoint);
		const apiKey = auth.key || "";
		const region = auth.region || "";
		const headers = {
			"Content-Type": "application/json",
			"Ocp-Apim-Subscription-Key": apiKey
		};
		if (region && region != "global") headers["Ocp-Apim-Subscription-Region"] = region;
		requestWithTimeout(apiEndpoint, {
			method: "post",
			headers,
			body: JSON.stringify([{"Text": data.text}]),
			form: Object.assign({
				"api-version": "3.0",
				"to": mapLanguageCodeForEngine("microsoft", data.output.id)
			}, data.input.auto ? {} : {"from": mapLanguageCodeForEngine("microsoft", data.input.id)})
		}, (error, response, body) => {
			const labels = getLabels();
			const languages = getLanguages();
			if (!error && body && response && response && response.statusCode == 200) {
				try {
					body = JSON.parse(body)[0];
					if (!data.specialCase && body.detectedLanguage && body.detectedLanguage.language && languages[body.detectedLanguage.language.toLowerCase()]) {
						data.input.name = languages[body.detectedLanguage.language.toLowerCase()].name;
						data.input.ownlang = languages[body.detectedLanguage.language.toLowerCase()].ownlang;
					}
					callback(body.translations.map(n => n && n.text).filter(n => n).join(""));
				}
				catch (err) {callback("");}
			}
			else {
				if (response && response && response.statusCode == 403 || response && response && response.statusCode == 429) dangerToast(`${labels.toast_translating_failed}. ${labels.toast_translating_tryanother}. ${labels.error_dailylimit}`);
				else if (response && response && response.statusCode == 401) dangerToast(`${labels.toast_translating_failed}. ${labels.toast_translating_tryanother}. ${labels.error_keyoutdated}`);
				else dangerToast(`${labels.toast_translating_failed}. ${labels.toast_translating_tryanother}. ${labels.error_serverdown}`);
				callback("");
			}
		}, PROVIDER_REQUEST_TIMEOUT_MS, data.timingContext || null);
	}

	function deepLTranslate(data, callback) {
		const auth = getAuth("deepl");
		requestWithTimeout(auth.paid ? "https://api.deepl.com/v2/translate" : "https://api-free.deepl.com/v2/translate", {
			method: "post",
			headers: {
				"Content-Type": "application/json",
				"Authorization": `DeepL-Auth-Key ${auth.key || ""}`
			},
			body: JSON.stringify(Object.assign({
				"text": [data.text],
				"target_lang": mapLanguageCodeForEngine("deepl", data.output.id)
			}, data.input.auto ? {} : {"source_lang": mapLanguageCodeForEngine("deepl", data.input.id)}))
		}, (error, response, body) => {
			const labels = getLabels();
			const languages = getLanguages();
			if (!error && body && response && response && response.statusCode == 200) {
				try {
					body = JSON.parse(body);
					if (!data.specialCase && body.translations[0] && body.translations[0].detected_source_language && languages[body.translations[0].detected_source_language.toLowerCase()]) {
						data.input.name = languages[body.translations[0].detected_source_language.toLowerCase()].name;
						data.input.ownlang = languages[body.translations[0].detected_source_language.toLowerCase()].ownlang;
					}
					callback(body.translations.map(n => n && n.text).filter(n => n).join(""));
				}
				catch (err) {callback("");}
			}
			else {
				if (response && response && response.statusCode == 429 || response && response && response.statusCode == 456) dangerToast(`${labels.toast_translating_failed}. ${labels.toast_translating_tryanother}. ${labels.error_dailylimit}`);
				else if (response && response && response.statusCode == 403) dangerToast(`${labels.toast_translating_failed}. ${labels.toast_translating_tryanother}. ${labels.error_keyoutdated}`);
				else dangerToast(`${labels.toast_translating_failed}. ${labels.toast_translating_tryanother}. ${labels.error_serverdown}`);
				callback("");
			}
		}, PROVIDER_REQUEST_TIMEOUT_MS, data.timingContext || null);
	}

	// Every provider request shares the same timeout and pressure boundary. Keeping
	// the AI response parsing here avoids duplicating their common failure behavior.
	function handleAiProviderTranslationResponse(engineKey, parseResponse, callback, error, response, body, silent = false, requestContext = null) {
		if (!error && body && response && response.statusCode == 200) {
			const translatedText = parseResponse(body);
			if (translatedText) return callback(translatedText);
		}
		const engineName = translationEngines[engineKey] && translationEngines[engineKey].name || engineKey;
		const details = getValidationErrorDetails(body);
		if (!silent) dangerToast(`${getLabels().toast_translating_failed} (${engineName})${details ? ` - ${details}` : ""}`);
		// Canary auth rejection is a provider terminal, not an empty malformed translation.
		if (requestContext && requestContext.wholeMarkerCanary === true && response && [401, 403].includes(response.statusCode)) return callback("", Object.freeze({terminalFailure: "auth", httpStatus: response.statusCode}));
		callback("");
	}

	function requestAiProviderTranslation(engineKey, url, options, parseResponse, callback, timingContext = null) {
		const parsedPayload = parseHistoricalResponseBody(options && options.body);
		const enrichedTimingContext = enrichHistoricalTimingContext(engineKey, timingContext, {payload: parsedPayload});
		const usageFromBody = engineKey === "gemini" ? body => geminiNativeProtocolAdapter.parseUsage(body) : parseOpenAiResponseUsage;
		const measuredTimingContext = enrichedTimingContext ? Object.assign({}, enrichedTimingContext, {
			outputCharsFromBody: body => {
				const translatedText = parseResponse(body);
				return typeof translatedText == "string" ? translatedText.length : null;
			},
			usageFromBody
		}) : null;
		requestWithTimeout(url, options, (error, response, body) => {
			handleAiProviderTranslationResponse(engineKey, parseResponse, callback, error, response, body);
		}, PROVIDER_REQUEST_TIMEOUT_MS, measuredTimingContext);
	}

	function openAiTranslate(data, callback) {
		const auth = getAuth("openai");
		const apiKey = auth.key || "";
		const apiEndpoint = normalizeApiEndpoint("openai", auth.endpoint || translationEngines.openai.endpoint);
		const modelId = auth.model || translationEngines.openai.model;
		const prompt = buildAiProviderTranslationPrompt(data);
		requestAiProviderTranslation("openai", apiEndpoint, {
			method: "post",
			headers: {
				"Content-Type": "application/json",
				"Authorization": `Bearer ${apiKey}`
			},
			body: JSON.stringify({
				model: modelId,
				instructions: prompt.system,
				input: prompt.prompt,
				store: false
			})
		}, body => parseOpenAiResponseText(body), callback, data.timingContext || null);
	}

	function geminiTranslate(data, callback) {
		const auth = getAuth("gemini");
		const apiKey = auth.key || "";
		const apiEndpoint = normalizeApiEndpoint("gemini", auth.endpoint || translationEngines.gemini.endpoint);
		const modelId = (auth.model || translationEngines.gemini.model).replace(/^models\//, "");
		const prompt = buildAiProviderTranslationPrompt(data);
		const requestUrl = `${apiEndpoint}/${encodeURIComponent(modelId)}:generateContent`;
		requestAiProviderTranslation("gemini", requestUrl, {
			method: "post",
			headers: {"Content-Type": "application/json", "x-goog-api-key": apiKey},
			body: JSON.stringify({
				system_instruction: {parts: [{text: prompt.system}]},
				contents: [{role: "user", parts: [{text: prompt.prompt}]}],
				generationConfig: {temperature: 0.2, topP: 0.8}
			})
		}, body => parseGeminiResponseText(body), callback, data.timingContext || null);
	}

	function chatCompletionsTranslate(engineKey, data, callback) {
		if (!isEngineConfiguredForRuntime(engineKey)) return callback("");
		const auth = getAuth(engineKey);
		const apiKey = auth.key || "";
		const customProtocol = getCustomProtocolContext(engineKey, auth);
		const apiEndpoint = customProtocol ? customProtocol.endpoint : normalizeApiEndpoint(engineKey, auth.endpoint || translationEngines[engineKey].endpoint);
		const modelId = auth.model || translationEngines[engineKey].model;
		const prompt = buildAiProviderTranslationPrompt(data);
		const customAdapter = customProtocol && customProtocol.adapter;
		const parseResponse = body => (customAdapter ? customAdapter.parseText(body) : parseOpenAiResponseText(body)).replace(/\[NEWLINE\]/g, "\n");
		if (customAdapter) {
			const adapterRequest = customAdapter.buildSingleRequest({endpoint: apiEndpoint, apiKey, model: modelId, systemPrompt: prompt.system, userPrompt: prompt.prompt});
			return requestCustomChatCompletion({
				engineKey,
				adapter: customAdapter,
				url: adapterRequest.url,
				requestOptions: adapterRequest.requestOptions,
				payload: adapterRequest.payload,
				timingContext: data.timingContext || null,
				requestContext: data.requestContext || null,
				reasoningOverride: data.reasoningOverride || null,
				outputCharsFromBody: body => parseResponse(body).length,
				onResponseMetrics: data.onResponseMetrics || null
			}, (error, response, body) => handleAiProviderTranslationResponse(engineKey, parseResponse, callback, error, response, body, !!data.silent, data.requestContext || null));
		}
		const requestOptions = {method: "post", headers: {"Content-Type": "application/json", "Authorization": `Bearer ${apiKey}`}};
		const payload = {
			model: modelId,
			messages: [{role: "system", content: prompt.system}, {role: "user", content: prompt.prompt}],
			temperature: 0.2,
			top_p: 0.8
		};
		return requestAiProviderTranslation(engineKey, apiEndpoint, Object.assign({}, requestOptions, {
			body: JSON.stringify(Object.assign({}, payload, engineRequestExtras(engineKey)))
		}), parseResponse, callback, data.timingContext || null);
	}

	function deepSeekTranslate(data, callback) {
		return chatCompletionsTranslate("deepseek", data, callback);
	}

	function openAiCompatibleTranslate(data, callback) {
		// Custom providers reuse this adapter; the engine id rides on the request data.
		const engineKey = data && data.engine && isCustomEngineKey(data.engine.id) ? data.engine.id : "oaicompat";
		return chatCompletionsTranslate(engineKey, data, callback);
	}

	function papagoTranslate(data, callback) {
		const credentials = (getAuth("papago").key || "").split(" ");
		const doTranslate = langCode => {
			langCode = normalizePapagoLanguageCode(langCode);
			const targetLangCode = normalizePapagoLanguageCode(data.output.id);
			if (!isPapagoLanguagePairSupported(langCode, targetLangCode)) return callback("");
			requestWithTimeout("https://openapi.naver.com/v1/papago/n2mt", {
				method: "post",
				headers: {
					"X-Naver-Client-Id": credentials[0],
					"X-Naver-Client-Secret": credentials[1],
					"Content-Type": "application/x-www-form-urlencoded"
				},
				form: {
					source: langCode,
					target: targetLangCode,
					text: data.text
				}
			}, (error, response, body) => {
				const labels = getLabels();
				if (!error && body && response && response && response.statusCode == 200) {
					try {
						const message = (JSON.parse(body) || {}).message;
						const result = message && (message.body || message.result);
						if (result && result.translatedText) callback(result.translatedText);
						else callback("");
					}
					catch (err) {callback("");}
				}
				else {
					if (response && response && response.statusCode == 429) dangerToast(`${labels.toast_translating_failed}. ${labels.toast_translating_tryanother}. ${labels.error_hourlylimit}`);
					else dangerToast(`${labels.toast_translating_failed}. ${labels.toast_translating_tryanother}. ${labels.error_serverdown}/${labels.error_keyoutdated}`);
					callback("");
				}
			}, PROVIDER_REQUEST_TIMEOUT_MS, data.timingContext || null);
		};
		// Papago has no auto-detect on the translate call, so detection is its own hop.
		if (data.input.auto) {
			requestWithTimeout("https://openapi.naver.com/v1/papago/detectLangs", {
				method: "post",
				headers: {
					"X-Naver-Client-Id": credentials[0],
					"X-Naver-Client-Secret": credentials[1],
					"Content-Type": "application/x-www-form-urlencoded"
				},
				form: {
					query: data.text
				}
			}, (error, response, body) => {
				const languages = getLanguages();
				let langCode = "";
				if (!error && body && response && response && response.statusCode == 200) {
					try {
						const detectedLangCode = normalizePapagoLanguageCode(JSON.parse(body)["langCode"]);
						if (languages[detectedLangCode] && translationEngines.papago.languages.includes(detectedLangCode)) langCode = detectedLangCode;
					}
					catch (err) {}
				}
				if (!langCode) return callback("");
				const detectedLanguage = languages[langCode];
				if (detectedLanguage) {
					data.input.name = detectedLanguage.name;
					data.input.ownlang = detectedLanguage.ownlang;
				}
				doTranslate(langCode);
			}, PROVIDER_REQUEST_TIMEOUT_MS, data.timingContext || null);
		}
		else doTranslate(data.input.id);
	}

	function baiduTranslate(data, callback) {
		const credentials = readBaiduCredentials(getAuth("baidu"));
		const salt = generateId();
		requestWithTimeout("https://fanyi-api.baidu.com/api/trans/vip/translate", {
			bdVersion: true,
			method: "post",
			form: {
				from: translationEngines.baidu.parser[data.input.id] || data.input.id,
				to: translationEngines.baidu.parser[data.output.id] || data.output.id,
				q: encodeURIComponent(data.text),
				appid: credentials.appId,
				salt: salt,
				sign: MD5(credentials.appId + data.text + salt + credentials.secretKey)
			}
		}, (error, response, result) => {
			const labels = getLabels();
			if (!error && result && response && response && response.statusCode == 200) {
				try {
					result = JSON.parse(result) || {};
					if (!result.error_code) {
						const messages = result.trans_result;
						if (messages && messages.length > 0 && result.from != result.to) callback(messages.map(message => decodeURIComponent(message.dst)).join("\n"));
						else {callback("");}
					}
					else {
						if (result.error_code == 54004) dangerToast(`${labels.toast_translating_failed}. ${labels.toast_translating_tryanother}. ${labels.error_monthlylimit}.`);
						else dangerToast(`${labels.toast_translating_failed}. ${labels.toast_translating_tryanother}. ${result.error_code} : ${result.error_msg}.`);
						callback("");
					}
				}
				catch (err) {callback("");}
			}
			else {
				dangerToast(`${labels.toast_translating_failed}. ${labels.toast_translating_tryanother}. ${labels.error_serverdown}`);
				callback("");
			}
		}, PROVIDER_REQUEST_TIMEOUT_MS, data.timingContext || null);
	}

	const engineAdapters = {
		googleApiTranslate,
		googleCloudTranslate,
		microsoftTranslate,
		deepLTranslate,
		deepSeekTranslate,
		openAiTranslate,
		geminiTranslate,
		openAiCompatibleTranslate,
		papagoTranslate,
		baiduTranslate
	};

	function getEngineAdapter(engineKey) {
		const engine = translationEngines[engineKey];
		return engine && engineAdapters[engine.funcName] || null;
	}

	function translate(engineKey, data, callback) {
		const adapter = getEngineAdapter(engineKey);
		if (!adapter) return callback("");
		return adapter(data, callback);
	}

	// One request for a whole screen of history. The wire shape is a JSON array keyed by
	// message id, so a partial or reordered answer still lands on the right messages.
	function requestWholeMarkerBatch(engineKey, items, timingContext, claim) {
		const auth = getAuth(engineKey), protocol = getCustomProtocolContext(engineKey, auth), adapter = protocol && protocol.adapter || openAiChatProtocolAdapter;
		const endpoint = protocol ? protocol.endpoint : normalizeApiEndpoint(engineKey, auth.endpoint || translationEngines[engineKey].endpoint), model = auth.model || translationEngines[engineKey].model;
		return claim.run((batch, role, requestContext) => new Promise(resolve => {
			if (!requestContext.isCurrent()) return resolve({failureKind: "stale"});
			const built = adapter.buildBatchRequest({endpoint, apiKey: auth.key || "", model, systemPrompt: batch.systemPrompt, userPrompt: batch.wire});
			const token = timingContext && timingContext.token || beginLatencyRequest({kind: "live", lane: "live-burst", messageCount: items.length});
			const context = Object.assign({}, timingContext, {token, role, requestContext, messageCount: batch.entries.length, historicalKeySeed: Object.freeze({engine: engineKey, endpoint, credential: auth.key || "", model, protocol: adapter.id, adapterVersion: adapter.version, schemaVersion: batch.contractRevision, promptVersion: batch.contractRevision, languageRules: {output: items[0].output.id}, itemCount: batch.entries.length, inputChars: batch.wire.length, promptChars: batch.systemPrompt.length + batch.wire.length})});
			requestCustomChatCompletion({engineKey, adapter, url: built.url, requestOptions: built.requestOptions, payload: built.payload, timingContext: context, requestContext}, (error, response, body) => {
				if (!requestContext.isCurrent()) return resolve({failureKind: "stale"});
				const statusCode = response && response.statusCode || null;
				if (statusCode === 401 || statusCode === 403) return resolve({failureKind: "auth", statusCode});
				if (error || statusCode !== 200) return resolve({failureKind: statusCode === 413 ? "request_budget" : statusCode === 409 ? "attempt_budget" : statusCode === 429 ? "rate_limit" : statusCode >= 500 ? "server" : statusCode === 400 ? "schema" : error && error.historicalFailureKind || (error ? "transient" : "permanent"), statusCode});
				if (historicalUtf8ByteLength(typeof body === "string" ? body : JSON.stringify(body)) > 65536) return resolve({failureKind: "response-budget", statusCode});
				let text; try {text = adapter.parseText(body);} catch {return resolve({failureKind: "malformed", statusCode});}
				resolve({text: String(text || ""), statusCode});
			});
		}));
	}
	function requestAiBatchTranslationDetailed(engineKey, preparedItems, timingContext = null) {
		if (Array.isArray(preparedItems) && preparedItems.some(item => item && item.wholeMarkerBatchFinal)) return Promise.resolve({translations: null, failureKind: "w5-terminal", statusCode: null});
		if (isOpenAiCompatibleEngineKey(engineKey) && isEngineConfiguredForRuntime(engineKey) && streamTransport && providerAttemptOwner) {
			const protocol = getCustomProtocolContext(engineKey, getAuth(engineKey)), adapter = protocol && protocol.adapter || openAiChatProtocolAdapter;
			if (adapter.id === "openai_chat") {const claim = wholeMarkerBatchCanary.claim(engineKey, preparedItems, timingContext); if (claim) return requestWholeMarkerBatch(engineKey, preparedItems, timingContext, claim);}
		}
		return new Promise(resolve => {
			const finishFailure = (failureKind, statusCode = null, metadata = null) => {
				const outcome = {translations: null, failureKind, statusCode};
				if (metadata && typeof metadata.physicalSettled == "boolean") Object.defineProperty(outcome, "historicalPhysicalSettled", {value: metadata.physicalSettled, enumerable: false});
				return resolve(outcome);
			};
			if (!engineKey || !preparedItems || !preparedItems.length || !isEngineConfiguredForRuntime(engineKey)) return finishFailure("configuration");
			const auth = getAuth(engineKey);
			const apiKey = auth.key || "";
			const customProtocol = getCustomProtocolContext(engineKey, auth);
			const observationEngineFamily = customProtocol && customProtocol.adapter && !["openai_chat", "openai_responses"].includes(customProtocol.adapter.id) ? "native" : isCustomEngineKey(engineKey) ? "custom" : ["gemininative", "anthropicnative"].includes(engineKey) ? "native" : "ai";
			const apiEndpoint = customProtocol ? customProtocol.endpoint : normalizeApiEndpoint(engineKey, auth.endpoint || translationEngines[engineKey].endpoint);
			const modelId = auth.model || translationEngines[engineKey].model;
			const batchInputChars = preparedItems.reduce((total, item) => total + String(item && item.protectedText || "").length, 0);
			let effectiveTimingContext = timingContext;
			if (!effectiveTimingContext) {
				const token = beginLatencyRequest({kind: "historical", messageCount: preparedItems.length, inputChars: batchInputChars});
				if (token) effectiveTimingContext = {token, role: "primary", engineKey, messageCount: preparedItems.length};
			}
			const output = preparedItems[0].output;
			const input = preparedItems[0].input;
			const semanticBatch = preparedItems.every(item => item && item.semanticRequest && item.semanticRequest.enabled), payloadItems = semanticBatch ? preparedItems.map(item => ({id: String(item.message.id), plan: JSON.parse(item.semanticRequest.wire)})) : preparedItems.map(item => ({
				id: String(item.message.id),
				text: item.protectedText.replace(/\n/g, " [NEWLINE] ").replace(/\s+/g, " ")
			}));
			// The user's translation preferences ride once per batch in the system prompt.
			const preferenceBlock = buildTranslationPreferenceBlock(getAiAutoTranslatePrompt({input, output}));
			const inlineFormatting = semanticBatch && preparedItems.some(item => item.semanticRequest.plan && item.semanticRequest.plan.inlineRanges && item.semanticRequest.plan.inlineRanges.formatCount);
			const nameRepair = semanticBatch && preparedItems.some(item => item.semanticRequest.attempt > 1 && item.semanticRequest.contextNameIds && item.semanticRequest.contextNameIds.length);
			const systemPrompt = semanticBatch ? `${buildTypedBatchSystemPrompt(output.id, {inlineFormatting, sourceContext: payloadItems.some(item => item.plan.sourceContext), nameKeep: payloadItems.some(item => item.plan.segments.some(row => row.allowNameKeep))})}${preferenceBlock}${nameRepair ? NAME_REPAIR_INSTRUCTION : ""}` : `You are a strict Discord chat batch translator. Return valid JSON only.${preferenceBlock}`;
			// When the channel runs AI decision mode the fixed skip rules apply to legacy batches
			// too; otherwise batching silently translates what the single-message path would
			// have left alone. The user's text is a preference block now, never a skip rule.
			const batchChannelId = preparedItems[0].channelId || null;
			const decisionRules = shouldUseAiAutoTranslateDecision(batchChannelId)
				? `Apply these skip rules to every message; when a message should not be translated set its "translation" to exactly ${AI_SKIP_TRANSLATION_TOKEN}.\n${LEGACY_DECISION_RULES}`
				: "The plugin has already filtered messages that should be skipped; do not make skip decisions.";
			// Message ids travel as short labels too; parseSemanticBatch maps them back to the real ids in payloadItems.
			const semanticMessageLabels = semanticBatch ? new Map(payloadItems.map((item, index) => [`m${index + 1}`, item.id])) : null;
			const batchPrompt = semanticBatch ? JSON.stringify({schemaVersion: "semantic-batch-v1", targetLanguageId: output.id, messages: payloadItems.map((item, index) => ({id: `m${index + 1}`, plan: typedBatchItemPayload(item.plan)}))}) : `Target language is exactly ${output.name || output.id}. Input language is ${input && input.auto ? "auto-detect" : (input.name || input.id || "auto")}. ${decisionRules}\nRules:\n1. Return ONLY a JSON array. Each item must be {"id":"same id","translation":"translated text"}.\n2. Translate every provided natural-language message into exactly the target language.\n3. Preserve placeholders like ⟦0⟧ and ⟦DTA0⟧ exactly. Preserve URLs, code, emoji, mentions, IDs, and product/model names.\n4. Convert [NEWLINE] markers back to real line breaks in the translation; do not show [NEWLINE] literally.\n5. Do not omit any source content, including short interjections, laughter, particles, repeated words, or standalone short lines; translate or preserve them naturally in the target language.\n6. Do not add explanations. Do not output any language other than the target language except preserved protected content.\n\nMessages JSON:\n${JSON.stringify(payloadItems)}`;
			const batchObservationProbe = combineWireObservationProbes(preparedItems.map(item => item && item.wireObservationProbe), {wireFamily: semanticBatch ? "typed-json" : "legacy-batch", wireVersion: semanticBatch ? preparedItems[0].semanticRequest.wireVersion || preparedItems[0].semanticRequest.semanticRevision : "legacy", wire: batchPrompt, itemCount: preparedItems.length});
			if (semanticBatch && typeof observeCompactWireShadowBatch == "function") try {observeCompactWireShadowBatch({requests: preparedItems.map(item => item.semanticRequest), typedBatchBytes: historicalUtf8ByteLength(batchPrompt), typedPromptBytes: historicalUtf8ByteLength(systemPrompt), itemCount: preparedItems.length});} catch (error) {}
			if (effectiveTimingContext) effectiveTimingContext = Object.assign({}, effectiveTimingContext, {wireObservationProbe: batchObservationProbe, engineFamily: observationEngineFamily});
			if (effectiveTimingContext && effectiveTimingContext.token) for (const item of preparedItems) if (item) item.wireObservationToken = effectiveTimingContext.token;
			// A single message keeps its direct-segments shortcut; multi-message batches go through the
			// tolerant reader, which also names the answer shape for the diagnostics counters.
			const readSemanticBatch = content => {
				const expected = new Set(payloadItems.map(item => item.id)), single = payloadItems.length === 1 ? payloadItems[0] : null, singleSegmentIds = single ? new Set(single.plan.segments.map(segment => String(segment.id))) : null;
				const readOptions = {expectedIds: expected, resolveId: rawId => semanticMessageLabels && semanticMessageLabels.has(rawId) ? semanticMessageLabels.get(rawId) : rawId, planSegmentIdsFor: id => {const item = payloadItems.find(candidate => candidate.id === id); return item && item.plan && Array.isArray(item.plan.segments) ? item.plan.segments.map(segment => String(segment.id)) : null;}};
				const batchAnswer = readSemanticBatchAnswer(content, readOptions);
				// Even a singleton can be split across message rows. Its explicit envelope
				// must win over a nested segment array found by the direct-response shortcut.
				if (batchAnswer.translations) return batchAnswer;
				const candidates = single ? parseJsonPayloadCandidates(content) : [];
				if (single) for (const parsed of candidates) {
					const direct = parseTypedPlanResponse(parsed), explicitRoot = !!(parsed && !Array.isArray(parsed) && Array.isArray(parsed.segments)), idsBelong = Array.isArray(direct) && direct.length > 0 && direct.every(row => singleSegmentIds.has(String(row && row.id || "")));
					if (Array.isArray(direct) && (explicitRoot || idsBelong)) {
						// Inspect the original envelope, but return the shortcut's exact rows. A
						// second parse of normalized rows can reinterpret ID-less text as JSON.
						const structure = Object.assign({}, batchAnswer.structure);
						const bareSegments = Array.isArray(candidates[0]) && candidates[0].length > 0 && candidates[0].every(row => singleSegmentIds.has(String(row && row.id || "")));
						if (structure.envelope === "segment-root" || bareSegments) Object.assign(structure, {rowCount: 1, recognizedMessageCount: 1, missingMessageCount: 0, missingIdRowCount: 0, unknownIdRowCount: 0, duplicateMessageRowCount: 0, invalidRowCount: 0});
						const returnedIds = new Set(direct.map(row => String(row.id == null ? "" : row.id)));
						Object.assign(structure, {parsedMessageCount: 1, unreadableMessageCount: 0, missingSegmentCount: [...singleSegmentIds].filter(id => !returnedIds.has(id)).length});
						return {translations: {[single.id]: {semanticSegments: direct}}, shapes: [], malformed: null, structure: Object.freeze(structure)};
					}
				}
				return batchAnswer;
			};
			const parseSemanticBatch = content => readSemanticBatch(content).translations;
			const measureBatchOutputChars = parseResponseText => body => {
				const translations = semanticBatch ? parseSemanticBatch(parseResponseText(body)) : parseAiBatchTranslationResponse(parseResponseText(body), payloadItems.map(item => item.id));
				return translations && Object.values(translations).reduce((total, value) => total + (semanticBatch
					? value.semanticSegments.reduce((chars, segment) => chars + (typeof segment.translation === "string" ? segment.translation.length : 0), 0)
					: String(value || "").length), 0);
			};
			const withBatchOutputMeasurement = (parseResponseText, adapter = null, protocol = "openai_chat", adapterVersion = 1) => effectiveTimingContext ? Object.assign({}, effectiveTimingContext, {
				outputCharsFromBody: measureBatchOutputChars(parseResponseText),
				usageFromBody: adapter && typeof adapter.parseUsage == "function" ? body => adapter.parseUsage(body) : parseOpenAiResponseUsage,
				historicalUsageFromBody: adapter && typeof adapter.parseUsage == "function" ? body => adapter.parseUsage(body) : parseOpenAiResponseUsage,
				historicalKeySeed: Object.freeze({
					engine: engineKey,
					endpoint: apiEndpoint,
					credential: apiKey,
					model: modelId,
					protocol,
					adapterVersion,
					schemaVersion: 1,
					promptVersion: semanticBatch ? TYPED_BATCH_PROMPT_VERSION : "historical-batch-v1",
					languageRules: {input: input && input.id || null, output: output && output.id || null, decisionRules},
					itemCount: preparedItems.length,
					inputChars: batchInputChars,
					promptChars: systemPrompt.length + batchPrompt.length
				})
			}) : null;
			let semanticCompatibilityFallbackStarted = false;
			const runSemanticCompatibilityFallback = statusCode => {
				if (!semanticBatch || semanticCompatibilityFallbackStarted || !preparedItems.every(item => typeof item.legacyProtectedText === "string" && item.legacyExceptions && typeof item.legacyExceptions === "object")) return false;
				semanticCompatibilityFallbackStarted = true;
				if (effectiveTimingContext && effectiveTimingContext.token) try {recordSemanticObservation({token: effectiveTimingContext.token, reason: "malformed", fallbackKind: "root-malformed"});} catch (error) {}
				if (effectiveTimingContext && effectiveTimingContext.token) try {recordAttemptOutcome({token: effectiveTimingContext.token, outcome: "failed", stage: "parse", reason: "malformed"});} catch (error) {}
				for (const item of preparedItems) {item.semanticFallbackRevision = item.semanticRequest && item.semanticRequest.semanticRevision || null; item.semanticCompatibilityFallback = "root-malformed-pending";}
				const legacyItems = preparedItems.map(item => Object.assign({}, item, {semanticRequest: null, protectedText: item.legacyProtectedText, exceptions: item.legacyExceptions, wireObservationProbe: item.legacyWireObservationProbe, semanticCompatibilityFallback: "root-malformed"}));
				const fallbackTiming = effectiveTimingContext ? Object.assign({}, effectiveTimingContext, {role: "fallback", observationRole: "fallback"}) : null;
				requestAiBatchTranslationDetailed(engineKey, legacyItems, fallbackTiming).then(outcome => {
					if (outcome && outcome.translations) {
						for (const item of preparedItems) {item.semanticCompatibilityFallback = "root-malformed"; item.semanticRequest = null; item.semanticOutcome = null; item.semanticPriorValid = {}; item.semanticRepair = false; item.protectedText = item.legacyProtectedText; item.exceptions = item.legacyExceptions;}
						try {Object.defineProperty(outcome, "semanticCompatibilityFallback", {value: true, enumerable: false});} catch {}
						resolve(outcome);
					}
					else {for (const item of preparedItems) {item.semanticCompatibilityFallback = "root-malformed-failed"; item.semanticCompatibilityFallbackFailed = true;} finishFailure(outcome && ["auth", "configuration", "request_budget", "attempt_budget"].includes(outcome.failureKind) ? outcome.failureKind : "semantic_schema", outcome && outcome.statusCode != null ? outcome.statusCode : statusCode);}
				}, () => {for (const item of preparedItems) {item.semanticCompatibilityFallback = "root-malformed-failed"; item.semanticCompatibilityFallbackFailed = true;} finishFailure("semantic_schema", statusCode);});
				return true;
			};
			const finishResponse = (error, response, body, parseResponseText, parseBatchResponse = null) => {
				const statusCode = response && response.statusCode || null;
				const historical = effectiveTimingContext && effectiveTimingContext.token && effectiveTimingContext.token.kind === "historical";
				if (!error && response && statusCode == 200) {
					const semanticRead = semanticBatch ? readSemanticBatch(parseResponseText(body)) : null;
					const translations = semanticBatch ? semanticRead.translations : parseBatchResponse ? parseBatchResponse(body, payloadItems.map(item => item.id)) : parseAiBatchTranslationResponse(parseResponseText(body), payloadItems.map(item => item.id));
					const fallbackStarted = translations === null && runSemanticCompatibilityFallback(statusCode);
					// One observation per parsed response, including canonical ones for a denominator.
					// The output-size measurement reader stays pure and cannot double-count responses.
					if (semanticRead && effectiveTimingContext && effectiveTimingContext.token) {
						const shapes = translations === null ? [semanticRead.malformed || "unknown"] : semanticRead.shapes;
						try {recordSemanticObservation({token: effectiveTimingContext.token, shapes, batchAnswer: Object.assign({}, semanticRead.structure, {promptVersion: TYPED_BATCH_PROMPT_VERSION, malformed: semanticRead.malformed, fallbackStarted})});} catch (error) {}
					}
					if (translations === null) return fallbackStarted || finishFailure("malformed", statusCode);
					return resolve({translations, failureKind: null, statusCode});
				}
				if (statusCode == 401 || statusCode == 403) {
					const labels = getLabels();
					dangerToast(`${labels.toast_translating_failed}. ${labels.toast_translating_tryanother}. ${labels.error_keyoutdated}`);
					return finishFailure("auth", statusCode);
				}
				if (historical && error && error.historicalFailureKind) {
					const kind = error.historicalFailureKind === "abort" ? "transient" : error.historicalFailureKind;
					return finishFailure(kind, statusCode, {physicalSettled: !!error.physicalSettled});
				}
				if (statusCode == 413) return finishFailure("request_budget", statusCode);
				if (statusCode == 409) return finishFailure("attempt_budget", statusCode);
				if (historical && statusCode == 429) return finishFailure("rate_limit", statusCode);
				if (historical && statusCode >= 500 && statusCode != 504) return finishFailure("server", statusCode);
				if (historical && statusCode == 400) {
					const classified = classifyProviderRequestError(error, response, body);
					if (["schema", "invalid_request", "unsupported_field", "unsupported_value"].includes(classified)) return finishFailure("schema", statusCode);
				}
				if (error || !response || statusCode == 408 || statusCode == 429 || statusCode >= 500) return finishFailure("transient", statusCode);
				return finishFailure("permanent", statusCode);
			};
			const batchRequestOptions = {endpoint: apiEndpoint, apiKey, model: modelId, systemPrompt, userPrompt: batchPrompt, jsonObject: semanticBatch};
			if (engineKey == "openai") {
				return requestWithTimeout(apiEndpoint, {
					method: "post",
					headers: {"Content-Type": "application/json", "Authorization": `Bearer ${apiKey}`},
					body: JSON.stringify(openAiResponsesProtocolAdapter.buildBatchRequest(batchRequestOptions).payload)
				}, (error, response, body) => finishResponse(error, response, body, parseOpenAiResponseText), PROVIDER_REQUEST_TIMEOUT_MS, withBatchOutputMeasurement(parseOpenAiResponseText, openAiResponsesProtocolAdapter, "openai_responses", openAiResponsesProtocolAdapter.version));
			}
			if (engineKey == "gemini") {
				const geminiModelId = String(modelId || "").replace(/^models\//, "");
				const requestUrl = `${apiEndpoint}/${encodeURIComponent(geminiModelId)}:generateContent`;
				return requestWithTimeout(requestUrl, {
					method: "post",
					headers: {"Content-Type": "application/json", "x-goog-api-key": apiKey},
					body: JSON.stringify(geminiNativeProtocolAdapter.buildBatchRequest(batchRequestOptions).payload)
				}, (error, response, body) => finishResponse(error, response, body, parseGeminiResponseText), PROVIDER_REQUEST_TIMEOUT_MS, withBatchOutputMeasurement(parseGeminiResponseText, geminiNativeProtocolAdapter, "gemini_native", geminiNativeProtocolAdapter.version));
			}
			if (isOpenAiCompatibleEngineKey(engineKey)) {
				const adapter = customProtocol && customProtocol.adapter || openAiChatProtocolAdapter;
				// Only the typed batch returns an object; legacy fallback returns an array.
				const adapterRequest = adapter.buildBatchRequest(batchRequestOptions);
				return requestCustomChatCompletion({
					engineKey,
					adapter,
					url: adapterRequest.url,
					requestOptions: adapterRequest.requestOptions,
					payload: adapterRequest.payload,
					timingContext: withBatchOutputMeasurement(adapter.parseText, adapter, adapter.id, adapter.version),
					outputCharsFromBody: measureBatchOutputChars(adapter.parseText)
				}, (error, response, body) => finishResponse(error, response, body, adapter.parseText, adapter.parseBatch));
			}
			requestWithTimeout(apiEndpoint, {
				method: "post",
				headers: {"Content-Type": "application/json", "Authorization": `Bearer ${apiKey}`},
				body: JSON.stringify({...openAiChatProtocolAdapter.buildBatchRequest(batchRequestOptions).payload, ...engineRequestExtras(engineKey)})
			}, (error, response, body) => finishResponse(error, response, body, parseOpenAiResponseText), PROVIDER_REQUEST_TIMEOUT_MS, withBatchOutputMeasurement(parseOpenAiResponseText, openAiChatProtocolAdapter, "openai_chat", openAiChatProtocolAdapter.version));
		});
	}

	function requestAiBatchTranslation(engineKey, preparedItems) {
		return requestAiBatchTranslationDetailed(engineKey, preparedItems).then(outcome => outcome.translations);
	}

	function getNearestRankBenchmarkValue(values, percentile) {
		if (!values.length) return null;
		const sorted = values.slice().sort((a, b) => a - b);
		return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(percentile * sorted.length) - 1))];
	}

	async function runSyntheticBenchmark(engineKey, {onProgress = () => {}, isCancelled = () => false} = {}) {
		const reasoning = getReasoningControlStatus(engineKey);
		const fixturesTotal = SYNTHETIC_BENCHMARK_TEXTS.length;
		const total = fixturesTotal * 2;
		const fingerprint = getBenchmarkFingerprint(engineKey);
		const arms = {
			baseline: {durations: [], successCount: 0, failureCount: 0, inputChars: 0, outputChars: 0, usageSampleCount: 0, reasoningSampleCount: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, usageDurationMs: 0},
			controlled: {durations: [], successCount: 0, failureCount: 0, inputChars: 0, outputChars: 0, usageSampleCount: 0, reasoningSampleCount: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, usageDurationMs: 0}
		};
		let completed = 0;
		let consecutiveFailures = 0;
		const snapshotArm = arm => {
			const usageReady = arm.usageSampleCount >= 5;
			const reasoningReady = arm.reasoningSampleCount >= 5;
			return Object.freeze({
				successCount: arm.successCount,
				failureCount: arm.failureCount,
				p50Ms: arm.successCount === fixturesTotal ? getNearestRankBenchmarkValue(arm.durations, 0.50) : null,
				p95Ms: arm.successCount === fixturesTotal ? getNearestRankBenchmarkValue(arm.durations, 0.95) : null,
				inputChars: arm.inputChars,
				outputChars: arm.outputChars,
				usageSampleCount: arm.usageSampleCount,
				reasoningSampleCount: arm.reasoningSampleCount,
				promptTokens: usageReady ? arm.promptTokens : null,
				completionTokens: usageReady ? arm.completionTokens : null,
				reasoningTokens: reasoningReady ? arm.reasoningTokens : null,
				approximateCompletionTokensPerSecond: usageReady && arm.usageDurationMs > 0 ? Math.round(arm.completionTokens / (arm.usageDurationMs / 1000) * 100) / 100 : null
			});
		};
		const finish = (reason = null, cancelled = false) => Object.freeze({
			mode: reasoning.mode,
			profile: reasoning.effectiveProfile,
			effort: reasoning.effort,
			support: reasoning.support,
			candidateId: reasoning.candidateId,
			resolvedValue: reasoning.resolvedValue,
			evidence: reasoning.evidence,
			fingerprint,
			total,
			completed,
			baseline: snapshotArm(arms.baseline),
			controlled: snapshotArm(arms.controlled),
			cancelled,
			reason
		});
		if (!isOpenAiCompatibleEngineKey(engineKey) || !isEngineConfiguredForRuntime(engineKey)) return finish("configuration");
		if (reasoning.mode === "follow") return finish("reasoning_disabled");
		// Only a selection that cannot be put on the wire is refused. Unconfirmed or
		// unvalidated selections measure as sent: the latencies are real either way.
		if (reasoning.support === "unsupported" || reasoning.availability === "unsupported") return finish("reasoning_unsupported");
		if (now() < (backoffUntil || 0)) return finish("backoff");

		const runGeneration = syntheticBenchmarkGeneration;
		const cancelled = () => runGeneration !== syntheticBenchmarkGeneration || !!isCancelled();
		const progress = (fixture = 0, arm = "baseline") => {
			try {onProgress(Object.freeze({total, completed, fixture, arm, baselineSuccess: arms.baseline.successCount, controlledSuccess: arms.controlled.successCount}));}
			catch (error) {}
		};
		progress();
		for (let fixtureIndex = 0; fixtureIndex < SYNTHETIC_BENCHMARK_TEXTS.length; fixtureIndex++) {
			const text = SYNTHETIC_BENCHMARK_TEXTS[fixtureIndex];
			const armOrder = fixtureIndex % 2 === 0 ? ["baseline", "controlled"] : ["controlled", "baseline"];
			for (const armName of armOrder) {
				if (cancelled()) return finish("cancelled", true);
				if (getBenchmarkFingerprint(engineKey) !== fingerprint) return finish("stale");
				if (now() < (backoffUntil || 0)) return finish("backoff");
				const currentReasoning = getReasoningControlStatus(engineKey);
				// A mid-run "field unsupported" verdict comes from this run's own requests;
				// name the real reason instead of pretending the configuration changed.
				if (currentReasoning.support === "unsupported") return finish("reasoning_unsupported");
				// Verdict fields (support, evidence, candidate) may settle during the run;
				// only the selection itself going elsewhere makes the measurement stale.
				if (currentReasoning.mode !== reasoning.mode || currentReasoning.effort !== reasoning.effort || currentReasoning.effectiveProfile !== reasoning.effectiveProfile) return finish("stale");
				progress(fixtureIndex + 1, armName);
				const startedAt = now();
				let translatedText = "";
				let responseMetrics = null;
				try {
					translatedText = await new Promise(resolve => translate(engineKey, {
						input: {id: "en", name: "English"},
						output: {id: "zh-CN", name: "Simplified Chinese"},
						text,
						specialCase: null,
						autoDecision: false,
						decisionPrompt: "",
						engine: translationEngines[engineKey],
						timingContext: null,
						reasoningOverride: armName,
						onResponseMetrics: metrics => {responseMetrics = metrics;},
						silent: true
					}, value => resolve(typeof value == "string" ? value : "")));
				}
				catch (error) {translatedText = "";}
				if (cancelled()) return finish("cancelled", true);
				completed++;
				const arm = arms[armName];
				arm.inputChars += text.length;
				const durationMs = Math.max(0, now() - startedAt);
				const validTranslation = !!translatedText && /[\u3400-\u9fff]/u.test(translatedText);
				if (validTranslation) {
					arm.successCount++;
					arm.outputChars += translatedText.length;
					arm.durations.push(durationMs);
					if (responseMetrics && responseMetrics.completionTokens != null) {
						arm.usageSampleCount++;
						arm.promptTokens += responseMetrics.promptTokens || 0;
						arm.completionTokens += responseMetrics.completionTokens;
						arm.usageDurationMs += durationMs;
					}
					if (responseMetrics && responseMetrics.reasoningTokens != null) {
						arm.reasoningSampleCount++;
						arm.reasoningTokens += responseMetrics.reasoningTokens;
					}
					consecutiveFailures = 0;
				}
				else {arm.failureCount++; consecutiveFailures++;}
				progress(fixtureIndex + 1, armName);
				if (consecutiveFailures >= 2) return finish("provider_failed");
			}
		}
		return finish(arms.baseline.successCount === fixturesTotal && arms.controlled.successCount === fixturesTotal ? null : "provider_failed");
	}

	return Object.freeze({
		translationEngines,
		enginePortals,
		MD5,
		translate,
		getEngineAdapter,
		googleApiTranslate,
		googleCloudTranslate,
		microsoftTranslate,
		deepLTranslate,
		deepSeekTranslate,
		openAiTranslate,
		geminiTranslate,
		openAiCompatibleTranslate,
		papagoTranslate,
		baiduTranslate,
		chatCompletionsTranslate,
		requestAiProviderTranslation,
		requestAiBatchTranslation,
		requestAiBatchTranslationDetailed,
		enableWholeMarkerBatchCanary: wholeMarkerBatchCanary.enable,
		disableWholeMarkerBatchCanary: wholeMarkerBatchCanary.disable,
		getWholeMarkerBatchCanarySnapshot: wholeMarkerBatchCanary.snapshot,
		runSyntheticBenchmark,
		cancelSyntheticBenchmark: () => ++syntheticBenchmarkGeneration,
		normalizeApiEndpoint,
		getModelCatalogEndpoint,
		mapLanguageCodeForEngine,
		normalizePapagoLanguageCode,
		isPapagoLanguagePairSupported,
		getValidationRequestForEngine,
		getValidationErrorDetails,
		isValidatableEngine,
		supportsModelCatalog,
		buildAiProviderTranslationPrompt,
		parseOpenAiResponseText,
		parseGeminiResponseText,
		parseAiBatchTranslationResponse,
		isEngineConfiguredForRuntime,
		getWireExperimentCapability,
		createWireExperimentSession,
		requestWithTimeout,
		scheduleBackoff,
		awaitBackoff,
		getBackoffUntil: () => backoffUntil || 0,
		getBackoffStep: () => backoffStep,
		isBackoffActive: () => now() < (backoffUntil || 0),
		// Nothing clears the window today; a client is per plugin instance, so a restart
		// is the only reset the runtime has ever had.
		resetBackoff() {
			backoffUntil = 0;
			backoffStep = 0;
		},
		getEngineConfigFingerprint,
		getBenchmarkFingerprint,
		getReasoningControlStatus,
		getReasoningTierOptions,
		getLastReasoningProbeUsage: engineKey => lastReasoningProbeUsage.has(engineKey) ? lastReasoningProbeUsage.get(engineKey) : null,
		getLastReasoningProbeEcho: engineKey => lastReasoningProbeEcho.has(engineKey) ? lastReasoningProbeEcho.get(engineKey) : null,
		getCustomInterfaceStatus,
		setReasoningModelPreference,
		invalidateReasoningCapabilities,
		getReasoningCapabilityCacheSize: () => reasoningCapabilityCache.size(),
		resetOpenAiChatStreamCapabilities() {
			const count = openAiChatStreamCapabilities.size;
			openAiChatStreamCapabilities.clear();
			return count;
		},
		getModelCatalogState: () => modelCatalogState,
		clearModelCatalogState() {
			modelCatalogState = {};
			saveModelCatalogs({});
		},
		fetchModelCatalog,
		validateEngineConfig
	});
}

module.exports = {
	AI_SKIP_TRANSLATION_TOKEN,
	SYNTHETIC_BENCHMARK_TEXTS,
	PROVIDER_REQUEST_TIMEOUT_MS,
	PROVIDER_RATE_LIMIT_BACKOFF_MS,
	PROVIDER_SERVER_ERROR_BACKOFF_MS,
	PROVIDER_BACKOFF_MAX_STEP,
	PROVIDER_BACKOFF_MAX_MS,
	CREDENTIAL_REQUIRED_ENGINES,
	FREE_ENGINE_CHUNK_LIMIT,
	splitTextIntoTranslationChunks,
	VALIDATABLE_ENGINES,
	AI_MODEL_ENGINES,
	MODEL_CATALOG_MAX_ITEMS,
	MODEL_CATALOG_MAX_ID_LENGTH,
	getModelCatalogPersistenceKey,
	translationEngines,
	enginePortals,
	isCustomEngineKey,
	isOpenAiCompatibleEngineKey,
	isAiBatchCapableEngineKey,
	createCustomEngineId,
	normalizeCustomProviders,
	syncCustomEngines,
	MD5,
	createHistoricalRequestKeyContract,
	normalizeApiEndpoint,
	getModelCatalogEndpoint,
	isSameEndpointOrigin,
	mapLanguageCodeForEngine,
	normalizePapagoLanguageCode,
	isPapagoLanguagePairSupported,
	getValidationRequestForEngine,
	getValidationErrorDetails,
	getSafeProviderErrorParameter,
	classifyProviderRequestError,
	getRegisteredCustomProtocolAdapterIds,
	getRegisteredCustomProtocolAdapters,
	isValidatableEngine,
	supportsModelCatalog,
	buildAiProviderTranslationPrompt,
	parseOpenAiResponseText,
	parseGeminiResponseText,
	parseAiBatchTranslationResponse,
	normalizeStoredModelCatalogs,
	createProviderClient
};
