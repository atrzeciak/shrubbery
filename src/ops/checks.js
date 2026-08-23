// What the site can find out about its own survival. Pure functions plus two HTTP reads, so the cron
// stays a thin caller and every threshold is testable against a fixed clock.

const DAY = 86400;
export const DOMAIN_SOON = 45 * DAY;
export const CARD_SOON = 30 * DAY;
export const BACKUP_STALE = 60 * DAY;
export const CHECK_FAILING = 7 * DAY;
export const CHECKS_STALE = 3 * DAY;

const seconds = (iso) => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
};

// The renewal date comes from wrangler.toml, not from a registry: .eu publishes no RDAP endpoint we
// can rely on, and a lookup that silently stops answering is worse than a date somebody has to retype
// once a year. Anything missing or unparseable is null, and null is reported as domain_unknown.
export function domainRenewsAt(value) {
  return seconds(String(value ?? "").trim());
}

const CF = "https://api.cloudflare.com/client/v4";

async function cfJson(fetchImpl, token, path) {
  // A hung request would freeze ops_status and suppress the monthly letter, which the family would
  // read as the site being dead. Ten seconds, then it becomes an ordinary failing check.
  const res = await fetchImpl(`${CF}${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`cloudflare ${path}: ${res.status}`);
  return res.json();
}

// A card is good to the last moment of its stated month, which is how card expiry has always been read.
function endOfMonth(year, month) {
  if (!year || !month) return null;
  return Math.floor(Date.UTC(year, month, 0, 23, 59, 59) / 1000);
}

// Cloudflare has deprecated /user/billing/profile with no API replacement; their own answer is "log in
// to the dashboard". When it finally disappears this call will start failing, which surfaces as the
// check_failing warning rather than as silence. At that point: delete the card half of this function
// and lean on Cloudflare's dashboard notifications, which are the primary alarm for a failing card
// anyway — do not replace it with a scraper.
export async function billingFacts(fetchImpl, token) {
  const profile = await cfJson(fetchImpl, token, "/user/billing/profile");
  const subs = await cfJson(fetchImpl, token, "/user/subscriptions");
  const card = profile?.result || {};
  const next = (Array.isArray(subs?.result) ? subs.result : [])
    .map((s) => seconds(s.current_period_end))
    .filter((n) => typeof n === "number")
    .sort((a, b) => a - b)[0] ?? null;
  return {
    card_expires_at: endOfMonth(card.card_expiry_year, card.card_expiry_month),
    subscription_renews_at: next,
  };
}

// Keys, not sentences: the UI and the mail render them in the reader's own language.
export function warningsFor(status, now) {
  const out = [];
  const soon = (at, window) => typeof at === "number" && at - now < window;
  // First, because it is the one that discredits the rest: if the daily run has stopped, every date
  // below is whatever was true the last time anybody looked, and the row would otherwise sit there
  // looking calm forever. A row that was never written is the same problem.
  // A row full of nulls is a site that has just been deployed or restored, not one whose cron died:
  // telling somebody standing the site back up that it "stopped working" would be false.
  if (typeof status.checked_at !== "number") out.push("checks_never");
  else if (now - status.checked_at > CHECKS_STALE) out.push("checks_stale");
  // A domain nobody can put a date on is the failure this whole system exists to prevent, so not
  // knowing is itself a warning rather than silence.
  if (typeof status.domain_expires_at !== "number") out.push("domain_unknown");
  else if (soon(status.domain_expires_at, DOMAIN_SOON)) out.push("domain_soon");
  if (soon(status.card_expires_at, CARD_SOON)) out.push("card_soon");
  // The Cloudflare subscription renews monthly, so "renews soon" is true about half of every month.
  // As a warning it kept the banner permanently lit, which is how a real domain warning gets skimmed
  // past. subscription_renews_at is still recorded and still reported, as a fact rather than a task.
  if (typeof status.backup_at !== "number") out.push("backup_never");
  else if (now - status.backup_at > BACKUP_STALE) out.push("backup_stale");
  // Only while it is the most recent word on the subject: a good download afterwards settles it.
  if (typeof status.backup_failed_at === "number" && status.backup_failed_at > (status.backup_at ?? 0)) out.push("backup_failed");
  if (typeof status.error_since === "number" && now - status.error_since > CHECK_FAILING) out.push("check_failing");
  return out;
}
