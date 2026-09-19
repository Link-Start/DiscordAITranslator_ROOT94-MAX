const test = require("node:test");
const assert = require("node:assert/strict");
const {findSettingsHostModal, getSettingsDoneLabel, localizeSettingsHostModal} = require("../../src/ui/settings-host-modal");

// A minimal stand-in for the BetterDiscord addon settings modal DOM: the modal frame,
// a footer with Discord's button (caption inside a nested contents div) and our panel
// root with its own buttons somewhere inside the content area.
function createNode(tag, className = "", text = null) {
	const node = {
		tagName: tag.toUpperCase(),
		className,
		parentElement: null,
		children: [],
		_text: text,
		get textContent() {return this._text != null ? this._text : this.children.map(child => child.textContent).join("");},
		set textContent(value) {this._text = String(value); this.children = [];},
		append(...nodes) {for (const child of nodes) {child.parentElement = this; this.children.push(child);} return this;},
		descendants() {return this.children.flatMap(child => [child, ...child.descendants()]);},
		querySelectorAll(selector) {
			const all = this.descendants();
			if (selector == "*") return all;
			return all.filter(node => node.tagName == String(selector).toUpperCase());
		},
		contains(other) {return other == this || this.descendants().includes(other);}
	};
	return node;
}

function createHostFixture({doneLabel = "完成", panelButton = "验证当前配置"} = {}) {
	const modal = createNode("div", "bd-addon-modal focusLock");
	const header = createNode("h1", "header", "DiscordAITranslator Settings");
	const content = createNode("div", "content");
	const wrap = createNode("div", "bd-addon-settings-wrap");
	const root = createNode("div", "translator-settings-panel-root translator-settings-ui");
	const ownButton = createNode("button", "translator-button").append(createNode("div", "contents", panelButton));
	root.append(ownButton);
	wrap.append(root);
	content.append(wrap);
	const footer = createNode("div", "footer");
	const caption = createNode("div", "contents_a1b2", doneLabel);
	const doneButton = createNode("button", "button_c3d4 lookFilled").append(caption);
	footer.append(doneButton);
	modal.append(header, content, footer);
	return {modal, header, root, footer, doneButton, caption, ownButton};
}

test("the host title follows the effective plugin language, including follow Discord", () => {
	const fixture = createHostFixture();
	localizeSettingsHostModal(fixture.root, "zh-CN", {followsDiscord: true});
	assert.equal(fixture.header.textContent, "DiscordAITranslator 设置");
	localizeSettingsHostModal(fixture.root, "ru");
	assert.equal(fixture.header.textContent, "DiscordAITranslator — Настройки");
	localizeSettingsHostModal(fixture.root, "en");
	assert.equal(fixture.header.textContent, "DiscordAITranslator Settings");
	fixture.header.textContent = "AnotherPlugin Settings";
	localizeSettingsHostModal(fixture.root, "zh-CN");
	assert.equal(fixture.header.textContent, "AnotherPlugin Settings", "unrelated host content is untouched");
});

test("getSettingsDoneLabel knows the plugin interface languages and nothing else", () => {
	assert.equal(getSettingsDoneLabel("zh-CN"), "完成");
	assert.equal(getSettingsDoneLabel("en"), "Done");
	assert.equal(getSettingsDoneLabel("ru"), "Готово");
	assert.equal(getSettingsDoneLabel("de"), null);
	assert.equal(getSettingsDoneLabel(null), null);
});

test("an English plugin language relabels BetterDiscord's Chinese Done button inside its caption element", () => {
	const fixture = createHostFixture({doneLabel: "完成"});
	assert.equal(findSettingsHostModal(fixture.root), fixture.modal);
	assert.equal(localizeSettingsHostModal(fixture.root, "en"), true);
	assert.equal(fixture.caption.textContent, "Done", "the nested caption carries the label");
	assert.equal(fixture.doneButton.className, "button_c3d4 lookFilled", "the button itself is untouched");
	assert.equal(fixture.doneButton.children.length, 1, "the button keeps its contents element");
	assert.equal(fixture.ownButton.textContent, "验证当前配置", "buttons inside the panel are never touched");
	assert.equal(localizeSettingsHostModal(fixture.root, "en"), true, "re-running after a refresh is a no-op that still reports the label as applied");
	assert.equal(fixture.caption.textContent, "Done");
});

test("a Chinese plugin language relabels an English host button and Russian gets its own word", () => {
	const chinese = createHostFixture({doneLabel: "Done"});
	assert.equal(localizeSettingsHostModal(chinese.root, "zh-CN"), true);
	assert.equal(chinese.caption.textContent, "完成");
	const russian = createHostFixture({doneLabel: "Done"});
	assert.equal(localizeSettingsHostModal(russian.root, "ru"), true);
	assert.equal(russian.caption.textContent, "Готово");
});

test("switching back to follow Discord while the modal is open restores BetterDiscord's original caption", () => {
	const fixture = createHostFixture({doneLabel: "完成"});
	assert.equal(localizeSettingsHostModal(fixture.root, "en"), true);
	assert.equal(localizeSettingsHostModal(fixture.root, "ru"), true, "a second pinned language relabels again");
	assert.equal(fixture.caption.textContent, "Готово");
	assert.equal(localizeSettingsHostModal(fixture.root, "ru", {followsDiscord: true}), false);
	assert.equal(fixture.caption.textContent, "完成", "the first remembered label comes back, not an intermediate one");
	assert.equal(localizeSettingsHostModal(fixture.root, "ru", {followsDiscord: true}), false, "restoring twice is harmless");
	assert.equal(fixture.caption.textContent, "完成");
});

test("following Discord from the start, an unknown caption, a missing host modal or an unknown language leave the DOM alone", () => {
	const follows = createHostFixture({doneLabel: "完成"});
	assert.equal(localizeSettingsHostModal(follows.root, "en", {followsDiscord: true}), false);
	assert.equal(follows.caption.textContent, "完成");

	const unknownCaption = createHostFixture({doneLabel: "Delete"});
	assert.equal(localizeSettingsHostModal(unknownCaption.root, "en"), false);
	assert.equal(unknownCaption.caption.textContent, "Delete");

	const detached = createNode("div", "translator-settings-panel-root");
	assert.equal(findSettingsHostModal(detached), null);
	assert.equal(localizeSettingsHostModal(detached, "en"), false);
	assert.equal(localizeSettingsHostModal(null, "en"), false);

	const german = createHostFixture({doneLabel: "完成"});
	assert.equal(localizeSettingsHostModal(german.root, "de"), false, "no plugin word for this language, so BetterDiscord's stays");
	assert.equal(german.caption.textContent, "完成");
});

test("every BetterDiscord Done translation is recognised so the relabel works whatever Discord's language is", () => {
	for (const hostLabel of ["Done", "Готово", "Fertig", "Terminé", "Hecho", "Feito", "Fatto", "Dokončiť", "Hotovo", "Kész", "Gata", "Bitti", "Valmis", "Xong", "Ολοκληρώθηκε", "완료", "Potwierdź"]) {
		const fixture = createHostFixture({doneLabel: hostLabel});
		assert.equal(localizeSettingsHostModal(fixture.root, "zh-CN"), true, hostLabel);
		assert.equal(fixture.caption.textContent, "完成", hostLabel);
	}
});
