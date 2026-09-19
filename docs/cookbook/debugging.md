# Debugging cookbook

[简体中文](debugging.zh-CN.md)

Use this procedure to identify the failing boundary and collect enough evidence for a focused regression. Current behavior belongs to the subject documents; the [repaint incident](../postmortem/translation-repaint-and-composer.md) owns the historical cause analysis. Historical observations do not certify a different installation.

## Establish identity and evidence

1. Record the source commit, plugin version/build ID, and built/installed SHA-256 hashes. A matching version alone is insufficient.
2. Read client diagnostics to verify enablement and the in-memory instance. Matching files do not prove successful hot reload; report an unverified live instance explicitly if the connection fails.
3. Separate connection/HTTP, response structure, content validation, and display commit failures. Visible cached results do not prove provider availability; an outer fallback label cannot replace underlying evidence.
4. Map source, sent segments, raw response, validation and final result. Use synthetic public regressions. Optional client access is described in the [MCP guide](discord-mcp.zh-CN.md).

The source version comes from [metadata](../../src/plugin/metadata.json); the actual artifact carries its build ID. Run from the repository root:

```powershell
npm run build:check
Select-String -Path DiscordAITranslator.plugin.js -Pattern '@version|@buildId'
Get-FileHash DiscordAITranslator.plugin.js -Algorithm SHA256
```

Compare the installed file separately and inspect the live instance when available. Matching versions or disk files do not prove a release was published or loaded into memory. Record measurements outside Git instead of maintaining build-number snapshots here.

## Display and composer isolation

### Verify composer isolation

Translation results refresh mounted message/reply surfaces through Store revisions with bounded confirmation retry. Channel/provider changes use one anchored projection pulse. Capsule updates never repaint the message list.

Keep cache for the warm-path check to isolate display variables. With authorization for a cold-cache check, clear only `translationCache`, preserving settings, credentials and channel state. Plugin lifecycle and global settings reinitialization are separate host operations: composer/input can still refresh during those operations.

| Symptom | Inspect first | Preserve |
| --- | --- | --- |
| Composer flashes as translation appears | Lifecycle overlap or whole-chat remount | No synchronous blank/remount; no forced update on synthetic instances without an updater |
| Scrolling jumps to newest | Reading anchor, latest scroll intent, deferred paint gate | New user gestures veto restoration; no unconditional delayed offset writes |
| Capsule finishes before text appears | Mounted revision, pending display, offscreen mount readiness | Provider completion is not display readiness |
| Cumulative count becomes per-batch | Channel/job generation and unique message IDs | Deduplicate retries; count cumulatively and time only the current work round |
| Display retry calls the provider | Failure classification | Repaint stored results; translation failures retain their translation policy |
| Spinner survives channel disable | Current task terminal state and restore transaction | Restore pending historical rows even without a result |
| Forwarded text is empty or original duplicated | Snapshot body and display owner | Shared snapshot-aware extraction, clone, paint and restore; immutable Store records |
| new_only translates old messages | Frozen channel boundary before the first walk | Empty streams without a boundary stay uninitialized; a history capsule is not a classification fix |

## Response, validation, and timing

- `root-malformed` is a local category, not proof that the provider returned invalid JSON. Compare actual responses with sent IDs.
- Merge repeated rows for one message only when known, non-overlapping, non-empty segments become complete. Unknown, conflicting or missing parts retain repair; never infer identity by position.
- Keep version/HTTP labels only with local structural and protection evidence. Ordinary prose, `tag` and short words do not get a blanket exemption. Kept source is not completed translation.
- Review complete meaning and emphasis placement together. Valid markers or a target-language character alone do not establish semantic quality.
- Replay fixed responses before comparing real requests with identical source, model and settings. Report repaired items, physical requests and timing separately; fewer repaired items or tokens need not reduce end-to-end latency.
- Preserve P3 and default-off experimental boundaries in [validation](../../.agents/notes/implemented/architecture/2026-09-17-validation-and-repair-boundaries.md) and [experimental grants](../../.agents/notes/implemented/architecture/2026-09-17-bounded-experiment-grants.md). Diagnosis does not authorize archived policy tightening or cache migration.
- Historical recovery probes the associated health key within budget and preserves active Retry-After. Retry must not reset all provider health indiscriminately.

## Regression entry points

| Boundary | Tests |
| --- | --- |
| Batch shape, IDs, local repair | [parser](../../tests/planner/semantic-batch-answer.test.js), [bundle integration](../../tests/integration/typed-compact-batch-wire.test.js) |
| Technical labels and untranslated counterexamples | [soft validation](../../tests/planner/translation-soft-validation.test.js), [integration](../../tests/integration/p3-soft-validation-keep.test.js) |
| Meaning and formatting | [inline ranges](../../tests/planner/translation-inline-ranges.test.js), [inline format](../../tests/planner/translation-inline-format.test.js) |
| Cumulative count and work time | [session](../../tests/capsule-session-regression.test.js), [duration](../../tests/capsule-duration-visibility.test.js) |
| Disable and loading indicators | [spinner recovery](../../tests/integration/historical-spinner-recovery.test.js) |

## Environment and privacy

Copy over an installed plugin after placing its backup outside the plugin directory; deleting then moving may be observed as an uninstall. Distinguish host/BDFDB compatibility failures after client updates from plugin failures. Do not dump configuration objects, credentials, real conversations or channel IDs.

Raw screenshots, responses, HAR, logs and machine paths stay outside Git. Convert private incidents into synthetic regressions. See [recovery boundaries](../recovery-plan.md) and [publication](../publication.md).

Display decisions and rejected repaint routes: [display and readiness boundaries](../../.agents/notes/implemented/architecture/2026-09-17-display-and-readiness-boundaries.md).
