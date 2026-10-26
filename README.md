<p align="center">
  <img src="icon.png" width="128" alt="GitTree">
</p>

<h1 align="center">GitTree</h1>

<p align="center">
  <strong>See your repository clearly.</strong><br>
  A fast, open-source Git desktop client for visual history, explicit workflows,<br>
  and local-first repository management. No required account.
</p>

<p align="center">
  <a href="https://github.com/giannoccarol/gittree/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/giannoccarol/gittree/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/giannoccarol/gittree/releases"><img alt="Release" src="https://img.shields.io/github/v/release/giannoccarol/gittree?display_name=tag"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-102A4C"></a>
  <img alt="Platforms" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-102A4C">
</p>

<p align="center">
  <a href="#installation">Install</a> ·
  <a href="docs/USER_GUIDE.md">User Guide</a> ·
  <a href="CONTRIBUTING.md">Contributing</a> ·
  <a href="https://github.com/giannoccarol/gittree/releases">Releases</a>
</p>

---

## Preview

Real GitTree builds captured from the deterministic Electron test fixture. No user repositories or personal data are used.

<p align="center">
  <img src="docs/screenshots/gittree-history-light.png" width="960" alt="GitTree commit history in the light theme">
</p>

<p align="center">
  <img src="docs/screenshots/gittree-history-dark.png" width="960" alt="GitTree commit history in the dark theme">
</p>

## Why GitTree

Busy repositories should not feel opaque. GitTree keeps history, branches, working changes, and repository state readable in one fluid desktop workspace. It answers the questions you ask every day — which branch am I on, where did this commit come from, what will this merge change — without hiding Git behind a proprietary model.

It works directly with the **local repository**, runs **explicit Git operations**, and remains compatible with the Git workflows and tools you already use.

Open source. No mandatory accounts. No telemetry. No proprietary sync.

## Features

- **Multi-repo workspace** — tabs, recursive folder import, worktree-aware discovery, restored layout, `gittree://` deep links
- **Branch navigator** — local/remote folders, instant search, ahead/behind, and contextual branch actions
- **Multi-lane commit graph** — real parents, octopus merges, virtualized history, progressive paging, word-level diff highlighting
- **Working tree** — stage/unstage per file and hunk, **discard changes**, commit, amend, sign-off, GPG/SSH signing, identity setup, hooks always on
- **Merge / rebase / cherry-pick** — previews, conflict editor (Incoming / Current / Result), Continue / Skip / Abort, smart merge when pending changes do not overlap
- **Branch lifecycle** — create, rename, delete, track, checkout, **checkout into a linked worktree**, recover any commit from the **reflog**
- **Tags** — create annotated or lightweight, **delete, push to a remote**, multi-select from the commit menu
- **Remotes** — add, rename, change URL, remove from Settings; provider-aware push menus
- **Stashes** — create, **apply, pop, drop** straight from the sidebar
- **Submodules** — detected in the working tree, initialize and update from the Changes view
- **Pull request review** — GitHub & GitLab OAuth device flow, diffs, inline comments, encrypted drafts, Azure DevOps via PAT
- **Hosting awareness** — GitHub, GitLab, Bitbucket Cloud, Azure DevOps compare/PR URLs
- **Themes & i18n** — light and dark, five tones each; English and Italian
- **Keyboard-first** — fetch, pull, push, create branch shortcuts on every platform
- **Safety** — per-repo git operation queue, snapshot-guarded mutations, input validation on every git boundary, encrypted credential vault, code signing workflow for Windows

Full workflow: [User Guide](docs/USER_GUIDE.md).

## Installation

Download the installer from [GitHub Releases](https://github.com/giannoccarol/gittree/releases):

| Platform | Artifact |
| --- | --- |
| Windows | NSIS installer |
| macOS | DMG |
| Linux | AppImage, DEB or Pacman package |

Until production certificates are enabled, the OS may warn about unsigned builds.

On Arch Linux and derivatives, download the `.pacman` asset and install it with:

```bash
sudo pacman -U GitTree-*-linux-x64.pacman
```

### Run from source

Requires **Node.js 22+**, **Git**, and **npm**.

```bash
git clone https://github.com/giannoccarol/gittree.git
cd gittree
npm ci
npm start
```

## Privacy & security

- No GitTree account
- No built-in telemetry
- No automatic repository upload
- No raw Git command bridge from the renderer
- OAuth tokens stay in the main process, encrypted with Electron `safeStorage`
- `contextIsolation` on, `nodeIntegration` off

Sensitive reports: [SECURITY.md](SECURITY.md).

## Development

| Command | Purpose |
| --- | --- |
| `npm start` | Launch the app |
| `npm test` | Run tests |
| `npm run lint` | ESLint (error-level, blocks CI) |
| `npm run test:coverage` | Tests with a coverage report |
| `npm run validate` | Tests + design audit |
| `npm run audit:design` | Design-system rules |
| `npm run screenshots:readme` | Regenerate deterministic README screenshots |
| `npm run perf:renderer` | Renderer benchmark |
| `npm run perf:history` | Commit-history loading benchmark on a synthetic repository |
| `npm run dist:win` / `dist:mac` / `dist:linux` | Platform installers |

```text
src/
├── main/        Git, hosting, vault, IPC, updates, logging, deep links
├── preload.js   Explicit isolated bridge
└── renderer/    Workspace, components, themes, i18n
```

Release guide: [docs/RELEASING.md](docs/RELEASING.md) · OAuth: [docs/OAUTH.md](docs/OAUTH.md) · Updates: [docs/UPDATES.md](docs/UPDATES.md) · Performance: [docs/PERFORMANCE.md](docs/PERFORMANCE.md) · Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · Design: [DESIGN.md](DESIGN.md) · Architecture decisions: [docs/adr/](docs/adr/)

## Brand

Source code is MIT-licensed. The GitTree name, logo, and visual identity are not. Modified or commercial distributions must use distinct branding. See [TRADEMARKS.md](TRADEMARKS.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Before opening a PR:

1. Keep Git operations explicit and reversible
2. Never expose tokens or credentials to the renderer
3. Add English and Italian strings together
4. Follow the [design system](DESIGN.md)
5. Run `npm run quality`

## License

[MIT](LICENSE)
