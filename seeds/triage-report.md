# Task BB/BC triage — London food + culture seeds

Parsed 163 leads. Geocoded via Nominatim; deduped vs 1150 London spots (name>=0.6 or <=75m).

| bucket | count | meaning |
|---|---|---|
| NEW | 25 | geocoded, in-bbox, not a duplicate -> importable as drafts |
| DEDUPE | 83 | already in catalogue -> enrichment (cross-link tags, NOT auto-applied) |
| MARKET_HOLD | 17 | needs a new 'market' category slug (owner decision) |
| AMBIGUOUS | 2 | geocoder returned far-apart matches -> owner triage |
| UNRESOLVED | 36 | no geocode / outside bbox -> quarantine |
| TRAP | 0 | do-not-add / closed -> dropped, never imported |

## NEW — importable drafts (25)
- **H.R. Higgins** — Mayfair — `coffee` — 51.5131,-0.1507 _[verify]_
- **Camden Coffee Shop** — Delancey St — `coffee` — 51.5368,-0.1421 _[verify]_
- **W. Martyn** — Muswell Hill — `coffee` — 51.5906,-0.1435 _[verify]_
- **Chin Chin Labs** — Camden — `food` — 51.5414,-0.1463 _[verify]_
- **La Gelatiera** — Covent Garden — `food` — 51.5111,-0.1268 _[verify]_
- **Marine Ices** — Chalk Farm — `food` — 51.5433,-0.1501 _[verify]_
- **Rinkoff's** — Whitechapel — `bakery` — 51.5220,-0.0645
- **Konditor** — Waterloo — `bakery` — 51.5042,-0.1103 _[verify]_
- **Rock & Sole Plaice** — Covent Garden — `food` — 51.5148,-0.1252 _[verify]_
- **Lemonia** — Primrose Hill — `food` — 51.5416,-0.1570 _[verify]_
- **Steve Hatt** — Essex Rd — `food` — 51.5385,-0.0989 _[verify]_
- **Taj Stores** — Brick Lane — `food` — 51.5200,-0.0717
- **Loon Fung** — Chinatown — `food` — 51.5119,-0.1303 _[verify]_
- **Brindisa** — Borough — `food` — 51.5051,-0.0904 _[verify]_
- **Japan Centre** — Piccadilly — `food` — 51.5097,-0.1315 _[verify]_
- **Prima / Parade** — Hammersmith/Ealing — `food` — 51.5396,0.0806 _[verify]_
- **Chalcot Crescent** — Primrose Hill — `film` — 51.5400,-0.1564 _[verify]_
- **Australia House** — Strand — `film` — 51.5129,-0.1156 _[verify]_
- **Millennium Bridge** —  — `film` — 51.5099,-0.0985
- **St Katharine Docks** — Tower — `maritime` — 51.5065,-0.0717
- **Grosvenor Chapel** — Mayfair — `faith` — 51.5090,-0.1512 _[verify]_
- **40 Stansfield Road** — Brixton — `music` — 51.4659,-0.1181
- **Ministry of Sound** — Elephant and Castle — `music` — 51.4978,-0.0995 _[verify]_
- **Point Hill** — Greenwich — `view` — 51.4745,-0.0099
- **Blythe Hill Fields** — Catford — `view` — 51.4471,-0.0356 _[verify]_

## DEDUPE — enrichment candidates (83)
- **Algerian Coffee Stores** ~ existing `algerian` ("Algerian Coffee Stores", sim 1, 40m) -> suggest tags: coffee, victorian
- **Bar Italia** ~ existing `baritalia` ("Bar Italia & the Baird plaque", sim 1, 25m) -> suggest tags: coffee, interior, scientific
- **Monmouth Coffee** ~ existing `monmouth` ("Monmouth Coffee", sim 1, 2625m) -> suggest tags: coffee
- **Prufrock Coffee** ~ existing `prufrock` ("Prufrock Coffee", sim 1, 79m) -> suggest tags: coffee
- **Kaffeine** ~ existing `kaffeine` ("Kaffeine", sim 1, 50m) -> suggest tags: coffee
- **Climpson & Sons** ~ existing `climpsons` ("Climpson & Sons", sim 1, 52m) -> suggest tags: coffee
- **Gelupo** ~ existing `gelupo-soho` ("Gelupo", sim 1, 196m) -> suggest tags: gelato
- **Oddono's** ~ existing `oddonos-south-ken` ("Oddono's", sim 1, 7989m) -> suggest tags: gelato
- **Maison Bertaux** ~ existing `maisonbertaux` ("Maison Bertaux", sim 1, 56m) -> suggest tags: bakery, victorian, interior
- **Beigel Bake** ~ existing `beigel` ("Beigel Bake", sim 1, 10m) -> suggest tags: bakery, jewish, late
- **Beigel Shop** ~ existing `beigel` ("Beigel Bake", sim 1, 26m) -> suggest tags: bakery, jewish
- **Lisboa Patisserie** ~ existing `lisboa-patisserie` ("Lisboa Patisserie", sim 1, 7581m) -> suggest tags: bakery, immigrant
- **Dusty Knuckle** ~ existing `dustyknuckle` ("The Dusty Knuckle", sim 1, 84m) -> suggest tags: bakery
- **E5 Bakehouse** ~ existing `e5-bakehouse` ("E5 Bakehouse", sim 1, 243m) -> suggest tags: bakery
- **St. John Bakery** ~ existing `st-john-bakery` ("St. John Bakery", sim 1, 1915m) -> suggest tags: bakery
- **Ambala** ~ existing `ambalasweet` ("Ambala Sweet Centre", sim 1, 26205m) -> suggest tags: bakery, immigrant
- **Antepliler** ~ existing `antepliler` ("Antepliler", sim 1, 312m) -> suggest tags: bakery, immigrant
- **Golden Gate Cake Shop** ~ existing `goldendragon` ("Golden Dragon", sim 0.5, 35m) -> suggest tags: bakery, immigrant
- **E. Pellicci** ~ existing `e-pellicci-bethnal-green` ("E. Pellicci", sim 1, 514m) -> suggest tags: caff, interior, crime
- **Regency Cafe** ~ existing `regency-cafe-westminster` ("Regency Café", sim 1, 132m) -> suggest tags: caff, cinematic, interwar
- **Terry's Cafe** ~ existing `terrys-cafe-borough` ("Terry's Café", sim 1, 154m) -> suggest tags: caff, interior
- **Andrew's** ~ existing `standrewsunitedreformedc` ("St Andrew's United Reformed Church", sim 1, 28806m) -> suggest tags: caff
- **Rules** ~ existing `rules` ("Rules", sim 1, 85m) -> suggest tags: food, georgian, literary
- **Wiltons** ~ existing `wiltons` ("Wiltons", sim 1, 104m) -> suggest tags: food, georgian
- **Sweetings** ~ existing `sweetings` ("Sweetings", sim 1, 68m) -> suggest tags: food, victorian, interior
- **The Quality Chop House** ~ existing `qualitychop` ("Quality Chop House", sim 1, 175m) -> suggest tags: food, victorian, interior
- **George & Vulture** ~ existing `georgevulture` ("The George & Vulture", sim 1, 20m) -> suggest tags: food, georgian, literary
- **Simpson's Tavern** ~ existing `cloth` ("Cloth Cornhill (ex-Simpson's Tavern)", sim 1, 19m) -> suggest tags: food, georgian
- **Veeraswamy** ~ existing `veeraswamy` ("Veeraswamy", sim 1, 1m) -> suggest tags: food, immigrant, interwar
- **Tayyabs** ~ existing `tayyabs` ("Tayyabs", sim 1, 10m) -> suggest tags: food, immigrant
- **Lahore Kebab House** ~ existing `lahorekebabhouse` ("Lahore Kebab House", sim 1, 0m) -> suggest tags: food, immigrant
- **Daquise** ~ existing `daquise` ("Daquise", sim 1, 47m) -> suggest tags: food, immigrant, polish
- **Ognisko** ~ existing `ognisko` ("Ognisko Polskie", sim 1, 188m) -> suggest tags: food, immigrant, polish, interior
- **L'Escargot** ~ existing `lescargot2` ("L'Escargot", sim 1, 0m) -> suggest tags: food, interwar
- **Mon Plaisir** ~ existing `monplaisir` ("Mon Plaisir", sim 1, 16m) -> suggest tags: food
- **Wong Kei** ~ existing `wongkei` ("Wong Kei", sim 1, 1m) -> suggest tags: food, immigrant
- **Golden Hind** ~ existing `thegoldenhind` ("The Golden Hind", sim 1, 0m) -> suggest tags: food, interwar
- **Song Que** ~ existing `song-que-pho` ("Sông Quê Café", sim 1, 23m) -> suggest tags: food, immigrant
- **Terroni of Clerkenwell** ~ existing `terroni-clerkenwell` ("Terroni of Clerkenwell", sim 1, 136m) -> suggest tags: deli, victorian, immigrant
- **Lina Stores** ~ existing `linastores` ("Lina Stores", sim 1, 53m) -> suggest tags: deli, immigrant, shopfront
- **Panzer's** ~ existing `panzers-deli` ("Panzer's Deli", sim 1, 78m) -> suggest tags: deli, jewish
- **Neal's Yard Dairy** ~ existing `nealsyard` ("Neal's Yard", sim 1, 2619m) -> suggest tags: deli
- **Paxton & Whitfield** ~ existing `paxtoncheese` ("Paxton & Whitfield", sim 1, 80m) -> suggest tags: deli, georgian
- **Persepolis** ~ existing `persepolis` ("Persepolis", sim 1, 270m) -> suggest tags: deli, immigrant, eccentric
- **Maryon Park** ~ existing `maryonpark` ("Maryon Park (where Blow-Up was shot)", sim 1, 128m) -> suggest tags: green, cinematic
- **Regency Cafe** ~ existing `regency-cafe-westminster` ("Regency Café", sim 1, 132m) -> suggest tags: cinematic
- **Speedy's Cafe** ~ existing `north-gower-sherlock` ("Speedy's & North Gower Street", sim 1, 126m) -> suggest tags: cinematic, caff
- **Platform 9 3/4** ~ existing `platform-nine-three-quarters` ("Platform 9 3/4", sim 1, 32m) -> suggest tags: cinematic
- **Cecil Court** ~ existing `cecilcourt` ("Cecil Court", sim 1, 32m) -> suggest tags: alley, bookshops, cinematic
- **SIS Building** ~ existing `sis-building-mi6` ("The SIS Building (MI6)", sim 1, 24m) -> suggest tags: cinematic
- **Trellick Tower** ~ existing `towerhouse` ("The Tower House", sim 1, 2740m) -> suggest tags: brutalism, cinematic, musical
- **Abbey Road Crossing** ~ existing `abbeyroad` ("Abbey Road Crossing", sim 1, 13m) -> suggest tags: musical
- **Heddon Street** ~ existing `ziggy` ("Heddon Street — Ziggy plaque", sim 1, 98m) -> suggest tags: musical, alley
- **Denmark Street** ~ existing `denmark` ("Denmark Street", sim 1, 21m) -> suggest tags: musical, shopfront
- **100 Club** ~ existing `the100club` ("The 100 Club", sim 1, 96m) -> suggest tags: musical, late
- **Ronnie Scott's** ~ existing `ronniescotts` ("Ronnie Scott’s", sim 1, 32m) -> suggest tags: musical, late
- **430 King's Road (World's End)** ~ existing `worldsend430kingsroad` ("World's End (430 King's Road)", sim 1, 483m) -> suggest tags: musical, shopfront
- **Berwick Street** ~ existing `berwick` ("Berwick Street", sim 1, 74m) -> suggest tags: musical, vinyl, market
- **The Dublin Castle** ~ existing `dublincastle` ("The Dublin Castle", sim 1, 146m) -> suggest tags: pub, musical
- **Roundhouse** ~ existing `roundhouse` ("The Roundhouse", sim 1, 63m) -> suggest tags: musical, victorian
- **Fabric** ~ existing `fabric` ("Fabric", sim 1, 40m) -> suggest tags: musical, late
- **Amy Winehouse Statue** ~ existing `amywinehousestatue` ("Amy Winehouse Statue", sim 1, 81m) -> suggest tags: musical
- **King Henry's Mound** ~ existing `henrysmound` ("King Henry's Mound", sim 1, 1510m) -> suggest tags: view, green
- **Parliament Hill** ~ existing `parliament-hill` ("Parliament Hill", sim 1, 387m) -> suggest tags: view, green
- **Severndroog Castle** ~ existing `severndroog-castle` ("Severndroog Castle", sim 1, 400m) -> suggest tags: follies, view
- **One Tree Hill** ~ existing `onetreehill` ("One Tree Hill", sim 1, 445m) -> suggest tags: view, green
- **Stave Hill** ~ existing `stavehill` ("Stave Hill", sim 1, 0m) -> suggest tags: view, eccentric
- **Alexandra Palace Terrace** ~ existing `allypally` ("Alexandra Palace", sim 1, 47m) -> suggest tags: view, scientific
- **The Garden at 120 Fenchurch Street** ~ existing `garden-at-120` ("The Garden at 120", sim 1, 86m) -> suggest tags: view, rooftop
- **Horizon 22** ~ existing `horizon-22` ("Horizon 22", sim 1, 106m) -> suggest tags: view, rooftop
- **Sky Garden** ~ existing `sky-garden` ("Sky Garden", sim 1, 48m) -> suggest tags: view, rooftop
- **The Monument** ~ existing `monument` ("The Monument", sim 1, 7m) -> suggest tags: view, history
- **Frank's Cafe** ~ existing `frankscafe` ("Frank's Cafe & Bold Tendencies", sim 1, 16929m) -> suggest tags: view, rooftop, eccentric
- **London Mithraeum** ~ existing `mithraeum` ("London Mithraeum", sim 1, 25m) -> suggest tags: roman, subterranean, museum
- **Guildhall Amphitheatre** ~ existing `amphitheatre` ("Guildhall Roman Amphitheatre", sim 1, 34m) -> suggest tags: roman, subterranean, museum
- **Greenwich Foot Tunnel** ~ existing `greenwich-foot-tunnel` ("Greenwich Foot Tunnel", sim 1, 242m) -> suggest tags: subterranean, victorian
- **Woolwich Foot Tunnel** ~ existing `woolwichfoottunnel` ("Woolwich Foot Tunnel", sim 1, 266m) -> suggest tags: subterranean
- **Mail Rail** ~ existing `mailrail` ("Mail Rail, The Postal Museum", sim 1, 158m) -> suggest tags: subterranean, museum, interwar
- **Churchill War Rooms** ~ existing `churchillwarrooms` ("Churchill War Rooms", sim 1, 21m) -> suggest tags: subterranean, museum
- **St Martin-in-the-Fields Crypt** ~ existing `cafeinthecrypt` ("Café in the Crypt", sim 1, 40m) -> suggest tags: faith, subterranean, caff
- **Crystal Palace Subway** ~ existing `crystalpalacesubway` ("Crystal Palace Subway", sim 1, 583m) -> suggest tags: subterranean, victorian, follies
- **Leake Street Tunnel** ~ existing `leakest` ("Leake Street Arches", sim 0.67, 115m) -> suggest tags: streetart, subterranean
- **London Silver Vaults** ~ existing `londonsilvervaults` ("London Silver Vaults", sim 1, 2m) -> suggest tags: subterranean, shopfront, victorian

## MARKET_HOLD — need 'market' category (17)
- **Leadenhall Market** — City (51.5127,-0.0834)
- **Borough Market / Park Street corner** — Borough
- **Electric Avenue** — Brixton (51.4622,-0.1140)
- **Borough Market** — Borough (51.5056,-0.0902)
- **Leadenhall** — City (51.5138,-0.0823)
- **Smithfield** — City (51.5178,-0.1022)
- **Columbia Road Flower Market** — Bethnal Green (51.5292,-0.0696)
- **Petticoat Lane** — City / Spitalfields (51.5168,-0.0749)
- **Broadway Market** — Hackney (51.5368,-0.0616)
- **Maltby Street / Ropewalk** — Bermondsey (51.4996,-0.0761)
- **Portobello Road** — Notting Hill (51.5163,-0.2053)
- **Chapel Market** — Islington (51.5335,-0.1088)
- **Ridley Road** — Dalston (51.5482,-0.0731)
- **Brixton Village and Market Row** — Brixton
- **Walthamstow Market** — Walthamstow (51.5822,-0.0306)
- **New Covent Garden Flower Market** — Nine Elms (51.4800,-0.1383)
- **East Street Market** — Walworth (51.4883,-0.0935)

## AMBIGUOUS (2)
- **Punjab** — Covent Garden — geocoder split 16395m: Punjab, 80, Neal Street, Seven Dials, Bloomsbury, London Borough of Camden, Grea
- **805** — Old Kent Rd — geocoder split 2301m: 805, 805-809, Old Kent Road, South Bermondsey, Old Kent Road, London Borough of 

## UNRESOLVED (36)
- **Site of the Moka Bar** — Soho (29 Frith St) — no geocode
- **The Parlour at Fortnum's** — Piccadilly — no geocode
- **Grodzinski** — Golders Green — no geocode
- **Alpino** — Chapel Market — no geocode
- **Mangal 2** — Dalston — no geocode
- **Sea Shell of Lisson Grove** — Marylebone — no geocode
- **I. Camisa & Son** — Soho — no geocode
- **Gazzano's** — Farringdon — no geocode
- **Paul Rothe & Son** — Marylebone — no geocode
- **The Blue Door, 280 Westbourne Park Road** — Notting Hill — no geocode
- **The Notting Hill Bookshop Site** — Blenheim Crescent — no geocode
- **National Gallery, Room 34** — Trafalgar Square — no geocode
- **Southmere Lake and Binsey Walk** — Thamesmead — no geocode
- **Apollo/Croydon Underpass Cluster** — Croydon — no geocode
- **The Prince's Head and Richmond Green** — Richmond — no geocode
- **King's Cross Gasholders and Granary** — King's Cross — no geocode
- **Kingsman Tailor Shop (Huntsman, 11 Savile Row)** — Savile Row — no geocode
- **23 and 25 Brook Street** — Mayfair — no geocode
- **3 Savile Row Rooftop** — Savile Row — no geocode
- **Site of the 2i's Coffee Bar** — Old Compton Street — no geocode
- **Trident Studios Site** — St Anne's Court — no geocode
- **Eel Pie Island and Eel Pie Museum** — Twickenham — no geocode
- **Freddie Mercury's Garden Lodge Door** — Logan Place, Kensington — no geocode
- **Site of the Blitz Club** — Great Queen Street — no geocode
- **The Clash's Westway Stretch** — Ladbroke Grove — no geocode
- **Primrose Hill Summit** — Primrose Hill — no geocode
- **Nunhead Cemetery Vista** — Nunhead — no geocode
- **Westminster Cathedral Campanile** — Westminster — no geocode
- **Greenwich Foot-Tunnel South Dome and Island Gardens** — Greenwich — no geocode
- **Billingsgate Roman House and Baths** — Lower Thames Street — no geocode
- **London Wall Car Park, Bay 52-ish** — City — no geocode
- **Brunel's Thames Tunnel and Museum** — Rotherhithe — no geocode
- **Aldwych Disused Station** — Strand — no geocode
- **Down Street Station** — Mayfair — no geocode
- **St Bride's Crypt** — Fleet Street — no geocode
- **Kingsway Tram Tunnel Portal** — Southampton Row — no geocode

## TRAP — dropped (0)
