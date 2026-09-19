const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = relative => fs.readFileSync(path.resolve(__dirname, "..", relative), "utf8");

test("settings use five accessible task tabs instead of one collapse stack", () => {
	const source = read("src/ui/settings-panel.js");
	for (const id of ["providers", "strategy", "general", "advanced", "diagnostics"]) {
		assert.match(source, new RegExp(`id: "${id}"`));
	}
	assert.match(source, /role: "tablist"/);
	assert.match(source, /role: "tab"/);
	assert.match(source, /role: "tabpanel"/);
	assert.match(source, /aria-selected/);
	assert.match(source, /aria-controls/);
	assert.match(source, /ArrowRight/);
	assert.match(source, /ArrowLeft/);
	assert.match(source, /event\.key == "Home"/);
	assert.match(source, /event\.key == "End"/);
});

test("settings share Discord interaction colors and keep a translator signature color", () => {
	const styles = read("src/ui/styles.js");
	const source = read("src/ui/settings-panel.js");
	assert.match(styles, /--translator-brand: var\(--brand-500, #5865f2\)/);
	assert.match(styles, /--translator-signature: #58b9f2/);
	assert.match(styles, /translator-settings-tab-active/);
	assert.match(styles, /translator-settings-tab:focus-visible/);
	assert.match(styles, /\.translator-btn \{[^}]*height: 32px;[^}]*box-sizing: border-box;/);
	assert.match(source, /ref: bindSettingsPanelScrollHost/);
	assert.match(styles, /\.translator-settings-scroll-host \{[^}]*overflow-y: hidden !important;/);
	assert.match(styles, /\.translator-settings-scroll-host \.translator-settings-panel-root \{[^}]*display: flex;[^}]*flex-direction: column;/);
	assert.match(styles, /\.translator-settings-tabpage \{[^}]*overflow-y: auto;/);
	assert.doesNotMatch(styles, /\.translator-settings-tabbar \{[^}]*position: sticky;/);
});

test("provider settings expose grouped roles without a second credential accordion", () => {
	const source = read("src/ui/settings-panel.js");
	const styles = read("src/ui/styles.js");
	const catalog = read("src/ui/provider-catalog.js");
	assert.match(source, /translator-provider-workspace/);
	// Group membership is shared with the channel popout through provider-catalog.js.
	assert.match(source, /PROVIDER_GROUPS\.map\(group => Object\.assign\(\{label: providerGroupLabels\[group\.id\]\}, group\)\)/);
	assert.match(catalog, /id: "ai", keys: Object\.freeze\(\["deepseek", "openai", "gemini", "oaicompat"\]\)/);
	assert.match(catalog, /id: "machine", keys: Object\.freeze\(\["googleapi", "microsoft", "baidu", "deepl", "googlecloud", "papago"\]\), pinned: Object\.freeze\(\["googleapi"\]\)/);
	assert.doesNotMatch(source, /label: compactText\("免费", "Free", "Бесплатно"\)/);
	assert.doesNotMatch(source, /translator-provider-role-free/);
	assert.doesNotMatch(styles, /\.translator-provider-role-free/);
	assert.match(source, /selectedIsBackup \? compactText\("取消备用"/);
	assert.match(source, /className: "translator-provider-card-actions"/);
	assert.match(styles, /\.translator-provider-card-actions \{[^}]*align-items: center;/);
	assert.match(styles, /\.translator-provider-badge \{[^}]*height: 32px;/);
	assert.match(source, /className: "translator-provider-region-select"/);
	assert.match(styles, /\.translator-provider-region-select \.translator-search-select-trigger \{height: 38px;/);
	assert.match(source, /flushDeferredSettingsWrites/);
});

test("archived stock providers leave the sidebar but keep engines and any referenced row", () => {
	const source = read("src/ui/settings-panel.js");
	const catalog = read("src/ui/provider-catalog.js");
	// ChatGPT and Papago are archived: hidden from the rail, fully functional in
	// code. Developers resurface one by removing its key from this list.
	assert.match(catalog, /const ARCHIVED_PROVIDER_KEYS = Object\.freeze\(\["openai", "papago"\]\);/);
	assert.match(source, /const resolveGroupKeys = group => resolveProviderGroupKeys\(group, \{/);
	// A key still serving as primary/backup or currently open keeps its row.
	assert.match(source, /keepKeys: \[plugin\.settings\.engines\.translator, plugin\.settings\.engines\.backup, selectedProvider\]/);
});

test("the channel popout's provider select shows the same rows as the settings sidebar", () => {
	const popout = read("src/ui/translate-components.js");
	// The popout used to list every key of translationEngines, so archived OpenAI and
	// Papago reappeared there while the settings sidebar hid them.
	assert.match(popout, /require\("\.\/provider-catalog"\)/);
	assert.match(popout, /\.\.\.visibleEngineKeys\.map\(engineKey => \(\{value: engineKey/);
	assert.doesNotMatch(popout, /Object\.keys\(translationEngines\)\.map\(engineKey => \(\{value: engineKey/);
	// The channel's current engine plus the global primary/backup keep their rows.
	assert.match(popout, /keepKeys: \[engineSettings\.translator, engineSettings\.backup, effectiveEngine\]/);
});

test("translation strategy uses sentence directions, searchable languages and a prompt library", () => {
	const source = read("src/ui/settings-panel.js");
	const popout = read("src/ui/translate-components.js");
	assert.match(source, /createTranslationDirectionRow\(messageTypes\.RECEIVED\)/);
	assert.match(source, /createTranslationDirectionRow\(messageTypes\.SENT\)/);
	assert.match(source, /createSearchableSelectComponent/);
	assert.match(source, /createPromptLibraryEditor/);
	assert.match(source, /showConfirmationModal/);
	assert.match(source, /BUILTIN_PROMPT_ID/);
	// The preference dropdown carries an "off" entry instead of a separate switch row.
	assert.match(source, /关闭（不发送偏好）/);
	assert.match(source, /setAiPromptSendingEnabled\(plugin\.settings\.filters, false\)/);
	assert.match(source, /value: sendingEnabled \? state\.selectedId : AI_PROMPT_OFF_OPTION/);
	// No visible basic/AI chooser: the prompt library always renders (the
	// reference plugin's policy page) and the stored mode follows whether an
	// AI provider is configured.
	assert.match(source, /autoTranslateDecisionMode/);
	assert.match(source, /aiCapable \? "ai" : "basic"/);
	assert.doesNotMatch(source, /translator-decision-card/);
	assert.match(source, /translator-backfill-switch/);
	assert.match(source, /translator-backfill-dependent-disabled/);
	// Source filters are a favorites multi-select: stars toggle without closing.
	assert.match(source, /multi: true/);
	assert.match(source, /translator-multi-star/);
	assert.match(source, /onToggle/);
	assert.match(source, /className: "translator-info-tip"/);
	assert.match(source, /本地语言预检测/);
	assert.match(source, /明显已经是目标语言的消息仍会被基础规则跳过/);
	const textSource = read("src/i18n/text.js");
	assert.match(textSource, /同一语言的地区或书写变体会自动合并匹配/);
	assert.match(source, /autoFavoriteOnSelect: true/);
	assert.match(popout, /autoFavoriteOnSelect: true/);
	assert.match(popout, /favoriteValues:/);
	assert.match(source, /BDFDB\.LibraryComponents\.TooltipContainer/);
	assert.doesNotMatch(source, /lockStableSelectScrollIntoView/);
	assert.doesNotMatch(source, /createStableSelect/);
	assert.doesNotMatch(source, /autoTranslateSourceLanguages\) \|\| \[\]\)\.map\(\(languageId, index\) => BDFDB\.ReactUtils\.createElement\(BDFDB\.LibraryComponents\.Flex/);
});

test("general and advanced pages expose dependent rows, live preview and scope chips", () => {
	const source = read("src/ui/settings-panel.js");
	const styles = read("src/ui/styles.js");
	assert.match(source, /disabled: !plugin\.settings\.general\.sendOriginalMessage/);
	assert.match(source, /disabled: !plugin\.settings\.general\.showOriginalMessage/);
	assert.match(source, /translator-color-preview/);
	assert.match(source, /translator-scope-chip-active/);
	assert.match(source, /"aria-pressed": active/);
	assert.match(styles, /translator-settings-dependent-disabled/);
	assert.match(styles, /translator-color-preview-message/);
	assert.match(source, /createGeneralSwitch\("highlightTranslatedMessages"\)/);
	assert.doesNotMatch(source, /refresh = false/);
	assert.match(source, /languageDetectionStrategy[\s\S]*?plugin\.SettingsUpdated = true;\s*refreshPanel\(\);/);
	// Switching the plugin language must rebuild the language table, or the pinned
	// auto entry keeps the name baked in under the previous language.
	assert.match(source, /plugin\.labels = plugin\.setLabelsByLanguage\(\);\s*plugin\.setLanguages\(\);\s*refreshPanel\(\);/);
	// BetterDiscord labels the host modal's Done button in Discord's language; the panel
	// relabels it from its mount ref whenever the plugin language is pinned.
	assert.match(source, /require\("\.\/settings-host-modal"\)/);
	assert.match(source, /localizeSettingsHostModal\(/);
	assert.match(source, /const currentLimit = String\(plugin\.getReceivedAutoTranslateLoadedLimit\(\)\)/);
	assert.match(source, /!limitOptions\.includes\(currentLimit\)/);
	assert.match(source, /key: `general-\$\{key\}`/);
	assert.match(source, /plugin\.SettingsUpdated = true;\s*refreshPanel\(\);/);
	assert.match(styles, /\.translator-settings-tabpage::-webkit-scrollbar \{width: 6px;\}/);
	assert.match(styles, /\.translator-settings-tabpage::-webkit-scrollbar-button \{display: none;/);
	assert.match(styles, /\.translator-dir-select \{width: 170px;/);
	assert.match(styles, /\.translator-language-filter-select \{width: 340px;/);
	assert.match(styles, /\.translator-channel-language-select \{width: 210px;/);
	assert.match(styles, /\.translator-search-select-popout \{[^}]*padding: 6px 0 6px 6px;/);
	assert.match(styles, /\.translator-search-select-option \{[^}]*width: calc\(100% - 6px\);/);
	assert.match(styles, /\.translator-search-select-list::-webkit-scrollbar-button \{display: none;/);
	const runtime = read("src/legacy/runtime.js");
	for (const color of ["#00ff40", "#00f5ff", "#3399ff", "#fff200", "#ff8a00", "#ff3b81", "#b85cff"]) assert.match(runtime, new RegExp(color));
});

test("channel translation dialog shares the sibling plugins' modal anatomy and type scale", () => {
	const source = read("src/ui/translate-components.js");
	const styles = read("src/ui/styles.js");
	assert.match(source, /BdApi\.UI\.showConfirmationModal/);
	assert.doesNotMatch(source, /BDFDB\.ModalUtils\.open\(_this/);
	assert.match(source, /size: "translator-channel-confirm"/);
	assert.match(source, /className: "translator-channel-confirm-header"/);
	assert.match(source, /className: "translator-channel-close"/);
	assert.match(styles, /\.translator-channel-confirm \{[^}]*width: 480px !important;/);
	assert.match(styles, /\.translator-channel-confirm > :last-child \{[^}]*display: none !important;/);
	assert.match(styles, /\.translator-channel-settings \{[^}]*font-size: 15px;/);
	assert.match(styles, /\.translator-channel-row-label \{[^}]*font-size: 16px;/);
	assert.match(styles, /\.translator-channel-zone-title \{[^}]*font-size: 14px;[^}]*font-weight: 700;/);
	assert.match(styles, /\.translator-channel-settings \.translator-search-select-trigger \{[^}]*font-size: 15px;/);
	assert.match(styles, /\.translator-channel-settings \.translator-btn \{[^}]*font-size: 14px;/);
	assert.match(styles, /\.translator-channel-confirm-header \{[^}]*padding-right: 12px;/);
	assert.match(styles, /\.translator-channel-close \{[^}]*margin: -4px 20px -4px auto;/);
	assert.match(styles, /\.translator-channel-scope-group \{[^}]*display: inline-grid;/);
	assert.match(styles, /\.translator-channel-scope-option \{[^}]*font-size: 13px;[^}]*font-weight: 600;/);
	assert.match(styles, /\.translator-channel-scope-group::before \{[^}]*top: 3px;[^}]*bottom: 3px;[^}]*left: 3px;[^}]*width: 68px;/);
	assert.match(styles, /background: var\(--purple-500, #6d5bd0\);[^}]*transition: transform 150ms/);
	assert.match(styles, /\.translator-channel-scope-group:hover::before \{background: var\(--purple-600, #6552c7\);\}/);
	assert.match(styles, /\.translator-channel-scope-group\[data-scope="guild"\]::before \{transform: translateX\(68px\);\}/);
	assert.match(styles, /\.translator-channel-scope-group\[data-scope="channel"\]::before \{transform: translateX\(136px\);\}/);
	assert.match(styles, /\.translator-channel-scope-option \{[^}]*display: flex;[^}]*align-items: center;[^}]*justify-content: center;[^}]*line-height: 1;/);
	assert.doesNotMatch(styles, /width: calc\(\(100% - 4px\) \/ 3\)/);
	assert.match(styles, /prefers-reduced-motion: reduce[\s\S]*translator-channel-scope-group::before \{transition: none;\}/);
	assert.doesNotMatch(source, /LOCK_CLOSED|lock_closed/);
	assert.match(source, /role: "radiogroup"/);
	assert.match(source, /role: "radio"/);
	assert.match(source, /cycleLanguageChoiceScope/);
	assert.doesNotMatch(source, /setLanguageChoiceScope/);
	assert.doesNotMatch(source, /className: "translator-channel-scope"/);
	assert.match(read("src/i18n/text.js"), /粘贴一段文字，识别后可将该语言设为发送目标语言。/);
	assert.doesNotMatch(styles, /\.translator-channel-modal \$\{BDFDB\.dotCN\.modalclose\} \{display: none;/);
});

test("diagnostics use the signature color and expose read-only update checking", () => {
	const source = read("src/ui/settings-panel.js");
	const styles = read("src/ui/styles.js");
	assert.match(source, /createDiagnosticsContent/);
	assert.match(source, /checkForUpdate/);
	assert.match(source, /WindowUtils\.copy\(diagnosticsText\)/);
	assert.match(source, /configuredProviders\.join/);
	assert.match(styles, /translator-about-version/);
	assert.match(styles, /translator-update-status-available/);
	assert.match(styles, /translator-loaded-status-requesting[\s\S]*var\(--translator-signature\)/);
});

test("P1 latency UI reuses status and diagnostic rows without adding another tab or control surface", () => {
	const source = read("src/ui/settings-panel.js");
	const styles = read("src/ui/styles.js");
	assert.match(source, /getLatencySnapshot/);
	assert.match(source, /const aiPerformanceRows/);
	assert.match(source, /ai_performance_title/);
	assert.match(source, /translator-status-main/);
	assert.match(source, /translator-status-detail/);
	assert.match(styles, /\.translator-status-main/);
	assert.match(styles, /\.translator-status-detail/);
	assert.match(source, /diagnosticsRows[\s\S]*aiPerformanceRows[\s\S]*translator-copy-diagnostics/);
	assert.equal((source.match(/id: "diagnostics"/g) || []).length, 1);
	assert.doesNotMatch(source, /translator-provider-performance/);
	assert.match(source, /aria-expanded/);
	assert.match(source, /setReasoningModelPreference/);
	assert.match(source, /\["follow", "off", "on"\]/);
	assert.match(source, /isCustomProviderKey\(engineKey\)/);
	assert.match(source, /customProviderAdvancedExpanded\[engineKey\]/);
	assert.match(source, /customProviderSpeedExpanded\[engineKey\]/);
	assert.match(source, /data-provider-main-slot/);
	assert.match(source, /data-provider-action/);
	assert.match(source, /getEngineConfigFingerprint/);
	assert.match(source, /deleteCredential\(engineKey\)/);
	assert.doesNotMatch(styles, /\.translator-provider-performance/);
	assert.match(styles, /\.translator-provider-main-status \{[^}]*white-space|\.translator-provider-main-status[\s\S]*white-space: nowrap/);
	assert.match(styles, /\.translator-provider-advanced \{[^}]*border-top: 1px solid var\(--translator-border\);\}/, "the advanced disclosure sits behind the card's only hairline, never a second bordered card");
	assert.match(source, /runSyntheticBenchmark/);
	assert.match(source, /benchmark_confirm_body/);
	assert.match(source, /role: "progressbar"/);
	assert.match(styles, /\.translator-provider-speed-body \{[^}]*border: 1px solid var\(--translator-border\)/, "the speed details live in a filled box, not behind another divider");
	assert.match(styles, /\.translator-benchmark-result-row \{[^}]*grid-template-columns:/);
	assert.doesNotMatch(styles, /\.translator-reasoning-benchmark[^}]*overflow-(?:y|x):\s*(?:auto|scroll)/);
	assert.match(source, /data-performance-setting[^]*history-concurrency[^]*live-concurrency[^]*live-streaming[^]*history-safety-downshift/, "the user-approved performance controls stay on the existing Advanced tab");
	assert.match(styles, /\.translator-performance-control-grid \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/, "performance controls use a compact two-column card rather than crowded full rows");
	assert.doesNotMatch(source, /progressiveDisplay|progressive-display/, "the controls do not expose an unscoped progressiveDisplay flag");
	assert.match(source, /translator-diagnostic-technical/);
});

test("P1 latency copy has dedicated Chinese, English and Russian values", () => {
	const {getCustomTextValue} = require("../src/i18n/text");
	const keys = [
		"model_validation_loading", "model_validation_success", "model_validation_failure",
		"model_validation_see_toast", "latency_response", "reasoning_usage_reported", "reasoning_echo_reported", "latency_failure", "latency_error_timeout", "latency_error_auth",
		"latency_error_not_found",
		"latency_error_rate_limit", "latency_error_server", "latency_error_network",
		"latency_error_invalid", "latency_error_invalid_request", "latency_error_unsupported_field", "latency_error_unsupported_value",
		"latency_error_sampling_conflict", "latency_error_schema", "latency_error_unknown", "ai_performance_title", "ai_performance_tip",
		"ai_latency_latest_translation", "ai_latency_latest_detection", "ai_latency_queue_wait",
		"ai_latency_response_samples", "ai_latency_queue_samples", "ai_latency_io_batch", "ai_latency_io_batch_summary",
		"ai_latency_sample_summary", "ai_latency_insufficient", "ai_latency_failovers", "ai_latency_timeout_rate_limit",
		"ai_latency_no_translation", "ai_latency_no_detection", "ai_latency_unknown_provider", "ai_latency_backup", "latency_milliseconds", "latency_seconds",
		"thinking_group_title", "thinking_mode_label", "thinking_mode_tip",
		"capability_badge_pending", "capability_badge_switch", "capability_badge_tiers", "capability_badge_budget", "capability_badge_tip",
		"thinking_mode_follow", "thinking_mode_off", "thinking_mode_on", "thinking_mode_follow_note", "thinking_mode_off_note", "thinking_strength_label", "thinking_strength_tip", "thinking_strength_custom", "thinking_strength_custom_sub", "thinking_strength_custom_tip", "thinking_tier_state_pending", "thinking_tier_state_sent", "thinking_tier_state_confirmed", "thinking_tier_state_reduced", "thinking_tier_state_ignored", "thinking_tier_state_rejected", "thinking_tier_state_invalid", "validate_config", "custom_status_invalid_strength", "thinking_migration_rejected_note", "thinking_migration_invalid_note",
		"advanced_settings", "advanced_settings_tip", "api_format_openai_chat", "api_format_openai_responses", "api_format_ollama_native", "api_format_gemini_native", "api_format_anthropic_messages", "api_key_optional_placeholder", "api_key_gemini_placeholder", "api_key_anthropic_placeholder",
		"api_type", "api_type_tip", "api_type_auto", "api_type_openai_chat_short", "api_type_openai_responses_short", "api_type_ollama_native_short", "api_type_gemini_native_short", "api_type_anthropic_messages_short",
		"api_endpoint_auto_type_tip", "speed_test", "api_type_note", "benchmark_state_idle", "benchmark_state_running", "benchmark_state_done",
		"thinking_raw_gloss_none", "thinking_raw_gloss_minimal", "thinking_raw_gloss_low", "thinking_raw_gloss_medium", "thinking_raw_gloss_high", "thinking_raw_gloss_max", "thinking_raw_gloss_xhigh", "thinking_raw_gloss_auto", "thinking_raw_gloss_on", "thinking_raw_gloss_off", "thinking_raw_gloss_dynamic", "thinking_raw_gloss_budget", "thinking_raw_gloss_unknown", "thinking_not_applied_tip",
		"custom_status_unknown_model", "custom_status_detecting", "custom_status_error", "custom_status_thinking_off_confirmed", "custom_status_setting_sent_unconfirmed",
		"custom_status_effort_reduced", "custom_status_thinking_on_confirmed", "custom_status_off_not_applied", "custom_status_on_not_applied", "custom_status_off_not_applied_actual", "custom_status_on_substituted", "custom_status_setting_rejected",
		"custom_status_interface_unknown", "custom_status_benchmark_slower", "custom_status_stale", "custom_status_upstream",
		"detect_disabled_benchmark",


		"reasoning_status_provider_default",
		"reasoning_status_pending", "reasoning_status_accepted", "reasoning_status_reduced", "reasoning_status_unsupported",
		"reasoning_status_close_accepted", "reasoning_status_close_confirmed", "reasoning_status_close_ignored", "reasoning_status_reduced_value",
		"reasoning_status_on_accepted", "reasoning_status_on_confirmed", "reasoning_status_on_ignored",
		"benchmark_title", "benchmark_badge", "benchmark_start", "benchmark_retry", "benchmark_stop", "benchmark_confirm",
		"benchmark_tip", "benchmark_confirm_body",
		"benchmark_arm_default", "benchmark_arm_disabled", "benchmark_arm_disable_request", "benchmark_arm_ignored", "benchmark_arm_reduced", "benchmark_arm_enabled",
		"benchmark_recommend_current", "benchmark_recommend_default", "benchmark_recommend_mixed", "benchmark_recommend_none", "benchmark_recommend_pending", "benchmark_reasoning_tokens",
		"benchmark_change", "benchmark_typical", "benchmark_worst", "benchmark_compare_faster", "benchmark_compare_slower",
		"benchmark_success", "benchmark_progress", "benchmark_no_compare", "benchmark_unchanged",
		"benchmark_cancelled", "benchmark_stale",
		"benchmark_need_mode",
		"benchmark_error_configuration", "benchmark_error_reasoning_disabled",
		"benchmark_error_reasoning_unsupported", "benchmark_error_backoff", "benchmark_error_provider_failed"
	];
	const languageNeutralBrands = new Set(["api_format_openai_chat", "api_format_openai_responses", "api_format_ollama_native", "api_format_gemini_native", "api_format_anthropic_messages", "api_type_openai_chat_short", "api_type_openai_responses_short", "api_type_ollama_native_short", "api_type_gemini_native_short", "api_type_anthropic_messages_short"]);
	for (const key of keys) {
		const zh = getCustomTextValue(key, true, false);
		const en = getCustomTextValue(key, false, false);
		const ru = getCustomTextValue(key, false, true);
		assert.notEqual(zh, key, `missing Chinese ${key}`);
		assert.notEqual(en, key, `missing English ${key}`);
		assert.notEqual(ru, key, `missing Russian ${key}`);
		if (!languageNeutralBrands.has(key)) assert.notEqual(ru, en, `Russian must not fall back to English for ${key}`);
	}
});

test("reasoning benchmark progress uses the current fixture and request totals in every locale", () => {
	const {getCustomTextValue} = require("../src/i18n/text");
	for (const [isChinese, isRussian] of [[true, false], [false, false], [false, true]]) {
		const value = getCustomTextValue("benchmark_progress", isChinese, isRussian);
		for (const slot of ["{done}", "{total}", "{fixture}", "{fixtures}", "{arm}"]) {
			assert.match(value, new RegExp(slot.replace(/[{}]/g, "\\$&")), `missing ${slot} in ${value}`);
		}
		assert.doesNotMatch(value, /\/10|\/5/, `benchmark progress must not hard-code the old totals: ${value}`);
	}
	const source = read("src/ui/settings-panel.js");
	assert.match(source, /benchmark_progress[\s\S]*total:\s*benchmarkProgress\.total/);
	assert.match(source, /benchmark_progress[\s\S]*fixtures:\s*SYNTHETIC_BENCHMARK_TEXTS\.length/);
});

test("the review artifact is a UTF-8 document and contains no key-shaped demo secret", () => {
	const draft = read("artifacts/ui-redesign-draft.html");
	assert.match(draft, /^<!doctype html>/i);
	assert.match(draft, /<meta charset="utf-8">/i);
	assert.match(draft, /--mk-signature: #58b9f2/);
	assert.doesNotMatch(draft, /value="sk-[A-Za-z0-9_-]+"/);
});
