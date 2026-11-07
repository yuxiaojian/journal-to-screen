# Project status

Updated 2026-11-06. Current snapshot; detailed design, numbered ADRs and history are in wiki.md. Maintained by the project lead.

## Current production
**Release v12 is live** (90-day retention, inbox paging, in-page photo viewer; Haiku analysis stays enabled). Deployed source `030321d` maps to tree `77b657a9`, which equals public `main` `8b3d935`. Deployment ancestry must never be pushed to public GitHub. Rollback target is release v11. The parent always decides the actual Family Link allowance. Details are in wiki section 18.

## Tasks
| Task | State | Next |
|---|---|---|
| Phase 1 MVP | Complete and live (since v10) | Preserve operating limits |
| Phase 1 tests/CI | Complete and merged | Keep CI green |
| Phase 2 camera/UI (JRN-P2) | Complete and live (since v11) | Preserve limits below |
| 90-day retention and inbox paging (PR #10) | Live (v12) | See the next row |
| Extend pre-v12 uploads to 90 days | Approved, **not confirmed run** | Run or confirm the one-off; until then those uploads expire after 7 days |
| Photo viewer (PR #11) | Live (v12), **not checked on a real iPhone** | Owner check on the Home Screen app |
| Image download script (PR #10) | Merged, **not run against production** | First production run by the owner |
| Branch protection and Dependabot alerts | On | Review any alerts |

## Evidence
- Main CI run 42338244392 on `8b3d935`: 109 unit tests and 56 black-box scenarios passed, none skipped.
- Release v12: `/healthz` returned 200, the new client code was being served, and startup logs showed no errors with `ai=on`, checked immediately after the release. No post-release database, send or budget check has run.
- Phase 2 evidence and its limits remain in wiki section 17, including that the owner's sign-off gave no per-device detail.

## Known limits
- The camera input uses a browser capture hint; some browsers show a picker instead. The library path is always available.
- Handwriting accuracy was waived by the owner and is unverified, not passed.
- Real OS push delivery and iOS behavior are not automated.
- One service-worker/push test glitch earlier in Phase 2 remains unexplained (its artifact was not kept). The port-collision cause found alongside it is probably a VPN client using the same local port, not proven.
- Reload loses a selected photo by design.
- Photos and transcripts expire 90 days after upload for uploads made since v12; provider retention is separate. Saved copies from the download script never expire.
- Storage has no quota: 11 MB of 1 GB used on 2026-11-06, and sustained uploads above about 5 a day at full size would fill it.
- The download script needs the full parent password; there is no download-only login.
- Branch protection requires a PR and a passing check but no approvals, so it does not enforce owner approval.
- USD 5 per UTC month is an app-side reservation ceiling, not an invoice guarantee.
- Optional helper PR #3 stays unmerged.

## Approvals
The approved one-off to extend pre-v12 uploads is the only production change still outstanding. No other deployment is approved. Production changes need explicit owner approval, and the agent's permission system may require the owner to run them. Preserve unrelated worktrees, branches and private history.
