const test = require("node:test");
const assert = require("node:assert/strict");
const {normalizeVersion, compareVersions, checkForUpdate, UPDATE_API_URL, UPDATE_LATEST_URL} = require("../src/updates/update-checker");

test("update version comparison handles stable and prerelease versions", () => {
	assert.equal(normalizeVersion("v1.2.3+build"), "1.2.3");
	assert.equal(compareVersions("1.2.3", "1.2.4"), -1);
	assert.equal(compareVersions("1.2.3", "1.2.3-beta"), 1);
	assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
});

test("update checking is read-only and returns release metadata", async () => {
	const calls = [];
	const result = await checkForUpdate({
		currentVersion: "0.3.41",
		fetch: async (url, init) => {
			calls.push({url, init});
			return {ok: true, status: 200, json: async () => ({tag_name: "v0.4.0", html_url: "https://github.com/ROOT94-MAX/DiscordAITranslator/releases/tag/v0.4.0", body: "notes"})};
		}
	});
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, UPDATE_API_URL);
	assert.equal(calls[0].init.method, "GET");
	assert.equal(calls[0].init.headers["User-Agent"], "DiscordAITranslator/0.3.41");
	assert.equal(result.status, "available");
	assert.equal(result.latest, "0.4.0");
	assert.equal(Object.prototype.hasOwnProperty.call(result, "asset"), false);
});

test("a GitHub API 403 falls back to the public latest-release redirect", async () => {
	const calls = [];
	const result = await checkForUpdate({
		currentVersion: "0.3.41",
		fetch: async (url, init) => {
			calls.push({url, init});
			if (url == UPDATE_API_URL) return {ok: false, status: 403};
			return {ok: true, status: 200, url: "https://github.com/ROOT94-MAX/DiscordAITranslator/releases/tag/v0.4.0"};
		}
	});
	assert.equal(calls.length, 2);
	assert.equal(calls[1].url, UPDATE_LATEST_URL);
	assert.equal(calls[1].init.redirect, "follow");
	assert.equal(result.latest, "0.4.0");
	assert.equal(result.status, "available");
	assert.equal(result.releaseUrl, "https://github.com/ROOT94-MAX/DiscordAITranslator/releases/tag/v0.4.0");
});

test("update checking rejects malformed releases and failed responses", async () => {
	await assert.rejects(() => checkForUpdate({currentVersion: "1.0.0", fetch: async () => ({ok: false, status: 503})}), /503/);
	await assert.rejects(() => checkForUpdate({currentVersion: "1.0.0", fetch: async () => ({ok: true, json: async () => ({tag_name: "latest"})})}), /tag/);
});
