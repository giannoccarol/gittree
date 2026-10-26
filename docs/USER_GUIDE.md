# GitTree User Guide

This guide covers the repository actions available from the workspace toolbar, the sidebar, the context menus and their keyboard-first workflow.

## Opening one repository or a workspace

The welcome action and the `+` repository-tab button offer two choices:

- **Open single repository** selects one existing Git working tree.
- **Scan workspace folder** searches a root folder recursively and shows results progressively.

Workspace scanning is manual and cancellable. It does not create a watcher or retain the selected root. GitTree recognizes normal repositories and worktrees, stops below every repository it finds, and skips bare repositories, symlinks, dependency caches and common build-output folders. All new repositories are selected by default; repositories already open remain visible but disabled. Search, **Select all** and **Select none** can refine the import.

The welcome screen also offers **Clone repository**: paste a remote URL (HTTPS, SSH or `git@host:path`), choose a destination folder and GitTree clones it, then adds it to the workspace.

### Deep links

GitTree registers the `gittree://` protocol. Opening `gittree://open?path=<absolute-repository-path>` in the browser, the terminal or another app opens that repository in the running instance (or starts GitTree and opens it).

### First-run onboarding

Until you have opened a repository, checked out a branch and created a first commit, the welcome screen shows a checklist that marks each step as you complete it.

## Keyboard shortcuts

| Action | Windows and Linux | macOS |
| --- | --- | --- |
| Open repository | `Ctrl+O` | `⌘O` |
| Search | `Ctrl+P` | `⌘P` |
| Fetch | `Ctrl+Shift+F` | `⌘⇧F` |
| Pull | `Ctrl+Shift+L` | `⌘⇧L` |
| Push | `Ctrl+Shift+P` | `⌘⇧P` |
| Create branch | `Ctrl+Shift+B` | `⌘⇧B` |
| Refresh workspace | `F5` | `F5` |

Shortcuts are ignored while a text field, selector or modal dialog is active. Repository mutations also require an active repository.

The same reference is available from the dedicated **Settings → Keyboard shortcuts** entry. Toolbar controls stay compact and do not repeat shortcut labels.

## Fetch

Fetch downloads remote refs and updates GitTree's knowledge of remote branches without checking out another branch or modifying working files.

Use **Fetch** or its shortcut when:

- a teammate has pushed commits;
- ahead/behind counters may be stale;
- a new remote branch should appear in the sidebar;
- you want to update repository information before pull, merge or rebase.

Fetch, pull and push are **per repository**: switching tabs while one runs keeps the busy state on the tab that owns the operation, and only that repository is refreshed when it completes.

## Pull

Pull updates the current local branch from its configured remote. Review the branch name and ahead/behind indicator before running it.

GitTree does not automatically stash local work. If Git reports blocking changes or conflicts, the application preserves the operation state and exposes the appropriate recovery workflow.

## Push

Push publishes commits from the current local branch to its configured remote. Branches without an upstream use the explicit publish or remote selection workflows provided by the branch context menu. The same menu can push tags to any remote.

GitTree never stores Git passwords or private SSH keys. Authentication remains delegated to the credential helper, SSH agent or operating-system tooling already configured for Git.

## Network timeout

Fetch, pull, push, tag publishing and remote branch deletion stop when the remote sends nothing for **300 seconds**; the error names the Git command that was stopped. Git never waits for a password typed in a terminal (`GIT_TERMINAL_PROMPT=0`), so use a credential helper, an SSH agent or an askpass program.

While a network command runs, the other actions on the same repository wait for it. To change the limit, set `gittree.networkTimeout` in seconds, globally or for one repository; `0` turns the limit off:

```bash
git config --global gittree.networkTimeout 600
```

When a pull is stopped, the download that Git started for it may keep retrying in the background until the connection fails.

## Working tree changes

The **Changes** view splits the working tree into **Unstaged** and **Staged** lists. Each file row can be staged or unstaged as a whole; opening a file shows its diff with **Stage hunk** / **Unstage hunk** actions for partial staging.

- **Discard all** (or the trash icon on a row) permanently reverts uncommitted changes: tracked files are restored from the index, untracked files are deleted. A confirmation dialog always lists the affected count, and a stale snapshot is rejected if the working tree changed underneath.
- Files in conflict cannot be discarded — resolve them first in the Merge Editor.
- When a repository contains **submodules**, a bar above the lists offers **Initialize submodules** and **Update submodules**; submodule entries are marked with a badge.

The commit composer supports a summary, a body, amend, sign-off and GPG/SSH signing, plus per-repository author profiles assigned in Settings.

## Quick branch creation

Open the quick branch dialog with `Ctrl+Shift+B` on Windows/Linux or `⌘⇧B` on macOS. It is also available from the plus button and **Create branch** row in the sidebar.

The dialog provides three branch types:

- **Feature** for product work;
- **Bug fix** for corrections;
- **Custom** for an explicit branch path.

For Feature and Bug fix, GitTree inspects local and remote branch folders before suggesting a name. For example:

| Existing project folders | Description | Proposed branch |
| --- | --- | --- |
| `feature/`, `bugfix/` | `Account profiles` | `feature/account-profiles` |
| `feat/`, `fix/` | `Issue 1911` | `fix/issue-1911` |

If the project has no matching folders, the defaults are `feature/` and `bugfix/`.

Descriptions are normalized to lowercase, spaces become hyphens and unsupported characters are removed. The final branch name is shown before creation. Existing local names are rejected immediately, while the main process still performs Git's complete ref validation.

Creating the branch starts from the current `HEAD`, checks out the new branch and refreshes the workspace. The Custom option preserves the previous ability to use another hierarchy, such as `release/version-2`.

If Git rejects the operation, the dialog remains open and shows the complete error. It closes only after the new branch has been confirmed.

## Branch context menu

Right-click any branch for:

- **Checkout**, **Merge into current branch**, **Rebase onto**;
- **Fetch**, **Pull**, **Push** (tracked upstream or any remote), **Track remote**;
- **Stash changes** before switching;
- **Diff against current branch**, **Rename**, **Delete** (safe or forced);
- **Create pull request** on the hosting provider;
- **Checkout in new worktree…** — pick a destination folder and a new branch name; GitTree creates the linked worktree and opens it as a repository tab;
- **Push tags…**, **Manage remotes…**, **View reflog…**.

## Working with tags

- **Create** a tag from a commit (right-click the commit): an empty annotation creates a lightweight tag, an annotation creates an annotated tag.
- **Delete** tags from the same menu: choose one or more tags pointing at that commit and confirm.
- **Push tags…** publishes local tags to a chosen remote. Deleting a remote tag requires a manual `git push --delete` for now.

## Managing remotes

**Settings → Remotes** lists every remote with its push URL. You can:

- add a remote (name + URL);
- rename a remote;
- change its URL;
- remove it (tracking branches stay local).

The branch context menu opens this section directly with **Manage remotes…**.

## Reflog

**View reflog…** (branch context menu) shows every recent movement of `HEAD` — commit, ref label, message and date. From any entry you can **create a branch** to recover work that lost its ref, or **copy the hash**.

## Linked worktrees

Worktrees are listed in **Settings → Worktrees** with their branch and path; the current one is marked. Linked worktrees can be removed from there (the working tree files are deleted). Creating them happens from the branch context menu; the scanner and the tab bar treat every worktree as an ordinary repository.

## Stashes

The sidebar stash list shows each stash with hover actions:

- **Pop** restores the changes and removes the entry;
- **Apply** restores the changes and keeps the entry;
- **Drop** deletes the entry (with confirmation).

Stash creation includes untracked files.

## Restoring a file from history

Right-click a commit and choose **Checkout file from commit…**: filter the file list, pick one file and GitTree restores its content from that commit into the working tree (replacing the current version).

## History filters and sorting

The History toolbar combines:

- free-text filtering across message, full hash, author name and email;
- an author filter;
- reference filters for branches, tags, HEAD or commits without references;
- sorting by topology, newest/oldest date, author, message or hash.

Filters and sorting are stored per repository. Topological order shows the real multi-lane graph. Other sort modes use a simple commit marker because reordered rows cannot truthfully preserve Git topology.

## Creating a pull request

The branch context menu can open a prefilled pull request page for GitHub, GitLab, Bitbucket Cloud and Azure DevOps. Azure DevOps supports current `dev.azure.com` HTTPS remotes, SSH `v3` remotes and legacy `visualstudio.com` URLs. Authentication continues in the system browser; GitTree does not handle browser credentials for this action.

## Inspector and diff layout

The Inspector supports Unified and Split layouts, plus a **word-level** toggle that highlights the changed words inside each modified line. Maximizing the Inspector automatically opens the Split layout so deletions stay on the left and additions stay on the right.

Changed line groups are paired row by row. File headers and hunk headers span both columns. Restoring the Inspector returns to the previous diff layout unless the layout was changed manually while maximized.

Unified diffs show old and new line-number gutters together. Split diffs show the old number on the left and the new number on the right. The same numbering rules apply to staged/unstaged changes and Pull Request patches; clicking an available new-line number in a provider diff starts an inline review comment.

The pop-out inspector (**Open in new window**) mirrors the main window live: commit selection, working-tree diffs, theme and tone stay in sync until the window is closed.

## Merging with pending changes

GitTree only blocks a merge when the incoming branch would **overwrite** one of your pending files. Pending changes on untouched files are preserved: the merge preview shows a *"Local changes won't be touched"* notice and the merge proceeds. When files do overlap, the preview lists them and offers **View changes** or **Stash and continue** (the stash includes untracked files).

## Resolving conflicts in the Merge Editor

When merge, rebase or cherry-pick stops on a conflict, GitTree opens its native Merge Editor:

- **Incoming** is shown on the left and **Current** on the right.
- **Result** remains editable below them; a vertical layout is also available.
- **Base** is available as an optional expandable reference.
- Previous/next controls navigate conflict blocks.
- Each block supports Current, Incoming, Both and a Smart Combination only when the base makes that combination provably safe.

Selections only update the in-memory Result. GitTree writes and stages the file only after **Mark as resolved** and its confirmation. If the file changed outside GitTree, the saved snapshot is rejected and the latest conflict is reloaded. Unresolved conflict markers are never staged. Binary conflicts use the same explicit final confirmation but offer only Current or Incoming.

## Environment requirements

- **Node.js 22+** and **Git** to run from source.
- GitTree recommends **Git 2.45.1 or newer**: older versions lack fixes for local-clone and submodule vulnerabilities. If your Git is older, a warning appears in Settings → About (operations still work, but are not recommended).
- A `--log-level=debug|info|warn|error` command-line flag raises the verbosity of the structured log written to the user-data `logs` folder (tokens are redacted).
