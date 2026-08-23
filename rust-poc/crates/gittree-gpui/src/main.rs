//! Finestra GPUI del POC con il tema dark di GitTree (token reali di
//! `src/renderer/styles/variables.css`) e lista commit virtualizzata.
//!
//! Uso: gittree-gpui [percorso-repo]   (default: la directory corrente)

use std::ops::Range;

use gpui::{
    actions, div, px, rgb, size, uniform_list, App, Application, Bounds, ClickEvent, Context,
    KeyBinding, SharedString, UniformListScrollHandle, Window, WindowBounds, WindowOptions,
};
use gpui::prelude::*;
use gpui::{FontWeight, StatefulInteractiveElement, Styled};
use gittree_core::git::engine::GitEngine;
use gittree_core::git::graph::{get_commit_diff, get_graph_page, GraphCommit};

actions!(poc, [NextCommit, PrevCommit]);

// Token del tema dark di GitTree (src/renderer/styles/variables.css).
const CANVAS: u32 = 0x0f0f11;
const SURFACE_SHELL: u32 = 0x151517;
const SURFACE_PRIMARY: u32 = 0x18181a;
const SURFACE_HOVER: u32 = 0x222226;
const SURFACE_SELECTED: u32 = 0x1a2f38;
const TEXT_PRIMARY: u32 = 0xf1f2f5;
const TEXT_SECONDARY: u32 = 0x9aa0a6;
const TEXT_TERTIARY: u32 = 0x6e7680;
const TEXT_LINK: u32 = 0x8ab4f8;
const BORDER_SUBTLE: u32 = 0x30363d;
const CHIP_BG: u32 = 0x26272b;

// --graph-lane-1..8 del tema dark.
const LANE_COLORS: [u32; 8] = [
    0x58a6ff, 0xf85149, 0x3fb950, 0xd29922, 0xa371f7, 0x34d4fe, 0xf778ba, 0xd29922,
];

// Token diff del tema dark.
const DIFF_ADD_TEXT: u32 = 0x7ee787;
const DIFF_DEL_TEXT: u32 = 0xff867f;
const DIFF_ADD_BG: u32 = 0x0b2616;
const DIFF_DEL_BG: u32 = 0x3b1518;
const DIFF_HUNK_BG: u32 = 0x162435;
const DIFF_HUNK_TEXT: u32 = 0x58a6ff;

const ROW_HEIGHT: f32 = 36.0;
const STATUSBAR_HEIGHT: f32 = 28.0;

#[derive(Clone, Copy)]
enum LineKind {
    Add,
    Del,
    Hunk,
    Context,
}

struct DiffLine {
    text: String,
    kind: LineKind,
}

fn classify(line: &str) -> LineKind {
    if line.starts_with("@@") {
        LineKind::Hunk
    } else if line.starts_with('+') && !line.starts_with("+++") {
        LineKind::Add
    } else if line.starts_with('-') && !line.starts_with("---") {
        LineKind::Del
    } else {
        LineKind::Context
    }
}

/// Etichetta relativa approssimativa dalla parte data di un ISO-8601 (`%aI`).
fn relative_date(iso: &str) -> String {
    let rest = iso.split('T').next().unwrap_or("");
    let parts: Vec<&str> = rest.split('-').collect();
    let (Some(year), Some(month), Some(day)) = (
        parts.first().and_then(|v| v.parse::<i64>().ok()),
        parts.get(1).and_then(|v| v.parse::<i64>().ok()),
        parts.get(2).and_then(|v| v.parse::<i64>().ok()),
    ) else {
        return String::new();
    };
    // Numero seriale approssimato, sufficiente per un'etichetta relativa.
    let serial = |y: i64, m: i64, d: i64| y * 372 + (m - 1) * 31 + d;
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let now_year = 1970 + secs / 31_557_600;
    let today = serial(now_year, 8, 23);
    match today - serial(year, month, day) {
        n if n <= 0 => "oggi".into(),
        1 => "ieri".into(),
        n if n < 30 => format!("{n}g"),
        n if n < 365 => format!("{}m", n / 30),
        n => format!("{}a", n / 365),
    }
}


/// Layout del grafo: assegna le lane come farebbe `git log --graph`.
#[derive(Clone, Copy, PartialEq)]
enum CellKind {
    Node,
    Pass,
    Empty,
}

#[derive(Clone)]
struct GraphRow {
    lane: usize,
    cells: Vec<(CellKind, usize)>, // (tipo cella, indice colore lane)
}

fn compute_graph_rows(commits_newest_first: &[GraphCommit]) -> Vec<GraphRow> {
    let mut ascending: Vec<&GraphCommit> = commits_newest_first.iter().collect();
    ascending.reverse();

    let mut lanes: Vec<Option<String>> = Vec::new();
    let mut rows = vec![
        GraphRow { lane: 0, cells: Vec::new() };
        commits_newest_first.len()
    ];

    for (order, commit) in ascending.iter().enumerate() {
        let index = commits_newest_first.len() - 1 - order;
        let existing = lanes
            .iter()
            .position(|tip| tip.as_deref() == Some(commit.hash.as_str()));
        let col = match existing {
            Some(col) => col,
            None => lanes
                .iter()
                .position(|tip| tip.is_none())
                .unwrap_or(lanes.len()),
        };
        while lanes.len() <= col {
            lanes.push(None);
        }

        let mut cells: Vec<(CellKind, usize)> = Vec::new();
        let width = lanes.len().max(col + 1);
        for column in 0..width {
            if column == col {
                cells.push((CellKind::Node, column));
            } else if lanes.get(column).map_or(false, |tip| tip.is_some()) {
                cells.push((CellKind::Pass, column));
            } else {
                cells.push((CellKind::Empty, column));
            }
        }
        rows[index] = GraphRow { lane: col, cells };

        // Il primo genitore subentra alla lane del nodo; gli altri occupano lane libere.
        let mut extra_parents = commit.parents.clone();
        lanes[col] = extra_parents.first().cloned();
        for parent in extra_parents.drain(..).skip(1) {
            if !lanes.contains(&Some(parent.clone())) {
                match lanes.iter().position(|tip| tip.is_none()) {
                    Some(free) => lanes[free] = Some(parent),
                    None => lanes.push(Some(parent)),
                }
            }
        }
    }
    rows
}

struct PocApp {
    repo_label: SharedString,
    branch: String,
    commits: Vec<GraphCommit>,
    graph_rows: Vec<GraphRow>,
    diff_lines: Vec<DiffLine>,
    selected: usize,
    list_scroll: UniformListScrollHandle,
    status_line: SharedString,
}

impl PocApp {
    fn load(repo_path: &str) -> Self {
        let engine = GitEngine::default();
        let repo = std::path::Path::new(repo_path);
        let branch = gittree_core::git::status::get_status(&engine, repo)
            .map(|snapshot| snapshot.branch)
            .unwrap_or_default();
        match get_graph_page(&engine, repo, 0, 5_000) {
            Ok(page) => {
                let mut commits = page.commits;
                commits.reverse(); // dal piu recente in giu, come il grafo di GitTree
                let selected = commits.len().saturating_sub(1);
                let mut state = Self {
                    repo_label: repo_path.to_owned().into(),
                    branch,
                    graph_rows: compute_graph_rows(&commits),
                    diff_lines: Vec::new(),
                    list_scroll: UniformListScrollHandle::new(),
                    status_line: format!(
                        "{} commit · {} refs · GPUI",
                        commits.len(),
                        page.refs.len()
                    )
                    .into(),
                    commits,
                    selected,
                };
                state.refresh_diff(&engine, repo);
                state
            }
            Err(error) => Self {
                repo_label: repo_path.to_owned().into(),
                branch,
                commits: Vec::new(),
                graph_rows: Vec::new(),
                diff_lines: vec![DiffLine {
                    text: format!("errore git: {}", error.message),
                    kind: LineKind::Context,
                }],
                selected: 0,
                list_scroll: UniformListScrollHandle::new(),
                status_line: "nessun dato".into(),
            },
        }
    }

    fn refresh_diff(&mut self, engine: &GitEngine, repo: &std::path::Path) {
        self.diff_lines = self
            .commits
            .get(self.selected)
            .map(|commit| get_commit_diff(engine, repo, &commit.hash, None))
            .unwrap_or_else(|| Ok(String::new()))
            .unwrap_or_else(|error| format!("diff non disponibile: {}", error.message))
            .lines()
            .map(|line| DiffLine {
                text: line.to_string(),
                kind: classify(line),
            })
            .collect();
    }

    fn select(&mut self, delta: isize, cx: &mut Context<Self>) {
        let total = self.commits.len() as isize;
        if total == 0 {
            return;
        }
        self.selected = (self.selected as isize + delta).clamp(0, total - 1) as usize;
        let repo_path = self.repo_label.to_string();
        self.refresh_diff(&GitEngine::default(), std::path::Path::new(&repo_path));
        self.status_line =
            format!("commit {} di {}", self.selected + 1, self.commits.len()).into();
        cx.notify();
    }

    fn pick(&mut self, index: usize, cx: &mut Context<Self>) {
        if index < self.commits.len() && index != self.selected {
            self.selected = index;
            let repo_path = self.repo_label.to_string();
            self.refresh_diff(&GitEngine::default(), std::path::Path::new(&repo_path));
            self.status_line =
                format!("commit {} di {}", index + 1, self.commits.len()).into();
            cx.notify();
        }
    }
}

impl Render for PocApp {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let total = self.commits.len();
        let branch_label = if self.branch.is_empty() {
            None
        } else {
            Some(SharedString::from(format!(" {}", self.branch)))
        };
        let list_scroll = self.list_scroll.clone();

        div()
            .flex()
            .flex_col()
            .size_full()
            .bg(rgb(CANVAS))
            .text_size(px(13.0))
            .text_color(rgb(TEXT_PRIMARY))
            .on_action(cx.listener(|this, _: &NextCommit, _window, cx| this.select(1, cx)))
            .on_action(cx.listener(|this, _: &PrevCommit, _window, cx| this.select(-1, cx)))
            // Barra superiore: wordmark + repo + chip branch.
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_3()
                    .px_3()
                    .h(px(40.0))
                    .bg(rgb(SURFACE_SHELL))
                    .border_b_1()
                    .border_color(rgb(BORDER_SUBTLE))
                    .child(div().font_weight(FontWeight::SEMIBOLD).child(SharedString::from("GitTree")))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_color(rgb(TEXT_TERTIARY))
                            .child(self.repo_label.clone()),
                    )
                    .when_some(branch_label, |bar, label| {
                        bar.child(
                            div()
                                .rounded_md()
                                .px_2()
                                .py_0p5()
                                .bg(rgb(CHIP_BG))
                                .font_family(SharedString::from("monospace"))
                                .text_color(rgb(TEXT_LINK))
                                .child(label),
                        )
                    }),
            )
            // Corpo: due pannelli bento arrotondati.
            .child(
                div()
                    .flex()
                    .flex_1()
                    .min_h_0()
                    .gap_1()
                    .p_1()
                    // Sinistra: lista commit virtualizzata.
                    .child(if total == 0 {
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded_lg()
                            .bg(rgb(SURFACE_PRIMARY))
                            .border_1()
                            .border_color(rgb(BORDER_SUBTLE))
                            .text_color(rgb(TEXT_TERTIARY))
                            .child(SharedString::from("Nessun commit nel repository"))
                            .into_any_element()
                    } else {
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .rounded_lg()
                            .overflow_hidden()
                            .bg(rgb(SURFACE_PRIMARY))
                            .border_1()
                            .border_color(rgb(BORDER_SUBTLE))
                            .child(
                                uniform_list("commit-list", total, cx.processor(
                                    |this, visible: Range<usize>, _window, cx| {
                                        visible
                                            .map(|index| this.render_commit_row(index, cx))
                                            .collect::<Vec<_>>()
                                    },
                                ))
                                .track_scroll(list_scroll)
                                .flex_1()
                                .h_full(),
                            )
                            .into_any_element()
                    })
                    // Destra: diff del commit selezionato.
                    .child(self.render_diff_panel()),
            )
            // Status bar (28px come --statusbar-height).
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_3()
                    .px_3()
                    .h(px(STATUSBAR_HEIGHT))
                    .bg(rgb(SURFACE_SHELL))
                    .border_t_1()
                    .border_color(rgb(BORDER_SUBTLE))
                    .text_size(px(11.0))
                    .text_color(rgb(TEXT_SECONDARY))
                    .child(self.status_line.clone())
                    .child(div().flex_1())
                    .child(
                        div()
                            .text_color(rgb(TEXT_TERTIARY))
                            .child(SharedString::from("Rust · GPUI POC")),
                    ),
            )
    }
}

impl PocApp {
    fn render_commit_row(&self, index: usize, cx: &mut Context<Self>) -> gpui::AnyElement {
        let Some(commit) = self.commits.get(index) else {
            return div().h(px(ROW_HEIGHT)).into_any_element();
        };
        let is_selected = index == self.selected;
        let graph_cells = self.graph_rows.get(index);
        let hash = SharedString::from(commit.hash.chars().take(7).collect::<String>());
        let subject = SharedString::from(commit.subject.clone());
        let author = SharedString::from(commit.author_name.clone());
        let date = SharedString::from(relative_date(&commit.date));

        div()
            .id(("commit-row", index))
            .flex()
            .items_center()
            .gap_2()
            .px_3()
            .h(px(ROW_HEIGHT))
            .w_full()
            .when(is_selected, |row| row.bg(rgb(SURFACE_SELECTED)))
            .hover(|row| row.bg(rgb(SURFACE_HOVER)))
            .on_click(cx.listener(move |this, _: &ClickEvent, _window, cx| {
                this.pick(index, cx);
            }))
            .child(
                // Colonna grafo: lane reali derivate dai parent dei commit.
                div()
                    .flex()
                    .items_center()
                    .font_family(SharedString::from("monospace"))
                    .children(graph_cells.map(|row| {
                        row.cells.iter().map(|(kind, color_index)| {
                            let glyph = match kind {
                                CellKind::Node => "\u{25cf}",
                                CellKind::Pass => "\u{2502}",
                                CellKind::Empty => " ",
                            };
                            div()
                                .w(px(14.0))
                                .text_center()
                                .text_size(px(12.0))
                                .text_color(rgb(LANE_COLORS[color_index % LANE_COLORS.len()]))
                                .child(SharedString::from(glyph))
                        }).collect::<Vec<_>>()
                    }).unwrap_or_default()),
            )
            .child(
                div()
                    .font_family(SharedString::from("monospace"))
                    .text_color(rgb(TEXT_LINK))
                    .child(hash),
            )
            .child(div().flex_1().min_w_0().truncate().child(subject))
            .child(
                div()
                    .max_w(px(140.0))
                    .truncate()
                    .text_color(rgb(TEXT_SECONDARY))
                    .child(author),
            )
            .child(div().text_color(rgb(TEXT_TERTIARY)).child(date))
            .into_any_element()
    }

    fn render_diff_panel(&self) -> gpui::AnyElement {
        let header = self
            .commits
            .get(self.selected)
            .map(|commit| {
                SharedString::from(format!(
                    "{}  {}",
                    commit.hash.chars().take(7).collect::<String>(),
                    commit.subject
                ))
            })
            .unwrap_or_else(|| SharedString::from("Diff"));

        let rows: Vec<gpui::AnyElement> = self
            .diff_lines
            .iter()
            .map(|line| {
                let (fg, bg) = match line.kind {
                    LineKind::Add => (DIFF_ADD_TEXT, DIFF_ADD_BG),
                    LineKind::Del => (DIFF_DEL_TEXT, DIFF_DEL_BG),
                    LineKind::Hunk => (DIFF_HUNK_TEXT, DIFF_HUNK_BG),
                    LineKind::Context => (TEXT_SECONDARY, SURFACE_PRIMARY),
                };
                div()
                    .font_family(SharedString::from("monospace"))
                    .text_size(px(12.0))
                    .text_color(rgb(fg))
                    .bg(rgb(bg))
                    .whitespace_nowrap()
                    .px_2()
                    .child(SharedString::from(line.text.clone()))
                    .into_any_element()
            })
            .collect();

        div()
            .flex_1()
            .min_w_0()
            .flex()
            .flex_col()
            .rounded_lg()
            .overflow_hidden()
            .bg(rgb(SURFACE_PRIMARY))
            .border_1()
            .border_color(rgb(BORDER_SUBTLE))
            .child(
                div()
                    .flex()
                    .items_center()
                    .px_3()
                    .h(px(34.0))
                    .bg(rgb(SURFACE_SHELL))
                    .border_b_1()
                    .border_color(rgb(BORDER_SUBTLE))
                    .truncate()
                    .child(header),
            )
            .child(
                div()
                    .id("diff-scroll")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .py_1()
                    .children(rows),
            )
            .into_any_element()
    }
}

fn main() {
    let repo_path = std::env::args().nth(1).unwrap_or_else(|| ".".to_string());
    Application::new().run(move |app: &mut App| {
        app.bind_keys([
            KeyBinding::new("down", NextCommit, None),
            KeyBinding::new("up", PrevCommit, None),
        ]);
        let bounds = Bounds::centered(None, size(px(1180.), px(760.)), app);
        let result = app.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                ..Default::default()
            },
            |_, cx| cx.new(|_| PocApp::load(repo_path.as_str())),
        );
        if let Err(error) = result {
            eprintln!("impossibile aprire la finestra: {error}");
            std::process::exit(1);
        }
        app.activate(true);
    });
}
