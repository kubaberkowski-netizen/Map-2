#!/usr/bin/env node
"use strict";
/*
 * tools/review-server.js — the lighthouse-city writeup review desk.
 *
 * A local, keyboard-driven flow for turning machine writeups (quality flags
 * `d` = draft, `m` = stub) into authored ones, one city per sitting:
 *
 *   node tools/review-server.js            # → http://localhost:5177
 *
 * Pick a city → for each spot you see the photo, hook, current writeup and
 * links out; edit in your own voice (or approve the draft as-is) and the tool
 * writes `w` back to data/spots.json and promotes the flag to `a` in
 * data/quality.json. Authored/verified spots (`a`/`v`) are NEVER queued or
 * touched — the "never touch writeups" rule is enforced here, not just hoped.
 *
 * Shortcuts: ⌘/Ctrl+Enter save & approve · ⌥A approve as-is · ⌥S skip.
 * When you finish a sitting: npm run build, review the diff, commit.
 * Both data files are backed up to data/.review-backup-<ts>/ at server start.
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const ROOT = path.join(__dirname, "..");
const SPOTS = path.join(ROOT, "data", "spots.json");
const QUALITY = path.join(ROOT, "data", "quality.json");
const PORT = +(process.env.PORT || 5177);
const LIGHTHOUSE = ["london", "nyc", "chicago", "losangeles", "sanfrancisco", "tokyo", "paris", "berlin", "warsaw", "sydney", "dublin", "manchester"];

let spots = JSON.parse(fs.readFileSync(SPOTS, "utf8"));
let quality = JSON.parse(fs.readFileSync(QUALITY, "utf8"));
quality.flags = quality.flags || {};
const byId = new Map(spots.map((z) => [z.id, z]));

// one backup per server run — cheap insurance for hand-edited catalogue data
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const BK = path.join(ROOT, "data", ".review-backup-" + stamp);
fs.mkdirSync(BK, { recursive: true });
fs.copyFileSync(SPOTS, path.join(BK, "spots.json"));
fs.copyFileSync(QUALITY, path.join(BK, "quality.json"));

function recount() {
  const c = { a: 0, v: 0, d: 0, m: 0, notable: (quality.notable || []).length };
  for (const id in quality.flags) { const f = quality.flags[id]; if (c[f] != null) c[f]++; }
  quality.counts = c;
}
function persist() {
  recount();
  quality.generated = new Date().toISOString();
  fs.writeFileSync(SPOTS, JSON.stringify(spots, null, 1));
  fs.writeFileSync(QUALITY, JSON.stringify(quality, null, 1).replace(
    /"counts": \{[^}]*\}/, '"counts": ' + JSON.stringify(quality.counts)));
}

function cities() {
  const per = {};
  for (const z of spots) {
    const p = per[z.city] || (per[z.city] = { id: z.city, total: 0, authored: 0, drafts: 0, stubs: 0, photos: 0 });
    p.total++;
    const f = quality.flags[z.id];
    if (f === "a" || f === "v") p.authored++;
    else if (f === "d") p.drafts++;
    else p.stubs++;
    if (z.ph) p.photos++; // present only in built sidecars, not spots.json — stays 0 here, photo shown from photos.json below
  }
  let ph = {};
  try { ph = (JSON.parse(fs.readFileSync(path.join(ROOT, "data", "photos.json"), "utf8")) || {}).photos || {}; } catch (e) { /* optional */ }
  for (const z of spots) if (ph[z.id] && per[z.city]) per[z.city].photos++;
  const list = Object.values(per);
  list.forEach((p) => { p.lighthouse = LIGHTHOUSE.indexOf(p.id) >= 0; });
  list.sort((a, b) => (b.lighthouse - a.lighthouse) || (LIGHTHOUSE.indexOf(a.id) + 1 || 999) - (LIGHTHOUSE.indexOf(b.id) + 1 || 999) || b.total - a.total);
  return { cities: list, photos: ph };
}

function queue(city, ph) {
  const rank = (z) => {
    const f = quality.flags[z.id] || "m";
    return (f === "d" ? 0 : 2) + (ph[z.id] ? 0 : 1); // drafts first, photos first
  };
  return spots
    .filter((z) => z.city === city && !["a", "v"].includes(quality.flags[z.id]))
    .sort((a, b) => rank(a) - rank(b) || (b.w || "").length - (a.w || "").length)
    .map((z) => ({ id: z.id, n: z.n, a: z.a, pc: z.pc, c: z.c, s: z.s, q: z.q, w: z.w, oh: undefined, flag: quality.flags[z.id] || "m", ph: ph[z.id] || null }));
}

const UI = `<!doctype html><meta charset="utf-8"><title>Flâneur review desk</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#F3EEE6;--card:#FAF8F3;--ink:#211C16;--ink3:#8A8073;--red:#C8372D;--line:#E7E0D4;--ok:#1F8A5B}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
.wrap{max-width:760px;margin:0 auto;padding:26px 18px 80px}
h1{font-family:Georgia,serif;font-size:26px;margin:0 0 4px}.sub{color:var(--ink3);font-size:13px;margin-bottom:20px}
.city{display:flex;align-items:center;gap:12px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px 16px;margin-bottom:8px;cursor:pointer}
.city:hover{border-color:var(--red)}.city b{flex:1}.lh{color:var(--red);font-size:11px;font-weight:700;letter-spacing:.08em}
.bar{flex:none;width:160px;height:8px;border-radius:99px;background:var(--line);overflow:hidden}.bar i{display:block;height:100%;background:var(--ok)}
.n{color:var(--ink3);font-size:12.5px;flex:none;width:150px;text-align:right}
.spot{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:20px}
.kick{font:700 11px monospace;letter-spacing:.14em;text-transform:uppercase;color:var(--ink3)}
.name{font-family:Georgia,serif;font-size:24px;margin:2px 0 2px}.meta{color:var(--ink3);font-size:13px;margin-bottom:10px}
img.ph{width:100%;max-height:260px;object-fit:cover;border-radius:12px;margin:8px 0}
textarea{width:100%;min-height:170px;border:1px solid var(--line);border-radius:12px;padding:12px;font:15px/1.55 Georgia,serif;background:#fff;color:var(--ink);resize:vertical}
.row{display:flex;gap:8px;margin-top:12px}
button{border:0;border-radius:11px;padding:12px 16px;font:700 14px inherit;cursor:pointer}
.ok{background:var(--red);color:#fff;flex:2}.asis{background:var(--ink);color:#F3ECDC;flex:1.4}.skip{background:var(--line);color:var(--ink);flex:1}
.links{margin-top:10px;font-size:13px}.links a{color:var(--red);margin-right:14px}
.prog{position:sticky;top:0;background:var(--bg);padding:10px 0;display:flex;align-items:center;gap:10px;font-size:13px;color:var(--ink3)}
.prog .bar{flex:1;width:auto}.back{background:none;border:1px solid var(--line);padding:6px 12px;border-radius:99px;font-weight:700;font-size:12.5px;cursor:pointer}
.flag{display:inline-block;font-size:11px;font-weight:700;border-radius:99px;padding:2px 9px;margin-left:8px;vertical-align:middle}
.fd{background:#FBF1E2;color:#A06A1B}.fm{background:var(--line);color:var(--ink3)}
.done{ text-align:center;padding:60px 0;font-family:Georgia,serif;font-size:22px}
kbd{background:var(--line);border-radius:5px;padding:1px 6px;font-size:11px}
.saved{color:var(--ok);font-weight:700;font-size:13px;min-width:70px;text-align:right}
</style>
<div class="wrap" id="app">Loading…</div>
<script>
var S={view:"cities",cities:[],q:[],i:0,city:null,savedFlash:""};
function esc(x){return String(x==null?"":x).replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})}
function load(){fetch("/api/cities").then(r=>r.json()).then(function(d){S.cities=d.cities;render()})}
function open(c){fetch("/api/queue?city="+encodeURIComponent(c)).then(r=>r.json()).then(function(q){S.view="review";S.city=c;S.q=q;S.i=0;render()})}
function cur(){return S.q[S.i]}
function next(){S.i++;S.savedFlash="";render()}
function save(asis){var z=cur();if(!z)return;var w=asis?z.w:document.getElementById("w").value.trim();if(!w){alert("Writeup is empty");return}
 fetch("/api/save",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:z.id,w:w,flag:"a"})}).then(r=>r.json()).then(function(res){if(res.ok){S.savedFlash="Saved ✓";next()}else alert(res.error||"save failed")})}
function render(){var el=document.getElementById("app");
 if(S.view==="cities"){el.innerHTML='<h1>Review desk</h1><div class="sub">Machine writeups awaiting your voice — lighthouse cities first. Approving promotes a spot to “In the author’s words”.</div>'+S.cities.map(function(c){var done=c.authored,total=c.total,pct=Math.round(done/total*100);return '<div class="city" onclick="open(\\''+esc(c.id)+'\\')"><b>'+esc(c.id)+(c.lighthouse?' <span class="lh">LIGHTHOUSE</span>':'')+'</b><span class="n">'+done+'/'+total+' authored · '+c.photos+' 📷</span><span class="bar"><i style="width:'+pct+'%"></i></span></div>'}).join("");return}
 var z=cur();
 if(!z){el.innerHTML='<div class="done">🎉 '+esc(S.city)+' queue clear.<br><br><button class="back" onclick="S.view=\\'cities\\';load()">← Cities</button><div class="sub" style="margin-top:16px">Now run <kbd>npm run build</kbd>, eyeball the diff, commit.</div></div>';return}
 el.innerHTML='<div class="prog"><button class="back" onclick="S.view=\\'cities\\';load()">←</button><span>'+(S.i+1)+' / '+S.q.length+' · '+esc(S.city)+'</span><span class="bar"><i style="width:'+Math.round(S.i/S.q.length*100)+'%"></i></span><span class="saved">'+S.savedFlash+'</span></div>'
 +'<div class="spot"><div class="kick">'+esc(z.c)+' · '+esc(z.a||"")+(z.pc?' · '+esc(z.pc):'')+'<span class="flag '+(z.flag==="d"?"fd":"fm")+'">'+(z.flag==="d"?"machine draft":"thin stub")+'</span></div>'
 +'<div class="name">'+esc(z.n)+'</div>'
 +(z.s?'<div class="meta">“'+esc(z.s)+'”</div>':'')
 +(z.ph?'<img class="ph" src="'+esc(z.ph)+'" alt="">':'')
 +'<textarea id="w" spellcheck="true">'+esc(z.w||"")+'</textarea>'
 +'<div class="links"><a target="_blank" href="https://www.google.com/search?q='+encodeURIComponent(z.q||z.n)+'">Google</a><a target="_blank" href="https://en.wikipedia.org/w/index.php?search='+encodeURIComponent(z.n)+'">Wikipedia</a><a target="_blank" href="https://www.google.com/search?tbm=isch&q='+encodeURIComponent(z.q||z.n)+'">Images</a></div>'
 +'<div class="row"><button class="ok" onclick="save(false)">Save & approve <kbd>⌘↵</kbd></button><button class="asis" onclick="save(true)">Approve as-is <kbd>⌥A</kbd></button><button class="skip" onclick="next()">Skip <kbd>⌥S</kbd></button></div></div>';
 var t=document.getElementById("w");if(t){t.focus();t.selectionStart=t.selectionEnd=t.value.length}}
document.addEventListener("keydown",function(e){if(S.view!=="review")return;
 if((e.metaKey||e.ctrlKey)&&e.key==="Enter"){e.preventDefault();save(false)}
 else if(e.altKey&&(e.key==="a"||e.key==="å"))
 {e.preventDefault();save(true)}
 else if(e.altKey&&(e.key==="s"||e.key==="ß")){e.preventDefault();next()}});
load();
</script>`;

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const send = (code, body, type) => { res.writeHead(code, { "content-type": type || "application/json" }); res.end(body); };
  if (req.method === "GET" && u.pathname === "/") return send(200, UI, "text/html; charset=utf-8");
  if (req.method === "GET" && u.pathname === "/api/cities") {
    const { cities: list } = cities();
    return send(200, JSON.stringify({ cities: list }));
  }
  if (req.method === "GET" && u.pathname === "/api/queue") {
    const { photos } = cities();
    return send(200, JSON.stringify(queue(u.searchParams.get("city") || "", photos)));
  }
  if (req.method === "POST" && u.pathname === "/api/save") {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on("end", () => {
      try {
        const { id, w, flag } = JSON.parse(raw || "{}");
        const z = byId.get(id);
        if (!z) return send(400, JSON.stringify({ error: "unknown id" }));
        const cf = quality.flags[id];
        if (cf === "a" || cf === "v") return send(400, JSON.stringify({ error: "already authored — refusing to touch" }));
        if (flag !== "a") return send(400, JSON.stringify({ error: "only promotion to 'a' is supported" }));
        if (typeof w === "string" && w.trim()) z.w = w.trim();
        if (!z.w) return send(400, JSON.stringify({ error: "empty writeup" }));
        quality.flags[id] = "a";
        persist();
        return send(200, JSON.stringify({ ok: true }));
      } catch (e) { return send(400, JSON.stringify({ error: String(e.message || e) })); }
    });
    return;
  }
  send(404, JSON.stringify({ error: "not found" }));
});
server.listen(PORT, "127.0.0.1", () => {
  console.log(`Review desk → http://localhost:${PORT}  (backup in ${path.relative(ROOT, BK)})`);
  console.log("When you finish a sitting: npm run build · review the diff · commit.");
});
