//! Port di `src/renderer/components/diff-parser.mts` (comportamento identico).

use regex::Regex;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum RowKind {
    #[serde(rename = "hunk")]
    Hunk,
    #[serde(rename = "file")]
    File,
    #[serde(rename = "no-newline")]
    NoNewline,
    #[serde(rename = "header")]
    Header,
    #[serde(rename = "add")]
    Add,
    #[serde(rename = "del")]
    Del,
    #[serde(rename = "context")]
    Context,
    #[serde(rename = "empty")]
    Empty,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedRow {
    pub content: String,
    pub kind: RowKind,
    pub old_line: Option<i64>,
    pub new_line: Option<i64>,
    /// Il port TS propaga le proprietà della riga sorgente via spread:
    /// qui conserviamo solo `type`, presente solo nell'output di `number_hunk`.
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub source_type: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SplitRow {
    Pair { left: UnifiedRow, right: UnifiedRow },
    Full(UnifiedRow),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HunkRange {
    pub old_start: i64,
    pub old_count: i64,
    pub new_start: i64,
    pub new_count: i64,
}

/// Replica `headerRange(line)`.
pub fn header_range(line: &str) -> Option<HunkRange> {
    let re = Regex::new(r"^@@@? -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@@?").expect("static regex");
    let c = re.captures(line)?;
    let get = |index: usize| -> i64 {
        c.get(index)
            .and_then(|m| m.as_str().parse::<i64>().ok())
            .unwrap_or(1)
    };
    Some(HunkRange {
        old_start: c[1].parse().ok()?,
        old_count: get(2),
        new_start: c[3].parse().ok()?,
        new_count: get(4),
    })
}

/// Replica `metadataKind(line)`.
pub fn metadata_kind(line: &str) -> Option<RowKind> {
    const HEADER_PREFIXES: [&str; 10] = [
        "index ",
        "--- ",
        "+++ ",
        "new file",
        "deleted file",
        "similarity",
        "rename from ",
        "rename to ",
        "old mode ",
        "new mode ",
    ];
    if line.starts_with("diff --git") {
        return Some(RowKind::File);
    }
    if line.starts_with("@@") {
        return Some(RowKind::Hunk);
    }
    if line == "\\ No newline at end of file" {
        return Some(RowKind::NoNewline);
    }
    if HEADER_PREFIXES
        .iter()
        .any(|prefix| line.starts_with(prefix))
    {
        return Some(RowKind::Header);
    }
    None
}

fn row(content: &str, kind: RowKind, old_line: Option<i64>, new_line: Option<i64>) -> UnifiedRow {
    UnifiedRow {
        content: content.to_string(),
        kind,
        old_line,
        new_line,
        source_type: None,
    }
}

/// Replica `parseUnified(patch)`.
pub fn parse_unified(patch: &str) -> Vec<UnifiedRow> {
    let mut old_line: Option<i64> = None;
    let mut new_line: Option<i64> = None;
    let mut in_hunk = false;

    patch
        .split('\n')
        .map(|content| match metadata_kind(content) {
            Some(RowKind::Hunk) => {
                let range = header_range(content);
                old_line = range.map(|r| r.old_start);
                new_line = range.map(|r| r.new_start);
                in_hunk = range.is_some();
                row(content, RowKind::Hunk, None, None)
            }
            Some(RowKind::File) => {
                in_hunk = false;
                row(content, RowKind::File, None, None)
            }
            Some(RowKind::NoNewline) => row(content, RowKind::NoNewline, None, None),
            metadata => {
                if !in_hunk {
                    return row(content, metadata.unwrap_or(RowKind::Header), None, None);
                }
                if content.starts_with('+') {
                    let out = row(content, RowKind::Add, None, new_line);
                    if new_line.is_some() {
                        new_line = Some(new_line.unwrap_or_default() + 1);
                    }
                    return out;
                }
                if content.starts_with('-') {
                    let out = row(content, RowKind::Del, old_line, None);
                    if old_line.is_some() {
                        old_line = Some(old_line.unwrap_or_default() + 1);
                    }
                    return out;
                }
                let out = row(content, RowKind::Context, old_line, new_line);
                if old_line.is_some() {
                    old_line = Some(old_line.unwrap_or_default() + 1);
                }
                if new_line.is_some() {
                    new_line = Some(new_line.unwrap_or_default() + 1);
                }
                out
            }
        })
        .collect()
}

fn empty_side() -> UnifiedRow {
    UnifiedRow {
        content: String::new(),
        kind: RowKind::Empty,
        old_line: None,
        new_line: None,
        source_type: None,
    }
}

/// Replica `parseSplit(patch)`.
pub fn parse_split(patch: &str) -> Vec<SplitRow> {
    let mut output: Vec<SplitRow> = Vec::new();
    let mut deletions: Vec<UnifiedRow> = Vec::new();
    let mut additions: Vec<UnifiedRow> = Vec::new();

    let flush = |output: &mut Vec<SplitRow>,
                 deletions: &mut Vec<UnifiedRow>,
                 additions: &mut Vec<UnifiedRow>| {
        let count = deletions.len().max(additions.len());
        for index in 0..count {
            output.push(SplitRow::Pair {
                left: deletions.get(index).cloned().unwrap_or_else(empty_side),
                right: additions.get(index).cloned().unwrap_or_else(empty_side),
            });
        }
        deletions.clear();
        additions.clear();
    };

    for row in parse_unified(patch) {
        match row.kind {
            RowKind::Del => deletions.push(row),
            RowKind::Add => additions.push(row),
            RowKind::Context => {
                flush(&mut output, &mut deletions, &mut additions);
                output.push(SplitRow::Pair {
                    left: row.clone(),
                    right: row,
                });
            }
            _ => {
                flush(&mut output, &mut deletions, &mut additions);
                output.push(SplitRow::Full(row));
            }
        }
    }
    flush(&mut output, &mut deletions, &mut additions);
    output
}

/// Input per `number_hunk`, equivalente a `NumberableHunk`.
#[derive(Debug, Clone, Default)]
pub struct HunkSourceLine {
    pub content: Option<String>,
    pub line_type: Option<String>,
}

#[derive(Debug, Clone)]
pub struct NumberableHunk<'a> {
    pub old_range_start: Option<i64>,
    pub new_range_start: Option<i64>,
    pub lines: &'a [HunkSourceLine],
}

/// Replica `numberHunk(hunk)`.
pub fn number_hunk(hunk: NumberableHunk<'_>) -> Vec<UnifiedRow> {
    let mut old_line = hunk.old_range_start.unwrap_or(0);
    let mut new_line = hunk.new_range_start.unwrap_or(0);

    hunk.lines
        .iter()
        .map(|source| {
            let content = source.content.clone().unwrap_or_default();
            let supplied_type = source.line_type.clone();
            if content == "\\ No newline at end of file" {
                return UnifiedRow {
                    content,
                    kind: RowKind::NoNewline,
                    old_line: None,
                    new_line: None,
                    source_type: supplied_type,
                };
            }
            let kind = if supplied_type.as_deref() == Some("delete") || content.starts_with('-') {
                RowKind::Del
            } else if supplied_type.as_deref() == Some("add") || content.starts_with('+') {
                RowKind::Add
            } else {
                RowKind::Context
            };
            match kind {
                RowKind::Add => {
                    let out = UnifiedRow {
                        content,
                        kind,
                        old_line: None,
                        new_line: Some(new_line),
                        source_type: supplied_type,
                    };
                    new_line += 1;
                    out
                }
                RowKind::Del => {
                    let out = UnifiedRow {
                        content,
                        kind,
                        old_line: Some(old_line),
                        new_line: None,
                        source_type: supplied_type,
                    };
                    old_line += 1;
                    out
                }
                _ => {
                    let out = UnifiedRow {
                        content,
                        kind,
                        old_line: Some(old_line),
                        new_line: Some(new_line),
                        source_type: supplied_type,
                    };
                    old_line += 1;
                    new_line += 1;
                    out
                }
            }
        })
        .collect()
}

/// Replica `maxDigits(rows)`.
pub fn max_digits(rows: &[SplitRow]) -> usize {
    let mut maximum = 1usize;
    for row in rows {
        let candidates: [Option<i64>; 4] = match row {
            SplitRow::Pair { left, right } => {
                [left.old_line, left.new_line, right.old_line, right.new_line]
            }
            SplitRow::Full(full) => [full.old_line, full.new_line, None, None],
        };
        for value in candidates.into_iter().flatten() {
            maximum = maximum.max(value.to_string().len());
        }
    }
    maximum
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_range_supporta_hunk_combinati() {
        let range = header_range("@@@ -1,2 +3,4 @@@").expect("range valido");
        assert_eq!(range.old_start, 1);
        assert_eq!(range.old_count, 2);
        assert_eq!(range.new_start, 3);
        assert_eq!(range.new_count, 4);
    }

    #[test]
    fn riga_vuota_in_hunk_diventa_context() {
        // Quirks del port TS: split('\n') su patch con newline finale
        // produce un'ultima riga vuota trattata come context.
        let rows = parse_unified("@@ -1 +1 @@\n-x\n+y\n");
        let last = rows.last().expect("almeno una riga");
        assert_eq!(last.kind, RowKind::Context);
        assert_eq!(last.content, "");
        assert_eq!(last.old_line, Some(2));
        assert_eq!(last.new_line, Some(2));
    }

    #[test]
    fn parse_split_affianca_delete_e_add() {
        let rows = parse_split("@@ -1 +1 @@\n-vecchio\n+nuovo\n");
        // La prima riga è l'header hunk (Full), segue la coppia del/add.
        assert!(matches!(rows[0], SplitRow::Full(_)));
        match &rows[1] {
            SplitRow::Pair { left, right } => {
                assert_eq!(left.kind, RowKind::Del);
                assert_eq!(right.kind, RowKind::Add);
            }
            other => panic!("seconda riga non accoppiata: {other:?}"),
        }
    }

    #[test]
    fn max_digits_minimo_uno() {
        assert_eq!(max_digits(&[]), 1);
    }

    #[test]
    fn max_digits_conteggia_le_cifre_massime() {
        let rows = vec![SplitRow::Pair {
            left: UnifiedRow {
                content: "-x".into(),
                kind: RowKind::Del,
                old_line: Some(12345),
                new_line: None,
                source_type: None,
            },
            right: UnifiedRow {
                content: "+x".into(),
                kind: RowKind::Add,
                old_line: None,
                new_line: Some(7),
                source_type: None,
            },
        }];
        assert_eq!(max_digits(&rows), 5);
    }
}
