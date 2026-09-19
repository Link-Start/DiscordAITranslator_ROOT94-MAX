const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {translationEngines, enginePortals, createProviderClient} = require("../src/providers/provider-client");

const root = path.resolve(__dirname, "..");

test("retired iTranslate and legacy Yandex providers leave no selectable or callable adapter", () => {
	const client = createProviderClient({request: () => {}});
	for (const engineKey of ["itranslate", "yandex"]) {
		assert.equal(translationEngines[engineKey], undefined, `${engineKey} is absent from the provider catalog`);
		assert.equal(enginePortals[engineKey], undefined, `${engineKey} has no settings portal`);
	}
	assert.equal(client.iTranslateTranslate, undefined);
	assert.equal(client.yandexTranslate, undefined);
});

test("retired provider code and documentation are removed rather than hidden", () => {
	const providerSource = fs.readFileSync(path.join(root, "src", "providers", "provider-client.js"), "utf8");
	const runtimeSource = fs.readFileSync(path.join(root, "src", "legacy", "runtime.js"), "utf8");
	const publicDocs = ["README.md", path.join("docs", "providers.md")]
		.map(file => fs.readFileSync(path.join(root, file), "utf8"))
		.join("\n");

	for (const retiredToken of ["iTranslateTranslate", "yandexTranslate", "web-api.itranslateapp.com", "translate.yandex.net/api/v1.5"]) {
		assert.doesNotMatch(providerSource + runtimeSource, new RegExp(retiredToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
	}
	assert.doesNotMatch(publicDocs, /itranslate|yandex/i);
});
