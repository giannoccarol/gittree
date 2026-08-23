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

/// Stato di un singolo file secondo porcelain v2.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStatus {
    pub path: String,
    pub index_code: char,
    pub worktree_code: char,
    pub staged: bool,
    pub unstaged: bool,
}

/// Snapshot arricchito per la vista Changes dell'app nativa:
/// split staged/unstaged, upstream e contatori ahead/behind.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusDetail {
    pub clean: bool,
    pub branch: String,
    pub detached: bool,
    pub upstream: String,
    pub ahead: usize,
    pub behind: usize,
    pub staged: Vec<FileStatus>,
    pub unstaged: Vec<FileStatus>,
    pub conflicted: Vec<String>,
}

/// Legge lo stato arricchito con split staged/unstaged e ahead/behind.
pub fn get_status_detail(engine: &GitEngine, repo: &Path) -> Result<StatusDetail, GitError> {
    let args = vec![
        "status".to_string(),
        "--porcelain=v2".to_string(),
        "--branch".to_string(),
        "-z".to_string(),
    ];
    let raw = engine.run(repo, &args)?;

    let mut detail = StatusDetail::default();
    let mut tokens = raw.split('\0').peekable();
    while let Some(token) = tokens.next() {
        if token.is_empty() {
            continue;
        }
        if let Some(head) = token.strip_prefix("# branch.head ") {
            let head = head.trim();
            if head == "(detached)" {
                detail.detached = true;
                detail.branch = "HEAD".to_string();
            } else {
                detail.branch = head.to_string();
            }
        } else if let Some(upstream) = token.strip_prefix("# branch.upstream ") {
            detail.upstream = upstream.trim().to_string();
        } else if let Some(ab) = token.strip_prefix("# branch.ab ") {
            for part in ab.split_whitespace() {
                if let Some(value) = part.strip_prefix('+') {
                    detail.ahead = value.parse().unwrap_or(0);
                } else if let Some(value) = part.strip_prefix('-') {
                    detail.behind = value.parse().unwrap_or(0);
                }
            }
        } else if token.starts_with('#') {
            continue;
        } else {
            let mut fields = token.split(' ');
            match fields.next() {
                Some("1") | Some("2") => {
                    let values: Vec<&str> = fields.collect();
                    // <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
                    let Some(path) = values.get(7) else {
                        continue;
                    };
                    if path.is_empty() {
                        continue;
                    }
                    let mut chars = values[0].chars();
                    let index_code = chars.next().unwrap_or('.');
                    let worktree_code = chars.next().unwrap_or('.');
                    let staged = index_code != '.';
                    let unstaged = worktree_code != '.';
                    let entry = FileStatus {
                        path: path.to_string(),
                        index_code,
                        worktree_code,
                        staged,
                        unstaged,
                    };
                    if staged {
                        detail.staged.push(entry.clone());
                    }
                    if unstaged {
                        detail.unstaged.push(entry);
                    }
                    detail.clean = false;
                    if values[0] == "2" {
                        tokens.next(); // percorso originale del rename
                    }
                }
                Some("u") => {
                    let values: Vec<&str> = fields.collect();
                    let Some(path) = values.get(9) else {
                        continue;
                    };
                    if path.is_empty() {
                        continue;
                    }
                    detail.conflicted.push(path.to_string());
                    detail.unstaged.push(FileStatus {
                        path: path.to_string(),
                        index_code: 'U',
                        worktree_code: 'U',
                        staged: false,
                        unstaged: true,
                    });
                    detail.clean = false;
                }
                Some("?") => {
                    let Some(path) = token.strip_prefix("? ") else {
                        continue;
                    };
                    if path.is_empty() {
                        continue;
                    }
                    detail.unstaged.push(FileStatus {
                        path: path.to_string(),
                        index_code: '?',
                        worktree_code: '?',
                        staged: false,
                        unstaged: true,
                    });
                    detail.clean = false;
                }
                _ => {}
            }
        }
    }
    detail.clean =
        detail.staged.is_empty() && detail.unstaged.is_empty() && detail.conflicted.is_empty();
    Ok(detail)
}

/// Rappresentazione piatta equivalente a `simple-git` status().
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
