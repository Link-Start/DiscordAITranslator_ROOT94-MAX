"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const {capture} = require("./verify-historical-s4-equivalence");

async function verify(baselinePath, modifiedPath) {
	// S4 is already the native abortable historical transport baseline. S5 may
	// change only failed-request control flow, so the two clean native captures
	// must remain byte-for-byte and state-for-state identical.
	const baseline = await capture(baselinePath, {nativeFetch: true});
	const modified = await capture(modifiedPath, {nativeFetch: true});
	assert.deepEqual(modified, baseline);
	return {equivalent: true, baseline, modified};
}

if (require.main === module) verify(path.resolve(process.argv[2]), path.resolve(process.argv[3])).then(
	result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`),
	error => {console.error(error && error.stack || error); process.exitCode = 1;}
);

module.exports = {verify};
