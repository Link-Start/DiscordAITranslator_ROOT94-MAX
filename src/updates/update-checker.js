const UPDATE_PROJECT_URL = "https://github.com/ROOT94-MAX/DiscordAITranslator";
const UPDATE_API_URL = "https://api.github.com/repos/ROOT94-MAX/DiscordAITranslator/releases/latest";
const UPDATE_LATEST_URL = `${UPDATE_PROJECT_URL}/releases/latest`;

function normalizeVersion(value) {
	return String(value || "").trim().replace(/^v/i, "").split("+")[0];
}

function compareVersions(left, right) {
	const parse = value => {
		const [core, prerelease = ""] = normalizeVersion(value).split("-", 2);
		const numbers = core.split(".").map(part => Number(part) || 0);
		return {numbers: [numbers[0] || 0, numbers[1] || 0, numbers[2] || 0], prerelease};
	};
	const a = parse(left);
	const b = parse(right);
	for (let index = 0; index < 3; index++) if (a.numbers[index] != b.numbers[index]) return a.numbers[index] > b.numbers[index] ? 1 : -1;
	if (a.prerelease == b.prerelease) return 0;
	if (!a.prerelease) return 1;
	if (!b.prerelease) return -1;
	return a.prerelease > b.prerelease ? 1 : -1;
}

async function checkForUpdate({currentVersion, fetch, apiUrl = UPDATE_API_URL} = {}) {
	if (typeof fetch != "function") throw new TypeError("fetch callback required");
	const current = normalizeVersion(currentVersion);
	const userAgent = `DiscordAITranslator/${current || "unknown"}`;
	const response = await fetch(apiUrl, {
		method: "GET",
		headers: {Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": userAgent},
		timeout: 10000
	});
	let release;
	if (response && response.ok) release = await response.json();
	else if (response && response.status == 403) {
		const fallback = await fetch(UPDATE_LATEST_URL, {
			method: "GET",
			headers: {Accept: "text/html", "User-Agent": userAgent},
			redirect: "follow",
			timeout: 10000
		});
		if (!fallback || !fallback.ok) throw new Error(`GitHub HTTP ${fallback && fallback.status || response.status}`);
		const releaseUrl = String(fallback.url || fallback.headers && typeof fallback.headers.get == "function" && fallback.headers.get("location") || "");
		const match = /\/releases\/tag\/v?([^/?#]+)/i.exec(releaseUrl);
		if (!match) throw new Error("release redirect missing");
		release = {tag_name: decodeURIComponent(match[1]), html_url: releaseUrl, body: ""};
	}
	else throw new Error(`GitHub HTTP ${response && response.status || "?"}`);
	const latest = normalizeVersion(release && release.tag_name);
	if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(latest)) throw new Error("release tag missing");
	const comparison = compareVersions(currentVersion, latest);
	return {
		current,
		latest,
		status: comparison < 0 ? "available" : comparison > 0 ? "development" : "current",
		releaseUrl: String(release && release.html_url || `${UPDATE_PROJECT_URL}/releases/tag/v${latest}`),
		body: String(release && release.body || "")
	};
}

module.exports = {UPDATE_PROJECT_URL, UPDATE_API_URL, UPDATE_LATEST_URL, normalizeVersion, compareVersions, checkForUpdate};
