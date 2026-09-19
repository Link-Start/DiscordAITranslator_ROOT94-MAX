const {isTranslatableOutputNode} = require("./translation-plan-serializer");
const {expectedInlinePlaceholders, inlineTokens} = require("./translation-inline-ranges");

// Spans may move as complete units for target-language word order. Their nesting
// remains source-owned: a link cannot close outside its parent bold/spoiler span.
function formatMismatch(text, expectations) {
	const parents = new Map(), expectedStack = [];
	for (const entry of expectations || []) {
		const match = /^⟦(\/?)F(\d+)⟧$/.exec(String(entry.token || entry));
		if (!match) continue;
		if (match[1]) expectedStack.pop();
		else {parents.set(match[2], expectedStack[expectedStack.length - 1] || null); expectedStack.push(match[2]);}
	}
	if (!parents.size) return false;
	const stack = [];
	for (const match of String(text).matchAll(/⟦(\/?)F(\d+)⟧/g)) {
		const top = stack[stack.length - 1];
		if (match[1]) {
			if (!top || top.id !== match[2] || !String(text).slice(top.end, match.index).replace(/⟦\/?F\d+⟧/g, "").trim()) return true;
			stack.pop();
		}
		else {
			if (parents.get(match[2]) !== (top ? top.id : null)) return true;
			stack.push({id: match[2], end: match.index + match[0].length});
		}
	}
	return stack.length > 0;
}

// P2: for merged inline ranges the ⟦...⟧ token multiset of a translation must equal the
// multiset that was sent (P1 placeholders, local ⟦Cn⟧ leaves, and paired ⟦Fn⟧ markers); any missing, duplicated
// or foreign token is a placeholder-mismatch. Plans without such ranges add no expectations.
function placeholderMismatch(text, expectations, sourceText) {
	if ([...String(text).matchAll(/⟦CTX\d+⟧|__KEEP_NAME__/g)].some(match => !String(sourceText || "").includes(match[0]))) return true;
	const expected = new Map();
	for (const placeholder of expectations || []) {
		const token = String(placeholder.token || placeholder), count = Number(placeholder.count || 1);
		if (token) expected.set(token, (expected.get(token) || 0) + count);
	}
	// A mixed batch must not let another message's generated formatting tokens leak
	// into a plain row. User-written lookalikes remain literal text, not our markup.
	if (!expected.size) return [...String(text).matchAll(/⟦\/?F\d+⟧/g)].some(match => !String(sourceText || "").includes(match[0]));
	for (const [token, count] of expected) if (String(text).split(token).length - 1 !== count) return true;
	return inlineTokens(text).some(token => !expected.has(token)) || formatMismatch(text, expectations);
}

// A Chinese prefix or note around the untouched source ("翻译：I am hungry") is not a
// translation. Compared after dropping protocol tokens and whitespace; sources shorter
// than four letters (names, "GG", "OK") are exempt because carrying them over is expected.
function normalizeForContainment(value) {
	return String(value == null ? "" : value).replace(/⟦[^⟧]*⟧/g, "").replace(/\s+/g, "").trim();
}
function containsWholeSource(translation, sourceText) {
	const source = normalizeForContainment(sourceText);
	if (!source || (source.match(/\p{L}/gu) || []).length < 4) return false;
	const answer = normalizeForContainment(translation);
	return answer !== source && answer.includes(source);
}

function validateSegmentResponse(plan,rows,{likelyTarget=()=>true,similarity=()=>0,maxSimilarity=0.94,expectedPlaceholders={}}={}){const expected=new Map((plan.nodes||[]).filter(isTranslatableOutputNode).map(n=>[n.id,n])),placeholders=Object.assign(expectedInlinePlaceholders(plan),expectedPlaceholders||{}),seen=new Set(),valid={},invalid=[],unknown=[],duplicate=[];for(const row of rows||[]){const id=String(row&&row.id||"");if(!expected.has(id)){unknown.push(id);continue;}if(seen.has(id)){duplicate.push(id);delete valid[id];invalid.push({id,reason:"duplicate-id"});continue;}seen.add(id);const text=String(row&&row.translation||"");let reason=null;if(!text.trim())reason="empty";else if(placeholderMismatch(text,placeholders[id],expected.get(id).wireText || expected.get(id).raw))reason="placeholder-mismatch";const node=expected.get(id),sourceText=typeof node.wireText==="string"?node.wireText:node.raw;if(!reason&&(!likelyTarget(text)||containsWholeSource(text,sourceText)))reason="wrong-language";else if(!reason&&similarity(sourceText,text)>=maxSimilarity)reason="too-similar";if(reason)invalid.push({id,reason});else valid[id]=text;}for(const id of expected.keys())if(!seen.has(id))invalid.push({id,reason:"missing-id"});const repairEligibleIds=[...new Set(invalid.map(x=>x.id).filter(id=>expected.has(id)))],candidateOutcome=invalid.length||unknown.length||duplicate.length?"repair-candidate":"valid";return Object.freeze({candidateOutcome,legacyOutcome:null,valid:Object.freeze(valid),invalid:Object.freeze(invalid),unknownIds:Object.freeze(unknown),duplicateIds:Object.freeze(duplicate),repairEligibleIds:Object.freeze(repairEligibleIds),doesScheduleRepair:false});}
module.exports={validateSegmentResponse};
