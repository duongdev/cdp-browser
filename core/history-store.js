// Pure browsing-history read-model (t103, ADR-0017). Shared by web/server.mjs and
// main.js — neither can import the renderer's ESM, so the matcher is mirrored in
// src/lib/tab-suggest.ts (same duplication pattern as core/notif-mutes.js).
//
// CDP/Edge exposes no History domain, so history is *recorded* from the tab poll:
// visitsFromTabs diffs a /json snapshot into visits, the caller stamps `ts` and
// folds them in with recordVisit. rankHistory serves the New Tab omnibox.
//
// A Visit is { url, title, visitCount, lastVisit }. Ranking is frecency
// (frequency × recency) so a page you open often + recently floats to the top.

const DAY = 24 * 3600_000
const DEFAULT_CAP = 1000

// Diacritic + case fold for Vietnamese-aware matching. NFD strips tone/diacritic
// combining marks; đ/Đ don't decompose so they're replaced explicitly.
function fold(s) {
  return (s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
}

// Only real web pages get remembered — no blank/internal/non-http schemes.
function isHistoryableUrl(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url)
}

// Frecency: visits weighted by recency. A fresh page (age 0) keeps full weight; an
// old one decays toward zero. Simple 1/(1+ageDays) decay — enough to order suggestions.
function frecencyScore(visit, now) {
  const ageDays = Math.max(0, now - visit.lastVisit) / DAY
  return visit.visitCount * (1 / (1 + ageDays))
}

// Fold a visit into the store: dedup by url (bump count + recency, keep newest
// non-empty title), else prepend. Caps to the lowest-frecency entries. Immutable.
function recordVisit(visits, { url, title, ts }, opts = {}) {
  const cap = opts.cap || DEFAULT_CAP
  const now = opts.now != null ? opts.now : ts
  const idx = visits.findIndex((v) => v.url === url)
  let next
  if (idx >= 0) {
    const existing = visits[idx]
    const updated = {
      url,
      title: title || existing.title,
      visitCount: existing.visitCount + 1,
      lastVisit: ts,
    }
    next = visits.slice()
    next[idx] = updated
  } else {
    next = [{ url, title: title || url, visitCount: 1, lastVisit: ts }, ...visits]
  }
  if (next.length > cap) {
    next = next
      .slice()
      .sort((a, b) => frecencyScore(b, now) - frecencyScore(a, now))
      .slice(0, cap)
  }
  return next
}

// The New Tab omnibox source: filter by folded query over title + url, order by
// frecency, cap to `limit`. Empty query returns the top-frecency pages.
function rankHistory(visits, { query, now, limit }) {
  const q = fold(query)
  const matched = q
    ? visits.filter((v) => fold(v.title).includes(q) || fold(v.url).includes(q))
    : visits.slice()
  matched.sort((a, b) => frecencyScore(b, now) - frecencyScore(a, now))
  return matched.slice(0, limit)
}

// Diff a /json tab snapshot against the last-seen url per tab. A tab whose url is
// new (or changed) yields one visit; unchanged and non-historyable tabs are skipped.
// Returns the changed {url,title} pairs (caller stamps ts) + the next per-tab map.
function visitsFromTabs(prevByTab, tabs) {
  const changed = []
  const next = {}
  for (const t of tabs) {
    if (!isHistoryableUrl(t.url)) continue
    next[t.id] = t.url
    if (prevByTab[t.id] !== t.url) changed.push({ url: t.url, title: t.title || "" })
  }
  return { changed, next }
}

module.exports = {
  fold,
  isHistoryableUrl,
  frecencyScore,
  recordVisit,
  rankHistory,
  visitsFromTabs,
}
