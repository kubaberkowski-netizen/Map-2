// Send daily push reminders to subscribed users. Runs in GitHub Actions on a
// schedule — see .github/workflows/send-reminders.yml. No terminal needed.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VAPID_PUBLIC, VAPID_PRIVATE
import webpush from "web-push";

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

const payload = JSON.stringify({
  title: "Flâneur",
  body: "New daily missions are live — keep your streak alive.",
  url: "./",
  tag: "daily",
});

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
