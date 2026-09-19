import fs from "node:fs";
import path from "node:path";
import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {inspectLinks} from "./check-publication.mjs";

const noteRoot = ".agents/notes";
// The one historical root is also read from the base commit so relocation cannot reset hashes.
const legacyNoteRoot = "docs/adr";
const manifestPath = `${noteRoot}/archive-manifest.json`;
const states = new Set(["proposed", "implemented", "rejected", "archived"]);
const classes = new Set(["feature", "bug-fix", "simplification", "architecture", "process", "testing"]);
const required = {
	proposed: ["Problem", "Proposal", "Alternatives considered", "Acceptance criteria", "Risks", "References"],
	implemented: ["Problem", "Decision", "Alternatives considered", "Consequences", "References"],
	rejected: ["Problem", "Proposal", "Alternatives considered", "References"]
};
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const ruleKey = text => text.toLowerCase().replaceAll(" ", "-");

function realDate(value) {
	return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function validNotePath(relative) {
	const parts = relative.split("/");
	const match = parts[2]?.match(/^(\d{4}-\d{2}-\d{2})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/);
	return parts.length === 3 && states.has(parts[0]) && classes.has(parts[1]) && !!match && realDate(match[1]);
}

// Only real prose contributes section headings and content, not examples or comments.
function prose(text) {
	let fence = null;
	return text.replace(/<!--[^]*?(?:-->|$)/g, "").split(/\r?\n/).map(line => {
		const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
		if (fence) {
			if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && line.slice(marker[0].length).trim() === "") fence = null;
			return "";
		}
		if (marker) { fence = marker[1]; return ""; }
		return /^\s*>|^(?: {4}|\t)/.test(line) ? "" : line;
	}).join("\n");
}

function inspectNote(file, relative, text, report) {
	const lines = text.split(/\r?\n/);
	const state = relative.split("/")[0];
	const header = lines[2]?.match(/^Status: (proposed|implemented|rejected)(?: — (\S.*))?$/);
	const status = header?.[1];
	if (!/^# Agent Note: \S.+$/.test(lines[0]) || lines[1] !== "" || !status || (status === "rejected") !== !!header?.[2]) report(file, "invalid-note-header");
	if (state === "archived") {
		const date = lines[3]?.match(/^Archived: (\d{4}-\d{2}-\d{2})$/)?.[1];
		if (!realDate(date || "") || lines[4] !== "" || status !== "implemented") report(file, "invalid-archive-header");
		// Sealed content keeps its original format. Hash and baseline checks below protect it.
		return;
	}
	else if (status !== state || lines[3] !== "" || /^Archived:/m.test(text)) report(file, "status-directory-mismatch");
	const body = prose(text);
	const sections = new Map();
	const headings = [...body.matchAll(/^## ([^\n]+)$/gm)];
	for (let i = 0; i < headings.length; i++) {
		const heading = headings[i][1].trim();
		if (sections.has(heading)) report(file, "duplicate-section");
		sections.set(heading, body.slice(headings[i].index + headings[i][0].length, headings[i + 1]?.index ?? body.length).trim());
	}
	if (headings[0]?.[1] !== "Problem") report(file, "problem-must-be-first");
	for (const heading of required[status] || []) {
		if (!sections.has(heading)) report(file, `missing-section-${ruleKey(heading)}`);
		else if (!sections.get(heading).replace(/^#+.*$/gm, "").trim()) report(file, `empty-section-${ruleKey(heading)}`);
	}
	if (status === "implemented" && /^#{2,6}\s+(?:Proposal|Plan|Implementation Plan|Migration Plan|Acceptance|Risks|提案|计划|实施计划|迁移计划|验收标准)(?:\s|$)/im.test(body)) report(file, "proposal-section-in-implemented");
	if (/\b(?:TODO|TBD|FIXME)\b|\{\{[^}]+\}\}|<fill[^>]*>|待填写|在此填写/i.test(body)) report(file, "unfilled-template");
	if (sections.has("References") && !/\[[^\]]+\]\([^)]+\)/.test(sections.get("References"))) report(file, "missing-evidence-link");
}

export function checkNotes(root, {baseRef = process.env.AGENT_NOTE_ARCHIVE_BASE_REF || "HEAD"} = {}) {
	const issues = [];
	const report = (file, rule) => issues.push({file, line: 1, rule});
	const git = (...args) => execFileSync("git", args, {cwd: root, encoding: "utf8", stdio: "pipe", maxBuffer: 16 * 1024 * 1024});
	if (fs.existsSync(path.join(root, legacyNoteRoot))) report(legacyNoteRoot, "legacy-note-root-present");
	let base = null;
	try { base = git("rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`).trim(); }
	catch { report(manifestPath, "invalid-archive-base"); }
	const absoluteRoot = path.join(root, noteRoot);
	if (!fs.existsSync(absoluteRoot) || !fs.lstatSync(absoluteRoot).isDirectory()) {
		report(noteRoot, "missing-note-root");
		return {notes: 0, issues};
	}
	let files;
	try {
		files = new Set(git("ls-files", "--cached", "--others", "--exclude-standard", "-z").split("\0").filter(file => file && fs.existsSync(path.join(root, file))));
	}
	catch { report(noteRoot, "unavailable-git-inventory"); return {notes: 0, issues}; }
	const archives = new Map();
	let notes = 0;
	const walk = (directory, prefix = "") => {
		for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
			const relative = prefix + entry.name;
			const file = `${noteRoot}/${relative}`;
			const absolute = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				const parts = relative.split("/");
				if (parts.length <= 2 && states.has(parts[0]) && (parts.length === 1 || classes.has(parts[1]))) walk(absolute, relative + "/");
				else report(file, "invalid-note-path");
				continue;
			}
			if (!entry.isFile()) { report(file, "non-regular-note-file"); continue; }
			if (["README.md", "AGENTS.md", "archive-manifest.json"].includes(relative) || /^(?:proposed|implemented|rejected)\/AGENTS\.md$/.test(relative)) continue;
			if (!validNotePath(relative)) { report(file, "invalid-note-path"); continue; }
			if (!files.has(file)) report(file, "note-excluded-from-publication");
			const bytes = fs.readFileSync(absolute);
			notes++;
			inspectNote(file, relative, bytes.toString("utf8"), report);
			if (relative.startsWith("archived/")) archives.set(relative, sha256(bytes));
			else issues.push(...inspectLinks(root, file, bytes.toString("utf8"), files));
		}
	};
	walk(absoluteRoot);
	if (!files.has(`${noteRoot}/README.md`)) report(noteRoot, "missing-note-index");
	const parseManifest = (text, rule) => {
		if (text === null) return {};
		try {
			const data = JSON.parse(text);
			if (data.version !== 1 || !data.files || typeof data.files !== "object" || Array.isArray(data.files) || Object.keys(data).some(key => !["version", "files"].includes(key))) throw new Error();
			for (const [file, hash] of Object.entries(data.files)) {
				if (!file.startsWith("archived/") || !validNotePath(file) || typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) throw new Error();
			}
			return data.files;
		}
		catch { report(manifestPath, rule); return {}; }
	};
	const manifestFile = path.join(root, manifestPath);
	const current = parseManifest(fs.existsSync(manifestFile) && fs.lstatSync(manifestFile).isFile() ? fs.readFileSync(manifestFile, "utf8") : null, "invalid-archive-manifest");
	if (fs.existsSync(manifestFile) && !files.has(manifestPath)) report(manifestPath, "manifest-excluded-from-publication");
	for (const [file, hash] of archives) {
		if (!Object.hasOwn(current, file)) report(`${noteRoot}/${file}`, "unlisted-archive");
		else if (current[file] !== hash) report(`${noteRoot}/${file}`, "archive-hash-mismatch");
	}
	for (const file of Object.keys(current)) if (!archives.has(file)) report(`${noteRoot}/${file}`, "missing-archive");
	if (base) {
		for (const baselineRoot of [noteRoot, legacyNoteRoot]) {
			const baselineManifest = `${baselineRoot}/archive-manifest.json`;
			const baselineFiles = git("ls-tree", "-r", "--name-only", "-z", base, "--", baselineRoot).split("\0").filter(Boolean);
			const previous = parseManifest(baselineFiles.includes(baselineManifest) ? git("show", `${base}:${baselineManifest}`) : null, "invalid-baseline-manifest");
			for (const file of baselineFiles.filter(file => file.startsWith(`${baselineRoot}/archived/`))) {
				if (!Object.hasOwn(previous, file.slice(baselineRoot.length + 1))) report(file, "baseline-archive-unlisted");
			}
			for (const [file, hash] of Object.entries(previous)) if (current[file] !== hash) report(`${noteRoot}/${file}`, "frozen-archive-changed");
		}
	}
	return {notes, issues};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const result = checkNotes(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
		for (const issue of result.issues) console.error(`${issue.file}:${issue.line}: ${issue.rule}`);
		console.log(`Agent Notes: ${result.notes} notes, ${result.issues.length} issue(s).`);
		process.exitCode = result.issues.length ? 1 : 0;
	}
	catch { console.error("Agent Notes check could not read the note tree or Git baseline."); process.exitCode = 1; }
}
