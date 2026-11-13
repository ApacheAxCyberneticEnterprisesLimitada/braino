use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};

#[derive(Debug)]
pub struct PluginHostError {
    code: &'static str,
    message: String,
}

impl PluginHostError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn code(&self) -> &'static str {
        self.code
    }

    fn status(&self) -> StatusCode {
        match self.code {
            "unauthorized" => StatusCode::UNAUTHORIZED,
            "artifact_too_large" | "response_too_large" => StatusCode::PAYLOAD_TOO_LARGE,
            "execution_timeout" => StatusCode::GATEWAY_TIMEOUT,
            "host_unavailable" => StatusCode::INTERNAL_SERVER_ERROR,
            "identity_invalid"
            | "input_invalid"
            | "response_invalid"
            | "artifact_digest_invalid"
            | "artifact_digest_mismatch"
            | "artifact_invalid"
            | "execution_failed"
            | "plugin_error" => StatusCode::UNPROCESSABLE_ENTITY,
            _ => StatusCode::BAD_REQUEST,
        }
    }
}

impl std::fmt::Display for PluginHostError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for PluginHostError {}

impl IntoResponse for PluginHostError {
    fn into_response(self) -> Response {
        (
            self.status(),
            Json(serde_json::json!({
                "error": { "code": self.code, "message": self.message }
            })),
        )
            .into_response()
    }
}
