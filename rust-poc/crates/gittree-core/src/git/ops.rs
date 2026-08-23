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

/// Opzioni del composer di commit.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CommitOptions {
    pub amend: bool,
    pub signoff: bool,
}

pub fn commit(engine: &GitEngine, repo: &Path, message: &str) -> Result<String, GitError> {
    commit_with_options(engine, repo, message, CommitOptions::default())
}

pub fn commit_with_options(
    engine: &GitEngine,
    repo: &Path,
    message: &str,
    options: CommitOptions,
) -> Result<String, GitError> {
    if message.trim().is_empty() {
        return Err(GitError {
            message: "messaggio di commit vuoto".to_string(),
        });
    }
    let mut args = vec!["commit".to_string(), "-m".to_string(), message.to_string()];
    if options.amend {
        args.push("--amend".to_string());
    }
    if options.signoff {
        args.push("-s".to_string());
    }
    engine.run(repo, &args).map_err(|error| {
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

/// Passa al branch (o ref) indicato dopo validazione difensiva.
pub fn checkout(engine: &GitEngine, repo: &Path, reference: &str) -> Result<(), GitError> {
    assert_safe_ref(reference)?;
    engine
        .run(
            repo,
            &[
                "checkout".to_string(),
                "--quiet".to_string(),
                reference.to_string(),
            ],
        )
        .map(|_| ())
}

/// Crea un branch senza spostarsi; `start_point` opzionale validato come ref.
pub fn create_branch(
    engine: &GitEngine,
    repo: &Path,
    name: &str,
    start_point: Option<&str>,
) -> Result<(), GitError> {
    assert_safe_ref(name)?;
    let mut args = vec!["branch".to_string(), name.to_string()];
    if let Some(start) = start_point {
        assert_safe_ref(start)?;
        args.push(start.to_string());
    }
    engine.run(repo, &args).map(|_| ())
}

/// Elimina un branch locale (`-d`, o `-D` se `force`).
pub fn delete_branch(
    engine: &GitEngine,
    repo: &Path,
    name: &str,
    force: bool,
) -> Result<(), GitError> {
    assert_safe_ref(name)?;
    let flag = if force { "-D" } else { "-d" };
    engine
        .run(
            repo,
            &["branch".to_string(), flag.to_string(), name.to_string()],
        )
        .map(|_| ())
}

/// Scarta le modifiche non in stage dei path indicati (`checkout -- <path>`).
pub fn discard(engine: &GitEngine, repo: &Path, paths: &[String]) -> Result<(), GitError> {
    let validated: Vec<String> = paths
        .iter()
        .map(|path| validate_repository_path(path))
        .collect::<Result<_, _>>()?;
    if validated.is_empty() {
        return Ok(());
    }
    let mut args = vec!["checkout".to_string(), "--".to_string()];
    args.extend(validated);
    engine.run(repo, &args).map(|_| ())
}

fn run_remote(engine: &GitEngine, repo: &Path, args: Vec<String>) -> Result<String, GitError> {
    engine.run(repo, &args)
}

/// Scarica tutti i remote con prune; nessun merge sul working tree.
pub fn fetch_all(engine: &GitEngine, repo: &Path) -> Result<String, GitError> {
    run_remote(
        engine,
        repo,
        vec![
            "fetch".to_string(),
            "--all".to_string(),
            "--prune".to_string(),
        ],
    )
}

/// Avanza il branch corrente sul suo upstream senza storico divergente.
pub fn pull(engine: &GitEngine, repo: &Path) -> Result<String, GitError> {
    run_remote(
        engine,
        repo,
        vec!["pull".to_string(), "--ff-only".to_string()],
    )
}

/// Invia il branch corrente al suo upstream impostandolo se manca.
pub fn push(engine: &GitEngine, repo: &Path) -> Result<String, GitError> {
    run_remote(engine, repo, vec!["push".to_string(), "-u".to_string()])
}
