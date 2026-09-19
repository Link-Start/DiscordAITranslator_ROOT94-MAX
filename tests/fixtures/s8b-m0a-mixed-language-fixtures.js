const original14Markdown = `可以。邮箱验证成功后，先不要继续提交，按下面顺序重新选择。之前的选择仅作为参考，不会自动沿用。

### 1. Degree of Interest
- A. Undergraduate
- B. Graduate
- C. Doctoral
- D. Non-Degree / Certificate
- E. 其他

### 2. Academic Area of Interest
- A. Cybersecurity
- B. Information Technology
- C. Computer Science
- D. Business
- E. 其他

### 3. Military Affiliation
- A. No Military Affiliation
- B. Active Duty
- C. Veteran
- D. Military Spouse/Dependent
- E. National Guard / Reserve

### 4. 身份/位置问题
- A. I currently reside in the United States.
- B. I currently reside outside the United States.
- C. I am temporarily located outside the United States.

### 5. Mailing Address 是否为 Permanent Address
- A. Yes
- B. No

### 6. “4-3”问题
这一项需要看到页面上的完整题干和选项，不能只按编号判断。请把题目文字或截图发来，我再列出准确选项。

### 7. Degree Level
- A. Undergraduate Certificate
- B. Associate
- C. Bachelor’s
- D. Master’s
- E. Doctoral
- F. Non-Degree

### 8. Start Classes
- A. 2026 Spring
- B. 2026 Summer
- C. 2026 Fall
- D. 2027 Spring
- E. 其他

### 9. Degree / Certificate
- A. Cyber Threat Hunting
- B. Cybersecurity
- C. Information Technology
- D. Computer Science
- E. 其他

### 10. Start Session
请从页面实际显示的日期中选择，例如：
- A. August 12, 2026
- B. 其他页面显示日期

### 11. Type of High School Education
- A. Public High School
- B. Private High School
- C. Home School
- D. GED
- E. International Secondary School
- F. 其他

### 12. Tuition Rate
- A. In-state tuition rate
- B. Out-of-state tuition rate
- C. Military tuition rate
- D. International tuition rate
- E. 其他

### 13. Financing
- A. Self-Pay
- B. Employer Assistance
- C. Financial Aid
- D. Military Benefits
- E. Scholarship
- F. Other

### 14. Acknowledgment
- A. 勾选同意
- B. 不勾选

请按下面格式回复你的最终选择：

\`\`\`text
1:
2:
3:
4:
5:
6:（提供题干/截图）
7:
8:
9:
10:
11:
12:
13:
14:
\`\`\`

我会按照你确认后的选项继续，不再使用之前那组默认选择。`;

const targetBodyForeignTitle = `${"这是用于说明申请条件和费用信息的中文段落。".repeat(52)}\nFinancial Aid Application Requirements`;
const targetBodyTranslatedTitle = `${"这是用于说明申请条件和费用信息的中文段落。".repeat(52)}\n经济援助申请要求`;

const allEnglishProtected = `中文骨架：
\`\`\`js
const tuition = 1;
\`\`\`
Spouse/Dependent
GED
Non-Degree
Non-Degree
4-3
In-state
Out-of-state
Self-Pay
中文结束。`;

const currentBehaviorGolden = Object.freeze({
	// 2026-09-13: the all-caps acronym guess retired; GED travels as text, so one placeholder less.
	original14Markdown: {placeholderOccurrences: 8, hardSkip: false, autoEligible: true},
	targetBodyForeignTitle: {hardSkip: true, autoEligible: false, translatedWholeSimilarityAboveThreshold: true},
	allEnglishProtected: {placeholderOccurrences: 8, hardSkip: true, autoEligible: false}
});

const desiredBehaviorGolden = Object.freeze({
	original14Markdown: {completeForeignHeadingsAndOptionsTranslate: true, markdownAndTargetTextPreserved: true},
	targetBodyForeignTitle: {foreignTitleTranslates: true, targetBodyPreserved: true},
	allEnglishProtected: {naturalLanguageTokensTranslate: true, fencedCodeProtected: true}
});

const fixtureSha256 = Object.freeze({
	original14Markdown: "273F159973C490F8E3AE194EFEEB8F68CC46AB6BD2E294EC99590BDC473EE32A",
	targetBodyForeignTitle: "C74FC0DE9677B6A930016B759BE0D6E48CC9F93F6FE28DED8C457B3B867A7DAF",
	allEnglishProtected: "594949B75F98D79FB933E947251204E503FA39F44CDFC89DAE6779E4B91ED8FB"
});

module.exports = {original14Markdown, targetBodyForeignTitle, targetBodyTranslatedTitle, allEnglishProtected, currentBehaviorGolden, desiredBehaviorGolden, fixtureSha256};
