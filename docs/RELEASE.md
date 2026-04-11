# Release runbook — `react-native-infinite-material-tab`

This document describes the **tag-based release flow** with exact `gh` commands
so that both humans and LLM agents (Claude Code) can execute releases without
ambiguity. Every step is idempotent where possible.

---

## Flow at a glance

```text
feature branch ──► PR ──► CI green ──► self-approve ──► squash merge to main
                                                               │
                                                               ▼
                                              bump version + update CHANGELOG
                                                               │
                                                               ▼
                                              git tag vX.Y.Z + push tag
                                                               │
                                                               ▼
                                           publish.yml runs (on tag push)
                                                               │
                                                               ▼
                                         ┌─────── npm publish ───────┐
                                         │                            │
                                         ▼                            ▼
                             registry.npmjs.org         GitHub Release created
```

**Three workflows back this flow:**

| Workflow | Trigger | Purpose |
|---|---|---|
| `ci.yml` | push / PR to `main` | lint + typecheck + unit test + library build + example metro bundle |
| `e2e.yml` | `workflow_dispatch` (manual) | Maestro iOS E2E on macOS runner |
| `publish.yml` | tag push `v*.*.*` (real publish) or `workflow_dispatch` (dry-run only) | npm publish + GitHub Release |

**Branch protection on `main` enforces:**
- All 3 CI jobs must pass (`lint-test`, `build-library`, `build-example`)
- Conversations must be resolved
- Linear history (no merge commits)
- No force-push, no deletion
- Approvals are **not** required (`required_approving_review_count: 0`).
  GitHub structurally disallows the PR author from approving their own PR,
  so this project — maintained solo — relies on CI + conversation-resolution
  as the quality gate. If more maintainers join, bump this back to 1.

---

## 0. Prerequisites

Set once per machine. These are already in place in the live environment.

```bash
gh auth status   # Must be authenticated as a repo admin
```

Required GitHub secret (set once):

```bash
# Already set — verify:
gh secret list --repo johntips/react-native-infinite-material-tab \
  | grep NPM_TOKEN
```

If not set:

```bash
printf '%s' '<npm-token>' \
  | gh secret set NPM_TOKEN --repo johntips/react-native-infinite-material-tab
```

---

## 1. Start a feature branch

```bash
cd react-native-infinite-material-tab
git fetch origin
git checkout -b fix/<short-slug> origin/main
```

Work, test locally:

```bash
pnpm install
pnpm lint
pnpm tsc --noEmit
pnpm test
pnpm build
```

Commit and push:

```bash
git add <specific files>
git commit -m "fix: <concise summary>"
git push -u origin fix/<short-slug>
```

---

## 2. Open a PR

```bash
gh pr create \
  --repo johntips/react-native-infinite-material-tab \
  --base main \
  --head fix/<short-slug> \
  --title "fix: <concise summary>" \
  --body "$(cat <<'EOF'
## Summary

<why this change>

## Test plan

- [x] pnpm lint
- [x] pnpm tsc --noEmit
- [x] pnpm test
- [x] pnpm build
EOF
)"
```

The PR URL is printed to stdout. Save it.

---

## 3. Wait for CI to go green

```bash
# Watch the PR's status checks
gh pr checks <PR_NUMBER> --repo johntips/react-native-infinite-material-tab --watch
```

Required checks that must pass:
- `Lint / Typecheck / Unit test`
- `Build library (tsc)`
- `Build example (metro bundle)`

If any check fails, read the failed job's log:

```bash
gh run list \
  --repo johntips/react-native-infinite-material-tab \
  --workflow=ci.yml \
  --limit 3
gh run view <RUN_ID> --repo johntips/react-native-infinite-material-tab --log-failed
```

Fix, commit, push; CI reruns automatically.

---

## 4. Merge (no approval step)

Branch protection requires CI to be green and every review conversation to be
resolved, but it does **not** require approvals — GitHub structurally blocks
self-approval on a solo repo, so we rely on CI as the gate instead.

Verify the PR is mergeable:

```bash
gh pr view <PR_NUMBER> \
  --repo johntips/react-native-infinite-material-tab \
  --json mergeable,mergeStateStatus,reviewDecision
```

Expected:
- `mergeable: MERGEABLE`
- `mergeStateStatus: CLEAN`
- `reviewDecision: ""` (empty because no review was required)

Squash merge:

```bash
gh pr merge <PR_NUMBER> \
  --repo johntips/react-native-infinite-material-tab \
  --squash \
  --delete-branch
```

---

## 5. Bump version + update CHANGELOG on main

Pull the merged main locally:

```bash
git checkout main
git pull --ff-only origin main
```

Bump the version in `package.json`:

```bash
# Patch: 0.2.1 → 0.2.2
npm version patch --no-git-tag-version

# Minor: 0.2.1 → 0.3.0
npm version minor --no-git-tag-version

# Major: 0.2.1 → 1.0.0
npm version major --no-git-tag-version
```

Then edit `CHANGELOG.md` and prepend a new section:

```markdown
## [X.Y.Z] - YYYY-MM-DD

### Fixed / Added / Changed
<user-facing notes>
```

> The `publish.yml` workflow extracts this section automatically from the
> `## [X.Y.Z]` header — match the format exactly.

---

## 6. Commit the version bump via PR

**You cannot push to main directly.** Create a release PR:

```bash
NEW_VERSION=$(node -p "require('./package.json').version")
git checkout -b release/v${NEW_VERSION} origin/main
git add package.json CHANGELOG.md
git commit -m "chore(release): v${NEW_VERSION}"
git push -u origin release/v${NEW_VERSION}

gh pr create \
  --repo johntips/react-native-infinite-material-tab \
  --base main \
  --head release/v${NEW_VERSION} \
  --title "chore(release): v${NEW_VERSION}" \
  --body "Release PR for v${NEW_VERSION}. See CHANGELOG.md for notes."
```

Wait for CI green → self-approve → squash merge.

---

## 7. Tag the released commit

After merge, the main branch now has the version bump commit:

```bash
git checkout main
git pull --ff-only origin main

NEW_VERSION=$(node -p "require('./package.json').version")
git tag -a "v${NEW_VERSION}" -m "Release v${NEW_VERSION}"
git push origin "v${NEW_VERSION}"
```

The tag push fires `publish.yml` automatically.

---

## 8. Verify publish + release

```bash
# Watch the publish run
gh run list \
  --repo johntips/react-native-infinite-material-tab \
  --workflow=publish.yml \
  --limit 3

RUN_ID=$(gh run list \
  --repo johntips/react-native-infinite-material-tab \
  --workflow=publish.yml \
  --limit 1 \
  --json databaseId --jq '.[0].databaseId')

gh run watch "$RUN_ID" --repo johntips/react-native-infinite-material-tab
```

Verify the new version is on npm:

```bash
NEW_VERSION=$(node -p "require('./package.json').version")
npm view react-native-infinite-material-tab@${NEW_VERSION} version
```

Verify the GitHub Release was created:

```bash
gh release view "v${NEW_VERSION}" \
  --repo johntips/react-native-infinite-material-tab
```

---

## 9. Emergency rollback

If a bad version ships, deprecate on npm (never force-delete — semver contract):

```bash
npm deprecate "react-native-infinite-material-tab@<X.Y.Z>" \
  "Deprecated: see https://github.com/johntips/react-native-infinite-material-tab/issues/<n>"
```

Cut a new patch version with the fix and follow steps 1–8 again.

---

## Running Maestro E2E manually

When a PR touches the render pipeline, run the full device validation from the
Actions tab or via CLI:

```bash
gh workflow run e2e.yml \
  --repo johntips/react-native-infinite-material-tab \
  --ref fix/<short-slug> \
  -f ref=fix/<short-slug>
```

Watch:

```bash
RUN_ID=$(gh run list \
  --repo johntips/react-native-infinite-material-tab \
  --workflow=e2e.yml \
  --limit 1 \
  --json databaseId --jq '.[0].databaseId')

gh run watch "$RUN_ID" --repo johntips/react-native-infinite-material-tab
```

Results (GIF, screenshots, JUnit XML) are uploaded as `maestro-results-<RUN_ID>`
with 7-day retention.

---

## Appendix: branch protection configuration

Stored in-repo for reference — matches the actual `PUT /repos/.../branches/main/protection` body.

```json
{
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "Lint / Typecheck / Unit test",
      "Build library (tsc)",
      "Build example (metro bundle)"
    ]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false,
    "required_approving_review_count": 0,
    "require_last_push_approval": false
  },
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true,
  "lock_branch": false,
  "allow_fork_syncing": true
}
```

To re-apply if it drifts:

```bash
cat > /tmp/branch-protection.json <<'JSON'
<paste the JSON above>
JSON
gh api -X PUT /repos/johntips/react-native-infinite-material-tab/branches/main/protection \
  --input /tmp/branch-protection.json
```
