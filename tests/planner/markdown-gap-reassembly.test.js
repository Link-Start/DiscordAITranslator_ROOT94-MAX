const test = require("node:test"), assert = require("node:assert/strict");
const {planReceivedMarkdown, reassembleReceivedMarkdown} = require("../../src/planner/received-markdown-lossless-planner");
function replaceTexts(source, translations) {const plan = planReceivedMarkdown(source, {targetLanguageId: "zh-CN"}), values = {}; for (const node of plan.nodes) if ((node.classification === "translate" || node.classification === "uncertain") && Object.hasOwn(translations, node.raw.trim())) values[node.id] = translations[node.raw.trim()]; return reassembleReceivedMarkdown(plan, values);}

test("Markdown source-owned boundaries preserve hard breaks ASCII gaps and intentional provider spacing", async t => {
 const cases = [
  ["## Title", {Title: "译文"}, "## 译文"],
  ["## Title", {Title: "　译文"}, "## 　译文"],
  ["##\tTitle", {Title: "  译文"}, "##\t 译文"],
  ["-  Item", {Item: "  译文"}, "-  译文"],
  ["First line  \r\nSecond line", {"First line": "第一行 ", "Second line": "第二行"}, "第一行  \r\n第二行"],
  ["First line  \nSecond line", {"First line": "第一行   ", "Second line": "第二行"}, "第一行   \n第二行"],
  ["中文English中文", {English: "译文"}, "中文译文中文"],
  ["中文 English 中文", {English: "译文"}, "中文 译文 中文"],
  ["**Word**", {Word: "译文"}, "**译文**"],
  ["Alpha  Beta", {"Alpha  Beta": "甲   乙"}, "甲   乙"],
  ["Word", {Word: "  译文  "}, "  译文  "],
  ["# [Read](https://example.invalid/x) `code` 😀", {Read: "译文"}, "# [译文](https://example.invalid/x) `code` 😀"]
 ];
 for (const [index, [source, translations, expected]] of cases.entries()) await t.test("boundary case " + index, () => assert.equal(replaceTexts(source, translations), expected));
});

test("Markdown edge restoration never rewrites source syntax protected code URLs emoji or line endings", () => {
 const source = "## Heading\r\n\r\n`code` 😀 https://example.invalid/x\n中文\r", plan = planReceivedMarkdown(source, {targetLanguageId: "zh-CN"}), replacements = {};
 for (const node of plan.nodes) if (node.classification === "translate" || node.classification === "protected") replacements[node.id] = node.classification === "translate" ? "标题" : "WRONG_PROTECTED_REPLACEMENT";
 assert.equal(reassembleReceivedMarkdown(plan, replacements), "## 标题\r\n\r\n`code` 😀 https://example.invalid/x\n中文\r");
 assert.equal(reassembleReceivedMarkdown(plan), source);
});

test("Markdown inline ranges preserve protected edge whitespace and existing gap nodes without double restoration", () => {
 const {createSemanticRequest, validateSemanticResponse} = require("../../src/planner/translation-semantic-runtime");
 for (const [source, expected] of [["## Read \\ ", "## \\ 译文"], ["## Read https://example.invalid  \r\nNext", "## https://example.invalid译文  \r\n下一行"]]) {
  const request = createSemanticRequest({engineKey: "oaicompat", source, targetLanguageId: "zh-CN"});
  const rows = JSON.parse(request.wire).segments.map(segment => ({id: segment.id, translation: segment.text === "Next" ? "下一行" : "⟦C0⟧译文"}));
  const outcome = validateSemanticResponse(request, JSON.stringify({segments: rows}));
  assert.equal(outcome.ok, true); assert.equal(outcome.translation, expected);
 }
});
