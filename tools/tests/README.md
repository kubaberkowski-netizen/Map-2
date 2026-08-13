# Mobile regression contracts

Run the deterministic native/mobile algorithm specifications with:

```bash
node tools/tests/mobile-regressions.test.js
```

The command exits nonzero on any failure. It covers authoritative native walk
duration, route-aware lock-screen radar hand-off, exact World membership, discovery
filter preservation, overnight/duplicate opening hours, and recorder acceptance for
walking, stationary jitter, GPS jumps, and slow vehicles.

The production application is an inline minified bundle and the recorder rules are
duplicated in Swift and Java. `mobile-regression-contracts.js` therefore holds small,
platform-independent executable contracts rather than importing a browser bundle or
requiring a simulator. Keep each production implementation aligned with these
contracts and add a failing scenario here before changing an edge-case rule.

## Research and import contracts

Run the guarded research pipelines through their package scripts:

```bash
npm run test:research-categories
npm run test:discovery-wave2
npm run test:paris
npm run test:hills
```

`test:paris` covers both Paris research waves. The signature-wave contract checks the
four new category slugs, all 41 dossier-to-production mappings, draft quality flags,
the reviewed 30-metre dense-city import rule, eight precise retags, and the final
17,369-catalogue / 272-Paris count invariants.
