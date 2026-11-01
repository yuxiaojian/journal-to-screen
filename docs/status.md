# Project status

Updated 2026-10-31. Current snapshot; detailed design, numbered ADRs and superseded decisions belong in wiki.md.

## Goal and current behavior
Phase 1 journal MVP is live with AI enabled. One English journal photo produces a literal transcription, deterministic count and suggested minutes; parents can correct text while preserving the original and manually decide Family Link allowance. Uploader sees status only. Tiers: under 50 words = 0 minutes; 50–99 = 45; 100–149 = 60; 150+ = 75. No automatic Family Link integration, reward ledger or writing feedback.

## Tasks and ownership
| Task | Owner | State | Next action |
|---|---|---|---|
| JRN-1 | Implementation | Complete; independent code/live checks, owner flow and final senior checkpoint passed | Closure docs publication |
| JRN-VPREP | Implementation | Reviewed helper published as optional draft PR #3 | Preserve; no additional paid tests planned |
| JRN-DOC | Project lead | Final closure edits prepared | Narrow review, then publish documentation/status PR |
| JRN-BB1 | Senior development | PR #4 owner-merged; independent PR review and CI verification passed | Main-branch CI running |
| JRN-QA | Independent review | Phase 1 aggregate QA passed | Review closure docs and new black-box tests |

Named team assignments are tracked in the private project room. Project status content is maintained by the project lead separately from specialist wiki edits.

## Source, branches and PRs
- Runtime PR #2 merged: https://github.com/yuxiaojian/journal-to-screen/pull/2 . Public main merge d92891d6b44a961020051e654abb80dcea940a22 has reviewed tree 379726f326908cbd47a643bc947512889b42ac90 (runtime reviewed at 33ac0ed; publication head dc985ea).
- Current production: release v10, AI enabled. Deployment-only source 2b8d63e9dd72e9aa270522922c89a7653847b5e6 has the exact reviewed tree above; it preserves existing deployment ancestry and must never be pushed to public GitHub. Runtime deployed in v8; owner key setup v9; project lead enabled AI in v10. No public history rewrite.
- Optional validation helper PR #3: https://github.com/yuxiaojian/journal-to-screen/pull/3 . Branch task/journal-validation at 2e46f81, stacked on preserved task/journal-mvp. Not merged and not required at runtime.
- Black-box tests PR #4: https://github.com/yuxiaojian/journal-to-screen/pull/4 , head 5ad1bba92b2b3d9e8cb4d9fa5d9f745eec99066b. CI run https://github.com/yuxiaojian/journal-to-screen/actions/runs/41266063231 succeeded on the PR merge ref; 87 unit and 33 black-box tests passed with zero failures or skips. Independent remote verification passed; owner merged PR #4 as f4438368e21746707a6140a4d8b8a3089184b7e9. Main-branch CI run: https://github.com/yuxiaojian/journal-to-screen/actions/runs/41267117423 . Documentation branch task/phase1-closure-pm preserves reviewed closure commit 217f977 and merges updated main; exact publication head is recorded in its PR. Preserve existing branches, private history and unrelated working changes.

## Verification evidence
- Runtime: 87 automated tests independently passed on PGlite; implementation runs also passed on PostgreSQL 16 and 18.6. Populated 001-to-002 migration tested; original 37 relay tests passed with the new schema on old code.
- Helper: 54 tests independently passed, including six real pseudo-terminal signal cases; implementation full suite 141 passed on PGlite/PG16/PG18.6. These tests are not yet the requested complete black-box regression suite.
- Owner synthetic API smoke passed 2/2: input 1781 tokens each, output 112 and 86; correct model/structured response. Derived token-rate cost USD 0.0004552, not an invoice guarantee.
- Deployment: migrations 001 and 002 recorded; existing row counts preserved. Independent source/served-byte, HTTPS/HSTS, redirect, insecure POST rejection and unauthenticated access checks passed.
- Owner reported all enabled app flows worked, including notification, photo, transcription, count/suggestion and correction. Independent read-only aggregates corroborated one needs-review analysis, one attempt, one correction, one accepted terminal send, 4916 micro-USD reserved, no queued/processing rows and idle job slot. Phone UI and notification arrival were owner-observed, not independent device QA.

## Decisions and limits
- Haiku remains configured. USD 5 per UTC month is an app-side conservative reservation ceiling, not a guaranteed provider invoice cap; at most two automatic attempts and no post-terminal API retry.
- Seven-day original-upload retention for photos/text and derivatives. Provider retention is separate. No secrets, photos, journal text or private reference samples in git, chat, URLs or logs.
- Owner waived the five-page handwriting accuracy gate on 2026-10-31: accuracy is unverified, never recorded as passed. Suggested minutes may be wrong; parents inspect the photo and decide the allowance.
- Real OS push delivery under offline/Focus/revoked-permission/reinstall scenarios and general handwriting accuracy are not guaranteed by local tests. New black-box tests should automate app-observable behavior, with external services faked and no paid API calls.
- Fresh AI-off uploads use the original immediate photo relay with no analysis row. Disabling AI can leave earlier queued uploads paused without a notice; check the inbox. Re-enabling can resume queued work.
- Migration SQL and its marker are not one transaction. If boot fails after SQL but before marker, inspect and stop; no blind rerun or manual production repair without approval. Rollback preserves additive schema and does not cancel already-accepted provider calls.

## Operations and next actions
The project lead executes future deployments and production configuration changes personally. Explicit owner approval remains required for merge, deploy/release and new paid tests/model changes; no production change is included in the wrap-up work. Existing app stays running. Complete closure-doc publication and independent CI verification, then pause this wrap-up. Camera-first upload and a restrained professional visual refresh are recorded as the next requirements, with design before implementation. Optional helper PR stays separate; no branch deletion or history cleanup authorized.

CI configured in PR #4: GitHub Actions runs all black-box integration tests on pull requests and main pushes, plus manual dispatch. Isolated PostgreSQL/fake external services, no production secrets or paid calls. Require actual successful remote workflow run before JRN-BB1 completion; no repository permission or branch-protection changes authorized.

Known UI finding: a stale parent correction is rejected and the latest text is preserved, but its conflict explanation is immediately cleared. The browser test verifies only the rejection/latest text; a separate fix has not been implemented.
