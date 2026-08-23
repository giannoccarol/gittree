//! Operazioni di scrittura essenziali: stage, unstage, commit.
//! Equivalente minimo di `repository-operations.mts` per il POC.

use std::path::Path;

use super::engine::{GitEngine, GitError};
use super::graph::{assert_safe_ref, validate_repository_path};

pub fn stage(engine: &GitEngine, repo: &Path, paths: &[String]) -> Result<(), GitError> {
    let validated: Vec<String> = paths
        .iter()
        .map(|path| validate_repository_path(path))
        .collect::<Result<_, _>>()?;
    let mut args = vec!["add".to_string(), "--".to_string()];
    args.extend(validated);
    engine.run(repo, &args).map(|_| ())
}

pub fn unstage(engine: &GitEngine, repo: &Path, paths: &[String]) -> Result<(), GitError> {
    let validated: Vec<String> = paths
        .iter()
        .map(|path| validate_repository_path(path))
        .collect::<Result<_, _>>()?;
    for path in &validated {
        assert_safe_ref(path)?;
    }
    let mut args = vec![
        "reset".to_string(),
        "--quiet".to_string(),
        "HEAD".to_string(),
        "--".to_string(),
    ];
    args.extend(validated);
    engine.run(repo, &args).map(|_| ())
}

pub fn commit(engine: &GitEngine, repo: &Path, message: &str) -> Result<String, GitError> {
    if message.trim().is_empty() {
        return Err(GitError {
            message: "messaggio di commit vuoto".to_string(),
        });
    }
    engine
        .run(
            repo,
            &["commit".to_string(), "-m".to_string(), message.to_string()],
        )
        .map_err(|error| {
            // Con nulla di staged git scrive i dettagli su stdout.
            let detail = if error.message.is_empty() {
                engine
                    .run(repo, &["status".to_string(), "--short".to_string()])
                    .unwrap_or_default()
            } else {
                error.message
            };
            GitError {
                message: format!("Failed to commit: {detail}"),
            }
        })
}
