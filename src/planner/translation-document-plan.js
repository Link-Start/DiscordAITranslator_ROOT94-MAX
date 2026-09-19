const {planReceivedMarkdown, PLANNER_VERSION} = require("./received-markdown-lossless-planner");
function hash(value) {let h=2166136261,s=String(value||"");for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619);}return(h>>>0).toString(16).padStart(8,"0");}

// Shared input projection: keep planner and ephemeral shadow reuse on the same field contract.
function collectTranslationDocumentFields(input = {}, options = {}) {
 const direction = String(options.direction || "received"), fields = [];
 const add = (fieldPath, text, relation = {}) => {if (text == null) return; fields.push({fieldPath, text: String(text), relation: Object.freeze(Object.assign({readOnly: true, output: false}, relation))});};
 add("body", input.body != null ? input.body : input.content);
 for (let i = 0; i < (input.embeds || []).length; i++) {
  const e = input.embeds[i] || {};
  add(`embeds.${i}.title`, e.title); add(`embeds.${i}.description`, e.description); add(`embeds.${i}.footer.text`, e.footer && e.footer.text);
  for (let j = 0; j < (e.fields || []).length; j++) {add(`embeds.${i}.fields.${j}.name`, e.fields[j] && e.fields[j].name); add(`embeds.${i}.fields.${j}.value`, e.fields[j] && e.fields[j].value);}
 }
 for (let i = 0; i < (input.forwarded || []).length; i++) add(`forwarded.${i}.body`, input.forwarded[i] && (input.forwarded[i].body || input.forwarded[i].content), {documentType: "forwarded"});
 if (input.reply && input.reply.body != null) add("reply.body", input.reply.body, {documentType: "reply", reuseDocumentIdentity: input.reply.documentIdentity || null});
 if (direction === "sent") add("sent.body", input.sent && input.sent.body != null ? input.sent.body : input.body, {documentType: "sent"});
 return fields;
}

function planTranslationDocument(input = {}, options = {}) {
 const direction = String(options.direction || "received"), targetLanguageId = String(options.targetLanguageId || "zh-CN");
 const fields = collectTranslationDocumentFields(input, {direction}).map(({fieldPath, text, relation}) => ({fieldPath, plan: planReceivedMarkdown(text, {direction, fieldPath, targetLanguageId}), relation}));
 const identity = `dp1:${hash([direction, targetLanguageId, PLANNER_VERSION, ...fields.map(f => `${f.fieldPath}:${f.plan.sourceHash}`)].join("\0"))}`;
 return Object.freeze({plannerVersion: PLANNER_VERSION, direction, targetLanguageId, documentIdentity: identity, attachmentPolicy: "excluded", attachmentsIncluded: false, fields: Object.freeze(fields), fieldCount: fields.length, nodeCount: fields.reduce((n, f) => n + f.plan.nodes.length, 0), coverageComplete: fields.every(f => f.plan.sourceLength === f.plan.nodes.reduce((n, x) => n + x.raw.length, 0))});
}
module.exports = {planTranslationDocument, collectTranslationDocumentFields};
