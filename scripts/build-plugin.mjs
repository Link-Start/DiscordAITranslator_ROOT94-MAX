import fs from "node:fs";
import path from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {build} from "esbuild";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDirectory, "..");
const outputPath = path.join(root, "DiscordAITranslator.plugin.js");

function createMetadataBanner(metadata) {
	return [
		"/**",
		` * @name ${metadata.name}`,
		` * @author ${metadata.author}`,
		` * @authorLink ${metadata.authorLink}`,
		` * @version ${metadata.version}`,
		` * @description ${metadata.description}`,
		` * @source ${metadata.source}`,
		` * @license ${metadata.license}`,
		" */",
		""
	].join("\n");
}

export async function createPluginBundle({debug = false} = {}) {
	const metadata = JSON.parse(fs.readFileSync(path.join(root, "src/plugin/metadata.json"), "utf8"));
	const result = await build({
		entryPoints: [path.join(root, "src/plugin/index.js")],
		bundle: true,
		platform: "node",
		format: "cjs",
		target: "es2020",
		charset: "utf8",
		legalComments: "none",
		keepNames: true,
		minify: false,
		minifySyntax: true,
		sourcemap: false,
		define: {__TRANSLATOR_DISPLAY_DEBUG__: debug ? "true" : "false"},
		write: false
	});
	const runtime = result.outputFiles[0].text
		.replace(/\r\n/g, "\n")
		.replace(
			/\{\s*manual:\s*!0,\s*independentOfTextAreaSwitch:\s*!0,\s*trackBusy:\s*!1\s*}/g,
			"{manual: true, independentOfTextAreaSwitch: true, trackBusy: false}"
		)
		.trimStart();
	return `${createMetadataBanner(metadata)}${runtime.trimEnd()}\n`;
}

export async function writePluginBundle({check = false, debug = false} = {}) {
	const generated = await createPluginBundle({debug});
	const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : "";
	if (check && current !== generated) throw new Error("DiscordAITranslator.plugin.js is out of date. Run npm run build.");
	if (!check && !debug && current !== generated) fs.writeFileSync(outputPath, generated);
	return generated;
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
	const debug = process.argv.includes("--debug");
	const generated = await writePluginBundle({check: process.argv.includes("--check"), debug});
	if (debug) process.stdout.write(generated);
}
