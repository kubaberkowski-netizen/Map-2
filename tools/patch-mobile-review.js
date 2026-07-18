#!/usr/bin/env node

/**
 * Guarded fixes for the generated application bundle.
 *
 * The app body in src/app.template.html is intentionally bundled/minified.
 * Keeping these product fixes as exact, labelled replacements makes review
 * practical and makes the build fail if the upstream bundle shape changes.
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
  if (count !== 1) throw new Error(`${label}: expected exactly one source anchor, found ${count}`);
  html = html.replace(needle, replacement);
}

function replaceExpected(label, needle, replacement, expected) {
  const count = occurrences(html, needle);
  if (count !== expected) throw new Error(`${label}: expected ${expected} source anchors, found ${count}`);
  html = html.split(needle).join(replacement);
}

// Bundle Leaflet with the app so the first native launch does not depend on a CDN.
// The CDN integrity metadata must go with the CDN URL: Capacitor's text
// normalizer and the checked-in LF-normalized CSS do not have the CDN bytes, so
// retaining that SRI would make WKWebView reject our trusted same-origin files.
replaceOnce(
  "local Leaflet CSS without stale CDN SRI",
  'i.href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",i.integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=",i.crossOrigin="anonymous"',
  'i.href="./vendor/leaflet/leaflet.css"'
);
replaceOnce("local cluster CSS", '_mcl.href="https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css"', '_mcl.href="./vendor/leaflet-markercluster/MarkerCluster.css"');
replaceOnce(
  "local Leaflet JS without stale CDN SRI",
  'c.src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",c.integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=",c.crossOrigin="anonymous"',
  'c.src="./vendor/leaflet/leaflet.js"'
);
replaceOnce("local cluster JS", '_mc.src="https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js"', '_mc.src="./vendor/leaflet-markercluster/leaflet.markercluster.js"');

// Weather belongs to the selected city/location, not to whichever city loaded first today.
replaceOnce(
  "location-aware weather cache lookup",
  'let day=new Date().toISOString().slice(0,10),cached=await Ae.get("flaneur-weather");if(cached&&cached.value){let p=JSON.parse(cached.value);if(p&&p.date===day){wxs(p);return}}let la=(W&&W.lat)||51.5132,lo=(W&&W.lng)||-.1267,',
  'let day=new Date().toISOString().slice(0,10),la=(W&&W.lat)||51.5132,lo=(W&&W.lng)||-.1267,wkey=cityId+"|"+Math.round(la*20)+"|"+Math.round(lo*20),cached=await Ae.get("flaneur-weather");if(cached&&cached.value){let p=JSON.parse(cached.value);if(p&&p.date===day&&p.key===wkey){wxs(p);return}}let '
);
replaceOnce("weather cache key payload", 'v={date:day,wet:wet,cold:cold,warm:warm,', 'v={date:day,key:wkey,wet:wet,cold:cold,warm:warm,');
replaceOnce(
  "weather refresh dependencies",
  'Ae.set("flaneur-weather",JSON.stringify(v)).catch(()=>{})}catch(_){}})()},[]),(0,r.useEffect)(()=>{if(L!=="cities"||cityWx)return;',
  'Ae.set("flaneur-weather",JSON.stringify(v)).catch(()=>{})}catch(_){}})()},[cityId,Se,Ia&&Math.round(Ia.lat*20),Ia&&Math.round(Ia.lng*20),Math.round(e.lat*20),Math.round(e.lng*20)]),(0,r.useEffect)(()=>{if(L!=="cities"||cityWx)return;'
);

// Selecting a recommendation is pure; recency starts when the detour is actually taken.
replaceOnce(
  "pure daily-detour selection",
  'var _pk=v[(B+DtR)%v.length];try{if(_pk&&_pk.id){var _dl2=JSON.parse(localStorage.getItem("flaneur-dealt")||"{}");_dl2[_pk.id]=Math.floor(Date.now()/864e5);localStorage.setItem("flaneur-dealt",JSON.stringify(_dl2));}}catch(e){}return _pk',
  'var _pk=v[(B+DtR)%v.length];return _pk'
);
replaceOnce(
  "record a taken daily detour",
  'Cg=()=>{Ec();try{navigator.vibrate&&navigator.vibrate([12,40,20])}catch{}ua({t:',
  'Cg=()=>{Ec();try{if(Pa&&Pa.id){var _dl2=JSON.parse(localStorage.getItem("flaneur-dealt")||"{}");_dl2[Pa.id]=Math.floor(Date.now()/864e5);localStorage.setItem("flaneur-dealt",JSON.stringify(_dl2))}}catch(_){}try{window.flHaptic&&window.flHaptic("success")}catch{}ua({t:'
);
replaceOnce('native detour haptic', 'try{navigator.vibrate&&navigator.vibrate(12)}catch{}Ac(i||null,!0,Yi)', 'try{window.flHaptic&&window.flHaptic("light")}catch{}Ac(i||null,!0,Yi)');
replaceOnce('native primary-action haptic', 'if(t&&navigator.vibrate)navigator.vibrate(8)', 'if(t&&window.flHaptic)window.flHaptic("light")');

// Proximity scanning is city-scoped instead of walking the full global catalogue per fix.
replaceOnce(
  "city-scoped proximity current lookup",
  'for(ci=0;ci<Z.length;ci++){if(Z[ci].id===_R.cur){cz=Z[ci];break}',
  'for(ci=0;ci<Zc.length;ci++){if(Zc[ci].id===_R.cur){cz=Zc[ci];break}'
);
replaceOnce("city-scoped proximity nearest loop", 'for(qi=0;qi<Z.length;qi++){var z=Z[qi];', 'for(qi=0;qi<Zc.length;qi++){var z=Zc[qi];');

// The Rome food World previously had zero matching catalogue entries.
replaceOnce(
  "non-empty Rome food World",
  '{id:"rome-bakery",name:"Rome Bakeries & Gelato",cats:["bakery"],e:"🍦",blurb:"Forno to gelateria, the sweet crawl.",city:"rome",match:e=>e.city==="rome"&&["bakery"].includes(e.c)}',
  '{id:"rome-taste",name:"Rome Food & Wine",cats:["food","wine","market","pub"],e:"🍷",blurb:"Market stalls, enoteche and old neighbourhood tables.",city:"rome",match:e=>e.city==="rome"&&["food","wine","market","pub"].includes(e.c)}'
);

// Exploring a World must preserve its exact predicate/IDs, not broaden to category chips.
replaceOnce(
  "weekly World exact filter",
  '_go=()=>{h(new Set(_fw.cats||[])),b(null),Zi(null),Zr(null),Vi(!1),p("list"),I("near")}',
  '_go=()=>{h(new Set),b(null),Zi(_fw.id),Zr(null),Vi(!1),p("list"),I("near")}'
);
replaceOnce(
  "World card exact filter",
  '_go=()=>{h(new Set(i.cats||[])),b(null),Zi(null),Zr(null),Vi(!1),p("list"),I("near")}',
  '_go=()=>{h(new Set),b(null),Zi(i.id),Zr(null),Vi(!1),p("list"),I("near")}'
);

// Destination routes now honour the same World, category, saved, mood, unseen, quality and hours filters.
replaceOnce(
  "destination route filter parity",
  'let cw=[...Zc,...Ie?[]:Jb].filter(Re=>typeof Re.lat=="number");u.size&&(cw=cw.filter(Re=>u.has(Re.c)));',
  'let cw=(Me?[...Zc.filter(Re=>wmem(Me,Re)),...Ie?[]:rb]:[...Zc,...Ie?[]:Jb]).filter(Re=>typeof Re.lat=="number");u.size&&(cw=cw.filter(Re=>u.has(Re.c)));if(w==="saved")cw=cw.filter(Re=>T.has(Re.id));else{cw=cw.filter(no);let _wf=Lw.find(Re=>Re.id===xt);_wf&&(cw=cw.filter(Re=>_wf.cats.includes(Re.c))),nt&&(cw=cw.filter(Re=>!P.has(Re.id)))}sto&&(cw=cw.filter(Qa));opn&&(cw=cw.filter(Re=>flOpenNow(Re.oh)===!0));'
);

// A city trophy is based on the active city's catalogue; global travel trophies stay global.
replaceOnce("city-aware trophies signature", 'var Uu=e=>{', 'var Uu=(e,_cityId)=>{');
replaceOnce(
  "city trophy working sets",
  'n={};for(let D of Z)n[D.id]=D;let l=Z.filter(D=>t.has(D.id)),s=l.length,',
  'n={};for(let D of Z)n[D.id]=D;_cityId=_cityId||"london";let _city=Ci.find(D=>D.id===_cityId)||{id:_cityId,name:_cityId},_citySpots=Z.filter(D=>(D.city||"london")===_cityId),l=Z.filter(D=>t.has(D.id)),_cityVisited=_citySpots.filter(D=>t.has(D.id)),s=l.length,'
);
replaceOnce(
  "city-centred quadrant trophy",
  'f={lat:51.5074,lng:-.1278},m=new Set;for(let D of l)',
  'f={lat:+_city.lat||51.5074,lng:+_city.lng||-.1278},m=new Set,_cityQuadrants=new Set;for(let D of _citySpots)typeof D.lat=="number"&&_cityQuadrants.add((D.lat>=f.lat?"N":"S")+(D.lng>=f.lng?"E":"W"));for(let D of _cityVisited)'
);
replaceOnce('city quadrant copy', '"Visit spots in all four quarters of London (NE/NW/SE/SW)"', '"Visit spots in all four quarters of "+_city.name+" (NE/NW/SE/SW)"');
replaceOnce(
  'attainable city quadrant trophy',
  'V("quad","Compass Rose","\\u{1F9ED}","Milestones",m.size,4,"silver","Visit spots in all four quarters of "+_city.name+" (NE/NW/SE/SW)"),V("catall"',
  '_cityQuadrants.size===4&&V("quad","Compass Rose","\\u{1F9ED}","Milestones",m.size,4,"silver","Visit spots in all four quarters of "+_city.name+" (NE/NW/SE/SW)"),V("catall"'
);
replaceOnce(
  'city category trophy counts',
  'let _cn=Z.filter(z=>z.c===cm[0]&&t.has(z.id)).length;',
  'let _cn=_cityVisited.filter(z=>z.c===cm[0]).length,_ct=_citySpots.filter(z=>z.c===cm[0]).length;'
);
replaceOnce(
  'attainable city category thresholds',
  '[[25,"bronze"],[50,"silver"],[100,"gold"]].forEach(th=>{V("cat-"',
  '[[25,"bronze"],[50,"silver"],[100,"gold"]].forEach(th=>{_ct>=th[0]&&V("cat-"'
);
replaceOnce(
  "city World trophy counts",
  'for(let D of Xr){let U=Z.filter(e=>wmem(D,e)).length;if(U<4)continue;let $e=Z.filter(Le=>wmem(D,Le)&&t.has(Le.id)).length;',
  'for(let D of Xr){if((D.city||"london")!==_cityId)continue;let U=_citySpots.filter(e=>wmem(D,e)).length;if(U<4)continue;let $e=_citySpots.filter(Le=>wmem(D,Le)&&t.has(Le.id)).length;'
);
replaceOnce(
  "city laureate trophy",
  'V("plat","London Laureate","\\u{1F3C6}","Platinum",s,150,"platinum","Visit 150 curated places \\u2014 true mastery of the city")',
  'V("plat",_city.name+" Laureate","\\u{1F3C6}","Platinum",_cityVisited.length,Math.min(150,_citySpots.length),"platinum","Master the curated catalogue of "+_city.name)'
);
replaceOnce(
  "completed-walk city trophy evaluation",
  'Uu({visited:P,verified:O,finds:J,streak:ta,checkinAt:Ct,walks:R}).filter',
  'Uu({visited:P,verified:O,finds:J,streak:ta,checkinAt:Ct,walks:R},cityId).filter'
);
replaceOnce(
  "profile city trophy evaluation",
  'maxPlace:Object.keys(Cic).reduce(function(a,d){return Math.max(a,Cic[d])},0)}),[P,O,J,ta,Ct,Lt,mxb,Cic])',
  'maxPlace:Object.keys(Cic).reduce(function(a,d){return Math.max(a,Cic[d])},0)},cityId),[P,O,J,ta,Ct,Lt,mxb,Cic,cityId])'
);

// Live scan de-duplicates only genuinely co-located names and uses the active city in search text.
replaceOnce('spatial live-scan known list', 'let g=new Set([...Z,...J].map($=>$.n.toLowerCase().trim())),k=', 'let g=[...Z,...J].filter($=>$.n&&typeof $.lat==="number"&&typeof $.lng==="number"),k=');
replaceOnce('city-aware Wikipedia query', 'q:`${Q.title} London`', 'q:`${Q.title} ${cyo.name}`');
replaceOnce('spatial live-scan result list', 'R=new Set,G=$=>{let F=[];', 'R=[],G=$=>{let F=[];');
replaceOnce(
  'spatial live-scan duplicate test',
  'g.has(de)||R.has(de)||(R.add(de),j._d=re(W,j),F.push(j))',
  'g.some(function(_x){return _x.n.toLowerCase().trim()===de&&re(_x,j)<.12})||R.some(function(_x){return _x.n.toLowerCase().trim()===de&&re(_x,j)<.12})||(R.push(j),j._d=re(W,j),F.push(j))'
);

// Walk is a stable home destination, including when re-tapping it from Plan or a child stage.
replaceOnce(
  "bottom-nav Walk reset",
  'I(i==="routes"?((L==="walk"||L==="plan")?L:"walk"):i),\ni==="trophies"&&sysub(null),window.scrollTo(0,0)',
  'i==="routes"&&(Bn(null),ul(Eo?"track":"build"),Eo||setFixedWalk(null)),I(i==="routes"?"walk":i),\ni==="trophies"&&sysub(null),window.scrollTo(0,0)'
);

// Selecting a place must not reorder the scrollable Plan list and throw the user to its top.
replaceOnce(
  "stable Plan suggestion order",
  'var _base=cityspots.filter(function(z){return !_selset[z.id]&&(!(pw.cats&&pw.cats.length)||pw.cats.indexOf(z.c)>=0)}).slice().sort(function(a,b){return pw.base?(re(pw.base,a)-re(pw.base,b)):((b.w||"").length-(a.w||"").length)});var sug=_selsp.concat(_base).slice(0,60);',
  'var _base=cityspots.filter(function(z){return (!(pw.cats&&pw.cats.length)||pw.cats.indexOf(z.c)>=0)}).slice().sort(function(a,b){return pw.base?(re(pw.base,a)-re(pw.base,b)):((b.w||"").length-(a.w||"").length)});var sug=_base.slice(0,60);_selsp.forEach(function(z){sug.some(function(x){return x.id===z.id})||sug.push(z)});'
);

// Accessible state, naming and keyboard parity for core native controls.
replaceOnce(
  "descriptive city control name",
  '"aria-label":"Change city"',
  '"aria-label":"Change city. "+cyo.name+". "+(Se?(Ia?"Live GPS following":"GPS acquiring"):"Using "+e.label)'
);
replaceOnce(
  "LIVE pressed state",
  '"aria-label":"Toggle live GPS"',
  '"aria-label":Se?"Turn off live GPS":"Turn on live GPS","aria-pressed":Se'
);
replaceOnce(
  "status toast live region",
  'aa?r.default.createElement("div",{className:`toast ${aa.win?"win":""}`}',
  'aa?r.default.createElement("div",{className:`toast ${aa.win?"win":""}`,role:"status","aria-live":"polite","aria-atomic":!0}'
);
replaceOnce('error toast alert region', 'n?r.default.createElement("div",{className:"toastnote"},n)', 'n?r.default.createElement("div",{className:"toastnote",role:"alert","aria-live":"assertive"},n)');
replaceOnce('onboarding dialog semantics', 'og?r.default.createElement("div",{className:"onb",onClick:qn}', 'og?r.default.createElement("div",{className:"onb",onClick:qn,role:"dialog","aria-modal":"true","aria-label":"Welcome to Flâneur"}');
replaceExpected('end-walk dialog semantics', 'cfe?r.default.createElement("div",{className:"confirmend",onClick:()=>setCfe(!1)}', 'cfe?r.default.createElement("div",{className:"confirmend",onClick:()=>setCfe(!1),role:"dialog","aria-modal":"true","aria-label":"End this walk?"}', 2);
replaceOnce('level-up dialog semantics', 'lvUp?r.default.createElement("div",{className:"lvupwrap",onClick:function(){setLvUp(null)}}', 'lvUp?r.default.createElement("div",{className:"lvupwrap",onClick:function(){setLvUp(null)},role:"dialog","aria-modal":"true","aria-label":"Level up"}');
replaceOnce('walk-detail dialog semantics', 'Ba?r.default.createElement("div",{className:"spotpop",onClick:()=>Dn(null)}', 'Ba?r.default.createElement("div",{className:"spotpop",onClick:()=>Dn(null),role:"dialog","aria-modal":"true","aria-label":"Walk details"}');
replaceOnce('streak dialog semantics', 'cg?r.default.createElement("div",{className:"spotpop",onClick:()=>ts(!1)}', 'cg?r.default.createElement("div",{className:"spotpop",onClick:()=>ts(!1),role:"dialog","aria-modal":"true","aria-label":"Walking streak"}');
replaceOnce(
  "proximity prompt keyboard activation",
  'className:"proxprompt",role:"button",onClick:function(){',
  'className:"proxprompt",role:"button",tabIndex:0,onKeyDown:function(e){if(e.key==="Enter"||e.key===" "){e.preventDefault();e.currentTarget.click()}},onClick:function(){'
);
replaceOnce('plan country label', 'r.default.createElement("label",null,"Country"),r.default.createElement("select",{className:"wizsel"', 'r.default.createElement("label",{htmlFor:"fl-plan-country"},"Country"),r.default.createElement("select",{id:"fl-plan-country",className:"wizsel"');
replaceOnce('plan city label', 'r.default.createElement("label",null,"City"),r.default.createElement("select",{className:"wizsel"', 'r.default.createElement("label",{htmlFor:"fl-plan-city"},"City"),r.default.createElement("select",{id:"fl-plan-city",className:"wizsel"');
replaceOnce('plan days group name', 'r.default.createElement("div",{className:"wizdays"}', 'r.default.createElement("div",{className:"wizdays",role:"group","aria-label":"Number of days"}');
replaceOnce('plan day selected state', 'className:"wizday"+(pw.days===n?" on":""),onClick:', 'className:"wizday"+(pw.days===n?" on":""),"aria-pressed":pw.days===n,"aria-label":n+(n===1?" day":" days"),onClick:');
replaceOnce('plan category selected state', 'className:"wizcat"+(on?" on":""),onClick:', 'className:"wizcat"+(on?" on":""),"aria-pressed":on,onClick:');
replaceOnce(
  'plan place keyboard activation',
  'className:"wizspot"+(inSel?" on":""),role:"button",onClick:function(){',
  'className:"wizspot"+(inSel?" on":""),role:"button",tabIndex:0,"aria-pressed":inSel,onKeyDown:function(e){if((e.key==="Enter"||e.key===" ")&&e.target===e.currentTarget){e.preventDefault();e.currentTarget.click()}},onClick:function(){'
);

// Native wording points to device settings rather than browser chrome.
replaceOnce(
  "native location permission copy",
  'l("Location permission was blocked. Tap the padlock in your address bar, allow Location, then hit LIVE again \\u2014 or open Map and tap where you are.")',
  'l(window.__FLANEUR_NATIVE__?"Location permission was blocked. Allow Location in your device Settings, then tap LIVE again.":"Location permission was blocked. Tap the padlock in your address bar, allow Location, then hit LIVE again \\u2014 or open Map and tap where you are.")'
);

// Parse each ordinary inline script so a malformed guarded replacement cannot ship.
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
console.log(`✓ mobile review patch applied (${parsed} inline scripts parsed)`);
