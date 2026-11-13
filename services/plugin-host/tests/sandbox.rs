use braino_plugin_host::{Invocation, PluginHost, PluginHostConfig};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, fs, path::PathBuf, time::Duration};

fn fixture() -> Vec<u8> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures/echo-plugin/target/wasm32-wasip2/release/braino_echo_plugin.wasm");
    fs::read(path).expect("build the no-std echo fixture for wasm32-wasip2 before running tests")
}

fn invocation(component: &[u8], token: &str) -> Invocation {
    Invocation {
        workspace_id: "workspace_test".into(),
        installation_id: "plugin_installation_test".into(),
        plugin_id: "example.echo".into(),
        plugin_version: "1.0.0".into(),
        artifact_digest: format!("sha256:{:x}", Sha256::digest(component)),
        component: component.to_vec(),
        capability: "team_chat.send".into(),
        input_json: "null".into(),
        configuration: HashMap::from([("prefix".into(), "configured".into())]),
        secrets: HashMap::from([("token".into(), token.into())]),
        network_hosts: vec![],
    }
}

#[tokio::test]
async fn every_invocation_gets_fresh_memory_and_workspace_data() {
    let component = fixture();
    let host = PluginHost::new(PluginHostConfig::for_tests()).unwrap();

    let first = host
        .invoke(invocation(&component, "first-secret"))
        .await
        .unwrap();
    let second = host
        .invoke(invocation(&component, "second-secret"))
        .await
        .unwrap();

    assert_eq!(
        first.output_json,
        r#"{"value":"configured:first-secret:team_chat.send:null:1"}"#
    );
    assert_eq!(
        second.output_json,
        r#"{"value":"configured:second-secret:team_chat.send:null:1"}"#
    );
}

#[tokio::test]
async fn rejects_artifacts_that_do_not_match_the_installation_digest() {
    let component = fixture();
    let host = PluginHost::new(PluginHostConfig::for_tests()).unwrap();
    let mut request = invocation(&component, "secret");
    request.artifact_digest = format!("sha256:{}", "0".repeat(64));

    let error = host.invoke(request).await.unwrap_err();

    assert_eq!(error.code(), "artifact_digest_mismatch");
}

#[test]
fn production_limits_are_bounded() {
    let limits = PluginHostConfig::default();
    assert!(limits.max_component_bytes <= 16 * 1024 * 1024);
    assert!(limits.max_memory_bytes <= 64 * 1024 * 1024);
    assert!(limits.max_response_bytes <= 8 * 1024 * 1024);
    assert!(limits.max_execution_time <= Duration::from_secs(30));
    assert!(limits.max_fuel > 0);
    assert!(limits.max_cached_components <= 16);
}

#[tokio::test]
async fn rejects_non_json_capability_input_before_guest_execution() {
    let component = fixture();
    let host = PluginHost::new(PluginHostConfig::for_tests()).unwrap();
    let mut request = invocation(&component, "secret");
    request.input_json = "not-json".into();

    let error = host.invoke(request).await.unwrap_err();

    assert_eq!(error.code(), "input_invalid");
}

#[tokio::test]
async fn fuel_stops_a_plugin_that_never_returns() {
    let component = fixture();
    let host = PluginHost::new(PluginHostConfig::for_tests()).unwrap();
    let mut request = invocation(&component, "secret");
    request.input_json = r#"{"loop":true}"#.into();

    let error = host.invoke(request).await.unwrap_err();

    assert_eq!(error.code(), "execution_failed");
}
