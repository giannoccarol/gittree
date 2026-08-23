//! Test del motore Git su repository reali temporanei e deterministici
//! (stesso approccio dei test node:test esistenti).

use std::path::Path;
use std::process::Command;

use gittree_core::git::engine::{GitEngine, GitError};
use gittree_core::git::graph::{get_commit_diff, get_graph_page};
use gittree_core::git::ops::{commit, stage, unstage};
use gittree_core::git::queue::RepoQueues;
use gittree_core::git::status::get_status;
use tempfile::TempDir;

const COMMIT_ENV: [(&str, &str); 6] = [
    ("GIT_AUTHOR_NAME", "Ada Lovelace"),
    ("GIT_AUTHOR_EMAIL", "ada@example.com"),
    ("GIT_COMMITTER_NAME", "Ada Lovelace"),
    ("GIT_COMMITTER_EMAIL", "ada@example.com"),
    ("GIT_AUTHOR_DATE", "2026-01-02T03:04:05+00:00"),
    ("GIT_COMMITTER_DATE", "2026-01-02T03:04:05+00:00"),
];

fn run_git(repo: &Path, args: &[&str]) -> String {
    let mut command = Command::new("git");
    command
        .current_dir(repo)
        .args([
            "-c",
            "user.name=Ada Lovelace",
            "-c",
            "user.email=ada@example.com",
        ])
        .args(args);
    for (key, value) in COMMIT_ENV {
        command.env(key, value);
    }
    let output = command.output().expect("avvio git");
    assert!(
        output.status.success(),
        "git {args:?} fallito: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).into_owned()
}

struct TestRepo {
    _dir: TempDir,
    path: std::path::PathBuf,
}

impl TestRepo {
    fn new() -> Self {
        let dir = TempDir::new().expect("directory temporanea");
        let path = dir.path().join("repo");
        std::fs::create_dir_all(&path).expect("creazione repo");
        run_git(&path, &["init", "-q", "-b", "main"]);
        Self { _dir: dir, path }
    }

    fn write(&self, name: &str, content: &str) {
        std::fs::write(self.path.join(name), content).expect("scrittura file");
    }
}

#[test]
fn grafo_paginato_con_refs_e_head() {
    let repo = TestRepo::new();
    let engine = GitEngine::default();

    // Repo senza commit: pagina vuota senza errore.
    let empty = get_graph_page(&engine, &repo.path, 0, 10).expect("pagina su repo vuoto");
    assert!(empty.commits.is_empty());
    assert!(!empty.has_more);

    repo.write("file.txt", "alpha\nbravo\n");
    run_git(&repo.path, &["add", "."]);
    run_git(&repo.path, &["commit", "-qm", "primo"]);
    repo.write("file.txt", "alpha\nbravo!\n");
    run_git(&repo.path, &["add", "."]);
    run_git(&repo.path, &["commit", "-qm", "secondo"]);

    let head_hash = run_git(&repo.path, &["rev-parse", "HEAD"]);
    let page = get_graph_page(&engine, &repo.path, 0, 10).expect("pagina completa");
    assert_eq!(page.commits.len(), 2);
    assert_eq!(page.commits[0].hash.trim(), head_hash.trim());
    assert_eq!(page.commits[0].subject, "secondo");
    assert_eq!(page.commits[1].subject, "primo");
    assert_eq!(page.commits[1].parents.len(), 0);
    assert_eq!(page.commits[0].parents, vec![page.commits[1].hash.clone()]);
    assert!(!page.has_more);

    let main_ref = page
        .refs
        .iter()
        .find(|reference| reference.full_name == "refs/heads/main")
        .expect("ref main presente");
    assert_eq!(
        gittree_core::git::graph::GraphRefType::Branch,
        main_ref.ref_type
    );
    let head_ref = page
        .refs
        .iter()
        .find(|reference| reference.full_name == "HEAD")
        .expect("HEAD sintetico presente");
    assert_eq!(head_ref.commit.trim(), head_hash.trim());

    // Paginazione: limite 1, seconda pagina senza altri elementi.
    let first = get_graph_page(&engine, &repo.path, 0, 1).expect("prima pagina");
    assert_eq!(first.commits.len(), 1);
    assert!(first.has_more);
    assert_eq!(first.next_offset, 1);
    let second = get_graph_page(&engine, &repo.path, 1, 1).expect("seconda pagina");
    assert_eq!(second.commits.len(), 1);
    assert!(!second.has_more);
}

#[test]
fn status_riflette_stage_e_worktree() {
    let repo = TestRepo::new();
    let engine = GitEngine::default();

    repo.write("tracked.txt", "uno\n");
    run_git(&repo.path, &["add", "."]);
    run_git(&repo.path, &["commit", "-qm", "iniziale"]);

    let clean = get_status(&engine, &repo.path).expect("stato pulito");
    assert!(clean.clean);
    assert_eq!(clean.branch, "main");
    assert!(!clean.detached);

    repo.write("tracked.txt", "due\n");
    repo.write("nuovo.txt", "contenuto\n");
    let dirty = get_status(&engine, &repo.path).expect("stato sporco");
    assert!(!dirty.clean);
    assert!(dirty.files.contains(&"tracked.txt".to_string()));
    assert!(dirty.files.contains(&"nuovo.txt".to_string()));
    assert!(dirty.conflicted.is_empty());

    stage(&engine, &repo.path, &["nuovo.txt".to_string()]).expect("stage");
    let staged = get_status(&engine, &repo.path).expect("dopo stage");
    assert!(!staged.clean);

    unstage(&engine, &repo.path, &["nuovo.txt".to_string()]).expect("unstage");

    // Commit senza nulla di staged: errore atteso.
    assert!(commit(&engine, &repo.path, "vuoto").is_err());

    stage(
        &engine,
        &repo.path,
        &["tracked.txt".to_string(), "nuovo.txt".to_string()],
    )
    .expect("stage finale");
    commit(&engine, &repo.path, "tutto dentro").expect("commit");
    let committed = get_status(&engine, &repo.path).expect("dopo commit");
    assert!(committed.clean, "{committed:?}");
}

#[test]
fn commit_diff_radice_usa_empty_tree() {
    let repo = TestRepo::new();
    let engine = GitEngine::default();

    repo.write("alpha.txt", "alpha\n");
    run_git(&repo.path, &["add", "."]);
    run_git(&repo.path, &["commit", "-qm", "radice"]);

    let hash = run_git(&repo.path, &["rev-parse", "HEAD"]);
    let diff = get_commit_diff(&engine, &repo.path, hash.trim(), None).expect("diff radice");
    assert!(diff.contains("+alpha"), "{diff}");

    repo.write("beta.txt", "beta\n");
    run_git(&repo.path, &["add", "."]);
    run_git(&repo.path, &["commit", "-qm", "secondo"]);
    let second = run_git(&repo.path, &["rev-parse", "HEAD"]);
    let range_diff =
        get_commit_diff(&engine, &repo.path, second.trim(), None).expect("diff secondo");
    assert!(range_diff.contains("+beta"));
    assert!(!range_diff.contains("+alpha"));
}

#[test]
fn coda_esegue_in_esclusiva_per_repo() {
    let queues = std::sync::Arc::new(RepoQueues::new());
    let counter = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let handles: Vec<_> = (0..8)
        .map(|_| {
            let queues = queues.clone();
            let counter = counter.clone();
            std::thread::spawn(move || {
                queues.run_exclusive(Path::new("/repo/condiviso"), || {
                    let current = counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    assert_eq!(current, 0, "accesso concorrente alla stessa coda");
                    std::thread::sleep(std::time::Duration::from_millis(1));
                    counter.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
                });
            })
        })
        .collect();
    for handle in handles {
        handle.join().expect("thread");
    }
}

#[test]
fn errore_git_contiene_stderr() {
    let _repo = TestRepo::new();
    let engine = GitEngine::default();
    let error = get_graph_page(&engine, Path::new("/percorso/inesistente"), 0, 10)
        .expect_err("errore atteso");
    assert!(
        !GitError {
            message: error.message.clone()
        }
        .message
        .is_empty()
    );
}
