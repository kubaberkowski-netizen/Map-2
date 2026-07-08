#!/usr/bin/env node
"use strict";
/* Process web-discovered trending candidates:
   load research/trending/*.json -> geocode-verify (Nominatim) -> dedup vs catalogue
   -> map to existing Ci city by bbox -> write research/new/trending-import.json
   plus research/trending-report.json (unmapped / dropped). ZERO LLM. */
const fs = require("fs"), path = require("path"), https = require("https");
const M = require("./model.js");
const ROOT = path.join(__dirname, "..");
const UA = "FlaneurHarvest/1.0 (map-2 catalogue research; contact via repo)";
const CACHE = path.join(ROOT, "research/.trending-geocache.json");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, "utf8")) : {};
function get(url){return new Promise((res,rej)=>{https.get(url,{headers:{"User-Agent":UA}},r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>res(d));}).on("error",rej);});}
function hav(a,b,c,d){const R=6371000,r=Math.PI/180;const dLat=(c-a)*r,dLng=(d-b)*r;const x=Math.sin(dLat/2)**2+Math.cos(a*r)*Math.cos(c*r)*Math.sin(dLng/2)**2;return 2*R*Math.asin(Math.sqrt(x));}
const norm = s => String(s||"").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"").replace(/[^a-z0-9]+/g,"");
async function geocode(q){
  if(cache[q]) return cache[q];
  const url=`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&addressdetails=0&q=${encodeURIComponent(q)}`;
  let out=null;
  try{ const j=JSON.parse(await get(url)); if(j.length) out={lat:+(+j[0].lat).toFixed(6),lng:+(+j[0].lon).toFixed(6),display:(j[0].display_name||"").slice(0,80)}; }catch(e){}
  cache[q]=out; fs.writeFileSync(CACHE,JSON.stringify(cache)); await sleep(1100); return out;
}

(async()=>{
  const model=M.loadModel();
  const cities=[...model.cityById.values()].filter(c=>c.bbox);
  const inBbox=(lat,lng,b)=>lng>=b[0]&&lng<=b[2]&&lat>=b[1]&&lat<=b[3];
  const cityFor=(lat,lng)=>cities.find(c=>inBbox(lat,lng,c.bbox));
  const Z=JSON.parse(fs.readFileSync(path.join(ROOT,"data/spots.json"),"utf8"));
  const nameCity=new Set(Z.map(z=>z.city+"|"+norm(z.n)));
  const globalNames=new Set(Z.map(z=>norm(z.n)));
  const pts=Z.map(z=>({lat:z.lat,lng:z.lng,n:norm(z.n)}));

  // load candidates
  const dir=path.join(ROOT, process.argv[2]||"research/trending");
  const files=fs.readdirSync(dir).filter(f=>/\.json$/.test(f)&&!/-geocache/.test(f));
  let cands=[];
  for(const f of files){ try{ const arr=JSON.parse(fs.readFileSync(path.join(dir,f),"utf8")); if(Array.isArray(arr)) arr.forEach(c=>cands.push({...c,_src:f})); }catch(e){ console.error("bad file",f); } }
  console.error("loaded",cands.length,"candidates from",files.length,"files");

  const accepted=[], dropped=[], unmapped=[];
  const seenBatch=new Set(); // dedupe within this batch (name+approx city)
  for(const c of cands){
    if(!c.n||!c.city){ dropped.push({n:c.n,why:"missing name/city"}); continue; }
    const provided=(Number.isFinite(c.lat)&&Number.isFinite(c.lng)&&!(c.lat===0&&c.lng===0))?{lat:+c.lat,lng:+c.lng}:null;
    // geocode "name, area, city, country"
    const q=[c.n,c.area,c.city,c.country].filter(Boolean).join(", ");
    const g=await geocode(q);
    let coord=null, how="";
    if(g&&provided){ const d=hav(g.lat,g.lng,provided.lat,provided.lng); if(d<30000){coord=g;how="geo~prov";} else {coord=provided;how="prov(geo-far "+Math.round(d/1000)+"km)";} }
    else if(g){ coord=g; how="geo"; }
    else if(provided){ coord=provided; how="prov(nogeo)"; }
    if(!coord){ dropped.push({n:c.n,city:c.city,why:"no coord"}); continue; }

    // map to city
    const city=cityFor(coord.lat,coord.lng);
    if(!city){ unmapped.push({n:c.n,city:c.city,country:c.country,lat:coord.lat,lng:coord.lng,c:c.c,w:c.w,s:c.s,how}); continue; }

    // dedup vs catalogue
    const nn=norm(c.n);
    if(nameCity.has(city.id+"|"+nn)){ dropped.push({n:c.n,city:city.id,why:"dup name-in-city"}); continue; }
    const near=pts.find(p=>hav(coord.lat,coord.lng,p.lat,p.lng)<150 && (p.n.slice(0,6)===nn.slice(0,6)||p.n===nn));
    if(near){ dropped.push({n:c.n,city:city.id,why:"dup proximity"}); continue; }
    // batch dedup
    const bk=city.id+"|"+nn; if(seenBatch.has(bk)){ dropped.push({n:c.n,city:city.id,why:"dup in-batch"}); continue; } seenBatch.add(bk);

    accepted.push({
      n:c.n, a:c.area||"", c:c.c, city:city.id,
      lat:+coord.lat.toFixed(5), lng:+coord.lng.toFixed(5),
      w:(c.w||"").trim(), s:(c.s||"").slice(0,60), q:c.n+" "+city.name,
      _facts:c.why?[c.why]:[], _sources:c.source?[c.source]:[], confidence:"web",
      _how:how, _src:c._src,
    });
  }
  fs.writeFileSync(path.join(ROOT,"research/new/trending-import.json"), JSON.stringify(accepted.map(({_how,_src,...r})=>r),null,1)+"\n");
  fs.writeFileSync(path.join(ROOT,"research/trending-report.json"), JSON.stringify({accepted:accepted.length,dropped,unmapped,byCity:accepted.reduce((m,r)=>{m[r.city]=(m[r.city]||0)+1;return m;},{})},null,1));
  console.error(`accepted ${accepted.length} | dropped ${dropped.length} | unmapped ${unmapped.length}`);
  const bc=accepted.reduce((m,r)=>{m[r.city]=(m[r.city]||0)+1;return m;},{});
  console.error("top cities:", Object.entries(bc).sort((a,b)=>b[1]-a[1]).slice(0,25).map(([k,v])=>k+":"+v).join(" "));
})();
