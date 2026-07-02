// Send daily push reminders to subscribed users. Runs in GitHub Actions on a
// schedule — see .github/workflows/send-reminders.yml. No terminal needed.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VAPID_PUBLIC, VAPID_PRIVATE
//
// The push names a SPECIFIC "detour of the day" (name + writeup hook) rather than
// a generic "missions are live" ping — a concrete, enticing habit trigger (UX
// review Task D). It is date-seeded so every subscriber gets the same pick each
// day (Wordle-style, consistent + shareable). We draw only from quality writeups
// (authored or reference-sourced, non-empty hook) in the densest city (London),
// since push_subscriptions carries no per-user city yet — a fuller per-user
// city/streak personalisation needs a schema + client change (noted in BACKEND.md).
import webpush from "web-push";
import fs from "node:fs";

// Pick today's detour from the committed catalogue (repo is checked out in CI).
function pickDetour() {
  try {
    const spots = JSON.parse(fs.readFileSync(new URL("../data/spots.json", import.meta.url)));
    let good = null;
    try {
      const q = JSON.parse(fs.readFileSync(new URL("../data/quality.json", import.meta.url)));
      good = { flags: q.flags || {}, notable: new Set(q.notable || []) };
    } catch { /* no quality file — fall back to length heuristic below */ }
    const cands = spots.filter((z) => {
      if (z.city !== "london") return false;
      const hook = (z.s || "").trim();
      if (hook.length < 12) return false;               // needs a usable one-liner
      if (good) { const f = good.flags[z.id]; return f === "a" || f === "v" || good.notable.has(z.id); }
      return (z.w || "").length > 160;                  // fallback: substantial writeup
    });
    if (!cands.length) return null;
    cands.sort((a, b) => String(a.id).localeCompare(String(b.id))); // stable order
    const day = Math.floor(Date.now() / 864e5);          // days since epoch (UTC)
    const pick = cands[day % cands.length];
    return { id: pick.id, name: pick.n, hook: (pick.s || "").trim(), area: (pick.a || "").trim() };
  } catch { return null; }
}

const SB_URL = process.env.SUPABASE_URL || "https://fpngxchltuovtsyzigul.supabase.co";
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PUB = process.env.VAPID_PUBLIC;
const PRIV = process.env.VAPID_PRIVATE;

if (!SB_KEY || !PUB || !PRIV) {
  console.error("Missing SUPABASE_SERVICE_ROLE_KEY / VAPID_PUBLIC / VAPID_PRIVATE.");
  process.exit(1);
}
webpush.setVapidDetails("mailto:kuba.berkowski@gmail.com", PUB, PRIV);

const headers = { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY };
const res = await fetch(`${SB_URL}/rest/v1/push_subscriptions?select=endpoint,subscription`, { headers });
if (!res.ok) { console.error("Fetch subscriptions failed:", res.status, await res.text()); process.exit(1); }
const subs = await res.json();

const detour = pickDetour();
const payload = JSON.stringify(
  detour
    ? {
        title: "Today's detour",
        body: detour.hook
          ? `${detour.name} — ${detour.hook}`
          : `${detour.name}${detour.area ? " · " + detour.area : ""}`,
        url: "./#spot=" + encodeURIComponent(detour.id), // deep-link straight to the place
        tag: "daily",
      }
    : {
        title: "Flâneur",
        body: "New daily missions are live — keep your streak alive.",
        url: "./",
        tag: "daily",
      }
);
console.log(detour ? `Detour of the day: ${detour.name}` : "No detour pick — using generic body.");

let sent = 0;
const gone = [];
for (const row of subs) {
  try { await webpush.sendNotification(row.subscription, payload); sent++; }
  catch (e) { if (e.statusCode === 404 || e.statusCode === 410) gone.push(row.endpoint); }
}
// prune expired subscriptions
for (const ep of gone) {
  await fetch(`${SB_URL}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(ep)}`, { method: "DELETE", headers });
}
console.log(`Sent ${sent}, pruned ${gone.length}, of ${subs.length} subscriptions.`);
