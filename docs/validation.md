# Journal reading validation runbook

How to check, on one local machine, that the journal reading code works against the real model and reads handwriting well
enough. Nothing here deploys anything, touches the running service, uses a database, or runs unless the owner types consent.

**Status: nothing in this document has been run against the live service.** Everything below is verified only with a fake
network. The first live call is the first time the request shape meets the real API.

## What the helper is

`node scripts/validate.js` is a small interactive script. It builds the **same request the application builds** (same
prompt, tool, forced tool choice, image re-encoding, model and output limit) and sends it through the same provider code.
A test asserts the bytes are identical for the same image. It imports modules only: **no database, no server, no job loop**,
so it cannot dispatch any stored upload.

| Mode | Command | Network | Key |
|---|---|---|---|
| Dry run (default) | `node scripts/validate.js` | none | not asked |
| Smoke test | `node scripts/validate.js --smoke [--injection]` | up to 2 (or 3) calls | hidden prompt |
| Five pages | `node scripts/validate.js --pages DIR --results FILE` | up to 5 calls | hidden prompt |

## Safety properties (each has a test)

- **Key:** typed into a hidden terminal prompt only. Never an argument, environment variable, file or log line. A key that looks
  like an argument is refused. The prompt refuses a non-terminal and always restores the terminal (Enter, Ctrl-C, Ctrl-D, end
  of input, error, exit).
- **Network:** only `https://api.anthropic.com/v1/messages`, POST, with the configured model and output limit; redirects are
  errors; there is no option or environment variable to change any of this.
- **Spending bound:** at most **8 calls in one consented session** (2 smoke + 1 optional injection + 5 pages). The 8 is per
  session, **not a lifetime total**: a restart is a new session and needs fresh typed consent, and parallel sessions are not
  coordinated, so run one at a time. A slot is used **before** the call is sent, and a timeout, cancel or unknown outcome keeps
  its slot. There are no automatic retries; the first failure stops the session.
- **Checks before the next call:** HTTP status, model echoed, stop reason `tool_use`, token usage present and within the bound,
  output below the maximum. Any miss stops the session. Excess usage can only be detected after that call has been paid for;
  the check prevents a second one.
- **Evidence:** numbers and booleans only. Model text is shown on screen and never saved. No filenames, paths, images, keys or
  raw errors are written.
- **Private files:** page folder and results file must resolve (symlinks included) **outside this repository**; the folder must
  be private (`chmod 700`); results are created mode 600 and never overwritten.

## Cost wording

The helper prints a **planning reservation per call** (currently 4,916 micro-USD, from the price table and worst-case token
bounds, with a 2x margin). It is a planning estimate: **not a provider-enforced cap and not an invoice guarantee.** No per-page
price is claimed. The real figure is whatever the usage numbers in the first calls show; record it afterwards.

## Step 0: preparation (owner)

1. In the Anthropic Console, create a **dedicated key** for this check. Set a monthly spend limit there if the console offers
   one. Do not reuse the key that will later run the service.
2. Do not paste the key anywhere except the hidden prompt.

## Step 1: dry run (anyone, no key)

`node scripts/validate.js` prints the model, limits, call ceiling and, for three synthetic images, the size of the exact request
that would be sent. Expect `endpoint ok=true` and `tool_choice=tool`.

## Step 2: smoke test (owner consent; synthetic images only, no child data)

`node scripts/validate.js --smoke` (add `--injection` for the third call). You will be asked for the key, then to type `yes`,
then to confirm each call.

What passes:

| Image | Expectation |
|---|---|
| Printed three-line text | HTTP 200, one `record_transcript` call, schema valid, **literal text and count match the fixture** (the helper prints the expected count, derived from the production counter). The model may report `not_handwriting` and the status may be `needs_review`; that is fine for printed text. `ready` is **not** required. |
| Blank page | schema valid, **empty text**, `needs_review`, never invented words |
| Injection page (optional) | schema valid; the words on the page are simply counted as words; minutes stay 0 |

Any failure here (for example the API rejecting forced tool choice) is a finding. Stop and report it; do not work around it.

## Step 3: the five-page check (only after the smoke test passes and with a **separate, later** consent)

1. Pick five real pages: one under 50 words, a middle one, one over 150, and at least one near 50, 100 or 150.
2. Put the photos in a private folder outside the repository (`chmod 700`). Next to each photo, a text file with the same base
   name containing **your own transcription** (`page1.jpg` and `page1.txt`). Write the references **before** running; the
   helper counts them with the production counter and prints those counts before any model call, so the model cannot influence them.
3. `node scripts/validate.js --pages /path/to/folder --results /path/outside/repo/result.json`
4. For each page you see the model text on screen and are asked whether the page was clearly legible and whether the model
   invented or rewrote anything.

**Gate (all must hold):** at least 4 of 5 pages within 5 percent of your reference count (a zero reference must match exactly);
no invented or rewritten passage on any accepted page; and on every page you called clear, the suggested-time tier equals the
tier your reference gives. Tier agreement is reported for all pages, because 49 versus 50 words is within 5 percent yet a
different tier.

Five pages are a **feasibility check, not a measurement of general accuracy.** A failed gate means: report the aggregate numbers
and ask for a revised plan. Do not change the model or prompt silently.

## Step 4: evidence and cleanup

- The results file holds, per page: index, reference count, model count, percent error, tier match, a flags count, token counts
  and your two answers. It is safe to share the numbers; do not share the folder.
- Afterwards, delete the page photos, the reference files and the results file when you no longer need them, and **delete the
  key in the Console**. Local deletion does not shorten the provider's own retention (see the privacy section of `wiki.md`).

## What this does not prove

It does not prove the deployed service works (separate approval), that every handwriting will read well, or that phones show
the new screens correctly. A pass allows the next step; it is not release approval.

## Running the service later (separate approval)

Before enabling analysis on any database, list rows still `queued` or `processing`: analyses queued during an earlier
analysis-enabled period can resume when it is turned back on, and migrations do not clear them. The helper never touches a
database, so it cannot dispatch them.
