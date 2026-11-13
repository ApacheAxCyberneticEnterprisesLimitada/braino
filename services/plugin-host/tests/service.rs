use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use braino_plugin_host::{app, AppConfig, PluginHostConfig};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf};
use tower::ServiceExt;

const TOKEN: &str = "test-plugin-host-token-with-32-characters";

fn fixture() -> Vec<u8> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures/echo-plugin/target/wasm32-wasip2/release/braino_echo_plugin.wasm");
    fs::read(path).expect("build the no-std echo fixture for wasm32-wasip2 before running tests")
}

fn request(component: &[u8]) -> Value {
    json!({
        "workspaceId": "workspace_test",
        "installationId": "plugin_installation_test",
        "pluginId": "example.echo",
        "pluginVersion": "1.0.0",
        "artifactDigest": format!("sha256:{:x}", Sha256::digest(component)),
        "componentBase64": STANDARD.encode(component),
        "capability": "team_chat.send",
        "inputJson": "{}",
        "configuration": { "prefix": "api" },
        "secrets": { "token": "workspace-secret" },
        "networkHosts": []
    })
}

fn service() -> axum::Router {
    app(AppConfig {
        api_token: TOKEN.into(),
        host: PluginHostConfig::for_tests(),
    })
    .unwrap()
}

#[tokio::test]
async fn health_is_public_but_invocations_require_the_private_token() {
    let health = service()
        .oneshot(Request::get("/healthz").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(health.status(), StatusCode::OK);

    let component = fixture();
    let denied = service()
        .oneshot(
            Request::post("/v1/invocations")
                .header("content-type", "application/json")
                .body(Body::from(request(&component).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn authenticated_invocation_runs_the_pinned_component() {
    let component = fixture();
    let response = service()
        .oneshot(
            Request::post("/v1/invocations")
                .header("authorization", format!("Bearer {TOKEN}"))
                .header("content-type", "application/json")
                .body(Body::from(request(&component).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap(),
        json!({ "outputJson": "{\"value\":\"api:workspace-secret:team_chat.send:{}:1\"}" })
    );
}
