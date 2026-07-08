#!/usr/bin/env node
"use strict";
/* Turn every unmapped trending candidate into a mappable spot: create a new Ci
   (region) for new towns, or widen an existing city's bbox when the spot fell
   just outside. Edits src/app.template.html in place. */
const fs = require("fs"), path = require("path");
const M = require("./model.js");
const ROOT = path.join(__dirname, "..");

// country name -> ISO2 (for flag emoji)
const ISO = {
 "Spain":"ES","Czech Republic":"CZ","USA":"US","United States":"US","Germany":"DE","Poland":"PL","Kuwait":"KW",
 "Greece":"GR","Maldives":"MV","Taiwan":"TW","Philippines":"PH","Malaysia":"MY","Indonesia":"ID","India":"IN",
 "Iceland":"IS","Mexico":"MX","Curacao":"CW","Colombia":"CO","Montenegro":"ME","Albania":"AL","Georgia":"GE",
 "Peru":"PE","Argentina":"AR","New Zealand":"NZ","Australia":"AU","Japan":"JP","Puerto Rico":"PR","Vietnam":"VN",
 "Croatia":"HR","Portugal":"PT","China":"CN","Thailand":"TH","Kazakhstan":"KZ","North Macedonia":"MK",
 "Guadeloupe":"GP","South Korea":"KR","Canada":"CA","Norway":"NO","Sweden":"SE","Haiti":"HT","Mozambique":"MZ",
 "Azerbaijan":"AZ","Morocco":"MA","Bosnia and Herzegovina":"BA","Uzbekistan":"UZ","Myanmar":"MM","Gibraltar":"GI",
 "United Arab Emirates":"AE","UAE":"AE","Qatar":"QA","Saudi Arabia":"SA","Oman":"OM","Sri Lanka":"LK","Panama":"PA",
 "Guatemala":"GT","Jamaica":"JM","Bolivia":"BO","Egypt":"EG",
};
const flag = c => { const i=ISO[c]; if(!i) return "🏳"; return String.fromCodePoint(...[...i].map(ch=>0x1F1E6+ch.charCodeAt(0)-65)); };
const slugify = s => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"").replace(/[^a-z0-9]+/g,"").slice(0,24);
const esc = s => String(s).replace(/\\/g,"\\\\").replace(/"/g,"\\\"");

const model = M.loadModel();
const existing = new Map([...model.cityById.entries()]);
const r = JSON.parse(fs.readFileSync(path.join(ROOT,"research/trending-report.json"),"utf8"));

// group unmapped by city+country
const groups = {};
for (const u of r.unmapped) { const k=(u.city||"?").trim()+"||"+(u.country||"?").trim(); (groups[k]=groups[k]||[]).push(u); }

let t = fs.readFileSync(path.join(ROOT,"src/app.template.html"),"utf8");
const anchor = `blurb:"Niche, storied detours across the capital."},`;
const newSpecs = [], widens = [];
const usedSlugs = new Set([...existing.keys()]);

for (const [k, arr] of Object.entries(groups)) {
  const [city, country] = k.split("||");
  const lats = arr.map(u=>u.lat), lngs = arr.map(u=>u.lng);
  const clat = lats.reduce((a,b)=>a+b,0)/lats.length, clng = lngs.reduce((a,b)=>a+b,0)/lngs.length;
  let slug = slugify(city);
  // existing city with same slug: only "widen" if the point is plausibly the SAME place
  // (same country region). Guard against homonyms (Liverpool UK vs AU) by distance to city centre.
  if (existing.has(slug)) {
    const c = existing.get(slug);
    const [cLat,cLng] = c.centre;
    const far = arr.some(u=>Math.abs(u.lat-cLat)>3 || Math.abs(u.lng-cLng)>3); // >~300km => homonym
    if (!far) { widens.push({slug, arr}); continue; }
    slug = slug + (ISO[country]||"x").toLowerCase(); // homonym -> new city with country suffix
  }
  // ensure unique
  let s2 = slug, i=2; while (usedSlugs.has(s2)) s2 = slug + i++;
  slug = s2; usedSlugs.add(slug);
  const h = 0.13;
  const bbox = [ +(Math.min(...lngs)-h).toFixed(3), +(Math.min(...lats)-h).toFixed(3), +(Math.max(...lngs)+h).toFixed(3), +(Math.max(...lats)+h).toFixed(3) ];
  const blurb = (arr[0].s || (arr[0].n+" and around")).slice(0,70);
  newSpecs.push({ slug, name:city, e:flag(country), lat:+clat.toFixed(4), lng:+clng.toFixed(4), bbox, blurb, region:1, _country:country });
}

// apply widens to existing city bboxes
for (const w of widens) {
  const c = existing.get(w.slug);
  const b = c.bbox.slice();
  for (const u of w.arr) { b[0]=Math.min(b[0],u.lng-0.03); b[1]=Math.min(b[1],u.lat-0.03); b[2]=Math.max(b[2],u.lng+0.03); b[3]=Math.max(b[3],u.lat+0.03); }
  const nb = b.map(x=>+x.toFixed(3));
  const re = new RegExp(`(\\{id:"${w.slug}",name:"[^"]*",label:"[^"]*",e:"[^"]*",lat:)[-0-9.]+(,lng:)[-0-9.]+(,bbox:)\\[[^\\]]*\\]`);
  if (re.test(t)) { t = t.replace(re, `$1${c.centre[0]}$2${c.centre[1]}$3[${nb.join(",")}]`); }
  else console.error("WIDEN no-match:", w.slug);
}

// insert new Ci
const entries = newSpecs.map(s=>`{id:"${s.slug}",name:"${esc(s.name)}",label:"${esc(s.name)}",e:"${s.e}",lat:${s.lat},lng:${s.lng},bbox:[${s.bbox.join(",")}],blurb:"${esc(s.blurb)}",region:1}`).join(",");
t = t.replace(anchor, anchor+entries+",");
fs.writeFileSync(path.join(ROOT,"src/app.template.html"), t);
fs.writeFileSync(path.join(ROOT,"research/ci-unmapped.json"), JSON.stringify(newSpecs,null,1));
console.error(`widened ${widens.length} existing cities; inserted ${newSpecs.length} new region-cities`);
console.error("widened:", widens.map(w=>w.slug).join(","));
