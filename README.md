# journal-to-screen

A proof of concept for a Web Push notification relay: a photo uploaded from one
phone produces a generic notification on a parent's iPhone Home Screen app, and
tapping it opens the photo behind a login.

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

**Quick start.** `npm ci`, then `npm test`. Create users with the private
local helper `npm run seed:local` (hashes only are sent to the server).

Licensed under the [MIT License](LICENSE).
