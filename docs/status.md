# Project status

Updated 2026-11-02. Current snapshot; detailed design, numbered ADRs and history are in wiki.md. Maintained by the project lead.

## Current production
**Phase 2 is complete and live, release v11** (camera-first upload and refreshed interface; Haiku analysis stays enabled). Deployed source `041eb369` maps to reviewed tree `011a647d`, which equals public `main` `b26a2d7`. Deployment ancestry must never be pushed to public GitHub. Rollback target is release v10 (Phase 1). The parent always decides the actual Family Link allowance.

## Tasks
| Task | State | Next |
|---|---|---|
| Phase 1 MVP | Complete and live (since v10) | Preserve operating limits |
| Phase 1 tests/CI | Complete and merged | Keep CI green |
| Phase 2 camera/UI (JRN-P2) | Complete and live (v11) | Preserve limits below |
| Phase 2 closure docs | This change, pending audit | Audit, then publish |

## Evidence
- Source: Phase 2 merged to `main` (PR #7), then a test-fixture fix (PR #8) gave `main` `b26a2d7`. Main CI run 41388854424 passed on that commit: 103 unit tests and 54 black-box scenarios.
- Independent public QA of the released source passed.
- Owner sign-off: the owner replied exactly "checked. signed off". No device model or per-case details were provided, so native camera behavior is not individually evidenced.
- Senior final closure withdrew the earlier aggregate-check condition. The post-release database, send and budget check **did not run** because the CLI login had expired. It remains optional and unverified. No measured post-release backend proof is claimed.
- Earlier failed CI runs and review rounds remain historical evidence (wiki sections 15 and 16).

## Known limits
- The camera input uses a browser capture hint; some browsers show a picker instead. The library path is always available.
- Handwriting accuracy was waived by the owner and is unverified, not passed.
- Real OS push delivery and iOS behavior are not automated.
- One service-worker/push test glitch earlier in Phase 2 remains unexplained (its artifact was not kept). The port-collision cause found alongside it is probably a VPN client using the same local port, not proven.
- Reload loses a selected photo by design. 90-day original-upload retention applies to uploads made after the change; provider retention is separate.
- USD 5 per UTC month is an app-side reservation ceiling, not an invoice guarantee.
- Optional helper PR #3 stays unmerged.

## Approvals
No further deployment is approved. The project lead executes production changes after explicit owner approval. Preserve unrelated worktrees, branches and private history.
