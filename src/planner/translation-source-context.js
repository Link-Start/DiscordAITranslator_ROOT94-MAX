// Read-only source context for the existing typed wire, not another request lane.
const SOURCE_CONTEXT_VERSION = "message-context-v2";
const NAME_KEEP_VERSION = "explicit-name-keep-v1";
const KEEP_NAME_TOKEN = "__KEEP_NAME__";
const NAME_REPAIR_INSTRUCTION = " Repair pass: these requested segments were rejected previously. Do not repeat an untranslated echo or merely change its punctuation/case. Translate ordinary words, interface/error sentences and slang into the exact target language. When an unchanged name or technical identifier is appropriate, use the explicitly permitted __KEEP_NAME__ token; an unmarked echo will fail again. Return every requested id with intact structure and no explanation.";
const SOURCE_CONTEXT_INSTRUCTION = " Use each sourceContext as read-only context for its segments. Read all messages in the current batch for terminology and tone, but the current message takes precedence: unrelated messages are not one conversation. Translate only the requested spans, never add text from context or another message.";
const NAME_KEEP_INSTRUCTION = " For EVERY segment marked allowNameKeep you MUST choose one of two outcomes: (1) translate its ordinary prose/slang into the target language, keeping any embedded names; (2) if the ENTIRE segment should stay unchanged as a name, product/model, abbreviation, technical identifier or name list (including versions, percentages and protected tokens), set translation to exactly __KEEP_NAME__. Never echo or just recase/punctuate an unchanged name: the client requires the explicit token and restores the original bytes itself. In outcome (2), this rule overrides the usual requirement to copy protected/formatting tokens; output only __KEEP_NAME__. Examples: a product name such as 'Atlas Cloud?' or a model label such as 'nova 4.1 ⟦0⟧' -> __KEEP_NAME__; 'please open Atlas Cloud' -> translate the instruction, retaining Atlas Cloud. Do not choose (2) for ordinary prose, uncertainty or translation failure. The allowNameKeep flag is permission to decide, not evidence of a name. Unmarked segments cannot use this token.";

function buildMessageSourceContext(plan, maxChars = 4096) {
	if (!plan || !Array.isArray(plan.nodes) || !plan.nodes.some(node => node.classification === "preserve-target" && /\p{L}/u.test(node.raw))) return null;
	let ordinal = 0;
	const text = plan.nodes.map(node => {
		if (node.classification !== "protected" || node.kind === "syntax" && !/[\p{L}\p{N}]/u.test(node.raw)) return node.raw;
		// Never unmask protected words, links, code, mentions or local placeholders.
		return `⟦CTX${ordinal++}⟧`;
	}).join("");
	return text.length <= maxChars ? text : null;
}

function hasTargetTextOnLine(plan, node) {
	if (!node) return false;
	const source = String(plan.source || ""), start = Math.max(source.lastIndexOf("\n", node.sourceStart - 1), source.lastIndexOf("\r", node.sourceStart - 1)) + 1;
	const next = source.slice(node.sourceEnd).search(/[\r\n]/), end = next < 0 ? source.length : node.sourceEnd + next;
	return plan.nodes.some(part => part.classification === "preserve-target" && part.sourceStart < end && part.sourceEnd > start && /\p{L}/u.test(part.raw));
}

function isNameKeepDecision(node, answer) {
	if (answer === KEEP_NAME_TOKEN) return true;
	const wire = String(node.wireText || node.raw);
	// Some models obey the existing token-preservation rule around the sentinel.
	// Accept only the original surrounding punctuation/formatting, byte for byte;
	// changed, missing or extra markers and prose still reach the hard validator.
	const masked = wire.replace(/⟦\/?F\d+⟧/g, token => " ".repeat(token.length));
	const name = masked.replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, "");
	if (!/^[A-Za-z][A-Za-z0-9_.+-]{0,63}$/.test(name)) return false;
	const index = masked.indexOf(name);
	return answer === wire.slice(0, index) + KEEP_NAME_TOKEN + wire.slice(index + name.length);
}

module.exports = {SOURCE_CONTEXT_VERSION, NAME_KEEP_VERSION, KEEP_NAME_TOKEN, SOURCE_CONTEXT_INSTRUCTION, NAME_KEEP_INSTRUCTION, NAME_REPAIR_INSTRUCTION, buildMessageSourceContext, hasTargetTextOnLine, isNameKeepDecision};
