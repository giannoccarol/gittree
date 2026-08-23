//! Port di `src/main/git/blame-parser.mts` (comportamento identico).

use regex::Regex;
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameRow {
    pub hash: String,
    pub original_line: i64,
    pub final_line: i64,
    pub author: String,
    pub summary: String,
}

fn to_i64(captures: &regex::Captures, index: usize) -> i64 {
    captures
        .get(index)
        .and_then(|m| m.as_str().parse::<i64>().ok())
        .unwrap_or(0)
}

/// Replica `parseBlamePorcelain(text)`.
pub fn parse_blame_porcelain(text: &str) -> Vec<BlameRow> {
    let hash_re = Regex::new(r"^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$").expect("static regex");
    let author_re = Regex::new(r"^author (.*)$").expect("static regex");
    let summary_re = Regex::new(r"^summary (.*)$").expect("static regex");

    let mut rows: Vec<BlameRow> = Vec::new();
    // str::lines() equivale allo split /\r?\n/ ignorando la coda vuota finale,
    // che nel port TS non produrrebbe alcun effetto.
    for line in text.lines() {
        if let Some(c) = hash_re.captures(line) {
            rows.push(BlameRow {
                hash: c[1].to_string(),
                original_line: to_i64(&c, 2),
                final_line: to_i64(&c, 3),
                author: String::new(),
                summary: String::new(),
            });
            continue;
        }
        let Some(current) = rows.last_mut() else {
            continue;
        };
        if line.starts_with('\t') {
            continue;
        }
        if let Some(c) = author_re.captures(line) {
            current.author = c[1].to_string();
            continue;
        }
        if let Some(c) = summary_re.captures(line) {
            current.summary = c[1].to_string();
        }
    }
    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn testo_vuoto_non_produce_righe() {
        assert!(parse_blame_porcelain("").is_empty());
    }

    #[test]
    fn righe_contenuto_tabulate_ignorate() {
        let text = concat!(
            "0123456789abcdef0123456789abcdef01234567 1 1 1\n",
            "author Ada\n",
            "summary add\n",
            "\tprima riga\n",
            "\tseconda riga\n"
        );
        let rows = parse_blame_porcelain(text);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].author, "Ada");
        assert_eq!(rows[0].summary, "add");
    }

    #[test]
    fn metadati_prima_del_primo_hash_ignorati() {
        let rows = parse_blame_porcelain("author Orfano\nsummary senza hash\n");
        assert!(rows.is_empty());
    }
}
