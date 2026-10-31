// Pure journal logic: count_v1, tiers, review rules and strict validation. No I/O.
import { PAGE_ISSUES } from './ai.js';

export const COUNT_VERSION = 'count_v1';
export const BOUNDARIES = [50, 100, 150];
export const NEAR_WORDS = 5;
export const MAX_TRANSCRIPT_CHARS = 20000;

// count_v1: whole transcript (headings included). Curly apostrophes -> '. En/em dashes and slashes split words.
// A word is ASCII letters with optional internal apostrophes/hyphens. Digits, punctuation and [?] count zero.
export function countWordsV1(text) {
  const t = String(text)
    .replace(/[‘’]/g, "'")
    .replace(/[–—/]/g, ' ');
  const m = t.match(/[A-Za-z]+(?:['-][A-Za-z]+)*/g);
  return m ? m.length : 0;
}

export function suggestedMinutes(wordCount) {
  if (wordCount >= 150) return 75;
  if (wordCount >= 100) return 60;
  if (wordCount >= 50) return 45;
  return 0;
}

export const isNearBoundary = (n) => BOUNDARIES.some((b) => Math.abs(n - b) <= NEAR_WORDS);
export const countMarkers = (text) => (String(text).match(/\[\?\]/g) || []).length;

export function reviewFlags({ wordCount, illegibleCount, pageIssues }) {
  const flags = [];
  if (illegibleCount > 0) flags.push('illegible_marker');
  if (pageIssues.length > 0) flags.push('page_issue');
  if (wordCount === 0) flags.push('empty_transcript');
  if (isNearBoundary(wordCount)) flags.push('near_threshold');
  return flags;
}

// A blank, unreadable or unrelated page can never be a confidently complete zero result: it needs review.
export function evaluate({ transcript, illegibleCount, pageIssues }) {
  const wordCount = countWordsV1(transcript);
  const flags = reviewFlags({ wordCount, illegibleCount, pageIssues });
  return { wordCount, minutes: suggestedMinutes(wordCount), flags, status: flags.length ? 'needs_review' : 'ready' };
}

// After a parent correction the page has been reviewed by a person: only advisory flags are recomputed.
export function evaluateCorrection(text) {
  const wordCount = countWordsV1(text);
  const flags = [];
  if (wordCount === 0) flags.push('empty_transcript');
  if (isNearBoundary(wordCount)) flags.push('near_threshold');
  return { wordCount, minutes: suggestedMinutes(wordCount), flags };
}

// eslint-disable-next-line no-control-regex
const BAD_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export function normalizeText(s) {
  return s.replace(/\r\n?/g, '\n').trim();
}

export function validText(s) {
  return typeof s === 'string' && s.length <= MAX_TRANSCRIPT_CHARS && !BAD_CHARS.test(s);
}

// Strict schema for the model's structured output. Anything else is a failure, never a partial result.
export function validateModelOutput(o) {
  const fail = (why) => { throw new Error(`schema:${why}`); };
  if (!o || typeof o !== 'object' || Array.isArray(o)) fail('type');
  const keys = Object.keys(o).sort().join(',');
  if (keys !== 'illegible_count,page_issues,transcript') fail('keys');
  if (!validText(o.transcript)) fail('transcript');
  if (!Number.isInteger(o.illegible_count) || o.illegible_count < 0 || o.illegible_count > 1000) fail('illegible_count');
  if (!Array.isArray(o.page_issues) || o.page_issues.length > 5) fail('page_issues');
  for (const p of o.page_issues) if (!PAGE_ISSUES.includes(p)) fail('page_issue_value');
  if (new Set(o.page_issues).size !== o.page_issues.length) fail('page_issue_dup');
  const transcript = normalizeText(o.transcript);
  if (countMarkers(transcript) !== o.illegible_count) fail('marker_mismatch');
  return { transcript, illegible_count: o.illegible_count, page_issues: [...o.page_issues] };
}
