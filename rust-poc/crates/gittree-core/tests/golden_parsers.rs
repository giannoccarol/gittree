//! Golden test: l'output dei parser Rust deve coincidere con quello generato
//! dall'implementazione TypeScript reale (scripts/gen-goldens.mjs).

use gittree_core::blame_parser::parse_blame_porcelain;
use gittree_core::diff_parser::{
    HunkSourceLine, NumberableHunk, max_digits, number_hunk, parse_split, parse_unified,
};
use gittree_core::patch_parser::{DiffLineType, parse_working_diff};
use serde_json::Value;

fn fixture(name: &str) -> String {
    let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("fixture {name}: {error}"))
}

fn expected(name: &str) -> Value {
    serde_json::from_str(&fixture(name)).expect("golden JSON valido")
}

fn actual_json<T: serde::Serialize>(value: &T) -> Value {
    serde_json::to_value(value).expect("serializzazione JSON")
}

#[test]
fn working_diff_unstaged_coincide_col_ts() {
    let patch = fixture("worktree-file.patch");
    let diff = parse_working_diff("file.txt", false, &patch);
    assert_eq!(
        actual_json(&diff),
        expected("expected-working-diff-unstaged.json")
    );
}

#[test]
fn working_diff_staged_coincide_col_ts() {
    let patch = fixture("staged-file.patch");
    let diff = parse_working_diff("file.txt", true, &patch);
    assert_eq!(
        actual_json(&diff),
        expected("expected-working-diff-staged.json")
    );
}

#[test]
fn blame_porcelain_coincide_col_ts() {
    let text = fixture("blame.porcelain");
    let rows = parse_blame_porcelain(&text);
    assert!(!rows.is_empty(), "la fixture blame non deve essere vuota");
    assert_eq!(actual_json(&rows), expected("expected-blame.json"));
}

#[test]
fn parse_unified_coincide_col_ts() {
    let patch = fixture("unified-all.patch");
    assert_eq!(
        actual_json(&parse_unified(&patch)),
        expected("expected-parse-unified.json")
    );
}

#[test]
fn parse_split_coincide_col_ts() {
    let patch = fixture("unified-all.patch");
    assert_eq!(
        actual_json(&parse_split(&patch)),
        expected("expected-parse-split.json")
    );
}

#[test]
fn number_hunk_coincide_col_ts() {
    // Stesso input derivato nel generatore: primo hunk del working diff unstaged.
    let patch = fixture("worktree-file.patch");
    let diff = parse_working_diff("file.txt", false, &patch);
    let hunk = diff.hunks.first().expect("almeno un hunk");

    let lines: Vec<HunkSourceLine> = hunk
        .lines
        .iter()
        .map(|line| HunkSourceLine {
            content: Some(line.content.clone()),
            line_type: Some(
                match line.line_type {
                    DiffLineType::Add => "add",
                    DiffLineType::Delete => "delete",
                    DiffLineType::Context => "context",
                }
                .to_string(),
            ),
        })
        .collect();

    let numbered = number_hunk(NumberableHunk {
        old_range_start: hunk.old_range.map(|range| range.start),
        new_range_start: hunk.new_range.map(|range| range.start),
        lines: &lines,
    });
    assert_eq!(
        actual_json(&numbered),
        expected("expected-number-hunk.json")
    );
}

#[test]
fn max_digits_coincide_col_ts() {
    let patch = fixture("unified-all.patch");
    let split = parse_split(&patch);
    let value = max_digits(&split);
    let expected_value: Value = expected("expected-max-digits.json");
    assert_eq!(
        serde_json::to_value(value).unwrap(),
        expected_value["value"]
    );
}
