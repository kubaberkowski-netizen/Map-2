// Stamp a successful run into public.ingest_runs so ingest-health.mjs can flag a
// feed that silently died (expired key, schema change). Never throws.
export async function reportRun(source, upserted = null, ok = true) {
  const url = process.env.SUPABASE_URL || "https://fpngxchltuovtsyzigul.supabase.co";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) return;
  try {
    await fetch(`${url}/rest/v1/ingest_runs?on_conflict=source`, {
      method: "POST",
      headers: { apikey: key, Authorization: "Bearer " + key, "content-type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ source, ran_at: new Date().toISOString(), upserted, ok }),
    });
  } catch { /* health reporting must never break an ingest */ }
}
