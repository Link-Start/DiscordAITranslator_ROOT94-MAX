const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {createSearchableSelectComponent} = require("../src/ui/searchable-select");

test("settings selects no longer patch the process-wide scrollIntoView prototype", () => {
	const source = fs.readFileSync(path.resolve(__dirname, "..", "src", "ui", "settings-panel.js"), "utf8");
	assert.doesNotMatch(source, /Element\.prototype\.scrollIntoView/);
	assert.doesNotMatch(source, /lockStableSelectScrollIntoView/);
	assert.doesNotMatch(source, /createStableSelect/);
	assert.match(source, /createCustomSelect/);
});

test("the self-drawn select changes values without invoking scrollIntoView", () => {
	let scrollCalls = 0;
	const originalElement = global.Element;
	global.Element = class {
		scrollIntoView() {scrollCalls++;}
	};
	class Component {
		constructor(props) {this.props = props; this.state = {};}
		setState(patch) {this.state = Object.assign({}, this.state, patch);}
	}
	const createElement = (type, props = {}) => ({type, props});
	const Select = createSearchableSelectComponent({Component}, createElement);
	let changed = null;
	try {
		const instance = new Select({value: "a", options: [{value: "a", label: "A"}, {value: "b", label: "B"}], onChange: value => {changed = value;}});
		instance.open();
		assert.equal(instance.state.open, true);
		instance.select({value: "b", label: "B"});
		assert.equal(changed, "b");
		assert.equal(instance.state.open, false);
		assert.equal(scrollCalls, 0);
	}
	finally {global.Element = originalElement;}
});

test("single language selects auto-favorite a chosen option without confusing selection", () => {
	class Component {
		constructor(props) {this.props = props; this.state = {};}
		setState(patch) {this.state = Object.assign({}, this.state, patch);}
	}
	const createElement = (type, props = {}) => ({type, props});
	const Select = createSearchableSelectComponent({Component}, createElement);
	const favorites = [];
	let changed = null;
	const instance = new Select({
		value: "en",
		options: [{value: "en", label: "English"}, {value: "ja", label: "Japanese"}],
		favoriteValues: favorites,
		autoFavoriteOnSelect: true,
		onToggleFavorite: (value, active) => favorites.push([value, active]),
		onChange: value => {changed = value;}
	});
	instance.select({value: "ja", label: "Japanese"});
	assert.equal(changed, "ja");
	assert.deepEqual(favorites, [["ja", true]]);
	assert.deepEqual(instance.state.favoriteValues, ["ja"]);
});
