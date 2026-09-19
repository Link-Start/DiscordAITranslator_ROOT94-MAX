import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {checkNotes} from "../scripts/check-agent-notes.mjs";

const notePath = "implemented/architecture/2026-07-13-single-file-build.md";
const note = `# Agent Note: Single-file build

Status: implemented

## Problem

Source ownership and install packaging need separate verification.

## Decision

Generate one plugin from modular source.

## Alternatives considered

Hand-maintaining the bundle couples source ownership to distribution.

## Consequences

The build becomes part of verification.

## References

- [Product](../../../../docs/product.md)
`;

function fixture(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-notes-check-"));
	t.after(() => {
		assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
		assert.ok(path.basename(root).startsWith("agent-notes-check-"));
		fs.rmSync(root, {recursive: true, force: true});
	});
	const write = (file, text) => {
		fs.mkdirSync(path.dirname(path.join(root, file)), {recursive: true});
		fs.writeFileSync(path.join(root, file), text);
	};
	const git = (...args) => execFileSync("git", args, {cwd: root, encoding: "utf8", stdio: "pipe"}).trim();
	git("init", "--quiet");
	git("config", "core.autocrlf", "false");
	git("config", "user.name", "Synthetic Contributor");
	git("config", "user.email", "contributor@example.invalid");
	write("docs/product.md", "# Product\n");
	write(".agents/notes/README.md", "# Agent Notes\n");
	const commit = () => { git("add", "."); git("-c", "commit.gpgsign=false", "commit", "-qm", "fixture"); return git("rev-parse", "HEAD"); };
	commit();
	const put = (file, value) => write(`.agents/notes/${file}`, value);
	const archive = () => {
		const file = notePath.replace("implemented/", "archived/");
		const content = note.replace("Status: implemented\n", "Status: implemented\nArchived: 2026-09-17\n");
		put(file, content);
		const files = {[file]: createHash("sha256").update(content).digest("hex")};
		put("archive-manifest.json", JSON.stringify({version: 1, files}));
		return {file, content, files};
	};
	// CI supplies this repository's baseline; disposable repositories have their own HEAD.
	return {root, write, put, git, commit, archive, check: options => checkNotes(root, {baseRef: "HEAD", ...options})};
}

test("a missing note root and an unavailable Git baseline fail closed", t => {
	const f = fixture(t);
	fs.unlinkSync(path.join(f.root, ".agents/notes/README.md"));
	fs.rmdirSync(path.join(f.root, ".agents/notes"));
	assert.ok(f.check().issues.some(i => i.rule === "missing-note-root"));
	assert.ok(f.check({baseRef: "does-not-exist"}).issues.some(i => i.rule === "invalid-archive-base"));
});

test("the first archive can be added to a valid pre-migration commit", t => {
	const f = fixture(t);
	f.put(notePath, note);
	assert.deepEqual(f.check().issues, []);
	f.archive();
	assert.deepEqual(f.check().issues, []);
});

test("note paths validate lifecycle, class, real date and status including translated sidecars", t => {
	const f = fixture(t);
	for (const file of ["unknown/architecture/2026-07-13-test.md", "implemented/other/2026-07-13-test.md", "implemented/architecture/2026-02-30-test.md", "implemented/architecture/2026-07-13-test.zh.md", "implemented/architecture/nested/2026-07-13-test.md"]) f.put(file, note);
	f.put("proposed/process/2026-07-13-test.md", note);
	const issues = f.check().issues;
	assert.equal(issues.filter(i => i.rule === "invalid-note-path").length, 5);
	assert.ok(issues.some(i => i.rule === "status-directory-mismatch"));
});

test("empty, comment-only, quoted and fenced headings cannot satisfy required sections", t => {
	const f = fixture(t);
	for (const replacement of ["", "<!-- describe this later -->", "> ## Decision\n> Generate one plugin.", "```md\n## Decision\nGenerate one plugin.\n```"]) {
		f.put(notePath, note.replace("## Decision\n\nGenerate one plugin from modular source.", replacement));
		assert.ok(f.check().issues.some(i => i.rule === "missing-section-decision" || i.rule === "empty-section-decision"));
	}
	f.put(notePath, note + "\n## Acceptance criteria\n\nA future implementation passes.\n");
	assert.ok(f.check().issues.some(i => i.rule === "proposal-section-in-implemented"));
	f.put(notePath, note.replace("Generate one plugin from modular source.", "TODO: fill this in."));
	assert.ok(f.check().issues.some(i => i.rule === "unfilled-template"));
});

test("proposed and rejected notes require their own decision evidence", t => {
	const f = fixture(t);
	const proposed = note.replace("Status: implemented", "Status: proposed").replace("## Decision", "## Proposal").replace("## Consequences", "## Risks") + "\n## Acceptance criteria\n\nOne installable file passes the parity check.\n";
	f.put("proposed/feature/2026-07-13-single-file-build.md", proposed);
	assert.deepEqual(f.check().issues, []);
	const rejected = proposed.replace("Status: proposed", "Status: rejected — The packaging constraint rules out this alternative.");
	f.put("rejected/feature/2026-07-13-other-build.md", rejected);
	assert.deepEqual(f.check().issues, []);
	f.put("rejected/feature/2026-07-13-other-build.md", rejected.replace(" — The packaging constraint rules out this alternative.", ""));
	assert.ok(f.check().issues.some(i => i.rule === "invalid-note-header"), "a rejection verdict must name its reason");
});

test("active links must resolve inside the public Git inventory; archived outbound links may age", t => {
	const f = fixture(t);
	f.put(notePath, note.replace("../../../../docs/product.md", "../../../../docs/missing.md"));
	assert.ok(f.check().issues.some(i => i.rule === "missing-publication-link"));
	f.put(notePath, note.replace("../../../../docs/product.md", "../../archived/architecture/2026-07-13-single-file-build.md"));
	f.archive();
	assert.deepEqual(f.check().issues, []);
	fs.unlinkSync(path.join(f.root, "docs/product.md"));
	assert.deepEqual(f.check().issues, []);
});

test("a frozen archive cannot be edited by recomputing its hash or deleted with its manifest entry", t => {
	const f = fixture(t);
	const {file, content} = f.archive();
	const baseRef = f.commit();
	const altered = content.replace("Generate one plugin", "Generate two plugins");
	f.put(file, altered);
	assert.ok(f.check({baseRef}).issues.some(i => i.rule === "archive-hash-mismatch"));
	f.put("archive-manifest.json", JSON.stringify({version: 1, files: {[file]: createHash("sha256").update(altered).digest("hex")}}));
	assert.ok(f.check({baseRef}).issues.some(i => i.rule === "frozen-archive-changed"));
	f.commit();
	assert.ok(f.check({baseRef}).issues.some(i => i.rule === "frozen-archive-changed"), "CI must compare with the pre-change commit, not the new HEAD");
	fs.unlinkSync(path.join(f.root, ".agents/notes", file));
	f.put("archive-manifest.json", JSON.stringify({version: 1, files: {}}));
	assert.ok(f.check({baseRef}).issues.some(i => i.rule === "frozen-archive-changed"));
});

test("manifest errors, unlisted archive files and baseline archives without a manifest fail closed", t => {
	const f = fixture(t);
	const {file} = f.archive();
	f.put("archive-manifest.json", "{bad json");
	assert.ok(f.check().issues.some(i => i.rule === "invalid-archive-manifest"));
	fs.unlinkSync(path.join(f.root, ".agents/notes/archive-manifest.json"));
	assert.ok(f.check().issues.some(i => i.rule === "unlisted-archive"));
	f.commit();
	f.archive();
	assert.ok(f.check().issues.some(i => i.rule === "baseline-archive-unlisted"));
	f.put("archive-manifest.json", JSON.stringify({version: 1, files: {"../escape.md": "0".repeat(64), [file]: "invalid"}}));
	assert.ok(f.check().issues.some(i => i.rule === "invalid-archive-manifest"));
});

test("only implemented notes can be sealed; existing archive format stays frozen", t => {
	const f = fixture(t);
	const {file, content} = f.archive();
	const seal = value => {
		f.put(file, value);
		f.put("archive-manifest.json", JSON.stringify({version: 1, files: {[file]: createHash("sha256").update(value).digest("hex")}}));
	};
	seal(content.replace("## Alternatives considered", "## Alternatives"));
	f.commit();
	assert.deepEqual(f.check().issues, [], "sealing must not rewrite historical headings to a new template");
	seal(content.replace("Status: implemented", "Status: rejected — The approach was declined."));
	assert.ok(f.check().issues.some(i => i.rule === "invalid-archive-header"));
});

test("moving the library preserves the old-root baseline and rejects a parallel legacy library", t => {
	const f = fixture(t);
	const {file, content} = f.archive();
	const currentRoot = path.join(f.root, ".agents/notes");
	const legacyRoot = path.join(f.root, "docs/adr");
	// Both resolved paths are within this disposable fixture, created by this test.
	for (const target of [currentRoot, legacyRoot]) assert.ok(path.relative(f.root, target) && !path.relative(f.root, target).startsWith(".."));
	fs.renameSync(currentRoot, legacyRoot);
	const baseRef = f.commit();
	fs.renameSync(legacyRoot, currentRoot);
	assert.deepEqual(f.check({baseRef}).issues, []);
	const altered = content.replace("Generate one plugin", "Generate two plugins");
	f.put(file, altered);
	f.put("archive-manifest.json", JSON.stringify({version: 1, files: {[file]: createHash("sha256").update(altered).digest("hex")}}));
	assert.ok(f.check({baseRef}).issues.some(i => i.rule === "frozen-archive-changed"), "root migration cannot reset frozen hashes");
	f.write("docs/adr/README.md", "# Duplicate library\n");
	assert.ok(f.check({baseRef}).issues.some(i => i.rule === "legacy-note-root-present"));
});
