# journal-to-screen

A proof of concept for a Web Push notification relay: a photo uploaded from one
phone produces a generic notification on a parent's iPhone Home Screen app, and
tapping it opens the photo behind a login.

**Scope.** Notification and private-photo relay only. It contains no AI, no
journal reading or grading, no reward ledger and no Family Link or
Google-account integration.

**Stack.** Node 22, Express, one Postgres database, Web Push. See
[`docs/wiki.md`](docs/wiki.md) for the design, decisions, test evidence and the
run, deploy and rollback guide, and [`.env.example`](.env.example) for
configuration.

**Quick start.** `npm ci`, then `npm test`. Create users with the private
local helper `npm run seed:local` (hashes only are sent to the server).

Licensed under the [MIT License](LICENSE).
