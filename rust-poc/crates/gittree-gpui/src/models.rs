//! Modelli di presentazione calcolati una sola volta per refresh:
//! righe commit precompilate, sezioni diff, lane grafo, date relative.
//! Tutti gli SharedString evitano copie durante il render.

use std::ops::Range;

use gittree_core::git::graph::{GraphCommit, GraphRef, GraphRefType};
use gpui::SharedString;

#[derive(Clone, Copy, PartialEq)]
pub enum LineKind {
    Add,
    Del,
    Hunk,
    Context,
}

pub struct DiffLine {
    pub text: SharedString,
    pub kind: LineKind,
}

pub struct FileSection {
    pub path: SharedString,
    pub range: Range<usize>,
    pub added: usize,
    pub deleted: usize,
}

pub struct DiffModel {
    pub lines: Vec<DiffLine>,
    pub files: Vec<FileSection>,
    pub added: usize,
    pub deleted: usize,
    pub binary: bool,
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

impl DiffModel {
    pub fn empty() -> Self {
        Self {
            lines: Vec::new(),
            files: Vec::new(),
            added: 0,
            deleted: 0,
            binary: false,
        }
    }

    /// Parsing minimale ma completo di un diff unificato git:
    /// sezioni per file con range di righe e contatori add/del.
    pub fn parse(raw: &str) -> Self {
        let mut model = DiffModel::empty();
        let mut current: Option<FileSection> = None;
        let mut in_binary_header = false;
        for line in raw.lines() {
            if let Some(rest) = line.strip_prefix("diff --git ") {
                if let Some(section) = current.take() {
                    model.added += section.added;
                    model.deleted += section.deleted;
                    model.files.push(section);
                }
                // b/<path> dopo l'ultimo spazio; gestisce anche i rename.
                let path = rest
                    .rsplit_once(" b/")
                    .map(|(_, path)| path)
                    .unwrap_or(rest);
                in_binary_header = false;
                current = Some(FileSection {
                    path: SharedString::from(path.to_string()),
                    range: model.lines.len()..model.lines.len(),
                    added: 0,
                    deleted: 0,
                });
                continue;
            }
            if line.starts_with("Binary files ") || line.starts_with("GIT binary patch") {
                in_binary_header = true;
                model.binary = true;
                if let Some(section) = current.as_mut() {
                    push_line(
                        &mut model.lines,
                        &mut section.range,
                        line,
                        LineKind::Context,
                    );
                }
                continue;
            }
            if in_binary_header {
                continue;
            }
            if line.starts_with("index ")
                || line.starts_with("old mode")
                || line.starts_with("new mode")
                || line.starts_with("new file mode")
                || line.starts_with("deleted file mode")
                || line.starts_with("similarity index")
                || line.starts_with("rename from")
                || line.starts_with("rename to")
                || line.starts_with("+++ ")
                || line.starts_with("--- ")
            {
                continue;
            }
            let Some(section) = current.as_mut() else {
                continue;
            };
            let kind = classify(line);
            match kind {
                LineKind::Add => section.added += 1,
                LineKind::Del => section.deleted += 1,
                _ => {}
            }
            push_line(&mut model.lines, &mut section.range, line, kind);
        }
        if let Some(section) = current.take() {
            model.added += section.added;
            model.deleted += section.deleted;
            model.files.push(section);
        }
        model
    }

    /// Righe visibili per il file selezionato (None = intero diff).
    pub fn visible_range(&self, selected_file: Option<usize>) -> Range<usize> {
        match selected_file.and_then(|index| self.files.get(index)) {
            Some(section) => section.range.clone(),
            None => 0..self.lines.len(),
        }
    }
}

fn push_line(lines: &mut Vec<DiffLine>, range: &mut Range<usize>, text: &str, kind: LineKind) {
    lines.push(DiffLine {
        text: SharedString::from(text.to_string()),
        kind,
    });
    range.end = lines.len();
}

/// Chip di riferimento associato a un commit (branch/tag/remote).
pub struct RefChip {
    pub label: SharedString,
    pub kind: RefChipKind,
}

#[derive(Clone, Copy, PartialEq)]
pub enum RefChipKind {
    Branch,
    Remote,
    Tag,
}

/// Riga della lista commit con tutte le stringhe pronte per il render.
pub struct CommitRow {
    pub hash: String,
    pub hash_short: SharedString,
    pub subject: SharedString,
    pub author: SharedString,
    pub date_rel: SharedString,
    pub haystack: String,
    pub chips: Vec<RefChip>,
}

pub struct RowModels {
    pub commits: Vec<CommitRow>,
    pub graph_rows: Vec<GraphRow>,
}

/// Etichetta relativa accurata dalla parte data di un ISO-8601 (`%aI`).
pub fn relative_date(iso: &str, today_epoch_days: i64) -> String {
    let rest = iso.split('T').next().unwrap_or("");
    let parts: Vec<&str> = rest.split('-').collect();
    let (Some(year), Some(month), Some(day)) = (
        parts.first().and_then(|value| value.parse::<i64>().ok()),
        parts.get(1).and_then(|value| value.parse::<i64>().ok()),
        parts.get(2).and_then(|value| value.parse::<i64>().ok()),
    ) else {
        return String::new();
    };
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return String::new();
    }
    match today_epoch_days - days_from_civil(year, month as u32, day as u32) {
        n if n <= 0 => "today".into(),
        1 => "yesterday".into(),
        n if n < 7 => format!("{n}d"),
        n if n < 30 => format!("{}w", n / 7),
        n if n < 365 => format!("{}mo", n / 30),
        n => format!("{}y", n / 365),
    }
}

/// Giorni dall'epoch per data civile (algoritmo di Hinnant).
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let m = month as i64;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + day as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

pub fn today_epoch_days() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64 / 86_400)
        .unwrap_or(0)
}

fn chip_kind(ref_type: GraphRefType) -> RefChipKind {
    match ref_type {
        GraphRefType::Branch | GraphRefType::Head => RefChipKind::Branch,
        GraphRefType::Remote => RefChipKind::Remote,
        GraphRefType::Tag => RefChipKind::Tag,
    }
}

/// Precomputa tutti i modelli riga per la pagina corrente (una volta per refresh).
pub fn build_rows(commits: &[GraphCommit], refs: &[GraphRef]) -> RowModels {
    let today = today_epoch_days();
    // Indice hash -> chips, costruito una volta sui refs.
    let mut chips_by_hash: std::collections::HashMap<&str, Vec<RefChip>> =
        std::collections::HashMap::new();
    for reference in refs {
        if reference.ref_type == GraphRefType::Head {
            continue;
        }
        chips_by_hash
            .entry(reference.commit.trim())
            .or_default()
            .push(RefChip {
                label: SharedString::from(reference.short_name.clone()),
                kind: chip_kind(reference.ref_type),
            });
    }

    let commits_model: Vec<CommitRow> = commits
        .iter()
        .map(|commit| {
            let hash = commit.hash.trim().to_string();
            let subject = commit.subject.trim().to_string();
            let author = commit.author_name.trim().to_string();
            let haystack = format!("{}\n{}\n{}", subject, author, hash).to_lowercase();
            CommitRow {
                hash_short: SharedString::from(hash.chars().take(7).collect::<String>()),
                hash,
                subject: SharedString::from(subject),
                author: SharedString::from(author),
                date_rel: SharedString::from(relative_date(commit.date.trim(), today)),
                haystack,
                chips: chips_by_hash.remove(commit.hash.trim()).unwrap_or_default(),
            }
        })
        .collect();

    RowModels {
        commits: commits_model,
        graph_rows: compute_graph_rows(commits),
    }
}

// -- Lane del grafo ------------------------------------------------------

#[derive(Clone, Copy, PartialEq)]
pub enum CellKind {
    Node,
    Pass,
    Empty,
}

#[derive(Clone)]
pub struct GraphRow {
    pub cells: Vec<(CellKind, usize)>,
}

/// Layout delle lane come farebbe `git log --graph`.
pub fn compute_graph_rows(commits_newest_first: &[GraphCommit]) -> Vec<GraphRow> {
    let mut ascending: Vec<&GraphCommit> = commits_newest_first.iter().collect();
    ascending.reverse();

    let mut lanes: Vec<Option<&str>> = Vec::new();
    let mut rows = vec![GraphRow { cells: Vec::new() }; commits_newest_first.len()];

    for (order, commit) in ascending.iter().enumerate() {
        let index = commits_newest_first.len() - 1 - order;
        let existing = lanes
            .iter()
            .position(|tip| tip.as_deref() == Some(commit.hash.trim()));
        let col = match existing {
            Some(col) => col,
            None => lanes
                .iter()
                .position(Option::is_none)
                .unwrap_or(lanes.len()),
        };
        while lanes.len() <= col {
            lanes.push(None);
        }

        let width = lanes.len().max(col + 1);
        let cells = (0..width)
            .map(|column| {
                if column == col {
                    (CellKind::Node, column)
                } else if lanes.get(column).is_some_and(Option::is_some) {
                    (CellKind::Pass, column)
                } else {
                    (CellKind::Empty, column)
                }
            })
            .collect();
        let _ = col;
        rows[index] = GraphRow { cells };

        let first_parent = commit.parents.first().map(String::as_str);
        lanes[col] = first_parent;
        for parent in commit.parents.iter().skip(1) {
            let parent = parent.as_str();
            if !lanes.contains(&Some(parent)) {
                match lanes.iter().position(Option::is_none) {
                    Some(free) => lanes[free] = Some(parent),
                    None => lanes.push(Some(parent)),
                }
            }
        }
    }
    rows
}
