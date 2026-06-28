// Flâneur — social push notifications (Supabase Edge Function)
//
// Sends a Web Push to a target user when someone follows them, likes/comments
// on their collection, or sends/accepts a friend request. The ACTOR is taken
// from the caller's JWT (so it can't be spoofed); the TARGET + context come in
// the body. Reuses the push_subscriptions table + service-worker push handler
// from BACKEND.md §10.
//
// Deploy (JWT verification ON — do NOT pass --no-verify-jwt):
//   supabase functions deploy notify-social
//   supabase secrets set VAPID_PUBLIC=<public> VAPID_PRIVATE=<private>
//   # SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected automatically.
//
// Client: window flNotify() (cloud module) calls this best-effort after a
// follow/like/comment/friend action; failures are swallowed.

import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VPUB = Deno.env.get("VAPID_PUBLIC");
const VPRIV = Deno.env.get("VAPID_PRIVATE");
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};
const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "content-type": "application/json" } });

function message(type: string, who: string, name?: string) {
  const handle = who ? "@" + who : "Someone";
  switch (type) {
    case "follow": return { title: "New follower", body: `${handle} started following you on Flâneur.` };
    case "like": return { title: "New like", body: `${handle} liked “${name || "your collection"}”.` };
    case "comment": return { title: "New comment", body: `${handle} commented on “${name || "your collection"}”.` };
    case "friend": return { title: "Friend request", body: `${handle} wants to be friends on Flâneur.` };
    case "friend_accept": return { title: "Friend request accepted", body: `${handle} accepted your friend request.` };
    default: return { title: "Flâneur", body: `${handle} interacted with you.` };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    if (!VPUB || !VPRIV) return json({ error: "VAPID not configured" }, 500);
    const auth = req.headers.get("authorization") || "";
    const token = auth.replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "no auth" }, 401);

    const sb = createClient(SB_URL, SRK, { auth: { persistSession: false } });
    // Identify the actor from their JWT — prevents spoofing who acted.
    const { data: ures, error: uerr } = await sb.auth.getUser(token);
    const actor = ures?.user;
    if (uerr || !actor) return json({ error: "bad token" }, 401);

    const { type, target, name } = await req.json();
    if (!type || !target || target === actor.id) return json({ ok: true, skipped: true });

    // actor's public handle (for the message)
    const { data: prof } = await sb.from("public_profiles").select("username").eq("user_id", actor.id).maybeSingle();
    const who = prof?.username || "";

    // Respect the target's notification preferences and blocks.
    const { data: tprof } = await sb.from("public_profiles").select("notify_prefs").eq("user_id", target).maybeSingle();
    const prefs = (tprof?.notify_prefs ?? {}) as Record<string, unknown>;
    if (prefs[String(type)] === false) return json({ ok: true, muted: true });
    const { data: blk } = await sb.from("blocks").select("blocker_id").eq("blocker_id", target).eq("blocked_id", actor.id).maybeSingle();
    if (blk) return json({ ok: true, blocked: true });

    const { data: subs } = await sb.from("push_subscriptions")
      .select("endpoint, subscription").eq("user_id", target);
    if (!subs || !subs.length) return json({ ok: true, sent: 0 });

    webpush.setVapidDetails("mailto:kuba.berkowski@gmail.com", VPUB, VPRIV);
    const m = message(String(type), who, name);
    const payload = JSON.stringify({ ...m, url: "./", tag: "social" });

    let sent = 0; const gone: string[] = [];
    for (const row of subs) {
      try { await webpush.sendNotification((row as any).subscription, payload); sent++; }
      catch (e: any) { if (e?.statusCode === 404 || e?.statusCode === 410) gone.push((row as any).endpoint); }
    }
    if (gone.length) await sb.from("push_subscriptions").delete().in("endpoint", gone);
    return json({ ok: true, sent, pruned: gone.length });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
