//! Test delle operazioni di scrittura estese e dello stato dettagliato
//! su repository reali temporanei, incluso un remote bare locale.

use std::path::Path;
use std::process::Command;

use gittree_core::git::engine::GitEngine;
use gittree_core::git::graph::head_diff;
use gittree_core::git::ops::{
    checkout, commit, create_branch, delete_branch, discard, fetch_all, pull, push, stage,
};
use gittree_core::git::status::{FileStatus, get_status_detail};
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

    fn initial_commit(&self) {
        self.write("base.txt", "base\n");
        run_git(&self.path, &["add", "."]);
        run_git(&self.path, &["commit", "-qm", "iniziale"]);
    }
}

fn find<'a>(files: &'a [FileStatus], path: &str) -> &'a FileStatus {
    files
        .iter()
        .find(|file| file.path == path)
        .unwrap_or_else(|| panic!("file {path} assente in {files:?}"))
}

#[test]
fn status_detail_separa_staged_e_unstaged() {
    let repo = TestRepo::new();
    let engine = GitEngine::default();
    repo.initial_commit();

    let clean = get_status_detail(&engine, &repo.path).expect("stato pulito");
    assert!(clean.clean);
    assert_eq!(clean.branch, "main");
    assert!(clean.staged.is_empty());
    assert!(clean.unstaged.is_empty());
    assert_eq!(clean.ahead, 0);
    assert_eq!(clean.behind, 0);

    repo.write("base.txt", "modificato\n");
    let unstaged_only = get_status_detail(&engine, &repo.path).expect("solo worktree");
    assert!(unstaged_only.staged.is_empty());
    let entry = find(&unstaged_only.unstaged, "base.txt");
    assert!(!entry.staged);
    assert!(entry.unstaged);
    assert_eq!(entry.index_code, '.');
    assert_eq!(entry.worktree_code, 'M');

    stage(&engine, &repo.path, &["base.txt".to_string()]).expect("stage");
    repo.write("nuovo.txt", "contenuto\n");
    let mixed = get_status_detail(&engine, &repo.path).expect("misto");
    let staged_entry = find(&mixed.staged, "base.txt");
    assert!(staged_entry.staged);
    assert_eq!(staged_entry.index_code, 'M');
    // Contenuto identico in worktree: solo staged, nessuna voce unstaged.
    assert!(!mixed.unstaged.iter().any(|file| file.path == "base.txt"));
    let untracked = find(&mixed.unstaged, "nuovo.txt");
    assert_eq!(untracked.index_code, '?');
    assert!(!untracked.staged);

    // Untracked non finisce tra gli staged.
    assert!(!mixed.staged.iter().any(|file| file.path == "nuovo.txt"));
}

#[test]
fn checkout_create_delete_branch() {
    let repo = TestRepo::new();
    let engine = GitEngine::default();
    repo.initial_commit();

    create_branch(&engine, &repo.path, "feature/x", None).expect("creazione branch");
    let before = get_status_detail(&engine, &repo.path).expect("stato");
    assert_eq!(
        before.branch, "main",
        "create_branch non deve spostare HEAD"
    );

    checkout(&engine, &repo.path, "feature/x").expect("checkout");
    let after = get_status_detail(&engine, &repo.path).expect("stato dopo checkout");
    assert_eq!(after.branch, "feature/x");

    // Ref pericolosi rifiutati senza invocare git.
    assert!(checkout(&engine, &repo.path, "-oProxyCommand=x").is_err());
    assert!(create_branch(&engine, &repo.path, "a..b", None).is_err());

    delete_branch(&engine, &repo.path, "feature/x", true)
        .expect_err("impossibile eliminare il branch corrente");

    checkout(&engine, &repo.path, "main").expect("ritorno su main");
    delete_branch(&engine, &repo.path, "feature/x", false).expect("eliminazione");
    let detail = get_status_detail(&engine, &repo.path).expect("stato finale");
    assert_eq!(detail.branch, "main");
}

#[test]
fn discard_ripristina_il_worktree() {
    let repo = TestRepo::new();
    let engine = GitEngine::default();
    repo.initial_commit();

    repo.write("base.txt", "sporco\n");
    discard(&engine, &repo.path, &["base.txt".to_string()]).expect("discard");
    let detail = get_status_detail(&engine, &repo.path).expect("stato dopo discard");
    assert!(detail.clean, "{detail:?}");
    assert_eq!(
        std::fs::read_to_string(repo.path.join("base.txt")).expect("lettura"),
        "base\n"
    );

    // Path che evadono il repository rifiutati.
    assert!(discard(&engine, &repo.path, &["../fuga".to_string()]).is_err());
    // Lista vuota: no-op riuscita.
    discard(&engine, &repo.path, &[]).expect("discard vuoto");
}

#[test]
fn fetch_pull_push_con_remote_bare_locale() {
    let engine = GitEngine::default();
    let dir = TempDir::new().expect("directory temporanea");
    let origin_path = dir.path().join("origin.git");
    std::fs::create_dir_all(&origin_path).expect("creazione bare");
    run_git(&origin_path, &["init", "-q", "--bare", "-b", "main"]);

    let upstream = TestRepo::new();
    upstream.initial_commit();
    run_git(
        &upstream.path,
        &["push", "-q", &format!("{}", origin_path.display()), "main"],
    );

    let repo = TestRepo::new();
    run_git(
        &repo.path,
        &[
            "remote",
            "add",
            "origin",
            origin_path.to_str().expect("percorso utf8"),
        ],
    );
    run_git(&repo.path, &["fetch", "-q", "origin"]);
    run_git(&repo.path, &["checkout", "-q", "-B", "main", "origin/main"]);

    fetch_all(&engine, &repo.path).expect("fetch");

    // Il remote ha un commit in piu: behind 1.
    upstream.write("avanti.txt", "avanti\n");
    run_git(&upstream.path, &["add", "."]);
    run_git(&upstream.path, &["commit", "-qm", "avanti"]);
    run_git(
        &upstream.path,
        &["push", "-q", &format!("{}", origin_path.display()), "main"],
    );
    fetch_all(&engine, &repo.path).expect("secondo fetch");
    let behind = get_status_detail(&engine, &repo.path).expect("stato dietro");
    assert_eq!(behind.behind, 1, "{behind:?}");

    pull(&engine, &repo.path).expect("pull ff-only");
    let synced = get_status_detail(&engine, &repo.path).expect("stato sincronizzato");
    assert_eq!(synced.ahead, 0);
    assert_eq!(synced.behind, 0);
    assert!(repo.path.join("avanti.txt").exists());

    // Commit locale in avanzamento rispetto al remote.
    repo.write("locale.txt", "locale\n");
    run_git(&repo.path, &["add", "."]);
    commit(&engine, &repo.path, "locale avanti").expect("commit locale");
    let ahead = get_status_detail(&engine, &repo.path).expect("stato avanti");
    assert_eq!(ahead.ahead, 1, "{ahead:?}");
    assert_eq!(ahead.upstream, "origin/main");

    push(&engine, &repo.path).expect("push");
    fetch_all(&engine, &repo.path).expect("fetch dopo push");
    let pushed = get_status_detail(&engine, &repo.path).expect("stato dopo push");
    assert_eq!(pushed.ahead, 0, "{pushed:?}");
}

#[test]
fn head_diff_combina_index_e_worktree() {
    let repo = TestRepo::new();
    let engine = GitEngine::default();
    repo.initial_commit();

    // Solo worktree.
    repo.write("base.txt", "modificato\n");
    let diff = head_diff(&engine, &repo.path, "base.txt").expect("diff worktree");
    assert!(diff.contains("+modificato"), "{diff}");

    // Anche un file nuovo in stage compare rispetto a HEAD.
    repo.write("nuovo.txt", "contenuto\n");
    stage(&engine, &repo.path, &["nuovo.txt".to_string()]).expect("stage");
    let diff = head_diff(&engine, &repo.path, "nuovo.txt").expect("diff staged");
    assert!(diff.contains("+contenuto"), "{diff}");

    // Pulito: nessun output.
    discard(&engine, &repo.path, &["base.txt".to_string()]).expect("discard");
    let empty = head_diff(&engine, &repo.path, "base.txt").expect("diff vuoto");
    assert!(empty.trim().is_empty(), "{empty}");
}
