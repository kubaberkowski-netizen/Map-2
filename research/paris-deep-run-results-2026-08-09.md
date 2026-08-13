# Paris deep-run results

Date: 2026-08-09
Visit window researched: 13–16 August 2026
Import status: 91 retained places imported as quality `d` drafts

## Outcome

The run screened 324 named leads against the pre-run catalogue of 17,237 places
and 140 Paris rows. It retained 91 after current-access, source, coordinate,
category, editorial-score and global-dedupe review:

| Lane | Screened | Retained | Preserved non-retained leads |
|---|---:|---:|---:|
| Built environment and history | 108 | 32 | 76 |
| Outdoor and nature | 88 | 29 | 59 |
| Culture, faith and commerce | 128 | 30 | 98 |
| **Total** | **324** | **91** | **233** |

The initial import used six bounded waves of 25, 8, 25, 4, 25 and 5. Final
independent QA then withdrew the Grand Rocher row because its apparent feature
coordinate was a generic estate geotag copied across unrelated photographs. The
91 retained drafts take Paris from 140 to 231 catalogue rows and the full catalogue
from 17,237 to 17,328. Every imported row remains pending human field review;
none was promoted to authored or verified quality.

## Category coverage

The retained rows span 36 categories. They add the first Paris entries for 14
live categories: `archive`, `bathhouse`, `brutalism`, `finance`, `footbridges`,
`hills`, `lido`, `market`, `plaque`, `ruins`, `temple`, `vinyl`,
`warmemory` and `wild`.

Paris therefore moves from 37 to 51 of the 64 live categories. The 13 categories
still empty after explicit screening are `almshouses`, `livery`, `pop`, `boba`,
`maritime`, `ghostsign`, `pieandmash`, `dumpling`, `faith`, `follies`, `synagogue`,
`monastery` and `castle`. They were not padded with generic or weak fits.

## Field-test clusters

These clusters are useful for testing random discovery, category filters, close
but distinct pins and route hand-off without trying to turn the run into a
checklist itinerary.

- **Marais and the islands:** Philippe-Auguste wall, Bastille stones, Hôtel de
  Sens, the Saint-Gervais elm, Fontaine Stravinsky, Défenseur du Temps,
  Bras-Marie swim and La Caféothèque.
- **East and north-east:** Grande-Roquette guillotine slabs, Souffle Continu,
  Petite Ceinture/Bois de Charonne, Butte-du-Chapeau-Rouge, Orgues de Flandre,
  Temple Ganesh, Halle Pajol and the Crimée lift bridge.
- **Bercy and Porte Dorée:** Simone-de-Beauvoir footbridge, Bercy swim, Les
  Frigos, Musée national de l’histoire de l’immigration and the Arboretum.
- **South Paris:** Mire du Sud, Montparnasse cemetery, Notre-Dame-du-Travail,
  the Georges-Brassens book market and the Petite Ceinture du 15e.
- **Richelieu and the grands boulevards:** Salle Ovale, Ultramod, Galerie Fayet,
  Le Damier de l’Opéra, Musée de la Franc-Maçonnerie and Max Linder Panorama.

## Visit-window controls

- Piscine des Amiraux, the Deportation Memorial, Salle Ovale and the
  Franc-Maçonnerie museum are closed on 15 August; their dossiers identify usable
  alternative trip dates.
- Citéco is supported through 16 August and begins its maintenance closure on
  17 August.
- Canal Saint-Martin swimming fits only Sunday 16 August, 14:00–18:00. Every
  swim remains conditional on the same-day municipal water, current, weather and
  staffing status.
- Orgues de Flandre has active works/diversions; Stravinsky movement and spraying
  are not guaranteed under drought vigilance.
- Parks, gardens, cemeteries, bridges and independent shops still require a
  same-day heat, weather, security or summer-hours check.

## Verification and lifecycle

The final three-dossier audit passes at 91 rows. Independent cross-lane review
checked every retained coordinate and current-access claim. The Paris contract
also verifies production-copy parity, raw Paris bbox containment, atomic
fact/source links, all-high confidence, 19/25 scoring, draft flags, 30-metre hard
dedupe, written reviews for 30–119 metre neighbours, catalogue counts and category
coverage. `npm run test:paris` is wired into CI.

The source dossiers are:

- `research/paris-built-history-deep-2026-08-09.json`
- `research/paris-outdoor-deep-2026-08-09.json`
- `research/paris-culture-commerce-deep-2026-08-09.json`

All three carry `do_not_reimport:true`. Field-test edits should update the existing
production rows and dossier evidence, not run the import again.
