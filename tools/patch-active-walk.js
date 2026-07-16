#!/usr/bin/env node

/**
 * Adds crash-safe active-walk persistence to the generated single-file app.
 *
 * The application source is intentionally kept as one generated/minified HTML
 * document. These guarded replacements make the behaviour change reviewable
 * without hand-editing the multi-megabyte generated file. Every anchor must
 * match exactly once; a future source refactor therefore fails the build rather
 * than silently omitting walk recovery.
 */

const fs = require("fs");
const path = require("path");
const acorn = require("acorn");

const ROOT = path.resolve(__dirname, "..");
const INDEX = path.join(ROOT, "index.html");

let html = fs.readFileSync(INDEX, "utf8");

function occurrences(haystack, needle) {
  let count = 0;
  let from = 0;
  while (true) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return count;
    count += 1;
    from = at + needle.length;
  }
}

function replaceOnce(label, needle, replacement) {
  const count = occurrences(html, needle);
  if (count !== 1) {
    throw new Error(`${label}: expected exactly one source anchor, found ${count}`);
  }
  html = html.replace(needle, replacement);
}

function replaceExpected(label, needle, replacement, expected) {
  const count = occurrences(html, needle);
  if (count !== expected) {
    throw new Error(`${label}: expected ${expected} source anchors, found ${count}`);
  }
  html = html.split(needle).join(replacement);
}

replaceOnce(
  "active-walk refs",
  "plRef=(0,r.useRef)(null),prz=(0,r.useRef)(!1),pacc=(0,r.useRef)(0),pps=(0,r.useRef)(0),[Eo,Sc]",
  "plRef=(0,r.useRef)(null),prz=(0,r.useRef)(!1),pacc=(0,r.useRef)(0),pps=(0,r.useRef)(0),awid=(0,r.useRef)(null),awtimer=(0,r.useRef)(null),awbreak=(0,r.useRef)(!1),[Eo,Sc]"
);

replaceOnce(
  "unfinished-walk recovery",
  '(0,r.useEffect)(()=>{(async()=>{try{let i=await Ae.get("flaneur-walks");',
  `(0,r.useEffect)(()=>{let _alive=!0;(async()=>{try{let _raw=null;try{let _rec=await Ae.get(AWK);_raw=_rec&&_rec.value||null}catch(_){}if(!_raw)try{_raw=localStorage.getItem(AWK)}catch(_){}if(!_raw)return;let _d=JSON.parse(_raw),_age=Date.now()-+(_d.updatedAt||_d.startedAt||0);if(!_d||_d.schema!==1||_d.status!=="recording"||!Array.isArray(_d.points)||!_d.startedAt){awClear();return}if(_age>1296e5){awClear();return}if(!_alive)return;let _pts=_d.points.filter(function(_p){return _p&&isFinite(+_p.lat)&&isFinite(+_p.lng)&&isFinite(+_p.t)}).slice(-6000),_mins=Math.max(1,Math.round((Date.now()-_d.startedAt)/6e4));if(window.confirm("Resume the unfinished walk from "+_mins+" minute"+(_mins===1?"":"s")+" ago?")){ss.current=_pts,ds.current=Math.max(0,+_d.distanceKm||0),dl.current=_pts.length?+_pts[_pts.length-1].t:0,is.current=!0,prz.current=!1,pacc.current=Math.max(0,+_d.pausedMs||0),plRef.current=_d.plannedWalkId||null,awid.current={id:_d.sessionId||("aw"+_d.startedAt),startedAt:+_d.startedAt},awbreak.current=!0,Ic(_pts.slice()),Tc(ds.current),bg(+_d.startedAt),Sc(!0),Po(!0);if(Array.isArray(_d.routeStopIds)&&_d.routeStopIds.length){let _rw=_d.routeStopIds.map(function(_id){return Z.find(function(_z){return _z.id===_id})}).filter(Boolean);_rw.length&&setRunw(_rw)}if(_d.cityId&&Ci.some(function(_c){return _c.id===_d.cityId}))setCityId(_d.cityId);I("walk"),Do("Recovered your unfinished walk"),setTimeout(function(){Do("")},3200)}else if(window.confirm("Discard that unfinished walk?"))awClear()}catch(_){}})();return()=>{_alive=!1}},[]),(0,r.useEffect)(()=>{(async()=>{try{let i=await Ae.get("flaneur-walks");`
);

replaceOnce(
  "active-walk persistence helpers",
  'Nc=i=>{Ae.set("flaneur-walks",JSON.stringify(i)).catch(()=>{})},colPut=',
  `AWK="flaneur-active-walk-v1",awClear=()=>{try{awtimer.current&&(clearTimeout(awtimer.current),awtimer.current=null),awid.current=null,localStorage.removeItem(AWK),Ae.set(AWK,"").catch(()=>{})}catch(_){}},awWrite=()=>{try{if(!is.current)return;let _m=awid.current||{},_pts=(ss.current||[]).slice(-6000),_started=+_m.startedAt||+wg||Date.now(),_draft={schema:1,sessionId:_m.id||("aw"+_started),status:"recording",startedAt:_started,updatedAt:Date.now(),points:_pts,distanceKm:Math.max(0,+ds.current||0),pausedMs:Math.max(0,+pacc.current||0),plannedWalkId:plRef.current||null,routeStopIds:(runw||[]).filter(function(_s){return _s&&_s.id}).map(function(_s){return _s.id}),cityId:cityId};let _json=JSON.stringify(_draft);try{localStorage.setItem(AWK,_json)}catch(_){}Ae.set(AWK,_json).catch(()=>{})}catch(_){}},awSave=_force=>{try{if(_force){awtimer.current&&(clearTimeout(awtimer.current),awtimer.current=null),awWrite();return}if(awtimer.current)return;awtimer.current=setTimeout(function(){awtimer.current=null,awWrite()},2500)}catch(_){}},Nc=i=>{let _v=JSON.stringify(i);try{localStorage.setItem("flaneur-walks",_v)}catch(_){}Ae.set("flaneur-walks",_v).catch(()=>{})},colPut=`
);

replaceOnce(
  "walk start checkpoint",
  'Tg=()=>{Se||Po(!0),ss.current=[],ds.current=0,dl.current=0,is.current=!0,prz.current=!1,pacc.current=0,setPz(!1),setCfe(!1),Ic([]),Tc(0),bg(Date.now()),Sc(!0);try{',
  'Tg=()=>{let _awst=Date.now();Se||Po(!0),ss.current=[],ds.current=0,dl.current=0,is.current=!0,prz.current=!1,pacc.current=0,awid.current={id:"aw"+_awst.toString(36)+"-"+Math.random().toString(36).slice(2,8),startedAt:_awst},awbreak.current=!1,setPz(!1),setCfe(!1),Ic([]),Tc(0),bg(_awst),Sc(!0),awSave(!0);try{'
);

replaceOnce(
  "walk end initial checkpoint",
  'Bg=()=>{is.current=!1,prz.current=!1,setPz(!1),setCfe(!1),Sc(!1);let i=ss.current.slice();',
  'Bg=()=>{awSave(!0),is.current=!1,prz.current=!1,setPz(!1),setCfe(!1),Sc(!1);let i=ss.current.slice();'
);

replaceOnce(
  "walk end distance source",
  'if(i.length<2)return;let c=pw(i),g=',
  'if(i.length<2){awClear();return}let c=Math.max(0,+ds.current||0),g='
);

replaceOnce(
  "walk segment serialization",
  'A=gw(i,90).map(me=>[Math.round(me.lat*1e5)/1e5,Math.round(me.lng*1e5)/1e5]),B=',
  'S=(function(){let _all=[],_cur=[];i.forEach(function(me){me.br&&_cur.length&&(_all.push(_cur),_cur=[]),_cur.push(me)}),_cur.length&&_all.push(_cur);return _all.map(function(_seg){return gw(_seg,90).map(function(me){return[Math.round(me.lat*1e5)/1e5,Math.round(me.lng*1e5)/1e5]})}).filter(function(_seg){return _seg.length})})(),A=[].concat.apply([],S),B='
);

replaceExpected(
  "completed-walk segment field",
  'path:A,spots:B,sel:',
  'path:A,segments:S,spots:B,sel:',
  2
);

replaceOnce(
  "clear draft after completed save",
  'cs(R),Nc(R),setLwk(',
  'cs(R),Nc(R),awClear(),setLwk('
);

replaceOnce(
  "GPS gap segmentation",
  'if(!A||(_d>=_thr&&_spd<=12)){v.push({lat:g.lat,lng:g.lng,t:_now}),ds.current+=_d/1e3,Ic(v.slice()),Tc(ds.current),addCellPt(g.lat,g.lng)}}',
  'if(!A||(_d>=_thr&&_spd<=12)){let _gap=!!A&&(awbreak.current||_dt>120||_dt>30&&_d>500),_pt={lat:g.lat,lng:g.lng,t:_now};_gap&&(_pt.br=1),v.push(_pt),ds.current+=(_gap?0:_d)/1e3,awbreak.current=!1,Ic(v.slice()),Tc(ds.current),addCellPt(g.lat,g.lng),awSave(!1)}}'
);

replaceOnce(
  "visibility checkpoint",
  'var _vis=function(){(typeof document!=="undefined"&&document.hidden)?i():_startW()};try{document.addEventListener("visibilitychange",_vis)}catch(e){}return function(){i();try{document.removeEventListener("visibilitychange",_vis)}catch(e){}}',
  'var _hide=function(){awbreak.current=!!is.current,awSave(!0)},_vis=function(){typeof document!=="undefined"&&document.hidden?(_hide(),i()):_startW()};try{document.addEventListener("visibilitychange",_vis),window.addEventListener("pagehide",_hide)}catch(e){}return function(){i();try{document.removeEventListener("visibilitychange",_vis),window.removeEventListener("pagehide",_hide)}catch(e){}}'
);

replaceOnce(
  "live map segments",
  'if(us&&us.length>1){L.polyline(us.map(function(p){return[p.lat,p.lng]}),{color:"#1F9E5A",weight:4,opacity:.9,lineCap:"round",lineJoin:"round"}).addTo(_g)}',
  'if(us&&us.length>1){let _segs=[],_cur=[];us.forEach(function(p){p.br&&_cur.length&&(_segs.push(_cur),_cur=[]),_cur.push([p.lat,p.lng])}),_cur.length&&_segs.push(_cur),_segs.forEach(function(_seg){_seg.length>1&&L.polyline(_seg,{color:"#1F9E5A",weight:4,opacity:.9,lineCap:"round",lineJoin:"round"}).addTo(_g)})}'
);

replaceOnce(
  "completed map segments",
  'let coords=(Ba.path||[]).filter(c=>Array.isArray(c)&&c.length>1).map(c=>[c[0],c[1]]);coords.length>1&&L.polyline(coords,{color:"#C8372D",weight:4,opacity:.85,lineCap:"round",lineJoin:"round"}).addTo(m);',
  'let segs=(Ba.segments&&Ba.segments.length?Ba.segments:[Ba.path||[]]).map(function(_seg){return(_seg||[]).filter(c=>Array.isArray(c)&&c.length>1).map(c=>[c[0],c[1]])}).filter(function(_seg){return _seg.length}),coords=[];segs.forEach(function(_seg){coords=coords.concat(_seg),_seg.length>1&&L.polyline(_seg,{color:"#C8372D",weight:4,opacity:.85,lineCap:"round",lineJoin:"round"}).addTo(m)});'
);

// Parse every ordinary inline script so a malformed replacement cannot ship.
const scriptRe = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
let match;
let parsed = 0;
while ((match = scriptRe.exec(html))) {
  const attrs = match[1] || "";
  const body = match[2] || "";
  if (!body.trim() || /type=["']application\/(?:ld\+json|json)["']/i.test(attrs)) continue;
  acorn.parse(body, { ecmaVersion: "latest", sourceType: "script", allowAwaitOutsideFunction: true });
  parsed += 1;
}
if (!parsed) throw new Error("no inline application scripts were parsed");

fs.writeFileSync(INDEX, html);
console.log(`✓ active-walk recovery patch applied (${parsed} inline scripts parsed)`);
