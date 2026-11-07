# journal-to-screen

A private family app: a photo of a handwritten journal page uploaded from one
phone produces a generic notification on a parent's iPhone Home Screen app, and
tapping it opens the photo behind a login. Photos and transcripts expire after
90 days.

**Scope.** A private photo relay with Web Push notices, plus an optional,
disabled-by-default journal reading step: one English handwritten page is
transcribed literally by a configurable Anthropic model, the server counts the
words and suggests a time tier, and a parent can correct the text and decides
the final time. There is no grading, writing feedback or reward ledger, and no
Family Link or Google-account integration. Nothing calls a model unless
`AI_ENABLED=1`, an API key and a priced model are all configured.

**Stack.** Node 22, Express, one Postgres database, Web Push. See
[`docs/wiki.md`](docs/wiki.md) for the design, decisions, test evidence and the
run, deploy and rollback guide, and [`.env.example`](.env.example) for
configuration.

**Quick start.** `npm ci`, then `npm test`. The black-box integration suite
(real server, real PostgreSQL 18 in Docker, headless Chromium, fake AI and push) runs with
`npx playwright install chromium` once, then `npm run test:bb`; `npm run test:all` runs both,
as CI does on every pull request. Create users with the private
local helper `npm run seed:local` (hashes only are sent to the server).

**Saving photos.** `npm run download:images` signs in as a parent and saves any
photos the output folder lacks to your own machine. It needs `JOURNAL_USERNAME`,
`JOURNAL_PASSWORD` and `JOURNAL_URL`; pass `--out <folder>` to choose where they go.

Licensed under the [MIT License](LICENSE).
