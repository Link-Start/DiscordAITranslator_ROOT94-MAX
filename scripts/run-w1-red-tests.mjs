import {readdirSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import path from "node:path";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const redTestDirectory = path.join(repositoryRoot, "tests", "red");

let files = [];
try {
	files = readdirSync(redTestDirectory, {withFileTypes: true})
		.filter(entry => entry.isFile() && /^w1-.*\.red\.js$/.test(entry.name))
		.map(entry => path.join("tests", "red", entry.name))
		.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}
catch (error) {
	console.error(`W1 red-test discovery failed: ${error && error.message || error}`);
	process.exitCode = 2;
}

if (!process.exitCode && files.length === 0) {
	console.error("W1 red-test discovery found no tests/red/w1-*.red.js files.");
	process.exitCode = 2;
}

if (!process.exitCode) {
	const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...files], {
		cwd: repositoryRoot,
		stdio: "inherit",
		windowsHide: true
	});
	if (result.error) {
		console.error(`W1 red-test runner failed: ${result.error.message}`);
		process.exitCode = 2;
	}
	else process.exitCode = Number.isInteger(result.status) ? result.status : 1;
}
