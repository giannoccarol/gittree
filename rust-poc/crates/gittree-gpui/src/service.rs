//! Facade delle operazioni Git per l'app GPUI: un solo `GitEngine`
//! condiviso, scritture serializzate dalla coda per-repository.
//! Tutti i metodi sono bloccanti e vanno invocati da `background_spawn`.

use std::path::{Path, PathBuf};

use gittree_core::git::engine::{GitEngine, GitError};
use gittree_core::git::graph::{GraphPage, get_commit_diff, get_graph_page, head_diff};
use gittree_core::git::ops::{
    CommitOptions, checkout, commit_with_options, create_branch, delete_branch, discard, fetch_all,
    pull, push, stage, unstage,
};
use gittree_core::git::queue::RepoQueues;
use gittree_core::git::status::{StatusDetail, get_status_detail};

/// Pagina grafo + stato del working tree, caricati insieme al refresh.
pub struct Snapshot {
    pub page: GraphPage,
    pub status: Option<StatusDetail>,
    pub status_error: Option<String>,
}

pub struct GitService {
    engine: GitEngine,
    repo: PathBuf,
    queues: std::sync::Arc<RepoQueues>,
}

impl GitService {
    pub fn new(repo: PathBuf) -> Self {
        Self {
            engine: GitEngine::default(),
            repo,
            queues: std::sync::Arc::new(RepoQueues::new()),
        }
    }

    fn read<T>(
        &self,
        operation: impl FnOnce(&GitEngine, &Path) -> Result<T, GitError> + Send + 'static,
    ) -> Result<T, String>
    where
        T: Send + 'static,
    {
        operation(&self.engine, &self.repo).map_err(|error| error.message)
    }

    fn write<T>(
        &self,
        operation: impl FnOnce(&GitEngine, &Path) -> Result<T, GitError> + Send + 'static,
    ) -> Result<T, String>
    where
        T: Send + 'static,
    {
        let engine = self.engine.clone();
        let repo = self.repo.clone();
        self.queues
            .run_exclusive(&repo, || operation(&engine, &repo))
            .map_err(|error| error.message)
    }

    /// Carica pagina grafo e stato in una sola chiamata background.
    pub fn snapshot(&self, limit: usize) -> Result<Snapshot, String> {
        let page = self.read(move |engine, repo| get_graph_page(engine, repo, 0, limit))?;
        let status = match self.read(get_status_detail) {
            Ok(detail) => Snapshot {
                page,
                status: Some(detail),
                status_error: None,
            },
            Err(message) => Snapshot {
                page,
                status: None,
                status_error: Some(message),
            },
        };
        Ok(status)
    }

    pub fn commit_diff(&self, hash: &str, file: Option<&str>) -> Result<String, String> {
        let hash = hash.to_string();
        let file = file.map(str::to_string);
        self.read(move |engine, repo| get_commit_diff(engine, repo, &hash, file.as_deref()))
    }

    /// Diff combinato (index + worktree) di un file contro HEAD.
    pub fn file_diff(&self, file: &str) -> Result<String, String> {
        let file = file.to_string();
        self.read(move |engine, repo| head_diff(engine, repo, &file))
    }

    pub fn stage(&self, paths: Vec<String>) -> Result<(), String> {
        self.write(move |engine, repo| stage(engine, repo, &paths))
    }

    pub fn unstage(&self, paths: Vec<String>) -> Result<(), String> {
        self.write(move |engine, repo| unstage(engine, repo, &paths))
    }

    pub fn discard(&self, paths: Vec<String>) -> Result<(), String> {
        self.write(move |engine, repo| discard(engine, repo, &paths))
    }

    pub fn commit(&self, message: String, options: CommitOptions) -> Result<String, String> {
        self.write(move |engine, repo| commit_with_options(engine, repo, &message, options))
    }

    pub fn checkout(&self, reference: String) -> Result<(), String> {
        self.write(move |engine, repo| checkout(engine, repo, &reference))
    }

    pub fn create_branch(&self, name: String, start_point: Option<String>) -> Result<(), String> {
        self.write(move |engine, repo| create_branch(engine, repo, &name, start_point.as_deref()))
    }

    #[allow(dead_code)]
    pub fn delete_branch(&self, name: String, force: bool) -> Result<(), String> {
        self.write(move |engine, repo| delete_branch(engine, repo, &name, force))
    }

    pub fn fetch(&self) -> Result<String, String> {
        self.write(fetch_all)
    }

    pub fn pull(&self) -> Result<String, String> {
        self.write(pull)
    }

    pub fn push(&self) -> Result<String, String> {
        self.write(push)
    }
}
