// event-reminders — day-before push for saved events.
// Finds event_saves whose event starts ~24h out and hasn't been reminded yet,
// sends a Web Push to that user's devices, then marks reminded_at so it fires
// once. Reuses the push_subscriptions table + VAPID keys from BACKEND.md §10.
// Runs on a cron (see EVENTS.md §Reminders).
// Deploy:  supabase functions deploy event-reminders   (or paste in dashboard)
// Secrets: VAPID_PUBLIC / VAPID_PRIVATE (already set if push works).
//          SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected automatically.
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VPUB = Deno.env.get("VAPID_PUBLIC");
const VPRIV = Deno.env.get("VAPID_PRIVATE");
const sb = createClient(SB_URL, SRK, { auth: { persistSession: false } });
const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

Deno.serve(async () => {
  if (!VPUB || !VPRIV) return json({ error: "VAPID not configured" }, 500);
  const now = Date.now();
  // Fire for events starting in the next 20–28h (a daily cron covers the day-before slot).
  const from = new Date(now + 20 * 3600e3).toISOString();
  const to = new Date(now + 28 * 3600e3).toISOString();

  const { data: saves, error } = await sb
    .from("event_saves")
    .select("user_id, event_id, reminded_at, events!inner(id, name, start_at, venue)")
    .is("reminded_at", null)
    .gte("events.start_at", from)
    .lte("events.start_at", to);
  if (error) return json({ error: error.message }, 500);
  if (!saves || !saves.length) return json({ ok: true, sent: 0, due: 0 });

  webpush.setVapidDetails("mailto:kuba.berkowski@gmail.com", VPUB, VPRIV);

  let sent = 0;
  const done: Array<{ user_id: string; event_id: string }> = [];
  for (const row of saves as any[]) {
    const ev = row.events;
    const { data: subs } = await sb.from("push_subscriptions")
      .select("endpoint, subscription").eq("user_id", row.user_id);
    if (subs && subs.length) {
      const payload = JSON.stringify({
        title: "Tomorrow: " + (ev.name || "your saved event"),
        body: (ev.venue ? ev.venue + " · " : "") + "Tap for details, directions & tickets.",
        url: "./#event=" + ev.id,
        tag: "event-" + ev.id,
      });
      const gone: string[] = [];
      for (const s of subs as any[]) {
        try { await webpush.sendNotification(s.subscription, payload); sent++; }
        catch (e: any) { if (e?.statusCode === 404 || e?.statusCode === 410) gone.push(s.endpoint); }
      }
      if (gone.length) await sb.from("push_subscriptions").delete().in("endpoint", gone);
    }
    done.push({ user_id: row.user_id, event_id: row.event_id });
  }
  // Mark reminded so each save only fires once.
  const stamp = new Date(now).toISOString();
  for (const d of done) {
    await sb.from("event_saves").update({ reminded_at: stamp })
      .eq("user_id", d.user_id).eq("event_id", d.event_id);
  }
  return json({ ok: true, sent, due: done.length });
});
