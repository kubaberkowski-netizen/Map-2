// One-shot: remove all parkrun rows (ext_id 'pr:*') from the events table.
// parkrun data is not licensed for commercial use — see the removal commit.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Delete this file after running.
const SB_URL = process.env.SUPABASE_URL || "https://fpngxchltuovtsyzigul.supabase.co";
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_KEY) { console.error("Missing SUPABASE_SERVICE_ROLE_KEY."); process.exit(1); }
const res = await fetch(`${SB_URL}/rest/v1/events?ext_id=like.pr:*`, {
  method: "DELETE",
  headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, Prefer: "count=exact" },
});
if (!res.ok) { console.error(`delete failed: ${res.status} ${await res.text()}`); process.exit(1); }
const cr = res.headers.get("content-range") || "";
console.log(`Deleted parkrun rows. content-range: ${cr}`);
