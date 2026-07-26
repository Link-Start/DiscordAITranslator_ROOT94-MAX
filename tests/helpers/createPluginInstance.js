const path = require("node:path");

function mergeRecords(base, override) {
	const result = Array.isArray(base) ? base.slice() : Object.assign({}, base || {});
	for (const key in override || {}) {
		const value = override[key];
		if (value && typeof value == "object" && !Array.isArray(value) && result[key] && typeof result[key] == "object" && !Array.isArray(result[key])) result[key] = mergeRecords(result[key], value);
		else result[key] = value;
	}
	return result;
}

function createPluginInstance(options = {}) {
	class BasePlugin {}
	const BDFDB = mergeRecords({
		ArrayUtils: {
			is: Array.isArray
		},
		DataUtils: {
			load: () => ({}),
			save: () => {}
		},
		DiscordObjects: {
			Message: class Message {
				constructor(data) {
					Object.assign(this, data);
				}
			}
		},
		ObjectUtils: {
			isEmpty: object => !object || !Object.keys(object).length,
			deepAssign: (...objects) => {
				const result = {};
				for (const object of objects) if (object) for (const key in object) result[key] = object[key];
				return result;
			},
			filter: (object, predicate) => Object.fromEntries(Object.entries(object || {}).filter(([, value]) => predicate(value))),
			sort: object => object
		},
		TimeUtils: {
			clear: () => {},
			interval: () => 0,
			timeout: () => 0
		},
		NotificationUtils: {
			toast: () => null
		},
		LanguageUtils: {
			languages: {
				"en": {id: "en", name: "English"},
				"zh-CN": {id: "zh-CN", name: "Chinese"}
			},
			LibraryStrings: {
				please_wait: "Please wait"
			},
			getLanguage: () => ({id: "en"})
		},
		MessageUtils: {
			rerenderAll: () => {}
		},
		PatchUtils: {
			patch: () => {},
			forceAllUpdates: () => {}
		},
		LibraryModules: {
			MessageUtils: {},
			MessageToolbarUtils: {}
		},
		LibraryStores: {
			ChannelStore: {
				getChannel: () => null
			},
			SelectedChannelStore: {
				getChannelId: () => "channel-test"
			}
		},
		UserUtils: {
			me: {id: "current-user"}
		},
		LibraryRequires: {
			request: () => {}
		}
	}, options.bdfdb || {});

	global.BdApi = {
		React: {
			Component: class Component {}
		}
	};
	global.window = {
		BDFDB_Global: {
			loaded: true,
			started: true,
			PluginUtils: {
				buildPlugin: () => [BasePlugin, BDFDB]
			}
		}
	};

	const pluginPath = path.resolve(__dirname, "..", "..", "DiscordAITranslator.plugin.js");
	delete require.cache[pluginPath];
	const PluginClass = require(pluginPath);
	const plugin = new PluginClass();
	plugin.settings = mergeRecords({
		general: {
			protectQuotedText: true
		},
		exceptions: {
			wordStart: ["!"],
			protectedTerms: [],
			wrapperPairs: []
		},
		engines: {
			translator: "googleapi",
			backup: "----"
		},
		filters: {
			minimumAutoTranslateLength: 6,
			receivedAutoTranslateLoadedTimeWindow: "1h",
			skipMixedReceivedMessages: true,
			skipSameLanguageReceivedMessages: true,
			useLocalLanguagePrecheck: true,
			treatLanguageVariantsAsSame: true,
			dropSimilarTranslations: true,
			translationSimilarityThreshold: 0.9,
			receivedAutoTranslateSourceLanguages: []
		},
		choices: {
			received: {input: "auto", output: "en"},
			sent: {input: "auto", output: "en"}
		}
	}, options.settings || {});
	plugin.defaults = mergeRecords({
		choices: {
			received: {value: {input: "auto", output: "en"}},
			sent: {value: {input: "auto", output: "en"}}
		},
		general: {}
	}, options.defaults || {});
	plugin.labels = mergeRecords({
		detect_language: "Detect language"
	}, options.labels || {});
	plugin.isTranslationEnabled = options.isTranslationEnabled || (() => true);
	if (options.isReceivedAutoTranslationEnabled) plugin.isReceivedAutoTranslationEnabled = options.isReceivedAutoTranslationEnabled;
	plugin.isOwnMessage = options.isOwnMessage || (() => false);
	if (options.getLanguageChoice) plugin.getLanguageChoice = options.getLanguageChoice;
	if (options.callSetLanguages !== false && typeof plugin.setLanguages == "function") plugin.setLanguages();
	plugin._testBdfdb = BDFDB;
	if (typeof options.mutatePlugin == "function") options.mutatePlugin(plugin, BDFDB);
	return plugin;
}

function createLocalLanguagePrecheckPluginInstance() {
	return createPluginInstance({
		isReceivedAutoTranslationEnabled: () => true,
		bdfdb: {
			TimeUtils: {
				clear: handle => { if (handle) clearTimeout(handle); },
				interval: (callback, ms) => setInterval(callback, ms),
				timeout: (callback, ms) => setTimeout(callback, ms)
			}
		}
	});
}

function createAutoTranslatePrecheckPluginInstance() {
	return createPluginInstance({
		settings: {
			filters: {
				skipMixedReceivedMessages: false,
				skipSameLanguageReceivedMessages: true,
				treatLanguageVariantsAsSame: true,
				dropSimilarTranslations: true,
				translationSimilarityThreshold: 0.9
			},
			choices: {
				received: {input: "auto", output: "zh-CN"},
				sent: {input: "auto", output: "en"}
			}
		},
		defaults: {
			choices: {
				received: {value: {input: "auto", output: "zh-CN"}},
				sent: {value: {input: "auto", output: "en"}}
			}
		},
		isReceivedAutoTranslationEnabled: () => true
	});
}

function createAiDecisionAllcapsPluginInstance() {
	return createPluginInstance({
		settings: {
			engines: {translator: "deepseek", backup: "----"},
			filters: {
				minimumAutoTranslateLength: 6,
				skipMixedReceivedMessages: false,
				skipSameLanguageReceivedMessages: true,
				treatLanguageVariantsAsSame: true,
				dropSimilarTranslations: true,
				translationSimilarityThreshold: 0.9,
				useLocalLanguagePrecheck: true,
				autoTranslateDecisionMode: "ai",
				receivedAutoTranslateSourceLanguages: []
			},
			choices: {
				received: {input: "auto", output: "zh-CN"},
				sent: {input: "auto", output: "en"}
			}
		},
		defaults: {
			choices: {
				received: {value: {input: "auto", output: "zh-CN"}},
				sent: {value: {input: "auto", output: "en"}}
			}
		},
		labels: {detect_language: "Auto detect"},
		isReceivedAutoTranslationEnabled: () => true
	});
}

function createManualTranslationButtonPluginInstance() {
	return createPluginInstance({
		bdfdb: {
			ArrayUtils: {
				remove: (array, value, removeAll = false) => {
					if (!Array.isArray(array)) return array;
					for (let index = array.length - 1; index >= 0; index--) {
						if (array[index] != value) continue;
						array.splice(index, 1);
						if (!removeAll) break;
					}
					return array;
				}
			},
			LibraryStores: {
				SelectedChannelStore: {
					getChannelId: () => "channel-1"
				}
			}
		},
		settings: {
			general: {
				showOriginalMessage: false,
				showOriginalDirectly: false
			},
			filters: {
				skipSameLanguageReceivedMessages: true,
				treatLanguageVariantsAsSame: true,
				dropSimilarTranslations: true,
				translationSimilarityThreshold: 0.9
			}
		},
		isTranslationEnabled: () => false,
		isReceivedAutoTranslationEnabled: () => false,
		mutatePlugin(plugin) {
			plugin.lockManualTranslationScroll = () => {};
			plugin.scheduleTranslationRerender = () => {};
		}
	});
}

function createProtectionRegressionPluginInstance() {
	return createPluginInstance({
		settings: {
			exceptions: {
				protectedTerms: ["BUG team", "ChatGPT Plus"],
				wrapperPairs: ['"|"', "“|”", "`|`"]
			}
		}
	});
}

function createTypingDuringTranslationPluginInstance() {
	return createPluginInstance({
		callSetLanguages: false,
		isTranslationEnabled: () => true
	});
}

module.exports = {
	createPluginInstance,
	createLocalLanguagePrecheckPluginInstance,
	createAutoTranslatePrecheckPluginInstance,
	createAiDecisionAllcapsPluginInstance,
	createManualTranslationButtonPluginInstance,
	createProtectionRegressionPluginInstance,
	createTypingDuringTranslationPluginInstance
};
