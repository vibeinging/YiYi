//! Mock LLM HTTP server for tests.
//!
//! Stands up a local `wiremock` server that speaks the OpenAI-compatible
//! `/v1/chat/completions` API. Tests configure responses and point the
//! resolved `LLMConfig.base_url` at the mock server by seeding a provider
//! into `ProvidersState.providers` + `ProvidersState.active_llm`.
//!
//! Usage:
//!
//! ```ignore
//! let mock = MockLlmServer::start().await;
//! mock.mock_chat_completion_response("hi there").await;
//!
//! let t = build_test_app_state().await;
//! seed_mock_llm_provider(t.state(), &mock, "mock-model").await;
//!
//! let out = my_command_impl(t.state(), ...).await.unwrap();
//! assert!(out.contains("hi there"));
//! ```
//!
//! Because `resolve_config_from_providers` resolves `base_url` from the
//! provider's `base_url` override (or the built-in `default_base_url`),
//! we seed a built-in provider id with an overridden `base_url` pointing
//! at the mock server. This exercises the real HTTP path end-to-end.

use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

/// Local mock LLM server. Keep alive for the duration of the test.
pub struct MockLlmServer {
    pub server: MockServer,
}

impl MockLlmServer {
    /// Start a fresh mock server on an ephemeral port.
    pub async fn start() -> Self {
        Self {
            server: MockServer::start().await,
        }
    }

    /// Base URL (e.g. `http://127.0.0.1:12345`). Treated as the provider
    /// `base_url` — the production code appends `/chat/completions`
    /// to this to form the final endpoint.
    pub fn uri(&self) -> String {
        self.server.uri()
    }

    /// Configure the mock to return a fixed assistant message for any
    /// `POST /chat/completions` (matches the path the OpenAI adapter hits
    /// when `base_url` is set to the mock URI).
    pub async fn mock_chat_completion_response(&self, message: &str) {
        let body = serde_json::json!({
            "id": "mock-id",
            "object": "chat.completion",
            "created": 0,
            "model": "mock-model",
            "choices": [{
                "index": 0,
                "message": { "role": "assistant", "content": message },
                "finish_reason": "stop"
            }],
            "usage": {
                "prompt_tokens": 10,
                "completion_tokens": 5,
                "total_tokens": 15,
            }
        });
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(body))
            .mount(&self.server)
            .await;
    }

    /// Configure a raw HTTP error response (for negative / fallback tests).
    /// Note: the LLM client retries transient 5xx errors, so tests targeting
    /// persistent errors should expect a longer wait.
    pub async fn mock_chat_completion_error(&self, status: u16) {
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(ResponseTemplate::new(status))
            .mount(&self.server)
            .await;
    }

    /// Configure a streaming SSE response: emits each chunk as a `data: {...}\n\n`
    /// envelope with `choices[0].delta.content = chunk`, followed by `data: [DONE]\n\n`.
    /// Matches the same `/chat/completions` path as the non-streaming mock, so tests
    /// can switch between streaming/non-streaming on the same server.
    pub async fn mock_chat_completion_stream(&self, chunks: &[&str]) {
        let mut body = String::new();
        for chunk in chunks {
            let evt = serde_json::json!({
                "id": "mock-id",
                "object": "chat.completion.chunk",
                "created": 0,
                "model": "mock-model",
                "choices": [{
                    "index": 0,
                    "delta": { "content": chunk },
                    "finish_reason": null
                }]
            });
            body.push_str(&format!("data: {}\n\n", evt));
        }
        // Final done chunk
        body.push_str("data: [DONE]\n\n");

        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_raw(body.into_bytes(), "text/event-stream")
                    .insert_header("content-type", "text/event-stream"),
            )
            .mount(&self.server)
            .await;
    }

    /// Configure an SSE response that emits a tool_call chunk, for ReAct tests
    /// that exercise tool dispatch.
    pub async fn mock_chat_completion_tool_call(
        &self,
        tool_name: &str,
        tool_args_json: &str,
    ) {
        let tool_call_evt = serde_json::json!({
            "id": "mock-id",
            "object": "chat.completion.chunk",
            "created": 0,
            "model": "mock-model",
            "choices": [{
                "index": 0,
                "delta": {
                    "tool_calls": [{
                        "index": 0,
                        "id": "call_mock_1",
                        "type": "function",
                        "function": {
                            "name": tool_name,
                            "arguments": tool_args_json,
                        }
                    }]
                },
                "finish_reason": null
            }]
        });
        let body = format!("data: {}\n\ndata: [DONE]\n\n", tool_call_evt);

        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_raw(body.into_bytes(), "text/event-stream")
                    .insert_header("content-type", "text/event-stream"),
            )
            .mount(&self.server)
            .await;
    }
}

/// Seed an active LLM provider in the given `AppState.providers` pointing at
/// the mock server. Uses the "openai" built-in provider id so the OpenAI-format
/// adapter is dispatched to, overriding its `base_url`. A fake API key keeps
/// `resolve_config_from_providers` happy.
pub async fn seed_mock_llm_provider(
    state: &crate::state::AppState,
    mock: &MockLlmServer,
    model: &str,
) {
    use crate::state::providers::{ModelSlotConfig, ProviderSettings};

    let mut providers = state.providers.write().await;
    providers.providers.insert(
        "openai".to_string(),
        ProviderSettings {
            base_url: Some(mock.uri()),
            api_key: Some("test-fake-key".to_string()),
            extra_models: vec![],
        },
    );
    providers.active_llm = Some(ModelSlotConfig {
        provider_id: "openai".to_string(),
        model: model.to_string(),
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "multi_thread")]
    async fn mock_llm_server_responds_with_configured_message() {
        let server = MockLlmServer::start().await;
        server
            .mock_chat_completion_response("Hello from mock")
            .await;

        let client = reqwest::Client::new();
        let resp = client
            .post(format!("{}/chat/completions", server.uri()))
            .json(&serde_json::json!({
                "model": "x",
                "messages": [{"role": "user", "content": "hi"}]
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 200);

        let body: serde_json::Value = resp.json().await.unwrap();
        assert_eq!(
            body["choices"][0]["message"]["content"],
            "Hello from mock"
        );
        assert_eq!(body["choices"][0]["finish_reason"], "stop");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn mock_llm_server_serves_configured_error_status() {
        let server = MockLlmServer::start().await;
        server.mock_chat_completion_error(503).await;

        let client = reqwest::Client::new();
        let resp = client
            .post(format!("{}/chat/completions", server.uri()))
            .json(&serde_json::json!({"model": "x", "messages": []}))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 503);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn mock_chat_completion_stream_serves_sse_chunks() {
        let server = MockLlmServer::start().await;
        server
            .mock_chat_completion_stream(&["Hello", ", world"])
            .await;

        let client = reqwest::Client::new();
        let resp = client
            .post(format!("{}/chat/completions", server.uri()))
            .json(&serde_json::json!({"model": "x", "messages": [], "stream": true}))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 200);
        assert!(resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .contains("text/event-stream"));

        let body = resp.text().await.unwrap();
        assert!(body.contains("\"Hello\""), "body missing first chunk: {}", body);
        assert!(body.contains("\", world\""), "body missing second chunk: {}", body);
        assert!(body.contains("data: [DONE]"), "body missing terminator: {}", body);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn mock_chat_completion_tool_call_serves_tool_call_event() {
        let server = MockLlmServer::start().await;
        server
            .mock_chat_completion_tool_call("my_tool", r#"{"x":1}"#)
            .await;

        let client = reqwest::Client::new();
        let resp = client
            .post(format!("{}/chat/completions", server.uri()))
            .json(&serde_json::json!({"model": "x", "messages": []}))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 200);
        let body = resp.text().await.unwrap();
        assert!(body.contains("my_tool"), "body missing tool name: {}", body);
        assert!(body.contains("tool_calls"), "body missing tool_calls key: {}", body);
        assert!(body.contains("data: [DONE]"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn seed_mock_llm_provider_sets_active_llm_to_mock_uri() {
        use crate::test_support::build_test_app_state;

        let t = build_test_app_state().await;
        let mock = MockLlmServer::start().await;
        seed_mock_llm_provider(t.state(), &mock, "mock-model").await;

        let providers = t.state().providers.read().await;
        let active = providers.active_llm.as_ref().expect("active_llm set");
        assert_eq!(active.provider_id, "openai");
        assert_eq!(active.model, "mock-model");

        let settings = providers.providers.get("openai").expect("provider seeded");
        assert_eq!(settings.base_url.as_deref(), Some(mock.uri().as_str()));
        assert_eq!(settings.api_key.as_deref(), Some("test-fake-key"));
    }
}
