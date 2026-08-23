//! Snapshot di stato del working tree, equivalente funzionale all'uso
//! di `simple-git` `status()` in `repository-operations.mts`.

use std::path::Path;

use serde::Serialize;

use super::engine::{GitEngine, GitError};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusSnapshot {
    pub clean: bool,
    pub branch: String,
    pub detached: bool,
    pub files: Vec<String>,
    pub conflicted: Vec<String>,
}

/// Legge lo stato con `status --porcelain=v2 --branch -z`.
pub fn get_status(engine: &GitEngine, repo: &Path) -> Result<StatusSnapshot, GitError> {
    let args = vec![
        "status".to_string(),
        "--porcelain=v2".to_string(),
        "--branch".to_string(),
        "-z".to_string(),
    ];
    let raw = engine.run(repo, &args)?;

    let mut snapshot = StatusSnapshot {
        clean: true,
        branch: String::new(),
        detached: false,
        files: Vec::new(),
        conflicted: Vec::new(),
    };

    // Con -z ogni record termina con NUL; i rename ("2") portano dopo
    // un secondo campo terminato a NUL con il percorso originale.
    let tokens: Vec<&str> = raw.split('\0').collect();
    let mut index = 0;
    while index < tokens.len() {
        let token = tokens[index];
        index += 1;
        if token.is_empty() || token.starts_with('#') && !token.starts_with("# branch.head ") {
            continue;
        }
        if let Some(head) = token.strip_prefix("# branch.head ") {
            if head.trim() == "(detached)" {
                snapshot.detached = true;
                snapshot.branch = "HEAD".to_string();
            } else {
                snapshot.branch = head.trim().to_string();
            }
            continue;
        }
        let mut fields = token.split(' ');
        match fields.next() {
            Some("1") | Some("2") => {
                let values: Vec<&str> = fields.collect();
                // <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
                if values.len() < 8 {
                    continue;
                }
                let xy = values[0];
                let path = values[7];
                if path.is_empty() {
                    continue;
                }
                snapshot.files.push(path.to_string());
                if xy.as_bytes().first() != Some(&b'.') || xy.as_bytes().get(1) != Some(&b'.') {
                    snapshot.clean = false;
                }
                if Some("2") == token.split(' ').next() {
                    index += 1; // salta il percorso originale del rename
                }
            }
            Some("u") => {
                let values: Vec<&str> = fields.collect();
                // <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
                let Some(path) = values.get(9) else {
                    continue;
                };
                if path.is_empty() {
                    continue;
                }
                snapshot.files.push(path.to_string());
                snapshot.conflicted.push(path.to_string());
                snapshot.clean = false;
            }
            Some("?") => {
                let path = token.strip_prefix("? ").unwrap_or("");
                if !path.is_empty() {
                    snapshot.files.push(path.to_string());
                    snapshot.clean = false;
                }
            }
            _ => {}
        }
    }
    Ok(snapshot)
}
