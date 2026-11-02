# Project status

Updated 2026-11-01. Current snapshot; detailed design, numbered ADRs and history are in wiki.md. Maintained by the project lead.

## Current production
Phase 1 is complete and live, release v10 with Haiku analysis enabled. Deployed source2b8d63e9dd72e9aa270522922c89a7653847b5e6 maps to reviewed public tree379726f326908cbd47a643bc947512889b42ac90. Deployment ancestry must never be pushed to public GitHub. The owner verified notification, photo, transcription, suggested time and correction. Independent security/source checks and read-only processing/reservation/send aggregates passed. Handwriting accuracy is owner-waived and unverified. Parent always decides the actual Family Link allowance.

## Tasks
| Task | Owner | State | Next |
|---|---|---|---|
| Phase 1 MVP | Implementation/review | Complete and live | Preserve operating limits |
| Phase 1 tests/CI | Senior development/review | Complete and merged | Keep CI green |
| Phase 1 closure docs | Project lead/review | Published and merged in PR5 | Preserve history |
| JRN-P2 camera/UI | Senior development | Round1 fixes passed independent recheck | PR and GitHub CI on the exact head |
| JRN-P2 QA | Independent review | Recheck PASS at2d03921: 103 unit, 53 black-box, original repros 2/2 | Narrow docs audit, then CI evidence |

## Source and evidence
- PRs2,4,5,6 are merged. Main1fd81439c04b276137ae0d5eb744ac31426c848e includes the test race fix. Independent main CI run41272325973 passed89 unit and33 black-box tests on realPG18.6, zero failures/flaky/skips, cleanup succeeded, no artifacts. Earlier failed CI runs remain historical evidence.
- Optional helper PR3 remains unmerged and not required at runtime; no private-page testing planned.
- Phase2 branch task/phase2-camera-ui is based on main1fd81439. Current review candidate2d039213233a9c2b5c748c4794e9231fb7525a71 is not pushed or deployed.
- Initial Phase2 review found a cross-account selected-photo/stale-preparation leak and correction-save failure recovery. Separate fixes reset/fence account state and restore edited text/retry; the original browser reproductions passed 2/2 in the independent recheck of the successor.
- Test startup diagnostics exposed misleading success logging on bind failure. Separate server startup-error and occupied-port regression fixes plus safer harness ports are included. The previous wildcard-shadowing explanation was rejected by observed diagnostics; environment-specific source-port attribution remains probable, not proven. The original service-worker failure remains unexplained because its original artifact was not retained.
- Implementation evidence at2d03921: three consecutive clean full runs, each103/103 unit and53/53 black-box scenarios, zero failure/flaky/skip, cleanup succeeded. Independent recheck PASS: 103/103 unit, 53/53 black-box, original reproductions 2/2, no blockers. Remote CI is pending. Full failed-run logs and diagnostic artifacts are retained locally outside git.

## Phase2 scope and acceptance
Primary native camera action accepts a photo then auto-uploads; library selection retains explicit Upload. Selected file/key live only in memory; retry retains both, cancelled replacement preserves selection, completed/new selection starts a new intent. Single-flight covers resize and network. Account changes clear state and fence stale async work. UI uses restrained navy/slate/off-white, system fonts and external CSS under unchanged CSP; labelled controls, visible focus,44px targets,320px/200percent zoom, responsive photo/text comparison. Correction conflict explanation must stay visible after rerender. No schema/model/dependency/cache change. A small startup listen-error handling change is included following the diagnostic finding.

## Known limits and approvals
Native OS camera/permission/retake behavior needs a later owner-device smoke; headless tests cannot prove it. Browser capture is a hint and may fall back to a picker. Reload loses the photo by design. Real OS push/iOS behavior and general OCR accuracy remain outside local regression guarantees. USD5 per UTC month is an app reservation ceiling, not an invoice guarantee. Seven-day original-upload retention remains; provider retention is separate.

No Phase2 merge or deployment is approved yet. Review and actual green GitHub CI are required before completion; production remains Phase1. The project lead personally executes production changes after explicit owner approval. Preserve unrelated worktrees/branches and private history. No new paid calls are part of Phase2 work.
