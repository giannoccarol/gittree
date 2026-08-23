//! Test end-to-end del sidecar: processo reale, stdio NDJSON, envelope `{ error }`.

use std::io::{BufRead, BufReader, Write};

use std::process::{Child, Command, Stdio};

use tempfile::TempDir;

struct Sidecar {
    child: Child,
}

impl Sidecar {
    fn spawn() -> Self {
        let child = Command::new(env!("CARGO_BIN_EXE_gittree-sidecar"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("avvio sidecar");
        Self { child }
    }

    fn request(&mut self, line: &str) -> serde_json::Value {
        let stdin = self.child.stdin.as_mut().expect("stdin");
        writeln!(stdin, "{line}").expect("scrittura richiesta");
        stdin.flush().expect("flush richiesta");
        let stdout = self.child.stdout.as_mut().expect("stdout");
        let mut reader = BufReader::new(stdout);
        let mut response = String::new();
        reader.read_line(&mut response).expect("lettura risposta");
        serde_json::from_str(response.trim()).expect("risposta JSON valida")
    }
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn make_repo(dir: &TempDir) -> std::path::PathBuf {
    let repo = dir.path().join("repo");
    std::fs::create_dir_all(&repo).expect("creazione repo");
    let run = |args: &[&str]| {
        let output = Command::new("git")
            .current_dir(&repo)
            .args(["-c", "user.name=Ada", "-c", "user.email=ada@example.com"])
            .args(args)
            .env("GIT_AUTHOR_DATE", "2026-01-02T03:04:05+00:00")
            .env("GIT_COMMITTER_DATE", "2026-01-02T03:04:05+00:00")
            .output()
            .expect("git");
        assert!(output.status.success(), "git {args:?} fallito");
    };
    run(&["init", "-q", "-b", "main"]);
    std::fs::write(repo.join("a.txt"), "uno\ndue\n").expect("file");
    run(&["add", "."]);
    run(&["commit", "-qm", "primo commit"]);
    repo
}

#[test]
fn protocollo_risponde_con_envelope_result_e_error() {
    let dir = TempDir::new().expect("temp");
    let repo = make_repo(&dir);
    let repo_json = serde_json::to_string(&repo).unwrap();

    let mut sidecar = Sidecar::spawn();

    // graph.page: result con commits e refs.
    let response = sidecar.request(&format!(
        "{{\"id\": 7, \"method\": \"graph.page\", \"params\": {{\"repo\": {repo_json}, \"offset\": 0, \"limit\": 10}}}}"
    ));
    assert_eq!(response["id"], 7);
    assert_eq!(response["result"]["commits"][0]["subject"], "primo commit");
    assert!(response.get("error").is_none());

    // status: branch main, clean true.
    let response = sidecar.request(&format!(
        "{{\"id\": 8, \"method\": \"status\", \"params\": {{\"repo\": {repo_json}}}}}"
    ));
    assert_eq!(response["id"], 8);
    assert_eq!(response["result"]["branch"], "main");
    assert_eq!(response["result"]["clean"], true);

    // Metodo sconosciuto: envelope { error }.
    let response = sidecar.request("{\"id\": 9, \"method\": \"nope\", \"params\": {}}");
    assert_eq!(response["id"], 9);
    assert!(
        response["error"]
            .as_str()
            .unwrap_or("")
            .contains("sconosciuto")
    );

    // Repo inesistente: errore con messaggio git.
    let response = sidecar.request(
        "{\"id\": 10, \"method\": \"status\", \"params\": {\"repo\": \"/percorso/assente\"}}",
    );
    assert_eq!(response["id"], 10);
    assert!(!response["error"].as_str().unwrap_or_default().is_empty());

    // Richiesta malformata: errore senza far crashare il processo.
    let response = sidecar.request("questo non è json");
    assert!(
        response["error"]
            .as_str()
            .unwrap_or_default()
            .contains("non valida")
    );

    // Il processo risponde ancora dopo gli errori.
    let response = sidecar.request(&format!(
        "{{\"id\": 11, \"method\": \"diff.working\", \"params\": {{\"repo\": {repo_json}}}}}"
    ));
    assert_eq!(response["id"], 11);
    assert!(response.get("result").is_some());
}
