# Flâneur agent guide

`CLAUDE.md` is the canonical architecture, data-model, build, and validation guide for this repository. Read it before changing code or catalogue data. If this file and `CLAUDE.md` disagree, stop and call out the conflict.

## Before editing

- Start from the latest `main` on a fresh branch for one task. Never reuse a merged branch.
- Inspect the relevant source files and existing behavior before proposing a change.
- For ambiguous product, design, data, or architecture decisions, pause after inspection and ask up to three questions whose answers would materially change the implementation. Otherwise state the assumptions and proceed.
- Keep parallel tasks away from the same generated or minified files.

## Sources and generated files

- Spot and writeup source: `data/spots.json`.
- Application source: `src/app.template.html`.
- Generated deployment files include `index.html` and content-hashed `spots.*.js` sidecars.
- Never hand-edit generated deployment files. Edit their source and run `npm run build`.
- Do not rewrite authored/approved writeups unless the user explicitly requests it. Follow the quality flags and rules in `CLAUDE.md`.
- When the build replaces hashed sidecars, include both the new file and deletion of the old file.

## Validation

For a fresh checkout:

```bash
npm ci
npm run build
git diff --check
```

Before finishing:

- Confirm the build completed successfully.
- Review the full diff, including generated outputs and deleted hashes.
- Confirm no unrelated files or authored writeups changed.
- Report the commands run and any checks that could not be completed.

## Git and review

- Do not commit directly to `main`.
- Do not force-push or rewrite history.
- Push a fresh task branch and open a draft pull request against `main`.
- The PR must explain the change, validation, risks, and preview status.
- Do not merge the PR unless the user explicitly asks after reviewing the preview.
