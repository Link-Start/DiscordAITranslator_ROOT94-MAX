import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {execFileSync} from "node:child_process";
import {inspectFile, checkRepository} from "../scripts/check-publication.mjs";

test("local and history scanners share exact synthetic identity exceptions", () => {
	const identities = JSON.parse(fs.readFileSync(new URL("../scripts/public-synthetic-identities.json", import.meta.url), "utf8"));
	const config = fs.readFileSync(new URL("../.gitleaks.toml", import.meta.url), "utf8");
	const identityRule = config.split('id = "unreviewed-discord-identity"')[1];
	const alternatives = identityRule.match(/regexes = \['''\^\(([^)]+)\)\$'''\]/)[1].split("|");
	assert.deepEqual(alternatives.sort(), identities.slice().sort());
	for (const identity of identities) assert.deepEqual(inspectFile("tests/fixture.js", Buffer.from(identity)), []);
});

test("publication rejects force-added evidence and installed state while accepting synthetic examples", () => {
	for (const name of [".env", ".env.production", "private.har", "full-test.log", "history.bundle", "images/chat.png", "DiscordAITranslator.config.json", "artifacts/response.json"]) {
		assert.ok(inspectFile(name, Buffer.from("{}\n")).some(issue => issue.rule === "private-file"), name);
	}
	for (const name of [".env.example", "tests/fixtures/synthetic.json", "artifacts/ui-redesign-draft.html"]) assert.deepEqual(inspectFile(name, Buffer.from("synthetic\n")), []);
});

test("privacy findings contain locations and rules, never the matched personal text", () => {
	const home = ["C:", "Users", "SyntheticPerson", "project"].join("\\");
	const identity = ["834765912", "876540123"].join("");
	const issues = inspectFile("docs/example.md", Buffer.from(`heading\n${home}\n${identity}\n`));
	assert.ok(issues.some(issue => issue.rule === "personal-home-path" && issue.line === 2));
	assert.ok(issues.some(issue => issue.rule === "unreviewed-discord-identity" && issue.line === 3));
	assert.ok(inspectFile("tests/fixture.js", Buffer.from(`row___${identity}___message`)).some(issue => issue.rule === "unreviewed-discord-identity"));
	assert.doesNotMatch(JSON.stringify(issues), /SyntheticPerson/);
});

test("document budgets constrain entry points and reject unreviewed binary attachments", () => {
	assert.ok(inspectFile("AGENTS.md", Buffer.from("line\n".repeat(81))).some(issue => issue.rule === "document-budget"));
	assert.ok(inspectFile("docs/example.md", Buffer.from("x".repeat(32001))).some(issue => issue.rule === "document-budget"));
	assert.ok(inspectFile("attachment.dat", Buffer.from([0, 1, 2])).some(issue => issue.rule === "binary-needs-privacy-review"));
});

test("repository checks cover unstaged docs, missing public links and ignored files force-added to Git", t => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "publication-check-"));
	// The exact directory is created by this test and contains only its disposable Git fixture.
	t.after(() => {
		assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
		assert.ok(path.basename(root).startsWith("publication-check-"));
		fs.rmSync(root, {recursive: true, force: true});
	});
	const git = (...args) => execFileSync("git", args, {cwd: root, stdio: "pipe"});
	git("init", "--quiet");
	fs.writeFileSync(path.join(root, ".gitignore"), "*.log\n");
	fs.writeFileSync(path.join(root, "README.md"), "[missing](absent.md)\n[ignored](private.log)\n");
	fs.writeFileSync(path.join(root, "private.log"), "synthetic evidence\n");
	let result = checkRepository(root);
	assert.equal(result.files, 2);
	assert.equal(result.issues.filter(issue => issue.rule === "missing-publication-link").length, 2);
	git("add", "-f", "private.log");
	result = checkRepository(root);
	assert.ok(result.issues.some(issue => issue.file === "private.log" && issue.rule === "private-file"));
	fs.writeFileSync(path.join(root, "README.md"), "[self](README.md)\n[external](https://example.com)\n");
	assert.equal(checkRepository(root).issues.filter(issue => issue.rule === "missing-publication-link").length, 0);
	const archive = ".agents/notes/archived/architecture/2026-07-12-old.md";
	fs.mkdirSync(path.dirname(path.join(root, archive)), {recursive: true});
	const privateHome = ["C:", "Users", "SyntheticPerson", "project"].join("\\");
	fs.writeFileSync(path.join(root, archive), `[historic link](missing.md)\n${privateHome}\n`);
	fs.writeFileSync(path.join(root, "README.md"), `[archive](${archive})\n[missing archive](.agents/notes/archived/absent.md)\n`);
	result = checkRepository(root);
	assert.ok(result.issues.some(issue => issue.file === archive && issue.rule === "personal-home-path"), "frozen notes still receive privacy checks");
	assert.deepEqual(result.issues.filter(issue => issue.rule === "missing-publication-link").map(issue => issue.file), ["README.md"], "only archived outbound links may age; active inbound links must resolve");
});
