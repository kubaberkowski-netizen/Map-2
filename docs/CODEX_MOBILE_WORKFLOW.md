# Codex mobile workflow

Use the phone as the control and review surface. Let Codex work asynchronously on a branch, and treat the pull request as the durable handoff.

## One-time setup

1. In Codex environments, connect `kubaberkowski-netizen/Map-2` and use `main` as the default base.
2. Connect the repository to a preview host such as Cloudflare Pages:
   - production branch: `main`
   - build command: `npm run build`
   - build output directory: repository root
3. In GitHub, add a ruleset for `main`:
   - require a pull request
   - require the **Build and verify generated files** check
   - block force-pushes and branch deletion
4. Prefer squash merge and automatically delete merged branches.

GitHub Pages remains the production deployment until a hosting migration is deliberately approved. The preview host is only the pre-merge review surface.

## Start every feature from a clean branch

Use one task, one fresh branch, and one pull request. Do not continue work on a branch after its PR is merged.

### Planning prompt

```text
Work on kubaberkowski-netizen/Map-2 from the latest main.

Read AGENTS.md and the relevant sections of CLAUDE.md. Inspect the current
implementation before editing. Then send me:

1. your understanding of the outcome
2. the files and systems involved
3. your implementation plan
4. up to three questions whose answers would materially change the result

Do not edit until I reply GO. If there are no meaningful questions, say so and
state the assumptions you recommend.
```

### Implementation prompt

```text
GO. Implement the approved plan on a fresh task branch.

Run npm ci, npm run build, and git diff --check. Review the complete diff,
including generated files and deleted content hashes. Push the branch and open
or update a draft PR against main. Include the commands run, validation result,
risks, and preview status. Do not merge.
```

## Review from iPhone

1. Open the draft PR in GitHub Mobile.
2. Wait for the validation check and preview deployment.
3. Open the commit-specific preview URL. This avoids confusing an old
   service-worker cache with the latest build.
4. Test the requested flow and at least one nearby regression path.
5. Send feedback in the same Codex task so it updates the existing branch and PR.
6. When satisfied, approve and squash-merge from GitHub.

Cloud tasks are not a live hot-reload environment. For a truly interactive
terminal/browser loop from a phone, use Remote with an awake desktop host.

## Recover work from an isolated checkout

If a task committed locally but has no Git remote, ask that original task to
export the commit:

```text
Do not make further edits. Export commit <sha> as a downloadable patch:

git format-patch -1 <sha> --stdout > recovered-change.patch

Return the patch file and git show --stat <sha>.
```

Start a new task attached to the Map-2 GitHub environment, base it on the latest
`main`, attach the patch, apply it, validate it, and open a fresh draft PR.
Do not mix recovered work into an unrelated open PR.

## Branch and PR hygiene

- Branch names: `agent/<short-task-name>` or `codex/<short-task-name>`.
- Close abandoned PRs after salvaging any still-useful commits.
- Never reuse a long-lived feature branch for a sequence of unrelated PRs.
- Keep independent tasks out of the same minified or generated files.
- A green build permits review; it does not authorize a merge.
