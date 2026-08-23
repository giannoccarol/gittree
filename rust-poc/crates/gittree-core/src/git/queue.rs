//! Coda seriale per repository: replica la semantica di `repository-queue.mts`
//! (una sola operazione git per repository per volta).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

#[derive(Default)]
pub struct RepoQueues {
    queues: Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>,
}

impl RepoQueues {
    pub fn new() -> Self {
        Self::default()
    }

    fn queue_for(&self, repo: &Path) -> Arc<Mutex<()>> {
        let key = repo.canonicalize().unwrap_or_else(|_| repo.to_path_buf());
        self.queues
            .lock()
            .expect("mappa code non avvelenata")
            .entry(key)
            .or_default()
            .clone()
    }

    /// Esegue `operation` in esclusione mutua sulle altre chiamate con lo stesso repo.
    pub fn run_exclusive<T>(&self, repo: &Path, operation: impl FnOnce() -> T) -> T {
        let queue = self.queue_for(repo);
        let _guard = queue.lock().expect("coda repo non avvelenata");
        operation()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn le_operazioni_sullo_stesso_repo_non_si_intercalano() {
        let queues = RepoQueues::new();
        let events = Mutex::new(Vec::<&'static str>::new());
        let active = AtomicUsize::new(0);

        queues.run_exclusive(Path::new("/repo/a"), || {
            assert_eq!(active.fetch_add(1, Ordering::SeqCst), 0, "sovrapposizione");
            events.lock().unwrap().push("start-1");
            events.lock().unwrap().push("end-1");
            assert_eq!(active.fetch_sub(1, Ordering::SeqCst), 1);
        });
        queues.run_exclusive(Path::new("/repo/a"), || {
            assert_eq!(active.fetch_add(1, Ordering::SeqCst), 0, "sovrapposizione");
            events.lock().unwrap().push("start-2");
            events.lock().unwrap().push("end-2");
            assert_eq!(active.fetch_sub(1, Ordering::SeqCst), 1);
        });

        assert_eq!(
            *events.lock().unwrap(),
            vec!["start-1", "end-1", "start-2", "end-2"]
        );
    }

    #[test]
    fn repo_diversi_usano_code_indipendenti() {
        let queues = RepoQueues::new();
        let first = queues.queue_for(Path::new("/repo/a"));
        let second = queues.queue_for(Path::new("/repo/b"));
        assert!(!Arc::ptr_eq(&first, &second));
        let again = queues.queue_for(Path::new("/repo/a"));
        assert!(Arc::ptr_eq(&first, &again));
    }
}
