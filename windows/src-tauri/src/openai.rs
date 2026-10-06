// ChatGPT chat — the same job as claude.rs, against OpenAI's Responses API.
//
// History lives in OpenAI's own message shape (see `Chat::openai_*`), so
// switching provider in the settings never mixes two formats. As in claude.rs,
// the API key and any file bytes stay on the Rust side.
//
// Not included, unlike the Claude chat: web search.

use serde_json::{json, Value};

use crate::claude::{base64_for, Chat, ChatContext, ChatReply};
use crate::secrets;

const ENDPOINT: &str = "https://api.openai.com/v1/responses";

/// Changeable in the settings window: OpenAI renames models faster than this
/// app ships, and a wrong name comes back from the API as a readable error.
pub const DEFAULT_MODEL: &str = "gpt-5";

/// Reasoning models count their thinking against this too, so it is generous.
const MAX_OUTPUT_TOKENS: u32 = 8192;
/// Text and code files are inlined; anything larger is skipped, as in claude.rs.
const MAX_INLINE_TEXT: u64 = 200_000;

const SYSTEM_PROMPT: &str = "You are Mochi, a personal AI assistant living at the top of the user's screen. \
You can help with anything — research, coding, recommendations, tasks, questions. \
Respond in the user's language. Be thorough and complete — use as much detail as the task requires. \
No markdown formatting (no **, no ##, no bullet dashes). Use plain text with line breaks.";

/// One chat turn. Returns the assistant's text, or a message the island shows
/// in the note view.
pub async fn send(
    chat: &Chat,
    model: &str,
    query: String,
    context: Option<ChatContext>,
) -> Result<ChatReply, String> {
    let key = secrets::get("openai-api-key")
        .ok_or_else(|| "OpenAI-API-Schlüssel fehlt. Öffne die Einstellungen.".to_string())?;

    // File / window context rides along with the first message only, like in
    // claude.rs.
    let content = user_content(chat.openai_is_empty(), &query, context.as_ref());
    chat.openai_push(json!({ "role": "user", "content": content }));

    let body = request_body(model, chat.openai_snapshot());
    match call(ENDPOINT, &key, &body).await.and_then(|r| reply_text(&r)) {
        Ok(text) => {
            chat.openai_push(json!({ "role": "assistant", "content": text }));
            Ok(ChatReply { text })
        }
        Err(err) => {
            chat.openai_pop(); // keep the history consistent with what the model saw
            Err(err)
        }
    }
}

fn request_body(model: &str, input: Vec<Value>) -> Value {
    let model = model.trim();
    json!({
        "model": if model.is_empty() { DEFAULT_MODEL } else { model },
        "instructions": SYSTEM_PROMPT,
        "input": input,
        "max_output_tokens": MAX_OUTPUT_TOKENS,
        // The whole history is sent every turn; nothing needs to live on
        // OpenAI's side.
        "store": false,
    })
}

fn text_part(text: impl Into<String>) -> Value {
    json!({ "type": "input_text", "text": text.into() })
}

fn user_content(first_turn: bool, query: &str, context: Option<&ChatContext>) -> Value {
    let mut parts: Vec<Value> = Vec::new();
    if first_turn {
        match context {
            Some(ChatContext::File { name, path }) => {
                if let Some(part) = file_part(name, path) {
                    parts.push(part);
                }
                parts.push(text_part(format!("File: {name}")));
            }
            Some(ChatContext::Window { app_name, title, url }) => {
                let mut text = format!("Context — App: {app_name}, Window: {title}");
                if let Some(url) = url {
                    text.push_str(&format!(", URL: {url}"));
                }
                parts.push(text_part(text));
            }
            None => {}
        }
    }
    parts.push(text_part(query));
    Value::Array(parts)
}

/// PDF → input_file, image → input_image, text/code → inline text.
fn file_part(name: &str, path: &str) -> Option<Value> {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let image = match ext.as_str() {
        "jpg" | "jpeg" => Some("image/jpeg"),
        "png" => Some("image/png"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    };
    if let Some(media) = image {
        let bytes = std::fs::read(path).ok()?;
        return Some(json!({
            "type": "input_image",
            "image_url": format!("data:{media};base64,{}", base64_for(&bytes)),
        }));
    }
    if ext == "pdf" {
        let bytes = std::fs::read(path).ok()?;
        return Some(json!({
            "type": "input_file",
            "filename": name,
            "file_data": format!("data:application/pdf;base64,{}", base64_for(&bytes)),
        }));
    }

    let len = std::fs::metadata(path).ok()?.len();
    if len > MAX_INLINE_TEXT {
        return None;
    }
    let text = std::fs::read_to_string(path).ok()?;
    Some(text_part(format!("File contents:\n{text}")))
}

/// The assistant's text out of a Responses API reply.
fn reply_text(response: &Value) -> Result<String, String> {
    let status = response.get("status").and_then(Value::as_str).unwrap_or("");
    if status == "failed" {
        let why = response
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("unbekannter Fehler");
        return Err(format!("OpenAI-Antwort fehlgeschlagen: {why}"));
    }

    let Some(items) = response.get("output").and_then(Value::as_array) else {
        return Err("Unerwartete Antwort der API.".into());
    };

    let mut texts: Vec<&str> = Vec::new();
    let mut refusal: Option<&str> = None;
    for item in items.iter().filter(|i| i.get("type").and_then(Value::as_str) == Some("message")) {
        let Some(parts) = item.get("content").and_then(Value::as_array) else { continue };
        for part in parts {
            match part.get("type").and_then(Value::as_str) {
                Some("output_text") => {
                    if let Some(t) = part.get("text").and_then(Value::as_str) {
                        texts.push(t);
                    }
                }
                Some("refusal") => refusal = part.get("refusal").and_then(Value::as_str),
                _ => {}
            }
        }
    }

    let text = texts.join("\n").trim().to_string();
    if !text.is_empty() {
        return Ok(text);
    }
    if let Some(why) = refusal {
        return Err(format!("OpenAI hat diese Anfrage abgelehnt: {why}"));
    }
    if status == "incomplete" {
        return Err("Die Antwort wurde abgeschnitten, bevor Text entstand (Token-Limit). Versuche ein kleineres Modell oder eine kürzere Frage.".into());
    }
    Err("Die Antwort enthielt keinen Text.".into())
}

async fn call(endpoint: &str, key: &str, body: &Value) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .post(endpoint)
        .bearer_auth(key)
        .json(body)
        .send()
        .await
        .map_err(|e| format!("Netzwerkfehler: {e}"))?;

    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        // Surface the API's own message, which is what makes a bad key or a
        // misspelt model name obvious.
        let detail = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| {
                v.get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_else(|| text.chars().take(200).collect());
        return Err(format!("OpenAI-API {status}: {detail}"));
    }
    serde_json::from_str(&text).map_err(|e| format!("Ungültige API-Antwort: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    /// Answers one HTTP request on a local port and returns what it received.
    fn serve_once(status_line: &str, body: &str) -> (String, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/v1/responses", listener.local_addr().unwrap());
        let response = format!(
            "HTTP/1.1 {status_line}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut received = Vec::new();
            let mut buf = [0u8; 4096];
            loop {
                let n = stream.read(&mut buf).unwrap();
                received.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&received);
                if let Some(split) = text.find("\r\n\r\n") {
                    let length = text[..split]
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .and_then(|v| v.trim().parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if received.len() >= split + 4 + length {
                        break;
                    }
                }
                if n == 0 {
                    break;
                }
            }
            stream.write_all(response.as_bytes()).unwrap();
            String::from_utf8_lossy(&received).to_string()
        });
        (url, handle)
    }

    const GOOD_REPLY: &str = r#"{"id":"resp_1","status":"completed","output":[
        {"type":"reasoning","summary":[]},
        {"type":"message","role":"assistant","content":[
            {"type":"output_text","text":"Hallo "},{"type":"output_text","text":"Welt"}]}]}"#;

    #[test]
    fn request_body_names_model_instructions_and_does_not_store() {
        let body = request_body("  gpt-test  ", vec![json!({"role":"user","content":"hi"})]);
        assert_eq!(body["model"], "gpt-test");
        assert_eq!(body["store"], false);
        assert_eq!(body["max_output_tokens"], MAX_OUTPUT_TOKENS);
        assert!(body["instructions"].as_str().unwrap().contains("Mochi"));
        assert_eq!(body["input"][0]["content"], "hi");
        // An empty name falls back instead of sending a request that cannot work.
        assert_eq!(request_body("   ", vec![])["model"], DEFAULT_MODEL);
    }

    #[test]
    fn a_file_rides_along_on_the_first_turn_only() {
        let dir = std::env::temp_dir().join(format!("coucou-openai-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("notiz.txt");
        std::fs::write(&file, "Inhalt der Notiz").unwrap();
        let ctx = ChatContext::File {
            name: "notiz.txt".into(),
            path: file.to_string_lossy().to_string(),
        };

        let first = user_content(true, "Fasse zusammen", Some(&ctx));
        let texts: Vec<&str> = first
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|p| p["text"].as_str())
            .collect();
        assert!(texts.iter().any(|t| t.contains("Inhalt der Notiz")));
        assert!(texts.iter().any(|t| *t == "File: notiz.txt"));
        assert_eq!(*texts.last().unwrap(), "Fasse zusammen");

        let later = user_content(false, "Und weiter?", Some(&ctx));
        assert_eq!(later.as_array().unwrap().len(), 1);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn images_and_pdfs_become_data_urls() {
        let dir = std::env::temp_dir().join(format!("coucou-openai-bin-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let png = dir.join("a.png");
        let pdf = dir.join("b.pdf");
        std::fs::write(&png, b"foo").unwrap();
        std::fs::write(&pdf, b"foo").unwrap();

        let image = file_part("a.png", png.to_str().unwrap()).unwrap();
        assert_eq!(image["type"], "input_image");
        assert_eq!(image["image_url"], "data:image/png;base64,Zm9v");

        let doc = file_part("b.pdf", pdf.to_str().unwrap()).unwrap();
        assert_eq!(doc["type"], "input_file");
        assert_eq!(doc["filename"], "b.pdf");
        assert_eq!(doc["file_data"], "data:application/pdf;base64,Zm9v");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reply_text_joins_message_parts_and_skips_reasoning() {
        let v: Value = serde_json::from_str(GOOD_REPLY).unwrap();
        assert_eq!(reply_text(&v).unwrap(), "Hallo \nWelt");
    }

    #[test]
    fn reply_text_explains_refusals_truncation_failures_and_garbage() {
        let refusal = json!({"status":"completed","output":[{"type":"message","content":[
            {"type":"refusal","refusal":"Dabei kann ich nicht helfen."}]}]});
        assert!(reply_text(&refusal).unwrap_err().contains("Dabei kann ich nicht helfen."));

        let cut = json!({"status":"incomplete","output":[{"type":"reasoning"}]});
        assert!(reply_text(&cut).unwrap_err().contains("Token-Limit"));

        let failed = json!({"status":"failed","error":{"message":"kaputt"}});
        assert!(reply_text(&failed).unwrap_err().contains("kaputt"));

        let empty = json!({"status":"completed","output":[]});
        assert!(reply_text(&empty).unwrap_err().contains("keinen Text"));

        assert!(reply_text(&json!({"hello":1})).unwrap_err().contains("Unerwartete"));
    }

    #[test]
    fn call_sends_the_key_and_body_and_parses_the_reply() {
        let (url, server) = serve_once("200 OK", GOOD_REPLY);
        let body = request_body("gpt-test", vec![json!({"role":"user","content":"hi"})]);
        let reply = tauri::async_runtime::block_on(call(&url, "sk-test-123", &body)).unwrap();
        assert_eq!(reply_text(&reply).unwrap(), "Hallo \nWelt");

        let request = server.join().unwrap();
        assert!(request.starts_with("POST /v1/responses"), "got: {request}");
        assert!(request.to_ascii_lowercase().contains("authorization: bearer sk-test-123"));
        assert!(request.contains("\"model\":\"gpt-test\""));
        assert!(request.contains("\"store\":false"));
    }

    #[test]
    fn call_surfaces_the_apis_own_error_message() {
        let (url, server) = serve_once(
            "401 Unauthorized",
            r#"{"error":{"message":"Incorrect API key provided","type":"invalid_request_error"}}"#,
        );
        let err = tauri::async_runtime::block_on(call(&url, "sk-bad", &json!({}))).unwrap_err();
        server.join().unwrap();
        assert!(err.contains("401"), "got: {err}");
        assert!(err.contains("Incorrect API key provided"), "got: {err}");
    }

    #[test]
    fn a_failed_turn_leaves_no_trace_in_the_history() {
        let chat = Chat::default();
        assert!(chat.openai_is_empty());
        chat.openai_push(json!({"role":"user","content":[]}));
        assert!(!chat.openai_is_empty());
        chat.openai_pop();
        assert!(chat.openai_is_empty());
        chat.openai_push(json!({"role":"user"}));
        chat.reset();
        assert!(chat.openai_snapshot().is_empty());
    }
}
