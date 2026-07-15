# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`.
- **Read an issue**: `gh issue view <number> --comments`, including labels and comments.
- **List issues**: use `gh issue list` with the narrowest appropriate state and label filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`.
- **Apply or remove labels**: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- **Close an issue**: `gh issue close <number> --comment "..."`.

Infer the repository from `git remote -v`; `gh` does this automatically inside the clone.

## Pull requests as a triage surface

**PRs as a request surface: no.**

GitHub shares one number space across issues and PRs. Resolve an ambiguous bare number with `gh pr view <number>` and fall back to `gh issue view <number>`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue and apply `ready-for-agent` when the work is implementation-ready.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments` and include its labels.

## Blocking relationships

Prefer GitHub's native issue dependencies. Add an edge with:

`gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-database-id>`

The blocker value is the numeric database `id` returned by `gh api repos/<owner>/<repo>/issues/<number> --jq .id`, not the issue number or node ID. If native dependencies are unavailable, put `Blocked by: #<number>` in the issue body.

Work only tickets whose blockers are closed. Claim a ticket with `gh issue edit <number> --add-assignee @me` before implementation.
