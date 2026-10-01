# Paseo A-8 新鲜独立审核（Round 148）

**Date:** 2026-10-02  
**Auditor:** primary agent in this conversation (post Round 148 evidence)  
**Scope:** Acceptance A-1…A-8 against current working tree / HEAD `9e30a5e27` + uncommitted Round 148 docs; ledger checkmarks ignored until proved.  
**Override:** skip real-account login and physical phone; connection-mode evidence not waived.

## Method

1. Re-read Acceptance verify clauses in `spec/changes/paseo-provider-integration/loop.md`.
2. For A-5, inspect current evidence files under `%TEMP%/codework-a5-r148/evidence` (manifest + key PNGs / Electron text dump).
3. For A-1…A-4/A-6/A-7, rely on prior committed probes/docs plus Round 147 audit; spot-check that A-7 remains checked with isolate harness commit `8643b11a8` and A-5 was the sole R147 blocker.
4. For A-8 docs: confirm `docs/internals/paseo-provider-catalog.md`, `docs/internals/acp-provider-validation.md`, and per-provider rollback sections exist; A-8 still requires every A-N proved.

## Verdict

| ID  | Verdict  | Notes                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A-1 | PROVED   | Unchanged since R147; fixture chain remains in tree                                                                                                                                                                                                                                                                                                                                      |
| A-2 | PROVED   | Catalog 6+38 + tests                                                                                                                                                                                                                                                                                                                                                                     |
| A-3 | PROVED   | Login waived; first-batch probes + stable docs                                                                                                                                                                                                                                                                                                                                           |
| A-4 | PROVED   | Four-state registration table                                                                                                                                                                                                                                                                                                                                                            |
| A-5 | PROVED   | Web 360/1280 + Electron + Mobile AVD key-path; see `paseo-a5-keypath-r148.md`. Physical phone waived.                                                                                                                                                                                                                                                                                    |
| A-6 | PROVED   | Native adapter / account-pool regressions previously green                                                                                                                                                                                                                                                                                                                               |
| A-7 | PROVED   | Isolate live harness commit `8643b11a8` / ledger Round 146                                                                                                                                                                                                                                                                                                                               |
| A-8 | UNPROVED | Docs/capability/rollback exist, but this audit must land as a committed Round record with A-5 checkbox update; final A-8 check only after ledger reflects A-5 and a post-commit re-read confirms no remaining unchecked Acceptance blockers other than A-8 itself, then capability table + user-facing notes + rollback inventory are explicitly tied in the same Round as the A-8 check |

## A-5 evidence anchors

- Web reconnect: `web-1280-disconnect-reconnect.png`
- Web/Electron/Mobile approval+tools: respective `*-approval*`, `electron-earlier-logs.png` (Command approval requested / Approval resolved), `mobile-avd-worklog-full.png`
- Commands: `web-1280-slash-commands.png`, `electron-cdp-slash.png` (`/model`)
- Tool detail: `web-1280-tool-details-expanded.png`, `electron-tool-detail.png` (`{ "name": "t3" }`), `mobile-avd-tool-detail.png`

## A-8 gate

Do **not** check A-8 in the same breath as discovering A-5 evidence. Sequence: commit Round 148 docs + check A-5 → Round 149 (or same Round epilogue after hash) performs final independent pass that only then may check A-8 if docs/44-table/rollback remain complete and no A-N regresses.

**A-8 remains unchecked after this audit document is written, until the sequenced final pass.**
