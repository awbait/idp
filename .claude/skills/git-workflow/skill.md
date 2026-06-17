---
name: git-workflow
description: "Enforces the project's Git workflow: feature branches, conventional commits, PR creation, and release process. Use this skill whenever working with git - creating branches, committing, switching tasks, creating PRs, or making releases. Triggers on any git operation, branch management, PR creation, or when the user says 'сделай релиз', 'создай PR', 'закоммить', 'commit', 'release'."
---

# Git Workflow

This skill enforces the project's branching and release strategy. Every code change flows through feature branches and pull requests - main is always protected.

## Branch Rules

### Never commit to main

All work happens on feature branches created from main:
- `feat/short-description` - new features
- `fix/short-description` - bug fixes
- `chore/short-description` - maintenance, refactoring, deps
- `docs/short-description` - documentation only
- `release/vX.Y.Z` - release preparation

Before creating a branch, pull the latest main:
```bash
git checkout main
git pull origin main
git checkout -b feat/my-feature
```

### Switching between tasks

If the current branch has uncommitted or unfinished work and the user asks for a different task:

1. Stage and commit current changes as WIP:
   ```bash
   git add -A
   git commit -m "wip: описание текущей работы"
   ```
2. Switch to main and create a new branch:
   ```bash
   git checkout main
   git pull origin main
   git checkout -b feat/new-task
   ```

The unfinished work stays safe in its branch. Never lose uncommitted changes.

## Commits

Use **Conventional Commits** format. Delegate to the `git-commit` skill for message generation.

Format: `type(scope): description`

Types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `perf`

Keep commits small and focused - one logical change per commit.

Before committing, pull the latest changes for the current branch to avoid conflicts:
```bash
git pull origin <current-branch> --rebase
```

## Pre-PR Checks

Build, lint, and test checks are enforced by **lefthook** (pre-push hook). When you `git push`, lefthook runs automatically - no need to run checks manually.

If the push fails due to lefthook - read the error output, fix the issue, commit the fix, and push again.

## Pull Requests

After finishing work on a branch:

1. Push the branch:
   ```bash
   git push -u origin feat/my-feature
   ```
2. Create a PR to main using `gh pr create`
3. The **user reviews and merges** - Claude never merges PRsа визу 

PR title should be concise (<70 chars). Body should summarize what changed and why.

## Releases

Releases happen **only when the user explicitly asks** ("сделай релиз", "release", etc.).

### Release process

1. Determine the new version based on commits since the last tag:
   - `feat:` → minor bump (v0.3.0 → v0.4.0)
   - `fix:` → patch bump (v0.3.0 → v0.3.1)
   - `BREAKING CHANGE` in commit body → major bump
   - If no tags exist yet, start with v0.1.0

2. Create a release branch:
   ```bash
   git checkout main
   git pull origin main
   git checkout -b release/vX.Y.Z
   ```

3. Update CHANGELOG.md and CHANGELOG.ru.md using the `changelog-maintenance` skill

4. Commit and create a PR:
   ```bash
   git add CHANGELOG.md CHANGELOG.ru.md
   git commit -m "chore(release): prepare vX.Y.Z"
   git push -u origin release/vX.Y.Z
   gh pr create --title "release: vX.Y.Z" --body "..."
   ```

5. The **user merges** the release PR. GitHub Action automatically creates the git tag and GitHub Release from the CHANGELOG

## Prohibited Actions

Never delete branches, tags, or releases - only the user can do that. Specifically:
- No `git branch -d/-D` on remote branches
- No `git push --delete`
- No `git tag -d` + push
- No `gh release delete`
- No `git push --force` to any branch

## Quick Reference

| Situation | Action |
|-----------|--------|
| Start new feature | `git checkout main && git pull && git checkout -b feat/...` |
| Switch to another task | WIP commit → checkout main → new branch |
| Work is done | Push (lefthook проверит) → create PR → checkout main |
| User says "release" | Determine version → release branch → CHANGELOG → PR |
| Merge conflict | Resolve, `git add`, continue rebase/merge |
