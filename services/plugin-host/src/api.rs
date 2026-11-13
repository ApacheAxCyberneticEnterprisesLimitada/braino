use crate::{AppConfig, Invocation, InvocationResult, PluginHost, PluginHostError};
use axum::{
    extract::{DefaultBodyLimit, State},
    http::{header, HeaderMap},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Deserialize;
use std::{collections::HashMap, sync::Arc};
use subtle::ConstantTimeEq;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InvocationPayload {
    workspace_id: String,
    installation_id: String,
    plugin_id: String,
    plugin_version: String,
    artifact_digest: String,
    component_base64: String,
    capability: String,
    input_json: String,
    configuration: HashMap<String, String>,
    secrets: HashMap<String, String>,
    network_hosts: Vec<String>,
}

impl InvocationPayload {
    fn decode(self, max_component_bytes: usize) -> Result<Invocation, PluginHostError> {
        if self.component_base64.len() > max_component_bytes.saturating_mul(2) {
            return Err(PluginHostError::new(
                "artifact_too_large",
                "plugin artifact exceeds the configured limit",
            ));
        }
        let component = STANDARD.decode(self.component_base64).map_err(|_| {
            PluginHostError::new("artifact_invalid", "plugin artifact encoding is invalid")
        })?;
        Ok(Invocation {
            workspace_id: self.workspace_id,
            installation_id: self.installation_id,
            plugin_id: self.plugin_id,
            plugin_version: self.plugin_version,
            artifact_digest: self.artifact_digest,
            component,
            capability: self.capability,
            input_json: self.input_json,
            configuration: self.configuration,
            secrets: self.secrets,
            network_hosts: self.network_hosts,
        })
    }
}

#[derive(Clone)]
struct ServiceState {
    api_token: String,
    host: PluginHost,
    max_component_bytes: usize,
}

pub fn app(config: AppConfig) -> Result<Router, PluginHostError> {
    let body_limit = config
        .host
        .max_component_bytes
        .saturating_mul(2)
        .saturating_add(1024 * 1024);
    let state = Arc::new(ServiceState {
        api_token: config.api_token,
        max_component_bytes: config.host.max_component_bytes,
        host: PluginHost::new(config.host)?,
    });
    Ok(Router::new()
        .route("/healthz", get(health))
        .route("/v1/invocations", post(invoke))
        .layer(DefaultBodyLimit::max(body_limit))
        .with_state(state))
}

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "ok": true, "service": "braino-plugin-host" }))
}

async fn invoke(
    State(state): State<Arc<ServiceState>>,
    headers: HeaderMap,
    Json(payload): Json<InvocationPayload>,
) -> Result<Json<InvocationResult>, PluginHostError> {
    authorize(&headers, &state.api_token)?;
    let invocation = payload.decode(state.max_component_bytes)?;
    state.host.invoke(invocation).await.map(Json)
}

fn authorize(headers: &HeaderMap, token: &str) -> Result<(), PluginHostError> {
    let supplied = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or_default();
    let authorized =
        supplied.len() == token.len() && supplied.as_bytes().ct_eq(token.as_bytes()).into();
    if authorized {
        Ok(())
    } else {
        Err(PluginHostError::new("unauthorized", "unauthorized"))
    }
}
