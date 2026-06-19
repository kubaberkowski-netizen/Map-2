"use strict";
/*
 * tools/category-map.js — best-effort OSM-tag → Flâneur category slug guesser.
 *
 * The 44 slugs are an editorial taxonomy, not an OSM ontology, so this only
 * fires when it is fairly confident. When it can't decide it returns null and
 * the candidate is emitted with c:"" and _meta.needs:["c"] — your job (or the
 * LLM extraction pass) is to pick the slug. Never let this auto-assign a wrong
 * slug: a wrong-but-valid slug is worse than a blank, because it looks done.
 *
 * Only categories with a clean physical-tag mapping are covered here. The
 * vibe-driven ones (oddity, history, literary, film, music, diaspora, pop,
 * brunch, view, alley, ghostsign, …) are intentionally left to a human/LLM.
 */

// ordered: first match wins, so put the specific tags before the generic ones
const RULES = [
  // food & drink
  [(t) => t.amenity === "cafe" && /coffee|espresso|roaster/i.test(t.name || ""), "coffee"],
  [(t) => t.cuisine === "coffee_shop" || t.shop === "coffee", "coffee"],
  [(t) => t.amenity === "cafe", "caff"],
  [(t) => t.amenity === "pub" || t.pub === "yes", "pub"],
  [(t) => t.amenity === "bar" && t.wine === "yes", "wine"],
  [(t) => t.shop === "wine" || t.craft === "winery", "wine"],
  [(t) => t.shop === "bakery" || t.craft === "bakery", "bakery"],
  [(t) => /dumpling|dim ?sum|jiaozi/i.test(t.name || ""), "dumpling"],
  [(t) => /pie ?(&|and) ?mash|pie and mash/i.test(t.name || ""), "pieandmash"],
  [(t) => /matcha/i.test(t.name || ""), "matcha"],
  [(t) => /\b(boba|bubble tea)\b/i.test(t.name || ""), "boba"],

  // shops
  [(t) => t.shop === "books" || t.shop === "bookshop", "bookshops"],
  [(t) => t.shop === "music" || /\bvinyl\b/i.test(t.name || ""), "vinyl"],

  // culture / heritage
  [(t) => t.tourism === "museum" || t.amenity === "museum", "museum"],
  [(t) => t.amenity === "cinema" || t.tourism === "cinema", "cinema"],
  [(t) => t.historic === "memorial" && /plaque/i.test(t.memorial || t["memorial:type"] || ""), "plaque"],
  [(t) => t.historic === "blue_plaque" || t["plaque:type"] != null, "plaque"],
  [(t) => t.historic === "archaeological_site" && /roman/i.test(JSON.stringify(t)), "roman"],
  [(t) => t.historic === "castle" || t.historic === "city_gate" || t.historic === "fort", "medieval"],
  [(t) => t.historic === "folly" || t.building === "folly", "follies"],
  [(t) => t.amenity === "archive" || t.office === "archive", "archive"],

  // place of worship / faith
  [(t) => t.amenity === "place_of_worship", "faith"],

  // green & water
  [(t) => t.leisure === "park" || t.leisure === "garden" || t.leisure === "nature_reserve", "green"],
  [(t) => t.leisure === "swimming_pool" && /lido|outdoor/i.test(t.name || ""), "lido"],
  [(t) => t.waterway === "canal" || /canal/i.test(t.name || ""), "canals"],

  // built form
  [(t) => t.building === "stadium" || t.leisure === "stadium" || t.sport != null && t.building === "grandstand", "stadium"],
  [(t) => /art ?deco/i.test(JSON.stringify(t)), "artdeco"],
  [(t) => t.building === "almshouse" || /almshouse/i.test(t.name || ""), "almshouses"],
  [(t) => t.tourism === "artwork" && /mural|graffiti|street/i.test(t.artwork_type || ""), "streetart"],

  // money / livery
  [(t) => /livery (hall|company)|worshipful company/i.test(t.name || ""), "livery"],

  // viewpoints
  [(t) => t.tourism === "viewpoint", "view"],
];

/**
 * Guess a category slug from an OSM-style tag bag. `validSet` is the live
 * Set of slugs from model.loadModel().categories — we never return a slug the
 * template doesn't define. Returns a slug or null.
 */
function guessCategory(tags, validSet) {
  if (!tags) return null;
  for (const [test, slug] of RULES) {
    let hit = false;
    try { hit = !!test(tags); } catch { hit = false; }
    if (hit && (!validSet || validSet.has(slug))) return slug;
  }
  return null;
}

module.exports = { guessCategory };
