import fs from "node:fs";
import path from "node:path";
import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";

const syntheticPrototype = "artifacts/ui-redesign-draft.html";
const privateDirectory = /^(?:artifacts|images|evidence|\.worktrees|\.superpowers|\.cursor|\.playwright-mcp|playwright-report|test-results|node_modules)\//;
const privateFile = /(?:^|\/)(?:\.env(?:\..*)?|AGENTS\.local\.md|settings\.local\.json)$|\.(?:log|har|bundle|zip|tar|gz|pem|key|p12|pfx|png|jpe?g|webp|gif|config\.json)$/i;
const examples = new Set([".env.example", ".config.example.json"]);
const privateHome = /(?:[A-Z]:[\\/]+Users[\\/]+|\/(?:Users|home)\/)[^\s/\\<>"']+/i;
const absoluteWindowsPath = /\b[A-Z]:[\\/]+[^\s<>"']+/i;
const discordIdentity = /[1-9]\d{16,19}/g;
const syntheticIdentities = new Set(JSON.parse(fs.readFileSync(new URL("./public-synthetic-identities.json", import.meta.url), "utf8")));

export function inspectFile(file, content) {
	const issues = [];
	const report = (rule, line = 1) => issues.push({file, line, rule});
	if (file !== syntheticPrototype && (privateDirectory.test(file) || (privateFile.test(file) && !examples.has(file)))) report("private-file");
	if (content.includes(0)) {
		report("binary-needs-privacy-review");
		return issues;
	}
	const text = content.toString("utf8");
	const documentation = file.endsWith(".md");
	const lines = text.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		if (privateHome.test(lines[i])) report("personal-home-path", i + 1);
		if (documentation && absoluteWindowsPath.test(lines[i])) report("machine-path-in-docs", i + 1);
		for (const match of lines[i].matchAll(discordIdentity)) {
			if (!syntheticIdentities.has(match[0])) report("unreviewed-discord-identity", i + 1);
		}
	}
	if (documentation && file !== "CHANGELOG.md") {
		const limit = file === "AGENTS.md" ? 80 : file === "docs/README.md" ? 100 : 400;
		if (lines.length > limit || text.length > 32000) report("document-budget");
	}
	return issues;
}

export function checkRepository(root) {
	// Include new, non-ignored files so a local check also covers work not staged yet.
	const candidates = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {cwd: root, encoding: "utf8"}).split("\0").filter(Boolean);
	const files = new Set(candidates.filter(file => fs.existsSync(path.join(root, file))));
	const issues = [];
	for (const file of files) {
		const absolute = path.join(root, file);
		const stat = fs.lstatSync(absolute);
		if (!stat.isFile()) {
			issues.push({file, line: 1, rule: "non-regular-file"});
			continue;
		}
		const content = fs.readFileSync(absolute);
		issues.push(...inspectFile(file, content));
		// Frozen notes keep historical outbound links; privacy checks above still apply.
		if (file.endsWith(".md") && !file.startsWith(".agents/notes/archived/")) issues.push(...inspectLinks(root, file, content.toString("utf8"), files));
	}
	return {files: files.size, issues};
}

export function inspectLinks(root, file, text, files) {
	const issues = [];
	const absolute = path.join(root, file);
	for (const match of text.matchAll(/\]\(([^)\r\n]+)\)/g)) {
		let target = match[1].replace(/\s+["'][^]*$/, "").replace(/^<|>$/g, "");
		if (/^(?:[a-z][a-z\d+.-]*:|#)/i.test(target)) continue;
		try { target = decodeURIComponent(target.split(/[?#]/)[0]); }
		catch { target = ""; }
		const resolved = path.resolve(path.dirname(absolute), target);
		const relative = path.relative(root, resolved).split(path.sep).join("/");
		const included = files.has(relative) || [...files].some(candidate => candidate.startsWith(relative + "/"));
		if (!target || relative.startsWith("../") || path.isAbsolute(relative) || !included) {
			issues.push({file, line: text.slice(0, match.index).split("\n").length, rule: "missing-publication-link"});
		}
	}
	return issues;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const result = checkRepository(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
		for (const issue of result.issues) console.error(`${issue.file}:${issue.line}: ${issue.rule}`);
		console.log(`Publication check: ${result.files} files, ${result.issues.length} issue(s). Secret values are never printed.`);
		process.exitCode = result.issues.length ? 1 : 0;
	}
	catch {
		console.error("Publication check could not read the Git file inventory.");
		process.exitCode = 1;
	}
}
