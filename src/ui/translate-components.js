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

const {translationEngines, normalizeCustomProviders} = require("../providers/provider-client");
const {createSearchableSelectComponent} = require("./searchable-select");
// Same rows, same order as the settings panel's provider sidebar: archived stock
// platforms (OpenAI, Papago) stay out of this select too.
const {resolveVisibleProviderKeys} = require("./provider-catalog");

// Shared Material Symbols table: the popout draws the same swap/info glyphs
// as the settings panel.
const {MATERIAL_ICON_PATHS} = require("./icon-paths");

// Sentinel option value for "follow the global provider" in the channel engine
// select (the draft removes the separate restore button: picking this option
// clears the override).
const CHANNEL_ENGINE_INHERIT = "__global__";

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

// The sibling plugins use BetterDiscord's confirmation-modal host. Keeping this
// resolver local gives the channel dialog the same native enter/exit motion and
// focus trap without turning the component module into another runtime adapter.
function resolveBetterDiscordModalSystem() {
	try {
		if (!BdApi || !BdApi.Webpack || typeof BdApi.Webpack.getMangled != "function") return null;
		const filters = BdApi.Webpack.Filters;
		if (!filters || typeof filters.byStrings != "function") return null;
		const system = BdApi.Webpack.getMangled(".modalKey?", {
			openModal: filters.byStrings(",instant:"),
			closeModal: filters.byStrings(".onCloseCallback()")
		});
		return system && typeof system.closeModal == "function" ? system : null;
	}
	catch (error) {return null;}
}

function createTranslateComponents(dependencies = {}) {
	const {BDFDB, getPlugin} = dependencies;
	// Fail loudly at construction rather than rendering a button wired to `undefined`.
	if (typeof getPlugin != "function") throw new Error("createTranslateComponents requires a getPlugin() accessor: the plugin instance is assigned in onLoad(), after this factory runs.");
	let SearchableSelect = null;
	let channelSettingsSequence = 0;
	const getSearchableSelect = () => SearchableSelect || (SearchableSelect = createSearchableSelectComponent(BdApi.React, BDFDB.ReactUtils.createElement));

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

					let modalKey = null;
					const cleanup = _ => {
						this.props.isActive = false;
						BDFDB.ReactUtils.forceUpdate(this);
					};
					const close = _ => {
						const system = resolveBetterDiscordModalSystem();
						if (modalKey != null && system) system.closeModal(modalKey);
					};
					const title = BDFDB.ReactUtils.createElement("div", {className: "translator-channel-confirm-header", children: [
						BDFDB.ReactUtils.createElement("span", {children: _this.getCustomText("channel_modal_title")}),
						BDFDB.ReactUtils.createElement("button", {
							type: "button",
							className: "translator-channel-close",
							"aria-label": _this.getCustomText("channel_modal_close"),
							title: _this.getCustomText("channel_modal_close"),
							onClick: close,
							children: BDFDB.ReactUtils.createElement("svg", {viewBox: "0 -960 960 960", "aria-hidden": true, children: BDFDB.ReactUtils.createElement("path", {fill: "currentColor", d: MATERIAL_ICON_PATHS.close})})
						})
					]});
					try {
						modalKey = BdApi.UI.showConfirmationModal(title, BDFDB.ReactUtils.createElement(TranslateSettingsComponent, {
							guildId: this.props.guildId,
							channelId: this.props.channelId
						}), {
							size: "translator-channel-confirm",
							confirmText: null,
							cancelText: null,
							onConfirm: cleanup,
							onCancel: cleanup,
							onClose: cleanup
						});
					}
					catch (error) {cleanup();}
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
			this.idPrefix = `translator-channel-${++channelSettingsSequence}`;
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
					pinned: id == "auto",
					favoriteDisabled: id == "auto",
					// Search spans every script even though the label follows the UI language.
					search: [lang.name, lang.ownlang, _this.getChineseLanguageName(id)].filter(Boolean).join(" "),
					backup: !primarySupported && backupSupported,
					unsupported: !primarySupported && !backupSupported,
					disabled: !primarySupported && !backupSupported
				};
			}));
		}
		renderChannelPrimaryEngine() {
			const _this = getPlugin();
			const channelId = this.props.channelId;
			const labelId = `${this.idPrefix}-provider-label`;
			const inherited = !_this.hasChannelPrimaryEngineOverride(channelId);
			const effectiveEngine = _this.getEffectivePrimaryEngine(channelId);
			const globalSuffix = _this.isChineseUiLanguage() ? "（全局）" : _this.isRussianUiLanguage() ? " (глобально)" : " (global)";
			const engineSettings = _this.settings && _this.settings.engines || {};
			// The engine this channel already uses (and the global primary/backup) keeps
			// its row even when archived, so the current value always has a label.
			const visibleEngineKeys = resolveVisibleProviderKeys({
				engines: translationEngines,
				customProviderIds: normalizeCustomProviders(engineSettings.customProviders).map(entry => entry.id),
				getLabel: engineKey => _this.getEngineLabel(engineKey),
				keepKeys: [engineSettings.translator, engineSettings.backup, effectiveEngine]
			});
			// One draft row: label + info tip on the left, the select on the right.
			// "跟随全局" is the first option instead of a separate restore button.
			return BDFDB.ReactUtils.createElement("div", {
				className: "translator-channel-zone translator-channel-provider-zone",
				children: BDFDB.ReactUtils.createElement("div", {className: "translator-channel-row", children: [
					BDFDB.ReactUtils.createElement("span", {id: labelId, className: "translator-channel-row-label", children: [
						_this.getCustomText("channel_primary_engine_title"),
						BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.TooltipContainer, {
							text: _this.getCustomText("channel_primary_engine_tip"),
							tooltipConfig: {type: "bottom", style: "max-width: 280px; white-space: normal;"},
							children: BDFDB.ReactUtils.createElement("button", {
								type: "button",
								className: "translator-info-tip",
								"aria-label": _this.getCustomText("channel_primary_engine_tip"),
								onClick: event => event && event.preventDefault && event.preventDefault(),
								children: BDFDB.ReactUtils.createElement("svg", {viewBox: "0 -960 960 960", width: 13, height: 13, "aria-hidden": true, children: BDFDB.ReactUtils.createElement("path", {fill: "currentColor", d: MATERIAL_ICON_PATHS.info})})
							})
						})
					]}),
					BDFDB.ReactUtils.createElement("div", {className: "translator-channel-engine-select", children: BDFDB.ReactUtils.createElement(getSearchableSelect(), {
						value: effectiveEngine,
						ariaLabelledBy: labelId,
						disablePortal: true,
						options: [
							{value: CHANNEL_ENGINE_INHERIT, label: _this.getCustomText("channel_primary_engine_inherit")},
							...visibleEngineKeys.map(engineKey => ({value: engineKey, label: inherited && engineKey == effectiveEngine ? `${_this.getEngineLabel(engineKey)}${globalSuffix}` : _this.getEngineLabel(engineKey)}))
						],
						searchPlaceholder: _this.isChineseUiLanguage() ? "搜索服务商" : "Search providers",
						onChange: engineKey => {
							if (engineKey == CHANNEL_ENGINE_INHERIT) _this.clearChannelPrimaryEngineOverride(channelId);
							else _this.setChannelPrimaryEngine(channelId, engineKey);
							_this.refreshChannelPrimaryEngineRuntime(channelId);
							_this.setLanguages();
							if (engineKey != CHANNEL_ENGINE_INHERIT && !_this.isEngineConfiguredForRuntime(engineKey)) BDFDB.NotificationUtils.toast(`${_this.getEngineLabel(engineKey)}: ${_this.getCustomText("channel_primary_engine_unconfigured_warning")}`, {type: "danger", position: "center"});
							BDFDB.ReactUtils.forceUpdate(this);
						}
					})})
				]})
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
			const titleId = `${this.idPrefix}-detector-title`;
			const hintId = `${this.idPrefix}-detector-hint`;
			const detectedLanguageId = this.state.detectedLanguageId;
			const detectedLanguage = detectedLanguageId && _this.getLanguageData(detectedLanguageId);
			// Zone rows per the draft: input + button in one row, then the result line
			// with an apply action. Detection feedback stays inline, never in a tooltip.
			return BDFDB.ReactUtils.createElement("div", {
				className: "translator-detector-panel",
				children: [
					BDFDB.ReactUtils.createElement("div", {
						id: titleId,
						className: "translator-channel-zone-title",
						children: _this.getCustomText("language_detector_title")
					}),
					BDFDB.ReactUtils.createElement("div", {
						id: hintId,
						className: "translator-channel-zone-note",
						children: _this.getCustomText("language_detector_hint")
					}),
					BDFDB.ReactUtils.createElement("div", {
						className: "translator-detector-row",
						children: [
							BDFDB.ReactUtils.createElement("input", {
								className: "translator-input",
								"aria-labelledby": titleId,
								"aria-describedby": hintId,
								placeholder: _this.getCustomText("language_detector_placeholder"),
								value: this.state.detectorText,
								spellCheck: false,
								onChange: event => this.setState({detectorText: event.target.value}),
								onKeyDown: event => {
									if (event.key == "Enter" && !this.state.detectingLanguage) {
										event.preventDefault();
										this.detectLanguageFromInput();
									}
								}
							}),
							BDFDB.ReactUtils.createElement("button", {
								type: "button",
								className: "translator-btn",
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
								className: "translator-status translator-status-ok",
								role: "status",
								"aria-live": "polite",
								"aria-atomic": true,
								children: `${_this.getCustomText("language_detector_detected")}${_this.isChineseUiLanguage() ? "：" : ": "}${_this.getLanguageDisplayName(detectedLanguage)} (${detectedLanguage.id})`
							}),
							BDFDB.ReactUtils.createElement("button", {
								type: "button",
								className: "translator-btn translator-btn-sec",
								onClick: _ => this.applyDetectedLanguage(messageTypes.SENT, languageTypes.OUTPUT),
								children: _this.getCustomText("language_detector_apply_sent_output")
							})
						]
					})
				].filter(Boolean)
			});
		}
		renderLanguageOption(option) {
			const _this = getPlugin();
			return BDFDB.ReactUtils.createElement("div", {className: "translator-channel-language-option", children: [
				BDFDB.ReactUtils.createElement("span", {className: "translator-channel-language-option-name", title: option.label, children: option.label}),
				(option.backup || option.unsupported) && BDFDB.ReactUtils.createElement("span", {className: "translator-channel-language-warning", title: option.unsupported ? _this.getCustomText("language_not_supported_by_channel_engines") : _this.labels.backup_engine_warning, children: "⚠"})
			].filter(Boolean)});
		}
		getLanguageFavoriteProps() {
			const _this = getPlugin();
			return {
				favoriteValues: _this.ensureSettingsStore().getFavorites(),
				autoFavoriteOnSelect: true,
				favoriteLabel: _this.isChineseUiLanguage() ? "收藏语言" : _this.isRussianUiLanguage() ? "Добавить в избранное" : "Favorite language",
				unfavoriteLabel: _this.isChineseUiLanguage() ? "取消收藏" : _this.isRussianUiLanguage() ? "Убрать из избранного" : "Remove favorite",
				onToggleFavorite: (languageId, active) => {
					_this.ensureSettingsStore().setFavorite(languageId, active);
					_this.setLanguages();
					BDFDB.ReactUtils.forceUpdate(this);
				}
			};
		}
		getScope(place) {
			const _this = getPlugin();
			if (_this.ensureSettingsStore().hasChannelLanguageScope(this.props.channelId, place)) return "channel";
			if (_this.ensureSettingsStore().hasGuildLanguageScope(this.props.guildId, place)) return "guild";
			return "global";
		}
		renderScopeControl(place) {
			const _this = getPlugin();
			const scope = this.getScope(place);
			const options = [
				{value: "global", label: _this.getCustomText("channel_scope_global"), tip: _this.getCustomText("channel_scope_global_tip")},
				{value: "guild", label: _this.getCustomText("channel_scope_guild"), tip: _this.getCustomText("channel_scope_guild_tip")},
				{value: "channel", label: _this.getCustomText("channel_scope_channel"), tip: _this.getCustomText("channel_scope_channel_tip")}
			];
			const select = nextScope => {
				if (nextScope == scope) return;
				// Preserve the mainline lock owner's exact persistence path. The three
				// visible segments are direct destinations, but the store transition remains
				// the proven global -> server -> channel -> global cycle.
				const store = _this.ensureSettingsStore();
				let resolvedScope = scope;
				for (let attempts = 0; attempts < 3 && resolvedScope != nextScope; attempts++) resolvedScope = store.cycleLanguageChoiceScope(this.props.channelId, this.props.guildId, place);
				if (resolvedScope == nextScope) BDFDB.ReactUtils.forceUpdate(this);
			};
			const move = (event, index) => {
				let nextIndex = null;
				if (event.key == "ArrowRight" || event.key == "ArrowDown") nextIndex = (index + 1) % options.length;
				else if (event.key == "ArrowLeft" || event.key == "ArrowUp") nextIndex = (index + options.length - 1) % options.length;
				else if (event.key == "Home") nextIndex = 0;
				else if (event.key == "End") nextIndex = options.length - 1;
				if (nextIndex == null) return;
				event.preventDefault();
				const nextScope = options[nextIndex].value;
				select(nextScope);
				const group = event.currentTarget && event.currentTarget.parentElement;
				if (group && typeof group.querySelector == "function") setTimeout(() => {
					const next = group.querySelector(`[data-scope="${nextScope}"]`);
					if (next && typeof next.focus == "function") next.focus();
				}, 0);
			};
			return BDFDB.ReactUtils.createElement("div", {
				className: "translator-channel-scope-group",
				role: "radiogroup",
				"aria-label": _this.getCustomText("channel_scope_label"),
				"data-place": place,
				"data-scope": scope,
				children: options.map((option, index) => BDFDB.ReactUtils.createElement("button", {
					key: option.value,
					type: "button",
					className: "translator-channel-scope-option",
					role: "radio",
					"aria-checked": scope == option.value,
					tabIndex: scope == option.value ? 0 : -1,
					"data-place": place,
					"data-scope": option.value,
					title: option.tip,
					onClick: _ => select(option.value),
					onKeyDown: event => move(event, index),
					children: option.label
				}))
			});
		}
		renderDirectionZone(place) {
			const _this = getPlugin();
			const input = _this.getLanguageChoice(languageTypes.INPUT, place, this.props.channelId);
			const output = _this.getLanguageChoice(languageTypes.OUTPUT, place, this.props.channelId);
			const title = _this.getCustomText(place == messageTypes.RECEIVED ? "channel_received_title" : "channel_sent_title");
			const titleId = `${this.idPrefix}-${place}-title`;
			const inputLabelId = `${this.idPrefix}-${place}-input-label`;
			const outputLabelId = `${this.idPrefix}-${place}-output-label`;
			const swapDisabled = input == "auto";
			const swapLabel = _this.getCustomText(swapDisabled ? "channel_swap_requires_source" : "channel_swap_languages");
			const save = (direction, value) => {
				_this.saveLanguageChoice(value, direction, place, this.props.channelId);
				_this.setLanguages();
				BDFDB.ReactUtils.forceUpdate(this);
			};
			return BDFDB.ReactUtils.createElement("section", {className: "translator-channel-zone", "aria-labelledby": titleId, children: [
				BDFDB.ReactUtils.createElement("div", {className: "translator-channel-zone-title", children: [
					BDFDB.ReactUtils.createElement("span", {className: "translator-channel-zone-heading", children: [
						BDFDB.ReactUtils.createElement("span", {id: titleId, children: title}),
						BDFDB.ReactUtils.createElement(BDFDB.LibraryComponents.TooltipContainer, {
							text: _this.getCustomText("channel_scope_help"),
							tooltipConfig: {type: "bottom", style: "max-width: 320px; white-space: normal;"},
							children: BDFDB.ReactUtils.createElement("button", {
								type: "button",
								className: "translator-channel-scope-info translator-info-tip",
								"aria-label": _this.getCustomText("channel_scope_help_label"),
								onClick: event => event && event.preventDefault && event.preventDefault(),
								children: BDFDB.ReactUtils.createElement("svg", {viewBox: "0 -960 960 960", width: 13, height: 13, "aria-hidden": true, children: BDFDB.ReactUtils.createElement("path", {fill: "currentColor", d: MATERIAL_ICON_PATHS.info})})
							})
						})
					]}),
					BDFDB.ReactUtils.createElement("div", {className: "translator-channel-zone-actions", children: [
						this.renderScopeControl(place),
						BDFDB.ReactUtils.createElement("button", {type: "button", className: "translator-channel-swap", disabled: swapDisabled, title: swapLabel, "aria-label": swapLabel, onClick: _ => {
							if (swapDisabled) return;
							_this.saveLanguageChoice(output, languageTypes.INPUT, place, this.props.channelId);
							_this.saveLanguageChoice(input, languageTypes.OUTPUT, place, this.props.channelId);
							_this.setLanguages();
							BDFDB.ReactUtils.forceUpdate(this);
						}, children: BDFDB.ReactUtils.createElement("svg", {viewBox: "0 -960 960 960", "aria-hidden": true, children: BDFDB.ReactUtils.createElement("path", {fill: "currentColor", d: MATERIAL_ICON_PATHS.swap})})})
					]})
				]}),
				BDFDB.ReactUtils.createElement("div", {className: "translator-channel-row", children: [
					BDFDB.ReactUtils.createElement("span", {id: inputLabelId, className: "translator-channel-row-label", children: _this.getCustomText("channel_source_language")}),
					BDFDB.ReactUtils.createElement("div", {className: "translator-channel-language-select", children: BDFDB.ReactUtils.createElement(getSearchableSelect(), Object.assign({value: input, ariaLabelledBy: inputLabelId, disablePortal: true, options: this.filterLanguages(languageTypes.INPUT, place), onChange: value => save(languageTypes.INPUT, value), renderOption: option => this.renderLanguageOption(option), searchPlaceholder: _this.isChineseUiLanguage() ? "搜索语言或代码" : "Search language or code"}, this.getLanguageFavoriteProps()))})
				]}),
				BDFDB.ReactUtils.createElement("div", {className: "translator-channel-row", children: [
					BDFDB.ReactUtils.createElement("span", {id: outputLabelId, className: "translator-channel-row-label", children: _this.getCustomText("channel_target_language")}),
					BDFDB.ReactUtils.createElement("div", {className: "translator-channel-language-select", children: BDFDB.ReactUtils.createElement(getSearchableSelect(), Object.assign({value: output, ariaLabelledBy: outputLabelId, disablePortal: true, options: this.filterLanguages(languageTypes.OUTPUT, place), onChange: value => save(languageTypes.OUTPUT, value), renderOption: option => this.renderLanguageOption(option), searchPlaceholder: _this.isChineseUiLanguage() ? "搜索语言或代码" : "Search language or code"}, this.getLanguageFavoriteProps()))})
				]})
			]});
		}
		render() {
			const _this = getPlugin();
			// Keep the floating loaded-history status capsule mounted outside this settings surface.
			// The modal header already names the channel (draft shell head), so the
			// body starts directly with the provider zone.
			return BDFDB.ReactUtils.createElement("div", {className: "translator-channel-settings translator-settings-ui", children: [
				this.renderChannelPrimaryEngine(),
				this.renderDirectionZone(messageTypes.RECEIVED),
				this.renderDirectionZone(messageTypes.SENT),
				BDFDB.ReactUtils.createElement("section", {className: "translator-channel-zone translator-channel-detector-zone", children: this.renderLanguageDetector()}),
				BDFDB.ReactUtils.createElement("div", {className: "translator-channel-footnotes", children: [
					BDFDB.ReactUtils.createElement("div", {className: "translator-channel-footnote", children: _this.getCustomText("channel_autosave_note")}),
					BDFDB.ReactUtils.createElement("div", {className: "translator-channel-footnote", children: _this.getCustomText("channel_toggle_tip")})
				]})
			]});
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
