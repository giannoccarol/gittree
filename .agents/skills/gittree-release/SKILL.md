---
name: gittree-release
description: Prepare, publish, monitor, and verify GitTree desktop releases through GitHub Actions and GitHub Releases, including semantic versioning, OAuth build variables, native artifacts, OTA metadata, signing gates, and rollback-safe failure handling. Use when releasing a new GitTree version, creating or validating a release tag, configuring the release pipeline, diagnosing a failed release workflow, or checking that installed clients can discover an update.
---

# GitTree Release

Ship one complete release from a clean, validated commit. Use the repository workflow as the only publisher; never upload partial native builds directly.

## Read the release contract

Before changing release state, read:

- `package.json`
- `electron-builder.yml`
- `.github/workflows/release.yml`
- `docs/RELEASING.md`
- `docs/UPDATES.md`
- `scripts/check-release-version.js`
- `scripts/release-assets.js`

Preserve unrelated work and existing history. Do not reset, force-push, move a published tag, expose OAuth tokens, or pass client secrets through logs.

## 1. Inspect before releasing

Resolve facts instead of assuming them:

- Check `git status --short --branch`, remotes, tags, and the default branch.
- Fetch tags before selecting a version.
- Confirm `gh auth status` and query the exact repository with `gh repo view`.
- Confirm that the target version and `v<version>` tag do not already exist.
- Confirm the repository variable names without printing secrets:
  - `GITTREE_GITHUB_CLIENT_ID`
  - `GITTREE_GITLAB_CLIENT_ID`
- Treat signing as capability-based:
  - Windows signing is optional but recommended.
  - macOS OTA requires both signing and notarization credentials.
  - Unsigned macOS releases must expose only the manual DMG, never a broken OTA feed.

The workflow's scoped `contents: write` permission is sufficient. Do not broaden the repository-wide default workflow permission without a demonstrated need.

## 2. Validate configuration

Run the production release check with the public client IDs supplied as environment variables. Retrieve them from GitHub Actions variables without echoing them. The package version and requested tag must match exactly.

Verify GitHub Device Flow by requesting a device code and checking for a successful response; do not authorize the throwaway code. Never request or store a GitHub App client secret or private key for the desktop Device Flow.

For GitLab, use only the public Application ID from a non-confidential application with `api` scope. Never place its Secret in the build or repository.

## 3. Prepare the version

Do not bump versions by hand for official releases. Push Conventional Commits to `master` and let `.github/workflows/versioning.yml` create the next SemVer tag (`.releaserc`: breaking → major, `feat` → minor, fixes → patch; the first breaking change after `0.30.x` opens `1.0.0`). Only intervene manually when recovering a broken tag.

## 4. Run release gates

Run every gate before creating the tag:

```text
npm run release:check
npm run validate
npm run test:renderer-ui
npm run perf:renderer
git diff --check
```

The renderer regression and performance scripts require GitTree to run with the local CDP endpoint expected by the scripts. Start the repository's Electron binary with `--remote-debugging-port=9222`, retain its exact PID, run both commands, and close only that process afterward.

Do not dismiss a failed gate. Reproduce it from a fresh app process, distinguish an app regression from a test race, fix the cause, and rerun the original gate.

## 5. Commit, tag, and publish

Require a clean worktree after the release commit. Push the release commit to the repository's actual default branch, then create one annotated tag:

```text
git tag -a v<version> -m "GitTree <version>"
git push origin v<version>
```

The tag starts `.github/workflows/release.yml`. Do not run `electron-builder --publish always` and do not publish the draft manually while native jobs are running. The workflow must:

1. validate version and source;
2. create or clean one draft;
3. build Windows, macOS, and Linux natively;
4. upload only validated assets;
5. publish only after every required job succeeds.

## 6. Monitor to a terminal state

Locate the run for the exact tag and watch it with `gh run watch --exit-status`. If it fails:

- inspect the failing job and logs;
- leave the release draft unpublished;
- do not move or delete the tag without explicit user approval;
- fix the source in a new commit and agree on the recovery strategy.

Do not report success while the workflow is queued or running.

## 7. Verify the published release

Read the final release and assets with `gh release view`. Confirm:

- the release is public and not a draft;
- stable tags are latest releases and prerelease tags are marked prerelease;
- Windows contains NSIS installer, blockmap, and `latest.yml`;
- signed macOS contains DMG, ZIP update payload, metadata, and applicable blockmap;
- unsigned macOS contains the manual DMG only;
- Linux contains AppImage, DEB, `latest-linux.yml`, and applicable blockmap;
- OTA metadata version equals `package.json`;
- metadata URLs and hashes refer to assets in the same release.

Use a temporary directory for downloaded verification artifacts and remove it afterward. Do not install the release automatically.

Finish by reporting the release URL, commit, tag, platform coverage, signing limitations, test results, and whether the previous packaged version can discover the new OTA metadata.
