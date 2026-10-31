# Project status

Current summary, maintained separately from detailed wiki.md. Updated 2026-10-31.

## Goal
One English journal photo becomes a literal transcription, deterministic word count and suggested minutes. Parent corrections preserve the original; the parent manually decides Family Link time. Child sees status only. Tiers: under50=0,50–99=45,100–149=60,150+=75. Anthropic first; USD5/month AI planning ceiling separate hosting; seven-day app retention. No feedback, ledger or automatic Family Link.

## Task state
- JRN-D1: design approved; pre-plan checkpoint and acceptance review complete.
- JRN-1: ready for recheck on task/journal-mvp at33ac0ed11d7664350230818f9249fad9537503ba, successor to6f3a935. Base is merged main b21da708f133786cf16fa0732a453e80f5270e01. No push or PR yet.
- JRN-QA: independent recheck passed at33ac0ed,87/87 PGlite tests. Three earlier P2s resolved: ambiguous-outcome lease retention, response-body deadline, duplicate-before-daily-cap ordering.
- JRN-C: final code-readiness checkpoint pending recheck. Product validation remains separate.

## Evidence
Implementation evidence:87/87 tests on PGlite, local PG16 and PG18.6, including37 POC regressions and populated001-to002 migration. Earlier snapshot independently passed81 tests, with three additional reproduced findings. Successor independently passed87/87 PGlite tests; outgoing two-commit history and56 unique blobs passed publication audit. Fixtures synthetic. No actual provider contact, keys, real pages, accuracy test, new device verification or deployment.

## Decisions and running service
No post-terminal API retries: at most two automatic attempts, no recovery rounds. Paused analysis status added. Existing photo/push POC remains running at release v7, source14a0e153, with one owner-observed successful device flow and documented limits. Public MIT PR1 is merged. Journal changes are not deployed. Preserve original private history and unrelated files.

## Next actions and approval gates
Independent recheck complete. Final code-readiness checkpoint and status-only publication audit pending, then authorized branch push and PR. Do not mark product validated before private API compatibility and five-page handwriting feasibility tests. Owner approval remains required for paid sample testing, merge and deployment. No current owner action blocks local verification. Record private-page results as aggregates only.
