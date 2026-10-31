-- JRN-1: one analysis per upload; durable job slot; monthly AI budget reservations.
CREATE TABLE journal_analyses (
  id TEXT PRIMARY KEY,
  upload_id TEXT NOT NULL UNIQUE REFERENCES uploads(id) ON DELETE CASCADE,
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('queued','processing','ready','needs_review','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 2), -- two automatic attempts in total; no post-terminal retry
  attempt_token TEXT,
  lease_until TIMESTAMPTZ,
  run_after TIMESTAMPTZ NOT NULL DEFAULT now(),
  error_code TEXT,
  model_id TEXT,
  prompt_version TEXT,
  count_version TEXT,
  transcript TEXT,
  illegible_count INTEGER,
  page_issues TEXT,
  review_flags TEXT,
  word_count INTEGER,
  suggested_minutes INTEGER,
  corrected_transcript TEXT,
  corrected_word_count INTEGER,
  corrected_suggested_minutes INTEGER,
  corrected_flags TEXT,
  corrected_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  corrected_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX journal_analyses_status ON journal_analyses (status, run_after);
CREATE INDEX journal_analyses_family_created ON journal_analyses (family_id, created_at);

-- Aggregate only; no journal content, so it can outlive the 7-day expiry of uploads.
CREATE TABLE ai_budget_months (
  month TEXT PRIMARY KEY,
  reserved_micro INTEGER NOT NULL DEFAULT 0 CHECK (reserved_micro >= 0)
);

-- Single row: a lease that enforces concurrency one across startup, sweep and request claimers.
CREATE TABLE job_slot (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  holder TEXT,
  lease_until TIMESTAMPTZ
);
INSERT INTO job_slot (id) VALUES (1);
