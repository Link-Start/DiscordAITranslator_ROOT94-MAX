# Extraction Plan: Cut By State Ownership, Delete In-Step

This plan replaces the "Later Milestones" list in `docs/recovery-plan.md`. That list is
retired; the display milestone it completed stays as recorded history.

## Why The Previous Plan Could Not Work

The previous list cut milestones by feature and by layer, and scheduled "remaining legacy
removal" last. Three measurements show why that could never shrink the legacy runtime:

1. **Its removal task removed nothing.** `git show --stat 345e406` — "refactor: remove legacy
   received display ownership" — touches three test files and zero production files. What it
   shipped was `tests/received-display-ownership.test.js`, a regex over runtime source text.
   This was not poor execution: `translatedMessages` is read by received display, reply
   previews, embeds, sent-edit, detection, and the auto-translate dedupe guard, so a milestone
   scoped to one of them can never drive the reader count to zero.
2. **Moving code without moving state is a no-op.** The 83 module-level `var` declarators live
   in the plugin factory closure, above the class. Every helper object, the historical job
   class, and all 9,254 lines of the class body read them directly. The helper objects
   (`receivedTranslationRuntime`, `translationDisplayLogic`, …) were already lifted above the
   class and the file did not shrink, because they still close over the same state.
3. **New code flows downhill into legacy.** A module-level var is free to read from anywhere;
   `src/display` receives its world through a hand-built dependency object. Adding a line to
   legacy costs nothing, adding one to a module costs a new injection. Measured: the four
   commits after the display milestone added 394 lines to `src/legacy/runtime.js` and 5 to
   `src/display`.

## What Changed In The Objective

**Artifact bytes are retired as a refactor metric.** Measured on this tree, `minify: true`
takes the bundle from 671 KB to 392 KB — inside the old 350-450 KB target — with zero source
changes, while refactoring alone could only reach roughly 660 KB. Byte count was tracking
formatting, not structure. The decision taken is to keep the shipped plugin **readable**,
because live DevTools diagnosis of real user reports is worth more than distribution size;
`tests/build-contract.test.js` now asserts readability instead of a byte ceiling. The
minification flag remains available as a final, independent step.

**Structure is measured directly and ratcheted.** `tests/architecture-budget.test.js` records
`runtime.js` line count and module-level var declarators, asserts they never grow, and asserts
they match the tree exactly so a milestone that forgets to lower them fails. The previous byte
guard was raised the moment it was breached; a ceiling that ratchets on breach is not a budget.

## The Cut Axis

A milestone is **one cohesive cluster of module-level state**. It converts every reader of that
cluster regardless of which feature or layer the reader lives in, then deletes the vars in the
same commit. Deletion is forced by construction: the reader count reaches zero, so the
declaration must go or the ratchet fails.

Rejected alternatives: **by-feature** (features share state, so deletion waits for the last
feature — this is what produced the current dual ownership) and **by-layer** (a layer boundary
slices across every var at once, so each layer must preserve every var for the layers not yet
moved — correct destination shape, fatal migration unit).

## Baseline (when this document was written)

| Metric | Value |
| --- | --- |
| `src/legacy/runtime.js` | 11,974 lines |
| Module-level var declarators | 83 |
| Modular code (`src/display`, `src/diagnostics`, `src/plugin`) | 592 lines |
| Artifact | 725,356 bytes, readable |
| Tests | 312 |

## Progress

| Metric | Baseline | Now |
| --- | --- | --- |
| `src/legacy/runtime.js` | 11,974 | 7,636 |
| Module-level var declarators | 83 | 16 |
| Modular code | 592 | 6,524 |
| Tests | 312 | 566 |

Extracted so far: presentation data (`src/ui`, `src/i18n`), channel titles, viewport and
scroll intent, the loaded-translation status HUD, the provider client, the translation
cache, the sent-message pipeline, the live translation queue, historical job bookkeeping,
and the repaint scheduler.

Remaining state, all of it in one of three groups: the displayed-translation maps
(`translatedMessages`, `oldMessages`, `suppressedAutoTranslations`) plus reply-preview
state, which move together in M7; the settings and credential cluster; and two
infrastructure bindings (`_this`, `pluginRuntimeActive`) that belong to the plugin shell.

Bugs the extraction surfaced and fixed along the way, each with its own regression test:
translations waiting out a 1500 ms delay meant for a full-list repaint; every provider
adapter throwing instead of settling on a hard network failure; and the automatic dedupe
guard reading a map the display migration had made permanently empty, so re-entering a
channel could wipe visible translations and re-spend on the provider.

## Milestones

Each row must leave the plugin fully working and independently shippable; the plugin is in
daily use. Both metric columns decrease monotonically.

| # | Cluster moved | Vars deleted | runtime.js after | Vars after |
| --- | --- | --- | --- | --- |
| M0 | Ratchet gate, metric change, display-milestone debt | 0 | 11,974 | 83 |
| M1 | Presentation data: css, 28-locale labels, custom text | 0 | ~9,600 | 83 |
| M2 | Channel title translation (pilot for delete-in-step) | 4 | ~9,480 | 79 |
| M3 | Viewport, scroll intent, input activity | 18 | ~9,150 | 61 |
| M4 | Loaded-translate status HUD and seen ledger | 3 | ~8,830 | 58 |
| M5 | Provider transport, engine catalog, credentials | 1 | ~7,500 | 57 |
| M6 | Translation cache and skip-decision persistence | 2 | ~7,290 | 55 |
| M7 | **Displayed-translation ownership** | 11 | ~6,400 | 44 |
| M8 | Orchestrator, live and historical queues | 15 | ~5,130 | 29 |
| M9 | Sent-message pipeline and edit interception | 6 | ~4,880 | 23 |
| M10 | Settings, language config, channel enablement, panel | 8 | ~2,980 | 15 |
| M11 | Policy, protection, heuristics, delegator sweep | 0 | ~1,780 | 15 |
| M12 | Delete `src/legacy/runtime.js`; plugin shell only | remainder | 0 | 0 |

### Where new work lands during the transition

Bug fixes and features go into the module that owns the state they touch, if that state has
already been extracted. If it has not, the fix goes into legacy **and** the affected cluster
moves up the order. The ratchet makes the alternative visible: any change that grows
`runtime.js` fails the suite.

### M7 is where `translatedMessages` and `oldMessages` finally die

They cannot die earlier. M7 bundles all eleven display-state vars into one cut so both maps
reach zero readers in a single commit. Three store capabilities the display milestone
deliberately omitted are preconditions, and each is a schema extension rather than a rewrite:

1. **Manual origin.** `message-state-store.js` filters restoration to `origin === "automatic"`,
   which is exactly why manual translation could not move. Restoration needs an explicit reason
   instead of an origin filter.
2. **Source archive replacing `oldMessages`.** The store's `source` holds `{content, embeds}`;
   `oldMessages[id]` holds a full `BDFDB.DiscordObjects.Message` clone plus
   `originalContentData`. The edit-prefill patch and the cache key derivation both need the
   wider shape, so the snapshot schema must widen and gain an explicit consume transition.
3. **Reply preview as a projection** of the same record, not a parallel store.

## Outstanding Debt From The Display Milestone (paid in M0)

- The store repaint path bypasses two rules the legacy path documents as hard: no chat-list
  repaint while a translator settings surface is open, and a 450 ms deferral while the channel
  text area is focused. `createDisplayRuntime` receives no hook for either.
- Store flush uses a fixed 120 ms where legacy used 1500 ms while viewing history.
- `getReceivedDisplayView` and its 23-line legacy projection have zero production callers and
  ship in every user's plugin.
- Task 10 steps 5-7 of `docs/recovery-plan.md` (renderer log, DiscordPTB smoke, evidence)
  remain unrun; the single operator pass ever attempted failed and was fixed in `443a54a`.

## Guardrails

- **Ratchet**: `tests/architecture-budget.test.js`, both metrics, exact match.
- **Dual-ownership invariant**: while any cluster is mid-migration, an integration assertion
  that no message id ever holds both a non-idle store record and a legacy display entry. The
  retired source-text contract could not observe divergence at all.
- **Repaint choke point**: repaint policy must be injected into the display runtime so
  "no commit repaints while the text area is focused" becomes expressible as a test.
