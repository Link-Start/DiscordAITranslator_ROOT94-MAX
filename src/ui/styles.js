// Chat-list styling for translated messages, the watermark, the loading dot and
// the translator toolbar buttons, plus the settings-panel design system. The panel
// CSS follows artifacts/ui-redesign-draft.html (the mk-* spec, which mirrors the
// reference plugin's damc-* sheet): Discord theme tokens, row-form layout on the
// panel background, hairline splits between groups, and self-drawn controls.
// Pure presentation: it reads BDFDB class names and holds no plugin state, so it
// lives outside the runtime closure.
function createTranslatorStyles(BDFDB) {
	return `
					${BDFDB.dotCN._translatortranslatebutton + BDFDB.dotCNS._translatortranslating + BDFDB.dotCN.textareaicon} {
						color: var(--status-danger) !important;
					}
					${BDFDB.dotCN._translatorconfigbutton} {
						margin: 2px 3px 0 6px;
					}
					.translator-discord-emoji {
						width: 1.375em;
						height: 1.375em;
						object-fit: contain;
						vertical-align: -0.275em;
						margin: 0 0.05em;
					}
					.translator-discord-mention {
						display: inline;
						padding: 0 2px;
						border-radius: 3px;
						background: var(--mention-background, color-mix(in srgb, var(--brand-500, #5865f2) 30%, transparent));
						color: var(--mention-foreground, var(--brand-260, #c9cdfb)) !important;
						font-weight: 500;
						white-space: break-spaces;
					}
					.translator-discord-mention:hover {
						background: var(--mention-background-hover, color-mix(in srgb, var(--brand-500, #5865f2) 45%, transparent));
						color: var(--white-500, #fff) !important;
					}
					.translator-translated-message {
						margin-top: 4px;
						padding: 6px 10px 6px 12px;
						border-left: 2px solid var(--translator-accent-color, var(--brand-500, var(--text-link)));
						background: color-mix(in srgb, var(--translator-accent-color, var(--brand-500, var(--text-link))) 8%, transparent);
						border-radius: 6px;
						color: var(--translator-text-color, inherit);
					}
					.translator-translation-loading {
						display: inline-block;
						width: 12px;
						height: 12px;
						margin-left: 6px;
						box-sizing: border-box;
						vertical-align: -1px;
						border: 2px solid color-mix(in srgb, var(--text-muted) 35%, transparent);
						border-top-color: var(--text-link);
						border-radius: 50%;
						animation: translator-loading-spin 750ms linear infinite;
					}
					@keyframes translator-loading-spin {
						to {transform: rotate(360deg);}
					}
					@media (prefers-reduced-motion: reduce) {
						.translator-translation-loading {animation-duration: 1600ms;}
					}
					.translator-protected-quote {
						color: var(--text-link);
						background: color-mix(in srgb, var(--brand-500, var(--text-link)) 14%, transparent);
						padding: 0 4px;
						border-radius: 4px;
						font-weight: 600;
					}
					.translator-reply-preview-multiline {
						overflow: visible !important;
						max-height: none !important;
					}
					.translator-reply-preview-body {
						overflow: visible !important;
						max-height: none !important;
						height: auto !important;
					}
					.translator-reply-preview-text {
						display: block !important;
						white-space: pre-wrap !important;
						overflow: visible !important;
						text-overflow: unset !important;
						-webkit-line-clamp: unset !important;
						line-clamp: unset !important;
						max-height: none !important;
						height: auto !important;
					}
					.translator-reply-preview-text > span {
						white-space: inherit !important;
						overflow: visible !important;
						text-overflow: unset !important;
					}
					.translator-reply-preview-body .translator-translated-message,
					.translator-reply-preview-text.translator-translated-message,
					.translator-reply-preview-text .translator-translated-message {
						margin: 0 !important;
						padding: 0 !important;
						border: 0 !important;
						border-left: 0 !important;
						background: transparent !important;
						box-shadow: none !important;
						color: inherit !important;
					}
					.translator-reply-preview-body [class*="translator"],
					.translator-reply-preview-text [class*="translator"] {
						background: transparent !important;
						box-shadow: none !important;
						color: inherit !important;
					}
					/* Flex column so BDFDB's hidden 0x0 focus-catcher input stops creating
					   an empty text line above the tab bar (the title-to-tabs gap). */
					#DiscordAITranslator-settings {position: relative; display: flex; flex-direction: column;}
					#DiscordAITranslator-settings ${BDFDB.dotCN._repochangelogbutton} {position: absolute; top: -2px; right: 2px; margin: 0;}
					.translator-settings-scroll-host {display: flex !important; flex-direction: column; min-height: 0; overflow-y: hidden !important; scrollbar-gutter: auto !important;}
					/* Put the page's 6px scrollbar and 6px gap in the modal's right inset.
					   Content and tabs still end 16px from the edge; the track ends at 4px. */
					.bd-addon-modal .bd-modal-content.translator-settings-scroll-host {padding-right: 4px;}
					.bd-addon-modal .translator-settings-scroll-host .translator-settings-tabbar {margin-right: 12px;}
					.translator-settings-scroll-host #DiscordAITranslator-settings,
					.translator-settings-scroll-host .translator-settings-panel-root {
						flex: 1 1 auto;
						min-height: 0;
						height: 100%;
						overflow: hidden;
					}
					.translator-settings-scroll-host .translator-settings-panel-root {display: flex; flex-direction: column;}
					.translator-settings-panel-root {
						overflow-anchor: none;
						overflow-x: clip;
						max-width: 100%;
						box-sizing: border-box;
					}
					/* ===== design tokens (mk-* spec, Discord theme variables first) ===== */
					.translator-settings-ui {
						--translator-bg: var(--modal-background, var(--background-primary, #313338));
						--translator-surface: var(--background-secondary, #2b2d31);
						--translator-sunken: var(--background-tertiary, #1e1f22);
						--translator-hover: var(--background-modifier-hover, rgba(255, 255, 255, 0.06));
						--translator-selected: var(--background-modifier-selected, rgba(255, 255, 255, 0.09));
						--translator-border: var(--background-modifier-accent, rgba(78, 80, 88, 0.48));
						--translator-input-bg: var(--input-background, var(--background-tertiary, #1e1f22));
						--translator-input-border: var(--input-border, var(--background-modifier-accent, rgba(78, 80, 88, 0.48)));
						--translator-text: var(--text-normal, #dbdee1);
						--translator-text-strong: var(--header-primary, #f2f3f5);
						--translator-text-sub: var(--header-secondary, #b5bac1);
						--translator-text-muted: var(--text-muted, #949ba4);
						--translator-brand: var(--brand-500, #5865f2);
						--translator-brand-active: var(--brand-560, #4752c4);
						--translator-on-brand: var(--white-500, #ffffff);
						--translator-brand-soft: var(--brand-260, #a0a9ff);
						--translator-signature: #58b9f2;
						--translator-floating: var(--background-floating, var(--background-tertiary, #1e1f22));
						--translator-shadow: var(--elevation-high, 0 8px 16px rgba(0, 0, 0, 0.24));
						--translator-link: var(--text-link, #00a8fc);
						--translator-ok: var(--status-positive, #23a55a);
						--translator-warn: var(--status-warning, #f0b232);
						--translator-danger: var(--status-danger, #f23f43);
						color: var(--translator-text);
						font-size: 15px;
						line-height: 1.5;
					}
					.translator-settings-ui :is(button, a, [role="tab"], [role="switch"]):focus-visible {
						outline: none;
						box-shadow: 0 0 0 2px color-mix(in srgb, var(--translator-brand) 45%, transparent);
					}
					/* ===== tabs ===== */
					.translator-settings-tabbar {
						display: flex;
						gap: 4px;
						height: 36px;
						padding: 3px;
						border-radius: 8px;
						background: var(--translator-sunken);
						box-sizing: border-box;
					}
					.translator-settings-tab {
						appearance: none;
						flex: 1 1 0;
						min-width: 0;
						height: 30px;
						padding: 0 8px;
						border: 0;
						border-radius: 5px;
						background: transparent;
						color: var(--translator-text-muted);
						font: inherit;
						font-size: 16px;
						font-weight: 600;
						text-align: center;
						white-space: nowrap;
						overflow: hidden;
						text-overflow: ellipsis;
						cursor: pointer;
						transition: background 120ms ease, color 120ms ease;
					}
					.translator-settings-tab:hover {
						background: var(--translator-hover);
						color: var(--translator-text);
					}
					.translator-settings-tab-active,
					.translator-settings-tab-active:hover {
						background: var(--translator-brand);
						color: var(--translator-on-brand);
					}
					.translator-settings-tab:focus-visible {
						outline: none;
						box-shadow: 0 0 0 2px color-mix(in srgb, var(--translator-brand) 45%, transparent);
					}
					.translator-settings-tabpage {
						min-height: 380px;
						padding-top: 16px;
						overflow: visible;
					}
					.translator-settings-scroll-host .translator-settings-tabpage {
						flex: 1 1 auto;
						min-height: 0;
						overflow-y: auto;
						overflow-x: clip;
						/* Reserve the scrollbar track even while nothing scrolls, so opening a
						   disclosure never narrows the pane and reflows rows sitting at a wrap
						   threshold. */
						scrollbar-gutter: stable;
						padding-right: 6px;
					}
					.translator-settings-tabpage::-webkit-scrollbar {width: 6px;}
					.translator-settings-tabpage::-webkit-scrollbar-track {background: transparent; margin-block: 8px;}
					.translator-settings-tabpage::-webkit-scrollbar-thumb {
						background: color-mix(in srgb, var(--translator-text-muted) 42%, transparent);
						border-radius: 4px;
					}
					.translator-settings-tabpage::-webkit-scrollbar-button {display: none; width: 0; height: 0;}
					/* ===== row-form primitives: groups, rows, splits, dependents ===== */
					.translator-group {
						display: flex;
						align-items: center;
						gap: 6px;
						margin: 24px 0 8px;
						color: var(--translator-text-muted);
						font-size: 14px;
						font-weight: 700;
					}
					.translator-group:first-child {margin-top: 2px;}
					.translator-row {
						min-height: 36px;
						display: flex;
						align-items: center;
						justify-content: space-between;
						gap: 12px;
					}
					.translator-row-label {
						flex: 1 1 auto;
						min-width: 0;
						display: inline-flex;
						align-items: center;
						gap: 5px;
						color: var(--translator-text);
						font-size: 16px;
						font-weight: 500;
						line-height: 20px;
					}
					.translator-row-control {
						flex: 0 0 auto;
						display: flex;
						align-items: center;
						justify-content: flex-end;
						gap: 8px;
						min-width: 0;
					}
					.translator-split {
						height: 1px;
						background: var(--translator-border);
						opacity: 0.55;
						margin: 14px 0;
					}
					.translator-settings-note {
						margin: 4px 0 10px;
						color: var(--translator-text-muted);
						font-size: 13px;
						line-height: 1.55;
					}
					.translator-settings-dependent-row {
						position: relative;
						margin-left: 10px;
						padding-left: 14px;
						transition: opacity 150ms ease;
					}
					.translator-settings-dependent-row::before {
						content: "";
						position: absolute;
						left: 0;
						top: 50%;
						transform: translateY(-50%);
						width: 3px;
						height: 16px;
						border-radius: 2px;
						background: color-mix(in srgb, var(--translator-text) 22%, transparent);
					}
					.translator-note-link {color: var(--translator-link); cursor: pointer;}
					.translator-note-link:hover {text-decoration: underline;}
					.translator-settings-dependent-row .translator-row-label {
						font-size: 15px;
						color: var(--translator-text-sub);
					}
					.translator-settings-dependent-disabled {
						opacity: 0.4;
						pointer-events: none;
					}
					/* ===== info tip (BdApi tooltip trigger) ===== */
					.translator-info-tip {
						appearance: none;
						flex: 0 0 auto;
						display: inline-flex;
						align-items: center;
						justify-content: center;
						width: 13px;
						height: 13px;
						padding: 0;
						border: 0;
						border-radius: 50%;
						background: transparent;
						color: var(--translator-text-muted);
						font: inherit;
						line-height: 1;
						cursor: help;
						transform: translateY(-1px);
					}
					.translator-info-tip svg {width: 13px; height: 13px; display: block;}
					.translator-info-tip:hover,
					.translator-info-tip:focus-visible {color: var(--translator-brand);}
					/* ===== self-drawn switch (36x20, green when on) ===== */
					.translator-switch {
						appearance: none;
						position: relative;
						width: 36px;
						height: 20px;
						flex: 0 0 auto;
						padding: 0;
						border: 1px solid var(--translator-border);
						border-radius: 10px;
						background: var(--translator-sunken);
						cursor: pointer;
						transition: background 150ms ease, border-color 150ms ease;
					}
					.translator-switch::after {
						content: "";
						position: absolute;
						top: 2px;
						left: 2px;
						width: 14px;
						height: 14px;
						border-radius: 50%;
						background: var(--translator-text-muted);
						transition: transform 150ms ease, background 150ms ease;
					}
					.translator-switch-on {
						background: var(--translator-ok);
						border-color: transparent;
					}
					.translator-switch-on::after {
						background: #fff;
						transform: translateX(16px);
					}
					.translator-switch:disabled {cursor: default;}
					/* ===== inputs ===== */
					.translator-input {
						width: 100%;
						box-sizing: border-box;
						height: 32px;
						padding: 0 10px;
						border: 1px solid var(--translator-input-border);
						border-radius: 6px;
						background: var(--translator-input-bg);
						color: var(--translator-text);
						font: inherit;
						font-size: 15px;
						outline: none;
						transition: border-color 120ms ease, box-shadow 120ms ease;
					}
					.translator-input:hover {border-color: color-mix(in srgb, var(--translator-text) 16%, transparent);}
					.translator-input:focus {
						border-color: var(--translator-brand);
						box-shadow: 0 0 0 3px color-mix(in srgb, var(--translator-brand) 18%, transparent);
					}
					.translator-input::placeholder {color: var(--translator-text-muted);}
					.translator-input-wrap {position: relative; min-width: 0;}
					.translator-input-wrap .translator-input {padding-right: 38px;}
					.translator-eye {
						appearance: none;
						position: absolute;
						top: 1px;
						right: 1px;
						bottom: 1px;
						width: 30px;
						padding: 0;
						border: 0;
						border-left: 1px solid var(--translator-border);
						border-radius: 0 5px 5px 0;
						background: transparent;
						color: var(--translator-text-sub);
						cursor: pointer;
						display: flex;
						align-items: center;
						justify-content: center;
					}
					.translator-eye:hover {background: var(--translator-hover); color: var(--translator-text);}
					.translator-eye svg {width: 15px; height: 15px; display: block;}
					/* Model input doubles as a drop list once a catalog is fetched
					   (the reference plugin's combo: chevron inside the field). */
					.translator-model-combo {position: relative; min-width: 0;}
					.translator-model-combo-has-models .translator-input {padding-right: 34px;}
					.translator-combo-chevron {
						appearance: none;
						position: absolute;
						top: 1px;
						right: 1px;
						bottom: 1px;
						width: 26px;
						padding: 0;
						border: 0;
						border-left: 1px solid var(--translator-input-border);
						border-radius: 0 5px 5px 0;
						background: transparent;
						color: var(--translator-text-sub);
						cursor: pointer;
						display: flex;
						align-items: center;
						justify-content: center;
					}
					.translator-combo-chevron:hover {background: var(--translator-hover); color: var(--translator-text);}
					.translator-combo-chevron svg {width: 16px; height: 16px; display: block; transition: transform 120ms ease;}
					.translator-combo-chevron[aria-expanded="true"] svg {transform: rotate(180deg);}
					.translator-field-label {
						display: flex;
						align-items: center;
						gap: 5px;
						margin: 14px 0 6px;
						color: var(--translator-text);
						font-size: 16px;
						font-weight: 500;
					}
					/* Performance controls are intentionally a compact card instead of five
					   competing full-width rows. Labels stay above their own controls, while
					   runtime state and destructive actions get separate visual zones. */
					.translator-performance-card {
						display: flex;
						flex-direction: column;
						gap: 10px;
						padding: 12px;
						border: 1px solid var(--translator-border);
						border-radius: 8px;
						background: color-mix(in srgb, var(--translator-surface) 72%, transparent);
					}
					.translator-performance-control-grid {display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px;}
					.translator-performance-control {
						min-width: 0;
						padding: 9px 10px 10px;
						border-radius: 7px;
						background: var(--translator-sunken);
					}
					.translator-performance-control .translator-field-label {margin: 0 0 7px; min-height: 20px; font-size: 14px; line-height: 20px;}
					.translator-performance-control-input {min-width: 0;}
					.translator-performance-switch-field {
						display: flex;
						align-items: center;
						justify-content: space-between;
						height: 32px;
						color: var(--translator-text-sub);
						font-size: 13px;
					}
					.translator-performance-runtime {
						display: grid;
						grid-template-columns: minmax(0, 1fr) 34px;
						align-items: center;
						gap: 10px;
						min-width: 0;
						padding: 8px 10px;
						border: 1px solid color-mix(in srgb, var(--translator-ok) 34%, var(--translator-border));
						border-radius: 7px;
						background: color-mix(in srgb, var(--translator-ok) 7%, var(--translator-sunken));
					}
					.translator-performance-runtime-limited {
						border-color: color-mix(in srgb, var(--translator-warn) 46%, var(--translator-border));
						background: color-mix(in srgb, var(--translator-warn) 8%, var(--translator-sunken));
					}
					.translator-performance-runtime-copy {min-width: 0;}
					.translator-performance-runtime-label {color: var(--translator-text); font-size: 13px; font-weight: 700; line-height: 18px;}
					.translator-performance-runtime-value {color: var(--translator-text-muted); font-size: 12px; line-height: 17px; white-space: normal; overflow-wrap: anywhere;}
					.translator-performance-runtime-cap {
						display: inline-flex;
						align-items: center;
						justify-content: center;
						width: 30px;
						height: 30px;
						border-radius: 50%;
						background: var(--translator-ok);
						color: #fff;
						font-size: 15px;
						font-weight: 800;
					}
					.translator-performance-runtime-limited .translator-performance-runtime-cap {background: var(--translator-warn); color: var(--translator-sunken);}
					.translator-cache-card {margin-top: 12px; padding: 12px; border: 1px solid var(--translator-border); border-radius: 8px; background: var(--translator-surface);}
					.translator-cache-heading, .translator-cache-controls {display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px 16px;}
					.translator-cache-heading {margin-bottom: 12px;}
					.translator-cache-title {display: inline-flex; align-items: center; gap: 6px; color: var(--translator-text); font-size: 14px; font-weight: 600;}
					.translator-cache-usage {color: var(--translator-text-muted); font-size: 12px; font-variant-numeric: tabular-nums;}
					.translator-cache-capacity {display: flex; align-items: center; gap: 8px; color: var(--translator-text-sub); font-size: 13px;}
					.translator-cache-capacity .translator-input {width: 100px; height: 32px; font-variant-numeric: tabular-nums; appearance: textfield; -moz-appearance: textfield;}
					.translator-cache-capacity .translator-input::-webkit-inner-spin-button,
					.translator-cache-capacity .translator-input::-webkit-outer-spin-button {-webkit-appearance: none; margin: 0;}
					.translator-btn.translator-btn-danger {background: color-mix(in srgb, var(--translator-danger) 10%, var(--translator-sunken)); color: var(--translator-danger); border: 1px solid color-mix(in srgb, var(--translator-danger) 35%, var(--translator-border));}
					.translator-btn.translator-btn-danger:hover {background: color-mix(in srgb, var(--translator-danger) 20%, var(--translator-sunken));}
					/* ===== buttons (primary brand, secondary sunken, green add, icon) ===== */
					.translator-btn {
						appearance: none;
						height: 32px;
						box-sizing: border-box;
						padding: 0 14px;
						border: 0;
						border-radius: 4px;
						display: inline-flex;
						align-items: center;
						justify-content: center;
						gap: 6px;
						background: var(--translator-brand);
						color: var(--translator-on-brand);
						font: inherit;
						font-size: 14px;
						font-weight: 500;
						line-height: 1;
						cursor: pointer;
						flex: 0 0 auto;
					}
					.translator-btn:hover {background: var(--translator-brand-active);}
					.translator-btn:disabled {opacity: 0.45; cursor: not-allowed;}
					.translator-btn svg {width: 13px; height: 13px; display: block;}
					.translator-btn-sec {
						background: var(--translator-sunken);
						color: var(--translator-text);
						border: 1px solid var(--translator-border);
					}
					.translator-btn-sec:hover {background: var(--translator-hover);}
					.translator-btn-green {background: var(--translator-ok); color: #fff; border: 0;}
					.translator-btn-green:hover {background: color-mix(in srgb, var(--translator-ok) 88%, black);}
					.translator-iconbtn {
						appearance: none;
						width: 32px;
						height: 32px;
						padding: 0;
						border: 1px solid var(--translator-border);
						border-radius: 6px;
						background: var(--translator-sunken);
						color: var(--translator-text-sub);
						cursor: pointer;
						display: inline-flex;
						align-items: center;
						justify-content: center;
						flex: 0 0 auto;
					}
					.translator-iconbtn:hover {background: var(--translator-hover); color: var(--translator-text);}
					.translator-iconbtn svg {width: 15px; height: 15px; display: block;}
					.translator-iconbtn-danger:hover {
						background: color-mix(in srgb, var(--translator-danger) 12%, transparent);
						border-color: color-mix(in srgb, var(--translator-danger) 45%, transparent);
						color: var(--translator-danger);
					}
					.translator-minibtn {
						appearance: none;
						width: 24px;
						height: 24px;
						padding: 0;
						border: 0;
						border-radius: 4px;
						background: transparent;
						color: var(--translator-text-muted);
						cursor: pointer;
						display: inline-flex;
						align-items: center;
						justify-content: center;
						flex: 0 0 auto;
					}
					.translator-minibtn:hover {background: var(--translator-hover); color: var(--translator-text);}
					.translator-minibtn svg {width: 14px; height: 14px; display: block;}
					.translator-minibtn-danger:hover {
						background: color-mix(in srgb, var(--translator-danger) 12%, transparent);
						color: var(--translator-danger);
					}
					.translator-portal-row {
						display: flex;
						flex-wrap: wrap;
						gap: 8px;
						margin-top: 12px;
					}
					.translator-portal {
						appearance: none;
						height: 26px;
						padding: 0 11px;
						box-sizing: border-box;
						border: 1px solid var(--translator-border);
						border-radius: 13px;
						background: color-mix(in srgb, var(--translator-brand) 9%, var(--translator-surface));
						color: var(--translator-text);
						font: inherit;
						font-size: 12px;
						font-weight: 600;
						line-height: 1;
						display: inline-flex;
						align-items: center;
						gap: 6px;
						cursor: pointer;
						text-decoration: none;
					}
					.translator-portal:hover {border-color: color-mix(in srgb, var(--translator-brand) 55%, transparent); color: var(--translator-text-strong);}
					.translator-portal:disabled {opacity: 0.55; cursor: default;}
					.translator-portal svg {width: 14px; height: 14px; display: block; color: var(--translator-text-sub);}
					.translator-portal:hover svg {color: color-mix(in srgb, var(--translator-brand) 50%, var(--translator-text-strong));}
					/* ===== status lines (result text stays in place) ===== */
					.translator-status {
						margin-top: 8px;
						font-size: 13px;
						color: var(--translator-text-muted);
					}
					.translator-status-ok {color: var(--translator-ok);}
					.translator-status-fail {color: var(--translator-danger);}
					.translator-status-warn {color: var(--translator-warn);}
					.translator-status-ok::before,
					.translator-status-fail::before,
					.translator-status-warn::before {
						content: "";
						display: inline-block;
						width: 6px;
						height: 6px;
						border-radius: 50%;
						background: currentColor;
						margin-right: 6px;
						vertical-align: 2px;
					}
					.translator-model-validation-status {position: relative; min-width: 0; min-height: 18px; padding-left: 12px; line-height: 18px;}
					.translator-model-validation-status.translator-status-ok::before,
					.translator-model-validation-status.translator-status-fail::before {position: absolute; left: 0; top: 6px; margin: 0;}
					.translator-status-main,
					.translator-status-detail {display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;}
					.translator-status-main {font-size: 13px; line-height: 18px; font-weight: 600;}
					.translator-status-detail {margin-top: 2px; font-size: 12.5px; line-height: 18px; font-weight: 400; opacity: 0.88;}
					.translator-status-detail-warn {color: var(--translator-warn); opacity: 1;}
					.translator-status-detail-ok {color: var(--translator-ok); opacity: 0.92;}
					/* ===== searchable self-drawn select ===== */
					.translator-search-select {position: relative; width: 100%; min-width: 0;}
					.translator-search-select-disabled {opacity: 0.55;}
					.translator-search-select-disabled .translator-search-select-trigger {cursor: not-allowed;}
					.translator-search-select-trigger {
						appearance: none;
						display: flex;
						align-items: center;
						width: 100%;
						height: 32px;
						padding: 0 0 0 10px;
						border: 1px solid var(--translator-border);
						border-radius: 6px;
						background: var(--translator-sunken);
						color: var(--translator-text);
						font: inherit;
						font-size: 15px;
						line-height: 1;
						text-align: left;
						cursor: pointer;
						overflow: hidden;
					}
					.translator-search-select-trigger:hover {background: var(--translator-hover);}
					.translator-search-select-value {
						min-width: 0;
						flex: 1 1 auto;
						overflow: hidden;
						text-overflow: ellipsis;
						white-space: nowrap;
					}
					.translator-search-select-chevron {
						align-self: stretch;
						width: 26px;
						flex: 0 0 auto;
						display: flex;
						align-items: center;
						justify-content: center;
						border-left: 1px solid var(--translator-border);
						color: var(--translator-text-sub);
					}
					.translator-search-select-chevron svg {width: 15px; height: 15px; display: block;}
					.translator-search-select-popout {
						position: absolute;
						z-index: 10020;
						top: calc(100% + 4px);
						left: 0;
						right: 0;
						padding: 6px 0 6px 6px;
						border: 1px solid var(--translator-border);
						border-radius: 8px;
						background: var(--translator-floating);
						box-shadow: var(--translator-shadow);
						box-sizing: border-box;
					}
					.translator-search-select-input {
						width: calc(100% - 6px);
						height: 32px;
						padding: 0 9px;
						border: 1px solid var(--translator-border);
						border-radius: 5px;
						background: var(--translator-input-bg);
						color: var(--translator-text);
						font: inherit;
						font-size: 13.5px;
						box-sizing: border-box;
						outline: none;
					}
					.translator-search-select-input:focus {border-color: var(--translator-brand);}
					.translator-search-select-list {max-height: 220px; margin-top: 5px; overflow-y: auto; overflow-x: hidden;}
					.translator-search-select-up .translator-search-select-popout {top: auto; bottom: calc(100% + 4px);}
					/* Portaled to document.body (fixed coordinates come inline): the
					   list escapes the modal so it is never clipped and never grows the
					   modal's scrollbar. Height clamps flow into the inner list. */
					.translator-search-select-popout-fixed {
						position: fixed;
						top: auto;
						left: auto;
						right: auto;
						bottom: auto;
						z-index: 10050;
						display: flex;
						flex-direction: column;
					}
					.translator-search-select-popout-fixed .translator-search-select-input {flex: 0 0 auto;}
					.translator-search-select-popout-fixed .translator-search-select-list {flex: 1 1 auto; min-height: 0; max-height: none;}
					.translator-search-select-list::-webkit-scrollbar {width: 6px;}
					.translator-search-select-list::-webkit-scrollbar-track {background: transparent;}
					.translator-search-select-list::-webkit-scrollbar-thumb {
						background: var(--scrollbar-auto-thumb, var(--translator-border));
						border-radius: 4px;
					}
					.translator-search-select-list::-webkit-scrollbar-button {display: none; width: 0; height: 0;}
					.translator-search-select-option {
						appearance: none;
						display: flex;
						align-items: center;
						width: calc(100% - 6px);
						min-height: 30px;
						padding: 5px 10px 5px 8px;
						border: 0;
						border-radius: 5px;
						background: transparent;
						color: var(--translator-text);
						font: inherit;
						font-size: 14px;
						text-align: left;
						cursor: pointer;
						box-sizing: border-box;
						gap: 6px;
					}
					.translator-search-select-option:hover,
					.translator-search-select-option-active {background: var(--translator-hover);}
					.translator-search-select-option[aria-selected="true"] {color: var(--translator-brand-soft); font-weight: 700;}
					.translator-search-select-option-content {min-width: 0; flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;}
					.translator-search-select-option-content > * {min-width: 0; max-width: 100%;}
					.translator-search-select-favorite {
						appearance: none;
						width: 24px;
						height: 24px;
						padding: 0;
						border: 0;
						border-radius: 4px;
						background: transparent;
						color: var(--translator-text-muted);
						font-size: 14px;
						cursor: pointer;
						flex: 0 0 auto;
					}
					.translator-search-select-favorite:hover {background: var(--translator-hover); color: var(--translator-text);}
					.translator-search-select-favorite-active {color: var(--translator-warn);}
					.translator-search-select-empty {margin-right: 6px; padding: 10px 8px; color: var(--translator-text-muted); font-size: 12.5px; text-align: center;}
					/* dashed "+ add" chip variant of the select trigger */
					.translator-language-filter-select {width: 340px; max-width: 100%; flex: 0 1 auto;}
					.translator-multi-option {display: flex; align-items: center; gap: 8px; min-width: 0; width: 100%; overflow: hidden;}
					.translator-multi-option-name {flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;}
					.translator-multi-star {flex: 0 0 auto; color: var(--translator-text-muted); font-size: 14px; line-height: 1;}
					.translator-multi-star-active {color: var(--translator-warn);}
					.translator-search-select-aschip {width: auto;}
					.translator-search-select-aschip .translator-search-select-trigger {
						height: 26px;
						padding: 0 10px;
						border: 1px dashed color-mix(in srgb, var(--translator-ok) 45%, transparent);
						border-radius: 6px;
						background: transparent;
						color: var(--translator-ok);
						font-size: 12.5px;
						font-weight: 500;
					}
					.translator-search-select-aschip .translator-search-select-trigger:hover {
						background: color-mix(in srgb, var(--translator-ok) 10%, transparent);
					}
					.translator-search-select-aschip .translator-search-select-chevron {display: none;}
					.translator-search-select-aschip .translator-search-select-popout {left: auto; right: 0; width: 260px;}
					/* ===== provider page: intro banner, rail, card, fields ===== */
					.translator-provider-onboarding {
						display: flex;
						gap: 10px;
						align-items: flex-start;
						margin-bottom: 14px;
						padding: 12px;
						border-radius: 8px;
						background: color-mix(in srgb, var(--translator-brand) 8%, transparent);
					}
					.translator-provider-onboarding-icon {
						flex: 0 0 auto;
						display: flex;
						color: var(--translator-brand-soft);
					}
					.translator-provider-onboarding-icon svg {width: 20px; height: 20px; display: block; fill: currentColor;}
					.translator-provider-onboarding-title {
						color: var(--translator-text-strong);
						font-size: 16px;
						font-weight: 600;
					}
					.translator-provider-onboarding-body {
						margin-top: 2px;
						color: var(--translator-text-muted);
						font-size: 14px;
						line-height: 1.6;
					}
					.translator-provider-onboarding-body b {color: var(--translator-text-sub); font-weight: 600;}
					.translator-provider-workspace {
						display: grid;
						grid-template-columns: 160px minmax(0, 1fr);
						gap: 16px;
						align-items: start;
					}
					.translator-provider-rail {display: flex; flex-direction: column; gap: 2px; min-width: 0;}
					.translator-provider-group-title {
						margin: 10px 0 3px 10px;
						color: var(--translator-text-muted);
						font-size: 11px;
						font-weight: 700;
						letter-spacing: 0.08em;
					}
					.translator-provider-group-title:first-child {margin-top: 0;}
					.translator-provider-option {
						appearance: none;
						display: flex;
						align-items: center;
						gap: 8px;
						width: 100%;
						min-width: 0;
						height: 34px;
						padding: 0 8px 0 10px;
						border: 0;
						border-radius: 6px;
						background: transparent;
						color: var(--translator-text-sub);
						font: inherit;
						font-size: 15px;
						font-weight: 500;
						text-align: left;
						cursor: pointer;
					}
					.translator-provider-option:hover {background: var(--translator-hover); color: var(--translator-text);}
					.translator-provider-option-active,
					.translator-provider-option-active:hover {
						background: var(--translator-selected);
						color: var(--translator-text-strong);
						font-weight: 600;
					}
					.translator-provider-ic {
						position: relative;
						width: 18px;
						height: 18px;
						flex: 0 0 auto;
						display: flex;
						align-items: center;
						justify-content: center;
					}
					.translator-provider-ic > svg {width: 16px; height: 16px; display: block;}
					.translator-provider-initial {
						width: 17px;
						height: 17px;
						border-radius: 4px;
						background: var(--translator-sunken);
						border: 1px solid var(--translator-border);
						color: var(--translator-text-sub);
						font-size: 9px;
						font-weight: 700;
						display: flex;
						align-items: center;
						justify-content: center;
						box-sizing: border-box;
					}
					.translator-provider-dot {
						position: absolute;
						right: -3px;
						bottom: -2px;
						width: 6px;
						height: 6px;
						border-radius: 50%;
						background: var(--translator-ok);
					}
					.translator-provider-name {
						min-width: 0;
						flex: 1 1 auto;
						overflow: hidden;
						text-overflow: ellipsis;
						white-space: nowrap;
					}
					.translator-provider-role {flex: 0 0 auto; font-size: 11px; font-weight: 700;}
					.translator-provider-add {
						appearance: none;
						margin-top: 6px;
						height: 28px;
						border: 1px dashed var(--translator-border);
						border-radius: 4px;
						background: transparent;
						color: var(--translator-text-muted);
						font: inherit;
						font-size: 13px;
						display: flex;
						align-items: center;
						justify-content: center;
						gap: 4px;
						cursor: pointer;
					}
					.translator-provider-add:hover {background: var(--translator-hover); color: var(--translator-text);}
					.translator-provider-add svg {width: 13px; height: 13px; display: block;}
					.translator-provider-custom-glyph {display: inline-flex; color: var(--translator-brand);}
					.translator-provider-custom-glyph svg {width: 16px; height: 16px; display: block; fill: currentColor;}
					.translator-provider-tile-custom {color: var(--translator-brand);}
					.translator-provider-tile .translator-provider-custom-glyph svg {width: 18px; height: 18px;}
					.translator-provider-rename {
						appearance: none;
						display: flex;
						align-items: center;
						gap: 6px;
						min-width: 0;
						max-width: 100%;
						padding: 0;
						border: 0;
						background: transparent;
						color: inherit;
						font: inherit;
						text-align: left;
						cursor: text;
					}
					.translator-provider-rename .translator-provider-card-title {min-width: 0;}
					.translator-provider-rename:hover .translator-provider-card-title {text-decoration: underline; text-decoration-color: var(--translator-text-muted); text-underline-offset: 3px;}
					.translator-provider-pencil {flex: 0 0 auto; display: inline-flex; color: var(--translator-text-muted);}
					.translator-provider-pencil svg {width: 12px; height: 12px; display: block;}
					.translator-provider-rename:hover .translator-provider-pencil {color: var(--translator-text);}
					.translator-provider-rename-input {
						width: 100%;
						min-width: 0;
						box-sizing: border-box;
						padding: 0 0 1px;
						border: 0;
						border-bottom: 1.5px solid var(--translator-brand);
						border-radius: 0;
						background: transparent;
						color: var(--translator-text-strong);
						font-family: inherit;
						font-size: 16px;
						font-weight: 700;
						outline: none;
					}
					.translator-provider-role-primary {
						height: 16px;
						padding: 0 6px;
						border-radius: 8px;
						background: color-mix(in srgb, var(--translator-brand) 18%, transparent);
						color: var(--translator-brand-soft);
						display: inline-flex;
						align-items: center;
					}
					.translator-provider-role-backup {
						height: 16px;
						padding: 0 6px;
						border-radius: 8px;
						background: color-mix(in srgb, var(--translator-warn) 16%, transparent);
						color: var(--translator-warn);
						display: inline-flex;
						align-items: center;
					}
					.translator-provider-detail {min-width: 0;}
					.translator-provider-detail .translator-input {height: 38px;}
					.translator-provider-detail .translator-eye {width: 34px;}
					.translator-provider-detail .translator-model-row .translator-btn {height: 38px;}
					.translator-provider-detail .translator-model-row .translator-iconbtn {width: 38px; height: 38px;}
					.translator-provider-main-slot {display: contents;}
					/* The artboard's vertical rhythm: each control row opens ~14px under the row
					   above it, the strength row stays clustered with its mode row, and labels
					   keep hugging their own control. */
					.translator-provider-main-slot[data-provider-main-slot="thinking"] > .translator-row {margin-top: 10px;}
					.translator-provider-main-slot[data-provider-main-slot="strength"] > .translator-row {margin-top: 4px;}
					.translator-thinking-group-head {display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin-bottom: 4px;}
					/* The card announces itself the way every other group header does: muted and
					   one tier under the field labels, so the controls stay the loudest thing. */
					.translator-thinking-group-title {font-size: 14px; font-weight: 700; line-height: 20px; color: var(--translator-text-muted);}
					.translator-thinking-group-badge {flex: 0 1 auto; min-width: 0; padding: 1px 8px; border: 1px solid var(--translator-border); border-radius: 999px; font-size: 12px; line-height: 18px; color: var(--translator-text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;}
					.translator-thinking-group {margin-top: 12px; padding: 10px 12px 12px; border: 1px solid var(--translator-border); border-radius: 8px; background: var(--translator-surface); display: flex; flex-direction: column; gap: 2px;}
					/* Inside the card every label sits on the same 14px tier as the thinking rows. */
					.translator-thinking-group .translator-field-label {margin-top: 6px; font-size: 14px;}
					/* The note under a row is a second full-width line; without wrap the three
					   flex children share one line and the CJK label crushes to one character
					   per row. */
					.translator-thinking-group .translator-row {flex-wrap: wrap;}
					/* The detail pane is the width reference, so the model row folds by its real
					   container: the input keeps the first line, fetch and verify share the second. */
					.translator-provider-detail {container-type: inline-size;}
					@container (max-width: 430px) {
						.translator-model-row {flex-wrap: wrap;}
						.translator-model-row .translator-model-combo {flex: 1 1 100%; min-width: 150px;}
						.translator-model-row .translator-iconbtn {flex: 0 0 auto;}
						.translator-model-row .translator-provider-validate {flex: 1 1 auto; min-width: 80px;}
						.translator-tier-custom-control {flex-wrap: wrap;}
					}
					/* The status strip: a tinted row that owns the sentence, its expandable
					   detail and at most one contextual action. The sentence wraps, never
					   truncates; the tint names the tone without shouting. */
					.translator-provider-status-actions {min-height: 40px; margin-top: 8px; display: flex; align-items: flex-start; gap: 8px; padding: 9px 10px; border-radius: 6px; background: color-mix(in srgb, var(--translator-text) 5%, transparent);}
					.translator-provider-status-actions[data-status-tone="warn"] {background: color-mix(in srgb, var(--translator-warn) 10%, transparent);}
					.translator-provider-status-actions[data-status-tone="fail"] {background: color-mix(in srgb, var(--translator-danger) 9%, transparent);}
					.translator-provider-status-actions[data-status-tone="ok"] {background: color-mix(in srgb, var(--translator-ok) 9%, transparent);}
					.translator-status-strip-dot {width: 6px; height: 6px; border-radius: 50%; margin-top: 6px; flex: none; background: currentColor; color: var(--translator-text-muted);}
					.translator-status-strip-body {flex: 1 1 140px; min-width: 0;}
					/* The strip's sentence wraps instead of inheriting the base ellipsis. */
					.translator-provider-main-status .translator-status-main {display: block; font-size: 13px; line-height: 18px; font-weight: 500; color: var(--translator-text-sub); white-space: normal; overflow: visible; text-overflow: clip; overflow-wrap: anywhere;}
					.translator-status-latency {margin-top: 2px; font-size: 12px; line-height: 16px; font-weight: 400; color: var(--translator-text-muted);}
					.translator-provider-status-actions[data-status-tone="warn"] .translator-status-strip-dot,
					.translator-provider-status-actions[data-status-tone="warn"] .translator-status-main {color: var(--translator-warn);}
					.translator-provider-status-actions[data-status-tone="fail"] .translator-status-strip-dot,
					.translator-provider-status-actions[data-status-tone="fail"] .translator-status-main {color: var(--translator-danger);}
					.translator-provider-status-actions[data-status-tone="ok"] .translator-status-strip-dot,
					.translator-provider-status-actions[data-status-tone="ok"] .translator-status-main {color: var(--translator-ok);}
					.translator-provider-detail .translator-provider-main-slot .translator-row-label,
					.translator-provider-detail .translator-provider-advanced-body .translator-row-label {font-size: 14px;}
					.translator-provider-diagnostics {margin-top: 6px; font-size: 12px; line-height: 16px; color: var(--translator-text-muted); word-break: break-word;}
					.translator-row-note {flex: 1 1 100%; margin-top: 6px; font-size: 12px; line-height: 18px; color: var(--translator-text-muted);}
					.translator-row-note-error {color: var(--translator-danger);}
					.translator-tier-option {display: flex; align-items: baseline; justify-content: space-between; gap: 10px; min-width: 0;}
					.translator-tier-copy {display: inline-flex; flex-direction: column; gap: 1px; min-width: 0;}
					.translator-tier-gloss {font-size: 12px; line-height: 16px; color: var(--translator-text-muted); font-weight: 400;}
					.translator-tier-raw {font-size: 13px; line-height: 18px; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;}
					.translator-tier-sub {flex: 0 0 auto; font-size: 12px; line-height: 16px; color: var(--translator-text-muted); font-weight: 400;}
					.translator-tier-sub.is-confirmed {color: var(--translator-ok); font-weight: 600;}
					.translator-tier-sub.is-sent,
					.translator-tier-sub.is-reduced,
					.translator-tier-sub.is-ignored {color: var(--translator-warn); font-weight: 600;}
					.translator-tier-sub.is-rejected {color: var(--translator-danger); font-weight: 600;}
					.translator-tier-sub.is-invalid {color: var(--translator-text-muted); font-weight: 600;}
					.translator-tier-custom-control {display: flex; align-items: center; gap: 8px; min-width: 0;}
					.translator-tier-custom-control .translator-input {flex: 1 1 150px; min-width: 150px;}
					.translator-input-invalid {border-color: var(--translator-danger);}
					/* Advanced is a quiet disclosure row at the card bottom, behind the card's
					   only hairline, never boxed into a second bordered card. */
					.translator-provider-advanced {min-width: 0; margin-top: 14px; padding-top: 4px; border-top: 1px solid var(--translator-border);}
					.translator-provider-advanced-toggle {appearance: none; width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 2px; border: 0; border-radius: 4px; background: transparent; color: var(--translator-text-sub); font: inherit; font-size: 13px; line-height: 18px; font-weight: 600; cursor: pointer;}
					.translator-provider-advanced-toggle:hover {color: var(--translator-text-strong);}
					.translator-provider-advanced-toggle:disabled {opacity: 0.55; cursor: default;}
					.translator-provider-advanced-body {margin-top: 4px; display: flex; flex-direction: column; gap: 12px;}
					/* The advanced row keeps its note in the label column and centers the control
					   across both lines, so nothing floats between sections. */
					.translator-provider-advanced-body .translator-row {display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; column-gap: 12px; row-gap: 3px; min-height: 32px;}
					.translator-provider-advanced-body .translator-row .translator-row-control {grid-column: 2; grid-row: 1 / span 2; max-width: 100%;}
					.translator-provider-advanced-body .translator-row .translator-row-note {grid-column: 1; grid-row: 2; margin-top: 0;}
					.translator-provider-speed {min-width: 0;}
					.translator-provider-speed-toggle {appearance: none; width: 100%; min-height: 32px; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 0; border: 0; background: transparent; color: var(--translator-text-strong); font: inherit; font-size: 14px; line-height: 20px; font-weight: 600; cursor: pointer;}
					.translator-provider-speed-toggle:focus-visible {outline: 2px solid var(--translator-brand); outline-offset: 2px; border-radius: 4px;}
					.translator-provider-speed-toggle:disabled {opacity: 0.55; cursor: default;}
					.translator-provider-speed-meta {display: inline-flex; align-items: center; gap: 6px; font-size: 12px; line-height: 16px; font-weight: 400; color: var(--translator-text-muted);}
					.translator-provider-speed-state.is-done {color: var(--translator-ok); font-weight: 600;}
					.translator-provider-advanced-chevron {display: inline-flex; transition: transform 120ms ease;}
					[data-provider-action="advanced"][aria-expanded="true"] .translator-provider-advanced-chevron {transform: rotate(180deg);}
					.translator-provider-speed-toggle svg {transition: transform 120ms ease;}
					.translator-provider-speed-toggle[aria-expanded="true"] svg {transform: rotate(180deg);}
					/* The A/B details live in one filled box instead of stacking more dividers. */
					.translator-provider-speed-body {min-width: 0; margin-top: 6px; padding: 10px 12px; border: 1px solid var(--translator-border); border-radius: 6px; background: var(--translator-sunken);}
					.translator-reasoning-benchmark {min-width: 0;}
					.translator-benchmark-header {min-height: 32px; display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap;}
					.translator-benchmark-desc {margin-top: 4px; font-size: 12px; line-height: 16px; color: var(--translator-text-muted);}
					.translator-benchmark-title {min-width: 0; display: inline-flex; align-items: center; gap: 5px; flex-wrap: wrap; color: var(--translator-text-strong); font-size: 14px; line-height: 20px; font-weight: 600;}
					.translator-benchmark-badge {padding: 2px 7px; border-radius: 9px; background: color-mix(in srgb, var(--translator-brand) 10%, transparent); color: var(--translator-text-muted); font-size: 11.5px; line-height: 16px; font-weight: 500;}
					.translator-benchmark-progress-copy {margin-top: 6px; color: var(--translator-text-muted); font-size: 12.5px; line-height: 18px; overflow-wrap: anywhere;}
					.translator-benchmark-progress {height: 4px; margin-top: 5px; border-radius: 2px; overflow: hidden; background: color-mix(in srgb, var(--translator-text) 12%, transparent);}
					.translator-benchmark-progress > span {display: block; height: 100%; border-radius: inherit; background: var(--translator-brand); transition: width 120ms ease;}
					.translator-benchmark-results {margin-top: 8px;}
					.translator-benchmark-result-row {min-height: 30px; display: grid; grid-template-columns: minmax(110px, 140px) minmax(0, 1fr); align-items: center; gap: 12px; border-top: 1px solid color-mix(in srgb, var(--translator-border) 70%, transparent); font-size: 12.5px; line-height: 18px;}
					.translator-benchmark-result-row > span:first-child {color: var(--translator-text); font-weight: 600;}
					.translator-benchmark-result-row > span:last-child {min-width: 0; color: var(--translator-text-muted); text-align: right; overflow-wrap: anywhere;}
					.translator-benchmark-result-status {padding-top: 6px; color: var(--translator-text-muted); font-size: 12.5px; line-height: 18px;}
					.translator-benchmark-result-status-ok {color: var(--translator-ok);}
					.translator-benchmark-result-status-warn {color: var(--translator-warn);}
					@media (max-width: 430px) {
						.translator-benchmark-header {align-items: flex-start;}
						.translator-benchmark-result-row {grid-template-columns: 1fr; gap: 2px; padding: 5px 0;}
						.translator-benchmark-result-row > span:last-child {text-align: left;}
						.translator-provider-status-actions {flex-wrap: wrap;}
						.translator-provider-advanced-body .translator-row {grid-template-columns: 1fr;}
						.translator-provider-advanced-body .translator-row .translator-row-control {grid-column: 1; grid-row: auto; width: 100%;}
						.translator-provider-advanced-body .translator-row .translator-row-note {grid-row: auto;}
						.translator-provider-advanced-body .translator-row-control > div {width: 100% !important;}
					}
					.translator-provider-card {
						display: flex;
						align-items: center;
						gap: 10px;
						padding: 8px 10px;
						border: 1px solid var(--translator-border);
						border-radius: 8px;
						background: var(--translator-surface);
						margin-bottom: 14px;
					}
					.translator-provider-tile {
						width: 32px;
						height: 32px;
						border-radius: 8px;
						flex: 0 0 auto;
						background: var(--translator-sunken);
						border: 1px solid var(--translator-border);
						color: var(--translator-text-strong);
						display: flex;
						align-items: center;
						justify-content: center;
						box-sizing: border-box;
					}
					.translator-provider-tile svg {width: 18px; height: 18px; display: block;}
					.translator-provider-tile .translator-provider-initial {
						width: 100%;
						height: 100%;
						border: 0;
						background: transparent;
						font-size: 12px;
						color: var(--translator-text-strong);
					}
					.translator-provider-card-copy {min-width: 0; flex: 1 1 auto;}
					.translator-provider-card-title {color: var(--translator-text-strong); font-size: 16px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;}
					.translator-provider-card-title-full {white-space: normal; overflow-wrap: anywhere; line-height: 1.25;}
					.translator-provider-card-description {
						display: flex;
						align-items: center;
						gap: 5px;
						color: var(--translator-text-muted);
						font-size: 12px;
						white-space: nowrap;
						overflow: hidden;
						text-overflow: ellipsis;
					}
					.translator-provider-card-description::before {
						content: "";
						width: 6px;
						height: 6px;
						border-radius: 50%;
						background: var(--translator-border);
						flex: 0 0 auto;
					}
					.translator-provider-card-description-ok::before {background: var(--translator-ok);}
					.translator-provider-badge {
						height: 32px;
						padding: 0 12px;
						border-radius: 6px;
						box-sizing: border-box;
						flex: 0 0 auto;
						background: color-mix(in srgb, var(--translator-brand) 15%, transparent);
						color: var(--translator-brand-soft);
						font-size: 13px;
						font-weight: 600;
						display: inline-flex;
						align-items: center;
					}
					.translator-provider-card-actions {display: flex; align-items: center; flex: 0 0 auto; gap: 6px; flex-wrap: wrap; justify-content: flex-end;}
					.translator-provider-role-actions {display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px;}
					.translator-provider-role-actions > * {width: 100%; min-width: 70px; height: 32px; padding: 0 12px; border-radius: 4px; font-size: 13px; justify-content: center; white-space: nowrap;}
					.translator-provider-region-select {width: 100%; min-width: 0;}
					.translator-provider-region-select .translator-search-select-trigger {height: 38px;}
					.translator-model-row {display: flex; gap: 8px; align-items: stretch;}
					.translator-model-row .translator-input-wrap,
					.translator-model-row .translator-model-combo {flex: 1 1 auto;}
										.translator-dir {display: flex; align-items: center; gap: 8px; flex: 0 0 auto; min-width: 0;}
					.translator-dir-select {width: 170px; flex: 0 1 auto; min-width: 130px;}
					.translator-dir-arrow {color: var(--translator-text-muted); font-weight: 700; flex: 0 0 auto;}
					.translator-swap {
						appearance: none;
						width: 28px;
						height: 28px;
						padding: 0;
						border: 1px solid var(--translator-border);
						border-radius: 6px;
						background: var(--translator-sunken);
						color: var(--translator-text-sub);
						cursor: pointer;
						display: inline-flex;
						align-items: center;
						justify-content: center;
						flex: 0 0 auto;
					}
					.translator-swap:hover {background: var(--translator-hover); color: var(--translator-text); border-color: color-mix(in srgb, var(--translator-brand) 45%, var(--translator-border));}
					.translator-swap:disabled {opacity: 0.38; cursor: default;}
					.translator-swap svg {width: 14px; height: 14px; display: block;}
					.translator-source-filter-chips {
						display: flex;
						flex-wrap: wrap;
						align-items: center;
						justify-content: flex-end;
						gap: 6px;
						min-width: 0;
						flex: 0 1 auto;
					}
					.translator-chip,
					.translator-source-filter-chip {
						height: 26px;
						padding: 0 6px 0 10px;
						border-radius: 6px;
						background: var(--translator-sunken);
						border: 1px solid var(--translator-border);
						color: var(--translator-text);
						font-size: 13px;
						display: inline-flex;
						align-items: center;
						gap: 6px;
						min-width: 0;
						box-sizing: border-box;
					}
					.translator-chip-label,
					.translator-source-filter-chip-label {
						max-width: 180px;
						overflow: hidden;
						text-overflow: ellipsis;
						white-space: nowrap;
					}
					.translator-chip-remove,
					.translator-source-filter-chip-remove {
						appearance: none;
						display: flex;
						align-items: center;
						justify-content: center;
						padding: 0 3px;
						border: 0;
						border-radius: 3px;
						background: transparent;
						color: var(--translator-text-muted);
						font: inherit;
						font-size: 13px;
						line-height: 1;
						cursor: pointer;
					}
					.translator-chip-remove:hover,
					.translator-source-filter-chip-remove:hover {
						background: color-mix(in srgb, var(--translator-danger) 12%, transparent);
						color: var(--translator-danger);
					}
					.translator-source-filter-empty {color: var(--translator-text-muted); font-size: 12.5px;}
					.translator-chips {
						display: flex;
						flex-wrap: wrap;
						align-items: center;
						gap: 6px;
						margin: 6px 0 10px;
					}
					.translator-chip-input {
						height: 26px;
						width: 168px;
						padding: 0 10px;
						border: 1px dashed var(--translator-border);
						border-radius: 6px;
						background: transparent;
						color: var(--translator-text);
						font: inherit;
						font-size: 12.5px;
						outline: none;
						box-sizing: border-box;
					}
					.translator-chip-input::placeholder {color: var(--translator-text-muted);}
					.translator-chip-input:focus {border-style: solid; border-color: var(--translator-brand);}
					.translator-scope-chips {display: flex; gap: 6px; flex: 0 0 auto;}
					.translator-scope-chip {
						appearance: none;
						height: 24px;
						padding: 0 10px;
						border-radius: 12px;
						border: 1px solid var(--translator-border);
						background: var(--translator-sunken);
						color: var(--translator-text-muted);
						font: inherit;
						font-size: 12px;
						font-weight: 600;
						cursor: pointer;
						display: inline-flex;
						align-items: center;
						gap: 4px;
					}
					.translator-scope-chip:hover {color: var(--translator-text); border-color: color-mix(in srgb, var(--translator-brand) 40%, var(--translator-border));}
					.translator-scope-chip-active {
						background: color-mix(in srgb, var(--translator-brand) 15%, transparent);
						border-color: color-mix(in srgb, var(--translator-brand) 50%, transparent);
						color: var(--translator-brand-soft);
					}
					/* ===== prompt policy cards (same anatomy as the reference plugin) ===== */
					.translator-policy {
						position: relative;
						border: 1px solid var(--translator-border);
						border-radius: 8px;
						overflow: hidden;
						background: var(--translator-surface);
						margin-top: 8px;
					}
					/* Replaces the native textarea resize grip (hidden below) with the
					   reference plugin's quiet diagonal-stripe corner; the native drag
					   hit-area still does the work. */
					.translator-policy::after {
						content: "";
						position: absolute;
						right: 5px;
						bottom: 5px;
						width: 9px;
						height: 9px;
						pointer-events: none;
						color: var(--translator-text-muted);
						background: repeating-linear-gradient(135deg, transparent, transparent 2px, currentColor 2px, currentColor 3.5px);
						clip-path: polygon(100% 0, 100% 100%, 0 100%);
						opacity: 0.65;
					}
					.translator-policy-editable:focus-within {
						border-color: var(--translator-brand);
						box-shadow: 0 0 0 3px color-mix(in srgb, var(--translator-brand) 18%, transparent);
					}
					.translator-policy-head {
						display: flex;
						align-items: center;
						gap: 8px;
						padding: 7px 11px;
						background: rgba(255, 255, 255, 0.03);
						border-bottom: 1px solid rgba(255, 255, 255, 0.07);
					}
					.translator-policy-name {
						min-width: 0;
						flex: 0 1 auto;
						border: 0;
						padding: 0;
						background: transparent;
						color: var(--translator-text-strong);
						font: inherit;
						font-size: 14px;
						font-weight: 700;
						outline: none;
					}
					.translator-policy-name:hover,
					.translator-policy-name:focus {
						text-decoration: underline;
						text-decoration-color: var(--translator-text-muted);
						text-underline-offset: 3px;
					}
					.translator-policy-name-static {
						color: var(--translator-text-strong);
						font-size: 14px;
						font-weight: 700;
					}
					.translator-policy-lock {
						display: inline-flex;
						align-items: center;
						gap: 4px;
						height: 18px;
						padding: 0 8px;
						border-radius: 9px;
						font-size: 11px;
						font-weight: 600;
						color: var(--translator-warn);
						background: color-mix(in srgb, var(--translator-warn) 13%, transparent);
						flex: 0 0 auto;
					}
					.translator-policy-lock svg {width: 10px; height: 10px; display: block;}
					.translator-policy-actions {margin-left: auto; display: flex; gap: 2px; flex: 0 0 auto;}
					.translator-policy-body {
						display: block;
						width: 100%;
						min-height: 150px;
						padding: 10px 12px;
						border: 0;
						background: var(--translator-sunken);
						/* Read-only builtin reads in the sub tone; the editable card
						   below lifts it back to full text (the reference contrast). */
						color: var(--translator-text-sub);
						font: inherit;
						font-size: 14px;
						line-height: 1.55;
						resize: vertical;
						outline: none;
						box-sizing: border-box;
					}
					.translator-policy-editable .translator-policy-body {color: var(--translator-text);}
					.translator-policy-body::-webkit-resizer {background: transparent;}
					/* Webkit-only theming: setting the standard scrollbar-width/-color
					   properties makes Chromium ignore ::-webkit-scrollbar rules and
					   fall back to the native thin scrollbar (the bar users keep seeing). */
					.translator-policy-body::-webkit-scrollbar {width: 6px;}
					.translator-policy-body::-webkit-scrollbar-thumb {
						background: var(--scrollbar-auto-thumb, var(--translator-border));
						border-radius: 3px;
					}
					.translator-policy-body::-webkit-scrollbar-track {background: transparent;}
					.translator-prompt-selector {width: 240px; max-width: 100%;}
					/* ===== backfill dependent block ===== */
					.translator-backfill-switch {margin: 0;}
					.translator-backfill-dependent {
						position: relative;
						margin-left: 10px;
						padding-left: 14px;
						transition: opacity 150ms ease;
					}
					.translator-backfill-dependent::before {
						content: "";
						position: absolute;
						left: 0;
						top: 50%;
						transform: translateY(-50%);
						width: 3px;
						height: 16px;
						border-radius: 2px;
						background: color-mix(in srgb, var(--translator-text) 22%, transparent);
					}
					.translator-backfill-dependent .translator-row-label {font-size: 15px; color: var(--translator-text-sub);}
					.translator-backfill-dependent-disabled {opacity: 0.4; pointer-events: none;}
					/* ===== general page: color swatch pills + live message preview ===== */
					.translator-color-palette {display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px;}
					.translator-color-chip {
						appearance: none;
						position: relative;
						display: inline-flex;
						align-items: center;
						justify-content: center;
						width: 32px;
						height: 32px;
						padding: 0;
						border-radius: 8px;
						border: 1px solid var(--translator-border);
						background: var(--background-secondary-alt, #383a40);
						color: var(--translator-text);
						cursor: pointer;
						transition: background 120ms ease, border-color 120ms ease;
					}
					.translator-color-chip:hover {background: var(--translator-hover); border-color: var(--translator-brand);}
					.translator-color-chip-active {
						background: color-mix(in srgb, var(--translator-brand) 14%, var(--background-secondary-alt, #383a40));
						border-color: var(--translator-brand);
						box-shadow: inset 0 0 0 1px var(--translator-brand);
					}
					.translator-settings-color-swatch {
						width: 16px;
						height: 16px;
						border-radius: 4px;
						border: 1px solid var(--translator-border);
						flex: 0 0 auto;
					}
					.translator-color-chip-code {display: none;}
					.translator-color-chip-add {
						width: 32px;
						height: 32px;
						padding: 0;
						justify-content: center;
						border: 1px solid var(--translator-border);
						border-radius: 8px;
						background: var(--background-secondary-alt, #383a40);
						color: var(--translator-text-sub);
					}
					.translator-color-chip-add svg {width: 14px; height: 14px; display: block;}
					.translator-color-chip-add:hover {background: var(--translator-hover); border-color: color-mix(in srgb, var(--translator-brand) 45%, var(--translator-border)); color: var(--translator-text);}
					.translator-color-chip-delete {
						position: absolute;
						top: 0;
						right: 0;
						width: 15px;
						height: 15px;
						border-radius: 50%;
						display: flex;
						align-items: center;
						justify-content: center;
						background: var(--translator-danger);
						color: #fff;
						font-size: 11px;
						font-weight: 700;
						line-height: 1;
						font-family: inherit;
						box-shadow: 0 0 0 2px var(--translator-bg);
					}
					.translator-color-custom-row {
						display: flex;
						align-items: center;
						gap: 8px;
						margin-top: 8px;
						max-width: 380px;
					}
					.translator-native-color-input {
						width: 34px;
						height: 32px;
						padding: 0;
						border: 1px solid var(--translator-border);
						border-radius: 6px;
						background: transparent;
						cursor: pointer;
						flex: 0 0 auto;
					}
					.translator-color-custom-input {
						flex: 1 1 auto;
						min-width: 0;
						height: 32px;
						box-sizing: border-box;
						padding: 0 10px;
						border: 1px solid var(--translator-input-border);
						border-radius: 6px;
						background: var(--translator-input-bg);
						color: var(--translator-text);
						font: inherit;
						font-size: 14px;
						outline: none;
					}
					.translator-color-custom-input:focus {border-color: var(--translator-brand);}
					.translator-color-preview {
						display: flex;
						gap: 12px;
						padding: 12px 4px 4px;
					}
					.translator-color-preview-avatar {width: 36px; height: 36px; border-radius: 50%; overflow: hidden; flex: 0 0 auto; display: block;}
					.translator-color-preview-avatar svg {width: 100%; height: 100%; display: block;}
					.translator-color-preview-body {flex: 1 1 auto; min-width: 0;}
					.translator-color-preview-head {display: flex; align-items: baseline; gap: 8px;}
					.translator-color-preview-name {color: #8ab4f8; font-size: 14.5px; font-weight: 600;}
					.translator-color-preview-time {color: var(--translator-text-muted); font-size: 11px;}
					.translator-color-preview-original {
						position: relative;
						margin-top: 4px;
						padding-left: 12px;
						color: var(--translator-text-muted);
						font-size: 14px;
					}
					.translator-color-preview-original::before {
						content: "";
						position: absolute;
						left: 0;
						top: 2px;
						bottom: 2px;
						width: 4px;
						border-radius: 2px;
						background: color-mix(in srgb, var(--translator-text) 24%, transparent);
					}
					.translator-color-preview-trans {
						margin-top: 4px;
						padding: 6px 10px 6px 12px;
						border-radius: 6px;
						border-left: 2px solid var(--translator-preview-color, var(--translator-signature));
						background: color-mix(in srgb, var(--translator-preview-color, var(--translator-signature)) 8%, transparent);
					}
					.translator-color-preview-message {color: var(--translator-preview-color, var(--translator-text)); font-size: 14.5px; line-height: 1.45;}
					.translator-color-preview-mark {margin-top: 3px; color: var(--translator-text-muted); font-size: 11.5px;}
					.translator-color-preview-plain .translator-color-preview-message {color: var(--translator-text);}
					.translator-color-preview-plain .translator-color-preview-trans {
						border-left-color: transparent;
						background: transparent;
						padding-left: 0;
					}
					/* ===== advanced page: prefix rows ===== */
					.translator-prefix-translation-row {
						display: grid;
						grid-template-columns: 110px minmax(0, 1fr) 32px;
						gap: 8px;
						align-items: center;
						width: 100%;
						box-sizing: border-box;
						margin-bottom: 8px;
					}
					.translator-prefix-translation-cell,
					.translator-prefix-translation-cell > * {min-width: 0; max-width: 100%; box-sizing: border-box;}
					.translator-prefix-input-cell .translator-input {font-family: var(--font-code, Consolas, "Courier New", monospace); font-size: 13px;}
					.translator-prefix-delete-cell {display: flex; align-items: center; justify-content: flex-end;}
					/* ===== diagnostics page: about card, portals, table ===== */
					.translator-about-card {
						padding: 12px;
						border: 1px solid var(--translator-border);
						border-radius: 8px;
						background: var(--translator-surface);
					}
					.translator-about-identity {display: flex; align-items: center; flex-wrap: wrap; gap: 10px;}
					.translator-about-icon {
						display: flex;
						align-items: center;
						justify-content: center;
						width: 36px;
						height: 36px;
						flex: 0 0 auto;
						border-radius: 8px;
						background: color-mix(in srgb, var(--translator-brand) 18%, transparent);
						color: var(--translator-brand-soft);
					}
					.translator-about-icon svg {width: 22px; height: 22px; display: block; fill: currentColor;}
					.translator-about-copy {min-width: 0; flex: 1 1 160px;}
					.translator-about-name {color: var(--translator-text-strong); font-size: 16px; font-weight: 700;}
					.translator-about-description {color: var(--translator-text-muted); font-size: 13px; line-height: 1.45;}
					.translator-about-release {display: flex; align-items: flex-end; flex-direction: column; gap: 5px; min-width: 0; margin-left: auto;}
					.translator-about-version {
						height: 22px;
						padding: 0 8px;
						border-radius: 11px;
						flex: 0 0 auto;
						background: color-mix(in srgb, var(--translator-brand) 15%, transparent);
						color: var(--translator-brand-soft);
						font-family: var(--font-code, Consolas, "Courier New", monospace);
						font-size: 12px;
						font-weight: 700;
						display: inline-flex;
						align-items: center;
					}
					.translator-about-split {height: 1px; background: var(--translator-border); margin: 12px 0;}
					.translator-about-actions {display: flex; flex-wrap: wrap; gap: 8px;}
					.translator-update-status {margin-top: 10px; font-size: 12.5px; line-height: 1.45; color: var(--translator-text-muted);}
					.translator-update-status-ok {color: var(--translator-ok);}
					.translator-update-status-available {color: var(--translator-signature);}
					.translator-update-status-fail {color: var(--translator-danger);}
					.translator-update-status-neutral {color: var(--translator-text-muted);}
										.translator-diagnostic-table {
						margin-top: 0;
						padding: 2px 12px;
						border: 1px solid var(--translator-border);
						border-radius: 8px;
						background: var(--translator-surface);
					}
					.translator-diagnostic-row {display: flex; align-items: center; gap: 12px; min-height: 34px; padding: 4px 0; box-sizing: border-box;}
					.translator-diagnostic-row + .translator-diagnostic-row {border-top: 1px solid var(--translator-border);}
					.translator-diagnostic-key {
						display: flex;
						align-items: center;
						gap: 6px;
						min-width: 0;
						flex: 1 1 auto;
						overflow: hidden;
						text-overflow: ellipsis;
						white-space: normal;
						color: var(--translator-text);
						font-size: 13px;
						line-height: 1.5;
					}
					.translator-diagnostic-value {
						display: inline-flex;
						align-items: center;
						gap: 6px;
						flex: 0 1 auto;
						min-width: 0;
						max-width: 64%;
						text-align: right;
						justify-content: flex-end;
						overflow-wrap: anywhere;
						color: var(--translator-text-muted);
						font-size: 13px;
						font-weight: 600;
					}
					.translator-diagnostic-value-neutral {font-weight: 400;}
					.translator-diagnostic-value-ok {color: var(--translator-ok);}
					.translator-diagnostic-value-fail {color: var(--translator-danger);}
					.translator-diagnostic-value-ok::before,
					.translator-diagnostic-value-fail::before {content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor;}
					.translator-ai-performance-table .translator-diagnostic-value {min-width: 0; max-width: 68%; justify-content: flex-end; text-align: right; white-space: normal; overflow-wrap: anywhere;}
					@media (max-width: 430px) {
						.translator-ai-performance-table .translator-diagnostic-row {align-items: flex-start; flex-wrap: wrap; gap: 2px 12px; padding: 5px 0;}
						.translator-ai-performance-table .translator-diagnostic-key,
						.translator-ai-performance-table .translator-diagnostic-value {flex: 1 1 100%; max-width: 100%; text-align: left; justify-content: flex-start; white-space: normal;}
					}
					.translator-copy-diagnostics {margin-top: 12px;}
					.translator-diagnostic-technical {margin-top: 12px; border: 1px solid var(--translator-border); border-radius: 8px; background: var(--translator-surface); overflow: hidden;}
					.translator-diagnostic-technical > summary {padding: 12px; color: var(--translator-text-sub); font-size: 13px; font-weight: 600; cursor: pointer;}
					.translator-diagnostic-technical > summary:hover {background: var(--translator-hover);}
					.translator-diagnostic-technical > summary:focus-visible {outline: 2px solid var(--translator-brand); outline-offset: -2px;}
					.translator-diagnostic-technical .translator-diagnostic-table {margin: 0 12px 12px; padding: 0; border: 0; border-radius: 0; background: transparent;}
					.translator-diagnostic-technical .translator-diagnostic-value {flex-shrink: 0;}
					.translator-w2-benchmark {margin-top: 16px; padding: 14px; border: 1px solid var(--translator-border); border-radius: 10px; background: var(--translator-surface);}
					.translator-w2-header {display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;}
					.translator-w2-title {color: var(--translator-text-strong); font-size: 14px; line-height: 20px; font-weight: 700;}
					.translator-w2-description {margin-top: 3px; color: var(--translator-text-muted); font-size: 12px; line-height: 17px;}
					.translator-w2-badge {flex: 0 0 auto; padding: 2px 7px; border-radius: 999px; color: var(--translator-text-muted); background: color-mix(in srgb, var(--translator-text) 8%, transparent); font-size: 11px; line-height: 16px;}
					.translator-w2-badge.is-ready {color: var(--translator-ok); background: color-mix(in srgb, var(--translator-ok) 10%, transparent);}
					.translator-w2-preflight {display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1px 18px; margin-top: 10px;}
					.translator-w2-preflight-row, .translator-w2-result-row {min-height: 28px; display: flex; align-items: center; justify-content: space-between; gap: 10px; border-top: 1px solid color-mix(in srgb, var(--translator-border) 65%, transparent); font-size: 12px; line-height: 17px;}
					.translator-w2-preflight-row > span:first-child, .translator-w2-result-row > span:first-child {color: var(--translator-text); font-weight: 600;}
					.translator-w2-preflight-row > span:last-child, .translator-w2-result-row > span:last-child {min-width: 0; color: var(--translator-text-muted); text-align: right; overflow-wrap: anywhere;}
					.translator-w2-status {display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 10px; color: var(--translator-text-muted); font-size: 12px;}
					.translator-w2-progress {height: 4px; margin-top: 5px; overflow: hidden; border-radius: 2px; background: color-mix(in srgb, var(--translator-text) 12%, transparent);}
					.translator-w2-progress > span {display: block; height: 100%; border-radius: inherit; background: var(--translator-brand);}
					.translator-w2-results {margin-top: 8px;}
					.translator-w2-actions {display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 10px;}
					@media (max-width: 520px) {
						.translator-w2-preflight {grid-template-columns: 1fr;}
						.translator-w2-header {flex-direction: column;}
					}
					/* ===== channel dialog: the same BetterDiscord modal shell as the sibling plugins ===== */
					.translator-channel-confirm {width: 480px !important; max-width: calc(100vw - 32px) !important;}
					.translator-channel-confirm > :last-child {display: none !important;}
					.translator-channel-confirm > div:not(:first-child):not(:last-child) {
						padding: 0 !important;
						margin: 0 !important;
						overflow-x: hidden !important;
						overflow-y: auto !important;
						scrollbar-gutter: auto !important;
					}
					.translator-channel-confirm > :first-child,
					.translator-channel-confirm > :first-child > * {width: 100%;}
					.translator-channel-confirm-header {display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; box-sizing: border-box; padding-right: 12px;}
					.translator-channel-close {
						display: inline-flex;
						align-items: center;
						justify-content: center;
						width: 28px;
						height: 28px;
						margin: -4px 20px -4px auto;
						padding: 0;
						border: 0;
						border-radius: 4px;
						background: transparent;
						color: var(--interactive-normal, #b5bac1);
						cursor: pointer;
					}
					.translator-channel-close:hover {background: var(--translator-hover); color: var(--interactive-hover, #dbdee1);}
					.translator-channel-close:focus-visible,
					.translator-channel-swap:focus-visible,
					.translator-channel-scope-option:focus-visible {outline: none; box-shadow: 0 0 0 2px color-mix(in srgb, var(--translator-brand) 45%, transparent);}
					.translator-channel-close svg {display: block; width: 18px; height: 18px;}
					.translator-channel-settings {
						display: flex;
						flex-direction: column;
						gap: 12px;
						padding: 4px 16px 16px;
						min-width: 0;
						font-size: 15px;
						color: var(--translator-text);
					}
					.translator-channel-zone {overflow: visible; border-radius: 8px; background: var(--translator-surface);}
					.translator-channel-zone-title {
						display: flex;
						align-items: center;
						justify-content: space-between;
						gap: 12px;
						padding: 10px 14px 0;
						color: var(--translator-text-muted);
						font-size: 14px;
						font-weight: 700;
					}
					.translator-channel-zone-heading {display: inline-flex; align-items: center; gap: 5px; min-width: 0;}
					.translator-channel-zone-actions {display: inline-flex; align-items: center; gap: 8px; margin-left: auto; flex: 0 0 auto;}
					.translator-channel-zone-note {padding: 5px 14px 0; color: var(--translator-text-muted); font-size: 13px; line-height: 1.45;}
					.translator-channel-row {display: flex; align-items: center; gap: 14px; padding: 12px 14px; box-sizing: border-box;}
					.translator-channel-row + .translator-channel-row {border-top: 1px solid rgba(255, 255, 255, 0.05);}
					.translator-channel-row-label {
						min-width: 0;
						flex: 1 1 auto;
						display: inline-flex;
						align-items: center;
						gap: 5px;
						color: var(--translator-text);
						font-size: 16px;
						font-weight: 500;
					}
					.translator-channel-settings .translator-search-select-trigger {font-size: 15px;}
					.translator-channel-settings .translator-input {height: 32px; font-size: 15px;}
					.translator-channel-settings .translator-btn {height: 32px; padding: 0 14px; border-radius: 6px; font-size: 14px;}
					/* Language names need more room than provider names in localized UIs. */
					.translator-channel-language-select {width: 210px; max-width: 100%; flex: 0 0 auto;}
					.translator-channel-engine-select {width: 190px; max-width: 100%; flex: 0 0 auto;}
					/* Same anatomy as the strategy page's swap button. */
					.translator-channel-swap {
						appearance: none;
						display: inline-flex;
						align-items: center;
						justify-content: center;
						width: 32px;
						height: 32px;
						padding: 0;
						border: 1px solid var(--translator-border);
						border-radius: 6px;
						background: var(--translator-sunken);
						color: var(--translator-text-sub);
						cursor: pointer;
						flex: 0 0 auto;
					}
					.translator-channel-swap:hover {background: var(--translator-hover); color: var(--translator-text);}
					.translator-channel-swap:disabled {opacity: 0.45; cursor: not-allowed; background: var(--translator-sunken); color: var(--translator-text-muted);}
					.translator-channel-swap svg {width: 14px; height: 14px; display: block;}
					.translator-channel-scope-group {
						position: relative;
						display: inline-grid;
						grid-template-columns: repeat(3, minmax(0, 1fr));
						align-items: center;
						width: 210px;
						max-width: 100%;
						height: 26px;
						padding: 2px;
						box-sizing: border-box;
						border: 1px solid var(--translator-border);
						border-radius: 6px;
						background: var(--translator-sunken);
						overflow: hidden;
						isolation: isolate;
						flex: 0 0 auto;
					}
					.translator-channel-scope-group::before {
						content: "";
						position: absolute;
						z-index: 0;
						top: 3px;
						bottom: 3px;
						left: 3px;
						width: 68px;
						border-radius: 4px;
						background: var(--purple-500, #6d5bd0);
						transition: transform 150ms cubic-bezier(0.2, 0.8, 0.2, 1), background 150ms ease;
					}
					.translator-channel-scope-group:hover::before {background: var(--purple-600, #6552c7);}
					.translator-channel-scope-group[data-scope="guild"]::before {transform: translateX(68px);}
					.translator-channel-scope-group[data-scope="channel"]::before {transform: translateX(136px);}
					.translator-channel-scope-option {
						appearance: none;
						position: relative;
						display: flex;
						align-items: center;
						justify-content: center;
						z-index: 1;
						width: 100%;
						height: 20px;
						padding: 0 5px;
						border: 0;
						border-radius: 4px;
						background: transparent;
						color: var(--translator-text-muted);
						font: inherit;
						font-size: 13px;
						font-weight: 600;
						line-height: 1;
						white-space: nowrap;
						overflow: hidden;
						text-overflow: ellipsis;
						cursor: pointer;
						transition: color 120ms ease, background 120ms ease;
					}
					.translator-channel-scope-option:not([aria-checked="true"]):hover {background: var(--translator-hover); color: var(--translator-text-sub);}
					.translator-channel-scope-option[aria-checked="true"] {background: transparent; color: var(--translator-on-brand);}
					@media (prefers-reduced-motion: reduce) {
						.translator-channel-scope-group::before {transition: none;}
					}
					.translator-channel-language-option {display: flex; align-items: center; gap: 7px; min-width: 0; width: 100%;}
					.translator-channel-language-option-name {min-width: 0; flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;}
					.translator-channel-language-warning {color: var(--translator-danger); font-size: 12px; flex: 0 0 auto;}
					.translator-channel-footnotes {display: flex; flex-direction: column; gap: 2px; padding: 0 2px;}
					.translator-channel-footnote {color: var(--translator-text-muted); font-size: 13px; line-height: 1.5;}
					/* ===== language detector (channel popout zone rows) ===== */
					.translator-detector-panel {min-width: 0;}
					.translator-detector-row {display: flex; align-items: center; gap: 12px; padding: 10px 14px 12px;}
					.translator-detector-row .translator-input {flex: 1 1 auto;}
					.translator-detector-result-row {
						display: flex;
						align-items: center;
						justify-content: space-between;
						gap: 10px;
						padding: 0 14px 11px;
					}
					.translator-detector-result-row .translator-status {margin: 0; flex: 1 1 auto; min-width: 0;}
					/* ===== misc shared bits kept for the panel ===== */
					.translator-settings-inline-actions {display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px;}
					@media (max-width: 620px) {
						.translator-channel-confirm {max-width: calc(100vw - 24px) !important;}
						.translator-channel-settings {padding: 4px 12px 14px;}
						.translator-settings-tab {padding: 0 5px; font-size: 12.5px;}
						.translator-provider-workspace {grid-template-columns: 1fr;}
						.translator-provider-rail {flex-direction: row; flex-wrap: wrap;}
						.translator-provider-group-title {width: 100%;}
						.translator-provider-option {width: auto;}
						.translator-provider-card {align-items: flex-start; flex-wrap: wrap;}
						.translator-provider-card-actions {width: 100%; justify-content: flex-start;}
						.translator-row {flex-wrap: wrap;}
						.translator-dir {flex-wrap: wrap;}
						.translator-prefix-translation-row {grid-template-columns: 110px 32px;}
						.translator-prefix-language-cell {grid-column: 1 / -1;}
						.translator-channel-row {align-items: stretch; flex-wrap: wrap;}
						.translator-channel-language-select,
						.translator-channel-engine-select {width: 100%; min-width: 0; flex: 1 1 100%;}
						.translator-detector-row {flex-wrap: wrap;}
						.translator-detector-row .translator-input {min-width: 160px;}
					}
					@media (max-width: 430px) {
						.translator-channel-zone-title {align-items: flex-start; flex-wrap: wrap;}
						.translator-channel-zone-actions {width: 100%; justify-content: flex-end;}
					}
					/* ===== floating loaded-status capsule (artboard C pill) ===== */
					.translator-loaded-status-floating {
						--translator-signature: #58b9f2;
						position: fixed;
						z-index: 999;
						display: inline-flex;
						align-items: center;
						gap: 6px;
						width: auto !important;
						min-width: 0 !important;
						max-width: min(230px, calc(100vw - 32px));
						padding: 4px 9px;
						border: 1px solid var(--background-modifier-accent, rgba(255,255,255,0.08)) !important;
						border-radius: 999px;
						background: var(--background-floating, #232428) !important;
						box-shadow: var(--shadow-low, 0 1px 3px rgba(0,0,0,0.32)) !important;
						color: var(--text-muted, #b5bac1);
						font-size: 12px;
						font-weight: 500;
						line-height: 16px;
						pointer-events: none;
						backdrop-filter: none;
						text-shadow: none;
					}
					.translator-loaded-status-floating::before,
					.translator-loaded-status-floating::after {
						content: none !important;
						display: none !important;
					}
					.translator-loaded-status-floating.translator-loaded-status-retryable {pointer-events: auto;}
					.translator-loaded-status-icon {
						display: inline-flex;
						width: 14px;
						height: 14px;
						color: var(--interactive-normal, var(--text-muted));
						flex: 0 0 auto;
					}
					.translator-loaded-status-icon > svg {display: block; width: 100%; height: 100%;}
					.translator-loaded-status-collecting .translator-loaded-status-icon,
					.translator-loaded-status-queued .translator-loaded-status-icon,
					.translator-loaded-status-displaying .translator-loaded-status-icon,
					.translator-loaded-status-requesting .translator-loaded-status-icon,
					.translator-loaded-status-committing .translator-loaded-status-icon {color: var(--translator-signature);}
					.translator-loaded-status-repairing .translator-loaded-status-icon {color: var(--status-warning, var(--yellow-300));}
					.translator-loaded-status-done .translator-loaded-status-icon {color: var(--status-positive, var(--green-360));}
					.translator-loaded-status-failed .translator-loaded-status-icon {color: var(--status-danger, var(--red-400));}
					.translator-loaded-status-text {white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; max-width: 100%;}
					.translator-loaded-status-retry {
						appearance: none;
						margin: 0 0 0 2px;
						padding: 0 0 0 7px;
						border: 0;
						border-left: 1px solid var(--background-modifier-accent, rgba(255,255,255,0.12));
						border-radius: 0;
						background: transparent;
						color: var(--interactive-active, #f2f3f5);
						font: inherit;
						font-weight: 600;
						line-height: 16px;
						cursor: pointer;
						width: auto;
						height: auto;
					}
					.translator-loaded-status-retry:hover {color: var(--text-normal, #dbdee1); background: transparent;}
					.translator-loaded-status-inline {
						display: inline-flex;
						align-items: center;
						gap: 6px;
						width: fit-content;
						max-width: 100%;
						margin: 6px 0 10px;
						padding: 4px 9px;
						border: 1px solid var(--background-modifier-accent, rgba(255,255,255,0.08));
						border-radius: 999px;
						background: color-mix(in srgb, var(--background-secondary, #2b2d31) 88%, black 12%);
						color: var(--text-muted, #b5bac1);
						font-size: 12px;
						font-weight: 500;
						line-height: 16px;
						box-sizing: border-box;
					}
					.translator-loaded-status-inline-text {
						white-space: nowrap;
						overflow: hidden;
						text-overflow: ellipsis;
						min-width: 0;
					}
	`;
}

module.exports = {createTranslatorStyles};
