# Paseo A-8 新鲜独立审核（Round 147）

**Date:** 2026-10-02  
**Auditor agent:** `118c5d7c-a9b3-4f1f-97ae-3dbdcd3d6d5f`  
**Scope:** Acceptance A-1…A-8 against current HEAD; ledger checkmarks ignored.  
**Override:** skip real-account login and physical phone; connection-mode evidence not waived.

## Verdict

| ID | Verdict | Notes |
| --- | --- | --- |
| A-1 | PROVED | Fixture → RuntimeModel → Adapter → Ingestion → Web/Mobile derivation tests green this audit |
| A-2 | PROVED | Fixed 6+38 IDs + catalog/snapshot/driver tests |
| A-3 | PROVED | Login waived; first-batch probes + stable docs |
| A-4 | PROVED | Four-state registration table |
| A-5 | UNPROVED | Missing durable Desktop/Mobile key-path evidence for chat select / approval / commands / tool details / failure·reconnect UI |
| A-6 | PROVED | Native adapter + account-pool targeted regressions |
| A-7 | PROVED | Isolate evidence `.t3/a7-live-isolate-r59|r62|r64` |
| A-8 | UNPROVED | Blocked by A-5; docs/capability/rollback alone insufficient |

**A-8 must remain unchecked.**

## Next action

Capture Electron + Mobile (AVD OK under phone waiver) interactive evidence for model/mode select, approval, slash commands, tool-detail expand, long content, and visible failure/retry; then re-run a fresh independent audit before considering A-8.
