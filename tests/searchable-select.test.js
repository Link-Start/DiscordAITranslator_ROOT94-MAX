const test = require("node:test");
const assert = require("node:assert/strict");
const {filterSearchOptions, orderFavoriteOptions, createSearchableSelectComponent, createModelComboComponent} = require("../src/ui/searchable-select");

const options = [
	{value: "en", label: "English"},
	{value: "zh-CN", label: "中文（简体）"},
	{value: "ja", label: "日本語"}
];

test("searchable select filters by localized label or language code", () => {
	assert.deepEqual(filterSearchOptions(options, "eng"), [options[0]]);
	assert.deepEqual(filterSearchOptions(options, "ZH-cn"), [options[1]]);
	assert.deepEqual(filterSearchOptions(options, "日本"), [options[2]]);
	assert.equal(filterSearchOptions(options, "missing").length, 0);
});

test("an empty query preserves the original option order", () => {
	assert.equal(filterSearchOptions(options, ""), options);
});

test("pinned entries stay first and favorite languages follow before the rest", () => {
	const auto = {value: "auto", label: "Detect", pinned: true, favoriteDisabled: true};
	const list = [options[0], auto, options[1], options[2]];
	assert.deepEqual(orderFavoriteOptions(list, ["ja", "en"]), [auto, options[0], options[2], options[1]]);
});

test("disabled searchable select cannot open select or toggle favorites", () => {
	class Component {
		constructor(props) {this.props = props; this.state = {};}
		setState(update) {this.state = Object.assign({}, this.state, update);}
	}
	const createElement = (type, props) => ({type, props: props || {}});
	const Select = createSearchableSelectComponent({Component}, createElement);
	const changes = [];
	const favorites = [];
	const instance = new Select({disabled: true, options, value: "en", favoriteValues: [], onChange: value => changes.push(value), onToggleFavorite: value => favorites.push(value)});
	instance.open();
	assert.equal(instance.state.open, false);
	instance.select(options[1]);
	instance.toggleFavorite(options[1]);
	assert.deepEqual(changes, []);
	assert.deepEqual(favorites, []);
	const tree = instance.render();
	const trigger = tree.props.children[0];
	assert.equal(trigger.props.disabled, true);
	assert.equal(trigger.props["aria-disabled"], true);
	assert.equal(trigger.props["aria-expanded"], false);
	trigger.props.onClick();
	assert.equal(instance.state.open, false);
});

test("searchable select closes when it becomes disabled", () => {
	class Component {
		constructor(props) {this.props = props; this.state = {};}
		setState(update) {this.state = Object.assign({}, this.state, update);}
	}
	const Select = createSearchableSelectComponent({Component}, (type, props) => ({type, props}));
	const instance = new Select({disabled: false, options, value: "en"});
	instance.open();
	assert.equal(instance.state.open, true);
	const previous = instance.props;
	instance.props = Object.assign({}, instance.props, {disabled: true});
	instance.componentDidUpdate(previous);
	assert.equal(instance.state.open, false);
});

test("a short trigger label can carry a longer explanatory title", () => {
	class Component {
		constructor(props) {this.props = props; this.state = {};}
		setState(update) {this.state = Object.assign({}, this.state, update);}
	}
	const found = [];
	const collect = node => {
		if (!node || typeof node != "object") return;
		if (Array.isArray(node)) return node.forEach(collect);
		if (node.props && node.props.className === "translator-search-select-value") found.push(node.props);
		if (node.props) collect(node.props.children);
	};
	const Select = createSearchableSelectComponent({Component}, (type, props) => ({type, props}));
	const options = [{value: "openai_chat", label: "OpenAI Chat"}];
	const withTitle = new Select({options, value: "openai_chat", triggerTitle: "OpenAI Chat Completions"});
	collect(withTitle.render());
	assert.equal(found[0].children, "OpenAI Chat", "the trigger stays short");
	assert.equal(found[0].title, "OpenAI Chat Completions", "the full name is available on hover");
	const plain = new Select({options, value: "openai_chat"});
	found.length = 0;
	collect(plain.render());
	assert.equal(found[0].title, "OpenAI Chat", "without an explicit title the label is reused");
});

test("a searchable select exposes its visible field label from both focus hosts", () => {
	class Component {
		constructor(props) {this.props = props; this.state = {};}
		setState(update) {this.state = Object.assign({}, this.state, update);}
	}
	const createElement = (type, props) => ({type, props: props || {}});
	const walk = (node, out = []) => {
		if (!node) return out;
		if (Array.isArray(node)) {node.forEach(child => walk(child, out)); return out;}
		if (typeof node != "object") return out;
		out.push(node);
		walk(node.props && node.props.children, out);
		return out;
	};
	const Select = createSearchableSelectComponent({Component}, createElement);
	const instance = new Select({options, value: "en", ariaLabelledBy: "sent-source-label", searchThreshold: 2, searchPlaceholder: "Search language"});
	instance.state = {open: true, query: "", activeIndex: 0, favoriteValues: []};
	const nodes = walk(instance.render());
	const trigger = nodes.find(node => node.props && node.props["aria-haspopup"] == "listbox");
	const search = nodes.find(node => node.type == "input");
	assert.equal(trigger.props["aria-labelledby"], "sent-source-label");
	assert.equal(trigger.props["aria-label"], undefined);
	assert.equal(search.props["aria-labelledby"], "sent-source-label");
	assert.equal(search.props["aria-label"], undefined);
});

test("a modal-owned searchable select keeps its search input inside the focus trap", () => {
	const {Component, createElement, walk} = renderHarness();
	const Select = createSearchableSelectComponent({Component}, createElement);
	const hadBdApi = Object.prototype.hasOwnProperty.call(global, "BdApi");
	const previousBdApi = global.BdApi;
	const hadDocument = Object.prototype.hasOwnProperty.call(global, "document");
	const previousDocument = global.document;
	let portalCalls = 0;
	global.BdApi = {ReactDOM: {createPortal: node => {portalCalls++; return {type: "portal", props: {children: node}};}}};
	global.document = {body: {}};
	try {
		const local = new Select({options, value: "en", disablePortal: true, searchPlaceholder: "Search language", onChange: () => {}});
		local.state = {open: true, query: "", activeIndex: 0, favoriteValues: [], floating: {openUp: false, style: {top: 40, left: 20, width: 200}}};
		const localNodes = walk(local.render());
		assert.equal(portalCalls, 0, "the focus-trapped modal never sends its input to document.body");
		assert.ok(localNodes.find(node => node.type == "input"));
		assert.equal(localNodes.some(node => node.props && /translator-search-select-popout-fixed/.test(node.props.className || "")), false);

		const globalSelect = new Select({options, value: "en", searchPlaceholder: "Search language", onChange: () => {}});
		globalSelect.state = {open: true, query: "", activeIndex: 0, favoriteValues: [], floating: {openUp: false, style: {top: 40, left: 20, width: 200}}};
		globalSelect.render();
		assert.equal(portalCalls, 1, "other settings surfaces retain the unclipped body portal");
	}
	finally {
		if (hadBdApi) global.BdApi = previousBdApi;
		else delete global.BdApi;
		if (hadDocument) global.document = previousDocument;
		else delete global.document;
	}
});

// --- T5: component-level behaviour the panel relies on (no prop-existence proxies) ---

function renderHarness() {
	class Component {
		constructor(props) {this.props = props; this.state = {};}
		setState(update) {this.state = Object.assign({}, this.state, update);}
	}
	const createElement = (type, props) => ({type, props: props || {}});
	const walk = (node, out = []) => {
		if (!node) return out;
		if (Array.isArray(node)) {node.forEach(child => walk(child, out)); return out;}
		if (typeof node != "object") return out;
		out.push(node);
		walk(node.props && node.props.children, out);
		return out;
	};
	return {Component, createElement, walk};
}

test("T5 a list under the search threshold renders no search input, a longer one does", () => {
	const {Component, createElement, walk} = renderHarness();
	const Select = createSearchableSelectComponent({Component}, createElement);
	const short = new Select({options, value: "en", searchThreshold: 8, onChange: () => {}});
	short.state = {open: true, query: "", activeIndex: 0, favoriteValues: []};
	assert.equal(walk(short.render()).filter(node => node.type == "input").length, 0, "three options need no search field");

	const long = new Select({options: Array.from({length: 12}, (_, i) => ({value: String(i), label: `Option ${i}`})), value: "0", searchThreshold: 8, onChange: () => {}});
	long.state = {open: true, query: "", activeIndex: 0, favoriteValues: []};
	assert.equal(walk(long.render()).filter(node => node.type == "input").length, 1, "twelve options do");

	const unset = new Select({options, value: "en", onChange: () => {}});
	unset.state = {open: true, query: "", activeIndex: 0, favoriteValues: []};
	assert.equal(walk(unset.render()).filter(node => node.type == "input").length, 1, "no threshold keeps the old always-searchable behaviour");
});

test("T5 both list components support Home and End and announce the active option from the focus host", () => {
	const {Component, createElement, walk} = renderHarness();
	const Select = createSearchableSelectComponent({Component}, createElement);
	const select = new Select({options, value: "en", searchThreshold: 8, onChange: () => {}});
	select.state = {open: true, query: "", activeIndex: 1, favoriteValues: []};
	let nodes = walk(select.render());
	// the reader hears the active option from the element that actually holds focus:
	// the trigger on a short list, never the unfocused listbox
	const trigger = nodes.find(node => node.props && node.props["aria-haspopup"] == "listbox");
	assert.equal(trigger.props["aria-activedescendant"], `${select.listboxId}-option-1`);
	const listbox = nodes.find(node => node.props && node.props.role == "listbox");
	assert.equal(listbox.props["aria-activedescendant"], undefined, "the listbox itself is not the focus host");
	assert.equal(nodes.filter(node => node.props && node.props.role == "option").every(node => typeof node.props.id == "string" && node.props.id), true, "every option is addressable");

	const fire = key => trigger.props.onKeyDown({key, preventDefault: () => {}});
	fire("End");
	assert.equal(select.state.activeIndex, options.length - 1);
	fire("Home");
	assert.equal(select.state.activeIndex, 0);

	// on a long list the search input holds focus, so it carries the announcement
	const long = new Select({options: Array.from({length: 12}, (_, i) => ({value: String(i), label: `Option ${i}`})), value: "0", searchThreshold: 8, onChange: () => {}});
	long.state = {open: true, query: "", activeIndex: 3, favoriteValues: []};
	nodes = walk(long.render());
	const search = nodes.find(node => node.type == "input");
	assert.equal(search.props["aria-activedescendant"], `${long.listboxId}-option-3`);

	// Escape from the search input closes the list and hands focus back to the trigger
	let focused = 0;
	const longTrigger = nodes.find(node => node.props && node.props["aria-haspopup"] == "listbox");
	longTrigger.props.ref({focus: () => {focused++;}});
	search.props.onKeyDown({key: "Escape", preventDefault: () => {}});
	assert.equal(long.state.open, false);
	assert.equal(focused, 1, "focus returns to the trigger instead of being dropped");

	const Combo = createModelComboComponent({Component}, createElement);
	const combo = new Combo({models: ["alpha", "beta", "gamma"], value: "", ariaLabel: "模型", onChange: () => {}});
	combo.state = {open: true, value: "", activeIndex: 1};
	nodes = walk(combo.render());
	const comboInput = nodes.find(node => node.props && node.props.role == "combobox");
	assert.equal(comboInput.props["aria-label"], "模型", "the model field keeps its localized accessible name");
	assert.equal(comboInput.props["aria-activedescendant"], `${combo.listboxId}-option-1`, "the combobox input is the focus host");
	assert.equal(nodes.find(node => node.props && node.props.role == "listbox").props["aria-activedescendant"], undefined);
	comboInput.props.onKeyDown({key: "End", preventDefault: () => {}});
	assert.equal(combo.state.activeIndex, 2);
	comboInput.props.onKeyDown({key: "Home", preventDefault: () => {}});
	assert.equal(combo.state.activeIndex, 0);
});

test("T5 keyboard navigation keeps the active option inside the list viewport", () => {
	const {Component, createElement, walk} = renderHarness();
	// the pure calculation both components delegate to
	const {scrollActiveOptionIntoView} = require("../src/ui/searchable-select");
	const list = {scrollTop: 0, clientHeight: 100};
	scrollActiveOptionIntoView(list, {offsetTop: 180, offsetHeight: 30});
	assert.equal(list.scrollTop, 110, "an option below the viewport scrolls up just enough");
	scrollActiveOptionIntoView(list, {offsetTop: 40, offsetHeight: 30});
	assert.equal(list.scrollTop, 40, "an option above scrolls down to its top");
	scrollActiveOptionIntoView(list, {offsetTop: 60, offsetHeight: 30});
	assert.equal(list.scrollTop, 40, "a visible option does not move the list");
	scrollActiveOptionIntoView(null, {offsetTop: 0, offsetHeight: 10});
	scrollActiveOptionIntoView(list, null);

	// and both components wire it: navigating past the viewport keeps the row visible
	const Select = createSearchableSelectComponent({Component}, createElement);
	const select = new Select({options: Array.from({length: 10}, (_, i) => ({value: String(i), label: `Option ${i}`})), value: "0", searchThreshold: 20, onChange: () => {}});
	select.state = {open: true, query: "", activeIndex: 9, favoriteValues: []};
	let nodes = walk(select.render());
	const fakeList = {scrollTop: 0, clientHeight: 96};
	nodes.find(node => node.props && node.props.role == "listbox").props.ref(fakeList);
	const active = nodes.find(node => node.props && node.props.role == "option" && node.props.ref);
	active.props.ref({offsetTop: 288, offsetHeight: 32});
	assert.equal(fakeList.scrollTop, 224, "the tenth row lands inside a 96px viewport");

	const Combo = createModelComboComponent({Component}, createElement);
	const combo = new Combo({models: Array.from({length: 10}, (_, i) => `model-${i}`), value: "", onChange: () => {}});
	combo.state = {open: true, value: "", activeIndex: 9};
	nodes = walk(combo.render());
	const comboList = {scrollTop: 0, clientHeight: 96};
	nodes.find(node => node.props && node.props.role == "listbox").props.ref(comboList);
	const comboActive = nodes.find(node => node.props && node.props.role == "option" && node.props.ref);
	comboActive.props.ref({offsetTop: 288, offsetHeight: 32});
	assert.equal(comboList.scrollTop, 224);
});

test("an open fixed popout realigns itself to the trigger it drifted from", () => {
	const {computeFixedPopoutPlacement, alignFixedPopout} = require("../src/ui/searchable-select");
	const hadWindow = Object.prototype.hasOwnProperty.call(global, "window");
	const previousWindow = global.window;
	global.window = {innerWidth: 1920, innerHeight: 1040};
	try {
		const anchorRect = {left: 213, top: 406, right: 434, bottom: 442, width: 221, height: 36};
		const floating = computeFixedPopoutPlacement(anchorRect);
		assert.equal(floating.openUp, false);
		assert.equal(floating.style.top, 446, "the intended spot is right under the trigger");
		assert.equal(floating.style.left, 213);
		assert.equal(floating.style.width, 221);
		// the popout landed lower, right and narrower than its style said (an ancestor
		// moved or scaled it after measuring); the alignment shifts the style by the error
		const anchorNode = {getBoundingClientRect: () => anchorRect};
		const drifted = {getBoundingClientRect: () => ({left: 220, top: 490, right: 429, bottom: 785, width: 209, height: 295})};
		const aligned = alignFixedPopout(anchorNode, drifted, floating);
		assert.equal(aligned.style.top, 402, "44px of drift comes straight back off the top");
		assert.equal(aligned.style.left, 206);
		assert.equal(aligned.style.width, 233);
		// once anchor and popout agree the alignment reports nothing to change
		const settled = {getBoundingClientRect: () => ({left: 213, top: 446, right: 434, bottom: 746, width: 221, height: 300})};
		assert.equal(alignFixedPopout(anchorNode, settled, computeFixedPopoutPlacement(anchorRect)), null);
		// a missing node or an unmeasurable popout never produces a phantom nudge
		assert.equal(alignFixedPopout(null, drifted, floating), null);
		assert.equal(alignFixedPopout(anchorNode, {getBoundingClientRect: () => ({left: 0, top: 0, width: 0, height: 0})}, floating), null);
	}
	finally {
		if (hadWindow) global.window = previousWindow;
		else delete global.window;
	}
});

test("a modal-owned search flips upward before the modal scroll boundary clips it", () => {
	const {computeFixedPopoutPlacement} = require("../src/ui/searchable-select");
	const hadWindow = Object.prototype.hasOwnProperty.call(global, "window");
	const previousWindow = global.window;
	global.window = {innerWidth: 534, innerHeight: 704};
	try {
		const anchor = {left: 263, right: 471, top: 382, bottom: 414, width: 208, height: 32};
		const modal = {left: 29, right: 510, top: 31, bottom: 670, width: 481, height: 639};
		assert.equal(computeFixedPopoutPlacement(anchor, null, 240).openUp, false, "the old viewport-only threshold incorrectly chooses down");
		assert.equal(computeFixedPopoutPlacement(anchor, modal, 280).openUp, true, "the modal boundary chooses the available space above");

		const {Component, createElement} = renderHarness();
		const Select = createSearchableSelectComponent({Component}, createElement);
		const instance = new Select({options: Array.from({length: 20}, (_, index) => ({value: String(index), label: `Language ${index}`})), value: "0", disablePortal: true});
		instance.root = {
			getBoundingClientRect: () => anchor,
			closest: selector => selector == '[role="dialog"], .translator-channel-confirm' ? {getBoundingClientRect: () => modal} : null
		};
		instance.open();
		assert.equal(instance.state.floating.openUp, true);
	}
	finally {
		if (hadWindow) global.window = previousWindow;
		else delete global.window;
	}
});
