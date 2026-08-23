//! GitTree nativo con GPUI: replica il layout dell'app Electron
//! (header, command bar, sidebar branches, history/changes, inspector,
//! status bar) usando gittree-core per tutte le operazioni Git.
//!
//! Uso: gittree-gpui [percorso-repo]   (default: la directory corrente)

use std::ops::Range;
use std::sync::Arc;

use gpui::prelude::*;
use gpui::{
    Animation, AnimationExt, App, Application, Bounds, ClickEvent, Context, FocusHandle, Focusable,
    InteractiveElement, KeyBinding, ParentElement, Render, SharedString, Styled,
    UniformListScrollHandle, Window, WindowBounds, WindowOptions, actions, canvas, div, point, px,
    size, uniform_list,
};

use crate::models::{CommitRow, DiffModel, GraphRow, RefChipKind, build_rows};
use crate::motion::breathing;
use crate::service::{GitService, Snapshot};
use crate::theme::{Theme, ThemeChoice};
use crate::ui::{
    badge, btn_icon, btn_icon_sm, btn_primary, btn_toolbar, card, chip, icon, panel, pulsing_icon,
    segmented, segmented_item,
};
use crate::widgets::text_field::TextField;
use gittree_core::git::ops::CommitOptions;
use gittree_core::git::status::StatusDetail;

mod icons;
mod models;
mod motion;
mod service;
mod theme;
mod ui;
mod widgets;

const HISTORY_LIMIT: usize = 5_000;
/// Altezza riga dell'app Electron (`.graph-row`, 38px).
const COMMIT_ROW_HEIGHT: f32 = 38.0;
const DIFF_ROW_HEIGHT: f32 = 20.0;
const BRANCH_ROW_HEIGHT: f32 = 30.0;
/// Colonna grafo di default (`.graph-view --graph-column-graph`).
const GRAPH_COL_WIDTH: f32 = 84.0;
const AUTHOR_COL_WIDTH: f32 = 150.0;
const DATE_COL_WIDTH: f32 = 130.0;
const HASH_COL_WIDTH: f32 = 64.0;
const SIDEBAR_WIDTH: f32 = 250.0;
const INSPECTOR_WIDTH: f32 = 400.0;
const FILE_RAIL_WIDTH: f32 = 150.0;
const TAGS_PREVIEW_LIMIT: usize = 24;

// Geometria del grafo, identica a `createGraphSegments` (graph-layout.mts):
// `x(lane) = 12 + lane * 18`, nodo a meta' riga (19px su righe da 38px).
const LANE_X0: f32 = 12.0;
const LANE_PITCH: f32 = 18.0;
const GRAPH_STROKE: f32 = 1.65;
const NODE_RADIUS: f32 = 4.0;
const MERGE_NODE_RADIUS: f32 = 5.0;
const HEAD_RING_RADIUS: f32 = 8.0;

// Percorsi asset delle icone Phosphor regolari (crate::icons::EmbeddedIcons).
const ICON_BRANCH: &str = "icons/git-branch.svg";
const ICON_COMMIT: &str = "icons/git-commit.svg";
const ICON_FETCH: &str = "icons/cloud-arrow-down.svg";
const ICON_PULL: &str = "icons/download-simple.svg";
const ICON_PUSH: &str = "icons/upload-simple.svg";
const ICON_INSPECTOR: &str = "icons/sidebar-simple.svg";
const ICON_SEARCH: &str = "icons/magnifying-glass.svg";
const ICON_PLUS: &str = "icons/plus.svg";
const ICON_MINUS: &str = "icons/minus.svg";
const ICON_CARET_LEFT: &str = "icons/caret-left.svg";
const ICON_CLOSE: &str = "icons/x.svg";
const ICON_MOON: &str = "icons/moon.svg";
const ICON_SUN: &str = "icons/sun.svg";
const ICON_SPINNER: &str = "icons/circle-notch.svg";

actions!(workspace, [Refresh, NextCommit, PrevCommit, FocusSearch]);

#[derive(Clone, Copy, PartialEq, Debug)]
enum ViewMode {
    History,
    Changes,
}

/// Stato di un pannello del workspace con la sua animazione corrente,
/// specchio di `WorkspacePanelMotion` (is-*-opening / is-*-closing).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum PanelState {
    Closed,
    Entering { generation: u64 },
    Open,
    Closing { generation: u64 },
}

impl PanelState {
    fn is_visible(self) -> bool {
        self != Self::Closed
    }

    fn is_active_toggle(self) -> bool {
        matches!(self, Self::Open | Self::Entering { .. })
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum PanelSide {
    Sidebar,
    Inspector,
}

#[derive(Clone)]
enum DiffSource {
    Commit(String),
    Worktree(String),
}

impl PartialEq for DiffSource {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (DiffSource::Commit(a), DiffSource::Commit(b)) => a == b,
            (DiffSource::Worktree(a), DiffSource::Worktree(b)) => a == b,
            _ => false,
        }
    }
}

struct BranchItem {
    name: SharedString,
    haystack: String,
    is_current: bool,
}

struct Inspector {
    source: Option<DiffSource>,
    model: DiffModel,
    visible_file: Option<usize>,
    scroll: UniformListScrollHandle,
}

struct Workspace {
    service: Arc<GitService>,
    repo_name: SharedString,
    theme_choice: ThemeChoice,
    palette: Theme,
    mode: ViewMode,
    sidebar_motion: PanelState,
    inspector_motion: PanelState,
    panel_gen: u64,
    busy: usize,
    message: SharedString,
    message_seq: u64,
    error: Option<SharedString>,
    pending_discard: bool,
    first_load_done: bool,

    rows: Vec<CommitRow>,
    graph_rows: Vec<GraphRow>,
    graph_lane_count: usize,
    filtered: Vec<usize>,
    history_query: String,
    selected_hash: Option<String>,
    list_scroll: UniformListScrollHandle,

    branches: Vec<BranchItem>,
    branches_visible: Vec<usize>,
    tags: Vec<SharedString>,
    status: Option<StatusDetail>,
    branch_query: String,

    amend: bool,
    signoff: bool,
    summary_non_empty: bool,
    changes_selected: Option<String>,

    new_branch_open: bool,

    branch_filter: gpui::Entity<TextField>,
    history_filter: gpui::Entity<TextField>,
    new_branch_field: gpui::Entity<TextField>,
    summary_field: gpui::Entity<TextField>,
    body_field: gpui::Entity<TextField>,

    inspector: Inspector,
    focus: FocusHandle,
}

impl Focusable for Workspace {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Workspace {
    fn new(repo_path: &str, cx: &mut Context<Self>) -> Self {
        let path = std::path::PathBuf::from(repo_path);
        let repo_name = path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| repo_path.to_string());

        let branch_filter = cx.new(|cx| TextField::new(cx).placeholder("Filter branches"));
        let history_filter = cx.new(|cx| TextField::new(cx).placeholder("Search commits"));
        let new_branch_field = cx.new(|cx| TextField::new(cx).placeholder("New branch name"));
        let summary_field = cx.new(|cx| TextField::new(cx).placeholder("Commit summary"));
        let body_field = cx.new(|cx| {
            TextField::new(cx)
                .placeholder("Description (optional)")
                .multiline(true)
        });

        cx.observe(&branch_filter, |this, _, cx| this.sync_fields(cx))
            .detach();
        cx.observe(&history_filter, |this, _, cx| this.sync_fields(cx))
            .detach();
        cx.observe(&summary_field, |this, _, cx| this.sync_fields(cx))
            .detach();

        let mut workspace = Self {
            service: Arc::new(GitService::new(path)),
            repo_name: repo_name.into(),
            theme_choice: ThemeChoice::Dark,
            palette: Theme::new(ThemeChoice::Dark),
            mode: ViewMode::History,
            sidebar_motion: PanelState::Open,
            inspector_motion: PanelState::Open,
            panel_gen: 0,
            busy: 0,
            message: SharedString::from("Loading repository…"),
            message_seq: 0,
            error: None,
            pending_discard: false,
            first_load_done: false,
            rows: Vec::new(),
            graph_rows: Vec::new(),
            graph_lane_count: 1,
            filtered: Vec::new(),
            history_query: String::new(),
            selected_hash: None,
            list_scroll: UniformListScrollHandle::new(),
            branches: Vec::new(),
            branches_visible: Vec::new(),
            tags: Vec::new(),
            status: None,
            branch_query: String::new(),
            amend: false,
            signoff: false,
            summary_non_empty: false,
            changes_selected: None,
            new_branch_open: false,
            branch_filter,
            history_filter,
            new_branch_field,
            summary_field,
            body_field,
            inspector: Inspector {
                source: None,
                model: DiffModel::empty(),
                visible_file: None,
                scroll: UniformListScrollHandle::new(),
            },
            focus: cx.focus_handle(),
        };
        workspace.refresh(false, cx);
        workspace
    }

    // -- Sync dai campi testo -------------------------------------------

    fn sync_fields(&mut self, cx: &mut Context<Self>) {
        let mut changed = false;
        let query = self.history_filter.read(cx).value().trim().to_lowercase();
        if query != self.history_query {
            self.history_query = query;
            self.apply_history_filter();
            changed = true;
        }
        let query = self.branch_filter.read(cx).value().trim().to_lowercase();
        if query != self.branch_query {
            self.branch_query = query;
            self.apply_branch_filter();
            changed = true;
        }
        let summary_filled = !self.summary_field.read(cx).is_empty();
        if summary_filled != self.summary_non_empty {
            self.summary_non_empty = summary_filled;
            changed = true;
        }
        if changed {
            cx.notify();
        }
    }

    fn apply_history_filter(&mut self) {
        if self.history_query.is_empty() {
            self.filtered = (0..self.rows.len()).collect();
        } else {
            let query = &self.history_query;
            self.filtered = self
                .rows
                .iter()
                .enumerate()
                .filter(|(_, row)| row.haystack.contains(query.as_str()))
                .map(|(index, _)| index)
                .collect();
        }
    }

    fn apply_branch_filter(&mut self) {
        let query = self.branch_query.to_lowercase();
        self.branches_visible = self
            .branches
            .iter()
            .enumerate()
            .filter(|(_, branch)| query.is_empty() || branch.haystack.contains(&query))
            .map(|(index, _)| index)
            .collect();
    }

    // -- Messaggi --------------------------------------------------------

    fn set_message(&mut self, message: impl Into<SharedString>) {
        self.message = message.into();
        self.message_seq += 1;
        self.error = None;
    }

    fn set_error(&mut self, error: impl Into<SharedString>) {
        self.error = Some(error.into());
        self.message_seq += 1;
        self.message = "Operation failed".into();
    }

    // -- Motion dei pannelli ----------------------------------------------

    fn toggle_panel(&mut self, side: PanelSide, cx: &mut Context<Self>) {
        let current = match side {
            PanelSide::Sidebar => self.sidebar_motion,
            PanelSide::Inspector => self.inspector_motion,
        };
        let opening = !current.is_active_toggle();
        self.panel_gen += 1;
        let generation = self.panel_gen;
        let next = if opening {
            PanelState::Entering { generation }
        } else {
            PanelState::Closing { generation }
        };
        match side {
            PanelSide::Sidebar => self.sidebar_motion = next,
            PanelSide::Inspector => self.inspector_motion = next,
        }
        let this = cx.weak_entity();
        cx.spawn(async move |_, async_cx| {
            async_cx
                .background_executor()
                .timer(motion::PANEL_CHANGE)
                .await;
            this.update(async_cx, |workspace, cx| {
                workspace.settle_panel(side, generation, cx)
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    /// Normalizza lo stato a fine animazione: `Entering → Open`,
    /// `Closing → Closed`. Le generazioni vecchie vengono ignorate.
    fn settle_panel(&mut self, side: PanelSide, generation: u64, cx: &mut Context<Self>) {
        let settled = match (side, self.panel_state(side)) {
            (_, PanelState::Entering { generation: g }) if g == generation => {
                Some(PanelState::Open)
            }
            (_, PanelState::Closing { generation: g }) if g == generation => {
                Some(PanelState::Closed)
            }
            _ => None,
        };
        if let Some(state) = settled {
            match side {
                PanelSide::Sidebar => self.sidebar_motion = state,
                PanelSide::Inspector => self.inspector_motion = state,
            }
            cx.notify();
        }
    }

    fn panel_state(&self, side: PanelSide) -> PanelState {
        match side {
            PanelSide::Sidebar => self.sidebar_motion,
            PanelSide::Inspector => self.inspector_motion,
        }
    }

    // -- Esecuzione asincrona delle operazioni Git -----------------------

    fn run_git<R>(
        &mut self,
        cx: &mut Context<Self>,
        work: impl FnOnce(&GitService) -> Result<R, String> + Send + 'static,
        done: impl FnOnce(&mut Self, Result<R, String>, &mut Context<Self>) + 'static,
    ) where
        R: Send + 'static,
    {
        self.busy += 1;
        cx.notify();
        let service = self.service.clone();
        cx.spawn(async move |this: gpui::WeakEntity<Workspace>, async_cx| {
            let result = async_cx
                .background_spawn(async move { work(&service) })
                .await;
            this.update(async_cx, move |workspace, cx| {
                workspace.busy = workspace.busy.saturating_sub(1);
                done(workspace, result, cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn refresh(&mut self, keep_selection: bool, cx: &mut Context<Self>) {
        self.busy += 1;
        cx.notify();
        let service = self.service.clone();
        let previous = if keep_selection {
            self.selected_hash.clone()
        } else {
            None
        };
        cx.spawn(async move |this: gpui::WeakEntity<Workspace>, async_cx| {
            let snapshot = async_cx
                .background_spawn(async move { service.snapshot(HISTORY_LIMIT) })
                .await;
            this.update(async_cx, |workspace, cx| {
                workspace.busy = workspace.busy.saturating_sub(1);
                match snapshot {
                    Ok(snapshot) => workspace.apply_snapshot(snapshot, previous),
                    Err(error) => workspace.set_error(format!("git: {error}")),
                }
                workspace.load_commit_diff(cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn apply_snapshot(&mut self, snapshot: Snapshot, previous_selected: Option<String>) {
        let models = build_rows(&snapshot.page.commits, &snapshot.page.refs);
        self.rows = models.commits;
        self.graph_rows = models.graph_rows;
        self.graph_lane_count = models.graph_lane_count.max(1);

        if let Some(detail) = snapshot.status.as_ref() {
            let current = (!detail.detached).then_some(detail.branch.as_str());
            self.branches = snapshot
                .page
                .refs
                .iter()
                .filter(|reference| reference.full_name.starts_with("refs/heads/"))
                .map(|reference| BranchItem {
                    is_current: Some(reference.short_name.as_str()) == current,
                    haystack: reference.short_name.to_lowercase(),
                    name: SharedString::from(reference.short_name.clone()),
                })
                .collect();
            self.tags = snapshot
                .page
                .refs
                .iter()
                .filter(|reference| reference.full_name.starts_with("refs/tags/"))
                .map(|reference| SharedString::from(reference.short_name.clone()))
                .collect();
            self.tags.sort_unstable();
        } else {
            self.branches.clear();
            self.tags.clear();
        }
        self.status = snapshot.status;
        if let Some(error) = snapshot.status_error {
            self.set_error(format!("status: {error}"));
        }

        self.apply_history_filter();
        self.apply_branch_filter();

        self.selected_hash =
            previous_selected.filter(|hash| self.rows.iter().any(|row| row.hash == *hash));
        if self.selected_hash.is_none() {
            self.selected_hash = self
                .filtered
                .first()
                .map(|index| self.rows[*index].hash.clone());
        }

        if !self.first_load_done {
            self.first_load_done = true;
            self.set_message(format!(
                "{} commits · {} refs · {} branches",
                self.rows.len(),
                snapshot.page.refs.len(),
                self.branches.len()
            ));
        }
    }

    fn load_commit_diff(&mut self, cx: &mut Context<Self>) {
        let Some(hash) = self.selected_hash.clone() else {
            return;
        };
        let source = DiffSource::Commit(hash);
        self.inspector.source = Some(source.clone());
        self.inspector.visible_file = None;
        let expected = source.clone();
        self.run_git(
            cx,
            move |service| match &source {
                DiffSource::Commit(hash) => service
                    .commit_diff(hash, None)
                    .map(|raw| DiffModel::parse(&raw)),
                DiffSource::Worktree(_) => Ok(DiffModel::empty()),
            },
            move |workspace, result, _cx| {
                if workspace.inspector.source == Some(expected) {
                    match result {
                        Ok(model) => workspace.inspector.model = model,
                        Err(error) => {
                            workspace.inspector.model = DiffModel::empty();
                            workspace.set_error(format!("diff: {error}"));
                        }
                    }
                }
            },
        );
    }

    fn load_worktree_diff(&mut self, path: String, cx: &mut Context<Self>) {
        let source = DiffSource::Worktree(path);
        self.changes_selected = source.worktree_path().map(str::to_string);
        self.inspector.source = Some(source.clone());
        self.inspector.visible_file = None;
        let expected = source.clone();
        let expected_path = match &source {
            DiffSource::Worktree(path) => path.clone(),
            DiffSource::Commit(_) => String::new(),
        };
        self.run_git(
            cx,
            move |service| {
                let path = expected_path.clone();
                service.file_diff(&path).map(|raw| DiffModel::parse(&raw))
            },
            move |workspace, result, _cx| {
                if workspace.inspector.source == Some(expected) {
                    match result {
                        Ok(model) => workspace.inspector.model = model,
                        Err(error) => workspace.set_error(format!("diff: {error}")),
                    }
                }
            },
        );
    }

    // -- Azioni utente ----------------------------------------------------

    fn pick_visible_index(&mut self, visible_index: usize, cx: &mut Context<Self>) {
        let Some(row_index) = self.filtered.get(visible_index).copied() else {
            return;
        };
        let Some(row) = self.rows.get(row_index) else {
            return;
        };
        let hash = row.hash.clone();
        if self.selected_hash.as_deref() == Some(hash.as_str()) {
            return;
        }
        self.changes_selected = None;
        self.mode = ViewMode::History;
        self.selected_hash = Some(hash);
        self.load_commit_diff(cx);
        cx.notify();
    }

    fn step_selection(&mut self, delta: isize, cx: &mut Context<Self>) {
        if self.filtered.is_empty() {
            return;
        }
        let current = self
            .selected_hash
            .as_deref()
            .and_then(|hash| {
                self.filtered
                    .iter()
                    .position(|index| self.rows[*index].hash == hash)
            })
            .unwrap_or(0);
        let next = (current as isize + delta).clamp(0, self.filtered.len() as isize - 1) as usize;
        self.pick_visible_index(next, cx);
    }

    fn stage_paths(&mut self, paths: Vec<String>, cx: &mut Context<Self>) {
        if paths.is_empty() {
            return;
        }
        self.pending_discard = false;
        self.run_git(
            cx,
            move |service| service.stage(paths).map(|_| ()),
            move |workspace, result, cx| match result {
                Ok(()) => {
                    workspace.set_message("Staged changes");
                    workspace.refresh(true, cx);
                }
                Err(error) => workspace.set_error(format!("stage: {error}")),
            },
        );
    }

    fn unstage_paths(&mut self, paths: Vec<String>, cx: &mut Context<Self>) {
        if paths.is_empty() {
            return;
        }
        self.run_git(
            cx,
            move |service| service.unstage(paths).map(|_| ()),
            move |workspace, result, cx| match result {
                Ok(()) => {
                    workspace.set_message("Unstaged changes");
                    workspace.refresh(true, cx);
                }
                Err(error) => workspace.set_error(format!("unstage: {error}")),
            },
        );
    }

    fn discard_all(&mut self, cx: &mut Context<Self>) {
        let paths: Vec<String> = self
            .status
            .as_ref()
            .map(|detail| {
                detail
                    .unstaged
                    .iter()
                    .filter(|file| file.worktree_code != '?')
                    .map(|file| file.path.clone())
                    .collect()
            })
            .unwrap_or_default();
        if paths.is_empty() {
            self.set_error("No local changes to discard");
            cx.notify();
            return;
        }
        if !self.pending_discard {
            self.pending_discard = true;
            self.set_message("Click Discard all again to confirm");
            cx.notify();
            return;
        }
        self.pending_discard = false;
        self.run_git(
            cx,
            move |service| service.discard(paths).map(|_| ()),
            move |workspace, result, cx| match result {
                Ok(()) => {
                    workspace.set_message("Discarded working tree changes");
                    workspace.refresh(false, cx);
                }
                Err(error) => workspace.set_error(format!("discard: {error}")),
            },
        );
    }

    fn submit_commit(&mut self, cx: &mut Context<Self>) {
        let staged_count = self
            .status
            .as_ref()
            .map(|detail| detail.staged.len())
            .unwrap_or(0);
        if staged_count == 0 && !self.amend {
            self.set_error("Stage at least one file to commit");
            cx.notify();
            return;
        }
        let summary = self.summary_field.read(cx).value().trim().to_string();
        if summary.is_empty() {
            self.set_error("Commit summary is required");
            cx.notify();
            return;
        }
        let body = self.body_field.read(cx).value().trim().to_string();
        let message = if body.is_empty() {
            summary
        } else {
            format!("{summary}\n\n{body}")
        };
        let options = CommitOptions {
            amend: self.amend,
            signoff: self.signoff,
        };
        self.run_git(
            cx,
            move |service| service.commit(message, options),
            move |workspace, result, cx| match result {
                Ok(output) => {
                    let short: String = output.trim().chars().take(7).collect();
                    workspace.set_message(format!("Committed {short}"));
                    workspace
                        .summary_field
                        .update(cx, |field, cx| field.clear(cx));
                    workspace.body_field.update(cx, |field, cx| field.clear(cx));
                    workspace.amend = false;
                    workspace.signoff = false;
                    workspace.refresh(false, cx);
                }
                Err(error) => workspace.set_error(format!("commit: {error}")),
            },
        );
    }

    fn checkout_branch(&mut self, name: String, cx: &mut Context<Self>) {
        if self
            .branches
            .iter()
            .any(|branch| branch.is_current && branch.name.as_ref() == name.as_str())
        {
            return;
        }
        if self
            .status
            .as_ref()
            .map(|detail| !detail.clean)
            .unwrap_or(false)
        {
            self.set_error("Commit or discard your changes before switching branches");
            cx.notify();
            return;
        }
        self.run_git(
            cx,
            move |service| service.checkout(name.clone()).map(|_| name),
            move |workspace, result, cx| match result {
                Ok(name) => {
                    workspace.set_message(format!("Checked out {name}"));
                    workspace.selected_hash = None;
                    workspace.refresh(false, cx);
                }
                Err(error) => workspace.set_error(format!("checkout: {error}")),
            },
        );
    }

    fn submit_new_branch(&mut self, name: String, cx: &mut Context<Self>) {
        let name = name.trim().to_string();
        if name.is_empty() {
            self.set_error("Branch name is required");
            cx.notify();
            return;
        }
        self.new_branch_open = false;
        let start_point = self
            .status
            .as_ref()
            .map(|detail| detail.branch.clone())
            .filter(|branch| !branch.is_empty());
        self.run_git(
            cx,
            move |service| {
                service.create_branch(name.clone(), start_point)?;
                service.checkout(name.clone()).map(|_| name)
            },
            move |workspace, result, cx| match result {
                Ok(name) => {
                    workspace.set_message(format!("Created and checked out {name}"));
                    workspace.selected_hash = None;
                    workspace.refresh(false, cx);
                }
                Err(error) => workspace.set_error(format!("branch: {error}")),
            },
        );
    }

    fn remote_action(&mut self, action: RemoteAction, cx: &mut Context<Self>) {
        let refresh_after_pull = matches!(action, RemoteAction::Pull);
        self.run_git(
            cx,
            move |service| match action {
                RemoteAction::Fetch => service.fetch().map(|_| "Fetched from remotes"),
                RemoteAction::Pull => service.pull().map(|_| "Pull completed"),
                RemoteAction::Push => service.push().map(|_| "Push completed"),
            },
            move |workspace, result: Result<&'static str, String>, cx| match result {
                Ok(message) => {
                    workspace.set_message(message);
                    if refresh_after_pull {
                        workspace.refresh(false, cx);
                    }
                }
                Err(error) => workspace.set_error(error),
            },
        );
    }
}

impl DiffSource {
    fn worktree_path(&self) -> Option<&str> {
        match self {
            DiffSource::Worktree(path) => Some(path),
            DiffSource::Commit(_) => None,
        }
    }
}

#[derive(Clone, Copy)]
enum RemoteAction {
    Fetch,
    Pull,
    Push,
}

// -- Render --------------------------------------------------------------

impl Workspace {
    fn input_shell(
        &self,
        theme: Theme,
        field: &gpui::Entity<TextField>,
        height: f32,
        leading_icon: Option<&'static str>,
    ) -> gpui::Div {
        div()
            .flex()
            .flex_1()
            .min_w_0()
            .items_center()
            .gap_1p5()
            .h(px(height))
            .px_2p5()
            .rounded_full()
            .bg(theme.surface_input)
            .border_1()
            .border_color(theme.border_subtle)
            .overflow_hidden()
            .children(leading_icon.map(|icon_name| icon(icon_name, 12.0, theme.text_tertiary)))
            .child(field.clone())
    }

    fn sync_badge(
        &self,
        theme: Theme,
        icon_name: &'static str,
        key: &'static str,
        count: usize,
    ) -> Option<gpui::AnyElement> {
        if count == 0 {
            return None;
        }
        let icon_color = theme.text_secondary;
        Some(
            div()
                .relative()
                .child(
                    div()
                        .flex()
                        .items_center()
                        .min_h(px(18.0))
                        .px_1p5()
                        .gap_0p5()
                        .rounded_md()
                        .text_size(px(11.0))
                        .text_color(theme.text_secondary)
                        .bg(theme.surface_secondary)
                        .border_1()
                        .border_color(theme.border_subtle)
                        .child(icon(icon_name, 10.0, icon_color))
                        .child(SharedString::from(count.to_string())),
                )
                .with_animation(
                    (SharedString::from(format!("badge-pop-{key}")), count),
                    Animation::new(motion::BADGE_POP),
                    move |wrapper, delta| {
                        let (offset, opacity) = motion::item_reveal(delta);
                        wrapper.top(px(offset)).opacity(opacity)
                    },
                )
                .into_any_element(),
        )
    }

    fn render_header(&self, theme: Theme, cx: &Context<Self>) -> gpui::Div {
        div()
            .flex()
            .items_center()
            .gap_2()
            .px_3()
            .h(px(38.0))
            .bg(theme.surface_shell)
            .border_b_1()
            .border_color(theme.border_subtle)
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .max_w(px(280.0))
                    .h(px(28.0))
                    .px_3()
                    .rounded_t_md()
                    .bg(theme.surface_primary)
                    .text_size(px(12.0))
                    .font_weight(gpui::FontWeight::MEDIUM)
                    .child(div().truncate().child(self.repo_name.clone())),
            )
            .child(btn_icon("add-tab", theme, ICON_PLUS))
            .child(div().flex_1())
            .child(
                btn_toolbar("theme-toggle", theme, false)
                    .on_click(cx.listener(|this, _: &ClickEvent, _window, cx| {
                        this.theme_choice = match this.theme_choice {
                            ThemeChoice::Dark => ThemeChoice::Light,
                            ThemeChoice::Light => ThemeChoice::Dark,
                        };
                        cx.notify();
                    }))
                    .child(icon(
                        match self.theme_choice {
                            ThemeChoice::Dark => ICON_SUN,
                            ThemeChoice::Light => ICON_MOON,
                        },
                        13.0,
                        theme.text_secondary,
                    ))
                    .child(SharedString::from(match self.theme_choice {
                        ThemeChoice::Dark => "Light",
                        ThemeChoice::Light => "Dark",
                    })),
            )
    }

    fn render_command_bar(&self, theme: Theme, cx: &Context<Self>) -> gpui::Div {
        let busy = self.busy > 0;
        let (ahead, behind) = self
            .status
            .as_ref()
            .map(|detail| (detail.ahead, detail.behind))
            .unwrap_or((0, 0));
        let clean = self
            .status
            .as_ref()
            .map(|detail| detail.clean)
            .unwrap_or(true);

        div()
            .flex()
            .items_center()
            .justify_between()
            .px_4()
            .py_1()
            .min_h(px(46.0))
            .bg(theme.canvas)
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_1p5()
                    .child(
                        btn_toolbar(
                            "toggle-sidebar",
                            theme,
                            self.sidebar_motion.is_active_toggle(),
                        )
                        .on_click(cx.listener(|this, _: &ClickEvent, _window, cx| {
                            this.toggle_panel(PanelSide::Sidebar, cx);
                        }))
                        .child(icon(
                            ICON_BRANCH,
                            13.0,
                            if self.sidebar_motion.is_active_toggle() {
                                theme.text_primary
                            } else {
                                theme.text_secondary
                            },
                        ))
                        .child("Branches"),
                    )
                    .child(
                        btn_toolbar("fetch", theme, false)
                            .when(busy, |button| button.opacity(0.6))
                            .on_click(cx.listener(|this, _: &ClickEvent, _window, cx| {
                                this.remote_action(RemoteAction::Fetch, cx);
                            }))
                            .child(icon(ICON_FETCH, 13.0, theme.text_secondary))
                            .child("Fetch"),
                    )
                    .child(
                        btn_toolbar("pull", theme, false)
                            .font_weight(gpui::FontWeight::SEMIBOLD)
                            .when(busy, |button| button.opacity(0.6))
                            .on_click(cx.listener(|this, _: &ClickEvent, _window, cx| {
                                this.remote_action(RemoteAction::Pull, cx);
                            }))
                            .child(icon(ICON_PULL, 13.0, theme.text_secondary))
                            .child("Pull")
                            .children(self.sync_badge(theme, ICON_PULL, "behind", behind)),
                    )
                    .child(
                        btn_toolbar("push", theme, false)
                            .font_weight(gpui::FontWeight::SEMIBOLD)
                            .when(busy, |button| button.opacity(0.6))
                            .on_click(cx.listener(|this, _: &ClickEvent, _window, cx| {
                                this.remote_action(RemoteAction::Push, cx);
                            }))
                            .child(icon(ICON_PUSH, 13.0, theme.text_secondary))
                            .child("Push")
                            .children(self.sync_badge(theme, ICON_PUSH, "ahead", ahead)),
                    ),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_1p5()
                            .text_size(px(11.0))
                            .text_color(if clean {
                                theme.success_text
                            } else {
                                theme.warning_text
                            })
                            .child(div().w(px(7.0)).h(px(7.0)).rounded_full().bg(if clean {
                                theme.success_text
                            } else {
                                theme.warning_text
                            }))
                            .child(SharedString::from(if clean { "clean" } else { "changed" })),
                    )
                    .child(
                        btn_toolbar(
                            "toggle-inspector",
                            theme,
                            self.inspector_motion.is_active_toggle(),
                        )
                        .on_click(cx.listener(|this, _: &ClickEvent, _window, cx| {
                            this.toggle_panel(PanelSide::Inspector, cx);
                        }))
                        .child(icon(
                            ICON_INSPECTOR,
                            13.0,
                            if self.inspector_motion.is_active_toggle() {
                                theme.text_primary
                            } else {
                                theme.text_secondary
                            },
                        ))
                        .child("Inspector"),
                    ),
            )
    }

    fn render_body(&self, theme: Theme, cx: &mut Context<Self>) -> gpui::Div {
        div()
            .flex()
            .flex_row()
            .flex_1()
            .min_h_0()
            .gap_1()
            .p_1()
            .children(self.render_sidebar(theme, cx))
            .child(self.render_main(theme, cx))
            .children(self.render_inspector_panel(theme, cx))
    }

    /// Colonna del pannello con l'animazione corrente (`motion-panel-*`).
    /// Il wrapper e' `relative`: gli offset `left` non spostano il layout
    /// dei pannelli vicini, come `translate3d` nell'app Electron.
    fn animated_panel_column(
        element: gpui::Div,
        state: PanelState,
        side: PanelSide,
        generation: u64,
    ) -> Option<gpui::AnyElement> {
        if !state.is_visible() {
            return None;
        }
        let column = element.relative();
        let enter_id = SharedString::from(match side {
            PanelSide::Sidebar => "sidebar-enter",
            PanelSide::Inspector => "inspector-enter",
        });
        let exit_id = SharedString::from(match side {
            PanelSide::Sidebar => "sidebar-exit",
            PanelSide::Inspector => "inspector-exit",
        });
        match state {
            PanelState::Open => Some(column.into_any_element()),
            PanelState::Entering { .. } => Some(
                column
                    .with_animation(
                        (enter_id.clone(), generation as usize),
                        Animation::new(motion::PANEL_CHANGE),
                        move |column, delta| {
                            // L'ingresso da destra e' il mirror esatto di quello da sinistra.
                            let slide = match side {
                                PanelSide::Sidebar => motion::panel_slide_enter(delta),
                                PanelSide::Inspector => -motion::panel_slide_enter(delta),
                            };
                            column
                                .opacity((delta / 0.72).clamp(0.0, 1.0))
                                .left(px(slide))
                        },
                    )
                    .into_any_element(),
            ),
            PanelState::Closing { .. } => Some(
                column
                    .with_animation(
                        (exit_id, generation as usize),
                        Animation::new(motion::PANEL_CHANGE),
                        move |column, delta| {
                            let slide = match side {
                                PanelSide::Sidebar => motion::panel_slide_exit_left(delta),
                                PanelSide::Inspector => motion::panel_slide_exit_right(delta),
                            };
                            column.opacity(1.0 - delta).left(px(slide))
                        },
                    )
                    .into_any_element(),
            ),
            PanelState::Closed => None,
        }
    }

    fn render_sidebar(&self, theme: Theme, cx: &mut Context<Self>) -> Option<gpui::AnyElement> {
        let total_visible = self.branches_visible.len();

        let column = div().w(px(SIDEBAR_WIDTH)).min_w_0().h_full().flex_shrink_0().child(
            panel(theme).size_full().child(
                div()
                    .flex()
                    .flex_col()
                    .size_full()
                    .child(
                        div()
                            .flex()
                            .items_start()
                            .justify_between()
                            .px_3()
                            .pt_2()
                            .pb_1()
                            .child(
                                div()
                                    .child(
                                        div()
                                            .text_size(px(10.0))
                                            .text_color(theme.text_tertiary)
                                            .child("WORKSPACE"),
                                    )
                                    .child(
                                        div()
                                            .text_size(px(14.0))
                                            .font_weight(gpui::FontWeight::SEMIBOLD)
                                            .child("Branches"),
                                    ),
                            )
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap_1()
                                    .child(btn_icon("new-branch", theme, ICON_PLUS).on_click(
                                        cx.listener(|this, _: &ClickEvent, window, cx| {
                                            this.new_branch_open = !this.new_branch_open;
                                            if this.new_branch_open {
                                                window.focus(
                                                    &this.new_branch_field.read(cx).handle(),
                                                );
                                            }
                                            cx.notify();
                                        }),
                                    ))
                                    .child(
                                        btn_icon("collapse-sidebar", theme, ICON_CARET_LEFT)
                                            .on_click(cx.listener(
                                                |this, _: &ClickEvent, _window, cx| {
                                                    this.toggle_panel(PanelSide::Sidebar, cx);
                                                },
                                            )),
                                    ),
                            ),
                    )
                    .when(self.new_branch_open, |sidebar| {
                        sidebar.child(
                            div()
                                .px_3()
                                .pb_1()
                                .h(px(32.0))
                                .flex()
                                .child(self.input_shell(theme, &self.new_branch_field, 28.0, None)),
                        )
                    })
                    .child(
                        div()
                            .flex()
                            .px_3()
                            .pb_2()
                            .h(px(36.0))
                            .child(self.input_shell(
                                theme,
                                &self.branch_filter,
                                30.0,
                                Some(ICON_SEARCH),
                            )),
                    )
                    .children(if total_visible == 0 {
                        Some(
                            div()
                                .flex_1()
                                .flex()
                                .items_center()
                                .justify_center()
                                .text_size(px(12.0))
                                .text_color(theme.text_tertiary)
                                .child("No branches")
                                .into_any_element(),
                        )
                    } else {
                        None
                    })
                    .when(total_visible > 0, |sidebar| {
                        sidebar.child(
                            uniform_list(
                                "branch-list",
                                total_visible,
                                cx.processor(move |this, range: Range<usize>, _window, cx| {
                                    range
                                        .filter_map(|position| {
                                            let branch_index =
                                                *this.branches_visible.get(position)?;
                                            Some(this.render_branch_row(
                                                theme,
                                                branch_index,
                                                position,
                                                cx,
                                            ))
                                        })
                                        .collect::<Vec<_>>()
                                }),
                            )
                            .track_scroll(UniformListScrollHandle::new())
                            .flex_1(),
                        )
                    })
                    .child(
                        div()
                            .px_3()
                            .py_2()
                            .border_t_1()
                            .border_color(theme.border_subtle)
                            .child(
                                div()
                                    .text_size(px(10.0))
                                    .text_color(theme.text_tertiary)
                                    .child(SharedString::from(format!(
                                        "TAGS \u{00b7} {}",
                                        self.tags.len()
                                    ))),
                            )
                            .child(
                                div().flex().flex_wrap().gap_1().pt_1().children(
                                    self.tags
                                        .iter()
                                        .take(TAGS_PREVIEW_LIMIT)
                                        .map(|tag| chip(theme, tag.clone()))
                                        .collect::<Vec<_>>(),
                                ),
                            ),
                    ),
            ),
        );
        Self::animated_panel_column(
            column,
            self.sidebar_motion,
            PanelSide::Sidebar,
            self.panel_gen,
        )
    }

    fn render_branch_row(
        &self,
        theme: Theme,
        branch_index: usize,
        position: usize,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let branch = &self.branches[branch_index];
        let is_current = branch.is_current;
        let name = branch.name.clone();
        let label = name.clone();
        div()
            .id(("branch-row", position))
            .flex()
            .items_center()
            .gap_2()
            .px_3()
            .h(px(BRANCH_ROW_HEIGHT))
            .cursor_pointer()
            .when(is_current, |row| row.bg(theme.surface_selected))
            .hover(move |style| style.bg(theme.surface_hover))
            .on_click(cx.listener(move |this, _: &ClickEvent, _window, cx| {
                this.checkout_branch(name.to_string(), cx);
            }))
            .child(
                div()
                    .w(px(10.0))
                    .text_size(px(9.0))
                    .text_color(theme.success_text)
                    .child(if is_current { "\u{25cf}" } else { "" }),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_size(px(12.0))
                    .text_color(if is_current {
                        theme.text_primary
                    } else {
                        theme.text_secondary
                    })
                    .font_weight(if is_current {
                        gpui::FontWeight::SEMIBOLD
                    } else {
                        gpui::FontWeight::NORMAL
                    })
                    .child(label),
            )
            .into_any_element()
    }
}

impl Workspace {
    fn render_main(&self, theme: Theme, cx: &mut Context<Self>) -> gpui::AnyElement {
        let change_count = self.change_count();
        // `.bento-panel` in Electron ha `motion-fade-in` al mount, ma su
        // Wayland il loop dei frame del compositor puo' essere throttled
        // quando la finestra non e' in primo piano (il diagnostico mostra
        // solo 6 render in 8s). Per non tenere il pannello centrale
        // invisibile, il mount resta opaco: le animazioni sono riservate
        // alle interazioni (switch History/Changes, toggle pannelli, toast).
        div()
            .flex_1()
            .min_w_0()
            .h_full()
            .child(
                panel(theme).size_full().child(
                    div()
                        .flex()
                        .flex_col()
                        .size_full()
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .justify_between()
                                .gap_2()
                                .px_4()
                                .h(px(72.0))
                                .border_b_1()
                                .border_color(theme.border_subtle)
                                .child(
                                    div()
                                        .flex()
                                        .items_center()
                                        .gap_3()
                                        .child(
                                            div()
                                                .child(
                                                    div()
                                                        .text_size(px(10.0))
                                                        .text_color(theme.text_tertiary)
                                                        .child("REPOSITORY ACTIVITY"),
                                                )
                                                .child(
                                                    div()
                                                        .text_size(px(14.0))
                                                        .font_weight(gpui::FontWeight::SEMIBOLD)
                                                        .child(SharedString::from(
                                                            match self.mode {
                                                                ViewMode::History => {
                                                                    "Commit history"
                                                                }
                                                                ViewMode::Changes => "Changes",
                                                            },
                                                        )),
                                                ),
                                        )
                                        .when(self.busy > 0, |title| {
                                            title.child(
                                                div()
                                                    .flex()
                                                    .items_center()
                                                    .gap_1p5()
                                                    .text_size(px(11.0))
                                                    .text_color(theme.text_tertiary)
                                                    .child(pulsing_icon(
                                                        ICON_SPINNER,
                                                        12.0,
                                                        theme.text_tertiary,
                                                    ))
                                                    .child("Loading…"),
                                            )
                                        }),
                                )
                                .child(
                                    segmented(theme)
                                        .child(
                                            segmented_item(
                                                "mode-history",
                                                self.mode == ViewMode::History,
                                                theme,
                                            )
                                            .on_click(cx.listener(
                                                |this, _: &ClickEvent, _window, cx| {
                                                    this.mode = ViewMode::History;
                                                    cx.notify();
                                                },
                                            ))
                                            .child("History"),
                                        )
                                        .child(
                                            segmented_item(
                                                "mode-changes",
                                                self.mode == ViewMode::Changes,
                                                theme,
                                            )
                                            .on_click(cx.listener(
                                                |this, _: &ClickEvent, _window, cx| {
                                                    this.mode = ViewMode::Changes;
                                                    cx.notify();
                                                },
                                            ))
                                            .child("Changes")
                                            .child(
                                                revealed_badge(
                                                    theme,
                                                    format!("{change_count}"),
                                                    ("changes-count", change_count),
                                                ),
                                            ),
                                        ),
                                ),
                        )
                        // Il contenuto History/Changes e' sempre opaco
                        // al mount: il content-in animato e' solo per lo
                        // switch user-initiated (click sul segmented).
                        .child(if self.mode == ViewMode::History {
                            self.render_history(theme, cx).into_any_element()
                        } else {
                            self.render_changes(theme, cx).into_any_element()
                        }),
                ),
            )
            .into_any_element()
    }

    /// Larghezza colonna grafo come `updateGraphWidth`:
    /// `clamp(lane_count * 18 + 20, 84..=240)`.
    fn graph_col_width(&self) -> f32 {
        (self.graph_lane_count as f32 * LANE_PITCH + 20.0).clamp(GRAPH_COL_WIDTH, 240.0)
    }

    fn change_count(&self) -> usize {
        self.status
            .as_ref()
            .map(|detail| detail.staged.len() + detail.unstaged.len())
            .unwrap_or(0)
    }

    fn render_history(&self, theme: Theme, cx: &mut Context<Self>) -> gpui::Div {
        if self.rows.is_empty() {
            return div()
                .flex_1()
                .flex()
                .flex_col()
                .items_center()
                .justify_center()
                .gap_2()
                .text_color(theme.text_tertiary)
                .child(pulsing_icon(
                    if self.busy > 0 {
                        ICON_SPINNER
                    } else {
                        ICON_COMMIT
                    },
                    24.0,
                    theme.border_strong,
                ))
                .child(if self.busy > 0 {
                    "Loading history…"
                } else {
                    "No commits in this repository"
                });
        }
        let filtering = !self.history_query.is_empty();
        div()
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            // Riga controlli cronologia (`.history-controls`): ricerca con
            // magnifier, clear animato e conteggio risultati in filtro.
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .px_3()
                    .py_2()
                    .border_b_1()
                    .border_color(theme.border_subtle)
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .flex_1()
                            .max_w(px(520.0))
                            .h(px(34.0))
                            .px_3()
                            .gap_2()
                            .rounded_full()
                            .bg(theme.surface_secondary)
                            .border_1()
                            .border_color(if filtering {
                                theme.primary
                            } else {
                                theme.border_subtle
                            })
                            .child(icon(ICON_SEARCH, 13.0, theme.text_tertiary))
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .h_full()
                                    .overflow_hidden()
                                    .child(self.history_filter.clone()),
                            )
                            .when(filtering, |search| {
                                search
                                    .child(
                                        btn_icon_sm("clear-history-search", theme, ICON_CLOSE)
                                            .on_click(cx.listener(
                                                |this, _: &ClickEvent, window, cx| {
                                                    this.history_filter
                                                        .update(cx, |field, cx| field.clear(cx));
                                                    let handle =
                                                        this.history_filter.read(cx).handle();
                                                    window.focus(&handle);
                                                },
                                            )),
                                    )
                                    .child(revealed_badge(
                                        theme,
                                        format!("{} / {}", self.filtered.len(), self.rows.len()),
                                        ("history-results", self.filtered.len()),
                                    ))
                            }),
                    ),
            )
            .child(self.render_graph_header(theme))
            .child(
                uniform_list(
                    "commit-list",
                    self.filtered.len(),
                    cx.processor(move |this, visible: Range<usize>, _window, cx| {
                        visible
                            .map(|position| this.render_commit_row(theme, position, cx))
                            .collect::<Vec<_>>()
                    }),
                )
                .track_scroll(self.list_scroll.clone())
                .flex_1(),
            )
    }

    fn render_graph_header(&self, theme: Theme) -> gpui::Div {
        // `.graph-header`: 36px, label uppercase 9.5px semibold, date/hash
        // allineati a destra come le colonne.
        let header_label = |text: &'static str| {
            div()
                .text_size(px(9.5))
                .font_weight(gpui::FontWeight::SEMIBOLD)
                .child(text)
        };
        div()
            .flex()
            .items_center()
            .min_h(px(36.0))
            .px_2()
            .border_b_1()
            .bg(theme.surface_secondary)
            .border_color(theme.border_subtle)
            .text_color(theme.text_tertiary)
            .child(
                div()
                    .w(px(self.graph_col_width()))
                    .px_2()
                    .child(header_label("GRAPH")),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .px_2()
                    .child(header_label("MESSAGE")),
            )
            .child(
                div()
                    .w(px(AUTHOR_COL_WIDTH))
                    .px_2()
                    .child(header_label("AUTHOR")),
            )
            .child(
                div()
                    .w(px(DATE_COL_WIDTH))
                    .px_2()
                    .flex()
                    .justify_end()
                    .child(header_label("DATE")),
            )
            .child(
                div()
                    .w(px(HASH_COL_WIDTH))
                    .px_2()
                    .flex()
                    .justify_end()
                    .child(header_label("HASH")),
            )
    }

    fn render_commit_row(
        &self,
        theme: Theme,
        position: usize,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let Some(row_index) = self.filtered.get(position).copied() else {
            return div().h(px(COMMIT_ROW_HEIGHT)).into_any_element();
        };
        let Some(row) = self.rows.get(row_index) else {
            return div().h(px(COMMIT_ROW_HEIGHT)).into_any_element();
        };
        let graph_row = self.graph_rows.get(row_index);
        let is_selected = self.selected_hash.as_deref() == Some(row.hash.as_str());

        let chips = row
            .chips
            .iter()
            .take(3)
            .map(|reference| {
                let themed_chip = chip(theme, reference.label.clone());
                match reference.kind {
                    RefChipKind::Tag => themed_chip.text_color(theme.warning_text),
                    RefChipKind::Remote => themed_chip.text_color(theme.text_secondary),
                    RefChipKind::Branch => themed_chip,
                }
                .into_any_element()
            })
            .collect::<Vec<_>>();

        div()
            .id(("commit-row", position))
            .flex()
            .items_center()
            .px_2()
            .h(px(COMMIT_ROW_HEIGHT))
            .w_full()
            .border_b_1()
            .border_color(theme.border_subtle)
            .cursor_pointer()
            .when(is_selected, |row| row.bg(theme.primary_soft))
            .hover(move |style| style.bg(theme.surface_hover))
            .on_click(cx.listener(move |this, _: &ClickEvent, _window, cx| {
                this.pick_visible_index(position, cx);
            }))
            .child(
                div()
                    .w(px(self.graph_col_width()))
                    .relative()
                    .h(px(COMMIT_ROW_HEIGHT))
                    .children(
                        graph_row
                            .map(|graph_row| self.render_graph_cell(theme, graph_row, row.is_head))
                            .unwrap_or_default(),
                    ),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .items_center()
                    .gap_2()
                    .px_2()
                    .overflow_hidden()
                    .child(div().flex().items_center().min_w_0().children(chips))
                    .child(
                        div()
                            .min_w_0()
                            .truncate()
                            .text_size(px(12.0))
                            .font_weight(gpui::FontWeight::SEMIBOLD)
                            .text_color(theme.text_primary)
                            .child(row.subject.clone()),
                    ),
            )
            .child(
                div()
                    .w(px(AUTHOR_COL_WIDTH))
                    .px_2()
                    .truncate()
                    .text_size(px(11.0))
                    .text_color(theme.text_secondary)
                    .child(row.author.clone()),
            )
            .child(
                div()
                    .w(px(DATE_COL_WIDTH))
                    .px_2()
                    .truncate()
                    .text_size(px(10.0))
                    .text_right()
                    .text_color(theme.text_tertiary)
                    .child(row.date_rel.clone()),
            )
            .child(
                div()
                    .w(px(HASH_COL_WIDTH))
                    .px_2()
                    .font_family(crate::theme::MONO)
                    .text_size(px(10.0))
                    .text_right()
                    .text_color(theme.text_tertiary)
                    .child(row.hash_short.clone()),
            )
            .into_any_element()
    }

    /// Cella grafo di una riga: binari verticali, curve verso i parent
    /// (stessa geometria SVG di `createGraphSegments`), nodo colorato e
    /// anello HEAD. I binari e i nodi sono div assoluti; le curve bezier
    /// vengono tracciate con `PathBuilder::stroke`.
    fn render_graph_cell(
        &self,
        theme: Theme,
        row: &GraphRow,
        is_head: bool,
    ) -> Vec<gpui::AnyElement> {
        let height = COMMIT_ROW_HEIGHT;
        let midpoint = height / 2.0;
        let lane_x = |lane: usize| LANE_X0 + lane as f32 * LANE_PITCH;
        let lane_color = |lane: usize| theme.lane_colors[lane % theme.lane_colors.len()];

        let mut elements: Vec<gpui::AnyElement> = Vec::new();

        for (lane, occupied) in row.rails.iter().enumerate() {
            if !*occupied {
                continue;
            }
            elements.push(
                div()
                    .absolute()
                    .left(px(lane_x(lane) - GRAPH_STROKE / 2.0))
                    .top(px(-1.0))
                    .size_full()
                    .h(px(height + 2.0))
                    .w(px(GRAPH_STROKE))
                    .bg(lane_color(lane))
                    .into_any_element(),
            );
        }
        if row.incoming {
            elements.push(
                div()
                    .absolute()
                    .left(px(lane_x(row.lane) - GRAPH_STROKE / 2.0))
                    .top(px(-1.0))
                    .w(px(GRAPH_STROKE))
                    .h(px(midpoint + 1.0))
                    .bg(lane_color(row.lane))
                    .into_any_element(),
            );
        }

        // Curve verso i parent: cubic bezier come nell'SVG (`C from mid+10,
        // to bottom-10, to bottom`), tracciate a 1.65px.
        let curves: Vec<(f32, f32, gpui::Rgba)> = row
            .parents
            .iter()
            .map(|parent| {
                (
                    lane_x(row.lane),
                    lane_x(parent.lane),
                    lane_color(parent.lane),
                )
            })
            .collect();
        if !curves.is_empty() {
            elements.push(
                canvas(
                    move |bounds, _, _| bounds.origin,
                    move |bounds, origin, window, _| {
                        for (from_x, to_x, color) in curves.iter() {
                            let mut path = gpui::PathBuilder::stroke(px(GRAPH_STROKE));
                            path.move_to(origin + point(px(*from_x), px(midpoint)));
                            if (from_x - to_x).abs() < 0.01 {
                                path.line_to(origin + point(px(*to_x), px(height + 1.0)));
                            } else {
                                path.cubic_bezier_to(
                                    origin + point(px(*to_x), px(height + 1.0)),
                                    origin + point(px(*from_x), px(midpoint + 10.0)),
                                    origin + point(px(*to_x), px(height - 9.0)),
                                );
                            }
                            if let Ok(path) = path.build() {
                                window.paint_path(path, *color);
                            }
                        }
                        let _ = bounds;
                    },
                )
                .absolute()
                .inset_0()
                .into_any_element(),
            );
        }

        // Nodo del commit: cerchio pieno con anello surface-primary; i merge
        // sono piu' grandi con anello piu' spesso (`.graph-lane-node.is-merge`).
        let is_merge = row.parents.len() > 1;
        let node_radius = if is_merge {
            MERGE_NODE_RADIUS
        } else {
            NODE_RADIUS
        };
        let node_ring = if is_merge { 2.5 } else { 1.5 };
        let node_size = node_radius * 2.0 + node_ring;
        elements.push(
            div()
                .absolute()
                .left(px(lane_x(row.lane) - node_size / 2.0))
                .top(px(midpoint - node_size / 2.0))
                .size(px(node_size))
                .rounded_full()
                .bg(lane_color(row.lane))
                .border_1()
                .border(px(node_ring))
                .border_color(theme.surface_primary)
                .into_any_element(),
        );
        // Indicatore HEAD: anello vuoto `--graph-head` (r=8, stroke 2).
        if is_head {
            let ring_size = HEAD_RING_RADIUS * 2.0 + 2.0;
            elements.push(
                div()
                    .absolute()
                    .left(px(lane_x(row.lane) - ring_size / 2.0))
                    .top(px(midpoint - ring_size / 2.0))
                    .size(px(ring_size))
                    .rounded_full()
                    .border_1()
                    .border(px(2.0))
                    .border_color(theme.graph_head)
                    .into_any_element(),
            );
        }
        elements
    }
}

impl Workspace {
    fn status_letter_color(&self, theme: Theme, code: char) -> gpui::Rgba {
        match code {
            'A' => theme.success_text,
            'D' => theme.error_text,
            'M' | 'R' | 'C' => theme.warning_text,
            'U' => theme.error_text,
            '?' => theme.text_tertiary,
            _ => theme.text_secondary,
        }
    }

    fn render_changes(&self, theme: Theme, cx: &mut Context<Self>) -> gpui::Div {
        let empty = self
            .status
            .as_ref()
            .map(|detail| detail.staged.is_empty() && detail.unstaged.is_empty())
            .unwrap_or(true);

        if empty {
            return div()
                .flex_1()
                .flex()
                .flex_col()
                .items_center()
                .justify_center()
                .gap_2()
                .text_color(theme.text_tertiary)
                .child(pulsing_icon(ICON_SPINNER, 24.0, theme.border_strong))
                .child(if self.busy > 0 {
                    "Checking working tree…"
                } else {
                    "Working tree clean"
                });
        }

        div()
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .p_2()
            .gap_2()
            .child(
                div()
                    .flex()
                    .gap_2()
                    .flex_1()
                    .min_h_0()
                    .child(self.render_file_section(theme, true, cx))
                    .child(self.render_file_section(theme, false, cx)),
            )
            .child(self.render_composer(theme, cx))
    }

    fn render_file_section(
        &self,
        theme: Theme,
        unstaged: bool,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let files: Vec<(char, String)> = self
            .status
            .as_ref()
            .map(|detail| {
                if unstaged {
                    detail
                        .unstaged
                        .iter()
                        .map(|file| (file.worktree_code, file.path.clone()))
                        .collect()
                } else {
                    detail
                        .staged
                        .iter()
                        .map(|file| (file.index_code, file.path.clone()))
                        .collect()
                }
            })
            .unwrap_or_default();

        let title = if unstaged { "Unstaged" } else { "Staged" };
        let section_id = if unstaged {
            "unstaged-files"
        } else {
            "staged-files"
        };

        card(theme)
            .flex_1()
            .min_w_0()
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .px_3()
                    .py_1p5()
                    .border_b_1()
                    .border_color(theme.border_subtle)
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_2()
                            .child(
                                div()
                                    .text_size(px(13.0))
                                    .font_weight(gpui::FontWeight::SEMIBOLD)
                                    .child(title),
                            )
                            .child(revealed_badge(
                                theme,
                                format!("{}", files.len()),
                                (section_id, files.len()),
                            )),
                    )
                    .children(if unstaged {
                        Some(
                            div()
                                .flex()
                                .gap_1()
                                .child(
                                    btn_toolbar("discard-all", theme, false)
                                        .when(files.is_empty(), |button| button.opacity(0.5))
                                        .on_click(cx.listener(
                                            |this, _: &ClickEvent, _window, cx| {
                                                this.discard_all(cx);
                                            },
                                        ))
                                        .text_color(theme.error_text)
                                        .child("Discard all"),
                                )
                                .child(
                                    btn_toolbar("stage-all", theme, false)
                                        .when(files.is_empty(), |button| button.opacity(0.5))
                                        .on_click(cx.listener(
                                            |this, _: &ClickEvent, _window, cx| {
                                                let paths = this
                                                    .status
                                                    .as_ref()
                                                    .map(|detail| {
                                                        detail
                                                            .unstaged
                                                            .iter()
                                                            .map(|file| file.path.clone())
                                                            .collect()
                                                    })
                                                    .unwrap_or_default();
                                                this.stage_paths(paths, cx);
                                            },
                                        ))
                                        .child(icon(ICON_PLUS, 12.0, theme.text_secondary))
                                        .child("Stage all"),
                                )
                                .into_any_element(),
                        )
                    } else {
                        Some(
                            btn_toolbar("unstage-all", theme, false)
                                .when(files.is_empty(), |button| button.opacity(0.5))
                                .on_click(cx.listener(|this, _: &ClickEvent, _window, cx| {
                                    let paths = this
                                        .status
                                        .as_ref()
                                        .map(|detail| {
                                            detail.staged.iter().map(|f| f.path.clone()).collect()
                                        })
                                        .unwrap_or_default();
                                    this.unstage_paths(paths, cx);
                                }))
                                .child(icon(ICON_MINUS, 12.0, theme.text_secondary))
                                .child("Unstage all")
                                .into_any_element(),
                        )
                    }),
            )
            .children(if files.is_empty() {
                Some(
                    div()
                        .flex_1()
                        .flex()
                        .items_center()
                        .justify_center()
                        .text_size(px(12.0))
                        .text_color(theme.text_tertiary)
                        .child(if unstaged {
                            "No unstaged files"
                        } else {
                            "Nothing staged"
                        })
                        .into_any_element(),
                )
            } else {
                Some(
                    uniform_list(section_id, files.len(), {
                        let files = files.clone();
                        cx.processor(move |this, range: Range<usize>, _window, cx| {
                            range
                                .filter_map(|position| {
                                    let (code, path) = files.get(position)?;
                                    Some(this.render_file_row(unstaged, position, *code, path, cx))
                                })
                                .collect::<Vec<_>>()
                        })
                    })
                    .track_scroll(UniformListScrollHandle::new())
                    .flex_1()
                    .into_any_element(),
                )
            })
    }

    fn render_file_row(
        &self,
        unstaged: bool,
        position: usize,
        code: char,
        path: &str,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let theme = self.palette;
        let selected = self.changes_selected.as_deref() == Some(path);
        let click_path = path.to_string();
        let stage_path = path.to_string();
        div()
            .id(("file-row", position))
            .flex()
            .items_center()
            .gap_2()
            .px_3()
            .h(px(28.0))
            .cursor_pointer()
            .when(selected, |row| row.bg(theme.surface_selected))
            .hover(move |style| style.bg(theme.surface_hover))
            .on_click(cx.listener(move |this, _: &ClickEvent, _window, cx| {
                if unstaged {
                    this.load_worktree_diff(click_path.clone(), cx);
                } else {
                    cx.notify();
                }
            }))
            .child(
                div()
                    .w(px(14.0))
                    .font_family(crate::theme::MONO)
                    .text_size(px(11.0))
                    .text_color(self.status_letter_color(theme, code))
                    .child(code.to_string()),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_size(px(12.0))
                    .text_color(theme.text_primary)
                    .child(SharedString::from(path.to_string())),
            )
            .child(if unstaged {
                btn_icon_sm(("stage-file", position), theme, ICON_PLUS)
                    .on_click(cx.listener(move |this, _: &ClickEvent, _window, cx| {
                        this.stage_paths(vec![stage_path.clone()], cx);
                    }))
                    .into_any_element()
            } else {
                btn_icon_sm(("unstage-file", position), theme, ICON_MINUS)
                    .on_click(cx.listener(move |this, _: &ClickEvent, _window, cx| {
                        this.unstage_paths(vec![stage_path.clone()], cx);
                    }))
                    .into_any_element()
            })
            .into_any_element()
    }

    fn render_composer(&self, theme: Theme, cx: &mut Context<Self>) -> gpui::Div {
        let staged_count = self
            .status
            .as_ref()
            .map(|detail| detail.staged.len())
            .unwrap_or(0);
        let can_commit = staged_count > 0 || self.amend;

        div()
            .border_t_1()
            .border_color(theme.border_subtle)
            .px_3()
            .py_2()
            .gap_1p5()
            .flex()
            .flex_col()
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .child(
                        div()
                            .text_size(px(13.0))
                            .font_weight(gpui::FontWeight::SEMIBOLD)
                            .child("Commit staged changes"),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_2()
                            .text_size(px(11.0))
                            .child(
                                ui::btn_toolbar("amend", theme, self.amend)
                                    .on_click(cx.listener(|this, _: &ClickEvent, _window, cx| {
                                        this.amend = !this.amend;
                                        cx.notify();
                                    }))
                                    .child("Amend HEAD"),
                            )
                            .child(
                                ui::btn_toolbar("signoff", theme, self.signoff)
                                    .on_click(cx.listener(|this, _: &ClickEvent, _window, cx| {
                                        this.signoff = !this.signoff;
                                        cx.notify();
                                    }))
                                    .child("Sign-off"),
                            ),
                    ),
            )
            .child(div().flex().h(px(32.0)).child(self.input_shell(
                theme,
                &self.summary_field,
                30.0,
                None,
            )))
            .child(
                div().h(px(64.0)).child(
                    div()
                        .size_full()
                        .p_1()
                        .rounded_lg()
                        .bg(theme.surface_input)
                        .border_1()
                        .border_color(theme.border_subtle)
                        .overflow_hidden()
                        .child(self.body_field.clone()),
                ),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .child(
                        div()
                            .text_size(px(11.0))
                            .text_color(theme.text_tertiary)
                            .child(SharedString::from(format!("{staged_count} file(s) staged"))),
                    )
                    .child(
                        btn_primary("commit", theme)
                            .when(!can_commit && !self.summary_filled(), |button| {
                                button.opacity(0.5)
                            })
                            .on_click(cx.listener(|this, _: &ClickEvent, _window, cx| {
                                this.submit_commit(cx);
                            }))
                            .child("Commit"),
                    ),
            )
    }

    fn summary_filled(&self) -> bool {
        self.summary_non_empty
    }
}

impl Workspace {
    fn render_inspector_panel(
        &self,
        theme: Theme,
        cx: &mut Context<Self>,
    ) -> Option<gpui::AnyElement> {
        let model = &self.inspector.model;
        let meta = match &self.inspector.source {
            Some(DiffSource::Commit(hash)) => self
                .rows
                .iter()
                .find(|row| &row.hash == hash)
                .map(|row| format!("{}  {}  {}", row.hash_short, row.author, row.date_rel)),
            Some(DiffSource::Worktree(path)) => Some(format!("worktree \u{00b7} {path}")),
            None => None,
        };
        let title = match self.inspector.source {
            Some(DiffSource::Commit(_)) => "Commit details",
            Some(DiffSource::Worktree(_)) => "Working tree diff",
            None => "Commit details",
        };

        let column = div().w(px(INSPECTOR_WIDTH)).h_full().flex_shrink_0().child(
            panel(theme).size_full().child(
                div()
                    .flex()
                    .flex_col()
                    .size_full()
                    .child(
                        div()
                            .flex()
                            .items_start()
                            .justify_between()
                            .gap_2()
                            .px_3()
                            .pt_2()
                            .pb_1()
                            .child(
                                div()
                                    .min_w_0()
                                    .flex_1()
                                    .child(
                                        div()
                                            .text_size(px(10.0))
                                            .text_color(theme.text_tertiary)
                                            .child("INSPECTOR"),
                                    )
                                    .child(
                                        div()
                                            .text_size(px(14.0))
                                            .font_weight(gpui::FontWeight::SEMIBOLD)
                                            .child(title),
                                    )
                                    .children(meta.map(|meta| {
                                        div()
                                            .mt_0p5()
                                            .font_family(crate::theme::MONO)
                                            .text_size(px(11.0))
                                            .text_color(theme.text_secondary)
                                            .truncate()
                                            .child(meta)
                                    })),
                            )
                            .child(btn_icon("close-inspector", theme, ICON_CLOSE).on_click(
                                cx.listener(|this, _: &ClickEvent, _window, cx| {
                                    this.toggle_panel(PanelSide::Inspector, cx);
                                }),
                            )),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_2()
                            .px_3()
                            .pb_2()
                            .text_size(px(11.0))
                            .child(revealed_badge(
                                theme,
                                format!("+{} \u{2212}{}", model.added, model.deleted),
                                (
                                    SharedString::from(format!(
                                        "inspector-delta-{}-{}",
                                        model.added, model.deleted
                                    )),
                                    model.added + model.deleted,
                                ),
                            ))
                            .child(revealed_badge(
                                theme,
                                format!("{} files", model.files.len()),
                                ("inspector-files", model.files.len()),
                            )),
                    )
                    .child(if model.lines.is_empty() {
                        div()
                            .flex_1()
                            .flex()
                            .flex_col()
                            .items_center()
                            .justify_center()
                            .gap_2()
                            .p_4()
                            .text_size(px(12.0))
                            .text_color(theme.text_tertiary)
                            .child(pulsing_icon(ICON_BRANCH, 24.0, theme.border_strong))
                            .child("Select a commit to inspect its changes.")
                            .into_any_element()
                    } else {
                        div()
                            .flex()
                            .flex_1()
                            .min_h_0()
                            .child(self.render_diff_pane(theme, cx))
                            .child(self.render_files_rail(theme, cx))
                            .into_any_element()
                    }),
            ),
        );
        Self::animated_panel_column(
            column,
            self.inspector_motion,
            PanelSide::Inspector,
            self.panel_gen,
        )
    }

    fn render_diff_pane(&self, theme: Theme, cx: &mut Context<Self>) -> gpui::AnyElement {
        let model = &self.inspector.model;
        let visible_range = model.visible_range(self.inspector.visible_file);
        let start = visible_range.start;
        let count = visible_range.end.saturating_sub(visible_range.start);

        div()
            .flex_1()
            .min_w_0()
            .border_r_1()
            .border_color(theme.border_subtle)
            .child(
                uniform_list(
                    "diff-lines",
                    count.max(1),
                    cx.processor(move |this, range: Range<usize>, _window, _cx| {
                        range
                            .map(|offset| this.render_diff_line(start + offset))
                            .collect::<Vec<_>>()
                    }),
                )
                .track_scroll(self.inspector.scroll.clone())
                .size_full(),
            )
            .into_any_element()
    }

    fn render_diff_line(&self, index: usize) -> gpui::AnyElement {
        use crate::models::LineKind as DiffLineKind;
        let theme = self.palette;
        let Some(line) = self.inspector.model.lines.get(index) else {
            return div().h(px(DIFF_ROW_HEIGHT)).into_any_element();
        };
        let (fg, bg) = match line.kind {
            DiffLineKind::Add => (theme.diff_add_text, theme.diff_add_bg),
            DiffLineKind::Del => (theme.diff_del_text, theme.diff_del_bg),
            DiffLineKind::Hunk => (theme.diff_hunk_text, theme.diff_hunk_bg),
            DiffLineKind::Context => (theme.text_secondary, theme.surface_primary),
        };
        div()
            .h(px(DIFF_ROW_HEIGHT))
            .w_full()
            .flex()
            .items_center()
            .font_family(crate::theme::MONO)
            .text_size(px(12.0))
            .text_color(fg)
            .bg(bg)
            .px_2()
            .whitespace_nowrap()
            .overflow_hidden()
            .child(line.text.clone())
            .into_any_element()
    }

    fn render_files_rail(&self, theme: Theme, cx: &mut Context<Self>) -> gpui::Div {
        div()
            .w(px(FILE_RAIL_WIDTH))
            .flex()
            .flex_col()
            .min_h_0()
            .child(
                div()
                    .px_3()
                    .py_1p5()
                    .text_size(px(10.0))
                    .text_color(theme.text_tertiary)
                    .child("CHANGED FILES"),
            )
            .child(
                div()
                    .id("files-rail")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .children(
                        self.inspector
                            .model
                            .files
                            .iter()
                            .enumerate()
                            .take(MAX_FILE_RAIL_ENTRIES)
                            .map(|(index, section)| {
                                let selected = self.inspector.visible_file == Some(index);
                                div()
                                    .id(("inspector-file", index))
                                    .px_3()
                                    .py_1()
                                    .cursor_pointer()
                                    .when(selected, |row| row.bg(theme.surface_selected))
                                    .hover(move |style| style.bg(theme.surface_hover))
                                    .on_click(cx.listener(
                                        move |this, _: &ClickEvent, _window, cx| {
                                            this.inspector.visible_file =
                                                if selected { None } else { Some(index) };
                                            cx.notify();
                                        },
                                    ))
                                    .child(
                                        div()
                                            .truncate()
                                            .text_size(px(11.0))
                                            .font_family(crate::theme::MONO)
                                            .text_color(theme.text_secondary)
                                            .child(section.path.clone()),
                                    )
                            })
                            .collect::<Vec<_>>(),
                    ),
            )
    }

    fn render_status_bar(&self, theme: Theme) -> gpui::Div {
        let (branch, ahead, behind, detached) = self
            .status
            .as_ref()
            .map(|detail| {
                (
                    detail.branch.clone(),
                    detail.ahead,
                    detail.behind,
                    detail.detached,
                )
            })
            .unwrap_or_default();
        let mut info = self.message.clone();
        if ahead > 0 || behind > 0 {
            info = SharedString::from(format!("{info}   \u{2191}{ahead} \u{2193}{behind}"));
        }
        let branch_label = if detached {
            SharedString::from("detached HEAD")
        } else {
            SharedString::from(branch)
        };

        let busy = self.busy > 0;
        div()
            .flex()
            .items_center()
            .gap_2()
            .px_3()
            .h(px(28.0))
            .bg(theme.surface_shell)
            .border_t_1()
            .border_color(theme.border_subtle)
            .text_size(px(11.0))
            .text_color(theme.text_secondary)
            .child(if busy {
                pulsing_dot(self.status_dot_color())
            } else {
                div()
                    .w(px(8.0))
                    .h(px(8.0))
                    .rounded_full()
                    .bg(self.status_dot_color())
                    .into_any_element()
            })
            .child(self.repo_name.clone())
            .when(!branch_label.is_empty(), |bar| bar.child(branch_label))
            .child(div().flex_1())
            .children(self.error.clone().map(|error| {
                div()
                    .max_w(px(520.0))
                    .truncate()
                    .text_color(theme.error_text)
                    .child(error)
                    .into_any_element()
            }))
            // Esito operazioni come toast compatto: `motion-fade-in-up`.
            .child(div().relative().truncate().child(info).with_animation(
                ("status-toast", self.message_seq),
                Animation::new(motion::CONTENT_ENTER),
                |toast, delta| {
                    let (offset, opacity) = motion::fade_in_up(delta);
                    toast
                        .top(px(offset.min(12.0)))
                        .opacity(opacity.clamp(0.0, 1.0))
                },
            ))
            .child(
                div()
                    .text_color(theme.text_tertiary)
                    .child("Rust \u{00b7} GPUI"),
            )
    }

    fn status_dot_color(&self) -> gpui::Rgba {
        let theme = self.palette;
        if self.error.is_some() {
            theme.error_text
        } else if self.status.as_ref().map(|s| s.clean).unwrap_or(false) {
            theme.success_text
        } else {
            theme.warning_text
        }
    }
}

/// Dot di stato con respiro `motion-pulse-soft` mentre girano operazioni.
fn pulsing_dot(color: gpui::Rgba) -> gpui::AnyElement {
    div()
        .with_animation(
            "status-dot-busy",
            Animation::new(motion::PULSE_SOFT)
                .repeat()
                .with_easing(breathing(0.45, 1.0)),
            move |dot, alpha| {
                dot.w(px(8.0))
                    .h(px(8.0))
                    .rounded_full()
                    .bg(color)
                    .opacity(alpha)
            },
        )
        .into_any_element()
}

const MAX_FILE_RAIL_ENTRIES: usize = 200;

/// Badge contatore con la comparsa `motion-item-reveal` quando il valore
/// cambia: l'id include il conteggio, quindi ogni nuovo valore riparte.
fn revealed_badge(
    theme: Theme,
    text: impl Into<SharedString>,
    key: impl Into<gpui::ElementId>,
) -> gpui::AnyElement {
    div()
        .relative()
        .child(badge(theme, text))
        .with_animation(
            key.into(),
            Animation::new(motion::BADGE_POP),
            move |wrapper, delta| {
                let (offset, opacity) = motion::item_reveal(delta);
                wrapper.top(px(offset)).opacity(opacity)
            },
        )
        .into_any_element()
}

impl Render for Workspace {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.palette;
        div()
            .id("workspace-root")
            .flex()
            .flex_col()
            .size_full()
            .bg(crate::theme::canvas_gradient(self.theme_choice))
            .font_family(crate::theme::SANS)
            .text_color(theme.text_primary)
            .text_size(px(13.0))
            .on_action(cx.listener(|this, _: &Refresh, _window, cx| {
                this.refresh(false, cx);
            }))
            .on_action(cx.listener(|this, _: &NextCommit, _window, cx| {
                this.step_selection(1, cx);
            }))
            .on_action(cx.listener(|this, _: &PrevCommit, _window, cx| {
                this.step_selection(-1, cx);
            }))
            .on_action(cx.listener(|this, _: &FocusSearch, window, cx| {
                let handle = this.history_filter.read(cx).handle();
                window.focus(&handle);
            }))
            .child(self.render_header(theme, cx))
            .child(self.render_command_bar(theme, cx))
            .child(self.render_body(theme, cx))
            .child(self.render_status_bar(theme))
    }
}

fn main() {
    let repo_path = std::env::args().nth(1).unwrap_or_else(|| ".".to_string());
    Application::new()
        .with_assets(icons::EmbeddedIcons)
        .run(move |app: &mut App| {
            app.bind_keys([
                KeyBinding::new("down", NextCommit, None),
                KeyBinding::new("up", PrevCommit, None),
                KeyBinding::new("f5", Refresh, None),
                KeyBinding::new("ctrl-p", FocusSearch, None),
            ]);
            widgets::text_field::bind_keys(app);

            let bounds = Bounds::centered(None, size(px(1280.), px(800.)), app);
            let result = app.open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(bounds)),
                    ..Default::default()
                },
                move |_, cx| {
                    let workspace = cx.new(|cx| Workspace::new(repo_path.as_str(), cx));
                    let weak = workspace.downgrade();
                    workspace.update(cx, move |workspace, cx| {
                        let weak_summary = weak.clone();
                        workspace.summary_field.update(cx, move |field, _| {
                            field.set_on_submit(move |_value, _window, cx| {
                                if let Some(entity) = weak_summary.upgrade() {
                                    entity.update(cx, |workspace, cx| workspace.submit_commit(cx));
                                }
                            });
                        });
                        let weak_branch = weak;
                        workspace.new_branch_field.update(cx, move |field, _| {
                            field.set_on_submit(move |value, _window, cx| {
                                if let Some(entity) = weak_branch.upgrade() {
                                    let value = value.to_string();
                                    entity.update(cx, |workspace, cx| {
                                        workspace.submit_new_branch(value, cx)
                                    });
                                }
                            });
                        });
                    });
                    workspace
                },
            );
            if let Err(error) = result {
                eprintln!("impossibile aprire la finestra: {error}");
                std::process::exit(1);
            }
            app.activate(true);
        });
}
