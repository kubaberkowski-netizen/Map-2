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
  "plRef=(0,r.useRef)(null),prz=(0,r.useRef)(!1),pacc=(0,r.useRef)(0),pps=(0,r.useRef)(0),awid=(0,r.useRef)(null),awtimer=(0,r.useRef)(null),awbreak=(0,r.useRef)(!1),awnative=(0,r.useRef)(!1),awlistener=(0,r.useRef)(null),awctx=(0,r.useRef)(\"\"),awfin=(0,r.useRef)(!1),awroute=(0,r.useRef)(null),awconsume=(0,r.useRef)(null),awelapsed=(0,r.useRef)(null),[Eo,Sc]"
);

replaceOnce(
  "unfinished-walk recovery",
  '(0,r.useEffect)(()=>{(async()=>{try{let i=await Ae.get("flaneur-walks");',
  `(0,r.useEffect)(()=>{let _alive=!0;(async()=>{try{let _raw=null,_d=null;try{let _rec=await Ae.get(AWK);_raw=_rec&&_rec.value||null}catch(_){}if(!_raw)try{_raw=localStorage.getItem(AWK)}catch(_){}if(_raw)try{_d=JSON.parse(_raw)}catch(_){}let _np=awPlugin();if(_np){try{let _h=await _np.addListener("walkUpdate",function(_ev){if(!_alive)return;let _ns=_ev&&_ev.snapshot||_ev;_ns&&_ns.sessionId&&(awnative.current=!0,awConsume(_ns))});awlistener.current=_h}catch(_){}try{let _ns=await _np.snapshot({});if(_ns&&_ns.sessionId){if(!_alive)return;let _meta=_d&&_d.sessionId===_ns.sessionId?_d:{},_st=+_ns.startedAt||+_meta.startedAt||Date.now();awnative.current=!0,awid.current={id:_ns.sessionId,startedAt:_st},plRef.current=_meta.plannedWalkId||null,awbreak.current=!0,is.current=!0,awConsume(_ns),bg(_st),Sc(!0),Po(!0);if(Array.isArray(_meta.routeStopIds)&&_meta.routeStopIds.length){let _rw=_meta.routeStopIds.map(function(_id){return Z.find(function(_z){return _z.id===_id})}).filter(Boolean);_rw.length&&setRunw(_rw)}if(_meta.cityId&&Ci.some(function(_c){return _c.id===_meta.cityId}))setCityId(_meta.cityId);I("walk");if(_ns.status==="stopped")Do("Saving the walk ended from your Lock Screen…");else{Do(_ns.status==="paused"?"Paused walk restored":"Background walk restored"),setTimeout(function(){Do("")},3200)}return}}catch(_){}}if(!_d)return;let _age=Date.now()-+(_d.updatedAt||_d.startedAt||0);if(!_d||_d.schema!==1||["recording","paused"].indexOf(_d.status)<0||!Array.isArray(_d.points)||!_d.startedAt){awClear();return}if(_age>1296e5){awClear();return}if(_d.sessionId){let _doneRaw=null;try{let _doneRec=await Ae.get("flaneur-walks");_doneRaw=_doneRec&&_doneRec.value||null}catch(_){}if(!_doneRaw)try{_doneRaw=localStorage.getItem("flaneur-walks")}catch(_){}if(_doneRaw)try{let _done=JSON.parse(_doneRaw);if(Array.isArray(_done)&&_done.some(function(_w){return _w&&_w.sessionId===_d.sessionId})){awClear();return}}catch(_){}}if(!_alive)return;let _pts=_d.points.filter(function(_p){return _p&&isFinite(+_p.lat)&&isFinite(+_p.lng)&&isFinite(+_p.t)}).slice(-6000),_mins=Math.max(1,Math.round((Date.now()-_d.startedAt)/6e4));if(window.confirm("Resume the unfinished walk from "+_mins+" minute"+(_mins===1?"":"s")+" ago?")){ss.current=_pts,ds.current=Math.max(0,+_d.distanceKm||0),dl.current=_pts.length?+_pts[_pts.length-1].t:0,is.current=!0,prz.current=_d.status==="paused",pacc.current=Math.max(0,+_d.pausedMs||0),pps.current=prz.current?Date.now():0,plRef.current=_d.plannedWalkId||null,awid.current={id:_d.sessionId||("aw"+_d.startedAt),startedAt:+_d.startedAt},awbreak.current=!0,Ic(_pts.slice()),Tc(ds.current),bg(+_d.startedAt),setPz(prz.current),Sc(!0),Po(!0);if(Array.isArray(_d.routeStopIds)&&_d.routeStopIds.length){let _rw=_d.routeStopIds.map(function(_id){return Z.find(function(_z){return _z.id===_id})}).filter(Boolean);_rw.length&&setRunw(_rw)}if(_d.cityId&&Ci.some(function(_c){return _c.id===_d.cityId}))setCityId(_d.cityId);I("walk"),Do("Recovered your unfinished walk"),setTimeout(function(){Do("")},3200)}else if(window.confirm("Discard that unfinished walk?"))awClear()}catch(_){}})();return()=>{_alive=!1;let _h=awlistener.current;awlistener.current=null;try{_h&&_h.remove&&_h.remove()}catch(_){}}},[]),(0,r.useEffect)(()=>{awnative.current&&awSyncContext()}),(0,r.useEffect)(()=>{(async()=>{try{let i=await Ae.get("flaneur-walks");`
);

replaceOnce(
  "current route ref synchronization",
  '(0,r.useEffect)(()=>{awnative.current&&awSyncContext()})',
  '(0,r.useEffect)(()=>{awroute.current=runw,awconsume.current=awConsume,awnative.current&&awSyncContext()})'
);

replaceOnce(
  "native listener uses latest walk consumer",
  '_ns&&_ns.sessionId&&(awnative.current=!0,awConsume(_ns))',
  '_ns&&_ns.sessionId&&(awnative.current=!0,awconsume.current&&awconsume.current(_ns))'
);

replaceOnce(
  "startup snapshot waits for restored metadata",
  'awbreak.current=!0,is.current=!0,awConsume(_ns),bg(_st)',
  'awbreak.current=!0,is.current=!0,bg(_st)'
);

replaceOnce(
  "startup snapshot deferred latest consume",
  'if(_meta.cityId&&Ci.some(function(_c){return _c.id===_meta.cityId}))setCityId(_meta.cityId);I("walk");if(_ns.status',
  'if(_meta.cityId&&Ci.some(function(_c){return _c.id===_meta.cityId}))setCityId(_meta.cityId);setTimeout(function(){let _c=awconsume.current;_c&&_c(_ns)},0),I("walk");if(_ns.status'
);

replaceExpected(
  "recovered route updates authoritative ref",
  '_rw.length&&setRunw(_rw)',
  '_rw.length&&(awroute.current=_rw,setRunw(_rw))',
  2
);

replaceOnce(
  "active-walk persistence helpers",
  'Nc=i=>{Ae.set("flaneur-walks",JSON.stringify(i)).catch(()=>{})},colPut=',
  `AWK="flaneur-active-walk-v1",awPlugin=()=>{try{return window.Capacitor&&window.Capacitor.Plugins&&window.Capacitor.Plugins.NativeWalkRecorder||null}catch(_){return null}},awPoints=_s=>{try{return((_s&&_s.points)||[]).map(function(_p){let _lat=_p.latitude!=null?_p.latitude:_p.lat,_lng=_p.longitude!=null?_p.longitude:_p.lng,_t=_p.timestamp!=null?_p.timestamp:_p.t,_q={lat:+_lat,lng:+_lng,t:+_t};(_p.startsNewSegment||_p.br)&&(_q.br=1);return _q}).filter(function(_p){return isFinite(_p.lat)&&isFinite(_p.lng)&&isFinite(_p.t)}).slice(-6000)}catch(_){return[]}},awApply=_s=>{try{if(!_s||!_s.sessionId)return;let _m=awid.current;if(_m&&_m.id&&_m.id!==_s.sessionId)return;let _has=Array.isArray(_s.points),_pts=_has?awPoints(_s):(ss.current||[]).slice(-6000),_delta=!_has&&_s.latestPoint?awPoints({points:[_s.latestPoint]})[0]:null;if(_delta){let _last=_pts[_pts.length-1];(!_last||_last.t!==_delta.t)&&(_pts.push(_delta),_pts=_pts.slice(-6000))}let _dm=_s.distanceMeters!=null?+_s.distanceMeters/1e3:+_s.distanceKm||0;awid.current={id:_s.sessionId,startedAt:+_s.startedAt||(_m&&_m.startedAt)||Date.now()},ss.current=_pts,ds.current=Math.max(0,_dm),dl.current=_pts.length?_pts[_pts.length-1].t:0,pacc.current=Math.max(0,+_s.pausedMs||0),prz.current=_s.status==="paused",pps.current=prz.current?Date.now():0,Ic(_pts.slice()),Tc(ds.current),setPz(prz.current);let _lp=_pts[_pts.length-1];_lp&&($u({lat:_lp.lat,lng:_lp.lng}),_s.latestPoint&&_s.latestPoint.accuracy!=null&&Ju(+_s.latestPoint.accuracy));is.current=_s.status!=="stopped",awSave(!1)}catch(_){}},awConsume=_s=>{awApply(_s);if(_s&&_s.status==="stopped"&&!awfin.current){awfin.current=!0,Do("Saving the walk ended from your Lock Screen…"),setTimeout(function(){Bg()},0)}},awItems=()=>{try{let _seen=new Set,_route=(runw||[]).filter(function(_s){return _s&&_s.id&&isFinite(+_s.lat)&&isFinite(+_s.lng)}).map(function(_s,_i){_seen.add(_s.id);return{id:_s.id,name:_s.n||"Walk stop",latitude:+_s.lat,longitude:+_s.lng,category:_s.c||"",emoji:(ne[_s.c]||{}).e||"•",ordinal:_i+1,isRouteStop:!0,isCompleted:O.has(_s.id)||P.has(_s.id)}}),_near=(fa||[]).filter(function(_s){return _s&&_s.id&&!_seen.has(_s.id)&&isFinite(+_s.lat)&&isFinite(+_s.lng)}).slice(0,24).map(function(_s){return{id:_s.id,name:_s.n||"Nearby place",latitude:+_s.lat,longitude:+_s.lng,category:_s.c||"",emoji:(ne[_s.c]||{}).e||"•",isRouteStop:!1,isCompleted:O.has(_s.id)||P.has(_s.id)}});return{routeStops:_route,radarCandidates:_near}}catch(_){return{routeStops:[],radarCandidates:[]}}},awContext=()=>{let _i=awItems();return{routeStops:_i.routeStops,radarCandidates:_i.radarCandidates,rangeM:+Ua||300,lockScreenEnabled:!0}},awSyncContext=()=>{try{if(!awnative.current||!awid.current)return;let _np=awPlugin();if(!_np||!_np.updateContext)return;let _c=awContext(),_sig=JSON.stringify([_c.rangeM,_c.routeStops.map(function(_x){return[_x.id,_x.isCompleted]}),_c.radarCandidates.map(function(_x){return[_x.id,_x.isCompleted]})]);if(_sig===awctx.current)return;awctx.current=_sig,_np.updateContext(Object.assign({sessionId:awid.current.id},_c)).catch(function(){awctx.current=""})}catch(_){}},awClear=()=>{try{awtimer.current&&(clearTimeout(awtimer.current),awtimer.current=null),awid.current=null,awnative.current=!1,awctx.current="",awfin.current=!1,localStorage.removeItem(AWK),Ae.set(AWK,"").catch(()=>{})}catch(_){}},awReadWalks=async()=>{let _raw=null;try{let _rec=await Ae.get("flaneur-walks");_raw=_rec&&_rec.value||null}catch(_){}if(!_raw)try{_raw=localStorage.getItem("flaneur-walks")}catch(_){}if(_raw)try{let _walks=JSON.parse(_raw);if(Array.isArray(_walks))return _walks}catch(_){}return Array.isArray(Lt)?Lt:[]},awWrite=()=>{try{if(!is.current)return;let _m=awid.current||{},_pts=(ss.current||[]).slice(-6000),_started=+_m.startedAt||+wg||Date.now(),_draft={schema:1,sessionId:_m.id||("aw"+_started),status:prz.current?"paused":"recording",native:!!awnative.current,startedAt:_started,updatedAt:Date.now(),points:_pts,distanceKm:Math.max(0,+ds.current||0),pausedMs:Math.max(0,+pacc.current||0),plannedWalkId:plRef.current||null,routeStopIds:(runw||[]).filter(function(_s){return _s&&_s.id}).map(function(_s){return _s.id}),cityId:cityId};let _json=JSON.stringify(_draft);try{localStorage.setItem(AWK,_json)}catch(_){}Ae.set(AWK,_json).catch(()=>{})}catch(_){}},awSave=_force=>{try{awSyncContext();if(_force){awtimer.current&&(clearTimeout(awtimer.current),awtimer.current=null),awWrite();return}if(awtimer.current)return;awtimer.current=setTimeout(function(){awtimer.current=null,awWrite()},2500)}catch(_){}},AwToggle=async()=>{let _resume=!!prz.current,_np=awnative.current&&awPlugin();if(_np)try{let _ns=await(_resume?_np.resume({sessionId:awid.current&&awid.current.id}):_np.pause({sessionId:awid.current&&awid.current.id}));_ns&&awApply(_ns);_resume&&awSyncContext()}catch(_){Do("Couldn’t "+(_resume?"resume":"pause")+" the background recorder"),setTimeout(function(){Do("")},2800);return!1}else _resume?(pacc.current+=Date.now()-pps.current,prz.current=!1,setPz(!1)):(pps.current=Date.now(),prz.current=!0,setPz(!0));return awSave(!0),!0},AwEdit=async()=>{if(!prz.current&&!await AwToggle())return;ul("build"),window.scrollTo(0,0)},Nc=(i,_strict)=>{let _v=JSON.stringify(i),_local=!1;try{localStorage.setItem("flaneur-walks",_v),_local=!0}catch(_){}return Ae.set("flaneur-walks",_v).then(()=>!0).catch(_e=>{if(_strict&&!_local)throw _e;return _local})},colPut=`
);

replaceOnce(
  "verified completed-walk persistence",
  'Nc=(i,_strict)=>{let _v=JSON.stringify(i),_local=!1;try{localStorage.setItem("flaneur-walks",_v),_local=!0}catch(_){}return Ae.set("flaneur-walks",_v).then(()=>!0).catch(_e=>{if(_strict&&!_local)throw _e;return _local})}',
  'Nc=async(i,_strict)=>{let _v=JSON.stringify(i),_local=!1,_primary=!1;try{localStorage.setItem("flaneur-walks",_v),_local=!0}catch(_){}try{await Ae.set("flaneur-walks",_v);let _check=await Ae.get("flaneur-walks");_primary=!!(_check&&_check.value===_v)}catch(_){}if(_strict&&!_primary)throw new Error("Completed walk storage verification failed");return _primary||_local}'
);

replaceOnce(
  "route-ref context source",
  'awItems=()=>{try{let _seen=new Set,_route=(runw||[]).filter',
  'awItems=_rw=>{try{_rw=Array.isArray(_rw)?_rw:awroute.current||runw;let _seen=new Set,_route=(_rw||[]).filter'
);

replaceOnce(
  "route-aware context builder",
  'awContext=()=>{let _i=awItems();',
  'awContext=_rw=>{let _i=awItems(_rw);'
);

replaceOnce(
  "walk context signature helper",
  'lockScreenEnabled:!0}},awSyncContext=()=>{try{',
  'lockScreenEnabled:!0}},awSig=_c=>JSON.stringify([_c.rangeM,_c.routeStops.map(function(_x){return[_x.id,_x.isCompleted]}),_c.radarCandidates.map(function(_x){return[_x.id,_x.isCompleted]})]),awSyncContext=()=>{try{'
);

replaceOnce(
  "walk context signature reuse",
  '_sig=JSON.stringify([_c.rangeM,_c.routeStops.map(function(_x){return[_x.id,_x.isCompleted]}),_c.radarCandidates.map(function(_x){return[_x.id,_x.isCompleted]})]);if(_sig',
  '_sig=awSig(_c);if(_sig'
);

replaceOnce(
  "corridor-complete lock-screen radar catalogue",
  '_near=(fa||[]).filter(function(_s){return _s&&_s.id&&!_seen.has(_s.id)&&isFinite(+_s.lat)&&isFinite(+_s.lng)}).slice(0,24).map(function(_s){return{id:_s.id,name:_s.n||"Nearby place",latitude:+_s.lat,longitude:+_s.lng,category:_s.c||"",emoji:(ne[_s.c]||{}).e||"•",isRouteStop:!1,isCompleted:O.has(_s.id)||P.has(_s.id)}})',
  '_pool=(Zc||[]).filter(function(_s){return _s&&_s.id&&!_seen.has(_s.id)&&isFinite(+_s.lat)&&isFinite(+_s.lng)}),_scored=_pool.map(function(_s){let _best=W&&isFinite(+W.lat)&&isFinite(+W.lng)?re(W,_s):1e9;(_rw||[]).forEach(function(_r){isFinite(+_r.lat)&&isFinite(+_r.lng)&&(_best=Math.min(_best,re(_r,_s)))});return{s:_s,score:_best}}),_pick=(_scored.length>2e3?_scored.slice().sort(function(_a,_b){return _a.score-_b.score}).slice(0,2e3):_scored).map(function(_x){return _x.s}).sort(function(_a,_b){return String(_a.id).localeCompare(String(_b.id))}),_near=_pick.map(function(_s){return{id:_s.id,name:_s.n||"Nearby place",latitude:+_s.lat,longitude:+_s.lng,category:_s.c||"",emoji:(ne[_s.c]||{}).e||"•",isRouteStop:!1,isCompleted:O.has(_s.id)||P.has(_s.id)}})'
);

replaceOnce(
  "stable radar context signature",
  '_c.radarCandidates.map(function(_x){return[_x.id,_x.isCompleted]})',
  '_c.radarCandidates.map(function(_x){return[_x.id,_x.isCompleted]}).sort(function(_a,_b){return String(_a[0]).localeCompare(String(_b[0]))})'
);

replaceOnce(
  "authoritative native elapsed snapshot",
  'let _dm=_s.distanceMeters!=null?+_s.distanceMeters/1e3:+_s.distanceKm||0;awid.current=',
  'let _dm=_s.distanceMeters!=null?+_s.distanceMeters/1e3:+_s.distanceKm||0,_em=_s.elapsedMs!=null?+_s.elapsedMs:_s.elapsedMilliseconds!=null?+_s.elapsedMilliseconds:_s.elapsedSeconds!=null?+_s.elapsedSeconds*1e3:null;_em!=null&&isFinite(_em)&&(awelapsed.current=Math.max(0,_em));awid.current='
);

replaceOnce(
  "recovered native elapsed draft",
  'dl.current=_pts.length?+_pts[_pts.length-1].t:0,is.current=!0,prz.current=',
  'dl.current=_pts.length?+_pts[_pts.length-1].t:0,awelapsed.current=_d.elapsedMs==null?null:Math.max(0,+_d.elapsedMs||0),is.current=!0,prz.current='
);

replaceOnce(
  "persist native elapsed draft",
  'distanceKm:Math.max(0,+ds.current||0),pausedMs:',
  'distanceKm:Math.max(0,+ds.current||0),elapsedMs:awelapsed.current==null?null:Math.max(0,+awelapsed.current||0),pausedMs:'
);

replaceOnce(
  "draft route ref source",
  'routeStopIds:(runw||[]).filter(function(_s)',
  'routeStopIds:(awroute.current||runw||[]).filter(function(_s)'
);

replaceOnce(
  "clear active route ref",
  'awid.current=null,awnative.current=!1,awctx.current="",awfin.current=!1,localStorage.removeItem(AWK)',
  'awid.current=null,awnative.current=!1,awctx.current="",awfin.current=!1,awroute.current=null,localStorage.removeItem(AWK)'
);

replaceOnce(
  "clear native elapsed ref",
  'awfin.current=!1,awroute.current=null,localStorage.removeItem(AWK)',
  'awfin.current=!1,awroute.current=null,awelapsed.current=null,localStorage.removeItem(AWK)'
);

replaceOnce(
  "resume relies on current-route effect",
  ';_ns&&awApply(_ns);_resume&&awSyncContext()}catch(_){',
  ';_ns&&awApply(_ns)}catch(_){'
);

replaceOnce(
  "walk start checkpoint",
  'Tg=()=>{Se||Po(!0),ss.current=[],ds.current=0,dl.current=0,is.current=!0,prz.current=!1,pacc.current=0,setPz(!1),setCfe(!1),Ic([]),Tc(0),bg(Date.now()),Sc(!0);try{',
  'Tg=async()=>{let _awst=Date.now(),_np=awPlugin();Se||Po(!0),ss.current=[],ds.current=0,dl.current=0,is.current=!0,prz.current=!1,pacc.current=0,awnative.current=!!_np,awctx.current="",awid.current={id:"aw"+_awst.toString(36)+"-"+Math.random().toString(36).slice(2,8),startedAt:_awst},awbreak.current=!1,setPz(!1),setCfe(!1),Ic([]),Tc(0),bg(_awst),Sc(!0),awSave(!0);if(_np)try{let _perm=await _np.requestPermissions({});awApply(await _np.start(Object.assign({sessionId:awid.current.id,startedAt:_awst},awContext()))),awSyncContext();let _warn=_perm&&_perm.accuracy==="reduced"?"Precise Location is off — enable it in Settings for a cleaner route":_perm&&_perm.notifications==="denied"?"Recording is on, but notification access is needed for Lock Screen controls":_perm&&_perm.lockScreen==="unavailable"?"Recording is on; Live Activities are disabled in Settings":null;_warn&&(Do(_warn),setTimeout(function(){Do("")},4600))}catch(_e){is.current=!1,Sc(!1),setPz(!1),setCfe(!1);try{await _np.discard({sessionId:awid.current&&awid.current.id})}catch(_){}awClear(),Do(_e&&_e.message?String(_e.message):"Background recording needs location permission"),setTimeout(function(){Do("")},4200);return!1}try{'
);

replaceOnce(
  "reset native elapsed at start",
  'pacc.current=0,awnative.current=!!_np,',
  'pacc.current=0,awelapsed.current=null,awnative.current=!!_np,'
);

replaceOnce(
  "native pending-session start guard",
  'Tg=async()=>{let _awst=Date.now(),_np=awPlugin();Se||Po(!0)',
  'Tg=async()=>{let _awst=Date.now(),_np=awPlugin(),_pending=null;if(_np)try{_pending=await _np.snapshot({})}catch(_){}if(_pending&&_pending.sessionId){let _pst=+_pending.startedAt||Date.now();awnative.current=!0,awid.current={id:_pending.sessionId,startedAt:_pst},is.current=!0,awConsume(_pending),bg(_pst),Sc(!0),Po(!0),I("walk"),Do(_pending.status==="stopped"?"Saving your previous walk first…":"Restoring your active walk…");return!1}Se||Po(!0)'
);

replaceOnce(
  "pending-session guard uses latest consumer",
  'is.current=!0,awConsume(_pending),bg(_pst)',
  'is.current=!0,awconsume.current&&awconsume.current(_pending),bg(_pst)'
);

replaceOnce(
  "native start route argument",
  'Tg=async()=>{let _awst=',
  'Tg=async _route=>{let _awst='
);

replaceOnce(
  "route assignment after pending-session guard",
  'return!1}Se||Po(!0)',
  'return!1}_route=Array.isArray(_route)?_route:[],awroute.current=_route,setRunw(_route.length?_route:null),Se||Po(!0)'
);

replaceOnce(
  "native start exact route context",
  'let _perm=await _np.requestPermissions({});awApply(await _np.start(Object.assign({sessionId:awid.current.id,startedAt:_awst},awContext()))),awSyncContext();',
  'let _perm=await _np.requestPermissions({}),_startContext=awContext(_route);awApply(await _np.start(Object.assign({sessionId:awid.current.id,startedAt:_awst},_startContext))),awctx.current=awSig(_startContext);'
);

replaceOnce(
  "walk end initial checkpoint",
  'Bg=()=>{is.current=!1,prz.current=!1,setPz(!1),setCfe(!1),Sc(!1);let i=ss.current.slice();',
  'Bg=async()=>{awSave(!0);let _np=awnative.current&&awPlugin(),_sid=awid.current&&awid.current.id;_np&&(awfin.current=!0);if(_np)try{let _ns=await _np.stop({sessionId:_sid});_ns&&awApply(_ns)}catch(_e){awfin.current=!1,Do("Couldn’t stop the background recorder — your walk is still safe"),setTimeout(function(){Do("")},4200);return}is.current=!1,prz.current=!1,setPz(!1),setCfe(!1),Sc(!1);let i=ss.current.slice();'
);

replaceOnce(
  "walk end distance source",
  'if(i.length<2)return;let c=pw(i),g=',
  'if(i.length<2){if(_np)try{await _np.discard({sessionId:_sid})}catch(_){}awClear();return}let c=Math.max(0,+ds.current||0),g='
);

replaceOnce(
  "walk end authoritative elapsed source",
  'let c=Math.max(0,+ds.current||0),g=Math.max(0,i[i.length-1].t-i[0].t-pacc.current),k=',
  'let c=Math.max(0,+ds.current||0),g=awnative.current&&awelapsed.current!=null?Math.max(0,+awelapsed.current||0):Math.max(0,i[i.length-1].t-i[0].t-pacc.current),k='
);

replaceOnce(
  "walk segment serialization",
  'A=gw(i,90).map(me=>[Math.round(me.lat*1e5)/1e5,Math.round(me.lng*1e5)/1e5]),B=',
  'S=(function(){let _all=[],_cur=[];i.forEach(function(me){me.br&&_cur.length&&(_all.push(_cur),_cur=[]),_cur.push(me)}),_cur.length&&_all.push(_cur);return _all.map(function(_seg){return gw(_seg,90).map(function(me){return[Math.round(me.lat*1e5)/1e5,Math.round(me.lng*1e5)/1e5]})}).filter(function(_seg){return _seg.length})})(),A=[].concat.apply([],S),B='
);

replaceOnce(
  "fresh completed-walk archive",
  'B=Object.keys(Ct).filter(me=>{let ve=new Date(Ct[me]).getTime();return ve>=k-6e4&&ve<=v+6e4}),R=plRef.current&&Lt.some(x=>x.id===plRef.current)?Lt.map(',
  'B=Object.keys(Ct).filter(me=>{let ve=new Date(Ct[me]).getTime();return ve>=k-6e4&&ve<=v+6e4}),_walks=await awReadWalks(),R=plRef.current&&_walks.some(x=>x.id===plRef.current)?_walks.map('
);

replaceOnce(
  "completed-walk session de-duplication",
  '},...Lt].slice(0,60);cs(R),Nc(R),setLwk(',
  '},..._walks.filter(x=>!_sid||x.sessionId!==_sid)].slice(0,60);cs(R),Nc(R),setLwk('
);

replaceExpected(
  "completed-walk segment and session fields",
  'path:A,spots:B,sel:',
  'sessionId:awid.current&&awid.current.id||null,path:A,segments:S,spots:B,sel:',
  2
);

replaceExpected(
  "completed-walk authoritative route",
  'sel:runw?runw.map(_s=>_s.id):[]',
  'sel:(awroute.current||runw)?(awroute.current||runw).map(_s=>_s.id):[]',
  2
);

replaceOnce(
  "clear draft after completed save",
  'cs(R),Nc(R),setLwk(',
  'cs(R);try{await Nc(R,!0)}catch(_e){cs(_walks),Do("Your walk is safe on this device. Reopen Flâneur to retry saving."),setTimeout(function(){Do("")},5200);return}if(_np)try{await _np.acknowledge({sessionId:_sid})}catch(_e){Do("Walk saved. Recorder cleanup will finish next time Flâneur opens."),setTimeout(function(){Do("")},5200);return}awClear(),setLwk('
);

replaceOnce(
  "GPS gap segmentation",
  'if(!A||(_d>=_thr&&_spd<=12)){v.push({lat:g.lat,lng:g.lng,t:_now}),ds.current+=_d/1e3,Ic(v.slice()),Tc(ds.current),addCellPt(g.lat,g.lng)}}',
  'if(!A||_d>=_thr){if(awnative.current)return;if(A&&_spd>5){awbreak.current=!0;return}let _pause=!!A&&(_dt>120||_dt>30&&_d>500),_gap=!!A&&(awbreak.current||_pause),_pt={lat:g.lat,lng:g.lng,t:_now};_gap&&(_pt.br=1),_pause&&(pacc.current+=Math.max(0,_dt*1e3)),v.push(_pt),ds.current+=(_gap?0:_d)/1e3,awbreak.current=!1,Ic(v.slice()),Tc(ds.current),addCellPt(g.lat,g.lng),awSave(!1)}}'
);

replaceOnce(
  "visibility checkpoint",
  'var _vis=function(){(typeof document!=="undefined"&&document.hidden)?i():_startW()};try{document.addEventListener("visibilitychange",_vis)}catch(e){}return function(){i();try{document.removeEventListener("visibilitychange",_vis)}catch(e){}}',
  'var _hide=function(){awbreak.current=!!is.current&&!awnative.current,awSave(!0),i()},_pull=function(){try{let _np=awnative.current&&awPlugin();_np&&_np.snapshot({}).then(function(_ns){_ns&&awConsume(_ns)}).catch(function(){})}catch(_){}},_vis=function(){typeof document!=="undefined"&&document.hidden?_hide():(_startW(),_pull())};try{document.addEventListener("visibilitychange",_vis),window.addEventListener("pagehide",_hide),window.addEventListener("pageshow",_pull)}catch(e){}return function(){i();try{document.removeEventListener("visibilitychange",_vis),window.removeEventListener("pagehide",_hide),window.removeEventListener("pageshow",_pull)}catch(e){}}'
);

replaceOnce(
  "foreground snapshot uses latest consumer",
  '_np&&_np.snapshot({}).then(function(_ns){_ns&&awConsume(_ns)}).catch(function(){})',
  '_np&&_np.snapshot({}).then(function(_ns){_ns&&awconsume.current&&awconsume.current(_ns)}).catch(function(){})'
);

replaceExpected(
  "native pause and resume controls",
  'onClick:()=>{prz.current?(pacc.current+=Date.now()-pps.current,prz.current=!1,setPz(!1)):(pps.current=Date.now(),prz.current=!0,setPz(!0))}',
  'onClick:AwToggle',
  2
);

replaceOnce(
  "native edit pause control",
  'onClick:()=>{prz.current||(pps.current=Date.now(),prz.current=!0,setPz(!0)),ul("build")\n,window.scrollTo(0,0)\n}',
  'onClick:AwEdit'
);

replaceOnce(
  "route-builder native resume",
  'Eo?(setRunw(_s),ul("track"),prz.current&&(pacc.current+=Date.now()-pps.current,prz.current=!1,setPz(!1))):',
  'Eo?(setRunw(_s),ul("track"),prz.current&&AwToggle()):'
);

replaceOnce(
  "route-builder immediate route ref",
  'Eo?(setRunw(_s),ul("track"),prz.current&&AwToggle()):(setRunw(_s),ul("track"),setAdq(!1),Tg(),Lg())',
  'Eo?(awroute.current=_s,setRunw(_s),ul("track"),prz.current&&AwToggle()):(ul("track"),setAdq(!1),Tg(_s),Lg())'
);

replaceOnce(
  "direct recording defers route reset until after guard",
  'onClick:()=>{setRunw(null),setAdq(!0),Tg()}',
  'onClick:()=>{setAdq(!0),Tg([])}'
);

replaceOnce(
  "lock-screen recording disclosure",
  '"Live location switches on when you start — your route stays on this device."',
  '"Live location switches on when you start. In the mobile app, recording continues while locked and walk status may appear on your Lock Screen. Your route stays on this device."'
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
