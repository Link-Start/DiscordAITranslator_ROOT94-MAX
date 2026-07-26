// The two React components that hang off the message toolbar: the translate button
// itself, and the per-channel language popout it opens. They are a render tree, not
// logic - they read plugin getters, write back through plugin setters and ask BDFDB to
// force an update.
//
// The components own no plugin state. TranslateSettings keeps a small amount of genuine
// component state (the language-detector scratch input and its result) because that data
// is local to an open popout and must die with it.
//
// BDFDB arrives in the dependencies object rather than as a module import: it is a live
// BetterDiscord library handle the plugin factory receives, not something this module can
// require. BdApi is a genuine Discord global and is referenced directly, exactly as the
// legacy factory did - and only inside createTranslateComponents, so requiring this file
// outside Discord does not touch it.
//
// About `this` and `_this`. These are the legacy factory's two different receivers and
// the distinction is load-bearing:
//   `this`  inside a component method is the React component - its props, its state, and
//           the instance handed to BDFDB.ReactUtils.forceUpdate. Every `this.` below is
//           still the component and was NOT rewritten.
//   `_this` was the factory-scope self-reference to the plugin instance. It cannot leave
//           the factory closure, so it is now injected.
// The injection has to be lazy. `_this` is assigned in the plugin's onLoad(), long after
// this module is required and after createTranslateComponents() runs, so capturing its
// value at construction time would freeze `undefined` into both components. The factory
// therefore takes a `getPlugin()` accessor, and every method that needs the plugin opens
// with `const _this = getPlugin();`. That resolves the plugin per method call, which is
// exactly when the legacy code resolved the closure variable, and it leaves every method
// body byte-identical to the original.

const {translationEngines} = require("../providers/provider-client");

// Presentation only, so it lives with the components rather than in the plugin closure.
// translateIcon/translateIconUntranslate are re-exported at the bottom because the
// message toolbar and context menus in runtime.js draw the same glyph.
const translateIconGeneral = `<svg name="Translate" width="24" height="24" viewBox="0 0 24 24"><mask/><path fill="currentColor" mask="url(#translateIconMask)" d="m 9.6568988,1.9999999 c -1.141416,0 -0.951614,1.2688185 -0.951614,1.2688185 v 0.6505173 h -5.392479 c 0,0 -1.2688185,-0.1898024 -1.2688185,0.9516139 0,1.1414159 1.2688185,0.9516139 1.2688185,0.9516139 H 12.426863 C 12.695162,7.2780713 11.349082,9.1398691 9.7646988,10.765256 8.6555628,9.6878231 7.4332858,8.3134878 6.8664892,7.065981 6.6161862,6.515072 5.9881318,6.6956414 5.7283935,6.9736693 5.1836529,7.5567679 5.5785907,8.592173 6.0833902,9.3409331 c 0.246901,0.366224 1.3724726,1.5182279 2.4570966,2.5995909 -1.6322361,1.477469 -3.154699,2.550028 -3.154699,2.550028 0,0 -1.0769951,0.696378 -0.322161,1.552568 0.7548319,0.856187 1.5810669,-0.125147 1.5810669,-0.125147 0,0 1.5136611,-1.082765 3.2203701,-2.6696 0.5195872,0.508635 0.8970952,0.874172 0.8970952,0.874172 0,0 0.82821,0.985394 1.582925,0.09231 0.754714,-0.893081 -0.354377,-1.545753 -0.354377,-1.545753 0.0097,0.03486 -0.34186,-0.224086 -0.864878,-0.666625 1.804964,-1.884163 3.470802,-4.1622897 3.47686,-6.1799145 h 1.398302 c 0,0 1.268819,0.2176541 1.268819,-0.9516139 0,-1.1692683 -1.268819,-0.9516139 -1.268819,-0.9516139 H 10.608512 V 3.2688184 c 0,0 0.189804,-1.2688185 -0.9516132,-1.2688185 z M 15.056812,10.104826 10.536646,22 h 2.379035 l 0.964624,-2.537637 h 4.732049 L 19.576978,22 h 2.379035 L 17.435847,10.104826 Z m 1.189517,3.130537 1.643021,4.323772 h -3.286042 z"/><extra/></svg>`;
const translateIconMask = `<mask id="translateIconMask" fill="black"><path fill="white" d="M 0 0 H 24 V 24 H 0 Z"/><path fill="black" d="M24 12 H 12 V 24 H 24 Z"/></mask>`;
const translateIcon = translateIconGeneral.replace(`<extra/>`, ``).replace(`<mask/>`, ``).replace(` mask="url(#translateIconMask)"`, ``);
const translateIconUntranslate = translateIconGeneral.replace(`<extra/>`, `<path fill="none" stroke="#f04747" stroke-width="2" d="m 14.702359,14.702442 8.596228,8.596148 m 0,-8.597139 -8.59722,8.596147 z"/>`).replace(`<mask/>`, translateIconMask);

// Same values as the legacy factory-scope languageTypes/messageTypes maps, and as the
// local copies in settings-panel.js. Kept under the legacy names so the component bodies
// read exactly the way they did inside runtime.js.
const languageTypes = Object.freeze({INPUT: "input", OUTPUT: "output"});
const messageTypes = Object.freeze({RECEIVED: "received", SENT: "sent"});

function createTranslateComponents(dependencies = {}) {
	const {BDFDB, getPlugin} = dependencies;
	// Fail loudly at construction rather than rendering a button wired to `undefined`.
	if (typeof getPlugin != "function") throw new Error("createTranslateComponents requires a getPlugin() accessor: the plugin instance is assigned in onLoad(), after this factory runs.");

	const TranslateButtonComponent = class TranslateButton extends BdApi.React.Component {
		render() {
			const _this = getPlugin();
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
			const _this = getPlugin();
			const isOutput = direction == languageTypes.OUTPUT;
			const settingsStore = _this.ensureSettingsStore();
			const currentInput = settingsStore.getLanguage(_this.getLanguageChoice(languageTypes.INPUT, place, this.props.channelId));
			const currentOutput = settingsStore.getLanguage(_this.getLanguageChoice(languageTypes.OUTPUT, place, this.props.channelId));
			return BDFDB.ObjectUtils.toArray(BDFDB.ObjectUtils.map(isOutput ? BDFDB.ObjectUtils.filter(settingsStore.getLanguages(), lang => !lang.auto) : settingsStore.getLanguages(), (lang, id) => {
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
			const _this = getPlugin();
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
			const _this = getPlugin();
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
			const _this = getPlugin();
			const detectedLanguageId = this.state.detectedLanguageId;
			if (!detectedLanguageId) return;
			_this.saveLanguageChoice(detectedLanguageId, direction, place, this.props.channelId);
			_this.setLanguages();
			BDFDB.ReactUtils.forceUpdate(this);
		}
		renderLanguageDetector() {
			const _this = getPlugin();
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
			const _this = getPlugin();
			// Keep the floating loaded-history status capsule mounted outside this settings surface.
			return [
				this.renderChannelPrimaryEngine(),
				this.renderLanguageDetector(),
				Object.keys(_this.defaults.choices).map(place => {
					let isChannelSpecific = _this.ensureSettingsStore().hasChannelLanguageScope(this.props.channelId, place);
					let isGuildSpecific = !isChannelSpecific && _this.ensureSettingsStore().hasGuildLanguageScope(this.props.guildId, place);
					return Object.keys(_this.defaults.choices[place].value).map(direction => [
						BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.FormItem, {
							title: _this.labels[`language_choice_${direction.toLowerCase()}_${place.toLowerCase()}`] + ": ",
							titleChildren: direction == languageTypes.OUTPUT && [{
								text: _ => isChannelSpecific ? _this.labels.language_selection_channel : isGuildSpecific ? _this.labels.language_selection_server : _this.labels.language_selection_global,
								name: isChannelSpecific || isGuildSpecific ? BDFDB.LibraryComponents.SvgIcon.Names.LOCK_CLOSED : BDFDB.LibraryComponents.SvgIcon.Names.LOCK_OPEN,
								color: isChannelSpecific ? "var(--status-danger)" : isGuildSpecific ? "var(--status-warning)" : null,
								onClick: _ => {
									const nextScope = _this.ensureSettingsStore().cycleLanguageChoiceScope(this.props.channelId, this.props.guildId, place);
									isChannelSpecific = nextScope == "channel";
									isGuildSpecific = nextScope == "guild";
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
								optionRenderer: lang => _this.ensureSettingsStore().getLanguage(lang.value) ? BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.Flex, {
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
											isFavorite: _this.ensureSettingsStore().isFavorite(lang.value),
											onClick: value => {
												_this.ensureSettingsStore().setFavorite(lang.value, value);
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

	return {TranslateButtonComponent, TranslateSettingsComponent};
}

module.exports = {
	createTranslateComponents,
	translateIcon,
	translateIconUntranslate,
	translateIconGeneral
};
