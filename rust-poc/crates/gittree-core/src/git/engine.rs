//! Motore Git del POC: esecuzione processi e tipi di errore condivisi.

use std::path::Path;
use std::process::Command;

#[derive(Debug, Clone)]
pub struct GitError {
    pub message: String,
}

impl std::fmt::Display for GitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for GitError {}

/// Punto di ingresso unico per invocare il binario git su un repository.
#[derive(Debug, Clone)]
pub struct GitEngine {
    pub git_path: String,
}

impl Default for GitEngine {
    fn default() -> Self {
        Self {
            git_path: "git".to_string(),
        }
    }
}

impl GitEngine {
    /// Esegue `git <args>` dentro `repo`; stdout come stringa, stderr nel messaggio d'errore.
    pub fn run(&self, repo: &Path, args: &[String]) -> Result<String, GitError> {
        let output = Command::new(&self.git_path)
            .current_dir(repo)
            .args(args)
            .output()
            .map_err(|error| GitError {
                message: format!("impossibile avviare git: {error}"),
            })?;
        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).into_owned())
        } else {
            Err(GitError {
                message: String::from_utf8_lossy(&output.stderr).trim().to_string(),
            })
        }
    }
}
