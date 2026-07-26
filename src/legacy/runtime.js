module.exports = (_ => {
	const changeLog = {
		
	};

	// Version source: the BetterDiscord metadata header `@version`.
	// Rule: SemVer only: MAJOR.MINOR.PATCH, for example `0.0.18`.
	// Do not add a leading `v` here; BetterDiscord may render its own UI prefix.
	// Keep the value as a string, never parse it as a decimal number.
	const normalizeSemverVersion = version => {
		const raw = String(version == null ? "" : version).trim();
		const withoutPrefix = raw.replace(/^(?:v\s*)+/i, "");
		const match = withoutPrefix.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/);
		return match ? `${match[1]}.${match[2]}.${match[3]}` : withoutPrefix;
	};
	
	return !window.BDFDB_Global || (!window.BDFDB_Global.loaded && !window.BDFDB_Global.started) ? class {
		constructor (meta) {for (let key in meta) this[key] = meta[key];}
		getName () {return this.name;}
		getAuthor () {return this.author;}
		getVersion () {return normalizeSemverVersion(this.version);}
		getDescription () {return `The Library Plugin needed for ${this.name} is missing. Open the Plugin Settings to download it. \n\n${this.description}`;}
		
		downloadLibrary () {
			BdApi.Net.fetch("https://mwittrien.github.io/BetterDiscordAddons/Library/0BDFDB.plugin.js").then(r => {
				if (!r || r.status != 200) throw new Error();
				else return r.text();
			}).then(b => {
				if (!b) throw new Error();
				else return require("fs").writeFile(require("path").join(BdApi.Plugins.folder, "0BDFDB.plugin.js"), b, _ => BdApi.UI.showToast("Finished downloading BDFDB Library", {type: "success"}));
			}).catch(error => {
				BdApi.UI.alert("Error", "Could not download BDFDB Library Plugin. Try again later or download it manually from GitHub: https://mwittrien.github.io/downloader/?library");
			});
		}
		
		load () {
			if (!window.BDFDB_Global || !Array.isArray(window.BDFDB_Global.pluginQueue)) window.BDFDB_Global = Object.assign({}, window.BDFDB_Global, {pluginQueue: []});
			if (!window.BDFDB_Global.downloadModal) {
				window.BDFDB_Global.downloadModal = true;
				BdApi.UI.showConfirmationModal("Library Missing", `The Library Plugin needed for ${this.name} is missing. Please click "Download Now" to install it.`, {
					confirmText: "Download Now",
					cancelText: "Cancel",
					onCancel: _ => {delete window.BDFDB_Global.downloadModal;},
					onConfirm: _ => {
						delete window.BDFDB_Global.downloadModal;
						this.downloadLibrary();
					}
				});
			}
			if (!window.BDFDB_Global.pluginQueue.includes(this.name)) window.BDFDB_Global.pluginQueue.push(this.name);
		}
		start () {this.load();}
		stop () {}
		getSettingsPanel () {
			let template = document.createElement("template");
			template.innerHTML = `<div style="color: var(--text-strong); font-size: 16px; font-weight: 300; white-space: pre; line-height: 22px;">The Library Plugin needed for ${this.name} is missing.\nPlease click <a style="font-weight: 500;">Download Now</a> to install it.</div>`;
			template.content.firstElementChild.querySelector("a").addEventListener("click", this.downloadLibrary);
			return template.content.firstElementChild;
		}
	} : (([Plugin, BDFDB]) => {
		// Extracted modules. Declared before any state so module-backed stores can be
		// constructed in the state block below.
		const {createDisplayRuntime} = require("../display/display-runtime");
		const {createDisplayRepaintScheduler} = require("../display/repaint-scheduler");
		const {createTranslatorStyles} = require("../ui/styles");
		const {createChannelTitleStore} = require("../channel-title/channel-title-store");
		const {createMessageViewportStore} = require("../viewport/message-viewport-store");
		const {createLoadedTranslationStatusStore} = require("../status/loaded-translation-status-store");
		const {createTranslationCacheStore} = require("../cache/translation-cache-store");
		const {createProviderClient, translationEngines, enginePortals} = require("../providers/provider-client");
		const {getLabelsForUiLanguage} = require("../i18n/labels");
		const {getCustomTextValue} = require("../i18n/text");

		var _this;
		const translationProtectionSignatureVersion = "2026-06-16-auto-protect-v11";
		
		const translateIconGeneral = `<svg name="Translate" width="24" height="24" viewBox="0 0 24 24"><mask/><path fill="currentColor" mask="url(#translateIconMask)" d="m 9.6568988,1.9999999 c -1.141416,0 -0.951614,1.2688185 -0.951614,1.2688185 v 0.6505173 h -5.392479 c 0,0 -1.2688185,-0.1898024 -1.2688185,0.9516139 0,1.1414159 1.2688185,0.9516139 1.2688185,0.9516139 H 12.426863 C 12.695162,7.2780713 11.349082,9.1398691 9.7646988,10.765256 8.6555628,9.6878231 7.4332858,8.3134878 6.8664892,7.065981 6.6161862,6.515072 5.9881318,6.6956414 5.7283935,6.9736693 5.1836529,7.5567679 5.5785907,8.592173 6.0833902,9.3409331 c 0.246901,0.366224 1.3724726,1.5182279 2.4570966,2.5995909 -1.6322361,1.477469 -3.154699,2.550028 -3.154699,2.550028 0,0 -1.0769951,0.696378 -0.322161,1.552568 0.7548319,0.856187 1.5810669,-0.125147 1.5810669,-0.125147 0,0 1.5136611,-1.082765 3.2203701,-2.6696 0.5195872,0.508635 0.8970952,0.874172 0.8970952,0.874172 0,0 0.82821,0.985394 1.582925,0.09231 0.754714,-0.893081 -0.354377,-1.545753 -0.354377,-1.545753 0.0097,0.03486 -0.34186,-0.224086 -0.864878,-0.666625 1.804964,-1.884163 3.470802,-4.1622897 3.47686,-6.1799145 h 1.398302 c 0,0 1.268819,0.2176541 1.268819,-0.9516139 0,-1.1692683 -1.268819,-0.9516139 -1.268819,-0.9516139 H 10.608512 V 3.2688184 c 0,0 0.189804,-1.2688185 -0.9516132,-1.2688185 z M 15.056812,10.104826 10.536646,22 h 2.379035 l 0.964624,-2.537637 h 4.732049 L 19.576978,22 h 2.379035 L 17.435847,10.104826 Z m 1.189517,3.130537 1.643021,4.323772 h -3.286042 z"/><extra/></svg>`;
		const translateIconMask = `<mask id="translateIconMask" fill="black"><path fill="white" d="M 0 0 H 24 V 24 H 0 Z"/><path fill="black" d="M24 12 H 12 V 24 H 24 Z"/></mask>`;
		const translateIcon = translateIconGeneral.replace(`<extra/>`, ``).replace(`<mask/>`, ``).replace(` mask="url(#translateIconMask)"`, ``);
		const translateIconUntranslate = translateIconGeneral.replace(`<extra/>`, `<path fill="none" stroke="#f04747" stroke-width="2" d="m 14.702359,14.702442 8.596228,8.596148 m 0,-8.597139 -8.59722,8.596147 z"/>`).replace(`<mask/>`, translateIconMask);
		
		const TranslateButtonComponent = class TranslateButton extends BdApi.React.Component {
			render() {
				const enabled = _this.isTranslationEnabled(this.props.channelId);
				return BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.ChannelTextAreaButton, {
					className: BDFDB.DOMUtils.formatClassName(BDFDB.disCN._translatortranslatebutton, _this.isTranslationEnabled(this.props.channelId) && BDFDB.disCN._translatortranslating, BDFDB.disCN.textareapickerbutton),
					isActive: this.props.isActive,
					iconSVG: translateIcon,
					nativeClass: true,
					tooltip: {
						text: _ => _this.getTranslateButtonTooltipText(this.props.channelId),
						tooltipConfig: {style: "max-width: 400px"}
					},
					onClick: _ => {
						this.props.isActive = true;
						BDFDB.ReactUtils.forceUpdate(this);
						
						BDFDB.ModalUtils.open(_this, {
							size: "LARGE",
							header: BDFDB.LanguageUtils.LanguageStrings.SETTINGS,
							subHeader: "",
							onClose: _ => {
								this.props.isActive = false;
								BDFDB.ReactUtils.forceUpdate(this);
							},
							children: BDFDB.ReactUtils.createElement(TranslateSettingsComponent, {
								guildId: this.props.guildId,
								channelId: this.props.channelId
							})
						});
					},
					onContextMenu: _ => {
						_this.toggleTranslation(this.props.channelId);
						BDFDB.ReactUtils.forceUpdate(this);
					}
				});
			}
		};
		
		const TranslateSettingsComponent = class TranslateSettings extends BdApi.React.Component {
			constructor(props) {
				super(props);
				this.state = {
					detectorText: "",
					detectedLanguageId: null,
					detectingLanguage: false
				};
			}
			filterLanguages(direction, place) {
				const isOutput = direction == languageTypes.OUTPUT;
				const currentInput = languages[_this.getLanguageChoice(languageTypes.INPUT, place, this.props.channelId)];
				const currentOutput = languages[_this.getLanguageChoice(languageTypes.OUTPUT, place, this.props.channelId)];
				return BDFDB.ObjectUtils.toArray(BDFDB.ObjectUtils.map(isOutput ? BDFDB.ObjectUtils.filter(languages, lang => !lang.auto) : languages, (lang, id) => {
					const input = isOutput ? currentInput : lang;
					const output = isOutput ? lang : currentOutput;
					const primarySupported = _this.engineSupportsLanguagePair(_this.getEffectivePrimaryEngine(this.props.channelId), input, output);
					const backupSupported = _this.engineSupportsLanguagePair(_this.getEffectiveBackupEngine(this.props.channelId), input, output);
					return {
						value: id,
						label: _this.getLanguageDisplayName(lang),
						backup: !primarySupported && backupSupported,
						unsupported: !primarySupported && !backupSupported,
						disabled: !primarySupported && !backupSupported
					};
				}));
			}
			renderChannelPrimaryEngine() {
				const channelId = this.props.channelId;
				return BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.FormItem, {
					title: _this.getCustomText("channel_primary_engine_title"),
					className: BDFDB.disCN.marginbottom8,
					children: BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.Flex, {
						align: BDFDB.LibraryComponents.Flex.Align.CENTER,
						children: [
							BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.Flex.Child, {
								grow: 1,
								children: BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.Select, {
									value: _this.getEffectivePrimaryEngine(channelId),
									options: Object.keys(translationEngines).map(engineKey => ({value: engineKey, label: _this.getEngineLabel(engineKey)})),
									onChange: engineKey => {
										_this.setChannelPrimaryEngine(channelId, engineKey);
										_this.refreshChannelPrimaryEngineRuntime(channelId);
										_this.setLanguages();
										if (!_this.isEngineConfiguredForRuntime(engineKey)) BDFDB.NotificationUtils.toast(`${_this.getEngineLabel(engineKey)}: ${_this.getCustomText("channel_primary_engine_unconfigured_warning")}`, {type: "danger", position: "center"});
										BDFDB.ReactUtils.forceUpdate(this);
									}
								})
							}),
							_this.hasChannelPrimaryEngineOverride(channelId) && BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.Button, {
								size: BDFDB.LibraryComponents.Button.Sizes.SMALL,
								className: BDFDB.disCN.marginleft8,
								onClick: _ => {
									_this.clearChannelPrimaryEngineOverride(channelId);
									_this.refreshChannelPrimaryEngineRuntime(channelId);
									_this.setLanguages();
									BDFDB.ReactUtils.forceUpdate(this);
								},
								children: _this.getCustomText("channel_primary_engine_restore")
							})
						].filter(Boolean)
					})
				});
			}
			async detectLanguageFromInput() {
				const text = (this.state.detectorText || "").trim();
				if (!text) return BDFDB.NotificationUtils.toast(_this.getCustomText("language_detector_empty"), {type: "danger", position: "center"});
				this.setState({detectingLanguage: true});
				const result = await _this.detectLanguageDetails(text);
				this.setState({
					detectingLanguage: false,
					detectedLanguageId: result && result.id || null
				});
				if (!result) BDFDB.NotificationUtils.toast(_this.getCustomText("language_detector_failed"), {type: "danger", position: "center"});
			}
			applyDetectedLanguage(place, direction) {
				const detectedLanguageId = this.state.detectedLanguageId;
				if (!detectedLanguageId) return;
				_this.saveLanguageChoice(detectedLanguageId, direction, place, this.props.channelId);
				_this.setLanguages();
				BDFDB.ReactUtils.forceUpdate(this);
			}
			renderLanguageDetector() {
				const detectedLanguageId = this.state.detectedLanguageId;
				const detectedLanguage = detectedLanguageId && _this.getLanguageData(detectedLanguageId);
				return BDFDB.ReactUtils.createElement("div", {
					className: "translator-detector-panel",
					children: [
						BDFDB.ReactUtils.createElement("div", {
							className: "translator-settings-support-title",
							children: _this.getCustomText("language_detector_title")
						}),
						BDFDB.ReactUtils.createElement("div", {
							className: "translator-settings-support-hint",
							children: _this.getCustomText("language_detector_hint")
						}),
						BDFDB.ReactUtils.createElement("div", {
							className: "translator-detector-input-wrap",
							children: [
								BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.TextInput, {
									className: "translator-detector-textinput",
									placeholder: _this.getCustomText("language_detector_placeholder"),
									value: this.state.detectorText,
									onChange: value => this.setState({detectorText: value})
								}),
								BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.Button, {
									size: BDFDB.LibraryComponents.Button.Sizes.SMALL,
									className: "translator-detector-input-button",
									disabled: this.state.detectingLanguage,
									onClick: _ => this.detectLanguageFromInput(),
									children: this.state.detectingLanguage ? _this.getCustomText("language_detector_button_loading") : _this.getCustomText("language_detector_button")
								})
							]
						}),
						detectedLanguage && BDFDB.ReactUtils.createElement("div", {
							className: "translator-detector-result-row",
							children: [
								BDFDB.ReactUtils.createElement("div", {
									className: "translator-detector-result-text",
									children: `${_this.getCustomText("language_detector_detected")}: ${_this.getLanguageDisplayName(detectedLanguage)} (${detectedLanguage.id})`
								}),
								BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.Button, {
									size: BDFDB.LibraryComponents.Button.Sizes.SMALL,
									className: "translator-detector-apply-button",
									onClick: _ => this.applyDetectedLanguage(messageTypes.SENT, languageTypes.OUTPUT),
									children: _this.getCustomText("language_detector_apply_sent_output")
								})
							]
						})
					].filter(Boolean)
				});
			}
			render() {
				// Keep the floating loaded-history status capsule mounted outside this settings surface.
				return [
					this.renderChannelPrimaryEngine(),
					this.renderLanguageDetector(),
					Object.keys(_this.defaults.choices).map(place => {
						let isChannelSpecific = channelLanguages[this.props.channelId] && channelLanguages[this.props.channelId][place];
						let isGuildSpecific = !isChannelSpecific && guildLanguages[this.props.guildId] && guildLanguages[this.props.guildId][place];
						return Object.keys(_this.defaults.choices[place].value).map(direction => [
							BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.FormItem, {
								title: _this.labels[`language_choice_${direction.toLowerCase()}_${place.toLowerCase()}`] + ": ",
								titleChildren: direction == languageTypes.OUTPUT && [{
									text: _ => isChannelSpecific ? _this.labels.language_selection_channel : isGuildSpecific ? _this.labels.language_selection_server : _this.labels.language_selection_global,
									name: isChannelSpecific || isGuildSpecific ? BDFDB.LibraryComponents.SvgIcon.Names.LOCK_CLOSED : BDFDB.LibraryComponents.SvgIcon.Names.LOCK_OPEN,
									color: isChannelSpecific ? "var(--status-danger)" : isGuildSpecific ? "var(--status-warning)" : null,
									onClick: _ => {
										if (channelLanguages[this.props.channelId] && channelLanguages[this.props.channelId][place]) {
											isChannelSpecific = false;
											delete channelLanguages[this.props.channelId][place];
											if (BDFDB.ObjectUtils.isEmpty(channelLanguages[this.props.channelId])) delete channelLanguages[this.props.channelId];
										}
										else if (guildLanguages[this.props.guildId] && guildLanguages[this.props.guildId][place]) {
											isGuildSpecific = false;
											isChannelSpecific = true;
											delete guildLanguages[this.props.guildId][place];
											if (BDFDB.ObjectUtils.isEmpty(guildLanguages[this.props.guildId])) delete guildLanguages[this.props.guildId];
											if (!channelLanguages[this.props.channelId]) channelLanguages[this.props.channelId] = {};
											channelLanguages[this.props.channelId][place] = {};
											for (let l in languageTypes) channelLanguages[this.props.channelId][place][languageTypes[l]] = _this.getLanguageChoice(languageTypes[l], place, null);
										}
										else {
											isGuildSpecific = true;
											if (!guildLanguages[this.props.guildId]) guildLanguages[this.props.guildId] = {};
											guildLanguages[this.props.guildId][place] = {};
											for (let l in languageTypes) guildLanguages[this.props.guildId][place][languageTypes[l]] = _this.getLanguageChoice(languageTypes[l], place, null);
										}
										BDFDB.DataUtils.save(channelLanguages, _this, "channelLanguages");
										BDFDB.DataUtils.save(guildLanguages, _this, "guildLanguages");
										
										BDFDB.ReactUtils.forceUpdate(this);
									}
								}, {
									iconSVG: `<svg width="21" height="21" fill="currentColor"><path d="M 0, 10.515 c 0, 2.892, 1.183, 5.521, 3.155, 7.361 L 0, 21.031 h 7.887 V 13.144 l -2.892, 2.892 C 3.549, 14.722, 2.629, 12.75, 2.629, 10.515 c 0 -3.418, 2.235 -6.309, 5.258 -7.492 v -2.629 C 3.418, 1.577, 0, 5.652, 0, 10.515 z M 21.031, 0 H 13.144 v 7.887 l 2.892 -2.892 C 17.482, 6.309, 18.402, 8.281, 18.402, 10.515 c 0, 3.418 -2.235, 6.309 -5.258, 7.492 V 20.768 c 4.469 -1.183, 7.887 -5.258, 7.887 -10.121 c 0 -2.892 -1.183 -5.521 -3.155 -7.361 L 21.031, 0 z"/></svg>`,
									onClick: _ => {
										let input = _this.getLanguageChoice(languageTypes.INPUT, place, this.props.channelId);
										let output = _this.getLanguageChoice(languageTypes.OUTPUT, place, this.props.channelId);
										input = input == "auto" ? "en" : input;
										
										_this.saveLanguageChoice(output, languageTypes.INPUT, place, this.props.channelId);
										_this.saveLanguageChoice(input, languageTypes.OUTPUT, place, this.props.channelId);
										
										_this.setLanguages();
										
										BDFDB.ReactUtils.forceUpdate(this);
									}
								}].map(data => {
									const icon = BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.Clickable, {
										className: BDFDB.disCN._translatorconfigbutton,
										onClick: data.onClick,
										children: BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.SvgIcon, {
											width: 24,
											height: 24,
											color: data.color || "currentColor",
											name: data.name,
											iconSVG: data.iconSVG
										})
									});
									return data.text ? BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.TooltipContainer, {tooltipConfig: {type: "bottom"}, text: data.text, children: icon}) : icon;
								}),
								className: BDFDB.disCN.marginbottom8,
								children: BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.Select, {
									menuShouldScrollIntoView: false,
									menuShouldBlockScroll: false,
									captureMenuScroll: false,
									menuPosition: "fixed",
									menuPlacement: "auto",
									menuPortalTarget: typeof document != "undefined" ? document.body : undefined,
									maxMenuHeight: typeof window != "undefined" ? Math.max(150, Math.min(240, Math.floor(window.innerHeight * 0.36))) : 220,
									value: _this.getLanguageChoice(direction, place, this.props.channelId),
									options: this.filterLanguages(direction, place),
									optionRenderer: lang => languages[lang.value] ? BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.Flex, {
										align: BDFDB.LibraryComponents.Flex.Align.CENTER,
										children: [
											BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.Flex.Child, {
												grow: 1,
												children: lang.label
											}),
											(lang.backup || lang.unsupported) && BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.TooltipContainer, {
												text: lang.unsupported ? _this.getCustomText("language_not_supported_by_channel_engines") : _this.labels.backup_engine_warning,
												tooltipConfig: {
													color: "red"
												},
												children: BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.SvgIcon, {
													nativeClass: true,
													width: 20,
													height: 20,
													color: "var(--status-danger)",
													name: BDFDB.LibraryComponents.SvgIcon.Names.WARNING
												})
											}),
											BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.FavButton, {
												isFavorite: languages[lang.value].fav == 0,
												onClick: value => {
													if (value) favorites.push(lang.value);
													else BDFDB.ArrayUtils.remove(favorites, lang.value, true);
													BDFDB.DataUtils.save(favorites.sort(), _this, "favorites");
													_this.setLanguages();
												}
											})
										]
									}) : null,
									onChange: value => {
										_this.saveLanguageChoice(value, direction, place, this.props.channelId);
										BDFDB.ReactUtils.forceUpdate(this);
									}
								})
							}),
							direction == languageTypes.OUTPUT && BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.FormDivider, {
								className: BDFDB.disCN.marginbottom8
							})
						]);
					}),
				].flat(10).filter(n => n);
			}
		};

		const brailleConverter = {
			"0":"⠴", "1":"⠂", "2":"⠆", "3":"⠒", "4":"⠲", "5":"⠢", "6":"⠖", "7":"⠶", "8":"⠦", "9":"⠔", "!":"⠮", "\"":"⠐", "#":"⠼", "$":"⠫", "%":"⠩", "&":"⠯", "'":"⠄", "(":"⠷", ")":"⠾", "*":"⠡", "+":"⠬", ",":"⠠", "-":"⠤", ".":"⠨", "/":"⠌", ":":"⠱", ";":"⠰", "<":"⠣", "=":"⠿", ">":"⠜", "?":"⠹", "@":"⠈", "a":"⠁", "b":"⠃", "c":"⠉", "d":"⠙", "e":"⠑", "f":"⠋", "g":"⠛", "h":"⠓", "i":"⠊", "j":"⠚", "k":"⠅", "l":"⠇", "m":"⠍", "n":"⠝", "o":"⠕", "p":"⠏", "q":"⠟", "r":"⠗", "s":"⠎", "t":"⠞", "u":"⠥", "v":"⠧", "w":"⠺", "x":"⠭", "y":"⠽", "z":"⠵", "[":"⠪", "\\":"⠳", "]":"⠻", "^":"⠘", "⠁":"a", "⠂":"1", "⠃":"b", "⠄":"'", "⠅":"k", "⠆":"2", "⠇":"l", "⠈":"@", "⠉":"c", "⠊":"i", "⠋":"f", "⠌":"/", "⠍":"m", "⠎":"s", "⠏":"p", "⠐":"\"", "⠑":"e", "⠒":"3", "⠓":"h", "⠔":"9", "⠕":"o", "⠖":"6", "⠗":"r", "⠘":"^", "⠙":"d", "⠚":"j", "⠛":"g", "⠜":">", "⠝":"n", "⠞":"t", "⠟":"q", "⠠":", ", "⠡":"*", "⠢":"5", "⠣":"<", "⠤":"-", "⠥":"u", "⠦":"8", "⠧":"v", "⠨":".", "⠩":"%", "⠪":"[", "⠫":"$", "⠬":"+", "⠭":"x", "⠮":"!", "⠯":"&", "⠰":";", "⠱":":", "⠲":"4", "⠳":"\\", "⠴":"0", "⠵":"z", "⠶":"7", "⠷":"(", "⠸":"_", "⠹":"?", "⠺":"w", "⠻":"]", "⠼":"#", "⠽":"y", "⠾":")", "⠿":"=", "_":"⠸"
		};

		const morseConverter = {
			"0":"−−−−−", "1":"·−−−−", "2":"··−−−", "3":"···−−", "4":"····−", "5":"·····", "6":"−····", "7":"−−···", "8":"−−−··", "9":"−−−−·", "!":"−·−·−−", "\"":"·−··−·", "$":"···−··−", "&":"·−···", "'":"·−−−−·", "(":"−·−−·", ")":"−·−−·−", "+":"·−·−·", ",":"−−··−−", "-":"−····−", ".":"·−·−·−", "/":"−··−·", ":":"−−−···", ";":"−·−·−·", "=":"−···−", "?":"··−−··", "@":"·−−·−·", "a":"·−", "b":"−···", "c":"−·−·", "d":"−··", "e":"·", "f":"··−·", "g":"−−·", "h":"····", "i":"··", "j":"·−−−", "k":"−·−", "l":"·−··", "m":"−−", "n":"−·", "o":"−−−", "p":"·−−·", "q":"−−·−", "r":"·−·", "s":"···", "t":"−", "u":"··−", "v":"···−", "w":"·−−", "x":"−··−", "y":"−·−−", "z":"−−··", "·":"e", "··":"i", "···":"s", "····":"h", "·····":"5", "····−":"4", "···−":"v", "···−··−":"$", "···−−":"3", "··−":"u", "··−·":"f", "··−−··":"?", "··−−·−":"_", "··−−−":"2", "·−":"a", "·−·":"r", "·−··":"l", "·−···":"&", "·−··−·":"\"", "·−·−·":"+", "·−·−·−":".", "·−−":"w", "·−−·":"p", "·−−·−·":"@", "·−−−":"j", "·−−−−":"1", "·−−−−·":"'", "−":"t", "−·":"n", "−··":"d", "−···":"b", "−····":"6", "−····−":"-", "−···−":"=", "−··−":"x", "−··−·":"/", "−·−":"k", "−·−·":"c", "−·−·−·":";", "−·−·−−":"!", "−·−−":"y", "−·−−·":"(", "−·−−·−":")", "−−":"m", "−−·":"g", "−−··":"z", "−−···":"7", "−−··−−":",", "−−·−":"q", "−−−":"o", "−−−··":"8", "−−−···":":", "−−−−·":"9", "−−−−−":"0", "_":"··−−·−"
		};
		
		
		var languages = {};
		var favorites = [];
		var authKeys = {};
		var channelLanguages = {}, guildLanguages = {}, channelPrimaryEngineOverrides = {};
		var translationEnabledStates = {globalDefault: false, channelOverrides: {}}, isTranslating;
		var translatedMessages = {}, oldMessages = {};
		var autoTranslationQueue = [];
		var queuedAutoTranslations = {};
		var liveTranslationRequests = {};
		var liveTranslationRequestSequence = 0;
		var liveTranslationRuntimeGeneration = 0;
		var sentAutomaticTranslationRequests = {};
		var sentAutomaticTranslationRequestSequence = 0;
		var sentAutomaticTranslationRuntimeGeneration = 0;
		var pendingSentOriginalMessages = [];
		var sentOriginalMessages = {};
		var suppressedAutoTranslations = {};
		var isLiveAutoTranslating = false;
		var translationRerenderTimer = null;
		var deferredTextAreaRerenderTimer = null;
		var autoTranslationQueueRetryTimer = null;
		var autoTranslationChannelStates = {};
		var replyPreviewTranslations = {};
		var queuedReplyPreviewTranslations = {};
		var autoTranslationEligibleReplyPreviewMessages = {};
		var replyPreviewRenderMessageIds = {};
		var lastAutoTranslationChannelId = null;
		// Backoff window set when the translation provider returns 429/5xx; the queue
		// pauses until this timestamp to avoid hammering a rate-limited or ailing server.
		var deferredTranslationRerenderPending = false;
		var historicalTranslationJobQueues = new Map();
		var historicalTranslationJobSequence = 0;
		var historicalTranslationRuntimeGeneration = 0;
		var failedHistoricalTranslationSnapshots = new Map();
		const channelTitleStore = createChannelTitleStore();
		const loadedTranslationStatusStore = createLoadedTranslationStatusStore({isChineseUiLanguage: () => _this && _this.isChineseUiLanguage()});
		var pluginRuntimeActive = true;
		var deferredSettingsRerenderTimer = null;
		var manualMessageTranslationRequests = {};
		const AUTO_TRANSLATION_RERENDER_DELAY = 120;
		const AUTO_TRANSLATION_HISTORY_RERENDER_DELAY = 1500;
		const AUTO_TRANSLATION_QUEUE_RETRY_DELAY = 900;
		const SENT_ORIGINAL_MATCH_TTL = 2 * 60 * 1000;
		const MAX_SENT_ORIGINAL_ENTRIES = 200;
		// A live burst drains into one AI batch request instead of one request per
		// message; the cap keeps a single prompt within comfortable output limits.
		const LIVE_AI_BATCH_ITEM_LIMIT = 10;
		// How often a deferred repaint re-checks whether the user stopped typing or closed
		// the settings surface. Matches the legacy text-area deferral.
		const AUTO_TRANSLATION_DEFERRED_REPAINT_RETRY = 450;
		const HISTORICAL_AI_BATCH_ITEM_LIMIT_MAX = 100;
		const DEFAULT_LOADED_AUTO_TRANSLATE_LIMIT = 50;
		const LOADED_AUTO_TRANSLATE_LIMIT_MIN = 1;
		const LOADED_AUTO_TRANSLATE_LIMIT_MAX = 100;
		const LOADED_AUTO_TRANSLATE_RANGE_MODES = {COUNT: "count", TIME: "time"};
		const TRANSLATION_MESSAGE_PATCH_TYPES = ["Messages", "MessageReply", "MessageButtons", "MessageContent", "Embed"];
		const DISCORD_EPOCH = 1420070400000;
		
		const defaultLanguages = {
			INPUT: "auto",
			OUTPUT: "$discord"
		};
		const languageTypes = {
			INPUT: "input",
			OUTPUT: "output"
		};
		const messageTypes = {
			RECEIVED: "received",
			SENT: "sent",
		};
		const AI_SKIP_TRANSLATION_TOKEN = "__SKIP_TRANSLATION__";
		const HISTORICAL_TERMINAL_ITEM_STATES = new Set(["translated", "skipped", "failed", "cancelled"]);

		class HistoricalTranslationJob {
			constructor(config = {}) {
				this.id = config.id || `historical-${Date.now()}`;
				this.channelId = config.channelId || null;
				this.generation = config.generation || 0;
				this.configurationSignature = config.configurationSignature || null;
				this.dependencies = Object.assign({
					prepare: item => ({status: "pending", prepared: item}),
					translateBatch: () => Promise.resolve(null),
					repairBatch: null,
					validate: (_item, translatedText) => translatedText == null ? {ok: false} : {ok: true, translation: translatedText},
					repair: () => Promise.resolve({status: "failed", reason: "unresolved"}),
					waitForCommit: () => Promise.resolve(),
					isCurrent: () => true,
					commit: () => {},
					rerender: () => {},
					onStateChange: () => {}
				}, config.dependencies || {});
				this.items = new Map();
				this.state = "collecting";
				this.sealed = false;
				this.cancelReason = null;
				this.started = false;
				this.repairConcurrency = Math.max(1, parseInt(config.repairConcurrency, 10) || 4);
				this.repairBatchSize = Math.max(1, parseInt(config.repairBatchSize, 10) || 10);
			}

			add(item) {
				if (this.state != "collecting" || this.sealed) return false;
				const source = item && item.message ? item : {message: item};
				const messageId = source.message && source.message.id;
				if (!messageId || this.items.has(String(messageId))) return false;
				this.items.set(String(messageId), {
					source,
					prepared: null,
					status: "pending",
					translation: null,
					reason: null
				});
				this.dependencies.onStateChange(this);
				return true;
			}

			seal() {
				if (this.state != "collecting" || this.sealed) return false;
				this.sealed = true;
				this.dependencies.onStateChange(this);
				return true;
			}

			cancel(reason = "cancelled") {
				if (this.state == "committed" || this.state == "cancelled") return false;
				this.cancelReason = reason;
				this.state = "cancelled";
				for (const record of this.items.values()) if (!HISTORICAL_TERMINAL_ITEM_STATES.has(record.status)) record.status = "cancelled";
				this.dependencies.onStateChange(this);
				return true;
			}

			invalidateMessage(messageId, reason = "source-changed") {
				if (this.state == "committed" || this.state == "cancelled") return false;
				const record = this.items.get(String(messageId));
				if (!record || record.status == "cancelled") return false;
				record.status = "cancelled";
				record.translation = null;
				record.reason = reason;
				this.dependencies.onStateChange(this);
				return true;
			}

			isMessagePending(messageId) {
				const record = this.items.get(String(messageId));
				return !!record && this.state != "cancelled" && !HISTORICAL_TERMINAL_ITEM_STATES.has(record.status);
			}

			setPreparedOutcome(record, outcome) {
				outcome = outcome || {status: "failed", reason: "prepare_failed"};
				if (outcome.status == "translated") {
					record.status = "translated";
					record.translation = outcome.translation;
				}
				else if (outcome.status == "skipped") {
					record.status = "skipped";
					record.reason = outcome.reason || "skipped";
				}
				else if (outcome.status == "failed") {
					record.status = "failed";
					record.reason = outcome.reason || "failed";
				}
				else {
					record.status = "translating";
					record.prepared = outcome.prepared || record.source;
				}
			}

			createSummary() {
				const summary = {jobId: this.id, channelId: this.channelId, generation: this.generation, translated: [], skipped: [], failed: []};
				for (const record of this.items.values()) {
					const item = Object.assign({}, record.source, {translation: record.translation, reason: record.reason});
					if (record.status == "translated") summary.translated.push(item);
					else if (record.status == "skipped") summary.skipped.push(item);
					else if (record.status == "failed") summary.failed.push(item);
				}
				return summary;
			}

			async start() {
				if (this.started) return this.runningPromise;
				this.sealed = true;
				this.started = true;
				this.state = "translating";
				this.dependencies.onStateChange(this);
				this.runningPromise = this.run();
				return this.runningPromise;
			}

			async run() {
				for (const record of this.items.values()) {
					if (this.state == "cancelled") return this.createSummary();
					if (record.status == "cancelled") continue;
					try {
						this.setPreparedOutcome(record, await this.dependencies.prepare(record.source, this));
					}
					catch (error) {
						this.setPreparedOutcome(record, {status: "failed", reason: "prepare_failed"});
					}
				}

				const translatingRecords = [...this.items.values()].filter(record => record.status == "translating");
				if (translatingRecords.length && this.state != "cancelled") {
					let resultMap = null;
					try {
						resultMap = await this.dependencies.translateBatch(translatingRecords.map(record => record.prepared), this);
					}
					catch (error) {}
					if (this.state == "cancelled") return this.createSummary();
					for (const record of translatingRecords) {
						if (record.status == "cancelled") continue;
						const messageId = String(record.source.message.id);
						const rawTranslation = resultMap && Object.prototype.hasOwnProperty.call(resultMap, messageId) ? resultMap[messageId] : null;
						let validation = {ok: false};
						try {validation = await this.dependencies.validate(record.prepared, rawTranslation, this) || {ok: false};}
						catch (error) {}
						if (validation.ok) {
							record.status = "translated";
							record.translation = validation.translation;
						}
						else record.status = "repairing";
					}
				}

				if (this.state == "cancelled") return this.createSummary();
				const unresolvedBatchRecords = [...this.items.values()].filter(record => record.status == "repairing");
				if (unresolvedBatchRecords.length > 1 && typeof this.dependencies.repairBatch == "function") {
					const chunkSize = Math.min(this.repairBatchSize, Math.max(1, Math.ceil(translatingRecords.length / 2)));
					for (let offset = 0; offset < unresolvedBatchRecords.length && this.state != "cancelled"; offset += chunkSize) {
						const chunk = unresolvedBatchRecords.slice(offset, offset + chunkSize).filter(record => record.status == "repairing");
						if (!chunk.length) continue;
						let repairResultMap = null;
						try {repairResultMap = await this.dependencies.repairBatch(chunk.map(record => record.prepared), this);}
						catch (error) {}
						if (this.state == "cancelled") return this.createSummary();
						for (const record of chunk) {
							if (record.status == "cancelled") continue;
							const messageId = String(record.source.message.id);
							const rawTranslation = repairResultMap && Object.prototype.hasOwnProperty.call(repairResultMap, messageId) ? repairResultMap[messageId] : null;
							let validation = {ok: false};
							try {validation = await this.dependencies.validate(record.prepared, rawTranslation, this) || {ok: false};}
							catch (error) {}
							if (validation.ok) {
								record.status = "translated";
								record.translation = validation.translation;
							}
						}
					}
				}

				if (this.state == "cancelled") return this.createSummary();
				this.state = "repairing";
				this.dependencies.onStateChange(this);
				const repairingRecords = [...this.items.values()].filter(record => record.status == "repairing");
				let repairIndex = 0;
				const repairNext = async () => {
					while (repairIndex < repairingRecords.length && this.state != "cancelled") {
						const record = repairingRecords[repairIndex++];
						if (!record || record.status == "cancelled") continue;
						let repairOutcome;
						try {repairOutcome = await this.dependencies.repair(record.prepared || record.source, this);}
						catch (error) {repairOutcome = {status: "failed", reason: "repair_failed"};}
						if (record.status == "cancelled") continue;
						this.setPreparedOutcome(record, repairOutcome);
						if (!HISTORICAL_TERMINAL_ITEM_STATES.has(record.status)) {
							record.status = "failed";
							record.reason = "repair_failed";
						}
					}
				};
				await Promise.all(Array.from({length: Math.min(this.repairConcurrency, repairingRecords.length)}, () => repairNext()));

				if (this.state == "cancelled") return this.createSummary();
				this.state = "ready";
				this.dependencies.onStateChange(this);
				await this.dependencies.waitForCommit(this);
				if (this.state == "cancelled" || !this.dependencies.isCurrent(this)) {
					this.cancel("stale_generation");
					return this.createSummary();
				}

				const summary = this.createSummary();
				await this.dependencies.commit(summary, this);
				if (this.state == "cancelled") return this.createSummary();
				this.dependencies.rerender(summary, this);
				this.state = "committed";
				this.dependencies.onStateChange(this);
				return summary;
			}
		}

		const protectionLogic = {
			escapeRegExp(_plugin, string) {
				return (string || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			},
			getExceptionScopeSetting(plugin, key, fallback = true) {
				const exceptions = plugin.settings && plugin.settings.exceptions || {};
				return exceptions[key] == null ? !!fallback : !!exceptions[key];
			},
			shouldProtectConfiguredTermsForPlace(plugin, place) {
				return place == messageTypes.SENT ? protectionLogic.getExceptionScopeSetting(plugin, "protectedTermsForSent", true) : protectionLogic.getExceptionScopeSetting(plugin, "protectedTermsForReceived", true);
			},
			shouldProtectWrappedTextForPlace(plugin, place) {
				return place == messageTypes.SENT ? protectionLogic.getExceptionScopeSetting(plugin, "wrapperPairsForSent", true) : protectionLogic.getExceptionScopeSetting(plugin, "wrapperPairsForReceived", true);
			},
			getProtectedTermsList(plugin) {
				let protectedTerms = BDFDB.ArrayUtils.is(plugin.settings.exceptions.protectedTerms) ? plugin.settings.exceptions.protectedTerms : [];
				return [...new Set(protectedTerms.map(term => (term || "").trim()).filter(Boolean))].sort((termA, termB) => termB.length - termA.length);
			},
			trimTrailingProtectedPunctuation(_plugin, text) {
				if (!text) return {protectedText: text, trailingText: ""};
				const trailingMatch = text.match(/([,.;:!?'"`)\]}>，。！？；：）】」》、]+)$/);
				if (!trailingMatch || trailingMatch.index < 1) return {protectedText: text, trailingText: ""};
				return {
					protectedText: text.slice(0, trailingMatch.index),
					trailingText: trailingMatch[0]
				};
			},
			protectRegexMatches(plugin, string, regex, protectedSegments = {}, count = 0, options = {}) {
				if (!string || !(regex instanceof RegExp)) return {string, protectedSegments, count};
				regex.lastIndex = 0;
				let lastIndex = 0, nextString = "", hasMatch = false, match;
				while ((match = regex.exec(string))) {
					let fullMatch = match[0];
					if (!fullMatch) {
						if (regex.global && regex.lastIndex === match.index) regex.lastIndex++;
						continue;
					}
					let protectedText = fullMatch;
					let trailingText = "";
					if (typeof options.normalize == "function") {
						let normalized = options.normalize(fullMatch, match, string) || {};
						protectedText = normalized.protectedText != null ? normalized.protectedText : protectedText;
						trailingText = normalized.trailingText || "";
					}
					if (!protectedText || !String(protectedText).trim()) continue;
					hasMatch = true;
					nextString += string.slice(lastIndex, match.index);
					protectedSegments[count] = protectedText;
					nextString += `${protectionLogic.createProtectionPlaceholder(plugin, count++)}${trailingText}`;
					lastIndex = match.index + fullMatch.length;
					if (!regex.global) break;
				}
				if (!hasMatch) return {string, protectedSegments, count};
				nextString += string.slice(lastIndex);
				return {string: nextString, protectedSegments, count};
			},
			protectCodeBlockSegments(plugin, string, protectedSegments = {}, count = 0) {
				return protectionLogic.protectRegexMatches(plugin, string, /```[\s\S]*?```/g, protectedSegments, count);
			},
			protectAutoDetectedSegments(plugin, string, protectedSegments = {}, count = 0) {
				let result = protectionLogic.protectRegexMatches(plugin, string, /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,24}\b/gi, protectedSegments, count);
				string = result.string;
				protectedSegments = result.protectedSegments;
				count = result.count;

				const trimTrailing = fullMatch => protectionLogic.trimTrailingProtectedPunctuation(plugin, fullMatch);
				result = protectionLogic.protectRegexMatches(plugin, string, /\bhttps?:\/\/[^\s<>()\u3000]+/gi, protectedSegments, count, {normalize: trimTrailing});
				string = result.string;
				protectedSegments = result.protectedSegments;
				count = result.count;

				result = protectionLogic.protectRegexMatches(plugin, string, /\b(?:www\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}(?:\/[^\s<>()\u3000]*)?/gi, protectedSegments, count, {
					normalize: fullMatch => {
						const trimmed = trimTrailing(fullMatch);
						if (!/[./]/.test(trimmed.protectedText || "")) return {protectedText: "", trailingText: fullMatch};
						return trimmed;
					}
				});
				string = result.string;
				protectedSegments = result.protectedSegments;
				count = result.count;

				result = protectionLogic.protectRegexMatches(plugin, string, /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{2,5})?\b/g, protectedSegments, count);
				string = result.string;
				protectedSegments = result.protectedSegments;
				count = result.count;

				string = string.replace(/(^|\s)(\/[A-Za-z][A-Za-z0-9_-]{1,32})(?=\s|$)/g, (fullMatch, leading, command) => {
					protectedSegments[count] = command;
					return `${leading || ""}${protectionLogic.createProtectionPlaceholder(plugin, count++)}`;
				});

				return {string, protectedSegments, count};
			},
			protectDiscordMarkupSegments(plugin, string, protectedSegments = {}, count = 0) {
				if (!string) return {string, protectedSegments, count};
				return protectionLogic.protectRegexMatches(plugin, string, /<a?:[A-Za-z0-9_~]+:\d+>|<@[!&]?\d+>|<#\d+>|<@&\d+>|<t:\d+(?::[tTdDfFR])?>/g, protectedSegments, count);
			},
			protectQuotedTextSegments(plugin, string, protectedSegments = {}, count = 0) {
				if (!plugin.settings.general.protectQuotedText || !string) return {string, protectedSegments, count};
				const quotedRegex = /"([^"\r\n]+)"|“([^”\r\n]+)”/g;
				string = string.replace(quotedRegex, fullMatch => {
					if (!fullMatch || !fullMatch.slice(1, -1).trim()) return fullMatch;
					protectedSegments[count] = fullMatch;
					return protectionLogic.createProtectionPlaceholder(plugin, count++);
				});
				return {string, protectedSegments, count};
			},
			protectWrappedTextSegments(plugin, string, protectedSegments = {}, count = 0, place = null) {
				if (!protectionLogic.shouldProtectWrappedTextForPlace(plugin, place) || !string) return {string, protectedSegments, count};
				for (let rule of plugin.getProtectedWrapperRules()) {
					let cursor = 0;
					let nextString = "";
					while (cursor < string.length) {
						let startIndex = string.indexOf(rule.left, cursor);
						if (startIndex < 0) {
							nextString += string.slice(cursor);
							break;
						}
						let contentStart = startIndex + rule.left.length;
						let endIndex = string.indexOf(rule.right, contentStart);
						if (endIndex < 0) {
							nextString += string.slice(cursor);
							break;
						}
						let fullText = string.slice(startIndex, endIndex + rule.right.length);
						let innerText = string.slice(contentStart, endIndex);
						nextString += string.slice(cursor, startIndex);
						if (innerText.trim() && !/[\r\n]/.test(fullText)) {
							protectedSegments[count] = fullText;
							nextString += protectionLogic.createProtectionPlaceholder(plugin, count++);
						}
						else nextString += fullText;
						cursor = endIndex + rule.right.length;
					}
					string = nextString;
				}
				return {string, protectedSegments, count};
			},
			protectConfiguredTerms(plugin, string, protectedSegments = {}, count = 0) {
				let protectedTerms = protectionLogic.getProtectedTermsList(plugin);
				const boundaryChars = "A-Za-z0-9_";
				for (let term of protectedTerms) {
					term = (term || "").trim();
					if (!term) continue;
					const startsWithWord = new RegExp(`^[${boundaryChars}]`).test(term);
					const endsWithWord = new RegExp(`[${boundaryChars}]$`).test(term);
					const termPattern = term.split(/\s+/).filter(Boolean).map(part => protectionLogic.escapeRegExp(plugin, part)).join("\\s*");
					const regex = new RegExp(`${startsWithWord ? `(^|[^${boundaryChars}])` : `()`}(${termPattern})${endsWithWord ? `(?=$|[^${boundaryChars}])` : ""}`, "gi");
					string = string.replace(regex, (match, leading, protectedTerm) => {
						if (!protectedTerm) return match;
						protectedSegments[count] = protectedTerm;
						return `${leading || ""}${protectionLogic.createProtectionPlaceholder(plugin, count++)}`;
					});
				}
				return {string, protectedSegments, count};
			},
			protectAutoTechnicalTerms(plugin, string, protectedSegments = {}, count = 0) {
				if (!string) return {string, protectedSegments, count};
				const protectToken = (fullMatch, offset, fullString) => {
					if (!fullMatch || fullMatch.length < 2) return fullMatch;
					const left = fullString[offset - 1] || "";
					const right = fullString[offset + fullMatch.length] || "";
					if (/[A-Za-z0-9_]/.test(left) || /[A-Za-z0-9_]/.test(right)) return fullMatch;
					protectedSegments[count] = fullMatch;
					return protectionLogic.createProtectionPlaceholder(plugin, count++);
				};

				string = string.replace(/\b[A-Za-z0-9_.-]{2,}\/[A-Za-z0-9_.-]{2,}(?:\/[A-Za-z0-9_.-]+)*\b/g, protectToken);
				string = string.replace(/\b[A-Za-z0-9_.-]+\.(?:js|jsx|ts|tsx|json|yml|yaml|toml|env|py|java|go|rs|cpp|c|h|css|html|md|txt|zip|rar|7z|exe|dll|png|jpg|jpeg|webp|gif|mp4|mov|psd|fig)\b/gi, protectToken);
				string = string.replace(/\bv\d+(?:\.\d+){1,4}(?:[-+][A-Za-z0-9.-]+)?\b|\b\d+(?:\.\d+){2,4}(?:[-+][A-Za-z0-9.-]+)?\b/gi, protectToken);
				const originalForShoutCheck = String(string);
				const isAllCapsLatinShouting = (() => {
					const latinLetters = originalForShoutCheck.match(/[A-Za-z]/g) || [];
					if (latinLetters.length < 4) return false;
					const upperCount = latinLetters.reduce((n, c) => n + (c >= "A" && c <= "Z" ? 1 : 0), 0);
					if (upperCount / latinLetters.length < 0.8) return false;
					const nonLatin = (originalForShoutCheck.match(/[一-鿿぀-ヿ가-힯]/g) || []).length;
					return nonLatin * 2 < latinLetters.length;
				})();
				if (!isAllCapsLatinShouting) {
					string = string.replace(/\b[A-Z][A-Z0-9]{1,}(?:[-_/+.][A-Z0-9]+)*\b/g, protectToken);
				}
				string = string.replace(/\b[A-Za-z]+(?:[A-Z][a-z0-9]+){1,}[A-Za-z0-9]*\b/g, protectToken);
				string = string.replace(/\b[A-Za-z0-9]+(?:[_-][A-Za-z0-9]+){1,}\b/g, protectToken);
				return {string, protectedSegments, count};
			},
			protectMixedLanguageLatinTokens(_plugin, string, protectedSegments = {}, count = 0) {
				return {string, protectedSegments, count};
			},
			getUnicodeEmojiDetector() {
				try {return new RegExp("[\\u200D\\uFE0E\\uFE0F\\u20E3]|\\p{Extended_Pictographic}|\\p{Regional_Indicator}", "u");}
				catch (err) {return /[\u200D\uFE0E\uFE0F\u20E3\u2600-\u27BF]|[\uD83C-\uDBFF][\uDC00-\uDFFF]/;}
			},
			isUnicodeEmojiGrapheme(_plugin, segment) {
				if (!segment || typeof segment != "string") return false;
				if (/^(?:\d|#|\*)$/.test(segment)) return false;
				const detector = protectionLogic.getUnicodeEmojiDetector();
				return !!(detector && detector.test(segment));
			},
			getUnicodeEmojiRegex() {
				try {
					return new RegExp("(?:\\p{Regional_Indicator}{2}|[0-9#*]\\uFE0F?\\u20E3|\\p{Extended_Pictographic}(?:\\uFE0F|\\uFE0E)?(?:\\p{Emoji_Modifier})?(?:\\u200D\\p{Extended_Pictographic}(?:\\uFE0F|\\uFE0E)?(?:\\p{Emoji_Modifier})?)*)", "gu");
				}
				catch (err) {
					return /(?:[\u2600-\u27BF]\uFE0F?|[\uD83C-\uDBFF][\uDC00-\uDFFF](?:\uFE0F|\uFE0E)?(?:\u200D[\uD83C-\uDBFF][\uDC00-\uDFFF](?:\uFE0F|\uFE0E)?)*)/g;
				}
			},
			protectUnicodeEmojiSegments(plugin, string, protectedSegments = {}, count = 0) {
				if (!string) return {string, protectedSegments, count};
				if (typeof Intl != "undefined" && Intl.Segmenter) {
					const detector = protectionLogic.getUnicodeEmojiDetector();
					const segmenter = new Intl.Segmenter(undefined, {granularity: "grapheme"});
					let nextString = "";
					for (const part of segmenter.segment(string)) {
						const segment = part && part.segment || "";
						if (segment && detector && protectionLogic.isUnicodeEmojiGrapheme(plugin, segment)) {
							protectedSegments[count] = segment;
							nextString += protectionLogic.createProtectionPlaceholder(plugin, count++);
						}
						else nextString += segment;
					}
					return {string: nextString, protectedSegments, count};
				}
				return protectionLogic.protectRegexMatches(plugin, string, protectionLogic.getUnicodeEmojiRegex(), protectedSegments, count);
			},
			createProtectionPlaceholder(_plugin, count) {
				return `⟦${count}⟧`;
			},
			getProtectionPlaceholderRegex(_plugin, count) {
				return new RegExp(`(?:⟦\\s*(?:DTA\\s*)?${count}\\s*⟧|【\\s*${count}\\s*】|\\[\\s*${count}\\s*\\]|<\\s*<\\s*<\\s*${count}\\s*>\\s*>\\s*>|[｛\\{]\\s*[｛\\{]\\s*${count}\\s*[｝\\}]\\s*[｝\\}])`, "g");
			},
			formatProtectedExceptionForDisplay(_plugin, exception) {
				if (exception == null) return "";
				exception = String(exception);
				if (/^<a?:[A-Za-z0-9_~]+:\d+>$/.test(exception)) return exception;
				if (/^<@!?\d+>$/.test(exception)) return exception;
				if (/^<@&\d+>$/.test(exception)) return exception;
				if (/^<#\d+>$/.test(exception)) return exception;
				return exception;
			},
			hasAllProtectionPlaceholders(plugin, string, protectedSegments) {
				if (!protectedSegments || !Object.keys(protectedSegments).length) return true;
				return Object.keys(protectedSegments).every(count => protectionLogic.getProtectionPlaceholderRegex(plugin, count).test(string || ""));
			},
			addExceptions(plugin, string, protectedSegments) {
				for (let count in protectedSegments) {
					let exception = BDFDB.ArrayUtils.is(plugin.settings.exceptions.wordStart) && plugin.settings.exceptions.wordStart.some(n => String(protectedSegments[count]).indexOf(n) == 0) ? String(protectedSegments[count]).slice(1) : String(protectedSegments[count]);
					let replacement = protectionLogic.formatProtectedExceptionForDisplay(plugin, exception);
					let newString = string.replace(protectionLogic.getProtectionPlaceholderRegex(plugin, count), replacement);
					string = newString;
				}
				return string;
			},
			removeExceptions(plugin, string, place) {
				let protectedSegments = {}, newString = [], count = 0;
				let discordMarkupResult = protectionLogic.protectDiscordMarkupSegments(plugin, string, protectedSegments, count);
				string = discordMarkupResult.string;
				protectedSegments = discordMarkupResult.protectedSegments;
				count = discordMarkupResult.count;
				let codeBlockResult = protectionLogic.protectCodeBlockSegments(plugin, string, protectedSegments, count);
				string = codeBlockResult.string;
				protectedSegments = codeBlockResult.protectedSegments;
				count = codeBlockResult.count;
				let wrappedTextResult = protectionLogic.protectWrappedTextSegments(plugin, string, protectedSegments, count, place);
				string = wrappedTextResult.string;
				protectedSegments = wrappedTextResult.protectedSegments;
				count = wrappedTextResult.count;
				let autoProtectedResult = protectionLogic.protectAutoDetectedSegments(plugin, string, protectedSegments, count);
				string = autoProtectedResult.string;
				protectedSegments = autoProtectedResult.protectedSegments;
				count = autoProtectedResult.count;
				if (protectionLogic.shouldProtectConfiguredTermsForPlace(plugin, place)) {
					let protectedTermsResult = protectionLogic.protectConfiguredTerms(plugin, string, protectedSegments, count);
					string = protectedTermsResult.string;
					protectedSegments = protectedTermsResult.protectedSegments;
					count = protectedTermsResult.count;
				}
				let autoTechnicalTermsResult = protectionLogic.protectAutoTechnicalTerms(plugin, string, protectedSegments, count);
				string = autoTechnicalTermsResult.string;
				protectedSegments = autoTechnicalTermsResult.protectedSegments;
				count = autoTechnicalTermsResult.count;
				let emojiProtectedResult = protectionLogic.protectUnicodeEmojiSegments(plugin, string, protectedSegments, count);
				string = emojiProtectedResult.string;
				protectedSegments = emojiProtectedResult.protectedSegments;
				count = emojiProtectedResult.count;

				if (place == messageTypes.RECEIVED) {
					newString.push(string);
				}
				else {
					let usedExceptions = BDFDB.ArrayUtils.is(plugin.settings.exceptions.wordStart) ? plugin.settings.exceptions.wordStart : [];
					string.split(" ").forEach(word => {
						if (word.indexOf("<@!") == 0 || word.indexOf("<#") == 0 || word.indexOf(":") == 0 || word.indexOf("<:") == 0 || word.indexOf("<a:") == 0 || word.indexOf("@") == 0 || word.indexOf("#") == 0 || usedExceptions.some(n => word.indexOf(n) == 0 && word.length > 1)) {
							newString.push(protectionLogic.createProtectionPlaceholder(plugin, count));
							protectedSegments[count] = word;
							count++;
						}
						else newString.push(word);
					});
				}
				const maskedString = newString.join(place == messageTypes.RECEIVED ? "" : " ");
				const hasTranslatableContent = maskedString.replace(/(?:⟦\s*(?:DTA\s*)?\d+\s*⟧|【\s*\d+\s*】|\[\s*\d+\s*\]|<<<\s*\d+\s*>>>|\{\{\d+\}\})/g, "").trim().length > 0;
				return [maskedString, protectedSegments, hasTranslatableContent];
			}
		};

		const receivedTranslationRuntime = {
			resetLoadedMessageTracking(channelId = null) {
				loadedTranslationStatusStore.resetSeen(channelId);
			},
			resetQueueTimer() {
				if (autoTranslationQueueRetryTimer) clearTimeout(autoTranslationQueueRetryTimer);
				autoTranslationQueueRetryTimer = null;
			},
			resetAutoTranslationTracking(plugin, channelId = null) {
				if (channelId) {
					delete autoTranslationChannelStates[channelId];
					receivedTranslationRuntime.resetLoadedMessageTracking(channelId);
				}
				else {
					autoTranslationChannelStates = {};
					receivedTranslationRuntime.resetLoadedMessageTracking();
				}
				plugin.clearAutoTranslationEligibleReplyPreviewMessages(channelId);
				if (!channelId || lastAutoTranslationChannelId == channelId) lastAutoTranslationChannelId = null;
			},
			getAutoTranslationChannelState(_plugin, channelId) {
				if (!channelId) return null;
				if (!autoTranslationChannelStates[channelId]) autoTranslationChannelStates[channelId] = {
					initialized: false,
					boundaryMessageId: null
				};
				return autoTranslationChannelStates[channelId];
			},
			prepareAutoTranslationChannelSession(plugin, channelId) {
				if (!channelId || lastAutoTranslationChannelId == channelId) return;
				const previousChannelId = lastAutoTranslationChannelId;
				if (previousChannelId) {
					plugin.clearAutoTranslationQueue(previousChannelId);
					// The seen map only serves boundary dedup inside the active channel session;
					// keeping it for left channels grows memory for the whole Discord session.
					receivedTranslationRuntime.resetLoadedMessageTracking(previousChannelId);
				}
				lastAutoTranslationChannelId = channelId;
				const channelState = receivedTranslationRuntime.getAutoTranslationChannelState(plugin, channelId);
				channelState.initialized = false;
				channelState.boundaryMessageId = null;
				receivedTranslationRuntime.resetLoadedMessageTracking(channelId);
				plugin.clearAutoTranslationEligibleReplyPreviewMessages(channelId);
				if (plugin.getReceivedAutoTranslateScope() == "new_only") plugin.clearDisplayedAutoTranslations(channelId);
			},
			getLiveTranslationRequestKey(_plugin, messageId, channelId) {
				return `${channelId || "__global"}:${String(messageId || "")}`;
			},
			createLiveTranslationRequest(plugin, message, channelId, originalContentData = null, signature = null) {
				if (!message || !message.id || !channelId) return null;
				const request = {
					id: ++liveTranslationRequestSequence,
					generation: liveTranslationRuntimeGeneration,
					channelId,
					messageId: String(message.id),
					signature: signature || plugin.createReceivedTranslationSignature(message, channelId, originalContentData || plugin.extractOriginalContentData(message))
				};
				liveTranslationRequests[receivedTranslationRuntime.getLiveTranslationRequestKey(plugin, request.messageId, channelId)] = request;
				return request;
			},
			isLiveTranslationRequestCurrent(plugin, request, message = null) {
				if (!request || !pluginRuntimeActive || request.generation != liveTranslationRuntimeGeneration || !plugin.isTranslationEnabled(request.channelId)) return false;
				const key = receivedTranslationRuntime.getLiveTranslationRequestKey(plugin, request.messageId, request.channelId);
				if (liveTranslationRequests[key] !== request) return false;
				if (!message) return true;
				const currentContentData = plugin.extractOriginalContentData(message);
				return plugin.createReceivedTranslationSignature(message, request.channelId, currentContentData) == request.signature;
			},
			releaseLiveDisplayPending(plugin, request) {
				// A live request that ends without a terminal commit must return its store
				// record to idle; a lingering pending identity would poison later commits.
				plugin.releaseReceivedDisplayPending({
					messageId: request.messageId,
					channelId: request.channelId,
					requestIdentity: String(request.id)
				});
			},
			finishLiveTranslationRequest(plugin, request) {
				if (!request) return false;
				const key = receivedTranslationRuntime.getLiveTranslationRequestKey(plugin, request.messageId, request.channelId);
				if (liveTranslationRequests[key] === request) delete liveTranslationRequests[key];
				if (queuedAutoTranslations[request.messageId] === request) delete queuedAutoTranslations[request.messageId];
				receivedTranslationRuntime.releaseLiveDisplayPending(plugin, request);
				return true;
			},
			invalidateLiveTranslationRequests(plugin, channelId = null) {
				if (!channelId) liveTranslationRuntimeGeneration++;
				for (const key of Object.keys(liveTranslationRequests)) {
					const request = liveTranslationRequests[key];
					if (channelId && request.channelId != channelId) continue;
					delete liveTranslationRequests[key];
					if (queuedAutoTranslations[request.messageId] === request) delete queuedAutoTranslations[request.messageId];
					receivedTranslationRuntime.releaseLiveDisplayPending(plugin, request);
				}
			},
			invalidateLiveTranslationMessage(plugin, messageId, channelId, currentSignature) {
				if (!messageId || !channelId || !currentSignature) return false;
				const key = receivedTranslationRuntime.getLiveTranslationRequestKey(plugin, messageId, channelId);
				const request = liveTranslationRequests[key];
				if (!request || request.signature == currentSignature) return false;
				delete liveTranslationRequests[key];
				if (queuedAutoTranslations[request.messageId] === request) delete queuedAutoTranslations[request.messageId];
				receivedTranslationRuntime.releaseLiveDisplayPending(plugin, request);
				return true;
			},
			clearAutoTranslationQueue(plugin, channelId = null) {
				plugin.cancelHistoricalTranslationJobs(channelId, channelId ? "channel-queue-cleared" : "all-queues-cleared");
				plugin.cancelPendingChannelTitleTranslation(channelId);
				receivedTranslationRuntime.invalidateLiveTranslationRequests(plugin, channelId);
				plugin.invalidateSentAutomaticTranslationRequests(channelId);
				if (!channelId) {
					autoTranslationQueue = [];
					queuedAutoTranslations = {};
					queuedReplyPreviewTranslations = {};
					autoTranslationEligibleReplyPreviewMessages = {};
					replyPreviewRenderMessageIds = {};
					deferredTranslationRerenderPending = false;
					receivedTranslationRuntime.resetLoadedMessageTracking();
					receivedTranslationRuntime.resetQueueTimer();
					plugin.clearLoadedAutoTranslationStatus();
					return;
				}
				autoTranslationQueue = autoTranslationQueue.filter(queueItem => {
					const shouldRemove = queueItem && queueItem.channel && queueItem.channel.id == channelId;
					if (shouldRemove && queueItem.message && queueItem.message.id && (!queueItem.liveRequest || queuedAutoTranslations[queueItem.message.id] === queueItem.liveRequest)) delete queuedAutoTranslations[queueItem.message.id];
					return !shouldRemove;
				});
				for (const messageId of Object.keys(queuedReplyPreviewTranslations)) {
					const request = queuedReplyPreviewTranslations[messageId];
					if (request == channelId || request && request.channelId == channelId) delete queuedReplyPreviewTranslations[messageId];
				}
				delete autoTranslationEligibleReplyPreviewMessages[channelId];
				receivedTranslationRuntime.resetLoadedMessageTracking(channelId);
				if (!autoTranslationQueue.length && autoTranslationQueueRetryTimer) {
					clearTimeout(autoTranslationQueueRetryTimer);
					autoTranslationQueueRetryTimer = null;
				}
				if (loadedTranslationStatusStore.isForChannel(channelId)) plugin.clearLoadedAutoTranslationStatus();
			},
			scheduleAutoTranslationQueueRetry(plugin) {
				if (autoTranslationQueueRetryTimer) return;
				autoTranslationQueueRetryTimer = setTimeout(_ => {
					autoTranslationQueueRetryTimer = null;
					plugin.processAutoTranslationQueue();
				}, AUTO_TRANSLATION_QUEUE_RETRY_DELAY);
			},
			scheduleAutoTranslationBackoff(plugin, ms) {
				plugin.ensureProviderClient().scheduleBackoff(ms);
				receivedTranslationRuntime.scheduleAutoTranslationQueueRetry(plugin);
			},
			awaitProviderBackoff(_plugin) {
				return _plugin.ensureProviderClient().awaitBackoff();
			},
			createQueueItem(plugin, message, channel, originalContentData = null, queueOptions = {}) {
				const normalizedOriginalContentData = originalContentData || plugin.extractOriginalContentData(message);
				return {
					message,
					channel,
					originalContentData: normalizedOriginalContentData,
					historicalLoad: !!queueOptions.historicalLoad,
					deferHistoricalSnapshotStart: !!queueOptions.deferHistoricalSnapshotStart,
					deferWhileReading: !!queueOptions.deferWhileReading,
					cachedTranslation: queueOptions.cachedTranslation || null,
					liveRequest: null
				};
			},
			enqueueLiveItem(plugin, queueItem) {
				autoTranslationQueue.unshift(queueItem);
				plugin.processAutoTranslationQueue();
				return true;
			},
			queueAutoTranslateMessage(plugin, message, channel, originalContentData = null, queueOptions = {}) {
				const cachedTranslation = queueOptions.cachedTranslation || null;
				if (!cachedTranslation && !plugin.shouldAutoTranslateReceivedMessage(message, channel, originalContentData)) return false;
				if (queueOptions.historicalLoad && !plugin.isMessageWithinLoadedRange(message)) return false;
				const queueItem = receivedTranslationRuntime.createQueueItem(plugin, message, channel, originalContentData, queueOptions);
				if (queueItem.historicalLoad) return plugin.collectHistoricalTranslationMessage(queueItem);
				const channelId = channel && channel.id || plugin.getMessageChannelId(message);
				queueItem.liveRequest = receivedTranslationRuntime.createLiveTranslationRequest(plugin, message, channelId, queueItem.originalContentData);
				if (!queueItem.liveRequest) return false;
				queuedAutoTranslations[message.id] = queueItem.liveRequest;
				const pendingMark = plugin.markReceivedDisplayPending({
					messageId: message.id,
					channelId,
					generation: plugin.getReceivedDisplayCommitGeneration(channelId),
					origin: "automatic",
					requestIdentity: String(queueItem.liveRequest.id)
				}, {refresh: false});
				if (pendingMark && pendingMark.catch) pendingMark.catch(_ => {});
				return receivedTranslationRuntime.enqueueLiveItem(plugin, queueItem);
			},
			beginQueueProcessing(plugin) {
				if (isTranslating || isLiveAutoTranslating) return false;
				if (plugin.ensureProviderClient().isBackoffActive()) {
					receivedTranslationRuntime.scheduleAutoTranslationQueueRetry(plugin);
					return false;
				}
				return true;
			},
			finishQueueIfEmpty() {
				return !autoTranslationQueue.length;
			},
			handleCachedQueueItem(plugin, queueItem) {
				if (!queueItem || !queueItem.cachedTranslation) return false;
				const channelId = queueItem.channel && queueItem.channel.id || "__global";
				const storedTranslation = plugin.refreshTranslationDisplay(Object.assign({channelId, auto: true}, queueItem.cachedTranslation));
				const commit = plugin.commitReceivedDisplayResult(plugin.createReceivedDisplayCommitResult(queueItem.message, channelId, {
					sourceSignature: storedTranslation.signature != null ? String(storedTranslation.signature) : plugin.createReceivedTranslationSignature(queueItem.message, channelId, queueItem.originalContentData),
					requestIdentity: queueItem.liveRequest ? String(queueItem.liveRequest.id) : null,
					status: "translated",
					translation: storedTranslation
				}), {refresh: false});
				const finishRequest = outcome => {
					if (outcome && outcome.deferredIds && outcome.deferredIds.length) plugin.scheduleReceivedDisplayFlush(channelId, queueItem.message.id);
					receivedTranslationRuntime.finishLiveTranslationRequest(plugin, queueItem.liveRequest);
				};
				Promise.resolve(commit).then(finishRequest, _ => finishRequest(null));
				return true;
			},
			handleQueueItemGuardFailure(plugin, queueItem) {
				if (!queueItem) return false;
				if (plugin.shouldAutoTranslateReceivedMessage(queueItem.message, queueItem.channel, queueItem.originalContentData, true)) return false;
				receivedTranslationRuntime.finishLiveTranslationRequest(plugin, queueItem.liveRequest);
				return true;
			},
			// Drains queued live items that can share one AI batch request with the first
			// item: same channel, no cached result, and not already batch-rejected.
			collectLiveBatchItems(plugin, firstItem) {
				const channelId = firstItem.channel && firstItem.channel.id || plugin.getMessageChannelId(firstItem.message);
				if (!channelId || firstItem.skipLiveBatch || firstItem.cachedTranslation) return null;
				if (!plugin.getHistoricalAiBatchEngineKey(channelId)) return null;
				const items = [firstItem];
				for (let index = 0; index < autoTranslationQueue.length && items.length < LIVE_AI_BATCH_ITEM_LIMIT;) {
					const candidate = autoTranslationQueue[index];
					const candidateChannelId = candidate && candidate.channel && candidate.channel.id || candidate && plugin.getMessageChannelId(candidate.message);
					if (!candidate || !candidate.message || candidate.historicalLoad || candidate.cachedTranslation || candidate.skipLiveBatch || candidateChannelId != channelId) {
						index++;
						continue;
					}
					autoTranslationQueue.splice(index, 1);
					items.push(candidate);
				}
				return items.length > 1 ? {channelId, items} : null;
			},
			finishBurstItem(plugin, queueItem, channelId, result) {
				const commit = plugin.commitReceivedDisplayResult(plugin.createReceivedDisplayCommitResult(queueItem.message, channelId, Object.assign({
					requestIdentity: queueItem.liveRequest ? String(queueItem.liveRequest.id) : null
				}, result)), {refresh: false});
				const finishRequest = outcome => {
					if (outcome && outcome.deferredIds && outcome.deferredIds.length) plugin.scheduleReceivedDisplayFlush(channelId, queueItem.message.id);
					receivedTranslationRuntime.finishLiveTranslationRequest(plugin, queueItem.liveRequest);
				};
				return Promise.resolve(commit).then(finishRequest, _ => finishRequest(null));
			},
			// Returns a burst item to the single-message path, preserving the queue's
			// newest-first order so a retry is never starved behind later arrivals.
			requeueBurstItem(plugin, queueItem, settled) {
				settled.add(queueItem);
				queueItem.skipLiveBatch = true;
				// A cancelled channel already emptied its queue; re-injecting the item there
				// would restart provider traffic the cancellation was meant to stop.
				if (!plugin.isLiveTranslationRequestCurrent(queueItem.liveRequest, queueItem.message)) {
					receivedTranslationRuntime.finishLiveTranslationRequest(plugin, queueItem.liveRequest);
					return;
				}
				autoTranslationQueue.unshift(queueItem);
			},
			async translateQueuedBurst(plugin, burst) {
				const {channelId, items} = burst;
				// Every drained item must reach a terminal state; anything still unsettled when
				// this returns is released so no message is left with a stuck loading indicator.
				const settled = new Set();
				isLiveAutoTranslating = true;
				try {
					const engineKey = plugin.getHistoricalAiBatchEngineKey(channelId);
					const input = Object.assign({}, languages[plugin.getLanguageChoice(languageTypes.INPUT, messageTypes.RECEIVED, channelId)] || {});
					const output = Object.assign({}, languages[plugin.getLanguageChoice(languageTypes.OUTPUT, messageTypes.RECEIVED, channelId)] || {});
					const prepared = [];
					for (const queueItem of items) {
						try {
							// A source edit or channel switch between queueing and now invalidates
							// the item; the request guard is the same one the single path uses.
							if (!plugin.isLiveTranslationRequestCurrent(queueItem.liveRequest, queueItem.message)) {
								settled.add(queueItem);
								receivedTranslationRuntime.finishLiveTranslationRequest(plugin, queueItem.liveRequest);
								continue;
							}
							const preparedItem = plugin.prepareHistoricalAiBatchQueueItem(queueItem, channelId, input, output);
							if (!preparedItem || preparedItem.skipped || preparedItem.cachedTranslation || !preparedItem.protectedText) {
								// Anything the batch cannot carry goes back to the single path.
								receivedTranslationRuntime.requeueBurstItem(plugin, queueItem, settled);
								continue;
							}
							prepared.push(preparedItem);
						}
						catch (error) {
							receivedTranslationRuntime.requeueBurstItem(plugin, queueItem, settled);
						}
					}
					if (!prepared.length) return;
					let resultMap = null;
					try {resultMap = await plugin.requestAiBatchTranslation(engineKey, prepared);}
					catch (error) {resultMap = null;}
					const commits = [];
					for (const preparedItem of prepared) {
						const queueItem = preparedItem.queueItem;
						try {
							const messageId = String(preparedItem.message.id);
							const rawTranslation = resultMap && Object.prototype.hasOwnProperty.call(resultMap, messageId) ? resultMap[messageId] : null;
							// An explicit skip verdict is a terminal answer, not a failure: paying
							// for a second full-price request to reach the same verdict is waste.
							if (rawTranslation != null && plugin.isSkipTranslationSignal(rawTranslation)) {
								settled.add(queueItem);
								plugin.persistReceivedSkipDecision(messageId, preparedItem.signature, "ai_skip_signal", preparedItem.protectedText);
								commits.push(receivedTranslationRuntime.finishBurstItem(plugin, queueItem, channelId, {
									sourceSignature: preparedItem.signature,
									status: "skipped",
									reason: "ai_skip_signal"
								}));
								continue;
							}
							let validation = {ok: false};
							try {validation = plugin.validateHistoricalTranslationJobResult(preparedItem, rawTranslation, {channelId}) || {ok: false};}
							catch (error) {validation = {ok: false};}
							if (!validation.ok) {
								// One unusable item must not cost the whole burst: retry it alone.
								receivedTranslationRuntime.requeueBurstItem(plugin, queueItem, settled);
								continue;
							}
							// The result is paid for and valid, so it is cached even when the live
							// request went stale; a retry then hits the cache instead of the provider.
							try {plugin.persistTranslationCacheEntry(messageId, preparedItem.signature, validation.translation);}
							catch (error) {}
							if (!plugin.isLiveTranslationRequestCurrent(queueItem.liveRequest, queueItem.message)) {
								settled.add(queueItem);
								receivedTranslationRuntime.finishLiveTranslationRequest(plugin, queueItem.liveRequest);
								continue;
							}
							settled.add(queueItem);
							commits.push(receivedTranslationRuntime.finishBurstItem(plugin, queueItem, channelId, {
								sourceSignature: preparedItem.signature,
								status: "translated",
								translation: validation.translation
							}));
						}
						catch (error) {
							receivedTranslationRuntime.requeueBurstItem(plugin, queueItem, settled);
						}
					}
					await Promise.all(commits);
				}
				finally {
					for (const queueItem of items) {
						if (settled.has(queueItem)) continue;
						try {receivedTranslationRuntime.finishLiveTranslationRequest(plugin, queueItem.liveRequest);}
						catch (error) {}
					}
					isLiveAutoTranslating = false;
					plugin.processAutoTranslationQueue();
				}
			},
			translateQueuedItem(plugin, queueItem) {
				isLiveAutoTranslating = true;
				plugin.translateMessage(queueItem.message, queueItem.channel, {
					auto: true,
					silent: true,
					trackBusy: false,
					originalContentData: queueItem.originalContentData,
					liveRequest: queueItem.liveRequest
				}).then(_ => {
					receivedTranslationRuntime.finishLiveTranslationRequest(plugin, queueItem.liveRequest);
					isLiveAutoTranslating = false;
					plugin.processAutoTranslationQueue();
				}).catch(_ => {
					receivedTranslationRuntime.finishLiveTranslationRequest(plugin, queueItem.liveRequest);
					isLiveAutoTranslating = false;
					plugin.processAutoTranslationQueue();
				});
			},
			createProcessMessagesContext(plugin, e) {
				e.instance.props.channelStream = [].concat(e.instance.props.channelStream);
				const channel = e.instance.props.channel;
				const channelId = channel && channel.id;
				plugin.prepareAutoTranslationChannelSession(channelId);
				const channelState = plugin.getAutoTranslationChannelState(channelId);
				const shouldInitializeAutoTranslation = !!(channelId && plugin.isTranslationEnabled(channelId) && channelState && !channelState.initialized);
				const historicalLoadedPass = shouldInitializeAutoTranslation && plugin.getReceivedAutoTranslateScope() == "loaded_messages";
				if (historicalLoadedPass) {
					const retainedFailedCount = plugin.getFailedHistoricalTranslationCount(channelId);
					plugin.attachAutoTranslationScrollWatcher();
					plugin.updateLoadedAutoTranslationStatus({active: true, collecting: true, done: false, channelId, batch: loadedTranslationStatusStore.getNextBatchNumber(), total: 0, processed: 0, displayed: 0, skipped: 0, failed: 0, retryable: retainedFailedCount, aiDropped: 0, lastSkipReason: "", lastSkipPreview: ""});
				}
				return {
					channel,
					channelId,
					channelState,
					shouldInitializeAutoTranslation,
					historicalLoadedPass,
					skipInitialLoadedMessages: shouldInitializeAutoTranslation && plugin.shouldDeferInitialAutoTranslate(channelId),
					autoTranslateBoundaryId: channelState ? channelState.boundaryMessageId : null,
					highestMessageId: channelState ? channelState.boundaryMessageId : null,
					collectedHistoricalMessages: false
				};
			},
			shouldCollectHistoricalStreamMessage(plugin, message, context) {
				if (!message || !message.id || !context.channelId) return false;
				const wasSeen = plugin.markLoadedAutoTranslationMessageSeen(context.channelId, message.id);
				if (plugin.getReceivedAutoTranslateScope() != "loaded_messages") return false;
				if (context.historicalLoadedPass) return true;
				return !wasSeen && !plugin.isMessageIdNewer(message.id, context.autoTranslateBoundaryId);
			},
			processChannelStreamEntry(plugin, entry, context) {
				const message = entry && entry.content;
				if (!message) return context.highestMessageId;
				if (BDFDB.ArrayUtils.is(message.attachments)) {
					const historicalLoad = receivedTranslationRuntime.shouldCollectHistoricalStreamMessage(plugin, message, context);
					if (historicalLoad) context.collectedHistoricalMessages = true;
					context.highestMessageId = plugin.getNewestMessageId(context.highestMessageId, message.id);
					plugin.checkMessage(entry, message, context.channel, {
						skipAutoQueue: context.skipInitialLoadedMessages,
						autoTranslateBoundaryId: context.autoTranslateBoundaryId,
						historicalLoad,
						deferHistoricalSnapshotStart: historicalLoad
					});
					return context.highestMessageId;
				}
				if (BDFDB.ArrayUtils.is(message)) for (let index in message) {
					const childMessage = message[index].content;
					if (!childMessage || !BDFDB.ArrayUtils.is(childMessage.attachments)) continue;
					const historicalLoad = receivedTranslationRuntime.shouldCollectHistoricalStreamMessage(plugin, childMessage, context);
					if (historicalLoad) context.collectedHistoricalMessages = true;
					context.highestMessageId = plugin.getNewestMessageId(context.highestMessageId, childMessage.id);
					plugin.checkMessage(message[index], childMessage, context.channel, {
						skipAutoQueue: context.skipInitialLoadedMessages,
						autoTranslateBoundaryId: context.autoTranslateBoundaryId,
						historicalLoad,
						deferHistoricalSnapshotStart: historicalLoad
					});
				}
				return context.highestMessageId;
			},
			finishProcessMessages(plugin, context) {
				if (context.channelState) {
					context.channelState.boundaryMessageId = plugin.getNewestMessageId(context.channelState.boundaryMessageId, context.highestMessageId);
					if (context.shouldInitializeAutoTranslation) context.channelState.initialized = true;
				}
				if (context.historicalLoadedPass || context.collectedHistoricalMessages) {
					if (context.collectedHistoricalMessages && !plugin.isUserActivelyScrollingMessages(context.channelId)) plugin.finishHistoricalTranslationSnapshot(context.channelId);
					const historicalEntry = plugin.getHistoricalTranslationJobQueue(context.channelId, false);
					const hasQueuedHistoricalForChannel = !!(historicalEntry && (historicalEntry.runningPromise || historicalEntry.jobs.length));
					if (!hasQueuedHistoricalForChannel) plugin.updateLoadedAutoTranslationStatus({active: false, collecting: false, done: true, channelId: context.channelId, batch: loadedTranslationStatusStore.getCurrentBatchNumber(), total: 0, processed: 0});
				}
			},
			processMessages(plugin, e) {
				const context = receivedTranslationRuntime.createProcessMessagesContext(plugin, e);
				for (let index in e.instance.props.channelStream) {
					receivedTranslationRuntime.processChannelStreamEntry(plugin, e.instance.props.channelStream[index], context);
				}
				receivedTranslationRuntime.finishProcessMessages(plugin, context);
			},
			createCheckMessageContext(plugin, message, channel, options = {}) {
				const channelId = channel && channel.id || BDFDB.LibraryStores.SelectedChannelStore.getChannelId();
				const sourceChanged = plugin.refreshReceivedMessageSourceState(message, channelId);
				const originalContentData = plugin.extractOriginalContentData(message);
				const channelState = plugin.getAutoTranslationChannelState(channelId);
				const autoTranslateBoundaryId = options.autoTranslateBoundaryId != null ? options.autoTranslateBoundaryId : channelState && channelState.boundaryMessageId;
				const expectedSignature = plugin.createReceivedTranslationSignature(message, channelId, originalContentData);
				const pendingSourceChanged = plugin.invalidateHistoricalTranslationMessage(message.id, channelId, expectedSignature);
				const liveSourceChanged = plugin.invalidateLiveTranslationMessage(message.id, channelId, expectedSignature);
				return {
					channelId,
					channelState,
					originalContentData,
					expectedSignature,
					forceQueue: sourceChanged || pendingSourceChanged || liveSourceChanged,
					skipAutoQueue: !!options.skipAutoQueue,
					isNewerThanBoundary: plugin.isMessageIdNewer(message.id, autoTranslateBoundaryId),
					historicalLoad: !!options.historicalLoad,
					deferHistoricalSnapshotStart: !!options.deferHistoricalSnapshotStart
				};
			},
			captureReceivedDisplaySource(plugin, message, context) {
				if (!context.channelId || plugin.isOwnMessage(message)) return null;
				// A disabled channel captures nothing: recapturing during the restore repaint
				// would replace cancelled records and break the transaction's acknowledgement.
				if (!plugin.isTranslationEnabled(context.channelId)) return null;
				const previousView = plugin.getReceivedDisplayRuntimeView(message.id);
				const generation = plugin.getReceivedDisplayGeneration(context.channelId);
				const record = plugin.captureReceivedMessageSource({
					messageId: message.id,
					channelId: context.channelId,
					generation: generation === undefined ? 1 : generation,
					sourceSignature: context.expectedSignature,
					source: {
						content: context.originalContentData && context.originalContentData.content || "",
						embeds: context.originalContentData && context.originalContentData.embeds || []
					}
				});
				// A same-generation signature change on a non-idle record is a source edit:
				// the fresh idle record replaced stale display state, so the message must
				// requeue and its stale cache entry must go.
				const sourceChanged = !!(previousView && record && previousView.status !== "idle" && previousView.generation === record.generation && previousView.sourceSignature !== record.sourceSignature);
				if (sourceChanged) {
					context.forceQueue = true;
					plugin.clearCachedTranslation(message.id);
				}
				return record;
			},
			commitCachedDisplayResult(plugin, message, context, cachedTranslation) {
				const storedTranslation = plugin.refreshTranslationDisplay(Object.assign({channelId: context.channelId, auto: true}, cachedTranslation));
				const commit = plugin.commitReceivedDisplayResult(plugin.createReceivedDisplayCommitResult(message, context.channelId, {
					sourceSignature: storedTranslation.signature != null ? String(storedTranslation.signature) : context.expectedSignature,
					status: "translated",
					translation: storedTranslation
				}), {refresh: false});
				if (commit && commit.catch) commit.catch(_ => {});
				const committedView = plugin.getReceivedDisplayRuntimeView(message.id);
				return !!(committedView && committedView.translated);
			},
			resolveCheckMessageDisplay(plugin, stream, message, context) {
				const hadDisplayedTranslation = !!translatedMessages[message.id];
				let translation = plugin.getActiveMessageTranslation(message, context.channelId, context.expectedSignature);
				let messageChanged = hadDisplayedTranslation && !translation;
				const canAutoTranslateMessage = plugin.isTranslationEnabled(context.channelId) && !suppressedAutoTranslations[message.id];
				const canAutoTranslateReplyPreviewForBase = canAutoTranslateMessage && !context.skipAutoQueue && (context.historicalLoad ? plugin.isMessageWithinLoadedRange(message) : context.isNewerThanBoundary);
				let cachedTranslation = null;
				let storeCommitted = false;
				if (canAutoTranslateReplyPreviewForBase) plugin.markAutoTranslationEligibleReplyPreviewMessage(context.channelId, message.id);
				if (!translation && canAutoTranslateMessage && !context.skipAutoQueue && (context.historicalLoad || context.forceQueue || messageChanged || context.isNewerThanBoundary)) {
					cachedTranslation = plugin.getCachedReceivedTranslation(message, context.channelId, context.originalContentData);
					// A cached automatic result commits into the display store without a refresh:
					// the render pass that triggered checkMessage paints text and decoration
					// together from the committed view.
					if (cachedTranslation && !context.historicalLoad) storeCommitted = receivedTranslationRuntime.commitCachedDisplayResult(plugin, message, context, cachedTranslation);
				}
				const storeView = !translation && plugin.getReceivedDisplayRuntimeView(message.id);
				if (translation) {
					plugin.refreshTranslationDisplay(translation);
					stream.content.content = translation.content;
				}
				else if (storeView && storeView.translated) {
					plugin.applyReceivedDisplayViewToStream(stream, storeView);
				}
				else if (oldMessages[message.id]) {
					stream.content.content = oldMessages[message.id].content;
					delete oldMessages[message.id];
					messageChanged = true;
				}
				return {translation, storeCommitted, messageChanged, cachedTranslation, canAutoTranslateMessage};
			},
			queueCheckMessageTranslation(plugin, message, channel, context, outcome) {
				if (outcome.translation || outcome.storeCommitted || context.skipAutoQueue || !outcome.canAutoTranslateMessage) return;
				if (context.channelState) context.channelState.boundaryMessageId = plugin.getNewestMessageId(context.channelState.boundaryMessageId, message.id);
				if (context.forceQueue || outcome.messageChanged || context.isNewerThanBoundary || context.historicalLoad) {
					const liveMessage = !context.historicalLoad && (context.isNewerThanBoundary || plugin.isLikelyLiveAutoTranslateMessage(message, context.channelId));
					plugin.queueAutoTranslateMessage(message, channel || {id: context.channelId}, context.originalContentData, {
						historicalLoad: context.historicalLoad && !liveMessage,
						deferHistoricalSnapshotStart: context.deferHistoricalSnapshotStart,
						deferWhileReading: false,
						cachedTranslation: context.historicalLoad && !liveMessage ? outcome.cachedTranslation : null
					});
				}
			},
			checkMessage(plugin, stream, message, channel, options = {}) {
				if (!message || !stream || !stream.content) return;
				plugin.captureSentOriginalMessage(message, channel && channel.id || message.channel_id || null);
				const context = receivedTranslationRuntime.createCheckMessageContext(plugin, message, channel, options);
				receivedTranslationRuntime.captureReceivedDisplaySource(plugin, message, context);
				const outcome = receivedTranslationRuntime.resolveCheckMessageDisplay(plugin, stream, message, context);
				receivedTranslationRuntime.queueCheckMessageTranslation(plugin, message, channel, context, outcome);
			},
			processAutoTranslationQueue(plugin) {
				if (!receivedTranslationRuntime.beginQueueProcessing(plugin)) return;
				if (receivedTranslationRuntime.finishQueueIfEmpty(plugin)) return;
				const nextItem = autoTranslationQueue.shift();
				if (!nextItem || !nextItem.message) return receivedTranslationRuntime.processAutoTranslationQueue(plugin);
				if (nextItem.historicalLoad) {
					plugin.collectHistoricalTranslationMessage(nextItem);
					return receivedTranslationRuntime.processAutoTranslationQueue(plugin);
				}
				if (receivedTranslationRuntime.handleCachedQueueItem(plugin, nextItem)) return receivedTranslationRuntime.processAutoTranslationQueue(plugin);
				if (receivedTranslationRuntime.handleQueueItemGuardFailure(plugin, nextItem)) return receivedTranslationRuntime.processAutoTranslationQueue(plugin);
				// beginQueueProcessing already refused to run inside a provider backoff window,
				// so the burst never holds the live lock across a backoff sleep.
				let burst = null;
				try {burst = receivedTranslationRuntime.collectLiveBatchItems(plugin, nextItem);}
				catch (error) {burst = null;}
				// The burst runs detached; its own finally resumes the queue, and a failure
				// there must never surface as an unhandled rejection.
				if (burst) return receivedTranslationRuntime.translateQueuedBurst(plugin, burst).catch(_ => {});
				return receivedTranslationRuntime.translateQueuedItem(plugin, nextItem);
			}
		};

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
				const storedTranslations = [replyPreviewTranslations[message.id], translatedMessages[message.id]].filter(Boolean);
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
				const storedTranslation = translatedMessages[message.id] || replyPreviewTranslations[message.id];
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
				delete suppressedAutoTranslations[message.id];
				oldMessages[message.id] = new BDFDB.DiscordObjects.Message(message);
				oldMessages[message.id].originalContentData = originalContentData || plugin.extractOriginalContentData(message);
				translatedMessages[message.id] = storedTranslation;
				return storedTranslation;
			},
			clearDisplayedTranslationState(_plugin, messageId, options = {}) {
				if (!messageId) return;
				const config = Object.assign({
					clearReplyPreview: false,
					preserveSuppressed: false
				}, options);
				delete translatedMessages[messageId];
				// oldMessages[messageId] intentionally survives this clear: a rendered message
				// whose props still carry translated text needs the clone on its next render
				// to restore the original; the render path deletes the clone after consuming it.
				if (!config.preserveSuppressed) delete suppressedAutoTranslations[messageId];
				if (config.clearReplyPreview) {
					delete replyPreviewTranslations[messageId];
					delete queuedReplyPreviewTranslations[messageId];
				}
			},
			getStoredTranslationChannelId(_plugin, messageId, fallbackChannelId = null, translation = null) {
				if (fallbackChannelId) return fallbackChannelId;
				if (translation && translation.channelId) return translation.channelId;
				const displayedTranslation = translatedMessages[messageId];
				if (displayedTranslation && displayedTranslation.channelId) return displayedTranslation.channelId;
				const replyPreviewTranslation = replyPreviewTranslations[messageId];
				if (replyPreviewTranslation && replyPreviewTranslation.channelId) return replyPreviewTranslation.channelId;
				return oldMessages[messageId] && oldMessages[messageId].channel_id || null;
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
				let translation = translatedMessages[message.id];
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
				translatedMessages[message.id] = translation;
				return translation;
			},
			getActiveReplyPreviewTranslation(plugin, message, channelId) {
				if (!message || !message.id) return null;
				const translation = plugin.getReplyPreviewTranslation(message, channelId);
				if (!translation) return null;
				if (!translationDisplayLogic.shouldDisplayStoredTranslation(plugin, translation, channelId)) {
					delete replyPreviewTranslations[message.id];
					delete queuedReplyPreviewTranslations[message.id];
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
				const storedMessageTranslation = translatedMessages[stableReferencedMessage.id];
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
				if (plugin.getReceivedAutoTranslateScope() != "loaded_messages" || !plugin.isTranslationEnabled(channelId) || plugin.isOwnMessage(message) || suppressedAutoTranslations[message.id] || queuedAutoTranslations[message.id]) return null;
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
				if (!translation && oldMessages[message.id]) {
					message = e.instance.props.message = new BDFDB.DiscordObjects.Message(oldMessages[message.id]);
					delete oldMessages[message.id];
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
				const translationPlace = plugin.isOwnMessage(message) ? messageTypes.SENT : messageTypes.RECEIVED;
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

		const languagePolicy = {
			getConcreteConfiguredLanguages(plugin, settingKey) {
				const sourceLanguages = plugin.settings && plugin.settings.filters && plugin.settings.filters[settingKey];
				const configuredLanguages = BDFDB.ArrayUtils.is(sourceLanguages) ? sourceLanguages : [];
				return [...new Set(configuredLanguages.filter(languageId => {
					const language = languages[languageId];
					return language && !language.auto && !language.special;
				}))];
			},
			normalizeLanguageId(_plugin, languageId) {
				return (languageId || "").toLowerCase();
			},
			matchesConfiguredSourceLanguage(plugin, languageId, sourceLanguages = null) {
				if (!languageId) return false;
				const normalizedLanguageId = languagePolicy.normalizeLanguageId(plugin, languageId);
				const resolvedSourceLanguages = sourceLanguages || plugin.getAutoTranslateSourceLanguages();
				const normalizedSourceLanguages = resolvedSourceLanguages.map(sourceLanguage => languagePolicy.normalizeLanguageId(plugin, sourceLanguage));
				return normalizedSourceLanguages.some(sourceLanguage => sourceLanguage == normalizedLanguageId || sourceLanguage.startsWith(`${normalizedLanguageId}-`) || normalizedLanguageId.startsWith(`${sourceLanguage}-`));
			}
		};

		const loadedAutoTranslatePolicy = {
			getFilterSettings(plugin) {
				return plugin.settings && plugin.settings.filters || {};
			},
			getReceivedAutoTranslateScope(plugin) {
				const scope = loadedAutoTranslatePolicy.getFilterSettings(plugin).receivedAutoTranslateScope;
				return scope == "loaded_messages" ? "loaded_messages" : "new_only";
			},
			getReceivedAutoTranslateLoadedRangeMode(_plugin) {
				return LOADED_AUTO_TRANSLATE_RANGE_MODES.COUNT;
			},
			getReceivedAutoTranslateLoadedTimeWindow(plugin) {
				const value = loadedAutoTranslatePolicy.getFilterSettings(plugin).receivedAutoTranslateLoadedTimeWindow;
				return ["15m", "1h", "6h", "24h", "all"].includes(value) ? value : "1h";
			},
			getReceivedAutoTranslateLoadedLimit(plugin) {
				return plugin.normalizeLoadedAutoTranslateLimit(loadedAutoTranslatePolicy.getFilterSettings(plugin).receivedAutoTranslateLoadedLimit);
			},
			shouldPauseLoadedAutoTranslateWhileScrolling(plugin) {
				return loadedAutoTranslatePolicy.getFilterSettings(plugin).pauseLoadedAutoTranslateWhileScrolling !== false;
			},
			shouldContinueLoadedAutoTranslateOnScroll(plugin) {
				return loadedAutoTranslatePolicy.getFilterSettings(plugin).continueLoadedAutoTranslateOnScroll !== false;
			},
			getReceivedAutoTranslateLoadedTimeWindowMs(plugin) {
				const window = loadedAutoTranslatePolicy.getReceivedAutoTranslateLoadedTimeWindow(plugin);
				if (window == "15m") return 15 * 60 * 1000;
				if (window == "1h") return 60 * 60 * 1000;
				if (window == "6h") return 6 * 60 * 60 * 1000;
				if (window == "24h") return 24 * 60 * 60 * 1000;
				return 0;
			}
		};

		const receivedSettingsPolicy = {
			getFilterSettings(plugin) {
				return plugin.settings && plugin.settings.filters || {};
			},
			getReceivedAutoTranslateSourceLanguages(plugin) {
				return languagePolicy.getConcreteConfiguredLanguages(plugin, "receivedAutoTranslateSourceLanguages");
			},
			getMinimumAutoTranslateLength(_plugin) {
				// Do not skip short chat text. Even one-character or two-character interjections can carry meaning.
				return 0;
			},
			getAutoTranslateMinimumLengthForAnalysis(plugin, analysis = null) {
				return receivedSettingsPolicy.getMinimumAutoTranslateLength(plugin);
			},
			getTranslationSimilarityThreshold(plugin) {
				const value = receivedSettingsPolicy.getFilterSettings(plugin).translationSimilarityThreshold;
				return Math.max(0.5, Math.min(0.99, parseFloat(value) || 0.9));
			},
			shouldTreatLanguageVariantsAsSame(plugin) {
				return receivedSettingsPolicy.getFilterSettings(plugin).treatLanguageVariantsAsSame !== false;
			},
			shouldSkipMixedReceivedMessages(_plugin) {
				return false;
			},
			shouldSkipSameLanguageReceivedMessages(plugin) {
				return receivedSettingsPolicy.getFilterSettings(plugin).skipSameLanguageReceivedMessages !== false;
			},
			useLocalLanguagePrecheck(plugin) {
				return receivedSettingsPolicy.getFilterSettings(plugin).useLocalLanguagePrecheck !== false;
			},
			shouldDropSimilarTranslations(plugin) {
				return receivedSettingsPolicy.getFilterSettings(plugin).dropSimilarTranslations !== false;
			}
		};

		const aiDecisionPolicy = {
			getAutoTranslateDecisionMode(plugin) {
				const mode = receivedSettingsPolicy.getFilterSettings(plugin).autoTranslateDecisionMode;
				return mode == "ai" ? "ai" : "basic";
			},
			supportsAiAutoTranslateDecisionEngine(_plugin, engineKey) {
				return ["deepseek", "openai", "gemini", "oaicompat"].includes(engineKey);
			},
			isAiAutoTranslateDecisionAvailable(plugin, channelId = null) {
				const engineKeys = channelId ? [
					plugin.getEffectivePrimaryEngine(channelId),
					plugin.getEffectiveBackupEngine(channelId)
				] : [
					plugin.getGlobalPrimaryEngine(),
					plugin.getEffectiveBackupEngine(),
					...Object.values(channelPrimaryEngineOverrides)
				];
				return [...new Set(engineKeys)].some(engineKey => aiDecisionPolicy.supportsAiAutoTranslateDecisionEngine(plugin, engineKey) && plugin.isEngineConfiguredForRuntime(engineKey));
			},
			shouldUseAiAutoTranslateDecision(plugin, channelId = null) {
				return aiDecisionPolicy.getAutoTranslateDecisionMode(plugin) == "ai" && aiDecisionPolicy.isAiAutoTranslateDecisionAvailable(plugin, channelId);
			}
		};

		const sentTranslationPolicy = {
			shouldSkipSentTranslationForSameTarget(plugin, text, channelId, forcedOutputLanguage = null, callback) {
				const targetLanguageId = forcedOutputLanguage || plugin.getLanguageChoice(languageTypes.OUTPUT, messageTypes.SENT, channelId);
				const targetLanguage = targetLanguageId && languages[targetLanguageId];
				if (!targetLanguageId || targetLanguageId == "auto" || targetLanguage && targetLanguage.special) return callback(false, null);
				const configuredInputLanguage = plugin.getLanguageChoice(languageTypes.INPUT, messageTypes.SENT, channelId);
				if (configuredInputLanguage && configuredInputLanguage != "auto") return callback(plugin.isSameLanguageOrVariant(configuredInputLanguage, targetLanguageId), configuredInputLanguage);
				const analysis = plugin.analyzeTextForAutoTranslate(text, targetLanguageId);
				if (plugin.isMostlyTargetLanguageMessage(analysis, targetLanguageId)) return callback(true, targetLanguageId);
				plugin.detectLanguage(text, detectedLanguage => callback(!!detectedLanguage && plugin.isSameLanguageOrVariant(detectedLanguage, targetLanguageId), detectedLanguage));
			},
			shouldAutoTranslateSentMessage(plugin, text, channelId, callback, forcedOutputLanguage = null) {
				plugin.shouldSkipSentTranslationForSameTarget(text, channelId, forcedOutputLanguage, (sameLanguage, detectedLanguage) => {
					if (sameLanguage) return callback(false);
					const sourceLanguages = plugin.getAutoTranslateSourceLanguages();
					if (!sourceLanguages.length) return callback(true);
					const configuredInputLanguage = plugin.getLanguageChoice(languageTypes.INPUT, messageTypes.SENT, channelId);
					if (configuredInputLanguage && configuredInputLanguage != "auto") return callback(plugin.matchesConfiguredSourceLanguage(configuredInputLanguage, sourceLanguages));
					if (detectedLanguage) return callback(plugin.matchesConfiguredSourceLanguage(detectedLanguage, sourceLanguages));
					plugin.detectLanguage(text, detectedLanguageId => callback(plugin.matchesConfiguredSourceLanguage(detectedLanguageId, sourceLanguages)));
				});
			},
			shouldSendOriginalInsteadOfSentTranslation(plugin, originalText, translation, input, output) {
				if (!translation) return true;
				if (input && output && input.id && output.id && plugin.isSameLanguageOrVariant(input.id, output.id)) return true;
				return plugin.getTextSimilarityScore(originalText, translation) >= Math.max(0.94, plugin.getTranslationSimilarityThreshold());
			},
			buildSentTranslationMessageValue(plugin, originalText, translation, input, output) {
				if (plugin.shouldSendOriginalInsteadOfSentTranslation(originalText, translation, input, output)) return originalText;
				return plugin.settings.general.sendOriginalMessage ? (translation + plugin.formatOriginalTextForMessage(originalText)) : translation;
			}
		};

		const sentAutomaticTranslationRuntime = {
			create(plugin, channelId, originalText, messageId = null) {
				if (!channelId) return null;
				const request = {
					id: ++sentAutomaticTranslationRequestSequence,
					generation: sentAutomaticTranslationRuntimeGeneration,
					channelId,
					messageId: messageId ? String(messageId) : null,
					originalText: String(originalText || ""),
					completed: false
				};
				sentAutomaticTranslationRequests[request.id] = request;
				return request;
			},
			isCurrent(plugin, request) {
				return !!(request && !request.completed && pluginRuntimeActive && request.generation == sentAutomaticTranslationRuntimeGeneration && sentAutomaticTranslationRequests[request.id] === request && plugin.isTranslationEnabled(request.channelId));
			},
			finish(_plugin, request) {
				if (!request || request.completed) return false;
				request.completed = true;
				if (sentAutomaticTranslationRequests[request.id] === request) delete sentAutomaticTranslationRequests[request.id];
				return true;
			},
			complete(plugin, request, translatedText, submit) {
				if (!request || request.completed || typeof submit != "function") return Promise.resolve(false);
				const isCurrent = sentAutomaticTranslationRuntime.isCurrent(plugin, request);
				const nextText = isCurrent ? translatedText : request.originalText;
				sentAutomaticTranslationRuntime.finish(plugin, request);
				return Promise.resolve(submit(nextText)).then(_ => {
					if (isCurrent) {
						if (request.messageId) sentAutomaticTranslationRuntime.rememberMessage(plugin, request.messageId, request.channelId, request.originalText, nextText);
						else sentAutomaticTranslationRuntime.trackPending(plugin, request.channelId, request.originalText, nextText);
					}
					return true;
				});
			},
			prune(_plugin) {
				const cutoff = Date.now() - SENT_ORIGINAL_MATCH_TTL;
				pendingSentOriginalMessages = pendingSentOriginalMessages.filter(entry => entry && entry.createdAt >= cutoff);
			},
			trackPending(plugin, channelId, originalText, submittedText) {
				originalText = String(originalText || "");
				submittedText = String(submittedText || "");
				if (!channelId || !originalText || !submittedText || originalText == submittedText) return false;
				sentAutomaticTranslationRuntime.prune(plugin);
				pendingSentOriginalMessages.push({channelId, originalText, submittedText, createdAt: Date.now()});
				if (pendingSentOriginalMessages.length > MAX_SENT_ORIGINAL_ENTRIES) pendingSentOriginalMessages.splice(0, pendingSentOriginalMessages.length - MAX_SENT_ORIGINAL_ENTRIES);
				return true;
			},
			rememberMessage(plugin, messageId, channelId, originalText, submittedText) {
				if (!messageId) return false;
				originalText = String(originalText || "");
				submittedText = String(submittedText || "");
				if (!originalText || !submittedText || originalText == submittedText) {
					delete sentOriginalMessages[messageId];
					return false;
				}
				sentAutomaticTranslationRuntime.prune(plugin);
				sentOriginalMessages[messageId] = {channelId, originalText, submittedText, capturedAt: Date.now()};
				const messageIds = Object.keys(sentOriginalMessages);
				if (messageIds.length > MAX_SENT_ORIGINAL_ENTRIES) messageIds.sort((left, right) => sentOriginalMessages[left].capturedAt - sentOriginalMessages[right].capturedAt).slice(0, messageIds.length - MAX_SENT_ORIGINAL_ENTRIES).forEach(id => delete sentOriginalMessages[id]);
				return true;
			},
			captureEcho(plugin, message, channelId = null) {
				if (!message || !message.id || !plugin.isOwnMessage(message)) return false;
				channelId = channelId || message.channel_id || null;
				const submittedText = String(message.content || "");
				if (!channelId || !submittedText) return false;
				sentAutomaticTranslationRuntime.prune(plugin);
				const pendingIndex = pendingSentOriginalMessages.findIndex(entry => entry.channelId == channelId && entry.submittedText == submittedText);
				if (pendingIndex < 0) return false;
				const pending = pendingSentOriginalMessages.splice(pendingIndex, 1)[0];
				return sentAutomaticTranslationRuntime.rememberMessage(plugin, String(message.id), channelId, pending.originalText, submittedText);
			},
			getEditableText(plugin, messageId, currentText) {
				sentAutomaticTranslationRuntime.prune(plugin);
				const stored = messageId && sentOriginalMessages[messageId];
				if (!stored) return currentText;
				if (String(currentText || "") != stored.submittedText) {
					delete sentOriginalMessages[messageId];
					return currentText;
				}
				return stored.originalText;
			},
			invalidate(_plugin, channelId = null) {
				if (!channelId) sentAutomaticTranslationRuntimeGeneration++;
				for (const requestId of Object.keys(sentAutomaticTranslationRequests)) {
					const request = sentAutomaticTranslationRequests[requestId];
					if (channelId && request.channelId != channelId) continue;
					delete sentAutomaticTranslationRequests[requestId];
				}
			}
		};

		const languageDetectionRuntime = {
			getStrategy(plugin) {
				const strategy = plugin.settings && plugin.settings.filters && plugin.settings.filters.languageDetectionStrategy;
				return ["local_first", "google_free", "local_only"].includes(strategy) ? strategy : "local_first";
			},
			getDetectableLanguageText(plugin, text) {
				let [newText, , translate] = plugin.removeExceptions((text || "").trim(), messageTypes.SENT);
				return translate && newText ? newText : "";
			},
			parseDetectedLanguageResponse(_plugin, body) {
				try {return (JSON.parse(body) || {}).src || null;}
				catch (err) {return null;}
			},
			detectLanguage(plugin, text, callback) {
				const detectableText = languageDetectionRuntime.getDetectableLanguageText(plugin, text);
				if (!detectableText) return callback(null);
				const strategy = languageDetectionRuntime.getStrategy(plugin);
				if (strategy != "google_free") {
					const localDetection = plugin.identifyLatinLanguage(detectableText);
					if (localDetection && localDetection.confident && localDetection.languageId) return callback(localDetection.languageId);
					if (strategy == "local_only") return callback(null);
				}
				BDFDB.LibraryRequires.request("https://translate.googleapis.com/translate_a/single", {
					form: {
						"client": "gtx",
						"dt": "t",
						"dj": "1",
						"source": "input",
						"sl": "auto",
						"tl": "en",
						"q": encodeURIComponent(detectableText)
					}
				}, (error, response, body) => {
					if (!error && body && response.statusCode == 200) return callback(languageDetectionRuntime.parseDetectedLanguageResponse(plugin, body));
					callback(null);
				});
			}
		};

		const languageHeuristicsRuntime = {
			getLatinStopwordTables(_plugin) {
				// Compact stopword tables for common Latin-script languages. Used only to fill the
				// gap that script-family analysis cannot: telling English/French/Spanish/etc. apart.
				return {
					en: "the,and,you,that,this,is,are,was,were,have,has,it,for,not,with,but,they,your,from,been,will,just,like,can,what,there,their",
					es: "que,de,no,es,en,un,una,por,con,se,los,las,su,para,como,mas,pero,le,al,lo,ella,este,eso",
					fr: "le,la,les,de,et,un,une,que,pas,pour,qui,dans,sur,ne,se,au,est,son,il,elle,avec,nous,vous",
					de: "der,die,das,und,ist,nicht,ein,eine,den,von,mit,sich,auf,fur,sie,dem,es,auch,wir,aber,hat",
					pt: "que,de,nao,um,uma,para,com,os,as,se,por,como,mas,mais,eu,voce,sua,seu,ja,esta,isto",
					it: "che,di,non,un,una,per,si,la,il,le,con,come,ma,piu,gli,sono,questo,quella,anche,stato",
					nl: "de,het,een,en,van,is,niet,te,dat,die,in,op,voor,met,zijn,haar,maar,wat,heb,wij,zij",
					pl: "nie,sie,to,na,jest,do,ze,jak,ale,co,dla,moze,tego,tym,byc,lub,oraz,takze,ich,jesli",
					ro: "sa,de,nu,in,ca,pe,un,o,cu,este,la,ai,mai,dar,sunt,pentru,fata,asta,ori,sau,aceasta",
					tr: "ve,bir,bu,icin,ile,ben,sen,degil,ama,daha,cok,var,yok,benim,senin,bana,sana,onlar,gibi,kadar",
					sv: "och,att,det,som,en,den,for,ar,inte,med,har,jag,du,han,hon,ett,kan,sa,men,om,alla",
					da: "og,at,det,som,en,den,er,ikke,med,har,jag,du,han,hun,et,kan,sa,men,om,vi,der",
					no: "og,at,det,som,en,den,er,ikke,med,har,jag,du,han,hun,et,kan,sa,men,om,vi,der",
					cs: "a,se,na,je,to,v,ze,si,pro,ale,jak,tak,ktery,byt,nebo,tento,jejich,coz,vice,ktere",
					hu: "es,egy,nem,hogy,az,is,volt,meg,lehet,csak,de,mint,mar,ott,majd,igen,mert,azzal,ilyen,olyan",
					id: "yang,dan,di,ini,itu,untuk,dengan,tidak,saya,anda,akan,ke,pada,dari,juga,karena,bisa,ada,mereka,sebagai",
					vi: "va,cua,la,mot,cac,trong,khong,co,nay,do,da,duoc,nguoi,cho,voi,den,tu,roi,ra,cung",
					tl: "ang,ng,mga,sa,ay,na,at,ni,si,naman,dahil,hindi,para,kung,ngunit,siya,ako,ikaw,nila,kapag"
				};
			},
			getShortLatinLanguageHintTables(_plugin) {
				return {
					en: "yes,hello,thanks,please",
					es: "hola,gracias",
					fr: "oui,bonjour,merci",
					de: "hallo,danke",
					it: "grazie",
					pt: "obrigado"
				};
			},
			identifyShortLatinLanguageHint(plugin, text) {
				const words = (text || "").toLowerCase().match(/[a-zà-ÿ]+(?:['’][a-zà-ÿ]+)*/g) || [];
				if (words.length != 1) return null;
				if (!plugin._shortLatinLanguageHintIndex) {
					const index = Object.create(null);
					const tables = languageHeuristicsRuntime.getShortLatinLanguageHintTables(plugin);
					for (const languageId in tables) for (const word of tables[languageId].split(",")) index[word] = languageId;
					plugin._shortLatinLanguageHintIndex = index;
				}
				return plugin._shortLatinLanguageHintIndex[words[0]] || null;
			},
			identifyLatinLanguage(plugin, text) {
				if (!plugin._latinStopwordIndex) {
					const tables = languageHeuristicsRuntime.getLatinStopwordTables(plugin);
					const index = Object.create(null);
					for (const lang in tables) {
						for (const word of tables[lang].split(",")) {
							if (!index[word]) index[word] = [];
							index[word].push(lang);
						}
					}
					plugin._latinStopwordIndex = index;
				}
				const words = (text || "").toLowerCase().match(/[a-zà-ÿ]+(?:['’][a-zà-ÿ]+)*/g) || [];
				if (words.length < 5) return {languageId: null, confident: false, tokenCount: words.length};
				const scores = Object.create(null);
				const seen = Object.create(null);
				for (const word of words) {
					const langs = plugin._latinStopwordIndex[word];
					if (!langs) continue;
					for (const lang of langs) {
						const key = lang + "|" + word;
						if (seen[key]) continue;
						seen[key] = 1;
						scores[lang] = (scores[lang] || 0) + 1;
					}
				}
				let best = null, bestScore = 0, runnerUp = 0;
				for (const lang in scores) {
					const score = scores[lang];
					if (score > bestScore) { runnerUp = bestScore; bestScore = score; best = lang; }
					else if (score > runnerUp) runnerUp = score;
				}
				// Conservative: only trust the call when one language clearly dominates.
				// Uncertain cases fall through to translation so we never silently drop a real foreign message.
				const confident = !!(best && bestScore >= 3 && bestScore >= 2 * runnerUp);
				return {languageId: best, score: bestScore, runnerUp, tokenCount: words.length, confident};
			},
			detectMessageLanguageLocal(plugin, text, analysis, targetLanguageId) {
				if (!analysis || !analysis.totalLetters) return {languageId: null, confident: false};
				// Non-Latin scripts are already handled by script-family checks upstream; the local
				// identifier only fills the Latin-vs-Latin gap where those checks bail out.
				const targetFamilies = analysis.targetFamilies || plugin.getLanguageScriptFamilies(targetLanguageId);
				if (!targetFamilies.length || targetFamilies[0] != "latin") return {languageId: null, confident: false};
				if (analysis.dominantFamily != "latin") return {languageId: null, confident: false};
				// Run on the raw masked text, not analysis.cleanedText: the sanitizer strips 1-3
				// letter tokens, which are exactly the stopwords we score on.
				return languageHeuristicsRuntime.identifyLatinLanguage(plugin, text);
			},
			isClearlyForeignLanguageMessage(plugin, text, targetLanguageId) {
				if (!text || !targetLanguageId || targetLanguageId == "auto") return false;
				const targetLanguage = languages[targetLanguageId];
				if (targetLanguage && targetLanguage.special) return false;
				const targetFamilies = plugin.getLanguageScriptFamilies(targetLanguageId);
				if (!targetFamilies.length) return false;
				const targetFamily = targetFamilies[0];
				const analysis = plugin.analyzeTextForAutoTranslate(text, targetLanguageId);
				if (!analysis || !analysis.totalLetters) return false;
				const dominant = analysis.dominantFamily;
				if (!dominant) return false;
				// Different script from the target with enough non-target letters = clearly foreign.
				if (dominant != targetFamily && analysis.nonTargetLetterCount >= 6) return true;
				// Same script (latin-vs-latin): confirm a different language via the stopword identifier.
				if (targetFamily == "latin" && dominant == "latin") {
					const detected = languageHeuristicsRuntime.identifyLatinLanguage(plugin, text);
					if (detected.confident && detected.languageId && !plugin.isSameLanguageOrVariant(detected.languageId, targetLanguageId)) return true;
				}
				return false;
			},
			isHanTargetMessageWithLatinTerms(plugin, analysis, targetLanguageId) {
				if (!analysis || !analysis.totalLetters) return false;
				const targetFamilies = analysis.targetFamilies || plugin.getLanguageScriptFamilies(targetLanguageId);
				if (!targetFamilies.includes("han")) return false;
				if (analysis.targetLetterCount < 2 || analysis.hanRunCount < 1) return false;
				const latinCount = analysis.counts && analysis.counts.latin || 0;
				const nonTargetNonLatinLetterCount = Math.max(0, analysis.nonTargetLetterCount - latinCount);
				if (nonTargetNonLatinLetterCount > 0) return false;
				if (!latinCount) return true;
				if (analysis.latinWordCount > 3) return false;
				return analysis.targetShare >= 0.18;
			},
			isMostlyTargetLanguageMessage(plugin, analysis, targetLanguageId) {
				if (!analysis || !analysis.totalLetters) return false;
				const targetFamilies = analysis.targetFamilies || plugin.getLanguageScriptFamilies(targetLanguageId);
				// Latin-script languages share the same script, so local script heuristics cannot safely
				// tell English/French/Spanish apart. Let the translator or AI decision handle those.
				if (!targetFamilies.length || targetFamilies[0] == "latin") return false;
				if (languageHeuristicsRuntime.isHanTargetMessageWithLatinTerms(plugin, analysis, targetLanguageId)) return true;
				if (analysis.targetLetterCount >= 6 && analysis.targetShare >= 0.55) return true;
				if (analysis.targetLetterCount >= 12 && analysis.targetShare >= 0.45 && analysis.nonTargetLetterCount <= Math.max(8, analysis.targetLetterCount * 0.8)) return true;
				return !!analysis.strongTargetScriptMatch;
			},
			isClearlyTargetLanguageMessage(plugin, analysis, targetLanguageId) {
				if (!analysis || !analysis.totalLetters) return false;
				const targetFamilies = analysis.targetFamilies || plugin.getLanguageScriptFamilies(targetLanguageId);
				if (!targetFamilies.length || targetFamilies[0] == "latin") return false;
				// Hard pre-check before sending received messages to a translator. This is intentionally
				// stricter than the post-check but stronger than the old heuristic for CJK/Cyrillic/etc.
				// It prevents target-language chat from being sent to AI and rewritten in the same language.
				if (languageHeuristicsRuntime.isHanTargetMessageWithLatinTerms(plugin, analysis, targetLanguageId)) return true;
				if (analysis.targetLetterCount >= 3 && analysis.targetShare >= 0.82) return true;
				if (analysis.targetLetterCount >= 6 && analysis.targetShare >= 0.68 && analysis.nonTargetLetterCount <= Math.max(3, Math.floor(analysis.targetLetterCount * 0.25))) return true;
				if (analysis.targetLetterCount >= 12 && analysis.targetShare >= 0.6 && analysis.nonTargetLetterCount <= Math.max(6, Math.floor(analysis.targetLetterCount * 0.35))) return true;
				return false;
			},
			isTranslationLikelyInTargetLanguage(plugin, text, targetLanguageId) {
				targetLanguageId = plugin.normalizeLanguageId(targetLanguageId);
				if (!text || !targetLanguageId || targetLanguageId == "auto") return true;
				const targetLanguage = languages[targetLanguageId];
				if (targetLanguage && targetLanguage.special) return true;
				const targetFamilies = plugin.getLanguageScriptFamilies(targetLanguageId);
				if (!targetFamilies.length) return true;
				const analysis = plugin.analyzeTextForAutoTranslate(text, targetLanguageId);
				if (!analysis || !analysis.totalLetters) return true;
				const shortLatinLanguageHint = analysis.dominantFamily == "latin" ? languageHeuristicsRuntime.identifyShortLatinLanguageHint(plugin, text) : null;
				if (shortLatinLanguageHint) {
					if (targetFamilies[0] != "latin") return false;
					return plugin.isSameLanguageOrVariant(shortLatinLanguageHint, targetLanguageId);
				}
				if (analysis.totalLetters < 4) return true;
				if (targetFamilies[0] == "latin" && analysis.dominantFamily == "latin") {
					const detected = languageHeuristicsRuntime.identifyLatinLanguage(plugin, text);
					if (detected.confident && detected.languageId) return plugin.isSameLanguageOrVariant(detected.languageId, targetLanguageId);
				}
				if (analysis.targetLetterCount == 0 && analysis.nonTargetLetterCount >= 4) return false;
				if (analysis.targetLetterCount >= 2 && analysis.targetShare >= 0.2) return true;
				return analysis.targetLetterCount >= 4 || analysis.targetShare >= 0.35;
			}
		};

		const textSimilarityRuntime = {
			normalizeComparisonText(_plugin, text) {
				text = (text || "").toLowerCase();
				if (typeof text.normalize == "function") text = text.normalize("NFKC");
				return text
					.replace(/https?:\/\/\S+/gi, "")
					.replace(/[`~!@#$%^&*()\-_=+\[\]{}\\|;:'",.<>/?，。！？；：“”‘’（）【】《》、…·]/g, "")
					.replace(/\s+/g, "");
			},
			getTextSimilarityScore(plugin, textA, textB) {
				const normalizedA = textSimilarityRuntime.normalizeComparisonText(plugin, textA);
				const normalizedB = textSimilarityRuntime.normalizeComparisonText(plugin, textB);
				if (!normalizedA || !normalizedB) return 0;
				if (normalizedA == normalizedB) return 1;
				if (normalizedA.length < 2 || normalizedB.length < 2) return normalizedA == normalizedB ? 1 : 0;
				const createBigrams = value => {
					const bigrams = new Map();
					for (let index = 0; index < value.length - 1; index++) {
						const bigram = value.slice(index, index + 2);
						bigrams.set(bigram, (bigrams.get(bigram) || 0) + 1);
					}
					return bigrams;
				};
				const bigramsA = createBigrams(normalizedA);
				const bigramsB = createBigrams(normalizedB);
				let overlap = 0;
				for (const [bigram, count] of bigramsA.entries()) if (bigramsB.has(bigram)) overlap += Math.min(count, bigramsB.get(bigram));
				return (2 * overlap) / (Math.max(1, normalizedA.length - 1) + Math.max(1, normalizedB.length - 1));
			}
		};

		const foreignLanguageDecisionRuntime = {
			isDetectedLanguageForeign(plugin, detectedLanguageId, targetLanguageId) {
				return !!detectedLanguageId && !plugin.isSameLanguageOrVariant(detectedLanguageId, targetLanguageId);
			},
			isReceivedMessageForeignAsync(plugin, text, targetLanguageId, callback) {
				if (plugin.isClearlyForeignLanguageMessage(text, targetLanguageId)) return callback(true);
				if (!text || !targetLanguageId || targetLanguageId == "auto") return callback(false);
				plugin.detectLanguage(text, detectedLanguageId => callback(foreignLanguageDecisionRuntime.isDetectedLanguageForeign(plugin, detectedLanguageId, targetLanguageId)));
			}
		};

		const receivedMessageFilterRuntime = {
			isTranslationResultTooSimilar(plugin, translation) {
				if (!translation) return false;
				const normalizedTranslation = plugin.normalizeStoredTranslationData(translation);
				const originalContent = (normalizedTranslation.originalContent || "").trim();
				const translatedContent = (normalizedTranslation.translatedContent || normalizedTranslation.content || "").trim();
				if (!originalContent || !translatedContent) return false;
				const normalizedOriginal = plugin.normalizeComparisonText(originalContent);
				const normalizedTranslated = plugin.normalizeComparisonText(translatedContent);
				if (!normalizedOriginal || !normalizedTranslated) return false;
				if (normalizedOriginal == normalizedTranslated) return true;
				return plugin.getTextSimilarityScore(originalContent, translatedContent) >= Math.max(0.92, plugin.getTranslationSimilarityThreshold());
			},
			getAutoTranslatedResultRejectReason(plugin, translation, channelId) {
				if (!translation || !translation.translatedContent) return "local_guard";
				if (receivedMessageFilterRuntime.isTranslationResultTooSimilar(plugin, translation)) return "too_similar";
				const detectedLanguageId = translation.input && translation.input.id;
				const targetLanguageId = translation.output && translation.output.id || plugin.getLanguageChoice(languageTypes.OUTPUT, messageTypes.RECEIVED, channelId);
				if (plugin.shouldSkipSameLanguageReceivedMessages() && detectedLanguageId && plugin.isSameLanguageOrVariant(detectedLanguageId, targetLanguageId)) return "same_language";
				const sourceLanguages = plugin.getReceivedAutoTranslateSourceLanguages();
				if (sourceLanguages.length && detectedLanguageId && !plugin.matchesConfiguredSourceLanguage(detectedLanguageId, sourceLanguages)) return "source_filter";
				if (plugin.shouldDropSimilarTranslations() && plugin.getTextSimilarityScore(translation.originalContent, translation.translatedContent) >= plugin.getTranslationSimilarityThreshold()) return "too_similar";
				return null;
			},
			shouldKeepAutoTranslatedResult(plugin, translation, channelId) {
				return !receivedMessageFilterRuntime.getAutoTranslatedResultRejectReason(plugin, translation, channelId);
			},
			buildAutoTranslateAnalysisText(plugin, originalContentData) {
				const rawText = plugin.buildTranslationRequestText(originalContentData);
				const [maskedText, , hasUnprotectedContent] = plugin.removeExceptions(rawText, messageTypes.RECEIVED);
				return {text: maskedText || "", hasUnprotectedContent};
			},
			isLinkOnlyReceivedContent(plugin, originalContentData) {
				if (!originalContentData) return false;
				const content = (originalContentData.content || "").trim();
				if (!content) return false;
				const [maskedContent, , hasUnprotectedContent] = plugin.removeExceptions(content, messageTypes.RECEIVED);
				if (hasUnprotectedContent) return false;
				const counts = plugin.countScriptFamilies(maskedContent);
				return !!maskedContent && Object.keys(counts).every(family => !counts[family]);
			},
			buildReceivedAutoTranslateAnalysis(plugin, originalContentData, channelId) {
				if (!originalContentData || !channelId) return null;
				const targetLanguageId = plugin.getLanguageChoice(languageTypes.OUTPUT, messageTypes.RECEIVED, channelId);
				const analysisSource = receivedMessageFilterRuntime.buildAutoTranslateAnalysisText(plugin, originalContentData);
				const analysis = plugin.analyzeTextForAutoTranslate(analysisSource.text, targetLanguageId);
				return {targetLanguageId, analysisSource, analysis};
			},
			getReceivedAutoTranslateSkipReason(plugin, originalContentData, channelId) {
				if (receivedMessageFilterRuntime.isLinkOnlyReceivedContent(plugin, originalContentData)) return "link_only";
				if (!plugin.hasTranslatableMessageContent(originalContentData)) return "symbol_only";
				const receivedAnalysis = receivedMessageFilterRuntime.buildReceivedAutoTranslateAnalysis(plugin, originalContentData, channelId);
				if (!receivedAnalysis || !receivedAnalysis.analysisSource.hasUnprotectedContent) return "symbol_only";
				const {targetLanguageId, analysis} = receivedAnalysis;
				if (!analysis.totalLetters) return "symbol_only";
				if (plugin.isClearlyTargetLanguageMessage(analysis, targetLanguageId)) return "same_language";
				if (plugin.shouldSkipSameLanguageReceivedMessages() && plugin.isMostlyTargetLanguageMessage(analysis, targetLanguageId)) return "same_language";
				return null;
			},
			shouldSkipReceivedTranslationBeforeRequest(plugin, originalContentData, channelId) {
				if (!originalContentData || !channelId) return false;
				if (receivedMessageFilterRuntime.isLinkOnlyReceivedContent(plugin, originalContentData)) return true;
				const receivedAnalysis = receivedMessageFilterRuntime.buildReceivedAutoTranslateAnalysis(plugin, originalContentData, channelId);
				if (!receivedAnalysis) return false;
				const {targetLanguageId, analysisSource, analysis} = receivedAnalysis;
				const targetLanguage = languages[targetLanguageId];
				if (!targetLanguageId || targetLanguageId == "auto" || targetLanguage && targetLanguage.special) return false;
				if (!analysisSource || !analysisSource.hasUnprotectedContent) return false;
				return plugin.isClearlyTargetLanguageMessage(analysis, targetLanguageId);
			},
			shouldSkipByLocalLanguagePrecheck(plugin, text, analysis, targetLanguageId) {
				if (!plugin.useLocalLanguagePrecheck()) return false;
				// Latin-vs-Latin same-language and source-filter checks that script-family
				// analysis cannot resolve locally, so we avoid a wasteful AI request. Only
				// acts on high-confidence detections; uncertain text still goes to translation.
				const localDetection = plugin.detectMessageLanguageLocal(text, analysis, targetLanguageId);
				if (!localDetection.confident || !localDetection.languageId) return false;
				if (plugin.isSameLanguageOrVariant(localDetection.languageId, targetLanguageId)) return true;
				const sourceLanguages = plugin.getReceivedAutoTranslateSourceLanguages();
				return sourceLanguages.length && !plugin.matchesConfiguredSourceLanguage(localDetection.languageId, sourceLanguages);
			},
			shouldAutoTranslateReceivedMessage(plugin, message, channel, originalContentData = null, ignoreQueued = false) {
				if (!channel || !channel.id || !message || !message.id) return false;
				if (!plugin.isTranslationEnabled(channel.id) || plugin.isOwnMessage(message)) return false;
				if (suppressedAutoTranslations[message.id]) return false;
				if (plugin.isMessageDisplayTranslated(message, channel.id) || !ignoreQueued && queuedAutoTranslations[message.id]) return false;
				const sourceData = originalContentData || plugin.extractOriginalContentData(message);
				if (plugin.getCachedReceivedSkipDecision(message, channel.id, sourceData)) return false;
				if (receivedMessageFilterRuntime.isLinkOnlyReceivedContent(plugin, sourceData)) return false;
				if (!plugin.hasTranslatableMessageContent(sourceData)) return false;
				const receivedAnalysis = receivedMessageFilterRuntime.buildReceivedAutoTranslateAnalysis(plugin, sourceData, channel.id);
				if (!receivedAnalysis || !receivedAnalysis.analysisSource.hasUnprotectedContent) return false;
				const {analysisSource, targetLanguageId, analysis} = receivedAnalysis;
				if (!analysis.totalLetters) return false;
				if (analysis.totalLetters < plugin.getAutoTranslateMinimumLengthForAnalysis(analysis)) return false;
				if (plugin.isClearlyTargetLanguageMessage(analysis, targetLanguageId)) return false;
				if (plugin.shouldSkipSameLanguageReceivedMessages() && plugin.isMostlyTargetLanguageMessage(analysis, targetLanguageId)) return false;
				if (receivedMessageFilterRuntime.shouldSkipByLocalLanguagePrecheck(plugin, analysisSource.text, analysis, targetLanguageId)) return false;
				return true;
			}
		};

		return class Translator extends Plugin {
			getVersion () {
				return normalizeSemverVersion(this.version);
			}

			createHistoricalTranslationJob (config = {}) {
				return new HistoricalTranslationJob(config);
			}

			onLoad () {
				_this = this;
				this.defaults = {
					general: {
						interfaceLanguage:		{value: "system", 	popout: false},
						sendOriginalMessage:		{value: false, 	popout: false},
						showOriginalMessage:		{value: false, 	popout: false},
						showOriginalDirectly:		{value: true, 	popout: false},
						showOriginalInReplyPreview:	{value: false, 	popout: false},
						useSpoilerInSentOriginal:	{value: false, 	popout: false},
						useSpoilerInReceivedOriginal:	{value: false, 	popout: false},
						highlightTranslatedMessages:	{value: true, 	popout: false},
						showTranslationLabel:		{value: true, 	popout: false},
						translatedTextColor:		{value: "#7cc7ff", popout: false},
						protectQuotedText:		{value: true, 	popout: false,	description: "Automatically protect and highlight wrapped content"},
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
						languageDetectionStrategy: {value: "local_first"},
						skipMixedReceivedMessages:	{value: false},
						skipSameLanguageReceivedMessages: {value: true},
					useLocalLanguagePrecheck:	{value: true},
						treatLanguageVariantsAsSame: {value: true},
						dropSimilarTranslations:	{value: true},
						minimumAutoTranslateLength:	{value: 2},
						translationSimilarityThreshold: {value: 0.9}
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
						backup:				{value: "----"}
					}
				};
				for (let m in messageTypes) this.defaults.choices[messageTypes[m]] = {value: Object.keys(languageTypes).reduce((newObj, l) => (newObj[languageTypes[l]] = defaultLanguages[l], newObj), {})};
				this.modulePatches = {
					before: [
						"ChannelTextAreaContainer",
						"ChannelTextAreaEditor",
						"Embed",
						"MessageReply",
						"Messages"
					],
					after: [
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
					]
				};

				this.css = createTranslatorStyles(BDFDB);
			}
			
			handleEditedMessageSubmit (methodArguments, originalMethod) {
				const args = Array.from(methodArguments || []);
				const channelId = args[0];
				const messageId = args[1];
				const payload = args[2];
				const originalText = typeof payload == "string" ? payload : payload && typeof payload.content == "string" ? payload.content : "";
				const submit = nextText => {
					const nextArgs = args.slice();
					nextArgs[2] = typeof payload == "string" ? nextText : Object.assign({}, payload || {}, {content: nextText});
					return Promise.resolve(originalMethod(...nextArgs));
				};
				this.clearDisplayedTranslationState(messageId, {clearReplyPreview: true});
				delete oldMessages[messageId];
				this.clearCachedTranslation(messageId);
				if (!originalText || !channelId || !this.isTranslationEnabled(channelId)) return submit(originalText);
				const sentRequest = this.createSentAutomaticTranslationRequest(channelId, originalText, messageId);
				return new Promise((resolve, reject) => {
					const finishSubmit = nextText => this.completeSentAutomaticTranslationRequest(sentRequest, nextText, submit).then(resolve, reject);
					this.shouldAutoTranslateSentMessage(originalText, channelId, shouldTranslate => {
						if (!shouldTranslate || !this.isSentAutomaticTranslationRequestCurrent(sentRequest)) return finishSubmit(originalText);
						this.translateText(originalText, messageTypes.SENT, (translation, input, output) => {
							finishSubmit(this.buildSentTranslationMessageValue(originalText, translation, input, output));
						}, null, {channelId});
					});
				});
			}

			onStart () {
				pluginRuntimeActive = true;
				this.resetReceivedDisplayRuntime();
				liveTranslationRuntimeGeneration++;
				liveTranslationRequests = {};
				sentAutomaticTranslationRuntimeGeneration++;
				sentAutomaticTranslationRequests = {};
				pendingSentOriginalMessages = [];
				historicalTranslationRuntimeGeneration++;
				this.attachAutoTranslationInputActivityWatcher();
				BDFDB.PatchUtils.patch(this, BDFDB.LibraryModules.MessageUtils, "startEditMessage", {before: e => {
					if (e.methodArguments[1] && oldMessages[e.methodArguments[1]] && oldMessages[e.methodArguments[1]].content) e.methodArguments[2] = oldMessages[e.methodArguments[1]].content;
					else if (e.methodArguments[1]) e.methodArguments[2] = this.getEditableSentMessageText(e.methodArguments[1], e.methodArguments[2]);
				}});
				BDFDB.PatchUtils.patch(this, BDFDB.LibraryModules.MessageUtils, "editMessage", {instead: e => this.handleEditedMessageSubmit(e.methodArguments, (...args) => e.originalMethod(...args))});
				BDFDB.PatchUtils.patch(this, BDFDB.LibraryModules.MessageToolbarUtils, "useMessageMenu", {after: e => {
					if (e.instance.props.message && e.instance.props.channel) {
						const channelId = e.instance.props.channel && e.instance.props.channel.id || null;
						let translated = this.isMessageDisplayTranslated(e.instance.props.message, channelId);
						let [children, index] = BDFDB.ContextMenuUtils.findItem(e.returnValue, {id: ["copy-text", "pin", "unpin"]});
						if (index == -1) [children, index] = BDFDB.ContextMenuUtils.findItem(e.returnValue, {id: ["edit", "add-reaction", "add-reaction-1", "quote"]});
						children.splice(index + 1, 0, BDFDB.ContextMenuUtils.createItem(BDFDB.LibraryComponents.MenuItems.MenuItem, {
							label: translated ? this.labels.context_messageuntranslateoption : this.labels.context_messagetranslateoption,
							id: BDFDB.ContextMenuUtils.createItemId(this.name, translated ? "untranslate-message" : "translate-message"),
							icon: _ => BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.MenuItems.MenuIcon, {
								icon: translated ? translateIconUntranslate : translateIcon
							}),
							action: _ => this.translateMessage(e.instance.props.message, e.instance.props.channel, {manual: true, independentOfTextAreaSwitch: true, trackBusy: false})
						}));
						this.injectMessageLanguageActions(children, index + 1, e.instance.props.message, e.instance.props.channel);
					}
				}});
				this.forceUpdateAll();
			}
			
			onStop () {
				pluginRuntimeActive = false;
				this.invalidateLiveTranslationRequests();
				this.invalidateSentAutomaticTranslationRequests();
				pendingSentOriginalMessages = [];
				historicalTranslationRuntimeGeneration++;
				channelTitleStore.invalidateInFlight();
				this.cancelHistoricalTranslationJobs(null, "plugin-stopped");
				this.clearChannelTitleTranslations();
				this.detachAutoTranslationInputActivityWatcher();
				this.detachAutoTranslationScrollWatcher();
				this.ensureTranslationCacheStore().cancelPendingSave();
				if (translationRerenderTimer) clearTimeout(translationRerenderTimer);
				if (deferredTextAreaRerenderTimer) clearTimeout(deferredTextAreaRerenderTimer);
				if (autoTranslationQueueRetryTimer) clearTimeout(autoTranslationQueueRetryTimer);
				if (deferredSettingsRerenderTimer) clearTimeout(deferredSettingsRerenderTimer);
				this.ensureMessageViewportStore().clearManualScrollLock();
				deferredSettingsRerenderTimer = null;
				// Restore store-owned automatic records synchronously before legacy cleanup so the
				// final rerender paints originals; onStop must not reload settings via forceUpdateAll.
				this.clearReceivedDisplayFlushQueue();
				this.restoreAllReceivedDisplay({refresh: false});
				this.clearDisplayedTranslations();
				failedHistoricalTranslationSnapshots.clear();
				manualMessageTranslationRequests = {};
				suppressedAutoTranslations = {};
				queuedAutoTranslations = {};
				queuedReplyPreviewTranslations = {};
				autoTranslationEligibleReplyPreviewMessages = {};
				replyPreviewRenderMessageIds = {};
				deferredTranslationRerenderPending = false;
				isTranslating = false;
				isLiveAutoTranslating = false;
				this.clearLoadedAutoTranslationStatus();
				BDFDB.MessageUtils.rerenderAll(true);
			}

			getSettingsPanel (collapseStates = {}) {
				let settingsPanel;
				return settingsPanel = BDFDB.PluginUtils.createSettingsPanel(this, {
					collapseStates: collapseStates,
					children: _ => {
						let settingsItems = [];
						const recommendedEngines = ["microsoft", "googlecloud", "googleapi", "deepseek", "openai", "gemini", "oaicompat"];
						const getSettingsPanelRoot = () => document.querySelector(".translator-settings-panel-root");
						const isScrollableElement = node => {
							if (!node || node == document || node == document.body || node == document.documentElement) return false;
							if (typeof node.scrollTop != "number" || typeof node.scrollHeight != "number" || typeof node.clientHeight != "number") return false;
							if (node.scrollHeight <= node.clientHeight + 1) return false;
							let overflowY = "";
							try {
								const style = window.getComputedStyle(node);
								overflowY = style && style.overflowY || "";
							}
							catch (err) {}
							// Discord/BDFDB scrollers can use generated classes or overlay/hidden overflow, so relying only on auto/scroll misses the real modal scroller.
							return overflowY != "visible" && overflowY != "clip" || node.scrollTop > 0;
						};
						const getSettingsPanelScrollElements = root => {
							const scrollers = [];
							const addScroller = node => {
								if (node && isScrollableElement(node) && !scrollers.includes(node)) scrollers.push(node);
							};
							let current = root;
							while (current && current.parentElement) {
								addScroller(current);
								current = current.parentElement;
							}
							addScroller(current);
							try {
								for (const node of document.querySelectorAll("div")) {
									if (node.scrollTop > 0) addScroller(node);
								}
							}
							catch (err) {}
							return scrollers;
						};
						const captureSettingsPanelScrollState = () => {
							const root = getSettingsPanelRoot();
							if (!root) return null;
							const scrollers = getSettingsPanelScrollElements(root);
							if (!scrollers.length) return null;
							return {
								items: scrollers.map(scroller => ({
									scroller,
									scrollTop: scroller.scrollTop,
									scrollLeft: scroller.scrollLeft
								})),
								windowX: typeof window != "undefined" ? window.scrollX : 0,
								windowY: typeof window != "undefined" ? window.scrollY : 0
							};
						};
						const applySettingsPanelScrollState = scrollState => {
							if (!scrollState || !scrollState.items) return;
							for (const item of scrollState.items) {
								if (!item || !item.scroller) continue;
								const maxScrollTop = Math.max(0, item.scroller.scrollHeight - item.scroller.clientHeight);
								const maxScrollLeft = Math.max(0, item.scroller.scrollWidth - item.scroller.clientWidth);
								item.scroller.scrollTop = Math.max(0, Math.min(item.scrollTop, maxScrollTop));
								item.scroller.scrollLeft = Math.max(0, Math.min(item.scrollLeft || 0, maxScrollLeft));
							}
							if (typeof window != "undefined") window.scrollTo(scrollState.windowX || 0, scrollState.windowY || 0);
						};
						const restoreSettingsPanelScrollState = scrollState => {
							if (!scrollState) return;
							applySettingsPanelScrollState(scrollState);
							requestAnimationFrame(() => {
								applySettingsPanelScrollState(scrollState);
								requestAnimationFrame(() => applySettingsPanelScrollState(scrollState));
							});
						};
						const refreshPanel = () => {
							const scrollState = captureSettingsPanelScrollState();
							BDFDB.PluginUtils.refreshSettingsPanel(this, settingsPanel, collapseStates);
							restoreSettingsPanelScrollState(scrollState);
						};
						const saveAuthField = (engineKey, field, value) => {
							if (!authKeys[engineKey]) authKeys[engineKey] = {};
							authKeys[engineKey][field] = (value || "").trim ? (value || "").trim() : value;
							BDFDB.DataUtils.save(authKeys, this, "authKeys");
							this.SettingsUpdated = true;
						};
						const saveReceivedFilterSetting = (key, value) => {
							saveFilterSetting(key, value);
						};
						const infoText = text => BDFDB.ReactUtils.createElement("div", {
							className: "translator-settings-note",
							children: text
						});
						const isChineseUi = this.isChineseUiLanguage();
						const isRussianUi = this.isRussianUiLanguage();
						const compactText = (zh, en, ru = null) => isChineseUi ? zh : isRussianUi ? (ru || en) : en;
						const getEnginePortalConfig = engineKey => {
							const portal = enginePortals[engineKey];
							if (!portal) return null;
							return {
								primaryUrl: portal.primaryUrl,
								primaryLabel: isChineseUi ? portal.primaryLabelZh : portal.primaryLabelEn,
								secondaryUrl: portal.secondaryUrl,
								secondaryLabel: isChineseUi ? portal.secondaryLabelZh : portal.secondaryLabelEn,
								hint: isChineseUi ? portal.hintZh : portal.hintEn
							};
						};
						const defaultSecondaryButtonColor = BDFDB.LibraryComponents.Button.Colors.PRIMARY || BDFDB.LibraryComponents.Button.Colors.GREY || undefined;
						const createActionButton = ({label, onClick, color = undefined, look = null, className = null}) => BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.Button, {
							size: BDFDB.LibraryComponents.Button.Sizes.SMALL,
							color: color === null ? undefined : (color || defaultSecondaryButtonColor),
							look: look || undefined,
							className,
							onClick,
							children: label
						});
						let stableSelectScrollState = null;
						let stableSelectScrollIntoViewOriginal = null;
						let stableSelectScrollLockTimer = null;
						const restoreStableSelectScrollIntoView = _ => {
							try {
								if (stableSelectScrollIntoViewOriginal && typeof Element != "undefined" && Element.prototype.scrollIntoView != stableSelectScrollIntoViewOriginal) Element.prototype.scrollIntoView = stableSelectScrollIntoViewOriginal;
							}
							catch (err) {}
							stableSelectScrollIntoViewOriginal = null;
						};
						const lockStableSelectScrollIntoView = (duration = 900) => {
							try {
								if (typeof Element == "undefined" || !Element.prototype || typeof Element.prototype.scrollIntoView != "function") return;
								if (!stableSelectScrollIntoViewOriginal) {
									stableSelectScrollIntoViewOriginal = Element.prototype.scrollIntoView;
									Element.prototype.scrollIntoView = function () {
										if (this && this.closest && this.closest(".translator-settings-panel-root")) return;
										return stableSelectScrollIntoViewOriginal.apply(this, arguments);
									};
								}
								if (stableSelectScrollLockTimer) clearTimeout(stableSelectScrollLockTimer);
								stableSelectScrollLockTimer = setTimeout(restoreStableSelectScrollIntoView, duration);
							}
							catch (err) {}
						};
						const restoreStableSelectScroll = (scrollState, repeat = false) => {
							if (!scrollState) return;
							const apply = _ => restoreSettingsPanelScrollState(scrollState);
							requestAnimationFrame(apply);
							setTimeout(apply, 0);
							if (repeat) [16, 40, 80, 160, 320, 520].forEach(delay => setTimeout(apply, delay));
						};
						const createStableSelect = props => {
							const getScrollState = _ => stableSelectScrollState || captureSettingsPanelScrollState();
							const rememberScroll = _ => {
								stableSelectScrollState = captureSettingsPanelScrollState();
								return stableSelectScrollState;
							};
							const rememberAndSoftRestore = (repeat = false) => {
								const scrollState = rememberScroll();
								lockStableSelectScrollIntoView(repeat ? 1200 : 700);
								restoreStableSelectScroll(scrollState, repeat);
								return scrollState;
							};
							const callHandler = (name, event) => {
								if (props && typeof props[name] == "function") return props[name](event);
							};
							const captureOnly = _ => {
								rememberScroll();
								lockStableSelectScrollIntoView(900);
							};
							const selectProps = Object.assign({
								menuShouldScrollIntoView: false,
								menuShouldBlockScroll: false,
								captureMenuScroll: false,
								menuPosition: "fixed",
								menuPlacement: "auto",
								menuPortalTarget: typeof document != "undefined" ? document.body : undefined,
								closeMenuOnSelect: true,
								maxMenuHeight: typeof window != "undefined" ? Math.max(150, Math.min(240, Math.floor(window.innerHeight * 0.36))) : 220
							}, props);
							selectProps.onMouseDown = event => {
								rememberAndSoftRestore(true);
								callHandler("onMouseDown", event);
							};
							selectProps.onPointerDown = event => {
								rememberAndSoftRestore(true);
								callHandler("onPointerDown", event);
							};
							selectProps.onClick = event => {
								rememberAndSoftRestore(true);
								callHandler("onClick", event);
							};
							selectProps.onKeyDown = event => {
								if (event && ["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)) rememberAndSoftRestore(true);
								callHandler("onKeyDown", event);
							};
							selectProps.onFocus = event => {
								rememberAndSoftRestore(true);
								callHandler("onFocus", event);
							};
							selectProps.onMenuOpen = _ => {
								rememberAndSoftRestore(true);
								callHandler("onMenuOpen");
							};
							selectProps.onMenuClose = _ => {
								const scrollState = getScrollState();
								callHandler("onMenuClose");
								restoreStableSelectScroll(scrollState, true);
								setTimeout(_ => {stableSelectScrollState = null;}, 450);
							};
							return BDFDB.ReactUtils.createElement("div", {
								className: "translator-stable-select-wrap",
								onMouseDownCapture: captureOnly,
								onPointerDownCapture: captureOnly,
								onFocusCapture: captureOnly,
								children: BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.Select, selectProps)
							});
						};
						const createSegmentedSelector = ({options, value, onChange, className = ""}) => BDFDB.ReactUtils.createElement("div", {
							className: BDFDB.DOMUtils.formatClassName("translator-segmented-group", className),
							children: options.map(option => BDFDB.ReactUtils.createElement("button", {
								type: "button",
								disabled: !!option.disabled,
								className: BDFDB.DOMUtils.formatClassName("translator-segmented-button", option.value == value && "translator-segmented-button-active", option.disabled && "translator-segmented-button-disabled"),
								onClick: _ => !option.disabled && onChange(option.value),
								children: option.label
							}))
						});
						const ensureSecretInputState = () => {
							if (!this.secretInputState) this.secretInputState = {};
							return this.secretInputState;
						};
						const isSecretFieldVisible = fieldKey => !!ensureSecretInputState()[fieldKey];
						const toggleSecretFieldVisibility = fieldKey => {
							const secretState = ensureSecretInputState();
							secretState[fieldKey] = !secretState[fieldKey];
							refreshPanel();
						};
						const createSecretToggleIcon = visible => BDFDB.ReactUtils.createElement("svg", {
							viewBox: "0 0 24 24",
							width: 18,
							height: 18,
							fill: "none",
							stroke: "currentColor",
							strokeWidth: 1.8,
							strokeLinecap: "round",
							strokeLinejoin: "round",
							"aria-hidden": true,
							children: [
								BDFDB.ReactUtils.createElement("path", {d: "M2.2 12s3.6-5.8 9.8-5.8S21.8 12 21.8 12 18.2 17.8 12 17.8 2.2 12 2.2 12Z", key: "outline"}),
								BDFDB.ReactUtils.createElement("circle", {cx: "12", cy: "12", r: "2.6", key: "pupil"}),
								!visible && BDFDB.ReactUtils.createElement("path", {d: "M4 19.2 19.2 4", key: "slash"})
							].filter(Boolean)
						});
						const createSecretInput = ({fieldKey, placeholder, value, onChange}) => BDFDB.ReactUtils.createElement("div", {
							className: "translator-secret-input-row",
							children: [
								BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.TextInput, {
									className: "translator-secret-input",
									type: isSecretFieldVisible(fieldKey) ? "text" : "password",
									placeholder,
									value,
									onChange
								}),
								BDFDB.ReactUtils.createElement("button", {
									type: "button",
									className: "translator-secret-toggle",
									"aria-label": isSecretFieldVisible(fieldKey) ? this.getCustomText("hide_secret_label") : this.getCustomText("show_secret_label"),
									title: isSecretFieldVisible(fieldKey) ? this.getCustomText("hide_secret_label") : this.getCustomText("show_secret_label"),
									onClick: _ => toggleSecretFieldVisibility(fieldKey),
									children: createSecretToggleIcon(isSecretFieldVisible(fieldKey))
								})
							]
						});
						const createExceptionScopeSwitches = (sentKey, receivedKey, sentLabelKey, receivedLabelKey) => BDFDB.ReactUtils.createElement("div", {
							className: "translator-settings-switch-group",
							children: [
								BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.SettingsItem, {
									type: "Switch",
									className: "translator-settings-switch-row",
									label: this.getCustomText(sentLabelKey),
									tag: BDFDB.LibraryComponents.FormTitle.Tags.H5,
									value: this.getExceptionScopeSetting(sentKey, true),
									onChange: value => {
										if (!this.settings.exceptions) this.settings.exceptions = {};
										this.settings.exceptions[sentKey] = !!value;
										BDFDB.DataUtils.save(!!value, this, "exceptions", sentKey);
										this.SettingsUpdated = true;
									}
								}),
								BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.SettingsItem, {
									type: "Switch",
									className: "translator-settings-switch-row",
									label: this.getCustomText(receivedLabelKey),
									tag: BDFDB.LibraryComponents.FormTitle.Tags.H5,
									value: this.getExceptionScopeSetting(receivedKey, true),
									onChange: value => {
										if (!this.settings.exceptions) this.settings.exceptions = {};
										this.settings.exceptions[receivedKey] = !!value;
										BDFDB.DataUtils.save(!!value, this, "exceptions", receivedKey);
										this.SettingsUpdated = true;
									}
								})
							]
						});
						const createStackedTokenInput = ({items, maxLength, placeholder, emptyText, onChange}) => BDFDB.ReactUtils.createElement(class extends BdApi.React.Component {
							constructor(props) {
								super(props);
								this.state = {
									value: "",
									items: BDFDB.ArrayUtils.is(props.items) ? [].concat(props.items) : []
								};
							}
							componentDidUpdate(prevProps) {
								const previousItems = BDFDB.ArrayUtils.is(prevProps.items) ? prevProps.items : [];
								const nextItems = BDFDB.ArrayUtils.is(this.props.items) ? this.props.items : [];
								if (JSON.stringify(previousItems) != JSON.stringify(nextItems)) this.setState({items: [].concat(nextItems)});
							}
							commitValue(rawValue) {
								let value = String(rawValue == null ? this.state.value : rawValue).trim();
								if (!value) return;
								if (typeof this.props.maxLength == "number" && this.props.maxLength > 0) value = value.slice(0, this.props.maxLength);
								const currentItems = BDFDB.ArrayUtils.is(this.state.items) ? this.state.items : [];
								if (currentItems.includes(value)) {
									this.setState({value: ""});
									return;
								}
								const nextItems = [].concat(currentItems, value);
								this.setState({value: "", items: nextItems});
								this.props.onChange(nextItems);
							}
							removeItem(targetItem) {
								const currentItems = BDFDB.ArrayUtils.is(this.state.items) ? this.state.items : [];
								const nextItems = currentItems.filter(item => item != targetItem);
								this.setState({items: nextItems});
								this.props.onChange(nextItems);
							}
							render() {
								const currentItems = BDFDB.ArrayUtils.is(this.state.items) ? this.state.items : [];
								return BDFDB.ReactUtils.createElement("div", {
									className: "translator-token-editor",
									children: [
										BDFDB.ReactUtils.createElement("div", {
											className: "translator-token-list",
											children: currentItems.length ? currentItems.map(item => BDFDB.ReactUtils.createElement("div", {
												className: "translator-token-badge",
												key: item,
												children: [
													BDFDB.ReactUtils.createElement("span", {
														className: "translator-token-badge-text",
														children: item
													}),
													BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.SvgIcon, {
														className: "translator-token-badge-delete",
														name: BDFDB.LibraryComponents.SvgIcon.Names.CLOSE,
														onClick: _ => this.removeItem(item)
													})
												]
											})) : BDFDB.ReactUtils.createElement("div", {
												className: "translator-token-empty",
												children: emptyText || placeholder
											})
										}),
										BDFDB.ReactUtils.createElement("div", {
											className: "translator-token-input-row",
											children: BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.TextInput, {
												value: this.state.value,
												placeholder,
												maxLength,
												onChange: value => this.setState({value}),
												onKeyDown: event => {
													if (event.which == 13) {
														event.preventDefault();
														this.commitValue();
													}
												},
												onBlur: _ => this.commitValue()
											})
										})
									]
								});
							}
						}, {items, maxLength, placeholder, emptyText, onChange});
						const createDisablePrefixForm = () => BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.FormItem, {
							title: this.getCustomText("disable_prefix_title"),
							className: BDFDB.disCN.marginbottom8,
							children: [
								infoText(this.getCustomText("disable_prefix_hint")),
								BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.ListInput, {
									placeholder: this.getCustomText("disable_prefix_placeholder"),
									maxLength: this.defaults.exceptions.wordStart.max,
									items: this.settings.exceptions.wordStart,
									onChange: value => {
										this.SettingsUpdated = true;
										BDFDB.DataUtils.save(value, this, "exceptions", "wordStart");
									}
								})
							]
						});
						const createProtectedTermsForm = () => BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.FormItem, {
							title: this.getCustomText("protected_terms_title"),
							className: BDFDB.DOMUtils.formatClassName(BDFDB.disCN.marginbottom8, "translator-advanced-protection-section translator-advanced-protection-terms"),
							children: [
								infoText(this.getCustomText("protected_terms_hint")),
								createExceptionScopeSwitches("protectedTermsForSent", "protectedTermsForReceived", "protected_terms_scope_sent", "protected_terms_scope_received"),
								createStackedTokenInput({
									placeholder: this.getCustomText("protected_terms_placeholder"),
									emptyText: this.getCustomText("protected_terms_placeholder"),
									maxLength: this.defaults.exceptions.protectedTerms.max,
									items: this.settings.exceptions.protectedTerms || [],
									onChange: value => {
										const nextValue = BDFDB.ArrayUtils.is(value) ? [].concat(value) : [];
										this.settings.exceptions.protectedTerms = nextValue;
										this.SettingsUpdated = true;
										BDFDB.DataUtils.save(nextValue, this, "exceptions", "protectedTerms");
									}
								})
							]
						});
						const createWrapperPairsForm = () => BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.FormItem, {
							title: this.getCustomText("wrapper_pairs_title"),
							className: BDFDB.DOMUtils.formatClassName(BDFDB.disCN.marginbottom8, "translator-advanced-protection-section translator-advanced-protection-wrapper"),
							children: [
								infoText(this.getCustomText("wrapper_pairs_hint")),
								createExceptionScopeSwitches("wrapperPairsForSent", "wrapperPairsForReceived", "wrapper_pairs_scope_sent", "wrapper_pairs_scope_received"),
								createStackedTokenInput({
									placeholder: this.getCustomText("wrapper_pairs_placeholder"),
									emptyText: this.getCustomText("wrapper_pairs_placeholder"),
									maxLength: this.defaults.exceptions.wrapperPairs.max,
									items: this.getWrapperPairItemsForSettings(),
									onChange: value => {
										const nextValue = (BDFDB.ArrayUtils.is(value) ? value : []).filter(rule => !this.isDiscordSpoilerWrapperRule(rule));
										this.settings.exceptions.wrapperPairs = [].concat(nextValue);
										this.SettingsUpdated = true;
										BDFDB.DataUtils.save(nextValue, this, "exceptions", "wrapperPairs");
									}
								})
							]
						});
						const createTranslatePrefixForm = () => BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.FormItem, {
							title: this.getCustomText("translate_prefix_title"),
							className: BDFDB.disCN.marginbottom8,
							children: [
								infoText(this.getCustomText("translate_prefix_hint")),
								...(this.settings.prefixes.translationPrefixData || []).map((entry, index) => BDFDB.ReactUtils.createElement("div", {
									className: "translator-prefix-translation-row",
									children: [
										BDFDB.ReactUtils.createElement("div", {
											className: "translator-prefix-translation-cell translator-prefix-input-cell",
											children: BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.TextInput, {
												placeholder: this.getCustomText("translate_prefix_placeholder"),
												value: entry.prefix,
												onChange: value => {
													this.settings.prefixes.translationPrefixData[index].prefix = value;
													BDFDB.DataUtils.save(this.settings.prefixes.translationPrefixData, this, "prefixes", "translationPrefixData");
													this.SettingsUpdated = true;
												}
											})
										}),
										BDFDB.ReactUtils.createElement("div", {
											className: "translator-prefix-translation-cell translator-prefix-language-cell",
											children: createStableSelect({
												value: entry.language,
												options: Object.keys(languages)
													.filter(key => !languages[key].auto && !languages[key].special)
													.map(key => ({
														value: key,
														label: this.getLanguageDisplayName(languages[key])
													}))
													.sort((a, b) => a.label.localeCompare(b.label)),
												onChange: value => {
													this.settings.prefixes.translationPrefixData[index].language = value;
													BDFDB.DataUtils.save(this.settings.prefixes.translationPrefixData, this, "prefixes", "translationPrefixData");
													this.SettingsUpdated = true;
												}
											})
										}),
										BDFDB.ReactUtils.createElement("div", {
											className: "translator-prefix-translation-cell translator-prefix-delete-cell",
											children: BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.Button, {
												color: BDFDB.LibraryComponents.Button.Colors.RED,
												size: BDFDB.LibraryComponents.Button.Sizes.TINY,
												onClick: _ => {
													this.settings.prefixes.translationPrefixData.splice(index, 1);
													BDFDB.DataUtils.save(this.settings.prefixes.translationPrefixData, this, "prefixes", "translationPrefixData");
													this.SettingsUpdated = true;
													refreshPanel();
												},
												children: BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.SvgIcon, {
													name: BDFDB.LibraryComponents.SvgIcon.Names.TRASH,
													width: 16,
													height: 16
												})
											})
										})
									]
								})),
								BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.SettingsItem, {
									type: "Button",
									color: BDFDB.LibraryComponents.Button.Colors.GREEN,
									onClick: _ => {
										if (!this.settings.prefixes.translationPrefixData) this.settings.prefixes.translationPrefixData = [];
										this.settings.prefixes.translationPrefixData.push({
											prefix: "$en",
											language: "en"
										});
										BDFDB.DataUtils.save(this.settings.prefixes.translationPrefixData, this, "prefixes", "translationPrefixData");
										this.SettingsUpdated = true;
										refreshPanel();
									},
									children: this.getCustomText("add_prefix_button")
								})
							]
						});
						const saveTranslatedTextColor = color => {
							color = (color || "").trim() || "#7cc7ff";
							this.settings.general.translatedTextColor = color;
							if (!BDFDB.ArrayUtils.is(this.settings.general.customTranslatedTextColors)) this.settings.general.customTranslatedTextColors = [];
							if (!this.getTranslatedTextColorPresets().includes(color) && !this.settings.general.customTranslatedTextColors.includes(color)) this.settings.general.customTranslatedTextColors.unshift(color);
							this.settings.general.customTranslatedTextColors = this.settings.general.customTranslatedTextColors.filter((value, index, array) => value && array.indexOf(value) == index).slice(0, 12);
							BDFDB.DataUtils.save(this.settings.general, this, "general");
							this.SettingsUpdated = true;
							refreshPanel();
						};
						const removeTranslatedTextColor = color => {
							color = (color || "").trim();
							if (!color || this.getTranslatedTextColorPresets().includes(color)) return;
							this.settings.general.customTranslatedTextColors = (this.settings.general.customTranslatedTextColors || []).filter(savedColor => savedColor != color);
							if (this.getTranslatedTextColor() == color) this.settings.general.translatedTextColor = this.getTranslatedTextColorPresets()[0] || "#7cc7ff";
							BDFDB.DataUtils.save(this.settings.general, this, "general");
							this.SettingsUpdated = true;
							refreshPanel();
						};
						const resetTranslatedTextColor = () => {
							const defaultColor = this.getTranslatedTextColorPresets()[0] || "#7cc7ff";
							const colorState = ensureTranslatedTextColorState();
							colorState.showCustom = false;
							colorState.customValue = defaultColor;
							this.settings.general.translatedTextColor = defaultColor;
							BDFDB.DataUtils.save(this.settings.general, this, "general");
							this.SettingsUpdated = true;
							refreshPanel();
						};
						const ensureTranslatedTextColorState = () => {
							if (!this.translatedTextColorState) this.translatedTextColorState = {
								showCustom: false,
								customValue: this.getTranslatedTextColor()
							};
							if (!this.translatedTextColorState.customValue) this.translatedTextColorState.customValue = this.getTranslatedTextColor();
							return this.translatedTextColorState;
						};
						const getCustomTranslatedTextColors = () => BDFDB.ArrayUtils.is(this.settings.general.customTranslatedTextColors) ? this.settings.general.customTranslatedTextColors : [];
						const createColorChip = (color, active) => {
							const isCustomColor = getCustomTranslatedTextColors().includes(color) && !this.getTranslatedTextColorPresets().includes(color);
							return BDFDB.ReactUtils.createElement("button", {
								type: "button",
								className: BDFDB.DOMUtils.formatClassName("translator-color-chip", active && "translator-color-chip-active"),
								title: isCustomColor ? `${color} · ${compactText("点击选择，点 × 删除", "Click to select, click × to delete", "Нажмите для выбора, × для удаления")}` : color,
								onClick: _ => {
									const colorState = ensureTranslatedTextColorState();
									colorState.showCustom = false;
									colorState.customValue = color;
									saveTranslatedTextColor(color);
								},
								children: [
									BDFDB.ReactUtils.createElement("span", {
										className: "translator-color-chip-code",
										children: color
									}),
									BDFDB.ReactUtils.createElement("span", {
										className: "translator-settings-color-swatch",
										style: {background: color}
									}),
									isCustomColor && BDFDB.ReactUtils.createElement("span", {
										className: "translator-color-chip-delete",
										title: compactText("删除这个自定义颜色", "Delete this custom color", "Удалить этот цвет"),
										onClick: event => {
											event.preventDefault();
											event.stopPropagation();
											removeTranslatedTextColor(color);
										},
										children: "×"
									})
								].filter(Boolean)
							});
						};
						const createColorOptionLabel = color => BDFDB.ReactUtils.createElement("div", {
							className: "translator-settings-color-option",
							children: [
								BDFDB.ReactUtils.createElement("span", {
									children: color
								}),
								BDFDB.ReactUtils.createElement("span", {
									className: "translator-settings-color-swatch",
									style: {background: color}
								})
							]
						});
						const createInlineHeader = (title, actions = []) => BDFDB.ReactUtils.createElement("div", {
							className: "translator-settings-inline-header",
							children: [
								BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.FormTitle.Title, {
									tag: BDFDB.LibraryComponents.FormTitle.Tags.H5,
									style: {margin: 0},
									children: title
								}),
								actions.length ? BDFDB.ReactUtils.createElement("div", {
									className: "translator-settings-inline-actions translator-settings-primary-actions",
									children: actions
								}) : null
							].filter(Boolean)
						});
						const createSubsectionTitle = title => BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.FormTitle.Title, {
							className: BDFDB.disCN.marginbottom8,
							tag: BDFDB.LibraryComponents.FormTitle.Tags.H5,
							children: title
						});
						const createDivider = () => BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.FormDivider, {
							className: BDFDB.disCNS.dividerdefault + BDFDB.disCN.marginbottom8
						});
						const createSpaciousDivider = () => BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.FormDivider, {
							className: BDFDB.DOMUtils.formatClassName(BDFDB.disCNS.dividerdefault + BDFDB.disCN.marginbottom8, "translator-settings-divider-spacious")
						});
						const createEnginePortalButtons = engineKey => {
							const portal = getEnginePortalConfig(engineKey);
							if (!portal) return {portal: null, buttons: []};
							return {
								portal,
								buttons: [
									portal.primaryUrl && createActionButton({
										label: portal.primaryLabel,
										color: BDFDB.LibraryComponents.Button.Colors.BRAND,
										onClick: _ => BDFDB.DiscordUtils.openLink(portal.primaryUrl)
									}),
									portal.secondaryUrl && portal.secondaryLabel && createActionButton({
										label: portal.secondaryLabel,
										color: BDFDB.LibraryComponents.Button.Colors.BRAND,
										onClick: _ => BDFDB.DiscordUtils.openLink(portal.secondaryUrl)
									})
								].filter(Boolean)
							};
						};
						const createEngineSupportPanel = engineKey => {
							const portalData = createEnginePortalButtons(engineKey);
							const hasLinks = !!portalData.buttons.length;
							if (!hasLinks) return null;

							return BDFDB.ReactUtils.createElement("div", {
								className: "translator-settings-support-panel",
								children: BDFDB.ReactUtils.createElement("div", {
									className: "translator-settings-support-row",
									children: portalData.buttons
								})
							});
						};
						const createFetchedModelSelector = engineKey => {
							const state = this.modelCatalogState && this.modelCatalogState[engineKey];
							if (!state || !state.items || !state.items.length) return null;
							return BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.FormItem, {
								title: this.getCustomText("model_catalog_title"),
								className: BDFDB.disCN.marginbottom8,
								children: [
									createStableSelect({
										value: authKeys[engineKey] && authKeys[engineKey].model || "",
										options: state.items.map(modelId => ({value: modelId, label: modelId})),
										onChange: value => {
											saveAuthField(engineKey, "model", value);
											refreshPanel();
										}
									}),
									BDFDB.ReactUtils.createElement("div", {
										className: "translator-settings-meta",
										children: this.getCustomText("model_catalog_loaded").replace("{count}", state.items.length)
									})
								]
							});
						};
						const updateEngineSetting = (field, value) => {
							this.settings.engines[field] = value;
							BDFDB.DataUtils.save(this.settings.engines, this, "engines");
							this.setLanguages();
							this.SettingsUpdated = true;
							refreshPanel();
						};
						const saveFilterSetting = (key, value) => {
							if (!this.settings.filters) this.settings.filters = {};
							this.settings.filters[key] = value;
							BDFDB.DataUtils.save(value, this, "filters", key);
							this.SettingsUpdated = true;
						};
						const createLanguageOptions = direction => Object.keys(languages)
							.filter(key => !languages[key].special && (direction == languageTypes.INPUT || !languages[key].auto))
							.map(key => ({
								value: key,
								label: this.getLanguageDisplayName(languages[key])
							}))
							.sort((a, b) => {
								if (a.value == "auto") return -1;
								if (b.value == "auto") return 1;
								return a.label.localeCompare(b.label);
							});
						const createLanguageSelector = (place, direction, title) => BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.FormItem, {
							title: title,
							className: BDFDB.disCN.marginbottom8,
							children: createStableSelect({
								value: this.settings.choices[place][direction],
								options: createLanguageOptions(direction),
								onChange: value => {
									this.settings.choices[place][direction] = value;
									BDFDB.DataUtils.save(this.settings.choices, this, "choices");
									this.setLanguages();
									this.SettingsUpdated = true;
									refreshPanel();
								}
							})
						});
						const createGeneralSwitch = key => BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.SettingsSaveItem, {
							type: "Switch",
							plugin: this,
							keys: ["general", key],
							className: "translator-settings-switch-row",
							label: this.getGeneralSettingLabel(key),
							value: this.settings.general[key]
						});
						const createGeneralSwitchGroup = keys => BDFDB.ReactUtils.createElement("div", {
							className: "translator-settings-switch-group",
							children: keys.map(createGeneralSwitch)
						});
						const createUiLanguageSelector = () => BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.FormItem, {
							title: this.getCustomText("plugin_language_title"),
							className: BDFDB.disCN.marginbottom8,
							children: [
								infoText(this.getCustomText("plugin_language_hint")),
								createStableSelect({
									value: this.settings.general.interfaceLanguage || "system",
									options: this.getPluginLanguageOptions(),
									onChange: value => {
										this.settings.general.interfaceLanguage = value || "system";
										BDFDB.DataUtils.save(this.settings.general, this, "general");
										this.SettingsUpdated = true;
										// Reload legacy labels so the popout/quick panel and label fallbacks
										// follow the new plugin language (BDFDB only reloads on Discord lang change).
										this.labels = this.setLabelsByLanguage();
										refreshPanel();
									}
								})
							]
						});
						const createTranslatedTextColorInput = () => BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.FormItem, {
							title: this.getCustomText("translated_text_color_title"),
							className: BDFDB.disCN.marginbottom8,
							children: (() => {
								const currentColor = this.getTranslatedTextColor();
								const colorState = ensureTranslatedTextColorState();
								const presetColors = this.getTranslatedTextColorPalette();
								const hasCustomCurrentColor = !this.getTranslatedTextColorPresets().includes(currentColor);
								return [
									createGeneralSwitch("highlightTranslatedMessages"),
									infoText(compactText("点色板即可切换，+ 号可自定义颜色。", "Pick a swatch or use + for a custom color.", "Нажмите цвет или используйте + для своего варианта.")),
									BDFDB.ReactUtils.createElement("div", {
										className: "translator-color-palette",
										children: [
											...presetColors.map(color => createColorChip(color, color == currentColor)),
											BDFDB.ReactUtils.createElement("button", {
												type: "button",
												className: "translator-color-chip translator-color-chip-add",
												onClick: _ => {
													colorState.showCustom = !colorState.showCustom;
													colorState.customValue = currentColor;
													refreshPanel();
												},
												children: "+"
											})
										]
									}),
									colorState.showCustom && BDFDB.ReactUtils.createElement("div", {
										className: "translator-color-custom-row",
										children: [
											BDFDB.ReactUtils.createElement("input", {
										type: "color",
										className: "translator-native-color-input",
										defaultValue: /^#[0-9a-f]{6}$/i.test(colorState.customValue || "") ? colorState.customValue : "#7cc7ff",
										onInput: event => {
											const nextColor = event && event.target && event.target.value || colorState.customValue;
											colorState.customValue = nextColor;
											const row = event && event.target && event.target.closest && event.target.closest(".translator-color-custom-row");
											const textInput = row && row.querySelector && row.querySelector(".translator-color-custom-input");
											if (textInput && textInput.value != nextColor) textInput.value = nextColor;
										},
										onChange: event => {
											colorState.customValue = event && event.target && event.target.value || colorState.customValue;
										}
									}),
									BDFDB.ReactUtils.createElement("input", {
										type: "text",
										className: "translator-color-custom-input",
										placeholder: "#7cc7ff",
										defaultValue: colorState.customValue,
										onInput: event => {
											colorState.customValue = event && event.target && event.target.value || "";
										}
									}),
											createActionButton({
												label: this.getCustomText("translated_text_color_save_button"),
												look: BDFDB.LibraryComponents.Button.Looks.OUTLINED,
												className: "translator-settings-field-action",
												onClick: _ => {
													const customColor = (colorState.customValue || "").trim();
													if (!this.isValidCssColorValue(customColor)) return BDFDB.NotificationUtils.toast(this.getCustomText("translated_text_color_invalid"), {type: "danger", position: "center"});
													colorState.showCustom = false;
													colorState.customValue = customColor;
													saveTranslatedTextColor(customColor);
												}
											})
										]
									})
								].filter(Boolean);
							})()
						});
						const createSourceLanguageFilter = () => BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.FormItem, {
							title: this.getCustomText("source_filter_title"),
							className: BDFDB.disCN.marginbottom8,
							children: [
								infoText(this.getCustomText("source_filter_hint")),
								!((this.settings.filters && this.settings.filters.autoTranslateSourceLanguages) || []).length && infoText(this.getCustomText("source_filter_empty_state")),
								...((this.settings.filters && this.settings.filters.autoTranslateSourceLanguages) || []).map((languageId, index) => BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.Flex, {
									className: BDFDB.disCN.marginbottom8,
									align: BDFDB.LibraryComponents.Flex.Align.CENTER,
									children: [
										BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.Flex.Child, {
											grow: 1,
											shrink: 0,
											basis: "85%",
											children: createStableSelect({
												value: languageId,
												options: Object.keys(languages)
													.filter(key => !languages[key].auto && !languages[key].special)
													.map(key => ({
														value: key,
														label: this.getLanguageDisplayName(languages[key])
													}))
													.sort((a, b) => a.label.localeCompare(b.label)),
												onChange: value => {
													this.settings.filters.autoTranslateSourceLanguages[index] = value;
													BDFDB.DataUtils.save(this.settings.filters.autoTranslateSourceLanguages, this, "filters", "autoTranslateSourceLanguages");
													this.SettingsUpdated = true;
												}
											})
										}),
										BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.Flex.Child, {
											grow: 0,
											shrink: 0,
											basis: "15%",
											children: BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.Button, {
												color: BDFDB.LibraryComponents.Button.Colors.RED,
												size: BDFDB.LibraryComponents.Button.Sizes.TINY,
												onClick: _ => {
													this.settings.filters.autoTranslateSourceLanguages.splice(index, 1);
													BDFDB.DataUtils.save(this.settings.filters.autoTranslateSourceLanguages, this, "filters", "autoTranslateSourceLanguages");
													this.SettingsUpdated = true;
													refreshPanel();
												},
												children: BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.SvgIcon, {
													name: BDFDB.LibraryComponents.SvgIcon.Names.TRASH,
													width: 16,
													height: 16
												})
											})
										})
									]
								})),
								BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.SettingsItem, {
									type: "Button",
									color: BDFDB.LibraryComponents.Button.Colors.GREEN,
									onClick: _ => {
										if (!this.settings.filters) this.settings.filters = {};
										if (!this.settings.filters.autoTranslateSourceLanguages) this.settings.filters.autoTranslateSourceLanguages = [];
										this.settings.filters.autoTranslateSourceLanguages.push("en");
										BDFDB.DataUtils.save(this.settings.filters.autoTranslateSourceLanguages, this, "filters", "autoTranslateSourceLanguages");
										this.SettingsUpdated = true;
										refreshPanel();
									},
									children: this.getCustomText("source_filter_add")
								})
							]
						});
						const createReceivedSourceLanguageFilter = () => BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.FormItem, {
							title: this.getCustomText("received_source_filter_title"),
							className: BDFDB.disCN.marginbottom8,
							children: [
								infoText(this.getCustomText("received_source_filter_hint")),
								!((this.settings.filters && this.settings.filters.receivedAutoTranslateSourceLanguages) || []).length && infoText(this.getCustomText("received_source_filter_empty_state")),
								...((this.settings.filters && this.settings.filters.receivedAutoTranslateSourceLanguages) || []).map((languageId, index) => BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.Flex, {
									className: BDFDB.disCN.marginbottom8,
									align: BDFDB.LibraryComponents.Flex.Align.CENTER,
									children: [
										BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.Flex.Child, {
											grow: 1,
											shrink: 0,
											basis: "85%",
											children: createStableSelect({
												value: languageId,
												options: Object.keys(languages)
													.filter(key => !languages[key].auto && !languages[key].special)
													.map(key => ({
														value: key,
														label: this.getLanguageDisplayName(languages[key])
													}))
													.sort((a, b) => a.label.localeCompare(b.label)),
												onChange: value => {
													this.settings.filters.receivedAutoTranslateSourceLanguages[index] = value;
													BDFDB.DataUtils.save(this.settings.filters.receivedAutoTranslateSourceLanguages, this, "filters", "receivedAutoTranslateSourceLanguages");
													this.SettingsUpdated = true;
												}
											})
										}),
										BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.Flex.Child, {
											grow: 0,
											shrink: 0,
											basis: "15%",
											children: BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.Button, {
												color: BDFDB.LibraryComponents.Button.Colors.RED,
												size: BDFDB.LibraryComponents.Button.Sizes.TINY,
												onClick: _ => {
													this.settings.filters.receivedAutoTranslateSourceLanguages.splice(index, 1);
													BDFDB.DataUtils.save(this.settings.filters.receivedAutoTranslateSourceLanguages, this, "filters", "receivedAutoTranslateSourceLanguages");
													this.SettingsUpdated = true;
													refreshPanel();
												},
												children: BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.SvgIcon, {
													name: BDFDB.LibraryComponents.SvgIcon.Names.TRASH,
													width: 16,
													height: 16
												})
											})
										})
									]
								})),
								BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.SettingsItem, {
									type: "Button",
									color: BDFDB.LibraryComponents.Button.Colors.GREEN,
									onClick: _ => {
										if (!this.settings.filters) this.settings.filters = {};
										if (!this.settings.filters.receivedAutoTranslateSourceLanguages) this.settings.filters.receivedAutoTranslateSourceLanguages = [];
										this.settings.filters.receivedAutoTranslateSourceLanguages.push("en");
										BDFDB.DataUtils.save(this.settings.filters.receivedAutoTranslateSourceLanguages, this, "filters", "receivedAutoTranslateSourceLanguages");
										this.SettingsUpdated = true;
										refreshPanel();
									},
									children: this.getCustomText("received_source_filter_add")
								})
							]
						});
						const createAutoTranslateDecisionSettings = () => {
							const aiCapable = this.isAiAutoTranslateDecisionAvailable();
							const currentMode = this.getAutoTranslateDecisionMode();
							return BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.FormItem, {
								title: this.getCustomText("auto_translate_decision_title"),
								className: BDFDB.disCN.marginbottom8,
								children: [
									infoText(this.getCustomText("auto_translate_decision_hint")),
									createSegmentedSelector({
										className: "translator-decision-mode-grid",
										value: currentMode,
										options: [
											{value: "basic", label: this.getCustomText("auto_translate_decision_basic")},
											{value: "ai", label: aiCapable ? this.getCustomText("auto_translate_decision_ai") : this.getCustomText("auto_translate_decision_ai_disabled"), disabled: !aiCapable}
										],
										onChange: value => {
											if (!this.settings.filters) this.settings.filters = {};
											this.settings.filters.autoTranslateDecisionMode = value;
											BDFDB.DataUtils.save(value, this, "filters", "autoTranslateDecisionMode");
											this.SettingsUpdated = true;
											refreshPanel();
										}
									}),
									BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.FormItem, {
										title: compactText("语言检测策略", "Language detection strategy", "Стратегия определения языка"),
										className: BDFDB.disCN.marginbottom8,
										children: [
											createStableSelect({
												value: this.getLanguageDetectionStrategy(),
												options: [
													{value: "local_first", label: compactText("本地优先，失败时使用 Google Free", "Local first, then Google Free", "Сначала локально, затем Google Free")},
													{value: "google_free", label: compactText("仅 Google Free", "Google Free only", "Только Google Free")},
													{value: "local_only", label: compactText("仅本地检测", "Local only", "Только локально")}
												],
												onChange: value => {
													if (!this.settings.filters) this.settings.filters = {};
													this.settings.filters.languageDetectionStrategy = value;
													BDFDB.DataUtils.save(value, this, "filters", "languageDetectionStrategy");
													this.SettingsUpdated = true;
												}
											}),
											infoText(compactText("本地检测只在高置信时返回；默认策略拿不准会回退到免密钥的 Google 检测。", "Local detection returns only high-confidence results; the default falls back to keyless Google detection when uncertain.", "Локальное определение возвращает только уверенные результаты; иначе используется Google без ключа."))
										]
									}),
									BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.SettingsItem, {
										type: "Switch",
										label: compactText("本地预检测:翻前用本地语种识别跳过同语言消息", "Local pre-check: skip same-language messages before requesting translation", "Локальная проверка: пропускать сообщения на целевом языке до запроса"),
										tag: BDFDB.LibraryComponents.FormTitle.Tags.H5,
										value: this.useLocalLanguagePrecheck(),
										onChange: value => {
											saveFilterSetting("useLocalLanguagePrecheck", value);
											refreshPanel();
										}
									}),
									infoText(compactText("仅在高置信时跳过,拿不准仍照常翻译;关闭后完全交给翻译服务商判定。", "Only skips when highly confident; uncertain text still gets translated. Turn off to rely entirely on the translation provider.", "Пропускает только при высокой уверенности; иначе переводит как обычно.")),
									currentMode == "ai" && aiCapable && infoText(this.getCustomText("auto_translate_ai_prompt_hint")),
									currentMode == "ai" && aiCapable && BDFDB.ReactUtils.createElement("textarea", {
										className: "translator-ai-prompt-textarea",
										defaultValue: this.getAiAutoTranslatePrompt(),
										onInput: event => {
											const value = event && event.target ? event.target.value : "";
											if (!this.settings.filters) this.settings.filters = {};
											this.settings.filters.aiAutoTranslatePrompt = value;
											BDFDB.DataUtils.save(value, this, "filters", "aiAutoTranslatePrompt");
											this.SettingsUpdated = true;
										},
										onChange: event => {
											const value = event && event.target ? event.target.value : "";
											if (!this.settings.filters) this.settings.filters = {};
											this.settings.filters.aiAutoTranslatePrompt = value;
											BDFDB.DataUtils.save(value, this, "filters", "aiAutoTranslatePrompt");
											this.SettingsUpdated = true;
										}
									})
								].filter(Boolean)
							});
						};
						const createEngineOptions = keys => keys
							.filter(key => translationEngines[key])
							.map(key => ({value: key, label: this.getEngineLabel(key)}));
						const createPrimaryOptions = () => createEngineOptions(recommendedEngines.concat(Object.keys(translationEngines).filter(key => !recommendedEngines.includes(key))));
						const createBackupOptions = () => [{value: "----", label: this.getCustomText("backup_engine_none")}].concat(
							Object.keys(translationEngines)
								.filter(key => key != this.settings.engines.translator)
								.map(key => ({value: key, label: this.getEngineLabel(key)}))
						);
						const createEngineFields = engineKey => {
							const engine = translationEngines[engineKey];
							if (!engine) return [infoText(this.getCustomText("engine_unknown_hint"))];
							if (engineKey == "googleapi") return [createEngineSupportPanel(engineKey)];
							let items = [];
							if (engine.premium) items.push(BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.SettingsItem, {
								type: "Switch",
								label: this.getCustomText("paid_version_label"),
								tag: BDFDB.LibraryComponents.FormTitle.Tags.H5,
								value: authKeys[engineKey] && authKeys[engineKey].paid,
								onChange: value => {
									if (!authKeys[engineKey]) authKeys[engineKey] = {};
									authKeys[engineKey].paid = value;
									BDFDB.DataUtils.save(authKeys, this, "authKeys");
									this.SettingsUpdated = true;
								}
							}));
							if (engine.key) {
								items.push(BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.FormTitle.Title, {
									className: BDFDB.disCN.marginbottom8,
									tag: BDFDB.LibraryComponents.FormTitle.Tags.H5,
									children: this.getCustomText("api_key_label")
								}));
								items.push(createSecretInput({
									fieldKey: `${engineKey}-key`,
									placeholder: engine.key,
									value: authKeys[engineKey] && authKeys[engineKey].key,
									onChange: value => saveAuthField(engineKey, "key", value)
								}));
							}
							if (engine.endpoint) {
								items.push(BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.FormTitle.Title, {
									className: BDFDB.disCN.marginbottom8,
									tag: BDFDB.LibraryComponents.FormTitle.Tags.H5,
									children: this.getCustomText("api_endpoint_label")
								}));
								items.push(BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.TextInput, {
									className: BDFDB.disCN.marginbottom8,
									placeholder: engine.endpoint,
									value: authKeys[engineKey] && authKeys[engineKey].endpoint,
									onChange: value => saveAuthField(engineKey, "endpoint", value)
								}));
							}
							if (engine.model) {
								const modelCatalogState = this.modelCatalogState && this.modelCatalogState[engineKey];
								const modelActions = [];
								if (this.isValidatableEngine(engineKey)) modelActions.push(createActionButton({
									label: this.getCustomText("model_detect_button"),
									color: defaultSecondaryButtonColor,
									className: "translator-settings-field-action",
									onClick: async _ => {
										const result = await this.validateEngineConfig(engineKey);
										if (result && result.normalized) refreshPanel();
									}
								}));
								if (this.supportsModelCatalog(engineKey)) modelActions.push(createActionButton({
									label: modelCatalogState && modelCatalogState.loading ? this.getCustomText("model_fetch_loading") : this.getCustomText("model_fetch_button"),
									color: defaultSecondaryButtonColor,
									className: "translator-settings-field-action",
									onClick: _ => this.fetchModelCatalog(engineKey, refreshPanel)
								}));
								items.push(createInlineHeader(this.getCustomText("model_id_label"), modelActions));
								items.push(BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.TextInput, {
									className: BDFDB.disCN.marginbottom8,
									placeholder: engine.model,
									value: authKeys[engineKey] && authKeys[engineKey].model,
									onChange: value => saveAuthField(engineKey, "model", value)
								}));
								if (modelCatalogState && modelCatalogState.loading) items.push(BDFDB.ReactUtils.createElement("div", {
									className: BDFDB.disCN.marginbottom8,
									style: {opacity: 0.8, lineHeight: "1.5"},
									children: this.getCustomText("model_fetch_loading")
								}));
								const fetchedModelSelector = createFetchedModelSelector(engineKey);
								if (fetchedModelSelector) items.push(fetchedModelSelector);
							}
							if (engineKey == "microsoft") items.push(BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.FormItem, {
								title: this.getCustomText("microsoft_region_label"),
								className: BDFDB.disCN.marginbottom8,
								children: createStableSelect({
									value: authKeys[engineKey] && authKeys[engineKey].region || "global",
									options: [
										{value: "global", label: "Global"},
										{value: "eastasia", label: "East Asia"},
										{value: "southeastasia", label: "Southeast Asia"},
										{value: "centralus", label: "Central US"},
										{value: "eastus", label: "East US"},
										{value: "eastus2", label: "East US 2"},
										{value: "westus", label: "West US"},
										{value: "westeurope", label: "West Europe"},
										{value: "japaneast", label: "Japan East"}
									],
									onChange: value => saveAuthField(engineKey, "region", value)
								})
							}));
							const supportPanel = createEngineSupportPanel(engineKey);
							if (supportPanel) items.push(supportPanel);
							if (!items.length) items.push(infoText(this.getCustomText("engine_no_extra_fields")));
							return items;
						};
						const createOtherServiceAuthSection = () => BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.CollapseContainer, {
							title: this.getCustomText("other_service_title"),
							collapseStates: collapseStates,
							children: [
								infoText(compactText("只有切换到这些服务商时再填写。", "Only fill these in if you switch to those providers.", "Заполняйте только если будете переключаться на этих провайдеров.")),
								...this.getAdditionalCredentialEngineKeys()
									.map(key => BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.CollapseContainer, {
										title: this.getEngineLabel(key),
										collapseStates: collapseStates,
										children: createEngineFields(key)
									}))
							]
						});
						const createProtectionSection = () => [
							createProtectedTermsForm(),
							createSpaciousDivider(),
							createWrapperPairsForm()
						];
						const createPrefixSection = () => [
							createDisablePrefixForm(),
							createTranslatePrefixForm()
						];
						settingsItems.push(BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.CollapseContainer, {
							title: this.getCustomText("section_service_title"),
							collapseStates: collapseStates,
							children: [
								BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.FormItem, {
									title: this.getCustomText("primary_engine_title"),
									className: BDFDB.disCN.marginbottom8,
									children: createStableSelect({
										value: this.settings.engines.translator,
										options: createPrimaryOptions(),
										onChange: value => updateEngineSetting("translator", value)
									})
								}),
								...createEngineFields(this.settings.engines.translator),
								createDivider(),
								BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.CollapseContainer, {
									title: this.getCustomText("backup_engine_title"),
									collapseStates: collapseStates,
									children: [
										infoText(compactText("主服务失败时才会切到备用服务。", "Used only when the primary provider fails.", "Используется только при сбое основного провайдера.")),
										BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.FormItem, {
											title: this.getCustomText("backup_engine_select_title"),
											className: BDFDB.disCN.marginbottom8,
											children: createStableSelect({
												value: this.settings.engines.backup,
												options: createBackupOptions(),
												onChange: value => updateEngineSetting("backup", value)
											})
										}),
										this.settings.engines.backup == "----" ? infoText(this.getCustomText("backup_engine_none_hint")) : createEngineFields(this.settings.engines.backup)
									]
								}),
								createOtherServiceAuthSection()
							]
						}));
						settingsItems.push(BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.CollapseContainer, {
							title: this.getCustomText("section_language_title"),
							collapseStates: collapseStates,
							children: [
								createSubsectionTitle(this.getCustomText("section_message_language_title")),
								createLanguageSelector(messageTypes.SENT, languageTypes.INPUT, this.getCustomText("sent_input_title")),
								createLanguageSelector(messageTypes.SENT, languageTypes.OUTPUT, this.getCustomText("sent_output_title")),
								createSourceLanguageFilter(),
								createDivider(),
								createLanguageSelector(messageTypes.RECEIVED, languageTypes.INPUT, this.getCustomText("received_input_title")),
								createLanguageSelector(messageTypes.RECEIVED, languageTypes.OUTPUT, this.getCustomText("received_output_title")),
								createReceivedSourceLanguageFilter(),
								createSpaciousDivider(),
								createAutoTranslateDecisionSettings()
							]
						}));
						settingsItems.push(BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.CollapseContainer, {
							title: this.getCustomText("section_display_title"),
							collapseStates: collapseStates,
							children: [
								createSubsectionTitle(this.getCustomText("section_display_message_title")),
								createGeneralSwitchGroup([
									"sendOriginalMessage",
									"useSpoilerInSentOriginal",
									"showOriginalMessage",
									"showOriginalDirectly",
									"useSpoilerInReceivedOriginal",
									"showOriginalInReplyPreview",
								]),
								createSpaciousDivider(),
								createTranslatedTextColorInput(),
								createSpaciousDivider(),
								createUiLanguageSelector()
							]
						}));
						settingsItems.push(BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.CollapseContainer, {
							title: this.getCustomText("section_advanced_title"),
							collapseStates: collapseStates,
							children: [
								...createProtectionSection(),
								createSpaciousDivider(),
								...createPrefixSection()
							]
						}));
						return BDFDB.ReactUtils.createElement("div", {
							className: "translator-settings-panel-root",
							children: settingsItems.flat(10).filter(n => n)
						});
					}
				});
			}
		
			onSettingsClosed () {
				if (deferredTranslationRerenderPending) this.flushDeferredTranslationRerender();
				if (this.SettingsUpdated) {
					delete this.SettingsUpdated;
					this.forceUpdateAll();
				}
			}

			getCustomText (key) {
				return getCustomTextValue(key, this.isChineseUiLanguage(), this.isRussianUiLanguage());
			}

			getGeneralSettingLabel (key) {
				const isChinese = this.isChineseUiLanguage();
				const isRussian = this.isRussianUiLanguage();
				const labels = isChinese ? {
					sendOriginalMessage: "发送译文时同时附带原文",
					showOriginalMessage: "查看收到的译文时同时显示原文",
					useSpoilerInOriginal: "原文使用剧透样式显示"
				} : {
					sendOriginalMessage: "Also send the original text with translated outgoing messages",
					showOriginalMessage: "Also show the original text with translated incoming messages",
					useSpoilerInOriginal: "Show original text as spoiler blocks"
				};
				Object.assign(labels, isChinese ? {
					showOriginalDirectly: "直接显示收到消息的原文",
					useSpoilerInOriginal: "原文使用剧透样式显示"
				} : {
					showOriginalDirectly: "Show received original text directly",
					useSpoilerInOriginal: "Show original text as spoiler blocks"
				});
				Object.assign(labels, isChinese ? {
					highlightTranslatedMessages: "给译文消息添加更显眼的左侧色条与背景",
					showTranslationLabel: "在译文消息上方显示“译文”标签"
				} : {
					highlightTranslatedMessages: "Highlight translated messages with a left accent and background",
					showTranslationLabel: "Show a visible 'Translated' label above translated messages"
				});
				Object.assign(labels, isChinese ? {
					protectQuotedText: "自动保护并高亮包裹符内的内容"
				} : {
					protectQuotedText: "Automatically protect and highlight wrapped content"
				});
				Object.assign(labels, isChinese ? {
					showOriginalInReplyPreview: "别人引用这条消息时只显示译文"
				} : {
					showOriginalInReplyPreview: "Show translated text only in reply previews"
				});
				Object.assign(labels, isChinese ? {
					useSpoilerInSentOriginal: "发送附带原文时使用剧透/刮刮乐遮盖",
					useSpoilerInReceivedOriginal: "查看收到的原文时使用剧透/刮刮乐遮盖"
				} : {
					useSpoilerInSentOriginal: "Hide attached outgoing original text behind spoiler (scratch-off) blocks",
					useSpoilerInReceivedOriginal: "Show received original text as spoiler (scratch-off) blocks"
				});
				if (isRussian) Object.assign(labels, {
					interfaceLanguage: "Язык интерфейса плагина",
					sendOriginalMessage: "Добавлять оригинал к переведённым исходящим сообщениям",
					showOriginalMessage: "Показывать оригинал рядом с переведёнными входящими сообщениями",
					showOriginalDirectly: "Показывать оригинал входящих сообщений напрямую",
					highlightTranslatedMessages: "Подсвечивать переведённые сообщения",
					showTranslationLabel: "Показывать метку перевода",
					translatedTextColor: "Цвет переведённого текста",
					protectQuotedText: "Автоматически защищать и подсвечивать текст в обрамляющих символах",
					useSpoilerInOriginal: "Показывать оригинал как спойлер"
				});
				if (isRussian) Object.assign(labels, {
					useSpoilerInSentOriginal: "袩褉褟褌邪褌褜 懈褋褏芯写薪褘泄 褌械泻褋褌 胁 懈褋褏芯写褟褖懈褏 褋芯芯斜褖械薪懈褟褏 泻邪泻 褋锌芯泄谢械褉",
					useSpoilerInReceivedOriginal: "袩芯泻邪蟹褘胁邪褌褜 芯褉懈谐懈薪邪谢 胁褏芯写褟褖懈褏 褋芯芯斜褖械薪懈泄 泻邪泻 褋锌芯泄谢械褉"
				});
				return labels[key] || this.labels[`general_${key}`] || this.defaults.general[key].description;
			}

			getEngineLabel (engineKey) {
				const isChinese = this.isChineseUiLanguage();
				const isRussian = this.isRussianUiLanguage();
				if (isRussian && engineKey == "googleapi") return "Google (по умолчанию, без API)";
				if (isRussian && engineKey == "googlecloud") return "Google Cloud Translation (официальный API)";
				if (isRussian && engineKey == "microsoft") return "Azure Translator (официальный API)";
				if (isRussian && engineKey == "oaicompat") return "Пользовательский API (совместимый с OpenAI)";
				if (engineKey == "googleapi") return isChinese ? "Google（默认，无需 API）" : "Google (Default, no API)";
				if (engineKey == "googlecloud") return isChinese ? "Google Cloud Translation（正式 API）" : "Google Cloud Translation (Official API)";
				if (engineKey == "microsoft") return isChinese ? "Azure Translator（正式 API）" : "Azure Translator (Official API)";
				if (engineKey == "openai") return isChinese ? "OpenAI（官方 API）" : "OpenAI (Official API)";
				if (engineKey == "gemini") return isChinese ? "Google Gemini（官方 API）" : "Google Gemini (Official API)";
				if (engineKey == "oaicompat") return isChinese ? "自定义 API（兼容 OpenAI）" : "Custom API (OpenAI Compatible)";
				return translationEngines[engineKey] && translationEngines[engineKey].name || engineKey;
			}

			getChannelTranslationToggleLabel () {
				if (this.isChineseUiLanguage()) return "\u5f53\u524d\u9891\u9053\u6536\u5230\u6d88\u606f\u81ea\u52a8\u7ffb\u8bd1";
				return "Incoming auto-translate for this channel";
			}

			getTranslateButtonTooltipText (channelId) {
				const enabled = this.isTranslationEnabled(channelId);
				if (!enabled) {
					if (this.isChineseUiLanguage()) return "左键打开设置，右键开启当前频道的翻译插件总开关";
					return "Left click for settings, right click to enable the translator master switch in this channel";
				}
				const statusText = this.isChineseUiLanguage() ? "当前频道翻译插件总开关已开启" : "Translator master switch is enabled in this channel";
				return `${statusText} | ${this.getTranslationTooltipText(this.getLanguageChoice(languageTypes.INPUT, messageTypes.RECEIVED, channelId), this.getLanguageChoice(languageTypes.OUTPUT, messageTypes.RECEIVED, channelId))}`;
			}

			getUiLanguageId () {
				const overrideLanguage = this.settings && this.settings.general && this.settings.general.interfaceLanguage;
				return overrideLanguage && overrideLanguage != "system" ? overrideLanguage : BDFDB.LanguageUtils.getLanguage().id;
			}

			isChineseUiLanguage () {
				return ["zh", "zh-CN", "zh-TW"].includes(this.getUiLanguageId());
			}

			isRussianUiLanguage () {
				return this.getUiLanguageId() == "ru";
			}

			getPluginLanguageOptions () {
				const isChinese = this.isChineseUiLanguage();
				const isRussian = this.isRussianUiLanguage();
				return [
					{value: "system", label: isChinese ? "跟随 Discord" : isRussian ? "Как в Discord" : "Follow Discord"},
					{value: "zh-CN", label: "简体中文"},
					{value: "en", label: "English"},
					{value: "ru", label: "Русский"}
				];
			}

			getReceivedAutoTranslateScopeOptions () {
				return [
					{value: "new_only", label: this.getCustomText("received_auto_translate_scope_new_only")},
					{value: "loaded_messages", label: this.getCustomText("received_auto_translate_scope_loaded_messages")}
				];
			}

			getReceivedAutoTranslateLoadedTimeWindowOptions () {
				return [
					{value: "15m", label: this.getCustomText("received_auto_translate_loaded_window_15m")},
					{value: "1h", label: this.getCustomText("received_auto_translate_loaded_window_1h")},
					{value: "6h", label: this.getCustomText("received_auto_translate_loaded_window_6h")},
					{value: "24h", label: this.getCustomText("received_auto_translate_loaded_window_24h")},
					{value: "all", label: this.getCustomText("received_auto_translate_loaded_window_all")}
				];
			}

			getReceivedAutoTranslateLoadedRangeModeOptions () {
				return [
					{value: LOADED_AUTO_TRANSLATE_RANGE_MODES.COUNT, label: this.getCustomText("received_auto_translate_loaded_range_mode_count")},
					{value: LOADED_AUTO_TRANSLATE_RANGE_MODES.TIME, label: this.getCustomText("received_auto_translate_loaded_range_mode_time")}
				];
			}

			normalizeLoadedAutoTranslateLimit (value) {
				const parsedValue = parseInt(value, 10);
				if (!isFinite(parsedValue)) return DEFAULT_LOADED_AUTO_TRANSLATE_LIMIT;
				return Math.max(LOADED_AUTO_TRANSLATE_LIMIT_MIN, Math.min(LOADED_AUTO_TRANSLATE_LIMIT_MAX, parsedValue));
			}

			getTranslatedTextColorPresets () {
				return [
					"#7cc7ff",
					"#5aa9ff",
					"#57d39b",
					"#f0b232",
					"#ff8a5b",
					"#ff6b9a",
					"#c084fc",
					"#e6edf3"
				];
			}

			getTranslatedTextColorPalette () {
				const colors = this.getTranslatedTextColorPresets().slice();
				const customColors = this.settings && this.settings.general && BDFDB.ArrayUtils.is(this.settings.general.customTranslatedTextColors) ? this.settings.general.customTranslatedTextColors : [];
				for (const color of customColors) if (color && !colors.includes(color)) colors.unshift(color);
				const currentColor = this.getTranslatedTextColor();
				if (!colors.includes(currentColor)) colors.unshift(currentColor);
				return colors;
			}

			getTranslatedTextColorOptions () {
				return this.getTranslatedTextColorPalette().map(color => ({value: color, label: color}));
			}

			getTranslatedTextColor () {
				const color = this.settings && this.settings.general && this.settings.general.translatedTextColor;
				return (color || "").trim() || "#7cc7ff";
			}

			isValidCssColorValue (color) {
				color = (color || "").trim();
				if (!color) return false;
				if (typeof document == "undefined" || !document.createElement) return /^#([0-9a-f]{3,8})$/i.test(color);
				const testElement = document.createElement("span");
				testElement.style.color = "";
				testElement.style.color = color;
				return !!testElement.style.color;
			}

			shouldUseSpoilerInSentOriginal () {
				const general = this.settings && this.settings.general || {};
				if (general.useSpoilerInSentOriginal != null) return !!general.useSpoilerInSentOriginal;
				return !!general.useSpoilerInOriginal;
			}

			shouldUseSpoilerInReceivedOriginal () {
				const general = this.settings && this.settings.general || {};
				if (general.useSpoilerInReceivedOriginal != null) return !!general.useSpoilerInReceivedOriginal;
				return !!general.useSpoilerInOriginal;
			}

			getCurrentUserId () {
				try {
					if (BDFDB.LibraryStores.UserStore && typeof BDFDB.LibraryStores.UserStore.getCurrentUser == "function") {
						const currentUser = BDFDB.LibraryStores.UserStore.getCurrentUser();
						if (currentUser && currentUser.id) return currentUser.id;
					}
				}
				catch (err) {}
				return BDFDB.UserUtils && BDFDB.UserUtils.me && BDFDB.UserUtils.me.id || null;
			}

			isOwnMessage (message) {
				const currentUserId = this.getCurrentUserId();
				return !!(currentUserId && message && message.author && message.author.id == currentUserId);
			}

			ensureElementChildrenArray (element) {
				if (!element || !element.props) return [];
				if (!Array.isArray(element.props.children)) element.props.children = element.props.children == null ? [] : [element.props.children];
				return element.props.children;
			}

			getMessageDetectionSourceText (message) {
				if (!message) return "";
				const translation = translatedMessages[message.id];
				if (translation && translation.originalContent) return translation.originalContent;
				const originalContentData = oldMessages[message.id] && oldMessages[message.id].originalContentData;
				if (originalContentData && originalContentData.content) return originalContentData.content;
				return message.content || "";
			}

			ensureChannelLanguageChoiceScope (channelId, place) {
				if (!channelId || !place) return null;
				if (!channelLanguages[channelId]) channelLanguages[channelId] = {};
				if (!channelLanguages[channelId][place]) {
					channelLanguages[channelId][place] = {};
					for (let typeKey in languageTypes) channelLanguages[channelId][place][languageTypes[typeKey]] = this.getLanguageChoice(languageTypes[typeKey], place, channelId);
				}
				return channelLanguages[channelId][place];
			}

			setReplyTargetLanguageForChannel (channelId, languageId) {
				if (!channelId || !languageId) return;
				const scope = this.ensureChannelLanguageChoiceScope(channelId, messageTypes.SENT);
				if (!scope) return;
				scope[languageTypes.OUTPUT] = languageId;
				BDFDB.DataUtils.save(channelLanguages, this, "channelLanguages");
				this.setLanguages();
				this.SettingsUpdated = true;
			}

			extractLegacyDisplayedTranslationParts (content) {
				content = (content || "").trim();
				if (!content) return {translatedContent: "", originalContent: ""};

				content = content.replace(/^\s*(?:译文|Translated|Перевод)\s*\n+/i, "");
				const lines = content.split("\n");
				const originalLabelIndex = lines.findIndex(line => /^(?:原文|Original|Оригинал)\s*$/i.test((line || "").trim()));
				if (originalLabelIndex > -1) return {
					translatedContent: lines.slice(0, originalLabelIndex).join("\n").trim(),
					originalContent: lines.slice(originalLabelIndex + 1).join("\n").trim()
				};

				if (/\n\|\|[\s\S]*\|\|$/.test(content)) {
					const match = content.match(/\n\|\|([\s\S]*)\|\|$/);
					return {
						translatedContent: content.replace(/\n\|\|[\s\S]*\|\|$/, "").trim(),
						originalContent: match && match[1] ? match[1].trim() : ""
					};
				}

				const boundaryLines = content.split("\n");
				let boundaryIndex = boundaryLines.length;
				while (boundaryIndex > 0 && /^\s*>\s?/.test(boundaryLines[boundaryIndex - 1])) boundaryIndex--;
				if (boundaryIndex < boundaryLines.length) return {
					translatedContent: boundaryLines.slice(0, boundaryIndex).join("\n").trim(),
					originalContent: boundaryLines.slice(boundaryIndex).map(line => line.replace(/^\s*>\s?/, "")).join("\n").trim()
				};

				return {translatedContent: content, originalContent: ""};
			}

			normalizeStoredTranslationData (translation) {
				if (!translation) return translation;
				const normalized = Object.assign({}, translation);
				const legacyParts = this.extractLegacyDisplayedTranslationParts(normalized.content || "");
				const translatedContent = (normalized.translatedContent || "").trim();
				const originalContent = normalized.originalContent != null ? String(normalized.originalContent) : "";

				if (!translatedContent || /^(?:译文|Translated|Перевод)\s*$/i.test(translatedContent)) normalized.translatedContent = legacyParts.translatedContent || translatedContent;
				else normalized.translatedContent = translatedContent;
				if (!originalContent && legacyParts.originalContent) normalized.originalContent = legacyParts.originalContent;
				return normalized;
			}

			async handleMessageLanguageAction (message, channel, applyAsReplyTarget = false) {
				const sourceText = (this.getMessageDetectionSourceText(message) || "").trim();
				if (!sourceText) return BDFDB.NotificationUtils.toast(this.getCustomText("detect_message_empty"), {type: "danger", position: "center"});
				const detectedLanguage = await this.detectLanguageDetails(sourceText);
				if (!detectedLanguage) return BDFDB.NotificationUtils.toast(this.getCustomText("detect_message_failed"), {type: "danger", position: "center"});
				if (applyAsReplyTarget && channel && channel.id) {
					this.setReplyTargetLanguageForChannel(channel.id, detectedLanguage.id);
					return BDFDB.NotificationUtils.toast(`${this.getCustomText("reply_language_applied")} ${this.getLanguageDisplayName(detectedLanguage)} (${detectedLanguage.id}). ${this.getCustomText("reply_language_hint")}`, {type: "success", position: "center"});
				}
				return BDFDB.NotificationUtils.toast(`${this.getCustomText("detect_message_success")}: ${this.getLanguageDisplayName(detectedLanguage)} (${detectedLanguage.id})`, {type: "success", position: "center"});
			}

			injectMessageLanguageActions (children, index, message, channel) {
				if (!children || !message || !channel) return;
				const insertIndex = index > -1 ? index + 1 : 0;
				children.splice(insertIndex, 0,
					BDFDB.ContextMenuUtils.createItem(BDFDB.LibraryComponents.MenuItems.MenuItem, {
						label: this.getCustomText("context_detect_message_language"),
						id: BDFDB.ContextMenuUtils.createItemId(this.name, "detect-message-language"),
						action: _ => this.handleMessageLanguageAction(message, channel, false)
					}),
					BDFDB.ContextMenuUtils.createItem(BDFDB.LibraryComponents.MenuItems.MenuItem, {
						label: this.getCustomText("context_reply_in_detected_language"),
						id: BDFDB.ContextMenuUtils.createItemId(this.name, "reply-in-detected-language"),
						action: _ => this.handleMessageLanguageAction(message, channel, true)
					})
				);
			}

			cloneOriginalContentData (originalContentData) {
				return {
					content: originalContentData && originalContentData.content || "",
					embeds: ((originalContentData && originalContentData.embeds) || []).map(embed => ({
						description: embed && embed.description || "",
						title: embed && embed.title || "",
						footerText: embed && embed.footerText || "",
						fields: ((embed && embed.fields) || []).map(field => ({
							name: field && field.name || "",
							value: field && field.value || ""
						}))
					}))
				};
			}

			normalizeExtractedMessageText (value) {
				if (value == null) return "";
				if (typeof value == "string") return value;
				if (typeof value == "number" || typeof value == "boolean") return String(value);
				if (value && typeof value == "object") {
					if (typeof value.text == "string") return value.text;
					if (typeof value.content == "string") return value.content;
					if (typeof value.raw == "string") return value.raw;
				}
				return "";
			}

			getReferencedPreviewContentCandidates (message) {
				const candidates = [];
				const addCandidate = value => {
					value = this.normalizeExtractedMessageText(value).trim();
					if (value && !candidates.includes(value)) candidates.push(value);
				};
				const referencedSources = [
					message && message.referencedMessage,
					message && message.referencedMessage && message.referencedMessage.message,
					message && message.referenced_message,
					message && message.messageReference && message.messageReference.message,
					message && message.reference && message.reference.message
				].filter(Boolean);
				for (const source of referencedSources) {
					addCandidate(source.content);
					addCandidate(source.originalContent);
					addCandidate(source.rawContent);
				}
				return candidates;
			}

			stripReferencedPreviewFromContent (message, content) {
				content = this.normalizeExtractedMessageText(content);
				if (!message || !content || !(message.referencedMessage || message.referenced_message || message.messageReference || message.reference)) return content;
				const trimmedContent = content.trim();
				if (!trimmedContent) return content;
				const candidates = this.getReferencedPreviewContentCandidates(message);
				if (!candidates.length) return content;
				const normalize = value => this.normalizeComparisonText(value || "");
				const lines = content.split(/\r?\n/);
				for (const candidate of candidates) {
					const normalizedCandidate = normalize(candidate);
					if (!normalizedCandidate) continue;
					if (normalize(trimmedContent) == normalizedCandidate) return content;
					if (trimmedContent.startsWith(candidate)) {
						let remainder = trimmedContent.slice(candidate.length).replace(/^\s+/, "");
						if (remainder) return remainder;
					}
					const firstLine = (lines[0] || "").trim();
					if (firstLine && (normalize(firstLine).includes(normalizedCandidate) || normalizedCandidate.includes(normalize(firstLine)))) {
						const remainder = lines.slice(1).join("\n").trim();
						if (remainder) return remainder;
					}
				}
				return content;
			}

			refreshReceivedMessageSourceState (message, channelId = null) {
				if (!message || !message.id || !oldMessages[message.id]) return false;
				const currentContent = this.normalizeExtractedMessageText(message.content).trim();
				if (!currentContent) return false;
				const storedOriginal = oldMessages[message.id];
				const storedOriginalData = storedOriginal.originalContentData || {};
				const translation = translatedMessages[message.id] || {};
				const knownContents = [
					storedOriginal.content,
					storedOriginalData.content,
					translation.originalContent,
					translation.translatedContent,
					translation.content
				].map(value => this.normalizeExtractedMessageText(value).trim()).filter(Boolean);
				if (knownContents.includes(currentContent)) return false;
				delete oldMessages[message.id];
				this.clearDisplayedTranslationState(message.id, {clearReplyPreview: true});
				this.clearCachedTranslation(message.id);
				return true;
			}

			extractOriginalContentData (message, options = {}) {
				const storedOriginalContentData = message && message.id && oldMessages[message.id] && oldMessages[message.id].originalContentData;
				if (storedOriginalContentData) return this.cloneOriginalContentData(storedOriginalContentData);
				let messageContent = this.normalizeExtractedMessageText(message && message.content || "");
				if (options && options.ignoreReferencedPreview) messageContent = this.stripReferencedPreviewFromContent(message, messageContent);
				const extractedParts = this.extractLegacyDisplayedTranslationParts(messageContent);
				return this.cloneOriginalContentData({
					content: extractedParts.originalContent || messageContent,
					embeds: ((message && message.embeds) || []).map(embed => ({
						description: this.normalizeExtractedMessageText(embed.originalDescription || embed.rawDescription || embed.description || ""),
						title: this.normalizeExtractedMessageText(embed.originalTitle || embed.rawTitle || embed.title || ""),
						footerText: this.normalizeExtractedMessageText(embed.originalFooter ? embed.originalFooter.text : embed.footer ? embed.footer.text : ""),
						fields: (embed.originalFields || embed.fields || []).map(field => ({
							name: this.normalizeExtractedMessageText(field.rawName || field.name || ""),
							value: this.normalizeExtractedMessageText(field.rawValue || field.value || "")
						}))
					}))
				});
			}

			isTranslatorInjectedElement (element) {
				if (!element || typeof element != "object") return false;
				if (element.key && String(element.key).indexOf("translator-") == 0) return true;
				const className = element.props && element.props.className;
				if (typeof className == "string" && className.toLowerCase().indexOf("translator") > -1) return true;
				const nestedChildren = element.props && element.props.children;
				if (!nestedChildren) return false;
				if (Array.isArray(nestedChildren)) return nestedChildren.some(child => this.isTranslatorInjectedElement(child));
				return this.isTranslatorInjectedElement(nestedChildren);
			}

			cleanupInjectedMessageChildren (children) {
				if (!Array.isArray(children)) return children;
				for (let index = children.length - 1; index > -1; index--) {
					if (this.isTranslatorInjectedElement(children[index])) children.splice(index, 1);
				}
				return children;
			}

			buildProtectedQuoteFragments (text, keyPrefix = "0") {
				if (!this.settings.general.protectQuotedText || typeof text != "string" || !text) return text;
				const quotedRegex = /"([^"\r\n]+)"|“([^”\r\n]+)”/g;
				let match, lastIndex = 0, quoteIndex = 0, fragments = [];
				while ((match = quotedRegex.exec(text))) {
					const quotedText = match[0];
					if (!quotedText || !quotedText.slice(1, -1).trim()) continue;
					if (match.index > lastIndex) fragments.push(text.slice(lastIndex, match.index));
					fragments.push(BDFDB.ReactUtils.createElement("span", {
						key: `translator-protected-quote-${keyPrefix}-${quoteIndex++}`,
						className: "translator-protected-quote",
						children: quotedText
					}));
					lastIndex = match.index + quotedText.length;
				}
				if (!fragments.length) return text;
				if (lastIndex < text.length) fragments.push(text.slice(lastIndex));
				return fragments.filter(fragment => fragment !== "");
			}

			highlightProtectedQuotesInNode (node, keyPrefix = "0") {
				if (!this.settings.general.protectQuotedText || node == null) return node;
				if (typeof node == "string") return this.buildProtectedQuoteFragments(node, keyPrefix);
				if (Array.isArray(node)) {
					let nextNodes = [];
					node.forEach((childNode, index) => {
						const highlightedNode = this.highlightProtectedQuotesInNode(childNode, `${keyPrefix}-${index}`);
						if (Array.isArray(highlightedNode)) nextNodes.push(...highlightedNode);
						else nextNodes.push(highlightedNode);
					});
					return nextNodes;
				}
				if (typeof node != "object" || this.isTranslatorInjectedElement(node) || !node.props) return node;
				if (typeof node.type == "string" && ["code", "pre"].includes(node.type)) return node;
				if (node.props.children != null) node.props.children = this.highlightProtectedQuotesInNode(node.props.children, `${keyPrefix}-c`);
				return node;
			}

			isDiscordSpoilerWrapperRule (rule) {
				const raw = (rule || "").trim();
				if (!raw) return false;
				if (/^\|{2,}$/.test(raw)) return true;
				let splitIndex = raw.indexOf("|");
				if (splitIndex < 1 || splitIndex >= raw.length - 1) return false;
				let left = raw.slice(0, splitIndex);
				let right = raw.slice(splitIndex + 1);
				return /^\|+$/.test(left) && /^\|+$/.test(right);
			}

			getWrapperPairItemsForSettings () {
				let wrapperPairs = BDFDB.ArrayUtils.is(this.settings.exceptions.wrapperPairs) ? this.settings.exceptions.wrapperPairs : [];
				return wrapperPairs.filter(rule => !this.isDiscordSpoilerWrapperRule(rule));
			}

			getProtectedWrapperRules () {
				let wrapperPairs = this.getWrapperPairItemsForSettings();
				return [...new Set(wrapperPairs.map(rule => (rule || "").trim()).filter(Boolean))].map(rule => {
					let splitIndex = rule.indexOf("|");
					if (splitIndex < 1 || splitIndex >= rule.length - 1) return null;
					let left = rule.slice(0, splitIndex);
					let right = rule.slice(splitIndex + 1);
					if (!left || !right) return null;
					return {left, right, raw: rule};
				}).filter(Boolean).sort((ruleA, ruleB) => (ruleB.left.length + ruleB.right.length) - (ruleA.left.length + ruleA.right.length));
			}

			findNextProtectedWrapperSegment (text, fromIndex = 0) {
				if (typeof text != "string" || !text) return null;
				let bestMatch = null;
				for (let rule of this.getProtectedWrapperRules()) {
					let startIndex = text.indexOf(rule.left, fromIndex);
					while (startIndex > -1) {
						let contentStart = startIndex + rule.left.length;
						let endIndex = text.indexOf(rule.right, contentStart);
						if (endIndex < 0) break;
						let fullText = text.slice(startIndex, endIndex + rule.right.length);
						let innerText = text.slice(contentStart, endIndex);
						if (innerText.trim() && !/[\r\n]/.test(fullText)) {
							let candidate = {startIndex, endIndex: endIndex + rule.right.length, fullText, innerText, rule};
							if (!bestMatch || candidate.startIndex < bestMatch.startIndex || candidate.startIndex == bestMatch.startIndex && fullText.length > bestMatch.fullText.length) bestMatch = candidate;
							break;
						}
						startIndex = text.indexOf(rule.left, contentStart);
					}
				}
				return bestMatch;
			}

			buildProtectedWrapperFragments (text, keyPrefix = "0") {
				if (typeof text != "string" || !text) return text;
				let fragments = [];
				let cursor = 0;
				let wrapperIndex = 0;
				while (cursor < text.length) {
					let match = this.findNextProtectedWrapperSegment(text, cursor);
					if (!match) break;
					if (match.startIndex > cursor) fragments.push(text.slice(cursor, match.startIndex));
					fragments.push(BDFDB.ReactUtils.createElement("span", {
						key: `translator-protected-quote-${keyPrefix}-${wrapperIndex++}`,
						className: "translator-protected-quote",
						children: match.fullText
					}));
					cursor = match.endIndex;
				}
				if (!fragments.length) return text;
				if (cursor < text.length) fragments.push(text.slice(cursor));
				return fragments.filter(fragment => fragment !== "");
			}

			highlightProtectedWrappedTextInNode (node, keyPrefix = "0") {
				if (node == null) return node;
				if (typeof node == "string") return this.buildProtectedWrapperFragments(node, keyPrefix);
				if (Array.isArray(node)) {
					let nextNodes = [];
					node.forEach((childNode, index) => {
						const highlightedNode = this.highlightProtectedWrappedTextInNode(childNode, `${keyPrefix}-${index}`);
						if (Array.isArray(highlightedNode)) nextNodes.push(...highlightedNode);
						else nextNodes.push(highlightedNode);
					});
					return nextNodes;
				}
				if (typeof node != "object" || this.isTranslatorInjectedElement(node) || !node.props) return node;
				if (typeof node.type == "string" && ["code", "pre"].includes(node.type)) return node;
				if (node.props.children != null) node.props.children = this.highlightProtectedWrappedTextInNode(node.props.children, `${keyPrefix}-c`);
				return node;
			}

			buildTranslationRequestText (originalContentData) {
				let allTextsToTranslate = originalContentData.content || "";
				(originalContentData.embeds || []).forEach(embed => {
					allTextsToTranslate += `\n__________________ __________________ __________________\n`;
					allTextsToTranslate += embed.title + "\n" + embed.description;
					(embed.fields || []).forEach(field => {
						allTextsToTranslate += "\n\n" + field.name + "__________________" + field.value;
					});
					if (embed.footerText) allTextsToTranslate += "\n" + embed.footerText;
				});
				return allTextsToTranslate.trim();
			}

			hasTranslatableMessageContent (originalContentData) {
				if (!originalContentData) return false;
				if ((originalContentData.content || "").trim()) return true;
				return (originalContentData.embeds || []).some(embed => (embed.title || "").trim() || (embed.description || "").trim() || (embed.footerText || "").trim() || (embed.fields || []).some(field => (field.name || "").trim() || (field.value || "").trim()));
			}

			buildReceivedDisplayContent (translatedContent, originalContent, forceInlineOriginal = false) {
				return translationDisplayLogic.buildReceivedDisplayContent(this, translatedContent, originalContent, forceInlineOriginal);
			}

			refreshTranslationDisplay (translation) {
				return translationDisplayLogic.refreshTranslationDisplay(this, translation);
			}

			getReceivedTranslationRequestConfigurationData (channelId) {
				return {
					protectionVersion: translationProtectionSignatureVersion,
					channelId: channelId || null,
					input: this.getLanguageChoice(languageTypes.INPUT, messageTypes.RECEIVED, channelId),
					output: this.getLanguageChoice(languageTypes.OUTPUT, messageTypes.RECEIVED, channelId),
					protectQuotedText: this.settings && this.settings.general && this.settings.general.protectQuotedText !== false,
					protectedTermsForReceived: this.getExceptionScopeSetting("protectedTermsForReceived", true),
					wrapperPairsForReceived: this.getExceptionScopeSetting("wrapperPairsForReceived", true),
					wrapperPairs: this.getProtectedWrapperRules().map(rule => rule.raw),
					protectedTerms: this.getProtectedTermsList().map(term => term.toLowerCase()),
					wordStart: BDFDB.ArrayUtils.is(this.settings && this.settings.exceptions && this.settings.exceptions.wordStart) ? this.settings.exceptions.wordStart.slice() : [],
					translator: this.getEffectivePrimaryEngine(channelId),
					backup: this.getEffectiveBackupEngine(channelId)
				};
			}

			getReceivedTranslationPolicyConfigurationData () {
				return {
					sourceLanguages: this.getReceivedAutoTranslateSourceLanguages(),
					autoDecisionMode: this.getAutoTranslateDecisionMode(),
					languageDetectionStrategy: this.getLanguageDetectionStrategy(),
					skipSameLanguage: this.shouldSkipSameLanguageReceivedMessages(),
					useLocalLanguagePrecheck: this.useLocalLanguagePrecheck(),
					treatLanguageVariantsAsSame: this.shouldTreatLanguageVariantsAsSame(),
					dropSimilarTranslations: this.shouldDropSimilarTranslations(),
					translationSimilarityThreshold: this.getTranslationSimilarityThreshold()
				};
			}

			getReceivedTranslationConfigurationData (channelId) {
				return Object.assign({}, this.getReceivedTranslationRequestConfigurationData(channelId), {
					policy: this.getReceivedTranslationPolicyConfigurationData()
				});
			}

			createReceivedTranslationSignature (message, channelId, originalContentData = null) {
				const sourceData = originalContentData || this.extractOriginalContentData(message);
				return JSON.stringify(Object.assign({}, this.getReceivedTranslationConfigurationData(channelId), {
					content: sourceData.content || "",
					embeds: sourceData.embeds || []
				}));
			}

			getCachedReceivedTranslation (message, channelId, originalContentData = null) {
				return this.ensureTranslationCacheStore().getCachedTranslation(message, channelId, originalContentData);
			}

			getCachedReceivedSkipDecision (message, channelId, originalContentData = null) {
				return this.ensureTranslationCacheStore().getCachedSkipDecision(message, channelId, originalContentData);
			}

			scheduleTranslationCacheSave () {
				return this.ensureTranslationCacheStore().scheduleSave();
			}

			persistTranslationCacheEntry (messageId, signature, translation) {
				return this.ensureTranslationCacheStore().persistTranslation(messageId, signature, translation);
			}

			shouldPersistReceivedSkipDecision (reason) {
				return this.ensureTranslationCacheStore().shouldPersistSkipDecision(reason);
			}

			hasCachedTranslationEntry (messageId) {
				return this.ensureTranslationCacheStore().hasEntry(messageId);
			}

			getPersistedTranslationCacheEntry (messageId) {
				return this.ensureTranslationCacheStore().getEntry(messageId);
			}

			seedRawTranslationCacheEntryForTest (messageId, signature, translation) {
				return this.ensureTranslationCacheStore().seedRawEntryForTest(messageId, signature, translation);
			}

			// The raw signature embeds the whole request configuration, so storing it verbatim
			// made it the majority of the persisted cache file. Every use is an equality check,
			// so a compact digest carries the same information at a fraction of the size.
			hashReceivedTranslationSignature (signature) {
				return this.ensureTranslationCacheStore().hashSignature(signature);
			}

			matchesCachedTranslationSignature (entry, signature) {
				return this.ensureTranslationCacheStore().matchesSignature(entry, signature);
			}

			getLoadedAutoTranslationSeenCount (channelId) {
				return loadedTranslationStatusStore.getSeenCount(channelId);
			}

			markLoadedAutoTranslationMessageSeen (channelId, messageId) {
				return loadedTranslationStatusStore.markMessageSeen(channelId, messageId);
			}

			hasStoredOriginalMessageClone (messageId) {
				return !!(messageId && oldMessages[messageId]);
			}

			persistReceivedSkipDecision (messageId, signature, reason, preview = "") {
				return this.ensureTranslationCacheStore().persistSkipDecision(messageId, signature, reason, preview);
			}

			clearCachedTranslation (messageId) {
				return this.ensureTranslationCacheStore().clear(messageId);
			}

			createReplyPreviewSignature (message, channelId, originalContent = null) {
				return JSON.stringify(Object.assign({}, this.getReceivedTranslationConfigurationData(channelId), {
					content: originalContent != null ? originalContent : message && message.content || ""
				}));
			}

			getReplyPreviewTranslation (message, channelId) {
				if (!message || !message.id) return null;
				const storedTranslation = replyPreviewTranslations[message.id];
				if (!storedTranslation) return null;
				const signature = this.createReplyPreviewSignature(message, channelId);
				if (storedTranslation.signature != signature) {
					delete replyPreviewTranslations[message.id];
					return null;
				}
				return storedTranslation;
			}

			createReplyPreviewTranslationData (message, channelId, translation) {
				if (!message || !translation) return null;
				translation = this.normalizeStoredTranslationData(translation);
				const translatedContent = (translation.translatedContent || translation.content || "").trim();
				const originalContent = (translation.originalContent != null ? translation.originalContent : message.content) || "";
				if (!translatedContent) return null;
				return {
					signature: this.createReplyPreviewSignature(message, channelId, originalContent),
					channelId,
					auto: !!translation.auto,
					translatedContent,
					originalContent,
					input: translation.input,
					output: translation.output
				};
			}

			getReplyPreviewDisplayContent (translation) {
				return translationDisplayLogic.getReplyPreviewDisplayContent(this, translation);
			}

			stripReplyPreviewOriginalSuffix (content) {
				return translationDisplayLogic.stripReplyPreviewOriginalSuffix(this, content);
			}

			getStableReplyPreviewOriginalContent (message) {
				return translationDisplayLogic.getStableReplyPreviewOriginalContent(this, message);
			}

			getStableReplyPreviewMessage (message) {
				return translationDisplayLogic.getStableReplyPreviewMessage(this, message);
			}

			getReplyPreviewFallbackContent (message) {
				return translationDisplayLogic.getReplyPreviewFallbackContent(this, message);
			}
			getReplyPreviewDisplayContentForMessage (message, channelId = null) {
				return translationDisplayLogic.getReplyPreviewDisplayContentForMessage(this, message, channelId);
			}

			tagReplyPreviewRenderNode (node) {
				if (node == null) return node;
				if (BDFDB.ArrayUtils.is(node)) return node.map(child => this.tagReplyPreviewRenderNode(child));
				const isValidElement = BDFDB.ReactUtils && typeof BDFDB.ReactUtils.isValidElement == "function" ? BDFDB.ReactUtils.isValidElement(node) : !!(node && typeof node == "object" && node.props);
				if (!isValidElement || !node.props) return node;

				const props = Object.assign({}, node.props);
				const className = typeof props.className == "string" ? props.className : "";
				const lowerClassName = className.toLowerCase();
				const extraClasses = [];

				if (lowerClassName.includes("reply") || lowerClassName.includes("replied") || lowerClassName.includes("referenced")) extraClasses.push("translator-reply-preview-body");
				if (lowerClassName.includes("repliedtext") || lowerClassName.includes("replycontent") || lowerClassName.includes("messagecontent")) {
					extraClasses.push("translator-reply-preview-text");
					props.style = Object.assign({}, props.style, {
						whiteSpace: "pre-wrap",
						overflow: "visible",
						textOverflow: "unset",
						maxHeight: "none",
						height: "auto",
						display: "block",
						WebkitLineClamp: "unset",
						lineClamp: "unset"
					});
					if (typeof props.children == "string") props.children = props.children.replace(/\n+/g, "\n");
				}
				if (extraClasses.length) props.className = BDFDB.DOMUtils.formatClassName(className, ...extraClasses);
				if (props.children != null) props.children = this.tagReplyPreviewRenderNode(props.children);
				return BDFDB.ReactUtils.createElement(node.type, Object.assign({}, props, {key: node.key, ref: node.ref}));
			}

			queueReplyPreviewTranslation (message, channelId, contextOptions = {}) {
				if (!message || !message.id || !channelId || queuedReplyPreviewTranslations[message.id]) return;
				const baseMessage = contextOptions.baseMessage || null;
				if (baseMessage && !this.shouldAutoTranslateReplyPreview(baseMessage, message, channelId)) return;
				if (suppressedAutoTranslations[message.id]) return;
				if (!this.isTranslationEnabled(channelId) || this.isOwnMessage(message)) return;
				const originalContent = (message.content || "").trim();
				if (!originalContent) return;
				const signature = this.createReplyPreviewSignature(message, channelId, originalContent);
				const existingTranslation = replyPreviewTranslations[message.id];
				if (existingTranslation && existingTranslation.signature == signature) return;
				const cachedTranslation = this.getCachedReceivedTranslation(message, channelId);
				if (cachedTranslation) {
					const previewTranslation = this.createReplyPreviewTranslationData(message, channelId, cachedTranslation);
					if (previewTranslation) replyPreviewTranslations[message.id] = previewTranslation;
					return;
				}
				const request = {channelId, signature};
				queuedReplyPreviewTranslations[message.id] = request;
				this.translateText(originalContent, messageTypes.RECEIVED, (translation, input, output) => {
					if (!pluginRuntimeActive || queuedReplyPreviewTranslations[message.id] !== request) return;
					delete queuedReplyPreviewTranslations[message.id];
					if (this.createReplyPreviewSignature(message, channelId, (message.content || "").trim()) != signature) return;
					if (baseMessage && !this.shouldAutoTranslateReplyPreview(baseMessage, message, channelId)) return;
					if (!this.isTranslationEnabled(channelId)) return;
					if (translation) {
						replyPreviewTranslations[message.id] = {
							signature,
							channelId,
							auto: true,
							translatedContent: (translation || "").trim(),
							originalContent,
							input,
							output
						};
						this.scheduleTranslationRerender({batched: true});
					}
				}, null, {
					showToast: false,
					showFailureToast: false,
					trackBusy: false,
					channelId
				});
			}

			resetAutoTranslationTracking (channelId = null) {
				return receivedTranslationRuntime.resetAutoTranslationTracking(this, channelId);
			}

			getAutoTranslationChannelState (channelId) {
				return receivedTranslationRuntime.getAutoTranslationChannelState(this, channelId);
			}

			prepareAutoTranslationChannelSession (channelId) {
				return receivedTranslationRuntime.prepareAutoTranslationChannelSession(this, channelId);
			}

			compareMessageIds (messageIdA, messageIdB) {
				if (!messageIdA && !messageIdB) return 0;
				if (!messageIdA) return -1;
				if (!messageIdB) return 1;
				try {
					const comparableA = BigInt(messageIdA);
					const comparableB = BigInt(messageIdB);
					if (comparableA == comparableB) return 0;
					return comparableA > comparableB ? 1 : -1;
				}
				catch (err) {
					const normalizedA = String(messageIdA);
					const normalizedB = String(messageIdB);
					if (normalizedA == normalizedB) return 0;
					if (normalizedA.length != normalizedB.length) return normalizedA.length > normalizedB.length ? 1 : -1;
					return normalizedA > normalizedB ? 1 : -1;
				}
			}

			getNewestMessageId (currentMessageId, candidateMessageId) {
				return this.compareMessageIds(candidateMessageId, currentMessageId) > 0 ? candidateMessageId : currentMessageId;
			}

			isMessageIdNewer (messageId, referenceMessageId) {
				if (!messageId) return false;
				if (!referenceMessageId) return true;
				return this.compareMessageIds(messageId, referenceMessageId) > 0;
			}

			clearAutoTranslationEligibleReplyPreviewMessages (channelId = null) {
				if (!channelId) autoTranslationEligibleReplyPreviewMessages = {};
				else delete autoTranslationEligibleReplyPreviewMessages[channelId];
			}

			markAutoTranslationEligibleReplyPreviewMessage (channelId, messageId) {
				if (!channelId || !messageId) return;
				if (!autoTranslationEligibleReplyPreviewMessages[channelId]) autoTranslationEligibleReplyPreviewMessages[channelId] = {};
				autoTranslationEligibleReplyPreviewMessages[channelId][messageId] = true;
			}

			isAutoTranslationEligibleReplyPreviewMessage (channelId, messageId) {
				return !!(channelId && messageId && autoTranslationEligibleReplyPreviewMessages[channelId] && autoTranslationEligibleReplyPreviewMessages[channelId][messageId]);
			}

			cleanupReplyPreviewRenderMarks () {
				replyPreviewRenderMessageIds = {};
			}

			markReplyPreviewRenderMessage (message) {
				if (message && typeof message == "object") {
					try {message.__DiscordAITranslatorReplyPreview = true;}
					catch (err) {}
				}
			}

			isRenderingReplyPreviewMessage (message) {
				return !!(message && typeof message == "object" && message.__DiscordAITranslatorReplyPreview);
			}

			clearReplyPreviewRenderMessage (message) {
				if (message && typeof message == "object") {
					try {delete message.__DiscordAITranslatorReplyPreview;}
					catch (err) {}
				}
			}

			pauseHistoricalAutoTranslationForNavigation (duration = 1800) {
				return this.ensureMessageViewportStore().pauseForNavigation(duration);
			}

			wrapReplyPreviewJumpPause (node) {
				if (node == null) return node;
				if (BDFDB.ArrayUtils.is(node)) return node.map(child => this.wrapReplyPreviewJumpPause(child));
				const isValidElement = BDFDB.ReactUtils && typeof BDFDB.ReactUtils.isValidElement == "function" ? BDFDB.ReactUtils.isValidElement(node) : !!(node && typeof node == "object" && node.props);
				if (!isValidElement || !node.props) return node;
				const props = Object.assign({}, node.props);
				const oldMouseDownCapture = props.onMouseDownCapture;
				const oldClickCapture = props.onClickCapture;
				const pause = event => {
					this.pauseHistoricalAutoTranslationForNavigation(1800);
				};
				props.onMouseDownCapture = event => {
					pause(event);
					if (typeof oldMouseDownCapture == "function") oldMouseDownCapture(event);
				};
				props.onClickCapture = event => {
					pause(event);
					if (typeof oldClickCapture == "function") oldClickCapture(event);
				};
				return BDFDB.ReactUtils.createElement(node.type, Object.assign({}, props, {key: node.key, ref: node.ref}));
			}

			stripTranslatorStylingFromReplyPreviewNode (node) {
				if (node == null) return node;
				if (BDFDB.ArrayUtils.is(node)) return node.map(child => this.stripTranslatorStylingFromReplyPreviewNode(child)).filter(Boolean);
				const isValidElement = BDFDB.ReactUtils && typeof BDFDB.ReactUtils.isValidElement == "function" ? BDFDB.ReactUtils.isValidElement(node) : !!(node && typeof node == "object" && node.props);
				if (!isValidElement || !node.props) return node;
				const props = Object.assign({}, node.props);
				if (typeof props.className == "string") props.className = props.className
					.split(/\s+/)
					.filter(className => className && className.toLowerCase().indexOf("translator") == -1)
					.join(" ");
				if (props.style) {
					props.style = Object.assign({}, props.style);
					delete props.style["--translator-accent-color"];
					delete props.style["--translator-text-color"];
					delete props.style.color;
					delete props.style.background;
					delete props.style.backgroundColor;
					delete props.style.borderLeft;
				}
				if (props.children != null) {
					const children = BDFDB.ArrayUtils.is(props.children) ? props.children : [props.children];
					props.children = children
						.filter(child => !this.isTranslatorInjectedElement(child))
						.map(child => this.stripTranslatorStylingFromReplyPreviewNode(child));
				}
				return BDFDB.ReactUtils.createElement(node.type, Object.assign({}, props, {key: node.key, ref: node.ref}));
			}

			shouldAutoTranslateReplyPreview (baseMessage, referencedMessage, channelId) {
				if (!this.settings.general.showOriginalInReplyPreview) return false;
				if (!channelId || !baseMessage || !baseMessage.id || !referencedMessage || !referencedMessage.id) return false;
				if (!this.isTranslationEnabled(channelId)) return false;
				if (this.isOwnMessage(baseMessage) || this.isOwnMessage(referencedMessage)) return false;
				if (suppressedAutoTranslations[referencedMessage.id]) return false;
				if (this.getReceivedAutoTranslateScope() == "loaded_messages") return this.isMessageWithinLoadedRange(baseMessage);
				return this.isAutoTranslationEligibleReplyPreviewMessage(channelId, baseMessage.id);
			}

			getMessagesScroller () {
				return this.ensureMessageViewportStore().getMessagesScroller();
			}

			extractMessageIdFromElement (element) {
				return this.ensureMessageViewportStore().extractMessageIdFromElement(element);
			}

			findMessageElementById (messageId) {
				return this.ensureMessageViewportStore().findMessageElementById(messageId);
			}

			findVisibleMessageAnchorElement (messagesScroller = null) {
				return this.ensureMessageViewportStore().findVisibleMessageAnchor(messagesScroller);
			}

			captureMessageAnchorState (messageId = null) {
				return this.ensureMessageViewportStore().captureAnchorState(messageId);
			}

			restoreMessageAnchorPosition (anchorState) {
				return this.ensureMessageViewportStore().restoreAnchorPosition(anchorState);
			}

			restoreMessageAnchorState (anchorState) {
				return this.ensureMessageViewportStore().restoreAnchorState(anchorState);
			}

			lockManualTranslationScroll (messageId) {
				return this.ensureMessageViewportStore().lockManualScroll(messageId);
			}

			getActiveManualTranslationScrollAnchor () {
				return this.ensureMessageViewportStore().getActiveManualScrollAnchor();
			}

			captureMessageScrollerState () {
				return this.ensureMessageViewportStore().captureScrollerState();
			}

			restoreMessageScrollerState (scrollerState) {
				return this.ensureMessageViewportStore().restoreScrollerState(scrollerState);
			}

			rerenderMessagesWithScrollPreserved () {
				this.attachAutoTranslationScrollWatcher();
				const manualAnchor = this.getActiveManualTranslationScrollAnchor();
				const scrollerState = manualAnchor ? null : this.captureMessageScrollerState();
				BDFDB.PatchUtils.forceAllUpdates(this, TRANSLATION_MESSAGE_PATCH_TYPES);
				if (manualAnchor) this.restoreMessageAnchorState(manualAnchor);
				else this.restoreMessageScrollerState(scrollerState);
			}

			getLoadedAutoTranslationStatusText (status) {
				return loadedTranslationStatusStore.getStatusText(status);
			}

			getLoadedAutoTranslationSkipReasonText (reason) {
				switch (reason) {
					case "symbol_only": return this.isChineseUiLanguage() ? "\u7eaf\u7b26\u53f7/\u65e0\u81ea\u7136\u8bed\u8a00" : "symbol-only/no natural language";
					case "link_only": return this.isChineseUiLanguage() ? "\u4ec5\u94fe\u63a5/\u53d7\u4fdd\u62a4\u5185\u5bb9" : "link-only/protected content";
					case "same_language": return this.isChineseUiLanguage() ? "\u540c\u76ee\u6807\u8bed\u8a00" : "same target language";
					case "too_similar": return this.isChineseUiLanguage() ? "\u4e0e\u539f\u6587\u8fc7\u4e8e\u76f8\u4f3c" : "too similar to source";
					case "wrong_target_language": return this.isChineseUiLanguage() ? "\u8fd4\u56de\u8bed\u8a00\u4e0d\u5bf9" : "wrong target language";
					case "ai_skip_signal": return this.isChineseUiLanguage() ? "AI\u5224\u5b9a\u65e0\u9700\u7ffb\u8bd1" : "AI skipped translation";
					case "source_filter": return this.isChineseUiLanguage() ? "\u4e0d\u5728\u6e90\u8bed\u8a00\u7b5b\u9009\u5185" : "outside source-language filter";
					case "local_guard": return this.isChineseUiLanguage() ? "\u672c\u5730\u4fdd\u62a4\u5140\u5e95\u4e22\u5f03" : "dropped by local safeguard";
					case "out_of_range": return this.isChineseUiLanguage() ? "\u8d85\u51fa\u5f53\u524d\u5df2\u52a0\u8f7d\u8303\u56f4" : "outside loaded range";
					default: return reason || (this.isChineseUiLanguage() ? "\u5df2\u8df3\u8fc7" : "skipped");
				}
			}

			getLoadedAutoTranslationPreviewText (text) {
				return loadedTranslationStatusStore.getPreviewText(text);
			}

			getLoadedAutoTranslationStatusTitleText (status) {
				if (!status) return "";
				const baseText = this.getLoadedAutoTranslationStatusText(status);
				const detailParts = [];
				if (status && status.lastSkipReason) detailParts.push(this.getLoadedAutoTranslationSkipReasonText(status.lastSkipReason));
				if (status && status.lastSkipPreview) detailParts.push(status.lastSkipPreview);
				return detailParts.length ? `${baseText} | ${this.isChineseUiLanguage() ? "\u6700\u8fd1\u8df3\u8fc7" : "Last skipped"}: ${detailParts.join(" | ")}` : baseText;
			}

			getAutoTranslatedResultRejectReason (translation, channelId) {
				return receivedMessageFilterRuntime.getAutoTranslatedResultRejectReason(this, translation, channelId);
			}

			getReceivedAutoTranslateSkipReason (originalContentData, channelId) {
				return receivedMessageFilterRuntime.getReceivedAutoTranslateSkipReason(this, originalContentData, channelId);
			}

			getLoadedAutoTranslationInlineStatusText (channelId = null) {
				return loadedTranslationStatusStore.getInlineStatusText(channelId || BDFDB.LibraryStores.SelectedChannelStore.getChannelId());
			}

			updateInlineLoadedAutoTranslationStatusElements () {
				if (typeof document == "undefined") return;
				let elements = [];
				try {elements = Array.from(document.querySelectorAll(".translator-loaded-status-inline"));}
				catch (err) {elements = [];}
				for (const element of elements) {
					if (element && element.remove) element.remove();
				}
			}

			findNativeTextAreaStatusElement (anchorRect = null) {
				if (typeof document == "undefined") return null;
				let candidates = [];
				try {candidates = Array.from(document.querySelectorAll("div, span"));}
				catch (err) {return null;}
				const matches = candidates.map(element => {
					if (!element || element.id == "DiscordAITranslator-loaded-status" || !element.getBoundingClientRect) return null;
					const text = (element.textContent || "").trim();
					if (!text || !(/慢速模式|slow\s*mode|slowmode/i.test(text))) return null;
					const rect = element.getBoundingClientRect();
					if (!rect.width || !rect.height) return null;
					if (anchorRect) {
						const nearInputTop = rect.bottom <= anchorRect.top + 10 && rect.bottom >= anchorRect.top - 42;
						const nearInputRight = rect.right <= anchorRect.right + 24 && rect.right >= anchorRect.left + anchorRect.width * 0.45;
						const aboveInput = rect.top >= anchorRect.top - 58 && rect.top <= anchorRect.top + 8;
						if (!nearInputTop || !nearInputRight || !aboveInput) return null;
					}
					return {element, rect, score: rect.right + rect.bottom};
				}).filter(Boolean).sort((a, b) => b.score - a.score);
				return matches[0] && matches[0].element || null;
			}

			isTranslateMasterSwitchVisuallyEnabled (channelId) {
				if (!channelId || !this.isTranslationEnabled(channelId)) return false;
				if (typeof document == "undefined") return false;
				let buttons = [];
				try {
					const selector = [BDFDB.dotCN && BDFDB.dotCN._translatortranslatebutton, BDFDB.disCN && "." + BDFDB.disCN._translatortranslatebutton].filter(Boolean).join(",");
					buttons = selector ? Array.from(document.querySelectorAll(selector)) : [];
				}
				catch (err) {buttons = [];}
				if (!buttons.length) return false;
				return buttons.some(button => button && button.classList && button.classList.contains(BDFDB.disCN._translatortranslating));
			}

			positionLoadedAutoTranslationStatusElement (element) {
				if (!element || typeof document == "undefined") return;
				const selectors = [BDFDB.dotCN && BDFDB.dotCN.channeltextarea, '[class*="channelTextArea"]', 'form [role="textbox"]'];
				let anchors = [];
				for (const selector of selectors) {
					if (!selector) continue;
					try {anchors = anchors.concat(Array.from(document.querySelectorAll(selector)).filter(Boolean));}
					catch (err) {}
				}
				anchors = anchors.map(anchor => {
					if (!anchor || !anchor.getBoundingClientRect) return null;
					const rect = anchor.getBoundingClientRect();
					if (!rect.width || !rect.height) return null;
					const visible = rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
					if (!visible) return null;
					const nearBottom = Math.max(0, window.innerHeight - rect.bottom);
					const widthScore = Math.min(rect.width, 900);
					const score = widthScore - nearBottom * 2 + rect.right * 0.05;
					return {anchor, rect, score};
				}).filter(Boolean).sort((a, b) => b.score - a.score);
				const anchorData = anchors[0];
				const anchor = anchorData && anchorData.anchor;
				const viewportPadding = 12;
				let maxStatusWidth = Math.max(180, Math.min(360, window.innerWidth - viewportPadding * 2));
				if (anchor && anchor.getBoundingClientRect) {
					const anchorRect = anchor.getBoundingClientRect();
					if (anchorRect && anchorRect.width) maxStatusWidth = Math.max(180, Math.min(maxStatusWidth, Math.floor(anchorRect.width * 0.55), anchorRect.width - 16));
				}
				element.style.maxWidth = `${Math.round(maxStatusWidth)}px`;
				const measuredRect = element.getBoundingClientRect ? element.getBoundingClientRect() : null;
				const statusWidth = Math.max(180, Math.min(measuredRect && measuredRect.width || element.offsetWidth || 260, maxStatusWidth));
				const statusHeight = Math.max(18, measuredRect && measuredRect.height || element.offsetHeight || 20);
				element.style.right = "auto";
				element.style.bottom = "auto";
				if (anchor && anchor.getBoundingClientRect) {
					const rect = anchor.getBoundingClientRect();
					const nativeStatus = this.findNativeTextAreaStatusElement(rect);
					let left = rect.right - statusWidth - viewportPadding;
					let top = rect.top - statusHeight - 8;
					if (nativeStatus && nativeStatus.getBoundingClientRect) {
						const nativeRect = nativeStatus.getBoundingClientRect();
						// 检测到 Discord 原生“慢速模式已开启”时，放在它的上方并右对齐，不再横向挪到频道列表。
						left = Math.max(rect.left + 8, Math.min(nativeRect.right - statusWidth, rect.right - statusWidth - 8));
						top = nativeRect.top - statusHeight - 8;
					}
					else {
						left = Math.max(rect.left + 8, Math.min(left, rect.right - statusWidth - 8));
					}
					top = Math.max(viewportPadding, Math.min(top, window.innerHeight - statusHeight - viewportPadding));
					element.style.left = `${Math.round(left)}px`;
					element.style.top = `${Math.round(top)}px`;
				}
				else {
					element.style.left = `${Math.max(viewportPadding, window.innerWidth - statusWidth - 108)}px`;
					element.style.top = `${Math.max(viewportPadding, window.innerHeight - statusHeight - 54)}px`;
				}
			}

			isChannelTextAreaFocused () {
				return this.ensureMessageViewportStore().isChannelTextAreaFocused();
			}

			ensureLoadedAutoTranslationStatusPositionWatcher () {
				if (typeof window == "undefined" || this._loadedAutoTranslationStatusPositionWatcherAttached) return;
				this._loadedAutoTranslationStatusPositionWatcherAttached = true;
				this._loadedAutoTranslationStatusPositionHandler = _ => {
					const element = typeof document != "undefined" && document.getElementById("DiscordAITranslator-loaded-status");
					if (!element) return;
					if (this._loadedAutoTranslationStatusPositionTimer) clearTimeout(this._loadedAutoTranslationStatusPositionTimer);
					this._loadedAutoTranslationStatusPositionTimer = setTimeout(_ => {
						this._loadedAutoTranslationStatusPositionTimer = null;
						this.positionLoadedAutoTranslationStatusElement(element);
					}, 80);
				};
				window.addEventListener("resize", this._loadedAutoTranslationStatusPositionHandler, {passive: true});
				window.addEventListener("scroll", this._loadedAutoTranslationStatusPositionHandler, true);
				try {
					if (typeof ResizeObserver != "undefined" && document && document.body) {
						this._loadedAutoTranslationStatusResizeObserver = new ResizeObserver(this._loadedAutoTranslationStatusPositionHandler);
						this._loadedAutoTranslationStatusResizeObserver.observe(document.body);
					}
				}
				catch (err) {}
			}

			detachLoadedAutoTranslationStatusPositionWatcher () {
				if (typeof window == "undefined" || !this._loadedAutoTranslationStatusPositionWatcherAttached) return;
				this._loadedAutoTranslationStatusPositionWatcherAttached = false;
				if (this._loadedAutoTranslationStatusPositionHandler) {
					window.removeEventListener("resize", this._loadedAutoTranslationStatusPositionHandler, {passive: true});
					window.removeEventListener("scroll", this._loadedAutoTranslationStatusPositionHandler, true);
				}
				if (this._loadedAutoTranslationStatusResizeObserver) {
					try {this._loadedAutoTranslationStatusResizeObserver.disconnect();}
					catch (err) {}
				}
				this._loadedAutoTranslationStatusResizeObserver = null;
				if (this._loadedAutoTranslationStatusPositionTimer) clearTimeout(this._loadedAutoTranslationStatusPositionTimer);
				this._loadedAutoTranslationStatusPositionTimer = null;
				this._loadedAutoTranslationStatusPositionHandler = null;
			}

			isTranslatorSettingsSurfaceOpen () {
				if (typeof document == "undefined") return false;
				try {
					// Only this plugin's own settings/quick panels should hide the floating status.
					// Generic Discord settings containers can remain in the DOM after closing and were hiding the capsule.
					return !!document.querySelector(".translator-settings-panel-root");
				}
				catch (err) {return false;}
			}

			removeLoadedAutoTranslationStatusElement () {
				const element = typeof document != "undefined" && document.getElementById("DiscordAITranslator-loaded-status");
				if (element) element.remove();
				this.detachLoadedAutoTranslationStatusPositionWatcher();
			}

			shouldShowLoadedAutoTranslationStatus (status) {
				if (!status || (!status.active && !status.done)) return false;
				const selectedChannelId = BDFDB.LibraryStores.SelectedChannelStore.getChannelId();
				const statusChannelId = status.channelId && status.channelId != "__global" ? status.channelId : selectedChannelId;
				if (!statusChannelId || !selectedChannelId || statusChannelId != selectedChannelId) return false;
				if (this.getReceivedAutoTranslateScope() != "loaded_messages") return false;
				return this.isTranslationEnabled(statusChannelId);
			}

			updateLoadedAutoTranslationStatus (updates = {}) {
				const currentStatus = loadedTranslationStatusStore.update(updates);
				if (!this.shouldShowLoadedAutoTranslationStatus(currentStatus)) {
					this.removeLoadedAutoTranslationStatusElement();
					return;
				}
				loadedTranslationStatusStore.cancelHide();
				if (typeof document == "undefined" || !document.body) return;
				this.attachAutoTranslationScrollWatcher();
				this.ensureLoadedAutoTranslationStatusPositionWatcher();
				let element = document.getElementById("DiscordAITranslator-loaded-status");
				if (!element) {
					element = document.createElement("div");
					element.id = "DiscordAITranslator-loaded-status";
					document.body.appendChild(element);
				}
				const retryableCount = Math.max(0, currentStatus.retryable || 0);
				const showRetry = !currentStatus.active && retryableCount > 0;
				// Always normalize the status DOM. This removes legacy progress-line children left by earlier builds.
				element.className = `translator-loaded-status-floating${showRetry ? " translator-loaded-status-retryable" : ""}`;
				if (!element.querySelector(".translator-loaded-status-text") || element.querySelector(".translator-loaded-status-progress")) {
					element.innerHTML = '<span class="translator-loaded-status-dot"></span><span class="translator-loaded-status-text"></span>';
				}
				const textElement = element.querySelector(".translator-loaded-status-text");
				if (textElement) textElement.textContent = this.getLoadedAutoTranslationStatusText(currentStatus);
				let retryButton = element.querySelector(".translator-loaded-status-retry");
				if (showRetry) {
					if (!retryButton) {
						retryButton = document.createElement("button");
						retryButton.type = "button";
						retryButton.className = "translator-loaded-status-retry";
						element.appendChild(retryButton);
					}
					retryButton.textContent = this.isChineseUiLanguage() ? "重试" : "Retry";
					retryButton.title = this.isChineseUiLanguage() ? `重试 ${retryableCount} 条失败消息` : `Retry ${retryableCount} failed messages`;
					retryButton.onclick = event => {
						if (event && event.stopPropagation) event.stopPropagation();
						const retryResult = this.retryFailedHistoricalTranslations(currentStatus.channelId);
						if (retryResult && typeof retryResult.catch == "function") retryResult.catch(_ => {});
					};
				}
				else if (retryButton) retryButton.remove();
				element.title = this.getLoadedAutoTranslationStatusTitleText(currentStatus);
				this.updateInlineLoadedAutoTranslationStatusElements();
				this.positionLoadedAutoTranslationStatusElement(element);
				requestAnimationFrame(_ => this.positionLoadedAutoTranslationStatusElement(element));
			}

			hideLoadedAutoTranslationStatus (delay = 1600) {
				loadedTranslationStatusStore.cancelHide();
				// In loaded-message mode the capsule is a persistent channel status, not a transient toast.
				// Keep it visible while the feature is enabled; clearLoadedAutoTranslationStatus removes it when disabled.
				if (this.shouldShowLoadedAutoTranslationStatus(loadedTranslationStatusStore.getStatus())) {
					this.updateLoadedAutoTranslationStatus({});
					return;
				}
				loadedTranslationStatusStore.scheduleHide(() => this.removeLoadedAutoTranslationStatusElement(), delay);
			}

			clearLoadedAutoTranslationStatus () {
				loadedTranslationStatusStore.clear();
				const element = typeof document != "undefined" && document.getElementById("DiscordAITranslator-loaded-status");
				if (element) element.remove();
				this.detachLoadedAutoTranslationStatusPositionWatcher();
				this.updateInlineLoadedAutoTranslationStatusElements();
			}

			scheduleTranslationRerender (options = {}) {
				const config = typeof options == "boolean" ? {batched: options} : Object.assign({batched: false, allowWhileSettings: false, allowWhileTyping: false}, options);
				// Hard rule: while plugin settings/quick strategy panels are open, loaded-history
				// translation may continue updating state, but it must not repaint the chat list.
				if (!config.allowWhileSettings && this.isTranslatorSettingsSurfaceOpen()) {
					deferredTranslationRerenderPending = true;
					if (!deferredSettingsRerenderTimer) deferredSettingsRerenderTimer = setTimeout(_ => {
						deferredSettingsRerenderTimer = null;
						this.scheduleTranslationRerender({batched: true});
					}, 1000);
					return;
				}
				if (!config.allowWhileTyping && this.isChannelTextAreaFocused()) {
					if (deferredTextAreaRerenderTimer) clearTimeout(deferredTextAreaRerenderTimer);
					deferredTextAreaRerenderTimer = setTimeout(_ => {
						deferredTextAreaRerenderTimer = null;
						this.scheduleTranslationRerender(Object.assign({}, config, {batched: true}));
					}, 450);
					return;
				}
				if (deferredTextAreaRerenderTimer) {
					clearTimeout(deferredTextAreaRerenderTimer);
					deferredTextAreaRerenderTimer = null;
				}
				deferredTranslationRerenderPending = false;
				if (!config.batched) {
					if (translationRerenderTimer) clearTimeout(translationRerenderTimer);
					translationRerenderTimer = null;
					this.rerenderMessagesWithScrollPreserved();
					return;
				}
				if (translationRerenderTimer) return;
				const rerenderDelay = this.isViewingMessageHistory() ? AUTO_TRANSLATION_HISTORY_RERENDER_DELAY : AUTO_TRANSLATION_RERENDER_DELAY;
				translationRerenderTimer = setTimeout(_ => {
					translationRerenderTimer = null;
					this.rerenderMessagesWithScrollPreserved();
				}, rerenderDelay);
			}

			flushDeferredTranslationRerender () {
				if (!deferredTranslationRerenderPending) return;
				deferredTranslationRerenderPending = false;
				this.scheduleTranslationRerender({batched: true});
			}

			getDisplayedTranslationChannelId (messageId) {
				if (!messageId) return null;
				const translation = translatedMessages[messageId];
				if (translation && translation.channelId) return translation.channelId;
				if (oldMessages[messageId] && oldMessages[messageId].channel_id) return oldMessages[messageId].channel_id;
				const displayView = this.getReceivedDisplayRuntimeView(messageId);
				return displayView && displayView.channelId || null;
			}

			getMessageChannelId (message, fallbackChannelId = null) {
				return message && (message.channel_id || message.channelId) || fallbackChannelId || BDFDB.LibraryStores.SelectedChannelStore.getChannelId();
			}

			createLiveTranslationRequest (message, channelId, originalContentData = null, signature = null) {
				return receivedTranslationRuntime.createLiveTranslationRequest(this, message, channelId, originalContentData, signature);
			}

			isLiveTranslationRequestCurrent (request, message = null) {
				return receivedTranslationRuntime.isLiveTranslationRequestCurrent(this, request, message);
			}

			finishLiveTranslationRequest (request) {
				return receivedTranslationRuntime.finishLiveTranslationRequest(this, request);
			}

			invalidateLiveTranslationRequests (channelId = null) {
				return receivedTranslationRuntime.invalidateLiveTranslationRequests(this, channelId);
			}

			invalidateLiveTranslationMessage (messageId, channelId, currentSignature) {
				return receivedTranslationRuntime.invalidateLiveTranslationMessage(this, messageId, channelId, currentSignature);
			}

			clearAutoTranslationQueue (channelId = null) {
				return receivedTranslationRuntime.clearAutoTranslationQueue(this, channelId);
			}

			clearDisplayedTranslations (channelId = null) {
				for (const messageId of Object.keys(translatedMessages)) {
					if (channelId && this.getDisplayedTranslationChannelId(messageId) != channelId) continue;
					this.clearDisplayedTranslationState(messageId);
				}
				for (const messageId of Object.keys(replyPreviewTranslations)) {
					if (channelId && replyPreviewTranslations[messageId].channelId != channelId) continue;
					delete replyPreviewTranslations[messageId];
					delete queuedReplyPreviewTranslations[messageId];
				}
			}

			clearDisplayedAutoTranslations (channelId = null) {
				for (const messageId of Object.keys(translatedMessages)) {
					const translation = translatedMessages[messageId];
					if (!translation || !translation.auto) continue;
					if (channelId && this.getDisplayedTranslationChannelId(messageId) != channelId) continue;
					this.clearDisplayedTranslationState(messageId);
				}
				for (const messageId of Object.keys(replyPreviewTranslations)) {
					const translation = replyPreviewTranslations[messageId];
					if (!translation || !translation.auto) continue;
					if (channelId && translation.channelId != channelId) continue;
					delete replyPreviewTranslations[messageId];
					delete queuedReplyPreviewTranslations[messageId];
				}
				this.clearChannelTitleTranslations(channelId);
			}

			applyStoredTranslationToMessage (message, translation, originalContentData = null) {
				return translationDisplayLogic.applyStoredTranslationToMessage(this, message, translation, originalContentData);
			}

			getMentionDisplayName (userId, message = null) {
				if (!userId) return null;
				const mentionUsers = message && (message.mentions || message.mentioned_users || message.referencedMessage && message.referencedMessage.mentions);
				if (Array.isArray(mentionUsers)) {
					const mentionUser = mentionUsers.find(user => user && String(user.id) == String(userId));
					if (mentionUser) return mentionUser.globalName || mentionUser.global_name || mentionUser.displayName || mentionUser.nick || mentionUser.username || mentionUser.name || null;
				}
				try {
					const user = BDFDB.LibraryStores.UserStore && BDFDB.LibraryStores.UserStore.getUser && BDFDB.LibraryStores.UserStore.getUser(userId);
					if (user) return user.globalName || user.global_name || user.displayName || user.username || user.name || null;
				}
				catch (err) {}
				return null;
			}

			restoreDiscordMentionTagsForDisplay (text, message = null) {
				if (typeof text != "string" || !text) return text;
				return text.replace(/<@!?(\d+)>/g, (fullMatch, userId) => {
					const displayName = this.getMentionDisplayName(userId, message);
					return displayName ? `@${displayName}` : fullMatch;
				});
			}

			clearDisplayedTranslationState (messageId, options = {}) {
				return translationDisplayLogic.clearDisplayedTranslationState(this, messageId, options);
			}

			getStoredTranslationChannelId (messageId, fallbackChannelId = null, translation = null) {
				return translationDisplayLogic.getStoredTranslationChannelId(this, messageId, fallbackChannelId, translation);
			}

			shouldDisplayStoredTranslation (translation, channelId = null) {
				return translationDisplayLogic.shouldDisplayStoredTranslation(this, translation, channelId);
			}

			getStoredTranslationOriginalContent (translation, fallbackContent = "") {
				return translationDisplayLogic.getStoredTranslationOriginalContent(this, translation, fallbackContent);
			}

			getActiveMessageTranslation (message, channelId = null, expectedSignature = null) {
				return translationDisplayLogic.getActiveMessageTranslation(this, message, channelId, expectedSignature);
			}

			getActiveReplyPreviewTranslation (message, channelId) {
				return translationDisplayLogic.getActiveReplyPreviewTranslation(this, message, channelId);
			}

			isMessageTranslationPending (messageId, channelId = null) {
				return this.isHistoricalMessagePending(messageId, channelId) || !!queuedAutoTranslations[messageId];
			}

			applyMessageContentRenderDecorations (e, message, translation) {
				return translationDisplayLogic.applyMessageContentRenderDecorations(this, e, message, translation);
			}

			getReceivedAutoTranslateScope () {
				return loadedAutoTranslatePolicy.getReceivedAutoTranslateScope(this);
			}

			getReceivedAutoTranslateLoadedRangeMode () {
				return loadedAutoTranslatePolicy.getReceivedAutoTranslateLoadedRangeMode(this);
			}

			getReceivedAutoTranslateLoadedTimeWindow () {
				return loadedAutoTranslatePolicy.getReceivedAutoTranslateLoadedTimeWindow(this);
			}

			getReceivedAutoTranslateLoadedLimit () {
				return loadedAutoTranslatePolicy.getReceivedAutoTranslateLoadedLimit(this);
			}

			shouldPauseLoadedAutoTranslateWhileScrolling () {
				return loadedAutoTranslatePolicy.shouldPauseLoadedAutoTranslateWhileScrolling(this);
			}

			shouldContinueLoadedAutoTranslateOnScroll () {
				return loadedAutoTranslatePolicy.shouldContinueLoadedAutoTranslateOnScroll(this);
			}

			getReceivedAutoTranslateLoadedTimeWindowMs () {
				return loadedAutoTranslatePolicy.getReceivedAutoTranslateLoadedTimeWindowMs(this);
			}

			getMessageTimestampMs (message) {
				if (!message) return null;
				const normalizeTimestamp = value => {
					if (!value) return null;
					if (value instanceof Date) return value.getTime();
					if (typeof value == "number" && isFinite(value)) return value > 1000000000000 ? value : value * 1000;
					if (typeof value == "string") {
						const parsed = Date.parse(value);
						if (isFinite(parsed)) return parsed;
					}
					if (value && value._d instanceof Date) return value._d.getTime();
					if (value && typeof value.valueOf == "function") {
						const primitive = value.valueOf();
						if (typeof primitive == "number" && isFinite(primitive)) return primitive > 1000000000000 ? primitive : primitive * 1000;
					}
					return null;
				};
				const directTimestamp = normalizeTimestamp(message.timestamp || message.createdAt || message.created_at);
				if (directTimestamp) return directTimestamp;
				if (message.id) {
					try {return Number((BigInt(message.id) >> 22n) + BigInt(DISCORD_EPOCH));}
					catch (err) {}
				}
				return null;
			}

			isMessageWithinLoadedTimeWindow (message) {
				const windowMs = this.getReceivedAutoTranslateLoadedTimeWindowMs();
				if (!windowMs) return true;
				const timestampMs = this.getMessageTimestampMs(message);
				if (!timestampMs) return true;
				return Date.now() - timestampMs <= windowMs;
			}

			isMessageWithinLoadedRange (message) {
				if (this.getReceivedAutoTranslateLoadedRangeMode() == LOADED_AUTO_TRANSLATE_RANGE_MODES.TIME) return this.isMessageWithinLoadedTimeWindow(message);
				return true;
			}

			isLikelyLiveAutoTranslateMessage (message, channelId = null) {
				if (!message || !message.id) return false;
				channelId = channelId || this.getMessageChannelId(message);
				const channelState = this.getAutoTranslationChannelState(channelId);
				// Hard rule: in loaded-message mode, historical messages must not become "live"
				// just because their timestamp is recent. Live messages are identified by the
				// channel boundary only; this keeps loaded batches old-to-new and prevents flicker.
				return !!(channelState && this.isMessageIdNewer(message.id, channelState.boundaryMessageId));
			}

			shouldDeferInitialAutoTranslate (channelId) {
				if (!channelId || this.getReceivedAutoTranslateScope() == "loaded_messages") return false;
				const channelState = this.getAutoTranslationChannelState(channelId);
				return !!(channelState && !channelState.initialized);
			}

			attachAutoTranslationInputActivityWatcher () {
				return this.ensureMessageViewportStore().attachInputActivityWatcher();
			}

			detachAutoTranslationInputActivityWatcher () {
				return this.ensureMessageViewportStore().detachInputActivityWatcher();
			}

			clearAutoTranslationScrollIntent () {
				return this.ensureMessageViewportStore().clearScrollIntent();
			}

			markAutoTranslationScrollIntent () {
				return this.ensureMessageViewportStore().markScrollIntent();
			}

			finishAutoTranslationScrollActivity (channelId) {
				return this.ensureMessageViewportStore().finishScrollActivity(channelId);
			}

			scheduleAutoTranslationScrollIdleFinish (channelId, delay = null) {
				return this.ensureMessageViewportStore().scheduleScrollIdleFinish(channelId, delay);
			}

			attachAutoTranslationScrollWatcher () {
				return this.ensureMessageViewportStore().attachScrollWatcher();
			}

			detachAutoTranslationScrollWatcher () {
				return this.ensureMessageViewportStore().detachScrollWatcher();
			}

			isViewingMessageHistory () {
				return this.ensureMessageViewportStore().isViewingMessageHistory();
			}

			isUserActivelyScrollingMessages (channelId = null) {
				return this.ensureMessageViewportStore().isUserActivelyScrolling(channelId);
			}

			scheduleAutoTranslationQueueRetry () {
				return receivedTranslationRuntime.scheduleAutoTranslationQueueRetry(this);
			}

			scheduleAutoTranslationBackoff (ms) {
				return receivedTranslationRuntime.scheduleAutoTranslationBackoff(this, ms);
			}

			awaitProviderBackoff () {
				return receivedTranslationRuntime.awaitProviderBackoff(this);
			}

			requestWithTimeout (url, options, callback, timeoutMs = 30000) {
				return this.ensureProviderClient().requestWithTimeout(url, options, callback, timeoutMs);
			}

			getReceivedAutoTranslateSourceLanguages () {
				return receivedSettingsPolicy.getReceivedAutoTranslateSourceLanguages(this);
			}

			getMinimumAutoTranslateLength () {
				return receivedSettingsPolicy.getMinimumAutoTranslateLength(this);
			}

			getAutoTranslateMinimumLengthForAnalysis (analysis = null) {
				return receivedSettingsPolicy.getAutoTranslateMinimumLengthForAnalysis(this, analysis);
			}

			getTranslationSimilarityThreshold () {
				return receivedSettingsPolicy.getTranslationSimilarityThreshold(this);
			}

			shouldTreatLanguageVariantsAsSame () {
				return receivedSettingsPolicy.shouldTreatLanguageVariantsAsSame(this);
			}

			shouldSkipMixedReceivedMessages () {
				return receivedSettingsPolicy.shouldSkipMixedReceivedMessages(this);
			}

			shouldSkipSameLanguageReceivedMessages () {
				return receivedSettingsPolicy.shouldSkipSameLanguageReceivedMessages(this);
			}

			useLocalLanguagePrecheck () {
				return receivedSettingsPolicy.useLocalLanguagePrecheck(this);
			}

			shouldDropSimilarTranslations () {
				return receivedSettingsPolicy.shouldDropSimilarTranslations(this);
			}

			getAutoTranslateDecisionMode () {
				return aiDecisionPolicy.getAutoTranslateDecisionMode(this);
			}

			supportsAiAutoTranslateDecisionEngine (engineKey) {
				return aiDecisionPolicy.supportsAiAutoTranslateDecisionEngine(this, engineKey);
			}

			isAiAutoTranslateDecisionAvailable (channelId = null) {
				return aiDecisionPolicy.isAiAutoTranslateDecisionAvailable(this, channelId);
			}

			shouldUseAiAutoTranslateDecision (channelId = null) {
				return aiDecisionPolicy.shouldUseAiAutoTranslateDecision(this, channelId);
			}

			getDefaultAiAutoTranslatePrompt () {
				return "输入语言：{{INPUT_LANGUAGE}}\n输出语言：{{OUTPUT_LANGUAGE}}\n\n只翻译消息中不是输出语言的自然语言内容，译成输出语言。已是输出语言的内容保持原样。\n\n短词、语气词、感叹词、笑声、重复词和单独一行仍属于有效聊天内容；只要它们不是输出语言，就必须翻译或按输出语言自然表达。不要因为内容很短而跳过或省略，例如 hi、ok、yes、no。\n\n保留原样：URL、IP、端口、@用户名、频道名、ID、代码、命令、表情、⟦0⟧/⟦1⟧ 等保护占位符。专有名词、产品名、模型名、游戏/技术术语默认保留；若在输出语言中有公认译名或官方译名，可使用该译名。\n\n禁止：把源语言同义改写成源语言；把已是输出语言的内容润色改写；解释原文。\n\n如果没有需要翻译的自然语言，或消息主要已是输出语言且只夹杂专名/缩写/技术词，只输出 __SKIP_TRANSLATION__。\n需要翻译时只输出处理后的消息。";
			}

			getLegacyAiAutoTranslatePrompts () {
				return [
					"任务：判断 Discord 收到消息是否需要翻译；需要时，只翻译非目标语言的自然语言内容。\n规则：\n1. 消息里存在非目标语言的自然语言内容：只翻译这些内容。\n2. 已经是目标语言的内容保持原样，不要重写、润色或改写。\n3. 专有名词、产品名、模型名、游戏术语、技术术语、URL、IP、端口、用户名、频道名、ID、代码、命令、表情符号保持原样。\n4. {{0}}、{{1}}、{{2}} 等保护占位符必须逐字保留，数量、顺序和位置不能改变。\n5. 如果消息只有链接、表情、用户名、数字、代码、命令、IP、端口、占位符，或没有需要翻译的自然语言内容，只输出 __SKIP_TRANSLATION__。\n6. 如果消息已经主要是目标语言，且只夹杂专有名词、产品名、英文缩写或技术词，只输出 __SKIP_TRANSLATION__。\n输出：需要翻译时只输出处理后的消息；不需要翻译时只输出 __SKIP_TRANSLATION__。不要解释，不要添加注释。",
					"任务：判断 Discord 收到消息是否需要翻译，并在需要时直接翻译成目标语言。\n规则：\n1. 主要自然语言已是目标语言：只输出 __SKIP_TRANSLATION__。\n2. 只有链接、表情、用户名、频道名、ID、数字、IP、端口、代码、命令或占位符：只输出 __SKIP_TRANSLATION__。\n3. 主要自然语言不是目标语言：翻译主要文本。\n4. 英文产品名、游戏术语、URL、IP、端口、用户名、表情不是“混合语言跳过”理由，保留即可。\n5. {{0}}、{{1}} 等保护占位符必须逐字保留，数量和顺序不能改变。\n输出：需要翻译时只输出译文；不需要翻译时只输出 __SKIP_TRANSLATION__。",
					"你是 Discord 聊天翻译判断器。判断这条收到的消息是否值得翻译成目标语言。\n需要翻译：主要内容不是目标语言；即使包含链接、表情、用户名、英文产品名、IP、端口、游戏术语，也不要因此跳过；混合少量英文关键词时，仍然翻译主要外语内容。\n不需要翻译：消息已经主要是目标语言；只有链接、表情、数字、代码、用户名；翻译后和原文几乎一样。\n保护占位符如 {{0}}、{{1}} 必须原样保留，不要改写。\n需要翻译时只输出译文；不需要翻译时只输出 __SKIP_TRANSLATION__。"
				];
			}

			getLanguagePromptName (languageData) {
				if (!languageData) return "";
				if (languageData.auto) return this.getCustomText("detect_language_label") || "Auto detect";
				return [languageData.name, languageData.ownlang, languageData.id].filter(Boolean).join(" / ");
			}

			getAiAutoTranslatePrompt (translationData = null) {
				const customPrompt = this.settings.filters && this.settings.filters.aiAutoTranslatePrompt;
				let prompt = this.getDefaultAiAutoTranslatePrompt();
				if (typeof customPrompt == "string" && customPrompt.trim()) {
					const trimmedPrompt = customPrompt.trim();
					if (!this.getLegacyAiAutoTranslatePrompts().some(legacyPrompt => trimmedPrompt == legacyPrompt.trim())) prompt = customPrompt;
				}
				if (!translationData) return prompt;
				const inputLanguage = this.getLanguagePromptName(translationData.input) || "Auto detect";
				const outputLanguage = this.getLanguagePromptName(translationData.output) || "Target language";
				return prompt
					.replace(/\{\{INPUT_LANGUAGE\}\}/g, inputLanguage)
					.replace(/\{\{OUTPUT_LANGUAGE\}\}/g, outputLanguage)
					.replace(/\{\{TARGET_LANGUAGE\}\}/g, outputLanguage);
			}

			isSkipTranslationSignal (translation) {
				return typeof translation == "string" && translation.trim().replace(/[。.!！\s]+$/g, "") == AI_SKIP_TRANSLATION_TOKEN;
			}

			getLanguageScriptFamilies (languageId) {
				languageId = this.normalizeLanguageId(languageId);
				if (!languageId) return [];
				if (languageId.startsWith("zh")) return ["han"];
				if (languageId == "ja") return ["han", "kana"];
				if (languageId == "ko") return ["hangul"];
				if (["ru", "uk", "bg", "be", "mk", "sr", "kk", "ky", "mn"].includes(languageId)) return ["cyrillic"];
				if (["ar", "fa", "ur", "ps", "sd", "ug"].includes(languageId)) return ["arabic"];
				if (languageId == "el") return ["greek"];
				if (["he", "iw", "yi"].includes(languageId)) return ["hebrew"];
				if (["hi", "mr", "ne"].includes(languageId)) return ["devanagari"];
				if (languageId == "th") return ["thai"];
				return ["latin"];
			}

			countScriptFamilies (text) {
				const counts = {
					han: 0,
					kana: 0,
					hangul: 0,
					cyrillic: 0,
					arabic: 0,
					greek: 0,
					hebrew: 0,
					devanagari: 0,
					thai: 0,
					latin: 0
				};
				for (const character of text || "") {
					const codePoint = character.codePointAt(0);
					if (codePoint >= 0x4E00 && codePoint <= 0x9FFF) counts.han++;
					else if ((codePoint >= 0x3040 && codePoint <= 0x30FF) || (codePoint >= 0x31F0 && codePoint <= 0x31FF)) counts.kana++;
					else if (codePoint >= 0xAC00 && codePoint <= 0xD7AF) counts.hangul++;
					else if (codePoint >= 0x0400 && codePoint <= 0x052F) counts.cyrillic++;
					else if (codePoint >= 0x0600 && codePoint <= 0x06FF) counts.arabic++;
					else if (codePoint >= 0x0370 && codePoint <= 0x03FF) counts.greek++;
					else if (codePoint >= 0x0590 && codePoint <= 0x05FF) counts.hebrew++;
					else if (codePoint >= 0x0900 && codePoint <= 0x097F) counts.devanagari++;
					else if (codePoint >= 0x0E00 && codePoint <= 0x0E7F) counts.thai++;
					else if ((codePoint >= 0x0041 && codePoint <= 0x007A) || (codePoint >= 0x00C0 && codePoint <= 0x024F)) counts.latin++;
				}
				return counts;
			}

			sanitizeTextForAutoTranslateAnalysis (text) {
				return (text || "")
					.replace(/```[\s\S]*?```/g, " ")
					.replace(/`[^`\r\n]+`/g, " ")
					.replace(/https?:\/\/\S+/gi, " ")
					.replace(/<a?:\w+:\d+>/g, " ")
					.replace(/<@!?\d+>|<#\d+>|<@&\d+>/g, " ")
					.replace(/\s+/g, " ")
					.trim();
			}

			analyzeTextForAutoTranslate (text, targetLanguageId) {
				const cleanedText = this.sanitizeTextForAutoTranslateAnalysis(text);
				const counts = this.countScriptFamilies(cleanedText);
				const latinWordCount = (cleanedText.match(/[A-Za-z][A-Za-z0-9._+-]*/g) || []).length;
				const hanRunCount = (cleanedText.match(/[\u4E00-\u9FFF]+/g) || []).length;
				const scriptEntries = Object.entries(counts).filter(([, count]) => count > 0).sort((entryA, entryB) => entryB[1] - entryA[1]);
				const totalLetters = scriptEntries.reduce((sum, [, count]) => sum + count, 0);
				const targetFamilies = this.getLanguageScriptFamilies(targetLanguageId);
				const targetLetterCount = targetFamilies.reduce((sum, family) => sum + (counts[family] || 0), 0);
				const nonTargetLetterCount = Math.max(0, totalLetters - targetLetterCount);
				const targetShare = totalLetters ? targetLetterCount / totalLetters : 0;
				const dominantEntry = scriptEntries[0] || ["", 0];
				const secondaryEntry = scriptEntries[1] || ["", 0];
				const dominantShare = totalLetters ? dominantEntry[1] / totalLetters : 0;
				const secondaryShare = totalLetters ? secondaryEntry[1] / totalLetters : 0;
				const isMixed = dominantEntry[1] >= 2 && secondaryEntry[1] >= 2 && dominantShare >= 0.2 && secondaryShare >= 0.2;
				const strongTargetScriptMatch = targetFamilies[0] != "latin" && targetLetterCount >= 3 && targetShare >= 0.65 && (!isMixed || nonTargetLetterCount <= Math.max(2, targetLetterCount * 0.35));
				return {
					cleanedText,
					counts,
					latinWordCount,
					hanRunCount,
					targetFamilies,
					totalLetters,
					targetLetterCount,
					nonTargetLetterCount,
					targetShare,
					dominantFamily: dominantEntry[0] || null,
					isMixed,
					strongTargetScriptMatch
				};
			}

			getLatinStopwordTables () {
				return languageHeuristicsRuntime.getLatinStopwordTables(this);
			}

			identifyLatinLanguage (text) {
				return languageHeuristicsRuntime.identifyLatinLanguage(this, text);
			}

			detectMessageLanguageLocal (text, analysis, targetLanguageId) {
				return languageHeuristicsRuntime.detectMessageLanguageLocal(this, text, analysis, targetLanguageId);
			}

			// Local high-confidence "this message is clearly a foreign language" check. Used by the
			// AI-decision safety net: when AI decision mode returns __SKIP_TRANSLATION__, this lets us
			// override the skip without any network call whenever the script family alone proves the
			// message is foreign (e.g. Latin-script message with a Han/Cyrillic/Arabic target).
			isClearlyForeignLanguageMessage (text, targetLanguageId) {
				return languageHeuristicsRuntime.isClearlyForeignLanguageMessage(this, text, targetLanguageId);
			}

			// Safety-net helper for received auto messages. Returns true when the message is foreign
			// (must be translated). First tier is the zero-network local check; second tier falls back
			// to Google gtx detection (covers latin-vs-latin the local check cannot). If gtx is
			// unreachable, the second tier resolves false so the caller honors the original skip.
			isReceivedMessageForeignAsync (text, targetLanguageId, callback) {
				return foreignLanguageDecisionRuntime.isReceivedMessageForeignAsync(this, text, targetLanguageId, callback);
			}

			isHanTargetMessageWithLatinTerms (analysis, targetLanguageId) {
				return languageHeuristicsRuntime.isHanTargetMessageWithLatinTerms(this, analysis, targetLanguageId);
			}

			isMostlyTargetLanguageMessage (analysis, targetLanguageId) {
				return languageHeuristicsRuntime.isMostlyTargetLanguageMessage(this, analysis, targetLanguageId);
			}

			isClearlyTargetLanguageMessage (analysis, targetLanguageId) {
				return languageHeuristicsRuntime.isClearlyTargetLanguageMessage(this, analysis, targetLanguageId);
			}

			shouldSkipReceivedTranslationBeforeRequest (originalContentData, channelId) {
				return receivedMessageFilterRuntime.shouldSkipReceivedTranslationBeforeRequest(this, originalContentData, channelId);
			}

			isTranslationLikelyInTargetLanguage (text, targetLanguageId) {
				return languageHeuristicsRuntime.isTranslationLikelyInTargetLanguage(this, text, targetLanguageId);
			}

			buildAutoTranslateAnalysisText (originalContentData) {
				return receivedMessageFilterRuntime.buildAutoTranslateAnalysisText(this, originalContentData);
			}

			isLinkOnlyReceivedContent (originalContentData) {
				return receivedMessageFilterRuntime.isLinkOnlyReceivedContent(this, originalContentData);
			}

			normalizeComparisonText (text) {
				return textSimilarityRuntime.normalizeComparisonText(this, text);
			}

			getTextSimilarityScore (textA, textB) {
				return textSimilarityRuntime.getTextSimilarityScore(this, textA, textB);
			}

			isSameLanguageOrVariant (languageA, languageB) {
				if (!languageA || !languageB) return false;
				const normalizedA = this.normalizeLanguageId(languageA);
				const normalizedB = this.normalizeLanguageId(languageB);
				if (normalizedA == normalizedB) return true;
				if (!this.shouldTreatLanguageVariantsAsSame()) return false;
				const rootA = normalizedA.split("-")[0];
				const rootB = normalizedB.split("-")[0];
				return rootA && rootA == rootB;
			}

			isTranslationResultTooSimilar (translation) {
				return receivedMessageFilterRuntime.isTranslationResultTooSimilar(this, translation);
			}

			shouldKeepAutoTranslatedResult (translation, channelId) {
				return receivedMessageFilterRuntime.shouldKeepAutoTranslatedResult(this, translation, channelId);
			}

			shouldAutoTranslateReceivedMessage (message, channel, originalContentData = null, ignoreQueued = false) {
				return receivedMessageFilterRuntime.shouldAutoTranslateReceivedMessage(this, message, channel, originalContentData, ignoreQueued);
			}

			queueAutoTranslateMessage (message, channel, originalContentData = null, queueOptions = {}) {
				return receivedTranslationRuntime.queueAutoTranslateMessage(this, message, channel, originalContentData, queueOptions);
			}


			createStoredReceivedTranslationData (message, channelId, originalContentData, signature, translation, input, output, auto = false) {
				if (!translation) return null;
				let strings = String(translation).split(/\n{0,1}__________________ __________________ __________________\n{0,1}/);
				let oldContent = (originalContentData && originalContentData.content || "").trim();
				let translatedContent = (strings.shift() || "").trim();
				if (!translatedContent) return null;
				let content = this.buildReceivedDisplayContent(translatedContent, oldContent);
				const embedIds = ((message && message.embeds) || []).map(embed => embed && embed.id).filter(Boolean);
				let embeds = strings.reduce((dict, segment, index) => {
					let embedId = embedIds[index];
					if (!embedId) return dict;
					let segmentLines = segment.split("\n");
					let title = segmentLines.shift();
					let description = segmentLines.shift();
					let footerText = segmentLines.pop();
					let fieldsSegment = segmentLines.join("\n").split("\n\n");
					let fields = fieldsSegment.map(line => {
						let [name, value] = line.split("__________________");
						return {name, value};
					});
					dict[embedId] = {title, description, fields, footerText};
					return dict;
				}, {});
				return {
					signature,
					channelId,
					auto: !!auto,
					content,
					translatedContent,
					originalContent: oldContent,
					embeds,
					input,
					output
				};
			}

			createHistoricalTranslationRetrySnapshot (item, channelId) {
				if (!item || !item.message || !item.message.id || !channelId) return null;
				const message = new BDFDB.DiscordObjects.Message(item.message);
				message.embeds = (item.message.embeds || []).map(embed => Object.assign({}, embed, {
					fields: (embed.fields || []).map(field => Object.assign({}, field)),
					footer: embed.footer ? Object.assign({}, embed.footer) : embed.footer
				}));
				message.attachments = (item.message.attachments || []).map(attachment => Object.assign({}, attachment));
				return {
					message,
					channel: Object.assign({}, item.channel || {}, {id: channelId}),
					originalContentData: this.cloneOriginalContentData(item.originalContentData || this.extractOriginalContentData(item.message)),
					historicalLoad: true,
					deferWhileReading: true,
					reason: item.reason || "provider_failed"
				};
			}

			updateFailedHistoricalTranslationSnapshots (summary, channelId) {
				if (!channelId) return 0;
				const existingEntry = failedHistoricalTranslationSnapshots.get(channelId);
				const snapshotsById = new Map((existingEntry && existingEntry.items || []).map(item => [String(item.message.id), item]));
				for (const item of [].concat(summary && summary.translated || [], summary && summary.skipped || [])) {
					if (item && item.message && item.message.id) snapshotsById.delete(String(item.message.id));
				}
				for (const item of summary && summary.failed || []) {
					const snapshot = this.createHistoricalTranslationRetrySnapshot(item, channelId);
					if (snapshot) snapshotsById.set(String(snapshot.message.id), snapshot);
				}
				const items = [...snapshotsById.values()];
				if (items.length) failedHistoricalTranslationSnapshots.set(channelId, {channelId, items, updatedAt: Date.now()});
				else failedHistoricalTranslationSnapshots.delete(channelId);
				return items.length;
			}

			getFailedHistoricalTranslationCount (channelId) {
				const entry = channelId && failedHistoricalTranslationSnapshots.get(channelId);
				return entry && entry.items ? entry.items.length : 0;
			}

			retryFailedHistoricalTranslations (channelId = null) {
				channelId = channelId || BDFDB.LibraryStores.SelectedChannelStore.getChannelId();
				const failedEntry = channelId && failedHistoricalTranslationSnapshots.get(channelId);
				if (!failedEntry || !failedEntry.items || !failedEntry.items.length || !this.isTranslationEnabled(channelId)) return Promise.resolve(false);
				const queueEntry = this.getHistoricalTranslationJobQueue(channelId, false);
				if (queueEntry && (queueEntry.runningPromise || queueEntry.jobs.some(job => job && job.state == "collecting"))) return Promise.resolve(false);
				const retryItems = failedEntry.items.slice(0, this.getReceivedAutoTranslateLoadedLimit());
				this.updateLoadedAutoTranslationStatus({
					active: true,
					collecting: true,
					done: false,
					channelId,
					batch: loadedTranslationStatusStore.getNextBatchNumber(channelId),
					total: retryItems.length,
					processed: 0,
					displayed: 0,
					skipped: 0,
					failed: 0,
					retryable: this.getFailedHistoricalTranslationCount(channelId),
					aiDropped: 0
				});
				let accepted = 0;
				for (const item of retryItems) if (this.collectHistoricalTranslationMessage(item)) accepted++;
				if (!accepted) {
					const failedCount = this.getFailedHistoricalTranslationCount(channelId);
					this.updateLoadedAutoTranslationStatus({active: false, collecting: false, done: true, channelId, failed: 0, retryable: failedCount, aiDropped: 0});
					return Promise.resolve(false);
				}
				return Promise.resolve(this.startCollectedHistoricalTranslationJobs(channelId)).then(_ => true);
			}

			getHistoricalTranslationJobQueue (channelId, create = true) {
				if (!channelId) return null;
				let entry = historicalTranslationJobQueues.get(channelId);
				if (!entry && create) {
					entry = {channelId, generation: 0, jobs: [], runningPromise: null, startToken: null};
					historicalTranslationJobQueues.set(channelId, entry);
				}
				return entry || null;
			}

			createCollectedHistoricalTranslationJob (channelId) {
				const entry = this.getHistoricalTranslationJobQueue(channelId);
				entry.generation++;
				let job;
				job = this.createHistoricalTranslationJob({
					id: `${channelId}:${++historicalTranslationJobSequence}`,
					channelId,
					generation: entry.generation,
					configurationSignature: this.createHistoricalTranslationJobConfigurationSignature(channelId),
					repairBatchSize: 10,
					dependencies: {
						prepare: source => this.prepareHistoricalTranslationJobItem(source, job),
						translateBatch: preparedItems => this.translateHistoricalTranslationJobBatch(preparedItems, job),
						repairBatch: preparedItems => this.repairHistoricalTranslationJobBatch(preparedItems, job),
						validate: (prepared, rawTranslation) => this.validateHistoricalTranslationJobResult(prepared, rawTranslation, job),
						repair: prepared => this.repairHistoricalTranslationJobItem(prepared, job),
						waitForCommit: () => this.waitForHistoricalTranslationCommit(job),
						isCurrent: () => this.isHistoricalTranslationJobCurrent(job),
						commit: summary => this.commitHistoricalTranslationJob(summary, job),
						rerender: () => this.rerenderHistoricalTranslationJob(job),
						onStateChange: () => this.updateHistoricalTranslationJobStatus(job)
					}
				});
				entry.jobs.push(job);
				return job;
			}

			collectHistoricalTranslationMessage (queueItem) {
				if (!queueItem || !queueItem.message || !queueItem.channel || !queueItem.channel.id) return false;
				const channelId = queueItem.channel.id;
				if (!this.isTranslationEnabled(channelId)) return false;
				const entry = this.getHistoricalTranslationJobQueue(channelId);
				let job = entry.jobs[entry.jobs.length - 1];
				if (job && job.state == "collecting" && !job.sealed && job.items.size >= this.getReceivedAutoTranslateLoadedLimit()) return false;
				if (!job || job.state != "collecting" || job.sealed) job = this.createCollectedHistoricalTranslationJob(channelId);
				if (!job.add(queueItem)) return false;
				queuedAutoTranslations[queueItem.message.id] = {type: "historical", channelId, jobId: job.id};
				if (!queueItem.deferHistoricalSnapshotStart) this.scheduleHistoricalTranslationJobStart(channelId);
				this.updateHistoricalTranslationJobStatus(job);
				return true;
			}

			scheduleHistoricalTranslationJobStart (channelId) {
				const entry = this.getHistoricalTranslationJobQueue(channelId, false);
				if (!entry || entry.startToken) return;
				const token = {};
				entry.startToken = token;
				const startSnapshot = _ => {
					if (entry.startToken !== token || historicalTranslationJobQueues.get(channelId) !== entry) return;
					entry.startToken = null;
					this.finishHistoricalTranslationSnapshot(channelId);
				};
				if (typeof queueMicrotask == "function") queueMicrotask(startSnapshot);
				else Promise.resolve().then(startSnapshot);
			}

			finishHistoricalTranslationSnapshot (channelId) {
				const entry = this.getHistoricalTranslationJobQueue(channelId, false);
				if (!entry) return false;
				const job = [...entry.jobs].reverse().find(candidate => candidate && candidate.state == "collecting" && !candidate.sealed);
				if (!job) return false;
				job.seal();
				if (!entry.runningPromise) this.startCollectedHistoricalTranslationJobs(channelId, {sealCurrent: false});
				return true;
			}

			startCollectedHistoricalTranslationJobs (channelId, options = {}) {
				const entry = this.getHistoricalTranslationJobQueue(channelId, false);
				if (!entry) return Promise.resolve(null);
				const config = Object.assign({sealCurrent: true}, options);
				entry.startToken = null;
				if (entry.runningPromise) return entry.runningPromise;
				let job = entry.jobs.find(candidate => candidate && candidate.state == "collecting" && candidate.sealed);
				if (!job && config.sealCurrent) {
					job = entry.jobs.find(candidate => candidate && candidate.state == "collecting");
					if (job) job.seal();
				}
				if (!job) return Promise.resolve(null);
				const runningPromise = Promise.resolve(job.start()).finally(_ => {
					for (const record of job.items.values()) {
						const messageId = record && record.source && record.source.message && record.source.message.id;
						const queuedMarker = messageId && queuedAutoTranslations[messageId];
						if (queuedMarker && queuedMarker.type == "historical" && queuedMarker.jobId == job.id) delete queuedAutoTranslations[messageId];
					}
					if (entry.runningPromise == runningPromise) entry.runningPromise = null;
					entry.jobs = entry.jobs.filter(candidate => candidate != job);
					if (entry.jobs.some(candidate => candidate && candidate.state == "collecting" && candidate.sealed)) this.startCollectedHistoricalTranslationJobs(channelId, {sealCurrent: false});
					else if (!entry.jobs.length && !entry.startToken && historicalTranslationJobQueues.get(channelId) === entry) historicalTranslationJobQueues.delete(channelId);
				});
				entry.runningPromise = runningPromise;
				return runningPromise;
			}

			async waitForHistoricalTranslationJobs (channelId) {
				while (true) {
					const entry = this.getHistoricalTranslationJobQueue(channelId, false);
					if (!entry) return;
					if (!entry.runningPromise && entry.jobs.length) this.startCollectedHistoricalTranslationJobs(channelId);
					if (!entry.runningPromise) return;
					await entry.runningPromise;
				}
			}

			isHistoricalMessagePending (messageId, channelId = null) {
				if (!messageId) return false;
				const entries = channelId ? [this.getHistoricalTranslationJobQueue(channelId, false)].filter(Boolean) : [...historicalTranslationJobQueues.values()];
				return entries.some(entry => entry.jobs.some(job => job.isMessagePending(messageId)));
			}

			invalidateHistoricalTranslationMessage (messageId, channelId, currentSignature) {
				if (!messageId || !channelId || !currentSignature) return false;
				const entry = this.getHistoricalTranslationJobQueue(channelId, false);
				let invalidated = false;
				for (const job of entry && entry.jobs || []) {
					const record = job && job.items.get(String(messageId));
					if (!record || record.status == "cancelled") continue;
					const source = record.source || {};
					const sourceSignature = record.prepared && record.prepared.signature || this.createReceivedTranslationSignature(source.message, channelId, source.originalContentData);
					if (sourceSignature == currentSignature) continue;
					if (job.invalidateMessage(messageId, "source-edited")) invalidated = true;
				}
				const failedEntry = failedHistoricalTranslationSnapshots.get(channelId);
				if (failedEntry && failedEntry.items) {
					const nextItems = failedEntry.items.filter(item => {
						if (!item || !item.message || String(item.message.id) != String(messageId)) return true;
						const snapshotSignature = this.createReceivedTranslationSignature(item.message, channelId, item.originalContentData);
						if (snapshotSignature == currentSignature) return true;
						invalidated = true;
						return false;
					});
					if (nextItems.length) failedHistoricalTranslationSnapshots.set(channelId, Object.assign({}, failedEntry, {items: nextItems}));
					else failedHistoricalTranslationSnapshots.delete(channelId);
				}
				if (invalidated) {
					delete queuedAutoTranslations[messageId];
					this.clearCachedTranslation(messageId);
					const repairStatus = loadedTranslationStatusStore.getStatus();
					if (repairStatus.channelId == channelId && repairStatus.done) {
						const failedCount = this.getFailedHistoricalTranslationCount(channelId);
						const visibleFailedCount = Math.min(repairStatus.failed || 0, failedCount);
						this.updateLoadedAutoTranslationStatus({failed: visibleFailedCount, retryable: failedCount, aiDropped: visibleFailedCount});
					}
				}
				return invalidated;
			}

			cancelHistoricalTranslationJobs (channelId = null, reason = "cancelled") {
				const entries = channelId ? [this.getHistoricalTranslationJobQueue(channelId, false)].filter(Boolean) : [...historicalTranslationJobQueues.values()];
				for (const entry of entries) {
					entry.generation++;
					entry.startToken = null;
					for (const job of entry.jobs) {
						job.cancel(reason);
						for (const record of job.items.values()) if (record.source && record.source.message) delete queuedAutoTranslations[record.source.message.id];
					}
					entry.jobs = [];
					if (channelId) historicalTranslationJobQueues.delete(channelId);
				}
				if (!channelId) historicalTranslationJobQueues.clear();
				historicalTranslationRuntimeGeneration++;
			}

			prepareHistoricalTranslationJobItem (queueItem, job) {
				if (!queueItem || !queueItem.message || !this.isHistoricalTranslationJobCurrent(job)) return {status: "failed", reason: "stale_job"};
				const channelId = job.channelId;
				const input = Object.assign({}, languages[this.getLanguageChoice(languageTypes.INPUT, messageTypes.RECEIVED, channelId)] || {});
				const output = Object.assign({}, languages[this.getLanguageChoice(languageTypes.OUTPUT, messageTypes.RECEIVED, channelId)] || {});
				const prepared = this.prepareHistoricalAiBatchQueueItem(queueItem, channelId, input, output);
				if (!prepared) return {status: "failed", reason: "prepare_failed"};
				if (prepared.cachedTranslation) return {status: "translated", translation: Object.assign({channelId, auto: true}, prepared.cachedTranslation)};
				if (prepared.skipped) return {status: "skipped", reason: prepared.skipReason || "local_guard"};
				return {status: "pending", prepared};
			}

			translateHistoricalTranslationJobBatch (preparedItems, job) {
				if (!preparedItems.length || !this.isHistoricalTranslationJobCurrent(job)) return Promise.resolve(null);
				const engineKey = this.getHistoricalAiBatchEngineKey(job.channelId);
				if (!engineKey) return Promise.resolve(null);
				return this.requestAiBatchTranslation(engineKey, preparedItems);
			}

			repairHistoricalTranslationJobBatch (preparedItems, job) {
				if (!preparedItems.length || !this.isHistoricalTranslationJobCurrent(job)) return Promise.resolve(null);
				const engineKey = this.getHistoricalAiBatchEngineKey(job.channelId);
				if (!engineKey) return Promise.resolve(null);
				// Repair traffic shares the provider key with live requests; honoring the
				// 429/5xx backoff window keeps repairs from extending a rate-limit storm.
				return this.awaitProviderBackoff().then(_ => this.isHistoricalTranslationJobCurrent(job) ? this.requestAiBatchTranslation(engineKey, preparedItems) : null);
			}

			validateHistoricalTranslationJobResult (prepared, rawTranslation, job) {
				if (!prepared || rawTranslation == null || String(rawTranslation).trim() === "" || this.isSkipTranslationSignal(rawTranslation)) return {ok: false};
				let translatedText = String(rawTranslation).replace(/\[NEWLINE\]/g, "\n").trim();
				if (!this.hasAllProtectionPlaceholders(translatedText, prepared.exceptions)) return {ok: false};
				translatedText = this.addExceptions(translatedText, prepared.exceptions);
				if (!this.isTranslationLikelyInTargetLanguage(translatedText, prepared.output && prepared.output.id)) return {ok: false};
				const storedTranslation = this.createStoredReceivedTranslationData(prepared.message, job.channelId, prepared.originalContentData, prepared.signature, translatedText, prepared.input, prepared.output, true);
				if (!storedTranslation || !this.shouldKeepAutoTranslatedResult(storedTranslation, job.channelId) || this.isTranslationResultTooSimilar(storedTranslation)) return {ok: false};
				return {ok: true, translation: storedTranslation};
			}

			repairHistoricalTranslationJobItem (prepared, job) {
				return new Promise(resolve => {
					if (!prepared || !prepared.message || !this.isHistoricalTranslationJobCurrent(job)) return resolve({status: "failed", reason: "stale_job"});
					const requestText = this.buildTranslationRequestText(prepared.originalContentData);
					this.awaitProviderBackoff().then(_ => {
						if (!this.isHistoricalTranslationJobCurrent(job)) return resolve({status: "failed", reason: "stale_job"});
						this.translateText(requestText, messageTypes.RECEIVED, (translation, input, output, meta = {}) => {
						if (!this.isHistoricalTranslationJobCurrent(job)) return resolve({status: "failed", reason: "stale_job"});
						if (!translation) return resolve({status: meta.skipped ? "skipped" : "failed", reason: meta.skipped ? "same_language" : "provider_failed"});
						const storedTranslation = this.createStoredReceivedTranslationData(prepared.message, job.channelId, prepared.originalContentData, prepared.signature, translation, input, output, true);
						const rejectReason = storedTranslation && this.getAutoTranslatedResultRejectReason(storedTranslation, job.channelId);
						if (!storedTranslation || rejectReason || this.isTranslationResultTooSimilar(storedTranslation)) return resolve({status: "skipped", reason: rejectReason || "too_similar"});
						resolve({status: "translated", translation: storedTranslation});
					}, null, {showToast: false, showFailureToast: false, trackBusy: false, auto: true, forcePlainTranslation: true, channelId: job.channelId});
					});
				});
			}

			waitForHistoricalTranslationCommit (job) {
				if (typeof document == "undefined") return Promise.resolve();
				return new Promise(resolve => {
					const waitUntilIdle = _ => {
						if (!this.isHistoricalTranslationJobCurrent(job)) return resolve();
						const messageViewport = this.ensureMessageViewportStore();
						if (messageViewport.getTimeSinceInputActivity() >= 300 && !messageViewport.isUserScrollingChannel(job.channelId)) return resolve();
						setTimeout(waitUntilIdle, 120);
					};
					waitUntilIdle();
				});
			}

			createHistoricalTranslationJobConfigurationSignature (channelId) {
				return this.createReceivedTranslationSignature(null, channelId, {content: "", embeds: []});
			}

			isHistoricalTranslationJobCurrent (job) {
				if (!job || !pluginRuntimeActive || !this.isTranslationEnabled(job.channelId)) return false;
				if (job.configurationSignature && job.configurationSignature != this.createHistoricalTranslationJobConfigurationSignature(job.channelId)) return false;
				const entry = this.getHistoricalTranslationJobQueue(job.channelId, false);
				return !!entry && entry.jobs.includes(job) && job.state != "cancelled";
			}

			isHistoricalTranslationJobItemCurrent (item, job) {
				if (!item || !item.message || !job || !job.channelId) return false;
				let currentMessage = null;
				try {
					const messageStore = BDFDB.LibraryStores && BDFDB.LibraryStores.MessageStore;
					if (messageStore && typeof messageStore.getMessage == "function") currentMessage = messageStore.getMessage(job.channelId, item.message.id);
				}
				catch (error) {}
				currentMessage = currentMessage || item.message;
				const expectedContentData = item.originalContentData || this.extractOriginalContentData(item.message);
				const currentContentData = this.extractOriginalContentData(currentMessage);
				return this.createReceivedTranslationSignature(item.message, job.channelId, expectedContentData) == this.createReceivedTranslationSignature(currentMessage, job.channelId, currentContentData);
			}

			async commitHistoricalTranslationJob (summary, job) {
				if (!this.isHistoricalTranslationJobCurrent(job)) return;
				summary.translated = summary.translated.filter(item => this.isHistoricalTranslationJobItemCurrent(item, job));
				summary.skipped = summary.skipped.filter(item => this.isHistoricalTranslationJobItemCurrent(item, job));
				summary.failed = summary.failed.filter(item => this.isHistoricalTranslationJobItemCurrent(item, job));
				const generation = this.getReceivedDisplayCommitGeneration(job.channelId);
				// The batch result must echo each record's active request identity: the store
				// commit supersedes a concurrent live request instead of rejecting the batch.
				const getRecordRequestIdentity = messageId => {
					const recordView = this.getReceivedDisplayRuntimeView(messageId);
					return recordView && recordView.requestIdentity != null ? recordView.requestIdentity : null;
				};
				const results = [];
				for (const item of summary.translated) {
					if (!item || !item.message || !item.translation) continue;
					const storedTranslation = this.refreshTranslationDisplay(Object.assign({channelId: job.channelId, auto: true}, item.translation));
					results.push({
						messageId: item.message.id,
						channelId: job.channelId,
						generation,
						sourceSignature: storedTranslation.signature != null ? String(storedTranslation.signature) : this.createReceivedTranslationSignature(item.message, job.channelId, item.originalContentData),
						requestIdentity: getRecordRequestIdentity(item.message.id),
						origin: "automatic",
						status: "translated",
						translation: storedTranslation
					});
					this.persistTranslationCacheEntry(item.message.id, storedTranslation.signature, storedTranslation);
					delete queuedAutoTranslations[item.message.id];
				}
				for (const item of summary.skipped) {
					if (!item || !item.message) continue;
					const signature = this.createReceivedTranslationSignature(item.message, job.channelId, item.originalContentData);
					this.persistReceivedSkipDecision(item.message.id, signature, item.reason || "local_guard", this.buildTranslationRequestText(item.originalContentData || {}));
					results.push({messageId: item.message.id, channelId: job.channelId, generation, sourceSignature: signature, requestIdentity: getRecordRequestIdentity(item.message.id), origin: "automatic", status: "skipped", reason: item.reason || "local_guard"});
					delete queuedAutoTranslations[item.message.id];
				}
				for (const item of summary.failed) {
					if (!item || !item.message) continue;
					results.push({messageId: item.message.id, channelId: job.channelId, generation, sourceSignature: this.createReceivedTranslationSignature(item.message, job.channelId, item.originalContentData), requestIdentity: getRecordRequestIdentity(item.message.id), origin: "automatic", status: "failed", reason: item.reason || "provider_failed"});
					delete queuedAutoTranslations[item.message.id];
				}
				let batchOutcome = null;
				if (results.length) {
					try {batchOutcome = await this.commitHistoricalReceivedDisplayBatch(results);}
					catch (error) {batchOutcome = null;}
				}
				const batchCommitted = !!(batchOutcome && (batchOutcome.confirmedIds && batchOutcome.confirmedIds.length || batchOutcome.missingIds && batchOutcome.missingIds.length || batchOutcome.staleIds && batchOutcome.staleIds.length || batchOutcome.deferredIds && batchOutcome.deferredIds.length));
				const batchRejected = !!(results.length && !batchCommitted);
				const failedCount = this.updateFailedHistoricalTranslationSnapshots(summary, job.channelId);
				this.updateLoadedAutoTranslationStatus({active: false, collecting: false, done: true, channelId: job.channelId, total: job.items.size, processed: job.items.size, displayed: batchRejected ? 0 : summary.translated.length, skipped: summary.skipped.length, failed: summary.failed.length, retryable: failedCount, aiDropped: summary.failed.length});
			}

			rerenderHistoricalTranslationJob (_job) {
				// The acknowledged historical batch commit repaints exact message IDs; a full-list
				// rerender here would reintroduce the flicker the display transaction removes.
			}

			updateHistoricalTranslationJobStatus (job) {
				if (!job || !job.channelId) return;
				const records = [...job.items.values()];
				const retainedFailedCount = this.getFailedHistoricalTranslationCount(job.channelId);
				const currentFailedCount = records.filter(record => record.status == "failed").length;
				this.updateLoadedAutoTranslationStatus({active: job.state != "committed" && job.state != "cancelled", collecting: job.state == "collecting", done: job.state == "committed", channelId: job.channelId, total: records.length, processed: records.filter(record => HISTORICAL_TERMINAL_ITEM_STATES.has(record.status)).length, displayed: records.filter(record => record.status == "translated").length, skipped: records.filter(record => record.status == "skipped").length, failed: currentFailedCount, retryable: retainedFailedCount, aiDropped: currentFailedCount});
			}

			getHistoricalAiBatchItemLimit (channelId = null) {
				return Math.max(LOADED_AUTO_TRANSLATE_LIMIT_MIN, Math.min(HISTORICAL_AI_BATCH_ITEM_LIMIT_MAX, this.getReceivedAutoTranslateLoadedLimit()));
			}

			getHistoricalAiBatchEngineKey (channelId = null) {
				const engineKey = this.getEffectivePrimaryEngine(channelId);
				if (!["deepseek", "openai", "gemini", "oaicompat"].includes(engineKey)) return null;
				const input = Object.assign({}, languages[this.getLanguageChoice(languageTypes.INPUT, messageTypes.RECEIVED, channelId)] || {});
				const output = Object.assign({}, languages[this.getLanguageChoice(languageTypes.OUTPUT, messageTypes.RECEIVED, channelId)] || {});
				if (!input.id || !output.id || output.special) return null;
				return this.validTranslator(engineKey, input, output, null) ? engineKey : null;
			}

			prepareHistoricalAiBatchQueueItem (queueItem, channelId, input, output) {
				if (!queueItem || !queueItem.message || !queueItem.message.id) return null;
				if (queueItem.cachedTranslation) return {queueItem, cachedTranslation: queueItem.cachedTranslation};
				const cachedSkipDecision = this.getCachedReceivedSkipDecision(queueItem.message, channelId, queueItem.originalContentData);
				if (cachedSkipDecision) return {queueItem, skipped: true, skipReason: cachedSkipDecision.reason, skipPreview: cachedSkipDecision.preview};
				if (!this.shouldAutoTranslateReceivedMessage(queueItem.message, queueItem.channel, queueItem.originalContentData, true)) return {queueItem, skipped: true};
				const originalContentData = queueItem.originalContentData || this.extractOriginalContentData(queueItem.message);
				const rawText = this.buildTranslationRequestText(originalContentData);
				const [protectedText, exceptions, shouldTranslate] = this.removeExceptions((rawText || "").trim(), messageTypes.RECEIVED);
				if (!shouldTranslate || !protectedText) return {queueItem, skipped: true};
				return {
					queueItem,
					message: queueItem.message,
					channelId,
					originalContentData,
					signature: this.createReceivedTranslationSignature(queueItem.message, channelId, originalContentData),
					protectedText,
					exceptions,
					input,
					output
				};
			}

			parseAiBatchTranslationResponse (content, expectedIds = null) {
				return this.ensureProviderClient().parseAiBatchTranslationResponse(content, expectedIds);
			}

			requestAiBatchTranslation (engineKey, preparedItems) {
				return this.ensureProviderClient().requestAiBatchTranslation(engineKey, preparedItems);
			}

			processAutoTranslationQueue () {
				return receivedTranslationRuntime.processAutoTranslationQueue(this);
			}
		
			forceUpdateAll () {
				favorites = BDFDB.DataUtils.load(this, "favorites");
				favorites = !BDFDB.ArrayUtils.is(favorites) ? [] : favorites;
				
				authKeys = BDFDB.DataUtils.load(this, "authKeys");
				channelLanguages = BDFDB.DataUtils.load(this, "channelLanguages");
				guildLanguages = BDFDB.DataUtils.load(this, "guildLanguages");
				channelPrimaryEngineOverrides = this.normalizeStoredChannelPrimaryEngineOverrides(BDFDB.DataUtils.load(this, "channelPrimaryEngineOverrides"));
				this.ensureTranslationCacheStore().loadPersisted();
				
				const storedTranslationEnabledStates = BDFDB.DataUtils.load(this, "translationEnabledStates");
				const storedReceivedAutoTranslationEnabledStates = BDFDB.DataUtils.load(this, "receivedAutoTranslationEnabledStates");
				const normalizedStoredTranslationEnabledStates = this.normalizeStoredChannelEnablementState(storedTranslationEnabledStates);
				const normalizedStoredReceivedAutoTranslationEnabledStates = this.normalizeStoredChannelEnablementState(storedReceivedAutoTranslationEnabledStates);
				translationEnabledStates = this.loadChannelEnablementState(storedTranslationEnabledStates, storedReceivedAutoTranslationEnabledStates);
				if (!normalizedStoredTranslationEnabledStates || !normalizedStoredReceivedAutoTranslationEnabledStates || !this.channelEnablementStatesEqual(normalizedStoredTranslationEnabledStates, translationEnabledStates) || !this.channelEnablementStatesEqual(normalizedStoredReceivedAutoTranslationEnabledStates, translationEnabledStates)) this.saveChannelEnablementState(translationEnabledStates);
				suppressedAutoTranslations = {};
				this.clearAutoTranslationQueue();
				this.resetAutoTranslationTracking();
				this.clearLoadedAutoTranslationStatus();
				isLiveAutoTranslating = false;
				replyPreviewTranslations = {};
				if (translationRerenderTimer) clearTimeout(translationRerenderTimer);
				translationRerenderTimer = null;
				if (deferredSettingsRerenderTimer) clearTimeout(deferredSettingsRerenderTimer);
				deferredSettingsRerenderTimer = null;
				
				this.setLanguages();
				BDFDB.PatchUtils.forceAllUpdates(this);
				BDFDB.MessageUtils.rerenderAll();
			}

			onMessageContextMenu (e) {
				if (e.instance.props.message && e.instance.props.channel) {
					let translated = this.isMessageDisplayTranslated(e.instance.props.message, e.instance.props.channel.id);
					let hint = BDFDB.BDUtils.isPluginEnabled("MessageUtilities") ? BDFDB.BDUtils.getPlugin("MessageUtilities").getActiveShortcutString("__Translate_Message") : null;
					let [children, index] = BDFDB.ContextMenuUtils.findItem(e.returnvalue, {id: ["copy-text", "pin", "unpin"]});
					if (index == -1) [children, index] = BDFDB.ContextMenuUtils.findItem(e.returnvalue, {id: ["edit", "add-reaction", "add-reaction-1", "quote"]});
					children.splice(index > -1 ? index + 1 : 0, 0, BDFDB.ContextMenuUtils.createItem(BDFDB.LibraryComponents.MenuItems.MenuItem, {
						label: translated ? this.labels.context_messageuntranslateoption : this.labels.context_messagetranslateoption,
						id: BDFDB.ContextMenuUtils.createItemId(this.name, translated ? "untranslate-message" : "translate-message"),
						icon: _ => BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.MenuItems.MenuIcon, {
							icon: translated ? translateIconUntranslate : translateIcon
						}),
						action: _ => this.translateMessage(e.instance.props.message, e.instance.props.channel, {manual: true, independentOfTextAreaSwitch: true, trackBusy: false})
					}));
					this.injectMessageLanguageActions(children, index > -1 ? index + 1 : 0, e.instance.props.message, e.instance.props.channel);
					this.injectSearchItem(e, false, e.instance.props.channel.id);
				}
			}
			
			onTextAreaContextMenu (e) {
				this.injectSearchItem(e, true);
			}
			
			injectSearchItem (e, ownMessage, channelId = null) {
				let text = document.getSelection().toString();
				if (text) {
					let translating, foundTranslation, foundInput, foundOutput, copied;
					let [children, index] = BDFDB.ContextMenuUtils.findItem(e.returnvalue, {id: ["devmode-copy-id", "search-google"], group: true});
					children.splice(index > -1 ? index + 1 : 0, 0, BDFDB.ContextMenuUtils.createItem(BDFDB.LibraryComponents.MenuItems.MenuGroup, {
						children: BDFDB.ContextMenuUtils.createItem(BDFDB.LibraryComponents.MenuItems.MenuItem, {
							id: BDFDB.ContextMenuUtils.createItemId(this.name, "search-translation"),
							icon: _ => BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.MenuItems.MenuIcon, {
								icon: translateIcon
							}),
							disabled: isTranslating,
							label: this.labels.context_translator,
							persisting: true,
							action: event => {
								let item = BDFDB.DOMUtils.getParent(BDFDB.dotCN.menuitem, event.target);
								if (item) {
									let createTooltip = _ => {
										BDFDB.TooltipUtils.create(item, !foundTranslation ? this.labels.toast_translating_failed : [
											`${BDFDB.LanguageUtils.LibraryStrings.from} ${this.getLanguageDisplayName(foundInput)}:`,
											text,
											`${BDFDB.LanguageUtils.LibraryStrings.to} ${this.getLanguageDisplayName(foundOutput)}:`,
											foundTranslation
										].map(n => BDFDB.ReactUtils.createElement("div", {children: n})), {
											type: "right",
											color: foundTranslation ? "primary" : "red",
											className: "googletranslate-tooltip"
										});
									};
									if (foundTranslation && foundInput && foundOutput) {
										if (document.querySelector(".googletranslate-tooltip")) {
											if (!copied) {
												copied = true;
												BDFDB.LibraryModules.WindowUtils.copy(foundTranslation);
												BDFDB.NotificationUtils.toast(BDFDB.LanguageUtils.LibraryStringsFormat("clipboard_success", BDFDB.LanguageUtils.LanguageStrings.TEXT), {type: "success"});
											}
											else {
												BDFDB.ContextMenuUtils.close(e.instance);
												BDFDB.DiscordUtils.openLink(this.getGoogleTranslatePageURL(foundInput.id, foundOutput.id, text));
											}
										}
										else createTooltip();
									}
									else if (!translating) {
										translating = true;
										this.translateText(text, ownMessage ? messageTypes.SENT : messageTypes.RECEIVED, (translation, input, output) => {
											if (translation) {
												foundTranslation = translation, foundInput = input, foundOutput = output;
												createTooltip();
											}
											else createTooltip();
										}, null, {channelId: channelId || BDFDB.LibraryStores.SelectedChannelStore.getChannelId()});
									}
								}
							}
						})
					}));
				}
			}
			
			processMessageButtons (e) {
				if (!e.instance.props.message || !e.instance.props.channel) return;
				let [children, index] = BDFDB.ReactUtils.findParent(e.returnvalue, {props: [["className", BDFDB.disCN.messagebuttons]]});
				if (index == -1) return;
				const channelId = e.instance.props.channel && e.instance.props.channel.id || null;
				let translated = this.isMessageDisplayTranslated(e.instance.props.message, channelId);
				children.unshift(BDFDB.ReactUtils.createElement(class extends BdApi.React.Component {
					render() {
						return BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.TooltipContainer, {
							key: translated ? "untranslate-message" : "translate-message",
							text: _ => translated ? _this.labels.context_messageuntranslateoption : _this.labels.context_messagetranslateoption,
							tooltipConfig: {className: BDFDB.disCN.messagetoolbartooltip},
							children: BDFDB.ReactUtils.createElement("div", {
								className: BDFDB.disCNS.messagetoolbarhoverbutton + BDFDB.disCN.messagetoolbarbutton,
								onClick: _ => {
									_this.translateMessage(e.instance.props.message, e.instance.props.channel, {manual: true, independentOfTextAreaSwitch: true, trackBusy: false}).then(_ => {
										translated = _this.isMessageDisplayTranslated(e.instance.props.message, channelId);
										BDFDB.ReactUtils.forceUpdate(this);
									});
								},
								children: BDFDB.ReactUtils.createElement("div", {
									className: BDFDB.disCNS.messagetoolbaricon + BDFDB.disCN.messagetoolbarbuttoncontent,
									children: BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.SvgIcon, {
										className: BDFDB.disCN.messagetoolbaricon,
										nativeClass: true,
										iconSVG: translated ? translateIconUntranslate : translateIcon
									})
								})
							})
						});
					}
				}));
			}
			
			processChannelTextAreaContainer (e) {
				if (e.instance.props.type != BDFDB.DiscordConstants.ChannelTextAreaTypes.NORMAL && e.instance.props.type != BDFDB.DiscordConstants.ChannelTextAreaTypes.SIDEBAR) return;
				BDFDB.PatchUtils.patch(this, e.instance.props, "onSubmit", {instead: e2 => {
					if (e2.methodArguments[0].value) {
						const text = e2.methodArguments[0].value;
						
						// Check for translation prefixes
						const prefixMap = {};
						const prefixData = this.settings.prefixes && this.settings.prefixes.translationPrefixData || [];
						for (const entry of prefixData) {
							prefixMap[entry.prefix] = entry.language;
						}
						
						let foundPrefix = null;
						let targetLanguage = null;
						
						// Check for prefixes more efficiently
						for (const prefix in prefixMap) {
							if (text.trim().startsWith(prefix)) {
								foundPrefix = prefix;
								targetLanguage = prefixMap[prefix];
								break;
							}
						}
						
						if (foundPrefix) {
							e2.stopOriginalMethodCall();
							// Remove the prefix from the message
							const cleanText = text.trim().substring(foundPrefix.length).trim();
							
							this.shouldAutoTranslateSentMessage(cleanText, e.instance.props.channel.id, shouldTranslate => {
								if (!shouldTranslate) return e2.originalMethod(Object.assign({}, e2.methodArguments[0], {value: cleanText}));
								// Translate with the specific target language
								this.translateText(cleanText, messageTypes.SENT, (translation, input, output) => {
									// Override the output language with the one from the prefix
									output = {id: targetLanguage, name: languages[targetLanguage] ? languages[targetLanguage].name : targetLanguage};
									
									translation = this.buildSentTranslationMessageValue(cleanText, translation, input, output);
									Promise.resolve(e2.originalMethod(Object.assign({}, e2.methodArguments[0], {value: translation}))).then(_ => {
										this.trackPendingSentOriginal(e.instance.props.channel.id, cleanText, translation);
									});
								}, targetLanguage, {channelId: e.instance.props.channel.id});
							}, targetLanguage);
							
							return Promise.resolve({
								shouldClear: true,
								shouldRefocus: true
							});
						}
						else if (this.isTranslationEnabled(e.instance.props.channel.id)) {
							e2.stopOriginalMethodCall();
							const originalValue = e2.methodArguments[0].value;
							const channelId = e.instance.props.channel.id;
							const sentRequest = this.createSentAutomaticTranslationRequest(channelId, originalValue);
							const submit = nextValue => e2.originalMethod(Object.assign({}, e2.methodArguments[0], {value: nextValue}));
							this.shouldAutoTranslateSentMessage(originalValue, e.instance.props.channel.id, shouldTranslate => {
								if (!shouldTranslate || !this.isSentAutomaticTranslationRequestCurrent(sentRequest)) return this.completeSentAutomaticTranslationRequest(sentRequest, originalValue, submit);
								this.translateText(originalValue, messageTypes.SENT, (translation, input, output) => {
									translation = this.buildSentTranslationMessageValue(originalValue, translation, input, output);
									this.completeSentAutomaticTranslationRequest(sentRequest, translation, submit);
								}, null, {channelId});
							});
							return Promise.resolve({
								shouldClear: true,
								shouldRefocus: true
							});
						}
					}
					return e2.callOriginalMethodAfterwards();
				}}, {noCache: true});
			}
			
			processChannelTextAreaEditor (e) {
				// Do not disable the text area while background/manual message translations are running.
				// Disabling here interrupts draft typing and can drop unsent text during message list refreshes.
			}
			
			processChannelTextAreaButtons (e) {
				if (e.instance.props.disabled || e.instance.props.type != BDFDB.DiscordConstants.ChannelTextAreaTypes.NORMAL && e.instance.props.type != BDFDB.DiscordConstants.ChannelTextAreaTypes.SIDEBAR) return;
				if (!e.returnvalue || !e.returnvalue.props) return;
				let children = [].concat(e.returnvalue.props.children || []).filter(child => {
					if (!child) return false;
					if (child.key == `${this.name}-translate-textarea-button`) return false;
					const className = child.props && typeof child.props.className == "string" ? child.props.className : "";
					return !className.includes("_translatortranslatebutton");
				});
				children.unshift(BDFDB.ReactUtils.createElement(TranslateButtonComponent, {
					key: `${this.name}-translate-textarea-button`,
					guildId: e.instance.props.channel.guild_id ? e.instance.props.channel.guild_id : "@me",
					channelId: e.instance.props.channel.id
				}));
				e.returnvalue.props.children = children;
			}

			get modelCatalogState () {
				return this.ensureProviderClient().getModelCatalogState();
			}

			ensureProviderClient () {
				if (!this.providerClientInstance) this.providerClientInstance = createProviderClient({
					request: (url, options, callback) => BDFDB.LibraryRequires.request(url, options, callback),
					setTimeout: (callback, delay) => BDFDB.TimeUtils.timeout(callback, delay),
					clearTimeout: timer => BDFDB.TimeUtils.clear(timer),
					// A raw global timer on purpose: routing the backoff sleep through BDFDB would
					// leave the awaiting promise pending forever once the plugin stops.
					sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
					now: () => Date.now(),
					getAuthKeys: () => authKeys,
					saveAuthKeys: value => BDFDB.DataUtils.save(value, this, "authKeys"),
					getLanguages: () => languages,
					notify: (message, options) => BDFDB.NotificationUtils.toast(message, options),
					getLabels: () => this.labels,
					getCustomText: key => this.getCustomText(key),
					getEngineLabel: engineKey => this.getEngineLabel(engineKey),
					shouldUseAiAutoTranslateDecision: channelId => this.shouldUseAiAutoTranslateDecision(channelId),
					getAiAutoTranslatePrompt: translationData => this.getAiAutoTranslatePrompt(translationData)
				});
				return this.providerClientInstance;
			}

			ensureTranslationCacheStore () {
				if (!this.translationCacheStoreInstance) this.translationCacheStoreInstance = createTranslationCacheStore({
					now: () => Date.now(),
					setTimeout: (callback, delay) => setTimeout(callback, delay),
					clearTimeout: timer => clearTimeout(timer),
					loadCache: () => BDFDB.DataUtils.load(this, "translationCache"),
					saveCache: cache => BDFDB.DataUtils.save(cache, this, "translationCache"),
					extractOriginalContentData: message => this.extractOriginalContentData(message),
					createSignature: (message, channelId, sourceData) => this.createReceivedTranslationSignature(message, channelId, sourceData),
					normalizeStoredTranslation: translation => this.normalizeStoredTranslationData(translation),
					extractLegacyDisplayedParts: content => this.extractLegacyDisplayedTranslationParts(content),
					// Policy and display stay in the received-translation runtime; a cache lookup
					// asks whether an old entry still passes today's guards, it does not decide.
					refreshTranslationDisplay: translation => this.refreshTranslationDisplay(translation),
					isTranslationResultTooSimilar: translation => this.isTranslationResultTooSimilar(translation),
					shouldSkipBeforeRequest: (sourceData, channelId) => this.shouldSkipReceivedTranslationBeforeRequest(sourceData, channelId),
					shouldKeepAutoTranslatedResult: (translation, channelId) => this.shouldKeepAutoTranslatedResult(translation, channelId),
					getSkipPreviewText: text => this.getLoadedAutoTranslationPreviewText(text)
				});
				return this.translationCacheStoreInstance;
			}

			ensureMessageViewportStore () {
				if (!this.messageViewportStoreInstance) this.messageViewportStoreInstance = createMessageViewportStore({
					getDocument: () => typeof document == "undefined" ? null : document,
					setTimeout: (callback, delay) => setTimeout(callback, delay),
					clearTimeout: timer => clearTimeout(timer),
					requestAnimationFrame: callback => typeof requestAnimationFrame == "function" ? requestAnimationFrame(callback) : setTimeout(callback, 0),
					now: () => Date.now(),
					getSelectedChannelId: () => BDFDB.LibraryStores.SelectedChannelStore.getChannelId(),
					getMessagesScrollerSelector: () => BDFDB.dotCN && BDFDB.dotCN.messagesscroller,
					getChannelTextAreaSelector: () => BDFDB.dotCN && BDFDB.dotCN.channeltextarea,
					escapeSelectorValue: value => typeof CSS != "undefined" && CSS.escape ? CSS.escape(value) : String(value).replace(/(["\\])/g, "\\$1"),
					// Closing the user-scroll window is the moment a historical snapshot may commit.
					onScrollActivityFinished: channelId => this.finishHistoricalTranslationSnapshot(channelId)
				});
				return this.messageViewportStoreInstance;
			}

			ensureReceivedDisplayRuntime () {
				if (!this.receivedDisplayRuntimeInstance) this.receivedDisplayRuntimeInstance = createDisplayRuntime({
					BDFDB: {
						dotCN: BDFDB.dotCN || {},
						ReactUtils: BDFDB.ReactUtils,
						MessageUtils: BDFDB.MessageUtils
					},
					document: {
						querySelector: selector => typeof document == "undefined" || !document || !selector ? null : document.querySelector(selector)
					},
					requestAnimationFrame: callback => typeof requestAnimationFrame == "function" ? requestAnimationFrame(callback) : setTimeout(callback, 0),
					setTimeout: (callback, delay) => setTimeout(callback, delay),
					getUserScrollIntentSequence: () => this.ensureMessageViewportStore().getUserScrollIntentSequence(),
					// Scroll preservation is best-effort: a capture or restore failure must never
					// break an acknowledged display transaction.
					captureScrollState: () => {
						try {return this.captureMessageScrollerState();}
						catch (error) {return null;}
					},
					restoreScrollState: scrollerState => {
						try {this.restoreMessageScrollerState(scrollerState);}
						catch (error) {}
					}
				});
				return this.receivedDisplayRuntimeInstance;
			}

			resetReceivedDisplayRuntime () {
				this.receivedDisplayRuntimeInstance = null;
			}

			captureReceivedMessageSource (snapshot) {
				return this.ensureReceivedDisplayRuntime().captureSource(snapshot);
			}

			markReceivedDisplayPending (request, options) {
				return this.ensureReceivedDisplayRuntime().markPending(request, options);
			}

			commitReceivedDisplayResult (result, options) {
				return this.ensureReceivedDisplayRuntime().commitMessageResult(result, options);
			}

			commitHistoricalReceivedDisplayBatch (results) {
				return this.ensureReceivedDisplayRuntime().commitHistoricalBatch(results);
			}

			getReceivedDisplayView (messageId) {
				return this.ensureReceivedDisplayRuntime().getDisplayView(messageId);
			}

			getReceivedDisplayRuntimeView (messageId) {
				return this.ensureReceivedDisplayRuntime().getDisplayView(messageId);
			}

			restoreReceivedDisplayChannel (channelId) {
				return this.ensureReceivedDisplayRuntime().restoreChannel(channelId);
			}

			restoreAllReceivedDisplay (options) {
				return this.ensureReceivedDisplayRuntime().restoreAll(options);
			}

			setReceivedDisplayGeneration (channelId, generation) {
				return this.ensureReceivedDisplayRuntime().setChannelGeneration(channelId, generation);
			}

			getReceivedDisplayGeneration (channelId) {
				return this.ensureReceivedDisplayRuntime().getChannelGeneration(channelId);
			}

			getReceivedDisplayCommitGeneration (channelId) {
				const generation = this.getReceivedDisplayGeneration(channelId);
				return generation === undefined ? 1 : generation;
			}

			releaseReceivedDisplayPending (request) {
				return this.ensureReceivedDisplayRuntime().releasePending(request);
			}

			// Live automatic commits write the store immediately and coalesce their visible
			// refresh: one acknowledged display transaction per channel per debounce window
			// instead of one full-list repaint (plus scroll restore) per message.
			// Repaint cadence lives in the scheduler module; the plugin only supplies the
			// predicates that depend on Discord state.
			canRepaintReceivedDisplayNow () {
				return !this.isTranslatorSettingsSurfaceOpen() && !this.isChannelTextAreaFocused();
			}

			ensureReceivedDisplayRepaintScheduler () {
				if (!this.receivedDisplayRepaintSchedulerInstance) this.receivedDisplayRepaintSchedulerInstance = createDisplayRepaintScheduler({
					renderMessages: messageIds => this.ensureReceivedDisplayRuntime().renderMessages(messageIds),
					canRepaintNow: () => this.canRepaintReceivedDisplayNow(),
					isViewingHistory: () => this.isViewingMessageHistory(),
					lastRenderUsedFallback: () => this.ensureReceivedDisplayRuntime().lastRenderUsedFallback()
				});
				return this.receivedDisplayRepaintSchedulerInstance;
			}

			getReceivedDisplayFlushDelay () {
				return this.ensureReceivedDisplayRepaintScheduler().getNextDelay();
			}

			scheduleReceivedDisplayFlush (channelId, messageId, delay = null) {
				this.ensureReceivedDisplayRepaintScheduler().schedule(channelId, messageId, delay);
			}

			flushReceivedDisplayQueues () {
				this.ensureReceivedDisplayRepaintScheduler().flush();
			}

			clearReceivedDisplayFlushQueue () {
				this.ensureReceivedDisplayRepaintScheduler().clear();
			}

			restoreReceivedDisplayMessage (messageId, options) {
				return this.ensureReceivedDisplayRuntime().restoreMessage(messageId, options);
			}

			isMessageDisplayTranslated (message, channelId = null) {
				if (!message || !message.id) return false;
				if (this.getActiveMessageTranslation(message, channelId)) return true;
				const displayView = this.getReceivedDisplayRuntimeView(message.id);
				return !!(displayView && displayView.translated);
			}

			createReceivedDisplayCommitResult (message, channelId, overrides) {
				return Object.assign({
					messageId: message.id,
					channelId,
					generation: this.getReceivedDisplayCommitGeneration(channelId),
					origin: "automatic",
					requestIdentity: null
				}, overrides);
			}

			// Display composition happens at render time so Display settings changed after a
			// commit still shape the painted content; the frozen store record keeps only the
			// translation facts.
			getReceivedDisplayViewRenderContent (view) {
				if (!view) return "";
				if (view.translated && view.translation) {
					const translatedContent = view.translation.translatedContent != null && view.translation.translatedContent !== "" ? view.translation.translatedContent : view.translation.content;
					return this.buildReceivedDisplayContent(String(translatedContent == null ? "" : translatedContent), view.translation.originalContent || "");
				}
				return String(view.content == null ? "" : view.content);
			}

			applyReceivedDisplayViewToStream (stream, view) {
				if (!stream || !stream.content || !view) return;
				const displayContent = this.getReceivedDisplayViewRenderContent(view);
				if (stream.content.content === displayContent) return;
				const clonedMessage = new BDFDB.DiscordObjects.Message(stream.content);
				clonedMessage.content = displayContent;
				stream.content = clonedMessage;
			}

			applyReceivedDisplayViewToContent (e, view) {
				if (!e || !e.returnvalue || !e.returnvalue.props) return;
				this.cleanupInjectedMessageChildren(this.ensureElementChildrenArray(e.returnvalue));
				translationDisplayLogic.clearTranslatedRenderDecorations(this, e);
				if (!view) {
					delete e.returnvalue.props["data-translator-revision"];
					return;
				}
				e.returnvalue.props["data-translator-revision"] = String(view.revision);
				if (view.translated && view.translation) {
					if (this.shouldProtectWrappedTextForPlace(messageTypes.RECEIVED)) e.returnvalue.props.children = this.highlightProtectedWrappedTextInNode(e.returnvalue.props.children, view.messageId);
					if (this.settings.general.highlightTranslatedMessages) e.returnvalue.props.className = BDFDB.DOMUtils.formatClassName(e.returnvalue.props.className, "translator-translated-message");
					e.returnvalue.props.style = Object.assign({}, e.returnvalue.props.style, {
						"--translator-accent-color": this.getTranslatedTextColor(),
						"--translator-text-color": this.getTranslatedTextColor()
					});
					const watermarkNode = translationDisplayLogic.createTranslationWatermarkNode(this, view.translation, "translator-translated-watermark");
					if (watermarkNode) this.ensureElementChildrenArray(e.returnvalue).push(watermarkNode);
					if (view.translation.originalContent && this.settings.general.showOriginalMessage && this.settings.general.showOriginalDirectly) this.ensureElementChildrenArray(e.returnvalue).push(this.createOriginalMessageBlock(view.translation.originalContent));
					return;
				}
				if (view.showLoading) this.ensureElementChildrenArray(e.returnvalue).push(BDFDB.ReactUtils.createElement("span", {
					key: "translator-translation-loading",
					className: "translator-translation-loading",
					"aria-label": this.isChineseUiLanguage() ? "正在翻译" : "Translating"
				}));
			}

			processMessages (e) {
				return receivedTranslationRuntime.processMessages(this, e);
			}

			checkMessage (stream, message, channel, options = {}) {
				return receivedTranslationRuntime.checkMessage(this, stream, message, channel, options);
			}

			processMessageReply (e) {
				return translationDisplayLogic.processMessageReply(this, e);
			}

			processMessageContent (e) {
				if (!e.instance.props.message || !e.returnvalue || !e.returnvalue.props) return;
				let message = e.instance.props.message;
				if (this.isRenderingReplyPreviewMessage(message)) {
					let children = this.ensureElementChildrenArray(e.returnvalue);
					this.cleanupInjectedMessageChildren(children);
					e.returnvalue = this.stripTranslatorStylingFromReplyPreviewNode(e.returnvalue);
					return;
				}
				const displayState = translationDisplayLogic.prepareMessageContentDisplay(this, e);
				message = displayState.message;
				const translation = displayState.translation;
				const displayView = this.getReceivedDisplayRuntimeView(message.id);
				if (!translation && displayView && displayView.translated) {
					this.applyReceivedDisplayViewToContent(e, displayView);
					return;
				}
				translationDisplayLogic.applyMessageContentRenderDecorations(this, e, message, translation);
				if (displayView) e.returnvalue.props["data-translator-revision"] = String(displayView.revision);
				else delete e.returnvalue.props["data-translator-revision"];
			}

			processEmbed (e) {
				return translationDisplayLogic.processEmbed(this, e);
			}

			isTranslatableChannelTitle (channel) {
				if (!channel || !channel.id || !(channel.name || "").trim()) return false;
				try {
					if (BDFDB.ChannelUtils && (BDFDB.ChannelUtils.isThread(channel) || BDFDB.ChannelUtils.isForumPost(channel))) return true;
				}
				catch (error) {}
				try {return typeof channel.isThread == "function" && channel.isThread();}
				catch (error) {return false;}
			}

			getChannelTitleTranslationSignature (channel) {
				if (!this.isTranslatableChannelTitle(channel)) return "";
				const channelId = channel.id;
				return JSON.stringify(Object.assign({}, this.getReceivedTranslationRequestConfigurationData(channelId), {
					name: channel.name
				}));
			}

			getActiveChannelTitleTranslation (channel) {
				if (!this.isTranslatableChannelTitle(channel) || !this.isTranslationEnabled(channel.id)) return null;
				return channelTitleStore.getTranslatedTitle(channel.id, this.getChannelTitleTranslationSignature(channel));
			}

			cancelPendingChannelTitleTranslation (channelId = null) {
				channelTitleStore.cancelPending(channelId);
			}

			clearChannelTitleTranslations (channelId = null) {
				if (channelTitleStore.clear(channelId)) this.forceUpdateChannelTitleComponents();
			}

			queueChannelTitleTranslation (channel) {
				if (!pluginRuntimeActive || !this.isTranslatableChannelTitle(channel) || !this.isTranslationEnabled(channel.id)) return false;
				const channelId = channel.id;
				const signature = this.getChannelTitleTranslationSignature(channel);
				if (!signature) return false;
				const request = channelTitleStore.beginRequest(channelId, signature);
				if (!request) return false;
				this.translateText(channel.name, messageTypes.RECEIVED, (translation, _input, _output, meta = {}) => {
					if (!channelTitleStore.isRequestCurrent(request)) return;
					// The plugin may have stopped, the channel may have been disabled, or the title
					// may have changed while the provider was working; none of those may commit.
					if (!pluginRuntimeActive || !this.isTranslationEnabled(channelId) || this.getChannelTitleTranslationSignature(channel) != signature) {
						channelTitleStore.abandonRequest(request);
						return;
					}
					if (!translation && !(meta && meta.skipped)) {
						channelTitleStore.failRequest(request);
						return;
					}
					if (channelTitleStore.completeRequest(request, translation || channel.name)) this.forceUpdateChannelTitleComponents();
				}, null, {auto: true, showToast: false, showFailureToast: false, trackBusy: false, channelId});
				return true;
			}

			replaceChannelTitleInRenderTree (node, originalTitle, translatedTitle) {
				if (typeof node == "string") return node == originalTitle ? translatedTitle : node;
				if (BDFDB.ArrayUtils.is(node)) {
					for (let index = 0; index < node.length; index++) node[index] = this.replaceChannelTitleInRenderTree(node[index], originalTitle, translatedTitle);
					return node;
				}
				if (!node || typeof node != "object" || !node.props) return node;
				if (Object.prototype.hasOwnProperty.call(node.props, "children")) node.props.children = this.replaceChannelTitleInRenderTree(node.props.children, originalTitle, translatedTitle);
				for (const key of ["text", "title", "aria-label", "threadName", "channelName"]) if (node.props[key] == originalTitle) node.props[key] = translatedTitle;
				return node;
			}

			getChannelFromTitlePatchEvent (e) {
				const props = e && e.instance && e.instance.props || {};
				for (const channel of [props.thread, props.activeThread, props.sidebarChannel]) if (channel && channel.id) return channel;
				const threadId = props.threadId || props.activeThreadId || props.sidebarChannelId;
				if (threadId) {
					const thread = BDFDB.LibraryStores.ChannelStore.getChannel(threadId);
					if (thread) return thread;
				}
				if (props.channelId) {
					const explicitChannel = BDFDB.LibraryStores.ChannelStore.getChannel(props.channelId);
					if (this.isTranslatableChannelTitle(explicitChannel)) return explicitChannel;
				}
				for (const channel of [props.channel, props.activeChannel]) if (channel && channel.id) return channel;
				const channelId = props.channelId || props.id || BDFDB.LibraryStores.SelectedChannelStore.getChannelId();
				return channelId && BDFDB.LibraryStores.ChannelStore.getChannel(channelId) || null;
			}

			processChannelTitlePatch (e) {
				const channel = this.getChannelFromTitlePatchEvent(e);
				if (!this.isTranslatableChannelTitle(channel) || !this.isTranslationEnabled(channel.id)) return;
				const translatedTitle = this.getActiveChannelTitleTranslation(channel);
				if (!translatedTitle) {
					this.queueChannelTitleTranslation(channel);
					return;
				}
				e.returnvalue = this.replaceChannelTitleInRenderTree(e.returnvalue, channel.name, translatedTitle);
			}

			forceUpdateChannelTitleComponents () {
				BDFDB.PatchUtils.forceAllUpdates(this, ["HeaderBarChannelName", "HeaderBarTitle", "ThreadCard", "ThreadSidebar", "ChannelThreadItem"]);
			}

			processHeaderBarChannelName (e) {this.processChannelTitlePatch(e);}
			processHeaderBarTitle (e) {this.processChannelTitlePatch(e);}
			processThreadCard (e) {this.processChannelTitlePatch(e);}
			processThreadSidebar (e) {this.processChannelTitlePatch(e);}
			processChannelThreadItem (e) {this.processChannelTitlePatch(e);}

			normalizeStoredChannelPrimaryEngineOverrides (overrides) {
				if (!overrides || typeof overrides != "object" || Array.isArray(overrides)) return {};
				const normalizedOverrides = {};
				for (const channelId in overrides) {
					const engineKey = overrides[channelId];
					if (!channelId || typeof engineKey != "string" || !translationEngines[engineKey]) continue;
					normalizedOverrides[channelId] = engineKey;
				}
				return normalizedOverrides;
			}

			getGlobalPrimaryEngine () {
				const engineKey = this.settings && this.settings.engines && this.settings.engines.translator;
				return translationEngines[engineKey] ? engineKey : Object.keys(translationEngines)[0];
			}

			getEffectivePrimaryEngine (channelId = null) {
				if (channelId && translationEngines[channelPrimaryEngineOverrides[channelId]]) return channelPrimaryEngineOverrides[channelId];
				return this.getGlobalPrimaryEngine();
			}

			getEffectiveBackupEngine (channelId = null) {
				const backupEngineKey = this.settings && this.settings.engines && this.settings.engines.backup;
				if (!translationEngines[backupEngineKey] || backupEngineKey == this.getEffectivePrimaryEngine(channelId)) return "----";
				return backupEngineKey;
			}

			getAdditionalCredentialEngineKeys () {
				const activeEngineKeys = new Set([
					this.settings && this.settings.engines && this.settings.engines.translator,
					this.settings && this.settings.engines && this.settings.engines.backup
				]);
				return Object.keys(translationEngines).filter(engineKey => translationEngines[engineKey].key && !activeEngineKeys.has(engineKey));
			}

			isEngineConfiguredForRuntime (engineKey) {
				return this.ensureProviderClient().isEngineConfiguredForRuntime(engineKey);
			}

			engineSupportsLanguage (engineKey, language) {
				const engine = translationEngines[engineKey];
				if (!engine || !language) return false;
				if (language.special) return true;
				if (language.auto) return !!engine.auto;
				return engine.languages.includes(language.id);
			}

			engineSupportsLanguagePair (engineKey, input, output) {
				if (output && output.special) return true;
				return this.engineSupportsLanguage(engineKey, input) && this.engineSupportsLanguage(engineKey, output);
			}

			hasChannelPrimaryEngineOverride (channelId) {
				return !!channelId && Object.prototype.hasOwnProperty.call(channelPrimaryEngineOverrides, channelId) && !!translationEngines[channelPrimaryEngineOverrides[channelId]];
			}

			saveChannelPrimaryEngineOverrides () {
				BDFDB.DataUtils.save(channelPrimaryEngineOverrides, this, "channelPrimaryEngineOverrides");
			}

			setChannelPrimaryEngine (channelId, engineKey) {
				if (!channelId || !translationEngines[engineKey]) return false;
				channelPrimaryEngineOverrides[channelId] = engineKey;
				this.saveChannelPrimaryEngineOverrides();
				return true;
			}

			clearChannelPrimaryEngineOverride (channelId) {
				if (!channelId || !Object.prototype.hasOwnProperty.call(channelPrimaryEngineOverrides, channelId)) return false;
				delete channelPrimaryEngineOverrides[channelId];
				this.saveChannelPrimaryEngineOverrides();
				return true;
			}

			refreshChannelPrimaryEngineRuntime (channelId) {
				if (!channelId) return;
				this.clearDisplayedAutoTranslations(channelId);
				this.clearAutoTranslationQueue(channelId);
				this.resetAutoTranslationTracking(channelId);
				this.scheduleTranslationRerender();
				this.processAutoTranslationQueue();
			}

			createEmptyChannelEnablementState (globalDefault = false) {
				return {
					globalDefault: !!globalDefault,
					channelOverrides: {}
				};
			}

			normalizeStoredChannelEnablementState (state) {
				if (!state || typeof state != "object" || Array.isArray(state)) return null;
				const normalizedState = this.createEmptyChannelEnablementState(state.globalDefault);
				const overrides = state.channelOverrides;
				if (!overrides || typeof overrides != "object" || Array.isArray(overrides)) return normalizedState;
				for (const channelId in overrides) {
					if (!channelId) continue;
					if (typeof overrides[channelId] != "boolean") continue;
					normalizedState.channelOverrides[channelId] = overrides[channelId];
				}
				return normalizedState;
			}

			migrateLegacyChannelEnablementState (stateKeys) {
				const normalizedState = this.createEmptyChannelEnablementState(false);
				for (const stateKey of stateKeys || []) {
					if (typeof stateKey != "string" || !stateKey || stateKey == "global") continue;
					normalizedState.channelOverrides[stateKey] = true;
				}
				return normalizedState;
			}

			loadChannelEnablementState (primaryStoredState, secondaryStoredState) {
				const normalizedPrimaryState = this.normalizeStoredChannelEnablementState(primaryStoredState) || (BDFDB.ArrayUtils.is(primaryStoredState) ? this.migrateLegacyChannelEnablementState(primaryStoredState) : null);
				const normalizedSecondaryState = this.normalizeStoredChannelEnablementState(secondaryStoredState) || (BDFDB.ArrayUtils.is(secondaryStoredState) ? this.migrateLegacyChannelEnablementState(secondaryStoredState) : null);
				return {
					globalDefault: false,
					channelOverrides: Object.assign({}, normalizedSecondaryState && normalizedSecondaryState.channelOverrides, normalizedPrimaryState && normalizedPrimaryState.channelOverrides)
				};
			}

			getChannelEnablementStateValue (channelId, state) {
				const normalizedState = this.normalizeStoredChannelEnablementState(state) || this.createEmptyChannelEnablementState(false);
				if (channelId && Object.prototype.hasOwnProperty.call(normalizedState.channelOverrides, channelId)) return normalizedState.channelOverrides[channelId];
				return normalizedState.globalDefault;
			}

			channelEnablementStatesEqual (leftState, rightState) {
				const normalizedLeftState = this.normalizeStoredChannelEnablementState(leftState) || this.createEmptyChannelEnablementState(false);
				const normalizedRightState = this.normalizeStoredChannelEnablementState(rightState) || this.createEmptyChannelEnablementState(false);
				if (normalizedLeftState.globalDefault != normalizedRightState.globalDefault) return false;
				const leftChannelIds = Object.keys(normalizedLeftState.channelOverrides);
				const rightChannelIds = Object.keys(normalizedRightState.channelOverrides);
				if (leftChannelIds.length != rightChannelIds.length) return false;
				for (const channelId of leftChannelIds) if (normalizedLeftState.channelOverrides[channelId] != normalizedRightState.channelOverrides[channelId]) return false;
				return true;
			}

			saveChannelEnablementState (nextState) {
				translationEnabledStates = nextState;
				BDFDB.DataUtils.save(nextState, this, "translationEnabledStates");
				BDFDB.DataUtils.save(nextState, this, "receivedAutoTranslationEnabledStates");
			}

			setChannelEnablementStateValue (channelId, enabled) {
				const currentState = this.normalizeStoredChannelEnablementState(translationEnabledStates) || this.createEmptyChannelEnablementState(false);
				const nextState = {
					globalDefault: false,
					channelOverrides: Object.assign({}, currentState.channelOverrides)
				};
				if (!channelId) return currentState;
				if (enabled == nextState.globalDefault) delete nextState.channelOverrides[channelId];
				else nextState.channelOverrides[channelId] = !!enabled;
				this.saveChannelEnablementState(nextState);
				return nextState;
			}

			async toggleTranslation (channelId) {
				const wasEnabled = this.isTranslationEnabled(channelId);
				this.setChannelEnablementStateValue(channelId, !wasEnabled);
				if (wasEnabled) {
					// A disabled channel session invalidates every in-flight commit before the
					// restore transaction repaints originals with acknowledgement.
					const displayGeneration = this.getReceivedDisplayGeneration(channelId);
					if (displayGeneration !== undefined) this.setReceivedDisplayGeneration(channelId, displayGeneration + 1);
					this.clearDisplayedAutoTranslations(channelId);
					this.clearAutoTranslationQueue(channelId);
					this.resetAutoTranslationTracking(channelId);
					await this.restoreReceivedDisplayChannel(channelId);
					this.scheduleTranslationRerender();
					this.processAutoTranslationQueue();
					return;
				}
				this.resetAutoTranslationTracking(channelId);
				this.scheduleTranslationRerender();
				this.processAutoTranslationQueue();
			}
			
			isTranslationEnabled (channelId) {
				return this.getChannelEnablementStateValue(channelId, translationEnabledStates);
			}

			toggleReceivedAutoTranslation (channelId) {
				return this.toggleTranslation(channelId);
			}

			isReceivedAutoTranslationEnabled (channelId) {
				return this.isTranslationEnabled(channelId);
			}

			setLanguages () {
				if (this.settings.engines.translator == this.settings.engines.backup) {
					this.settings.engines.backup = Object.keys(translationEngines).filter(n => n != this.settings.engines.translator)[0];
					BDFDB.DataUtils.save(this.settings.engines, this, "engines");
				}
				let languageIds = Object.values(translationEngines).reduce((ids, translationEngine) => ids.concat(translationEngine.languages || []), []);
				languages = BDFDB.ObjectUtils.deepAssign(
					!Object.values(translationEngines).some(translationEngine => translationEngine.auto) ? {} : {
						auto: {
							auto: true,
							name: this.labels.detect_language,
							id: "auto"
						}
					},
					BDFDB.ObjectUtils.filter(BDFDB.LanguageUtils.languages, lang => languageIds.includes(lang.id)),
					{
						binary:	{
							special: true,
							name: "Binary",
							id: "binary"
						},
						braille: {
							special: true,
							name: "Braille 6-dot",
							id: "braille"
						},
						morse: {
							special: true,
							name: "Morse",
							id: "morse"
						},
                        hex: {
                            special: true,
                            name: "Hexadecimal",
                            id: "hex"
                        },
					}
				);
				for (let id in languages) languages[id].fav = favorites.includes(id) ? 0 : 1;
				languages = BDFDB.ObjectUtils.sort(languages, "fav");
			}

			getLanguageData (language) {
				if (!language) return null;
				if (typeof language == "string") return languages[language] || BDFDB.LanguageUtils.languages[language] || {id: language, name: language};
				return language;
			}

			getChineseLanguageName (languageId) {
				if (!languageId) return "";
				const overrideNames = {
					auto: "检测语言",
					"zh": "中文",
					"zh-CN": "简体中文",
					"zh-TW": "繁体中文"
				};
				if (overrideNames[languageId]) return overrideNames[languageId];
				const normalizedId = ({
					iw: "he",
					jw: "jv"
				})[languageId] || languageId;
				try {
					if (typeof Intl != "undefined" && typeof Intl.DisplayNames == "function") {
						const displayNames = new Intl.DisplayNames(["zh-Hans"], {type: "language"});
						return displayNames.of(normalizedId) || "";
					}
				}
				catch (err) {}
				return "";
			}

			getLanguageDisplayName (language) {
				const languageData = this.getLanguageData(language);
				if (!languageData) return "";
				const baseName = BDFDB.LanguageUtils.getName(languageData) || languageData.name || languageData.id;
				const chineseName = this.getChineseLanguageName(languageData.id);
				if (!chineseName || baseName == chineseName || baseName.includes(` / ${chineseName}`)) return baseName;
				return `${baseName} / ${chineseName}`;
			}

			getTranslationTooltipText (inputLanguage, outputLanguage) {
				return `${this.getLanguageDisplayName(inputLanguage)} -> ${this.getLanguageDisplayName(outputLanguage)}`;
			}

			detectLanguageDetails (text) {
				return new Promise(resolve => {
					this.detectLanguage(text, languageId => {
						const languageData = languageId && this.getLanguageData(languageId);
						resolve(languageData ? languageData : null);
					});
				});
			}

			getOriginalMessageLabel () {
				if (this.isChineseUiLanguage()) return "原文";
				if (this.isRussianUiLanguage()) return "Оригинал";
				return "Original";
			}

			formatOriginalTextForMessage (originalText, useSpoiler = this.shouldUseSpoilerInSentOriginal()) {
				if (!originalText) return "";
				if (useSpoiler) return `\n||${originalText}||`;
				return `\n> ${originalText.split("\n").join("\n> ")}`;
			}

			getCustomEmojiAssetUrl (emojiId, animated = false) {
				if (!emojiId) return "";
				return `https://cdn.discordapp.com/emojis/${emojiId}.${animated ? "gif" : "webp"}?size=40&quality=lossless`;
			}

			createDiscordMarkupDisplayNode (token, key) {
				if (!token) return token;
				let match = /^<(a?):([A-Za-z0-9_~]+):(\d+)>$/.exec(token);
				if (match) {
					const animated = match[1] == "a";
					const emojiName = match[2];
					const emojiId = match[3];
					return BDFDB.ReactUtils.createElement("img", {
						key,
						className: "translator-discord-emoji",
						src: this.getCustomEmojiAssetUrl(emojiId, animated),
						alt: `:${emojiName}:`,
						title: `:${emojiName}:`,
						draggable: false
					});
				}
				match = /^<@!?(\d+)>$/.exec(token);
				if (match) {
					const displayName = this.getMentionDisplayName(match[1]) || "user";
					return BDFDB.ReactUtils.createElement("span", {
						key,
						className: "translator-discord-mention",
						children: `@${displayName}`
					});
				}
				match = /^<@&(\d+)>$/.exec(token);
				if (match) {
					let roleName = "role";
					try {
						const guildId = BDFDB.LibraryStores.SelectedGuildStore && BDFDB.LibraryStores.SelectedGuildStore.getGuildId && BDFDB.LibraryStores.SelectedGuildStore.getGuildId();
						const role = guildId && BDFDB.LibraryStores.GuildStore && BDFDB.LibraryStores.GuildStore.getRole && BDFDB.LibraryStores.GuildStore.getRole(guildId, match[1]);
						if (role && role.name) roleName = role.name;
					}
					catch (err) {}
					return BDFDB.ReactUtils.createElement("span", {
						key,
						className: "translator-discord-mention translator-discord-role-mention",
						children: `@${roleName}`
					});
				}
				match = /^<#(\d+)>$/.exec(token);
				if (match) {
					let channelName = "channel";
					try {
						const channel = BDFDB.LibraryStores.ChannelStore && BDFDB.LibraryStores.ChannelStore.getChannel && BDFDB.LibraryStores.ChannelStore.getChannel(match[1]);
						if (channel && channel.name) channelName = channel.name;
					}
					catch (err) {}
					return BDFDB.ReactUtils.createElement("span", {
						key,
						className: "translator-discord-mention translator-discord-channel-mention",
						children: `#${channelName}`
					});
				}
				return token;
			}

			renderDiscordMarkupText (text, keyPrefix = "discord-markup") {
				if (text == null) return "";
				text = String(text);
				const nodes = [];
				const tokenRegex = /(<a?:[A-Za-z0-9_~]+:\d+>|<@!?\d+>|<@&\d+>|<#\d+>)/g;
				let lastIndex = 0;
				let match;
				let index = 0;
				while ((match = tokenRegex.exec(text))) {
					if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
					nodes.push(this.createDiscordMarkupDisplayNode(match[0], `${keyPrefix}-${index++}`));
					lastIndex = match.index + match[0].length;
				}
				if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
				return nodes;
			}

			createOriginalMessageBlock (originalText) {
				if (!originalText) return null;
				return BDFDB.ReactUtils.createElement("div", {
					key: "translator-original-message",
					className: "translator-original-message",
					children: BDFDB.ReactUtils.createElement("span", {
						className: this.shouldUseSpoilerInReceivedOriginal() ? "translator-original-spoiler" : null,
						children: this.renderDiscordMarkupText(originalText, "translator-original")
					})
				});
			}

			getLanguageChoice (direction, place, channelId) {
				let choice;
				let channel = channelId && BDFDB.LibraryStores.ChannelStore.getChannel(channelId);
				let guildId = channel ? (channel.guild_id ? channel.guild_id : "@me") : null;
				if (channelLanguages[channelId] && channelLanguages[channelId][place]) choice = channelLanguages[channelId][place][direction];
				else if (guildId && guildLanguages[guildId] && guildLanguages[guildId][place]) choice = guildLanguages[guildId][place][direction];
				else choice = this.settings.choices[place] && this.settings.choices[place][direction];
				choice = languages[choice] ? choice : Object.keys(languages)[0];
				choice = direction == languageTypes.OUTPUT && choice == "auto" ? "en" : choice;
				return choice;
			}

			saveLanguageChoice (choice, direction, place, channelId) {
				let channel = channelId && BDFDB.LibraryStores.ChannelStore.getChannel(channelId);
				let guildId = channel ? (channel.guild_id ? channel.guild_id : "@me") : null;
				if (channelLanguages[channelId] && channelLanguages[channelId][place]) {
					channelLanguages[channelId][place][direction] = choice;
					BDFDB.DataUtils.save(channelLanguages, this, "channelLanguages");
				}
				else if (guildLanguages[guildId] && guildLanguages[guildId][place]) {
					guildLanguages[guildId][place][direction] = choice;
					BDFDB.DataUtils.save(guildLanguages, this, "guildLanguages");
				}
				else {
					this.settings.choices[place][direction] = choice;
					BDFDB.DataUtils.save(this.settings.choices, this, "choices");
				}
			}

			getAutoTranslateSourceLanguages () {
				return languagePolicy.getConcreteConfiguredLanguages(this, "autoTranslateSourceLanguages");
			}

			normalizeLanguageId (languageId) {
				return languagePolicy.normalizeLanguageId(this, languageId);
			}

			matchesConfiguredSourceLanguage (languageId, sourceLanguages = null) {
				return languagePolicy.matchesConfiguredSourceLanguage(this, languageId, sourceLanguages);
			}

			getLanguageDetectionStrategy () {
				return languageDetectionRuntime.getStrategy(this);
			}

			detectLanguage (text, callback) {
				return languageDetectionRuntime.detectLanguage(this, text, callback);
			}

			shouldSkipSentTranslationForSameTarget (text, channelId, forcedOutputLanguage = null, callback) {
				return sentTranslationPolicy.shouldSkipSentTranslationForSameTarget(this, text, channelId, forcedOutputLanguage, callback);
			}

			shouldSendOriginalInsteadOfSentTranslation (originalText, translation, input, output) {
				return sentTranslationPolicy.shouldSendOriginalInsteadOfSentTranslation(this, originalText, translation, input, output);
			}

			buildSentTranslationMessageValue (originalText, translation, input, output) {
				return sentTranslationPolicy.buildSentTranslationMessageValue(this, originalText, translation, input, output);
			}

			shouldAutoTranslateSentMessage (text, channelId, callback, forcedOutputLanguage = null) {
				return sentTranslationPolicy.shouldAutoTranslateSentMessage(this, text, channelId, callback, forcedOutputLanguage);
			}

			createSentAutomaticTranslationRequest (channelId, originalText, messageId = null) {
				return sentAutomaticTranslationRuntime.create(this, channelId, originalText, messageId);
			}

			isSentAutomaticTranslationRequestCurrent (request) {
				return sentAutomaticTranslationRuntime.isCurrent(this, request);
			}

			completeSentAutomaticTranslationRequest (request, translatedText, submit) {
				return sentAutomaticTranslationRuntime.complete(this, request, translatedText, submit);
			}

			invalidateSentAutomaticTranslationRequests (channelId = null) {
				return sentAutomaticTranslationRuntime.invalidate(this, channelId);
			}

			trackPendingSentOriginal (channelId, originalText, submittedText) {
				return sentAutomaticTranslationRuntime.trackPending(this, channelId, originalText, submittedText);
			}

			captureSentOriginalMessage (message, channelId = null) {
				return sentAutomaticTranslationRuntime.captureEcho(this, message, channelId);
			}

			getEditableSentMessageText (messageId, currentText) {
				return sentAutomaticTranslationRuntime.getEditableText(this, messageId, currentText);
			}

			translateMessage (message, channel, options = {}) {
				return new Promise(callback => {
					let liveRequest = options.auto ? options.liveRequest || null : null;
					let manualRequestKey = null;
					let manualRequest = null;
					const finish = result => {
						if (liveRequest) this.finishLiveTranslationRequest(liveRequest);
						if (manualRequestKey && manualMessageTranslationRequests[manualRequestKey] === manualRequest) delete manualMessageTranslationRequests[manualRequestKey];
						callback(result);
					};
					if (!message) return finish(null);
					const channelId = channel && channel.id || BDFDB.LibraryStores.SelectedChannelStore.getChannelId();
					const isManualTranslation = !!options.manual || !options.auto;
					if (isManualTranslation) manualRequestKey = `${channelId || "__global"}:${String(message.id)}`;
					const activeTranslation = this.getActiveMessageTranslation(message, channelId);
					const storeDisplayView = !activeTranslation && this.getReceivedDisplayRuntimeView(message.id);
					const storeTranslated = !!(storeDisplayView && storeDisplayView.translated && storeDisplayView.origin === "automatic");
					if (isManualTranslation && !activeTranslation && !storeTranslated && manualMessageTranslationRequests[manualRequestKey]) return finish(false);
					if (isManualTranslation) this.lockManualTranslationScroll(message.id);
					if (activeTranslation) {
						if (options.auto) return finish(false);
						suppressedAutoTranslations[message.id] = true;
						this.clearDisplayedTranslationState(message.id, {
							clearReplyPreview: true,
							preserveSuppressed: true
						});
						this.scheduleTranslationRerender();
						finish(false);
					}
					else if (storeTranslated) {
						// Manual untranslate of a store-owned automatic translation restores the
						// original through one acknowledged display transaction.
						if (options.auto) return finish(false);
						suppressedAutoTranslations[message.id] = true;
						this.clearDisplayedTranslationState(message.id, {
							clearReplyPreview: true,
							preserveSuppressed: true
						});
						this.restoreReceivedDisplayMessage(message.id).then(_ => finish(false), _ => finish(false));
					}
					else {
						if (options.auto && !this.isTranslationEnabled(channelId)) return finish(false);
						const rerenderOptions = {
							batched: options.auto || options.silent,
							allowWhileTyping: !!options.auto
						};
						const originalContentData = options.originalContentData || this.extractOriginalContentData(message, {ignoreReferencedPreview: isManualTranslation});
						if (!this.hasTranslatableMessageContent(originalContentData)) return finish(false);
						if (this.shouldSkipReceivedTranslationBeforeRequest(originalContentData, channelId)) {
							const skipReason = this.getReceivedAutoTranslateSkipReason(originalContentData, channelId) || "same_language";
							const skipSignature = this.createReceivedTranslationSignature(message, channelId, originalContentData);
							this.persistReceivedSkipDecision(message.id, skipSignature, skipReason, this.buildTranslationRequestText(originalContentData));
							if (options.auto) {
								this.commitReceivedDisplayResult(this.createReceivedDisplayCommitResult(message, channelId, {
									sourceSignature: skipSignature,
									requestIdentity: liveRequest ? String(liveRequest.id) : null,
									status: "skipped",
									reason: skipReason
								}), {refresh: false}).then(_ => finish(false), _ => finish(false));
								return;
							}
							return finish(false);
						}
						const signature = this.createReceivedTranslationSignature(message, channelId, originalContentData);
						if (options.auto && !liveRequest) liveRequest = this.createLiveTranslationRequest(message, channelId, originalContentData, signature);
						if (options.auto && !this.isLiveTranslationRequestCurrent(liveRequest, message)) return finish(false);
						const cachedTranslation = this.getCachedReceivedTranslation(message, channelId, originalContentData);
						if (cachedTranslation) {
							const storedCachedTranslation = Object.assign({}, cachedTranslation, {
								channelId,
								auto: !!options.auto,
								manual: isManualTranslation,
								independentOfTextAreaSwitch: !!options.independentOfTextAreaSwitch
							});
							if (options.auto) {
								this.refreshTranslationDisplay(storedCachedTranslation);
								this.commitReceivedDisplayResult(this.createReceivedDisplayCommitResult(message, channelId, {
									sourceSignature: storedCachedTranslation.signature != null ? String(storedCachedTranslation.signature) : signature,
									requestIdentity: liveRequest ? String(liveRequest.id) : null,
									status: "translated",
									translation: storedCachedTranslation
								}), {refresh: false}).then(outcome => {
									if (outcome && outcome.deferredIds && outcome.deferredIds.length) this.scheduleReceivedDisplayFlush(channelId, message.id);
									finish(true);
								}, _ => finish(false));
								return;
							}
							this.applyStoredTranslationToMessage(message, storedCachedTranslation, originalContentData);
							this.scheduleTranslationRerender(rerenderOptions);
							return finish(true);
						}
						const allTextsToTranslate = this.buildTranslationRequestText(originalContentData);
						message.embeds.forEach(embed => embed.message_id = message.id);
						let embedIds = message.embeds.map(embed => embed.id);
						if (isManualTranslation) {
							manualRequest = {};
							manualMessageTranslationRequests[manualRequestKey] = manualRequest;
						}
						try {
							this.translateText(allTextsToTranslate, messageTypes.RECEIVED, (translation, input, output, meta = {}) => {
								try {
									if (options.auto && !this.isLiveTranslationRequestCurrent(liveRequest, message)) return finish(false);
									if (isManualTranslation && manualMessageTranslationRequests[manualRequestKey] !== manualRequest) return finish(false);
									if (translation) {
								let strings = translation.split(/\n{0,1}__________________ __________________ __________________\n{0,1}/);
								let oldContent = (originalContentData.content || "").trim();
								let translatedContent = (strings.shift() || "").trim();
								let content = this.buildReceivedDisplayContent(translatedContent, oldContent);
								let embeds = strings.reduce((dict, segment, index) => {
									let embedId = embedIds[index];
									let segmentLines = segment.split("\n");
									let title = segmentLines.shift();
									let description = segmentLines.shift();
									let footerText = segmentLines.pop();
									let fieldsSegment = segmentLines.join("\n").split("\n\n");
									let fields = fieldsSegment.map(line => {
										let [name, value] = line.split("__________________");
										return {name, value};
									});

									dict[embedId] = {title, description, fields, footerText};
									return dict;
								}, {});
								const storedTranslation = {
									signature,
									channelId,
									auto: !!options.auto,
									manual: isManualTranslation,
									independentOfTextAreaSwitch: !!options.independentOfTextAreaSwitch,
									content: content,
									translatedContent,
									originalContent: oldContent,
									embeds: embeds,
									input,
									output
								};
								const rejectReason = this.getAutoTranslatedResultRejectReason(storedTranslation, channelId);
								if ((options.auto && rejectReason) || this.isTranslationResultTooSimilar(storedTranslation)) {
									this.persistReceivedSkipDecision(message.id, signature, rejectReason || "too_similar", storedTranslation.originalContent || storedTranslation.translatedContent);
									if (options.auto) {
										this.commitReceivedDisplayResult(this.createReceivedDisplayCommitResult(message, channelId, {
											sourceSignature: signature,
											requestIdentity: liveRequest ? String(liveRequest.id) : null,
											status: "skipped",
											reason: rejectReason || "too_similar"
										}), {refresh: false}).then(_ => finish(false), _ => finish(false));
										return;
									}
									return finish(false);
								}
								if (options.auto) {
									this.persistTranslationCacheEntry(message.id, signature, storedTranslation);
									this.commitReceivedDisplayResult(this.createReceivedDisplayCommitResult(message, channelId, {
										sourceSignature: signature,
										requestIdentity: liveRequest ? String(liveRequest.id) : null,
										status: "translated",
										translation: storedTranslation
									}), {refresh: false}).then(outcome => {
										if (outcome && outcome.deferredIds && outcome.deferredIds.length) this.scheduleReceivedDisplayFlush(channelId, message.id);
										finish(true);
									}, _ => finish(false));
									return;
								}
								this.applyStoredTranslationToMessage(message, storedTranslation, originalContentData);
								this.scheduleTranslationRerender(rerenderOptions);
								this.persistTranslationCacheEntry(message.id, signature, storedTranslation);
							}
									else if (meta && meta.skipped && options.auto) {
										this.persistReceivedSkipDecision(message.id, signature, "ai_skip_signal", allTextsToTranslate);
										this.commitReceivedDisplayResult(this.createReceivedDisplayCommitResult(message, channelId, {
											sourceSignature: signature,
											requestIdentity: liveRequest ? String(liveRequest.id) : null,
											status: "skipped",
											reason: "ai_skip_signal"
										}), {refresh: false}).then(_ => finish(true), _ => finish(true));
										return;
									}
									else if (options.auto && !translation && !(meta && meta.skipped)) {
										this.commitReceivedDisplayResult(this.createReceivedDisplayCommitResult(message, channelId, {
											sourceSignature: signature,
											requestIdentity: liveRequest ? String(liveRequest.id) : null,
											status: "failed",
											reason: "provider_failed"
										}), {refresh: false}).then(_ => finish(false), _ => finish(false));
										return;
									}
									finish(!!translation || !!(meta && meta.skipped));
								}
								catch (error) {finish(false);}
							}, null, {
								showToast: !options.silent,
								showFailureToast: !options.silent,
								trackBusy: options.trackBusy !== false,
								auto: !!options.auto,
								forcePlainTranslation: !!options.forcePlainTranslation,
								channelId
							});
						}
						catch (error) {finish(false);}
					}
				});
			}

			translateText (text, place, callback, forcedOutputLanguage = null, options = {}) {
				const showToast = options.showToast !== false;
				const showFailureToast = options.showFailureToast !== false;
				const trackBusy = options.trackBusy !== false;
				let toast = null, toastInterval, finished = false, retriedAfterSkip = false, skipSafetyNetHandler = null, finishTranslation = translation => {
					// AI-decision safety net: when AI decision mode returns a skip signal OR a wrong-target
					// result (e.g. it echoes all-caps text unchanged, treating it as an acronym) for a
					// received auto message, verify the original is actually foreign before honoring the
					// drop. A real foreign message gets a forced plain re-translation (no skip option) so it
					// is never dropped to an AI misjudgement. Runs before the cleanup guards so the
					// translating state stays live.
					const isSkip = this.isSkipTranslationSignal(translation);
					if (!isSkip && translation) translation = this.addExceptions(translation, protectedSegments);
					const wrongTarget = !isSkip && !!translation && !this.isTranslationLikelyInTargetLanguage(translation, output && output.id);
					if (!finished && !retriedAfterSkip && skipSafetyNetHandler && (isSkip || wrongTarget) && options.auto && place == messageTypes.RECEIVED && this.useLocalLanguagePrecheck() && this.shouldUseAiAutoTranslateDecision(channelId)) {
						retriedAfterSkip = true;
						skipSafetyNetHandler(translation);
						return;
					}
					if (trackBusy) isTranslating = false;
					if (toast) toast.close();
					BDFDB.TimeUtils.clear(toastInterval);

					if (finished) return;
					finished = true;
					const complete = (...args) => {
						callback(...args);
						if (trackBusy) this.processAutoTranslationQueue();
					};
					if (isSkip) return complete("", input, output, {skipped: true});
					if (translation && wrongTarget) return complete("", input, output, {failed: true, wrongTargetLanguage: true});
					complete(translation == text ? "" : translation, input, output, {failed: !translation});
				};
				// Bottom-layer protection is shared by AI and traditional engines: only protected placeholders are sent for mentions/emoji/links/code.
				let [newText, protectedSegments, translate] = this.removeExceptions(text.trim(), place);
				let channelId = options.channelId || BDFDB.LibraryStores.SelectedChannelStore.getChannelId();
				const primaryEngineKey = this.getEffectivePrimaryEngine(channelId);
				const backupEngineKey = this.getEffectiveBackupEngine(channelId);
				let input = Object.assign({}, languages[this.getLanguageChoice(languageTypes.INPUT, place, channelId)]);
				let output = forcedOutputLanguage ? 
					Object.assign({}, languages[forcedOutputLanguage] || {id: forcedOutputLanguage, name: forcedOutputLanguage}) : 
					Object.assign({}, languages[this.getLanguageChoice(languageTypes.OUTPUT, place, channelId)]);
				
				if (translate && input.id != output.id) {
					let specialCase = this.checkForSpecialCase(newText, input);
					if (specialCase) {
						input.name = specialCase.name;
						switch (specialCase.id) {
							case "binary": newText = this.binary2string(newText); break;
							case "braille": newText = this.braille2string(newText); break;
							case "morse": newText = this.morse2string(newText); break;
                            case "hex": newText = this.hex2string(newText); break;
						}
					}
					if (output.special) {
						switch (output.id) {
							case "binary": newText = this.string2binary(newText); break;
							case "braille": newText = this.string2braille(newText); break;
							case "morse": newText = this.string2morse(newText); break;
                            case "hex": newText = this.string2hex(newText); break;
						}
						finishTranslation(newText);
					}
					else {
						const startTranslating = engine => {
							if (trackBusy) isTranslating = true;
							if (toast) toast.close();
							BDFDB.TimeUtils.clear(toastInterval);
							
							if (showToast) toast = BDFDB.NotificationUtils.toast(`${this.labels.toast_translating} (${translationEngines[engine].name}) - ${BDFDB.LanguageUtils.LibraryStrings.please_wait}`, {
								timeout: 0,
								ellipsis: true,
								position: "center",
								onClose: _ => BDFDB.TimeUtils.clear(toastInterval)
							});
							// The watchdog floor must cover requestWithTimeout's 30s window (60 ticks
							// at 500ms); a shorter floor discards paid responses arriving after it.
							const timeoutTicks = Math.max(64, Math.min(120, Math.ceil((newText || "").length / 25)));
							toastInterval = BDFDB.TimeUtils.interval((_, count) => {
								if (count < timeoutTicks) return;
								finishTranslation("");
								if (showFailureToast) BDFDB.NotificationUtils.toast(`${this.labels.toast_translating_failed} (${translationEngines[engine].name}) - ${this.labels.toast_translating_tryanother}`, {
									type: "danger",
									position: "center"
								});
							}, 500);
						};
						const aiPrompt = this.getAiAutoTranslatePrompt({input, output});
						const normalizeProviderTranslation = translation => {
							if (!translation || this.isSkipTranslationSignal(translation)) return translation;
							return this.hasAllProtectionPlaceholders(translation, protectedSegments) ? translation : "";
						};
						const dispatchEngine = useAutoDecision => {
							const aiDecisionFor = engineKey => !!useAutoDecision && this.supportsAiAutoTranslateDecisionEngine(engineKey);
							if (this.validTranslator(primaryEngineKey, input, output, specialCase)) {
								startTranslating(primaryEngineKey);
								this[translationEngines[primaryEngineKey].funcName].apply(this, [{input, output, text: newText, specialCase, engine: translationEngines[primaryEngineKey], autoDecision: aiDecisionFor(primaryEngineKey), decisionPrompt: aiPrompt}, translation => {
									translation = normalizeProviderTranslation(translation);
									if (!translation && this.validTranslator(backupEngineKey, input, output, specialCase)) {
										startTranslating(backupEngineKey);
										this[translationEngines[backupEngineKey].funcName].apply(this, [{input, output, text: newText, specialCase, engine: translationEngines[backupEngineKey], autoDecision: aiDecisionFor(backupEngineKey), decisionPrompt: aiPrompt}, backupTranslation => finishTranslation(normalizeProviderTranslation(backupTranslation))]);
									}
									else finishTranslation(translation);
								}]);
							}
							else if (this.validTranslator(backupEngineKey, input, output, specialCase)) {
								startTranslating(backupEngineKey);
								this[translationEngines[backupEngineKey].funcName].apply(this, [{input, output, text: newText, specialCase, engine: translationEngines[backupEngineKey], autoDecision: aiDecisionFor(backupEngineKey), decisionPrompt: aiPrompt}, backupTranslation => finishTranslation(normalizeProviderTranslation(backupTranslation))]);
							}
							else finishTranslation();
						};
						// Safety net handler: invoked by finishTranslation on an AI skip signal for a received
						// auto message. If the message is foreign, force a plain re-translation (autoDecision:false,
						// no skip option); otherwise honor the original skip.
						skipSafetyNetHandler = skipTranslation => {
							this.isReceivedMessageForeignAsync(newText, output && output.id, isForeign => {
								if (isForeign) dispatchEngine(false);
								else finishTranslation(skipTranslation);
							});
						};
						// Clearly cross-script foreign messages (e.g. all-caps Latin "HELLO CRYZYYY" -> Chinese)
						// are always foreign: translate plainly so AI decision mode cannot misjudge all-caps
						// text as an acronym and echo/skip it. Same-script (latin<->latin) still uses AI decision.
						const isReceivedAutoAiDecision = options.auto && !options.forcePlainTranslation && place == messageTypes.RECEIVED && this.shouldUseAiAutoTranslateDecision(channelId);
						const useAutoDecision = isReceivedAutoAiDecision && !this.isClearlyForeignLanguageMessage(newText, output && output.id);
						dispatchEngine(useAutoDecision);
					}
				}
				else finishTranslation();
			}
			
			validTranslator (key, input, output, specialCase) {
				let engine = translationEngines[key];
				if (!engine || typeof this[engine.funcName] != "function") return false;
				if (!this.isEngineConfiguredForRuntime(key)) return false;
				return specialCase || this.engineSupportsLanguagePair(key, input, output);
			}

			isValidatableEngine (engineKey) {
				return this.ensureProviderClient().isValidatableEngine(engineKey);
			}

			normalizeApiEndpoint (engineKey, endpoint) {
				return this.ensureProviderClient().normalizeApiEndpoint(engineKey, endpoint);
			}

			supportsModelCatalog (engineKey) {
				return this.ensureProviderClient().supportsModelCatalog(engineKey);
			}

			getModelCatalogEndpoint (engineKey, endpoint) {
				return this.ensureProviderClient().getModelCatalogEndpoint(engineKey, endpoint);
			}

			fetchModelCatalog (engineKey, onUpdate = null) {
				return this.ensureProviderClient().fetchModelCatalog(engineKey, onUpdate);
			}

			mapLanguageCodeForEngine (engineKey, languageId) {
				return this.ensureProviderClient().mapLanguageCodeForEngine(engineKey, languageId);
			}

			getValidationRequestForEngine (engineKey) {
				return this.ensureProviderClient().getValidationRequestForEngine(engineKey);
			}

			getValidationErrorDetails (body) {
				return this.ensureProviderClient().getValidationErrorDetails(body);
			}

			validateEngineConfig (engineKey) {
				return this.ensureProviderClient().validateEngineConfig(engineKey);
			}
			
			googleApiTranslate (data, callback) {
				return this.ensureProviderClient().googleApiTranslate(data, callback);
			}

			googleCloudTranslate (data, callback) {
				return this.ensureProviderClient().googleCloudTranslate(data, callback);
			}
			
			microsoftTranslate (data, callback) {
				return this.ensureProviderClient().microsoftTranslate(data, callback);
			}
			
			deepLTranslate (data, callback) {
				return this.ensureProviderClient().deepLTranslate(data, callback);
			}

			buildAiProviderTranslationPrompt (data) {
				return this.ensureProviderClient().buildAiProviderTranslationPrompt(data);
			}

			parseOpenAiResponseText (body) {
				return this.ensureProviderClient().parseOpenAiResponseText(body);
			}

			parseGeminiResponseText (body) {
				return this.ensureProviderClient().parseGeminiResponseText(body);
			}

			requestAiProviderTranslation (engineKey, url, options, parseResponse, callback) {
				return this.ensureProviderClient().requestAiProviderTranslation(engineKey, url, options, parseResponse, callback);
			}

			openAiTranslate (data, callback) {
				return this.ensureProviderClient().openAiTranslate(data, callback);
			}

			geminiTranslate (data, callback) {
				return this.ensureProviderClient().geminiTranslate(data, callback);
			}

			chatCompletionsTranslate (engineKey, data, callback) {
				return this.ensureProviderClient().chatCompletionsTranslate(engineKey, data, callback);
			}

			deepSeekTranslate (data, callback) {
				return this.ensureProviderClient().deepSeekTranslate(data, callback);
			}

			openAiCompatibleTranslate (data, callback) {
				return this.ensureProviderClient().openAiCompatibleTranslate(data, callback);
			}
						iTranslateTranslate (data, callback) {
				return this.ensureProviderClient().iTranslateTranslate(data, callback);
			}
			
			yandexTranslate (data, callback) {
				return this.ensureProviderClient().yandexTranslate(data, callback);
			}
			
			papagoTranslate (data, callback) {
				return this.ensureProviderClient().papagoTranslate(data, callback);
			}
			
			baiduTranslate (data, callback) {
				return this.ensureProviderClient().baiduTranslate(data, callback);
			}
			
			MD5 (e) {
				return this.ensureProviderClient().MD5(e);
			}

			checkForSpecialCase (text, input) {
				if (input.special) return input;
				else if (input.auto) {
					if (/^[0-1]*$/.test(text.replace(/\s/g, ""))) {
						return {id: "binary", name: "Binary"};
					}
					else if (/^[⠁⠂⠃⠄⠅⠆⠇⠈⠉⠊⠋⠌⠍⠎⠏⠐⠑⠒⠓⠔⠕⠖⠗⠘⠙⠚⠛⠜⠝⠞⠟⠠⠡⠢⠣⠤⠥⠦⠧⠨⠩⠪⠫⠬⠭⠮⠯⠰⠱⠲⠳⠴⠵⠶⠷⠸⠹⠺⠻⠼⠽⠾⠿]*$/.test(text.replace(/\s/g, ""))) {
						return {id: "braille", name: "Braille 6-dot"};
					}
					else if (/^[/|·−._-]*$/.test(text.replace(/\s/g, ""))) {
						return {id: "morse", name: "Morse"};
					}
					else if (/^(0x[0-9a-fA-F]{2}\s*)+$/.test(text.replace(/\s/g, ""))) {
						return {id: "hex", name: "Hexadecimal"};
					}
				}
				return null;
			}


			string2binary (string) {
				let binary = "";
				for (let character of string) binary += parseInt(character.charCodeAt(0).toString(2)).toPrecision(8).split(".").reverse().join("").toString() + " ";
				return binary;
			}

			string2braille (string) {
				let braille = "";
				for (let character of string) braille += brailleConverter[character.toLowerCase()] ? brailleConverter[character.toLowerCase()] : character;
				return braille;
			}

			string2morse (string) {
				string = string.replace(/ /g, "%%%%%%%%%%");
				let morse = "";
				for (let character of string) morse += (morseConverter[character.toLowerCase()] ? morseConverter[character.toLowerCase()] : character) + " ";
				morse = morse.split("\n");
				for (let i in morse) morse[i] = morse[i].trim();
				return morse.join("\n").replace(/% % % % % % % % % % /g, "/ ");
			}
			string2hex(string) {
				let hex = "";
				for (let character of string) {
					hex += "0x" + character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0") + " ";
				}
				return hex.trim();
			}			
			binary2string (binary) {
				let string = "";
				binary = binary.replace(/\n/g, "00001010").replace(/\r/g, "00001101").replace(/\t/g, "00001001").replace(/\s/g, "");
				if (/^[0-1]*$/.test(binary)) {
					let eightDigits = "";
					let counter = 0;
					for (let digit of binary) {
						eightDigits += digit;
						counter++;
						if (counter > 7) {
							string += String.fromCharCode(parseInt(eightDigits, 2).toString(10));
							eightDigits = "";
							counter = 0;
						}
					}
				}
				else BDFDB.NotificationUtils.toast("Invalid binary format. Only use 0s and 1s.", {
					type: "danger",
					position: "center"
				});
				return string;
			}

			braille2string (braille) {
				let string = "";
				for (let character of braille) string += brailleConverter[character.toLowerCase()] ? brailleConverter[character.toLowerCase()] : character;
				return string;
			}

			morse2string (morse) {
				let string = "";
				for (let word of morse.replace(/[_-]/g, "−").replace(/\./g, "·").replace(/\r|\t/g, "").split(/\/|\||\n/g)) {
					for (let characterstr of word.trim().split(" ")) string += morseConverter[characterstr] ? morseConverter[characterstr] : characterstr;
					string += " ";
				}
				return string.trim();
			}

			hex2string(hex) {
				let string = "";
				for (let part of hex.trim().split(/\s+/)) {
					if (part.startsWith("0x") || part.startsWith("0X")) {
						part = part.slice(2);
					}
					if (part.length === 2 && /^[0-9a-fA-F]{2}$/.test(part)) {
						string += String.fromCharCode(parseInt(part, 16));
					}
				}
				return string;
			}			

			escapeRegExp (string) {
				return protectionLogic.escapeRegExp(this, string);
			}

			getExceptionScopeSetting (key, fallback = true) {
				return protectionLogic.getExceptionScopeSetting(this, key, fallback);
			}

			shouldProtectConfiguredTermsForPlace (place) {
				return protectionLogic.shouldProtectConfiguredTermsForPlace(this, place);
			}

			shouldProtectWrappedTextForPlace (place) {
				return protectionLogic.shouldProtectWrappedTextForPlace(this, place);
			}

			getProtectedTermsList () {
				return protectionLogic.getProtectedTermsList(this);
			}

			trimTrailingProtectedPunctuation (text) {
				return protectionLogic.trimTrailingProtectedPunctuation(this, text);
			}

			protectRegexMatches (string, regex, protectedSegments = {}, count = 0, options = {}) {
				return protectionLogic.protectRegexMatches(this, string, regex, protectedSegments, count, options);
			}

			protectCodeBlockSegments (string, protectedSegments = {}, count = 0) {
				return protectionLogic.protectCodeBlockSegments(this, string, protectedSegments, count);
			}

			protectAutoDetectedSegments (string, protectedSegments = {}, count = 0) {
				return protectionLogic.protectAutoDetectedSegments(this, string, protectedSegments, count);
			}

			protectDiscordMarkupSegments (string, protectedSegments = {}, count = 0) {
				return protectionLogic.protectDiscordMarkupSegments(this, string, protectedSegments, count);
			}

			protectQuotedTextSegments (string, protectedSegments = {}, count = 0) {
				return protectionLogic.protectQuotedTextSegments(this, string, protectedSegments, count);
			}

			protectWrappedTextSegments (string, protectedSegments = {}, count = 0, place = null) {
				return protectionLogic.protectWrappedTextSegments(this, string, protectedSegments, count, place);
			}

			protectConfiguredTerms (string, protectedSegments = {}, count = 0) {
				return protectionLogic.protectConfiguredTerms(this, string, protectedSegments, count);
			}

			protectAutoTechnicalTerms (string, protectedSegments = {}, count = 0) {
				return protectionLogic.protectAutoTechnicalTerms(this, string, protectedSegments, count);
			}


			protectMixedLanguageLatinTokens (string, protectedSegments = {}, count = 0) {
				return protectionLogic.protectMixedLanguageLatinTokens(this, string, protectedSegments, count);
			}


			getUnicodeEmojiDetector () {
				return protectionLogic.getUnicodeEmojiDetector();
			}

			isUnicodeEmojiGrapheme (segment) {
				return protectionLogic.isUnicodeEmojiGrapheme(this, segment);
			}

			getUnicodeEmojiRegex () {
				return protectionLogic.getUnicodeEmojiRegex();
			}

			protectUnicodeEmojiSegments (string, protectedSegments = {}, count = 0) {
				return protectionLogic.protectUnicodeEmojiSegments(this, string, protectedSegments, count);
			}


			createProtectionPlaceholder (count) {
				return protectionLogic.createProtectionPlaceholder(this, count);
			}

			getProtectionPlaceholderRegex (count) {
				return protectionLogic.getProtectionPlaceholderRegex(this, count);
			}

			formatProtectedExceptionForDisplay (exception) {
				return protectionLogic.formatProtectedExceptionForDisplay(this, exception);
			}

			hasAllProtectionPlaceholders (string, protectedSegments) {
				return protectionLogic.hasAllProtectionPlaceholders(this, string, protectedSegments);
			}

			addExceptions (string, protectedSegments) {
				return protectionLogic.addExceptions(this, string, protectedSegments);
			}

			removeExceptions (string, place) {
				return protectionLogic.removeExceptions(this, string, place);
			}

			getGoogleTranslatePageURL (input, output, text) {
				return `https://translate.google.com/#${BDFDB.LanguageUtils.languages[input] ? input : "auto"}/${output}/${encodeURIComponent(text)}`;
			}

			setLabelsByLanguage () {
				return getLabelsForUiLanguage(this.getUiLanguageId());
			}
		};
	})(window.BDFDB_Global.PluginUtils.buildPlugin(changeLog));
})();
