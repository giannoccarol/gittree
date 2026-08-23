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
    /// Il commit e' puntato da HEAD (anello `--graph-head` sul nodo).
    pub is_head: bool,
    pub subject: SharedString,
    pub author: SharedString,
    pub date_rel: SharedString,
    pub haystack: String,
    pub chips: Vec<RefChip>,
}

pub struct RowModels {
    pub commits: Vec<CommitRow>,
    pub graph_rows: Vec<GraphRow>,
    /// Lane massime della pagina: determina la larghezza colonna grafo.
    pub graph_lane_count: usize,
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
    let mut head_hashes: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for reference in refs {
        if reference.ref_type == GraphRefType::Head {
            head_hashes.insert(reference.commit.trim());
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
                is_head: head_hashes.contains(commit.hash.trim()),
                hash,
                subject: SharedString::from(subject),
                author: SharedString::from(author),
                date_rel: SharedString::from(relative_date(commit.date.trim(), today)),
                haystack,
                chips: chips_by_hash.remove(commit.hash.trim()).unwrap_or_default(),
            }
        })
        .collect();

    let layout = layout_graph(commits);
    RowModels {
        commits: commits_model,
        graph_rows: layout.rows,
        graph_lane_count: layout.lane_count,
    }
}

// -- Lane del grafo ------------------------------------------------------
//
// Port fedele di `src/renderer/components/graph-layout.mts` (layoutGraph +
// createGraphSegments): stesse regole di assegnazione lane, stesso dedup
// del first parent su lane esistente, stessa geometria dei segmenti.

#[derive(Clone, Copy, Debug)]
pub struct GraphParent {
    pub lane: usize,
}

/// Riga di layout del grafo: tutto cio' che serve a disegnare i binari,
/// le curve verso i parent e il nodo, senza stringe.
#[derive(Clone, Debug)]
pub struct GraphRow {
    pub lane: usize,
    pub incoming: bool,
    /// Lane con binario verticale passante (occupate da altri commit).
    pub rails: Vec<bool>,
    pub parents: Vec<GraphParent>,
}

pub struct GraphLayout {
    pub rows: Vec<GraphRow>,
    pub lane_count: usize,
}

fn first_available_lane<T>(lanes: &[Option<T>]) -> usize {
    lanes
        .iter()
        .position(Option::is_none)
        .unwrap_or(lanes.len())
}

fn trim_trailing_lanes<T>(lanes: &mut Vec<Option<T>>) {
    while lanes.last().is_some_and(Option::is_none) {
        lanes.pop();
    }
}

/// Port di `layoutGraph`: processa i commit newest-first come da pagina git.
pub fn layout_graph(commits_newest_first: &[GraphCommit]) -> GraphLayout {
    let mut lanes: Vec<Option<String>> = Vec::new();
    let mut rows = Vec::with_capacity(commits_newest_first.len());
    let mut lane_count = 0usize;

    for commit in commits_newest_first {
        let hash = commit.hash.trim();
        let existing = lanes.iter().position(|tip| tip.as_deref() == Some(hash));
        let incoming = existing.is_some();
        let lane = existing.unwrap_or_else(|| {
            let lane = first_available_lane(&lanes);
            if lane == lanes.len() {
                lanes.push(None);
            }
            lane
        });
        lanes[lane] = Some(hash.to_string());

        let before: Vec<bool> = lanes.iter().map(|tip| tip.is_some()).collect();
        let mut parents: Vec<GraphParent> = Vec::new();

        match commit.parents.first().map(String::as_str) {
            None => lanes[lane] = None,
            Some(first_parent) => {
                // Il first parent gia' presente su un'altra lane chiude la
                // propria lane e punta lì (niente doppio binario).
                let existing_parent = lanes
                    .iter()
                    .enumerate()
                    .position(|(index, tip)| index != lane && tip.as_deref() == Some(first_parent));
                match existing_parent {
                    Some(parent_lane) => {
                        lanes[lane] = None;
                        parents.push(GraphParent { lane: parent_lane });
                    }
                    None => {
                        // La lane del commit prosegue con il first parent.
                        lanes[lane] = Some(first_parent.to_string());
                        parents.push(GraphParent { lane });
                    }
                }
            }
        }

        for parent in commit.parents.iter().skip(1) {
            let parent_hash = parent.as_str().trim();
            let parent_lane = match lanes
                .iter()
                .position(|tip| tip.as_deref() == Some(parent_hash))
            {
                Some(parent_lane) => parent_lane,
                None => {
                    let parent_lane = first_available_lane(&lanes);
                    if parent_lane == lanes.len() {
                        lanes.push(None);
                    }
                    lanes[parent_lane] = Some(parent_hash.to_string());
                    parent_lane
                }
            };
            parents.push(GraphParent { lane: parent_lane });
        }

        trim_trailing_lanes(&mut lanes);
        lane_count = lane_count.max(before.len()).max(lanes.len()).max(lane + 1);

        rows.push(GraphRow {
            lane,
            incoming,
            // `createGraphSegments`: binari verticali su ogni lane occupata
            // dello snapshot `before`, tranne la propria.
            rails: before
                .iter()
                .enumerate()
                .filter(|(index, _)| *index != lane)
                .map(|(_, occupied)| *occupied)
                .collect(),
            parents,
        });
    }

    GraphLayout { rows, lane_count }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn commit(hash: &str, parents: &[&str]) -> GraphCommit {
        GraphCommit {
            hash: hash.to_string(),
            subject: String::new(),
            author_name: String::new(),
            author_email: String::new(),
            date: String::new(),
            parents: parents.iter().map(|parent| parent.to_string()).collect(),
        }
    }

    #[test]
    fn linear_history_stays_on_lane_zero() {
        let commits = [commit("c", &["b"]), commit("b", &["a"]), commit("a", &[])];
        let layout = layout_graph(&commits);
        assert_eq!(layout.rows.len(), 3);
        assert!(layout.rows.iter().all(|row| row.lane == 0));
        assert_eq!(layout.lane_count, 1);
        // Solo il commit piu' nuovo non e' "incoming": gli altri sono stati
        // piazzati sulla lane dal rispettivo figlio.
        assert!(!layout.rows[0].incoming);
        assert!(layout.rows[1].incoming);
        assert!(layout.rows[2].incoming);
    }

    #[test]
    fn branch_gets_its_own_lane_and_merges_back() {
        // main: a --- c --- d
        //           \- b --/
        let commits = [
            commit("d", &["c"]),
            commit("c", &["a", "b"]),
            commit("b", &["a"]),
            commit("a", &[]),
        ];
        let layout = layout_graph(&commits);
        assert_eq!(layout.rows[3].lane, 0); // a
        assert_eq!(layout.rows[2].lane, 1); // b su lane nuova
        assert_eq!(layout.rows[1].lane, 0); // c
        assert_eq!(layout.rows[0].lane, 0); // d
        // c ha due parent: primo sulla propria lane, merge parent su lane 1.
        let row_c = &layout.rows[1];
        assert_eq!(row_c.parents.len(), 2);
        assert_eq!(row_c.parents[0].lane, 0);
        assert_eq!(row_c.parents[1].lane, 1);
    }

    #[test]
    fn first_parent_already_on_other_lane_closes_own_lane() {
        // x punta a b che si trova gia' sulla lane principale: la sua lane
        // si chiude e il binario punta lì invece di duplicarsi.
        let commits = [
            commit("c", &["b"]),
            commit("x", &["b"]),
            commit("b", &["a"]),
            commit("a", &[]),
        ];
        let layout = layout_graph(&commits);
        let row_x = &layout.rows[1];
        assert_eq!(row_x.lane, 1);
        assert_eq!(row_x.parents.len(), 1);
        assert_eq!(row_x.parents[0].lane, 0);
    }

    #[test]
    fn rails_skip_own_lane_like_create_graph_segments() {
        let commits = [
            commit("d", &["c"]),
            commit("c", &["a", "b"]),
            commit("b", &["a"]),
            commit("a", &[]),
        ];
        let layout = layout_graph(&commits);
        // Riga di b (indice 2): la propria lane e' esclusa dai binari,
        // resta solo il passante del ramo principale (lane 0).
        let row_b = &layout.rows[2];
        assert_eq!(row_b.lane, 1);
        assert_eq!(row_b.rails, vec![true]);
        assert!(row_b.incoming);
    }
}
