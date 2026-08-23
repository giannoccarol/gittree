//! Port sperimentale di `repository-history.mts`: pagina grafo e refs.

use std::path::Path;

use serde::Serialize;

use super::engine::{GitEngine, GitError};

const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GraphCommit {
    pub hash: String,
    pub parents: Vec<String>,
    pub subject: String,
    #[serde(rename = "authorName")]
    pub author_name: String,
    #[serde(rename = "authorEmail")]
    pub author_email: String,
    pub date: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GraphRefType {
    Branch,
    Remote,
    Tag,
    Head,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphRef {
    #[serde(rename = "fullName")]
    pub full_name: String,
    #[serde(rename = "shortName")]
    pub short_name: String,
    #[serde(rename = "type")]
    pub ref_type: GraphRefType,
    pub commit: String,
    pub upstream: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphPage {
    pub commits: Vec<GraphCommit>,
    pub refs: Vec<GraphRef>,
    pub next_offset: usize,
    pub has_more: bool,
}

/// Replica `getGraphPage(offset, limit)` con gli stessi argomenti di git.
pub fn get_graph_page(
    engine: &GitEngine,
    repo: &Path,
    offset: usize,
    limit: usize,
) -> Result<GraphPage, GitError> {
    let safe_offset = offset;
    let safe_limit = limit.max(1);
    let args = vec![
        "log".to_string(),
        "--all".to_string(),
        "--topo-order".to_string(),
        "--date-order".to_string(),
        "--parents".to_string(),
        "-z".to_string(),
        format!("--skip={safe_offset}"),
        format!("--max-count={}", safe_limit + 1),
        "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s".to_string(),
    ];
    let raw = match engine.run(repo, &args) {
        Ok(raw) => raw,
        Err(error) => {
            let lower = error.message.to_lowercase();
            if lower.contains("does not have any commits")
                || lower.contains("your current branch")
                    && lower.contains("does not have any commits")
            {
                return Ok(GraphPage {
                    commits: Vec::new(),
                    refs: Vec::new(),
                    next_offset: safe_offset,
                    has_more: false,
                });
            }
            return Err(GitError {
                message: format!("Failed to get graph page: {}", error.message),
            });
        }
    };

    let parsed: Vec<GraphCommit> = raw
        .split('\0')
        .map(|record| record.trim_matches(['\r', '\n']))
        .filter(|record| !record.is_empty())
        .map(|record| {
            let parts: Vec<&str> = record.split('\x1f').collect();
            let field =
                |index: usize| -> String { parts.get(index).copied().unwrap_or("").to_string() };
            let parents: Vec<String> = if parts.len() > 1 && !parts[1].is_empty() {
                parts[1].split_whitespace().map(str::to_string).collect()
            } else {
                Vec::new()
            };
            // Il soggetto puo contenere 0x1f: tutto cio che segue la data viene riunito.
            let subject = parts
                .iter()
                .skip(5)
                .copied()
                .collect::<Vec<&str>>()
                .join("\x1f");
            GraphCommit {
                hash: field(0),
                parents,
                subject,
                author_name: field(2),
                author_email: field(3),
                date: field(4),
            }
        })
        .collect();

    let has_more = parsed.len() > safe_limit;
    let mut commits: Vec<GraphCommit> = parsed.into_iter().take(safe_limit).collect();
    commits.shrink_to_fit();
    let refs = get_graph_refs(engine, repo)?;
    Ok(GraphPage {
        commits,
        refs,
        next_offset: safe_offset + safe_limit.min(usize::MAX - safe_offset),
        has_more,
    })
}

fn ref_type_for(full_name: &str) -> GraphRefType {
    if full_name.starts_with("refs/remotes/") {
        GraphRefType::Remote
    } else if full_name.starts_with("refs/tags/") {
        GraphRefType::Tag
    } else {
        GraphRefType::Branch
    }
}

/// Replica `getGraphRefs()`: heads, remotes, tags piu HEAD sintetico.
pub fn get_graph_refs(engine: &GitEngine, repo: &Path) -> Result<Vec<GraphRef>, GitError> {
    let args = vec![
        "for-each-ref".to_string(),
        "--format=%(refname)\t%(refname:short)\t%(objectname)\t%(upstream:short)".to_string(),
        "refs/heads".to_string(),
        "refs/remotes".to_string(),
        "refs/tags".to_string(),
    ];
    let raw = engine.run(repo, &args)?;
    let mut refs: Vec<GraphRef> = raw
        .lines()
        .filter(|line| !line.is_empty())
        .map(|line| {
            let parts: Vec<&str> = line.split('\t').collect();
            let full_name = parts.first().copied().unwrap_or("").to_string();
            let short_name = parts.get(1).copied().unwrap_or("").to_string();
            let commit = parts.get(2).copied().unwrap_or("").to_string();
            let upstream = parts.get(3).copied().unwrap_or("").to_string();
            GraphRef {
                ref_type: ref_type_for(&full_name),
                full_name,
                short_name,
                commit,
                upstream,
            }
        })
        .filter(|reference| !reference.full_name.ends_with("/HEAD"))
        .collect();

    if let Ok(head_commit) = engine.run(repo, &["rev-parse".to_string(), "HEAD".to_string()]) {
        refs.push(GraphRef {
            full_name: "HEAD".to_string(),
            short_name: "HEAD".to_string(),
            ref_type: GraphRefType::Head,
            commit: head_commit.trim().to_string(),
            upstream: String::new(),
        });
    }
    Ok(refs)
}

/// Replica `getDiff(commitHash, file)` / `getCommitDiff`.
pub fn get_commit_diff(
    engine: &GitEngine,
    repo: &Path,
    hash: &str,
    file: Option<&str>,
) -> Result<String, GitError> {
    let validated = file.map(validate_repository_path).transpose()?;
    let has_parent_args = vec![
        "rev-list".to_string(),
        "--parents".to_string(),
        "-n".to_string(),
        "1".to_string(),
        hash.to_string(),
    ];
    let parents_raw = engine
        .run(repo, &has_parent_args)
        .map_err(|error| GitError {
            message: format!("Failed to get diff: {}", error.message),
        })?;
    let has_parent = parents_raw.split_whitespace().count() > 1;

    let mut args = vec!["diff".to_string(), "--no-ext-diff".to_string()];
    if has_parent {
        args.push(format!("{hash}^..{hash}"));
    } else {
        args.push(format!("{EMPTY_TREE}..{hash}"));
    }
    if let Some(path) = validated {
        args.push("--".to_string());
        args.push(path);
    }
    engine.run(repo, &args).map_err(|error| GitError {
        message: format!("Failed to get diff: {}", error.message),
    })
}

pub fn working_tree_diff(
    engine: &GitEngine,
    repo: &Path,
    file: Option<&str>,
) -> Result<String, GitError> {
    let validated = file.map(validate_repository_path).transpose()?;
    let mut args = vec!["diff".to_string(), "--no-ext-diff".to_string()];
    if let Some(path) = validated {
        args.push("--".to_string());
        args.push(path);
    }
    engine.run(repo, &args).map_err(|error| GitError {
        message: format!("Failed to get diff: {}", error.message),
    })
}

/// Validazione difensiva dei path relativi al repository.
pub fn validate_repository_path(path: &str) -> Result<String, GitError> {
    let candidate = std::path::Path::new(path);
    if path.is_empty()
        || candidate.is_absolute()
        || candidate.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir | std::path::Component::RootDir
            )
        })
    {
        return Err(GitError {
            message: format!("percorso non valido: {path}"),
        });
    }
    Ok(path.to_string())
}

/// Rifiuta ref potenzialmente pericolosi prima di passarli alla CLI.
pub fn assert_safe_ref(reference: &str) -> Result<(), GitError> {
    let invalid = reference.is_empty()
        || reference.starts_with('-')
        || reference.contains("..")
        || reference
            .chars()
            .any(|character| character.is_control() || " ~^:?*[\\".contains(character));
    if invalid {
        return Err(GitError {
            message: format!("ref non valido: {reference}"),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rifiutisce_ref_pericolosi() {
        assert!(assert_safe_ref("-oProxyCommand=x").is_err());
        assert!(assert_safe_ref("main").is_ok());
        assert!(assert_safe_ref("").is_err());
        assert!(assert_safe_ref("a..b").is_err());
    }

    #[test]
    fn rifituisce_path_che_evadono_il_repo() {
        assert!(validate_repository_path("../secrets.txt").is_err());
        assert!(validate_repository_path("/etc/passwd").is_err());
        assert!(validate_repository_path("src/main.rs").is_ok());
    }
}
