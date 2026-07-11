// daily-nudge — the two daily pushes that power day-2 retention.
//   ?kind=daily   (morning): today's puzzles / Detour nudge to every subscribed device
//   ?kind=streak  (evening): streak-guard for users with streak>=2 who haven't synced a check-in today
// Deploy:  supabase functions deploy daily-nudge   (or paste in dashboard)
// Secrets: VAPID_PUBLIC / VAPID_PRIVATE (already set if event-reminders works).
// Cron (dashboard → Integrations → Cron, uses pg_cron + pg_net; replace <ref>/<SERVICE_ROLE>):
//   select cron.schedule('daily-nudge-am','0 9 * * *',
//     $$select net.http_post('https://<ref>.supabase.co/functions/v1/daily-nudge?kind=daily',
//       '{}'::jsonb, headers:='{"Authorization":"Bearer <SERVICE_ROLE>"}'::jsonb)$$);
//   select cron.schedule('daily-nudge-pm','0 18 * * *',
//     $$select net.http_post('https://<ref>.supabase.co/functions/v1/daily-nudge?kind=streak',
//       '{}'::jsonb, headers:='{"Authorization":"Bearer <SERVICE_ROLE>"}'::jsonb)$$);
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VPUB = Deno.env.get("VAPID_PUBLIC");
const VPRIV = Deno.env.get("VAPID_PRIVATE");
const sb = createClient(SB_URL, SRK, { auth: { persistSession: false } });
const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
const CAP = 4000; // per-run send ceiling

Deno.serve(async (req) => {
  if (!VPUB || !VPRIV) return json({ error: "VAPID not configured" }, 500);
  webpush.setVapidDetails("mailto:kuba.berkowski@gmail.com", VPUB, VPRIV);
  const kind = new URL(req.url).searchParams.get("kind") || "daily";
  const day = Math.floor(Date.now() / 864e5);

  let targets: Array<{ sub: any; payload: Record<string, string> }> = [];
  if (kind === "streak") {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const { data: profs, error } = await sb
      .from("public_profiles")
      .select("user_id, streak, stats_at")
      .gte("streak", 2)
      .lt("stats_at", today.toISOString());
    if (error) return json({ error: error.message }, 500);
    const ids = (profs || []).map((p) => p.user_id);
    if (!ids.length) return json({ ok: true, kind, sent: 0, targets: 0 });
    const { data: subs } = await sb
      .from("push_subscriptions")
      .select("user_id, endpoint, subscription")
      .in("user_id", ids);
    const sm = new Map((profs || []).map((p) => [p.user_id, p.streak]));
    targets = (subs || []).map((s) => ({
      sub: s,
      payload: {
        title: "🔥 Your " + (sm.get(s.user_id) || 2) + "-day streak is on the line",
        body: "One check-in before midnight keeps it alive.",
        url: "./",
        tag: "streak-" + day,
      },
    }));
  } else {
    const { data: subs, error } = await sb
      .from("push_subscriptions")
      .select("endpoint, subscription")
      .limit(CAP);
    if (error) return json({ error: error.message }, 500);
    const payload = day % 2 === 0
      ? {
        title: "🗺️ Today’s boards are live",
        body: "Five fresh pins, a new plaque, a timeline to untangle — same puzzles for everyone.",
        url: "./#tab=games",
        tag: "daily-" + day,
      }
      : {
        title: "✨ Today’s Detour is waiting",
        body: "A storied place near you, picked for today’s weather.",
        url: "./",
        tag: "daily-" + day,
      };
    targets = (subs || []).map((s) => ({ sub: s, payload }));
  }

  let sent = 0, dead = 0;
  for (const t of targets.slice(0, CAP)) {
    try {
      await webpush.sendNotification(t.sub.subscription, JSON.stringify(t.payload));
      sent++;
    } catch (e) {
      const sc = (e as { statusCode?: number }).statusCode;
      if (sc === 404 || sc === 410) {
        dead++;
        try { await sb.from("push_subscriptions").delete().eq("endpoint", t.sub.endpoint); } catch (_) { /* ignore */ }
      }
    }
  }
  return json({ ok: true, kind, sent, dead, targets: targets.length });
});
