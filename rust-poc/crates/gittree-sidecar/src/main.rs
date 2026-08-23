//! Sidecar stdio del POC: protocollo NDJSON con envelope `{ error }`
//! compatibile con lo stile IPC di GitTree.
//!
//! Richiesta:  {"id": 1, "method": "graph.page", "params": {"repo": "/...", "offset": 0, "limit": 500}}
//! Risposta:   {"id": 1, "result": {...}} | {"id": 1, "error": "messaggio"}

use std::io::{BufRead, Write};
use std::path::PathBuf;

use gittree_core::git::engine::GitEngine;
use gittree_core::git::{graph, ops, status};
use serde_json::{Value, json};

fn require_repo(params: &Value) -> Result<PathBuf, String> {
    params
        .get("repo")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .ok_or_else(|| "parametro 'repo' mancante".to_string())
}

fn optional_file(params: &Value) -> Result<Option<String>, String> {
    match params.get("file") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(path)) => Ok(Some(path.clone())),
        Some(other) => Err(format!("parametro 'file' non valido: {other}")),
    }
}

fn string_array(params: &Value, key: &str) -> Result<Vec<String>, String> {
    let values = params
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("parametro '{key}' mancante"))?;
    Ok(values
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect())
}

fn handle(engine: &GitEngine, method: &str, params: &Value) -> Result<Value, String> {
    match method {
        "graph.page" => {
            let repo = require_repo(params)?;
            let offset = params.get("offset").and_then(Value::as_u64).unwrap_or(0);
            let limit = params.get("limit").and_then(Value::as_u64).unwrap_or(500);
            let page = graph::get_graph_page(
                engine,
                &repo,
                usize::try_from(offset).unwrap_or(usize::MAX),
                usize::try_from(limit).unwrap_or(500),
            )
            .map_err(|error| error.message)?;
            serde_json::to_value(page).map_err(|error| error.to_string())
        }
        "status" => {
            let repo = require_repo(params)?;
            let snapshot = status::get_status(engine, &repo).map_err(|error| error.message)?;
            serde_json::to_value(snapshot).map_err(|error| error.to_string())
        }
        "diff.working" => {
            let repo = require_repo(params)?;
            let file = optional_file(params)?;
            graph::working_tree_diff(engine, &repo, file.as_deref())
                .map(Value::String)
                .map_err(|error| error.message)
        }
        "diff.commit" => {
            let repo = require_repo(params)?;
            let hash = params
                .get("hash")
                .and_then(Value::as_str)
                .ok_or_else(|| "parametro 'hash' mancante".to_string())?;
            graph::assert_safe_ref(hash).map_err(|error| error.message)?;
            let file = optional_file(params)?;
            graph::get_commit_diff(engine, &repo, hash, file.as_deref())
                .map(Value::String)
                .map_err(|error| error.message)
        }
        "stage" => {
            let repo = require_repo(params)?;
            ops::stage(engine, &repo, &string_array(params, "paths")?)
                .map(|_| Value::Null)
                .map_err(|error| error.message)
        }
        "unstage" => {
            let repo = require_repo(params)?;
            ops::unstage(engine, &repo, &string_array(params, "paths")?)
                .map(|_| Value::Null)
                .map_err(|error| error.message)
        }
        "commit" => {
            let repo = require_repo(params)?;
            let message = params
                .get("message")
                .and_then(Value::as_str)
                .ok_or_else(|| "parametro 'message' mancante".to_string())?;
            ops::commit(engine, &repo, message)
                .map(Value::String)
                .map_err(|error| error.message)
        }
        _ => Err(format!("metodo sconosciuto: {method}")),
    }
}

fn respond(engine: &GitEngine, line: &str) -> Value {
    let request = match serde_json::from_str::<Value>(line) {
        Ok(value) => value,
        Err(error) => {
            return json!({ "id": null, "error": format!("richiesta non valida: {error}") });
        }
    };
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let method = request.get("method").and_then(Value::as_str);
    let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
    match method {
        Some(method) => match handle(engine, method, &params) {
            Ok(result) => json!({ "id": id, "result": result }),
            Err(error) => json!({ "id": id, "error": error }),
        },
        None => json!({ "id": id, "error": "campo 'method' mancante" }),
    }
}

fn main() {
    let engine = GitEngine::default();
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let response = respond(&engine, &line);
        writeln!(out, "{response}").expect("scrittura stdout");
        out.flush().expect("flush stdout");
    }
}
