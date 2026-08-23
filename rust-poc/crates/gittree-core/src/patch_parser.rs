//! Port di `src/main/git/patch-parser.mts` (comportamento identico).

use regex::Regex;
use serde::Serialize;
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DiffLineType {
    Add,
    Delete,
    Context,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffRange {
    pub start: i64,
    pub lines: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WorkingDiffLine {
    #[serde(rename = "type")]
    pub line_type: DiffLineType,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkingDiffHunk {
    pub id: String,
    pub header: String,
    // Il port TS usa `null`, quindi la chiave resta presente nel JSON.
    pub old_range: Option<DiffRange>,
    pub new_range: Option<DiffRange>,
    pub lines: Vec<WorkingDiffLine>,
    pub raw: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkingDiff {
    pub path: String,
    pub staged: bool,
    pub binary: bool,
    pub hunks: Vec<WorkingDiffHunk>,
    pub prelude: String,
}

/// Replica `parseWorkingDiff(relativePath, staged, patch)`.
pub fn parse_working_diff(relative_path: &str, staged: bool, patch: &str) -> WorkingDiff {
    let binary_re =
        Regex::new(r"(?m)^(?:GIT binary patch|Binary files .* differ)$").expect("static regex");
    let hunk_start_re = Regex::new(r"(?m)^@@ ").expect("static regex");
    let range_re =
        Regex::new(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@").expect("static regex");

    let binary = binary_re.is_match(patch);
    let first_hunk = hunk_start_re.find(patch).map(|m| m.start());
    let prelude = match first_hunk {
        None => patch.to_string(),
        Some(at) => patch[..at].to_string(),
    };

    let mut hunks = Vec::new();
    if let Some(first) = first_hunk {
        let source = &patch[first..];
        let starts: Vec<usize> = hunk_start_re.find_iter(source).map(|m| m.start()).collect();
        for (index, &start) in starts.iter().enumerate() {
            let end = starts.get(index + 1).copied().unwrap_or(source.len());
            let raw = &source[start..end];
            let stripped = raw.strip_suffix('\n').unwrap_or(raw);
            let mut parts = stripped.split('\n');
            let header = parts.next().unwrap_or("").to_string();
            let body: Vec<&str> = parts.collect();

            let range = range_re.captures(&header).map(|c| {
                let get = |i: usize, fallback: i64| -> i64 {
                    c.get(i)
                        .and_then(|m| m.as_str().parse::<i64>().ok())
                        .unwrap_or(fallback)
                };
                (
                    DiffRange {
                        start: c[1].parse::<i64>().unwrap_or(0),
                        lines: get(2, 1),
                    },
                    DiffRange {
                        start: c[3].parse::<i64>().unwrap_or(0),
                        lines: get(4, 1),
                    },
                )
            });

            let scope = if staged { "staged" } else { "unstaged" };
            let digest = Sha256::digest(format!("{scope}\0{relative_path}\0{raw}").as_bytes());
            let id: String = digest.iter().map(|b| format!("{b:02x}")).collect();

            hunks.push(WorkingDiffHunk {
                id,
                header,
                old_range: range.as_ref().map(|(old, _)| *old),
                new_range: range.as_ref().map(|(_, new)| *new),
                lines: body
                    .into_iter()
                    .map(|line| WorkingDiffLine {
                        line_type: if line.starts_with('+') {
                            DiffLineType::Add
                        } else if line.starts_with('-') {
                            DiffLineType::Delete
                        } else {
                            DiffLineType::Context
                        },
                        content: line.to_string(),
                    })
                    .collect(),
                raw: raw.to_string(),
            });
        }
    }

    WorkingDiff {
        path: relative_path.to_string(),
        staged,
        binary,
        hunks,
        prelude,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rileva_binary_patch_alternativa() {
        let diff = parse_working_diff("a.bin", false, "GIT binary patch\n");
        assert!(diff.binary);
        assert!(diff.hunks.is_empty());
        assert_eq!(diff.prelude, "GIT binary patch\n");
    }

    #[test]
    fn patch_senza_hunk_restituisce_prelude_integro() {
        let diff = parse_working_diff("a.txt", false, "diff --git a/a.txt b/a.txt\n");
        assert!(diff.hunks.is_empty());
        assert!(!diff.binary);
        assert_eq!(diff.prelude, "diff --git a/a.txt b/a.txt\n");
    }

    #[test]
    fn range_con_contatori_omessi_valgono_uno() {
        let diff = parse_working_diff("a.txt", false, "@@ -3 +3 @@\n context\n");
        let hunk = &diff.hunks[0];
        assert_eq!(hunk.old_range, Some(DiffRange { start: 3, lines: 1 }));
        assert_eq!(hunk.new_range, Some(DiffRange { start: 3, lines: 1 }));
    }

    #[test]
    fn l_id_dipende_dallo_scope_staged() {
        let patch = "@@ -1 +1 @@\n-x\n+y\n";
        let unstaged = parse_working_diff("a.txt", false, patch);
        let staged = parse_working_diff("a.txt", true, patch);
        assert_ne!(unstaged.hunks[0].id, staged.hunks[0].id);
        // L'id copre il raw originale, incluso il newline finale.
        assert_eq!(unstaged.hunks[0].id.len(), 64);
    }
}
