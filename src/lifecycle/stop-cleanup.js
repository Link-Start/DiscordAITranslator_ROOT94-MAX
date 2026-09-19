// Runs shutdown work as independent best-effort steps. A host cleanup failure must
// not strand later plugin-owned state or prevent the final Discord repaint.
function runIsolatedCleanupSteps(steps = []) {
	const failures = [];
	for (let index = 0; index < steps.length; index++) {
		try {
			const result = typeof steps[index] == "function" ? steps[index]() : null;
			if (result && typeof result.then == "function") Promise.resolve(result).catch(error => failures.push({index, error}));
		}
		catch (error) {failures.push({index, error});}
	}
	return failures;
}

module.exports = {runIsolatedCleanupSteps};
