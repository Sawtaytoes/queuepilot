# 2026-08-13 — A PR merges as soon as CI is green

Status: Accepted
Date: 2026-08-13
Type: process (repo workflow)
Supersedes: —
Superseded by: —

Repo-local restatement of the workspace decision **"The AI merges its own PRs — the owner
never merges"** (`agentic/docs/decisions/2026-08-05-the-ai-merges-its-own-prs-the-owner-never-merges.md`).
That decision already settled *who* merges; this record exists because an agent asked the
owner anyway on [#68](https://github.com/Sawtaytoes/queuepilot/pull/68), and because two
mechanics specific to **this** repo are what make the answer non-obvious here.

## Decision

**Green CI is the merge gate. Nothing else.** When the `ci` workflow passes on a PR in this
repo, the agent that opened it merges it. "Opened a PR, it's green, say the word" is not a
finished handoff.

Mechanics that are specific to this repo:

- **Squash merge, delete the branch.** Matches every commit on `main` since the GitHub move
  (`<type>(<scope>): <subject> (#NN)`); the repo has `delete_branch_on_merge` on.
- **`gh pr merge` does not work from the shared checkout.** Concurrent agents keep
  worktrees on this repo, so `gh` fails trying to switch the local branch:
  `fatal: 'main' is already used by worktree at …`. That failure is easy to misread as
  "merging is blocked." It is not — merge over the API:
  ```bash
  gh api -X PUT repos/Sawtaytoes/queuepilot/pulls/<N>/merge \
    -f merge_method=squash -f commit_title="<type>(<scope>): <subject> (#<N>)"
  ```
- **Merging is not deploying.** The `workflow_run` deploy builds and pushes
  `ghcr.io/sawtaytoes/queuepilot:{sha,main,latest}`; the live app only takes it on a
  deliberate `app.redeploy`. So a green merge cannot move the app under the family's NFC
  cards — the risk everyone reaches for when hesitating here does not exist at merge time.

**The one exception:** a PR the owner, or its own decision record, explicitly put on hold
still waits — e.g.
[2026-08-03-follow-the-os-colour-scheme-via-charcuterie-switcher](2026-08-03-follow-the-os-colour-scheme-via-charcuterie-switcher.md)
carries "do NOT merge/deploy until then". A stated hold beats this default; the *absence*
of a hold is not a hold.

## Context

PR #68 (the QueuePilot favicon) came back CI-green and was left open with "the GitHub merge
policy for this repo is still unsettled — say the word and I'll merge." It was not
unsettled: the 2026-08-05 workspace decision covers it, and the note that said "policy TBD"
was a stale summary line whose own body already recorded the resolution. The owner
re-confirmed, and #68 was squash-merged as `171d0cc`.

The confusion has a traceable source. This repo *did* have an auto-merge-when-green flow on
Forgejo; that died with the 2026-08-02 move to public GitHub, and
[the record restoring CI](2026-08-02-ci-and-deploy-on-github-actions-to-ghcr.md) restored
the workflow without restating who merges. Anyone reading only this repo's records finds a
gap that the workspace records had already closed.

## Why

CI here is the real gate — typecheck, unit tests and the e2e suites all run in it, and a
green run is the same signal the old Forgejo auto-merge trusted. A second "yes" from an
owner who has said he will never click merge buys nothing and costs a round trip per
change. The deploy step stays manual, which is where the actual risk to the live app lives.

## Evidence

> "It should merge once CI is clena."
> (owner, 2026-08-13, when asked whether to merge the green favicon PR)

> "You can merge these all yourself. I won't ever be merging anything; especially not stuff
> you wrote."
> (owner, 2026-08-05 — the workspace decision this restates)
