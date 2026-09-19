let searchableSelectSequence = 0;

// aria-activedescendant keeps focus off the options, so the browser never scrolls
// the highlighted row into view on its own. Plain scrollTop math, so it works the
// same in tests and in Discord.
function scrollActiveOptionIntoView(list, option) {
	if (!list || !option || typeof option.offsetTop != "number") return;
	const top = option.offsetTop;
	const bottom = top + (option.offsetHeight || 0);
	if (typeof list.scrollTop != "number" || typeof list.clientHeight != "number") return;
	if (top < list.scrollTop) list.scrollTop = top;
	else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
}

function normalizeSearchText(value) {
	return String(value || "").trim().toLocaleLowerCase();
}

function filterSearchOptions(options, query) {
	const needle = normalizeSearchText(query);
	if (!needle) return Array.isArray(options) ? options : [];
	return (Array.isArray(options) ? options : []).filter(option =>
		normalizeSearchText(option && option.label).includes(needle)
		|| normalizeSearchText(option && option.value).includes(needle)
		// Extra haystack for localized labels: lets an English query find a
		// language whose visible label is Chinese, and vice versa.
		|| normalizeSearchText(option && option.search).includes(needle)
	);
}

// Multi mode pins the checked options to the top (keeping their relative
// order) so the current selection reads at a glance whenever the list opens.
function orderMultiSelectOptions(options, values) {
	const list = Array.isArray(options) ? options : [];
	const selectedValues = Array.isArray(values) ? values : [];
	if (!selectedValues.length) return list;
	return [...list.filter(option => option && selectedValues.includes(option.value)), ...list.filter(option => !option || !selectedValues.includes(option.value))];
}

// Single language selects keep automatic entries first, then favorites, then the
// remaining locale order. Selection can add a favorite without changing what the
// select reports as its value.
function orderFavoriteOptions(options, favoriteValues) {
	const list = Array.isArray(options) ? options : [];
	const favorites = Array.isArray(favoriteValues) ? favoriteValues : [];
	return [
		...list.filter(option => option && option.pinned),
		...list.filter(option => option && !option.pinned && favorites.includes(option.value)),
		...list.filter(option => !option || !option.pinned && !favorites.includes(option.value))
	];
}

// Fixed-position geometry for a popout portaled to document.body: the list
// escapes the settings modal's scroll container (no clipping, no scrollbar
// growth) and flips upward when the viewport below the trigger is tight.
function computeFixedPopoutPlacement(anchorRect, boundaryRect = null, preferredHeight = 240) {
	const gap = 4;
	const margin = 8;
	const viewportHeight = typeof window != "undefined" && window.innerHeight || 0;
	const viewportWidth = typeof window != "undefined" && window.innerWidth || 0;
	const topEdge = boundaryRect && Number.isFinite(boundaryRect.top) ? Math.max(0, boundaryRect.top) : 0;
	const bottomEdge = boundaryRect && Number.isFinite(boundaryRect.bottom) ? Math.min(viewportHeight, boundaryRect.bottom) : viewportHeight;
	const below = Math.max(0, bottomEdge - anchorRect.bottom - gap - margin);
	const above = Math.max(0, anchorRect.top - gap - margin - topEdge);
	const openUp = below < preferredHeight && above > below;
	const available = openUp ? above : below;
	const width = Math.min(anchorRect.width, Math.max(120, viewportWidth - margin * 2));
	const left = Math.min(Math.max(anchorRect.left, margin), Math.max(margin, viewportWidth - margin - width));
	const style = {left: Math.round(left), width: Math.round(width), maxHeight: Math.max(120, Math.min(300, Math.floor(available)))};
	if (openUp) style.bottom = Math.round(viewportHeight - anchorRect.top + gap);
	else style.top = Math.round(anchorRect.bottom + gap);
	return {openUp, style};
}

// BetterDiscord exposes ReactDOM on BdApi; outside Discord (tests, the static
// preview) the popout falls back to absolute positioning inside the trigger.
function resolvePortalRenderer() {
	try {
		return typeof BdApi != "undefined" && BdApi.ReactDOM && typeof BdApi.ReactDOM.createPortal == "function" && typeof document != "undefined" && document.body ? BdApi.ReactDOM.createPortal : null;
	}
	catch (err) {
		return null;
	}
}

function measureAnchorPlacement(node, boundaryNode = null, preferredHeight = 240) {
	try {
		const rect = node && node.getBoundingClientRect ? node.getBoundingClientRect() : null;
		const boundaryRect = boundaryNode && boundaryNode.getBoundingClientRect ? boundaryNode.getBoundingClientRect() : null;
		return rect ? computeFixedPopoutPlacement(rect, boundaryRect, preferredHeight) : null;
	}
	catch (err) {
		return null;
	}
}

// A fixed popout is placed from one snapshot of its trigger, but the app around it
// can move or scale what that snapshot described afterwards - modal entrance
// animations, pane scrolls whose events die inside nested scrollers, CSS zoom on an
// ancestor. Rather than enumerating causes, this compares where the popout actually
// landed with where the trigger sits now and shifts the style by the visual error;
// repeated once per frame while open, it converges even under an ancestor scale.
function alignFixedPopout(anchorNode, popoutNode, floating) {
	if (!anchorNode || !popoutNode || !floating || !floating.style) return null;
	let anchor = null;
	let actual = null;
	try {
		anchor = anchorNode.getBoundingClientRect ? anchorNode.getBoundingClientRect() : null;
		actual = popoutNode.getBoundingClientRect ? popoutNode.getBoundingClientRect() : null;
	}
	catch (err) {return null;}
	if (!anchor || !actual || !actual.width && !actual.height) return null;
	const want = computeFixedPopoutPlacement(anchor);
	// A flipped direction is a fresh anchor, not a nudge.
	if (want.openUp != floating.openUp) return want;
	const viewportHeight = typeof window != "undefined" && window.innerHeight || 0;
	const deltaX = want.style.left - actual.left;
	const deltaW = want.style.width - actual.width;
	const deltaY = floating.openUp ? want.style.bottom - (viewportHeight - actual.bottom) : want.style.top - actual.top;
	if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1 && Math.abs(deltaW) < 1) return null;
	const style = Object.assign({}, floating.style, {
		left: Math.round(floating.style.left + deltaX),
		width: Math.round(floating.style.width + deltaW),
		maxHeight: want.style.maxHeight
	});
	if (floating.openUp) style.bottom = Math.round(floating.style.bottom + deltaY);
	else style.top = Math.round(floating.style.top + deltaY);
	return {openUp: floating.openUp, style};
}

function createSearchableSelectComponent(React, createElement) {
	if (!React || !React.Component || typeof createElement != "function") throw new TypeError("React component API required");
	return class SearchableSelect extends React.Component {
		constructor(props) {
			super(props);
			this.state = {
				open: false,
				floating: null,
				query: "",
				activeIndex: 0,
				// multi mode keeps the live selection here so toggling stars never
				// forces a full settings-panel refresh (which would close the popout).
				values: Array.isArray(props.values) ? [].concat(props.values) : [],
				favoriteValues: Array.isArray(props.favoriteValues) ? [].concat(props.favoriteValues) : []
			};
			this.root = null;
			this.popout = null;
			this.listboxId = `translator-search-select-${++searchableSelectSequence}`;
			this.onDocumentPointerDown = event => {
				const target = event && event.target;
				if (!target) return;
				if (this.root && this.root.contains(target)) return;
				// The portaled popout lives on document.body, outside the trigger.
				if (this.popout && this.popout.contains(target)) return;
				this.close();
			};
			// The fixed popout must track its trigger while the modal scrolls or
			// the window resizes; closed instances ignore the events.
			this.onReposition = _ => {
				if (this.state.open) this.setState({floating: this.measurePlacement()});
			};
			// While open, the popout re-checks its own landing spot every frame and
			// corrects any drift the event listeners above never got to see.
			this.popoutAlignFrame = null;
			this.onPopoutFrame = _ => {
				this.popoutAlignFrame = null;
				if (!this.state.open) return;
				const aligned = alignFixedPopout(this.root, this.popout, this.state.floating);
				if (aligned) this.setState({floating: aligned});
				this.schedulePopoutAlign();
			};
		}

		componentDidMount() {
			if (typeof document != "undefined") {
				document.addEventListener("mousedown", this.onDocumentPointerDown, true);
				document.addEventListener("scroll", this.onReposition, true);
			}
			if (typeof window != "undefined") window.addEventListener("resize", this.onReposition);
		}

		componentWillUnmount() {
			this.cancelPopoutAlign();
			if (typeof document != "undefined") {
				document.removeEventListener("mousedown", this.onDocumentPointerDown, true);
				document.removeEventListener("scroll", this.onReposition, true);
			}
			if (typeof window != "undefined") window.removeEventListener("resize", this.onReposition);
		}

		componentDidUpdate(prevProps) {
			if (!prevProps.disabled && this.props.disabled && this.state.open) this.close();
			if (this.props.multi) {
				const previous = Array.isArray(prevProps.values) ? prevProps.values : [];
				const next = Array.isArray(this.props.values) ? this.props.values : [];
				if (JSON.stringify(previous) != JSON.stringify(next) && JSON.stringify(next) != JSON.stringify(this.state.values)) this.setState({values: [].concat(next)});
			}
			const previousFavorites = Array.isArray(prevProps.favoriteValues) ? prevProps.favoriteValues : [];
			const nextFavorites = Array.isArray(this.props.favoriteValues) ? this.props.favoriteValues : [];
			if (JSON.stringify(previousFavorites) != JSON.stringify(nextFavorites) && JSON.stringify(nextFavorites) != JSON.stringify(this.state.favoriteValues)) this.setState({favoriteValues: [].concat(nextFavorites)});
		}

		open() {
			if (this.props.disabled) return;
			this.setState({open: true, floating: this.measurePlacement(), query: "", activeIndex: 0});
			this.schedulePopoutAlign();
		}
		close() {
			if (!this.state.open) return;
			this.cancelPopoutAlign();
			this.setState({open: false, floating: null, query: "", activeIndex: 0});
		}

		getPlacementBoundary() {
			if (!this.props.disablePortal || !this.root || typeof this.root.closest != "function") return null;
			try {return this.root.closest('[role="dialog"], .translator-channel-confirm');}
			catch (error) {return null;}
		}

		measurePlacement() {
			return measureAnchorPlacement(this.root, this.getPlacementBoundary(), this.props.disablePortal ? 280 : 240);
		}

		schedulePopoutAlign() {
			if (this.props.disablePortal || this.popoutAlignFrame != null || typeof window == "undefined" || typeof window.requestAnimationFrame != "function") return;
			this.popoutAlignFrame = window.requestAnimationFrame(this.onPopoutFrame);
		}

		cancelPopoutAlign() {
			if (this.popoutAlignFrame != null && typeof window != "undefined" && typeof window.cancelAnimationFrame == "function") window.cancelAnimationFrame(this.popoutAlignFrame);
			this.popoutAlignFrame = null;
		}

		isSelectedValue(value) {
			return this.props.multi ? this.state.values.includes(value) : value == this.props.value;
		}

		isFavoriteValue(value) {return this.state.favoriteValues.includes(value);}

		toggleFavorite(option, event, forcedValue = null) {
			if (this.props.disabled || !option || option.favoriteDisabled) return;
			if (event) {
				event.preventDefault();
				event.stopPropagation();
			}
			const active = forcedValue == null ? !this.isFavoriteValue(option.value) : !!forcedValue;
			const next = active
				? [...this.state.favoriteValues.filter(value => value != option.value), option.value]
				: this.state.favoriteValues.filter(value => value != option.value);
			this.setState({favoriteValues: next});
			if (typeof this.props.onToggleFavorite == "function") this.props.onToggleFavorite(option.value, active, next);
		}

		select(option) {
			if (this.props.disabled || !option || option.disabled) return;
			if (this.props.multi) {
				const nextValues = this.state.values.includes(option.value)
					? this.state.values.filter(value => value != option.value)
					: [].concat(this.state.values, option.value);
				this.setState({values: nextValues});
				if (typeof this.props.onToggle == "function") this.props.onToggle(option.value, nextValues);
				return;
			}
			if (this.props.autoFavoriteOnSelect && !option.favoriteDisabled && !this.isFavoriteValue(option.value)) this.toggleFavorite(option, null, true);
			if (typeof this.props.onChange == "function") this.props.onChange(option.value);
			this.close();
		}

		getTriggerLabel(selected) {
			if (this.props.multi) return typeof this.props.summarize == "function" ? this.props.summarize(this.state.values) : `${this.state.values.length}`;
			return selected ? selected.label : this.props.placeholder || "—";
		}

		render() {
			const disabled = !!this.props.disabled;
			const options = Array.isArray(this.props.options) ? this.props.options : [];
			const favoritesEnabled = Array.isArray(this.props.favoriteValues);
			const ordered = this.props.multi ? orderMultiSelectOptions(options, this.state.values) : favoritesEnabled ? orderFavoriteOptions(options, this.state.favoriteValues) : options;
			const visible = filterSearchOptions(ordered, this.state.query);
			const activeIndex = visible.length ? Math.max(0, Math.min(this.state.activeIndex, visible.length - 1)) : 0;
			const selected = this.props.multi ? null : options.find(option => option.value == this.props.value);
			const handleListKeyDown = event => {
				if (disabled) return;
				if (event.key == "ArrowDown" || event.key == "ArrowUp") {
					event.preventDefault();
					const delta = event.key == "ArrowDown" ? 1 : -1;
					this.setState({activeIndex: visible.length ? (activeIndex + delta + visible.length) % visible.length : 0});
				}
				else if (event.key == "Enter" && visible[activeIndex]) {
					event.preventDefault();
					this.select(visible[activeIndex]);
				}
				else if (event.key == "Home" || event.key == "End") {
					event.preventDefault();
					this.setState({activeIndex: event.key == "Home" ? 0 : Math.max(0, visible.length - 1)});
				}
				else if (event.key == "Escape") {
					event.preventDefault();
					this.close();
					if (this.trigger && typeof this.trigger.focus == "function") this.trigger.focus();
				}
			};
			// The chevron is drawn (Material Symbols path, same glyph as the reference
			// plugin) so the trigger reads as a self-drawn control in every theme.
			const chevron = createElement("svg", {
				viewBox: "0 -960 960 960",
				"aria-hidden": true,
				children: createElement("path", {fill: "currentColor", d: "M480-357q-6 0-11-2t-10-7L261-564q-9-9-9-21t9-21q9-9 21.5-9t21.5 9l176 176 176-176q9-9 21-9t21 9q9 9 9 21.5t-9 21.5L501-366q-5 5-10 7t-11 2Z"})
			});
			// A short list with a search field reads as a much bigger decision than it is.
			// The threshold is the option count at which the field starts earning its place;
			// without one the field always shows, which is the old behaviour.
			const searchThreshold = Number(this.props.searchThreshold);
			const showSearch = !(Number.isFinite(searchThreshold) && options.length < searchThreshold);
			// BetterDiscord's confirmation modal traps focus inside its own DOM tree.
			// Channel-dialog selects opt out of the document.body portal so the visible
			// search box remains a real descendant of that focus trap and accepts typing.
			const renderPortal = this.props.disablePortal ? null : resolvePortalRenderer();
			const fixed = !!(renderPortal && this.state.floating);
			const popout = !disabled && this.state.open ? createElement("div", {
				// translator-settings-ui rides along because the portaled node leaves
				// the settings scope and would otherwise lose the design tokens.
				className: `translator-search-select-popout${fixed ? " translator-search-select-popout-fixed translator-settings-ui" : ""}`,
				style: fixed ? this.state.floating.style : undefined,
				ref: node => {this.popout = node; if (node && !this.props.disablePortal) this.schedulePopoutAlign();},
				children: [
					showSearch ? createElement("input", {
						className: "translator-search-select-input",
						autoFocus: true,
						value: this.state.query,
						placeholder: this.props.searchPlaceholder || "Search",
						"aria-label": this.props.ariaLabelledBy ? undefined : this.props.ariaLabel || this.props.searchPlaceholder || "Search",
						"aria-labelledby": this.props.ariaLabelledBy || undefined,
						"aria-describedby": this.props.ariaDescribedBy || undefined,
						role: "combobox",
						"aria-expanded": true,
						"aria-controls": this.listboxId,
						"aria-activedescendant": visible.length ? `${this.listboxId}-option-${activeIndex}` : undefined,
						onChange: event => this.setState({query: event.target.value, activeIndex: 0}),
						onKeyDown: handleListKeyDown
					}) : null,
					createElement("div", {
						className: "translator-search-select-list",
						id: this.listboxId,
						role: "listbox",
						"aria-multiselectable": this.props.multi ? true : undefined,
						ref: node => {this.listNode = node;},
						children: visible.length ? visible.map((option, index) => {
							const favorite = this.isFavoriteValue(option.value);
							const optionContent = typeof this.props.renderOption == "function" ? this.props.renderOption(option, this.isSelectedValue(option.value)) : option.label;
							return createElement("div", {
							role: "option",
							id: `${this.listboxId}-option-${index}`,
							ref: index == activeIndex ? node => scrollActiveOptionIntoView(this.listNode, node) : undefined,
							tabIndex: -1,
							"aria-selected": this.isSelectedValue(option.value),
							title: option.label,
							className: `translator-search-select-option${index == activeIndex ? " translator-search-select-option-active" : ""}`,
							onMouseDown: event => event.preventDefault(),
							onClick: _ => this.select(option),
							children: favoritesEnabled ? [
								createElement("div", {className: "translator-search-select-option-content", children: optionContent}),
								!option.favoriteDisabled && createElement("button", {
									type: "button",
									className: `translator-search-select-favorite${favorite ? " translator-search-select-favorite-active" : ""}`,
									"aria-label": `${favorite ? this.props.unfavoriteLabel || "Remove favorite" : this.props.favoriteLabel || "Add favorite"}: ${option.label}`,
									title: favorite ? this.props.unfavoriteLabel || "Remove favorite" : this.props.favoriteLabel || "Add favorite",
									onMouseDown: event => {event.preventDefault(); event.stopPropagation();},
									onClick: event => this.toggleFavorite(option, event),
									children: favorite ? "★" : "☆"
								})
							].filter(Boolean) : optionContent
						});
						}) : createElement("div", {className: "translator-search-select-empty", children: this.props.emptyLabel || "No results"})
					})
				]
			}) : null;
			return createElement("div", {
				className: `translator-search-select${disabled ? " translator-search-select-disabled" : ""}${!fixed && this.state.open && this.state.floating && this.state.floating.openUp ? " translator-search-select-up" : ""}${this.props.className ? ` ${this.props.className}` : ""}`,
				ref: node => {this.root = node;},
				children: [
					createElement("button", {
						type: "button",
						disabled,
						className: "translator-search-select-trigger",
						"aria-haspopup": "listbox",
						"aria-label": this.props.ariaLabelledBy ? undefined : this.props.ariaLabel || this.getTriggerLabel(selected),
						"aria-labelledby": this.props.ariaLabelledBy || undefined,
						"aria-describedby": this.props.ariaDescribedBy || undefined,
						"aria-expanded": !disabled && this.state.open,
						"aria-disabled": disabled,
						"aria-controls": this.listboxId,
						ref: node => {this.trigger = node;},
						"aria-activedescendant": !disabled && this.state.open && !showSearch && visible.length ? `${this.listboxId}-option-${activeIndex}` : undefined,
						onClick: _ => !disabled && (this.state.open ? this.close() : this.open()),
						onKeyDown: event => {
							if (disabled) return;
							// With the search field hidden, focus stays on the trigger, so the
							// open list's keyboard lives here as well.
							if (this.state.open) return handleListKeyDown(event);
							if (event.key == "ArrowDown" || event.key == "Enter" || event.key == " ") {
								event.preventDefault();
								this.open();
							}
						},
						children: [
							createElement("span", {className: "translator-search-select-value", title: this.props.triggerTitle || this.getTriggerLabel(selected), children: this.getTriggerLabel(selected)}),
							createElement("span", {className: "translator-search-select-chevron", "aria-hidden": true, children: chevron})
						]
					}),
					popout ? (fixed ? renderPortal(popout, document.body) : popout) : null
				].filter(Boolean)
			});
		}
	};
}

// Model input with a self-drawn drop list (a native datalist renders an
// untheme-able OS floater in Electron, so it is banned here). The input doubles
// as the filter; committed values ride the same deferred writer text fields use;
// the chevron only exists once a catalog has been fetched.
function createModelComboComponent(React, createElement) {
	if (!React || !React.Component || typeof createElement != "function") throw new TypeError("React component API required");
	return class ModelCombo extends React.Component {
		constructor(props) {
			super(props);
			this.state = {
				open: false,
				floating: null,
				value: String(props.value || ""),
				// The filter follows real typing only, so opening via the chevron
				// shows the full list while the chosen model stays in the input.
				query: "",
				activeIndex: 0
			};
			this.root = null;
			this.popout = null;
			this.listboxId = `translator-model-combo-${++searchableSelectSequence}`;
			this.onDocumentPointerDown = event => {
				const target = event && event.target;
				if (!target) return;
				if (this.root && this.root.contains(target)) return;
				if (this.popout && this.popout.contains(target)) return;
				this.close();
			};
			this.onReposition = _ => {
				if (this.state.open) this.setState({floating: measureAnchorPlacement(this.root)});
			};
			// While open, the popout re-checks its own landing spot every frame and
			// corrects any drift the event listeners above never got to see.
			this.popoutAlignFrame = null;
			this.onPopoutFrame = _ => {
				this.popoutAlignFrame = null;
				if (!this.state.open) return;
				const aligned = alignFixedPopout(this.root, this.popout, this.state.floating);
				if (aligned) this.setState({floating: aligned});
				this.schedulePopoutAlign();
			};
		}

		componentDidMount() {
			if (typeof document != "undefined") {
				document.addEventListener("mousedown", this.onDocumentPointerDown, true);
				document.addEventListener("scroll", this.onReposition, true);
			}
			if (typeof window != "undefined") window.addEventListener("resize", this.onReposition);
			this.consumeAutoOpen();
		}

		componentWillUnmount() {
			this.cancelPopoutAlign();
			if (typeof document != "undefined") {
				document.removeEventListener("mousedown", this.onDocumentPointerDown, true);
				document.removeEventListener("scroll", this.onReposition, true);
			}
			if (typeof window != "undefined") window.removeEventListener("resize", this.onReposition);
		}

		componentDidUpdate() {this.consumeAutoOpen();}

		getModels() {return Array.isArray(this.props.models) ? this.props.models : [];}

		// A fetch marks {engine} on plugin state; the first combo render after it
		// pops the list open once so the user sees where the models landed.
		consumeAutoOpen() {
			const signal = this.props.autoOpen;
			if (signal && !signal.consumed && this.getModels().length && !this.state.open) {
				signal.consumed = true;
				this.open();
			}
		}

		open() {
			this.setState({open: true, floating: measureAnchorPlacement(this.root), query: "", activeIndex: 0});
			this.schedulePopoutAlign();
		}
		close() {
			if (!this.state.open) return;
			this.cancelPopoutAlign();
			this.setState({open: false, floating: null, query: "", activeIndex: 0});
		}

		schedulePopoutAlign() {
			if (this.popoutAlignFrame != null || typeof window == "undefined" || typeof window.requestAnimationFrame != "function") return;
			this.popoutAlignFrame = window.requestAnimationFrame(this.onPopoutFrame);
		}

		cancelPopoutAlign() {
			if (this.popoutAlignFrame != null && typeof window != "undefined" && typeof window.cancelAnimationFrame == "function") window.cancelAnimationFrame(this.popoutAlignFrame);
			this.popoutAlignFrame = null;
		}

		select(model) {
			this.setState({value: model, open: false, floating: null, query: "", activeIndex: 0});
			if (typeof this.props.onSelect == "function") this.props.onSelect(model);
		}

		render() {
			const models = this.getModels();
			const needle = normalizeSearchText(this.state.query);
			const visible = needle ? models.filter(model => normalizeSearchText(model).includes(needle)) : models;
			const activeIndex = visible.length ? Math.max(0, Math.min(this.state.activeIndex, visible.length - 1)) : 0;
			const handleKeyDown = event => {
				if (event.key == "ArrowDown" || event.key == "ArrowUp") {
					if (!models.length) return;
					event.preventDefault();
					if (!this.state.open) return this.open();
					const delta = event.key == "ArrowDown" ? 1 : -1;
					this.setState({activeIndex: visible.length ? (activeIndex + delta + visible.length) % visible.length : 0});
				}
				else if ((event.key == "Home" || event.key == "End") && this.state.open) {
					event.preventDefault();
					this.setState({activeIndex: event.key == "Home" ? 0 : Math.max(0, visible.length - 1)});
				}
				else if (event.key == "Enter" && this.state.open && visible[activeIndex]) {
					event.preventDefault();
					this.select(visible[activeIndex]);
				}
				else if (event.key == "Escape" && this.state.open) {
					event.preventDefault();
					this.close();
				}
			};
			const chevron = createElement("svg", {
				viewBox: "0 -960 960 960",
				"aria-hidden": true,
				children: createElement("path", {fill: "currentColor", d: "M480-357q-6 0-11-2t-10-7L261-564q-9-9-9-21t9-21q9-9 21.5-9t21.5 9l176 176 176-176q9-9 21-9t21 9q9 9 9 21.5t-9 21.5L501-366q-5 5-10 7t-11 2Z"})
			});
			const renderPortal = resolvePortalRenderer();
			const fixed = !!(renderPortal && this.state.floating);
			const popout = this.state.open && models.length ? createElement("div", {
				className: `translator-search-select-popout${fixed ? " translator-search-select-popout-fixed translator-settings-ui" : ""}`,
				style: fixed ? this.state.floating.style : undefined,
				ref: node => {this.popout = node; if (node) this.schedulePopoutAlign();},
				children: createElement("div", {
					className: "translator-search-select-list",
					id: this.listboxId,
					role: "listbox",
					ref: node => {this.listNode = node;},
					children: visible.length ? visible.map((model, index) => createElement("div", {
						role: "option",
						id: `${this.listboxId}-option-${index}`,
						ref: index == activeIndex ? node => scrollActiveOptionIntoView(this.listNode, node) : undefined,
						title: model,
						"aria-selected": model == this.state.value,
						className: `translator-search-select-option${index == activeIndex ? " translator-search-select-option-active" : ""}`,
						onMouseDown: event => event.preventDefault(),
						onClick: _ => this.select(model),
						children: model
					})) : createElement("div", {className: "translator-search-select-empty", children: this.props.emptyLabel || "No results"})
				})
			}) : null;
			return createElement("div", {
				className: `translator-model-combo${models.length ? " translator-model-combo-has-models" : ""}${!fixed && this.state.open && this.state.floating && this.state.floating.openUp ? " translator-search-select-up" : ""}`,
				ref: node => {this.root = node;},
				children: [
					createElement("input", {
						type: "text",
						className: "translator-input",
						role: "combobox",
						"aria-label": this.props.ariaLabel,
						"aria-expanded": this.state.open,
						"aria-controls": this.listboxId,
						"aria-autocomplete": "list",
						"aria-activedescendant": this.state.open && visible.length ? `${this.listboxId}-option-${activeIndex}` : undefined,
						spellCheck: false,
						placeholder: this.props.placeholder,
						value: this.state.value,
						onChange: event => {
							const next = event.target.value;
							this.setState({value: next, query: next, activeIndex: 0, open: models.length ? true : this.state.open, floating: models.length && !this.state.open ? measureAnchorPlacement(this.root) : this.state.floating});
							if (typeof this.props.onChange == "function") this.props.onChange(next);
						},
						onKeyDown: handleKeyDown,
						onBlur: this.props.onBlur || undefined
					}),
					models.length ? createElement("button", {
						type: "button",
						className: "translator-combo-chevron",
						"aria-label": this.props.openLabel || "Open the model list",
						"aria-expanded": this.state.open,
						title: this.props.openLabel || undefined,
						onMouseDown: event => event.preventDefault(),
						onClick: _ => this.state.open ? this.close() : this.open(),
						children: chevron
					}) : null,
					popout ? (fixed ? renderPortal(popout, document.body) : popout) : null
				].filter(Boolean)
			});
		}
	};
}

module.exports = {scrollActiveOptionIntoView, normalizeSearchText, filterSearchOptions, orderMultiSelectOptions, orderFavoriteOptions, computeFixedPopoutPlacement, alignFixedPopout, createSearchableSelectComponent, createModelComboComponent};
