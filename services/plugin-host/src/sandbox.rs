use crate::{bindings, egress::mediated_request, PluginHostConfig, PluginHostError};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
    time::Duration,
};
use wasmtime::{
    component::{Component, HasSelf, Linker},
    Config, Engine, Store, StoreLimits, StoreLimitsBuilder,
};

const SHA256_PREFIX: &str = "sha256:";

#[derive(Clone, Debug)]
pub struct Invocation {
    pub workspace_id: String,
    pub installation_id: String,
    pub plugin_id: String,
    pub plugin_version: String,
    pub artifact_digest: String,
    pub component: Vec<u8>,
    pub capability: String,
    pub input_json: String,
    pub configuration: HashMap<String, String>,
    pub secrets: HashMap<String, String>,
    pub network_hosts: Vec<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InvocationResult {
    pub output_json: String,
}

#[derive(Clone)]
pub struct PluginHost {
    engine: Engine,
    linker: Arc<Linker<InvocationState>>,
    components: Arc<Mutex<ComponentCache>>,
    config: PluginHostConfig,
}

#[derive(Default)]
struct ComponentCache {
    entries: HashMap<String, Component>,
    order: VecDeque<String>,
}

impl ComponentCache {
    fn get(&mut self, digest: &str) -> Option<Component> {
        let component = self.entries.get(digest)?.clone();
        self.order.retain(|item| item != digest);
        self.order.push_back(digest.to_string());
        Some(component)
    }

    fn insert(&mut self, digest: String, component: Component, maximum: usize) -> Component {
        if let Some(existing) = self.get(&digest) {
            return existing;
        }
        while self.entries.len() >= maximum {
            if let Some(expired) = self.order.pop_front() {
                self.entries.remove(&expired);
            } else {
                break;
            }
        }
        self.order.push_back(digest.clone());
        self.entries.insert(digest, component.clone());
        component
    }
}

struct InvocationState {
    configuration: HashMap<String, String>,
    secrets: HashMap<String, String>,
    network_hosts: Vec<String>,
    max_response_bytes: usize,
    http_timeout: Duration,
    limits: StoreLimits,
}

impl bindings::braino::plugin::host::Host for InvocationState {
    async fn configuration(&mut self, name: String) -> Option<String> {
        self.configuration.get(&name).cloned()
    }

    async fn secret(&mut self, name: String) -> Result<String, String> {
        self.secrets
            .get(&name)
            .cloned()
            .ok_or_else(|| "secret is unavailable".to_string())
    }

    async fn request(
        &mut self,
        request: bindings::braino::plugin::host::HttpRequest,
    ) -> Result<bindings::braino::plugin::host::HttpResponse, String> {
        mediated_request(
            request,
            &self.network_hosts,
            self.max_response_bytes,
            self.http_timeout,
        )
        .await
    }
}

impl PluginHost {
    pub fn new(config: PluginHostConfig) -> Result<Self, PluginHostError> {
        let mut engine_config = Config::new();
        engine_config.consume_fuel(true);
        engine_config.wasm_component_model(true);
        let engine = Engine::new(&engine_config)
            .map_err(|_| PluginHostError::new("host_unavailable", "plugin host is unavailable"))?;
        let mut linker = Linker::new(&engine);
        bindings::Plugin::add_to_linker::<_, HasSelf<_>>(&mut linker, |state| state)
            .map_err(|_| PluginHostError::new("host_unavailable", "plugin host is unavailable"))?;
        Ok(Self {
            engine,
            linker: Arc::new(linker),
            components: Arc::new(Mutex::new(ComponentCache::default())),
            config,
        })
    }

    pub async fn invoke(
        &self,
        invocation: Invocation,
    ) -> Result<InvocationResult, PluginHostError> {
        validate_invocation(&invocation, &self.config)?;
        let component = self.component(&invocation)?;
        let limits = StoreLimitsBuilder::new()
            .memory_size(self.config.max_memory_bytes)
            .instances(32)
            .memories(2)
            .tables(32)
            .table_elements(100_000)
            .build();
        let mut store = Store::new(
            &self.engine,
            InvocationState {
                configuration: invocation.configuration,
                secrets: invocation.secrets,
                network_hosts: invocation.network_hosts,
                max_response_bytes: self.config.max_response_bytes,
                http_timeout: self.config.http_timeout,
                limits,
            },
        );
        store.limiter(|state| &mut state.limits);
        store
            .set_fuel(self.config.max_fuel)
            .map_err(|_| PluginHostError::new("host_unavailable", "plugin host is unavailable"))?;
        store
            .fuel_async_yield_interval(Some(10_000))
            .map_err(|_| PluginHostError::new("host_unavailable", "plugin host is unavailable"))?;

        let run = async {
            let instance =
                bindings::Plugin::instantiate_async(&mut store, &component, self.linker.as_ref())
                    .await
                    .map_err(|_| ())?;
            let output = instance
                .braino_plugin_handler()
                .call_invoke(&mut store, &invocation.capability, &invocation.input_json)
                .await
                .map_err(|_| ())?;
            Result::<_, ()>::Ok(output)
        };
        let output = tokio::time::timeout(self.config.max_execution_time, run)
            .await
            .map_err(|_| PluginHostError::new("execution_timeout", "plugin execution timed out"))?
            .map_err(|_| PluginHostError::new("execution_failed", "plugin execution failed"))?;
        let output_json =
            output.map_err(|message| PluginHostError::new("plugin_error", message))?;
        if output_json.len() > self.config.max_response_bytes {
            return Err(PluginHostError::new(
                "response_too_large",
                "plugin response exceeds the configured limit",
            ));
        }
        serde_json::from_str::<serde_json::Value>(&output_json).map_err(|_| {
            PluginHostError::new("response_invalid", "plugin response must be valid JSON")
        })?;
        Ok(InvocationResult { output_json })
    }

    fn component(&self, invocation: &Invocation) -> Result<Component, PluginHostError> {
        {
            let mut components = self.components.lock().map_err(|_| {
                PluginHostError::new("host_unavailable", "plugin host is unavailable")
            })?;
            if let Some(component) = components.get(&invocation.artifact_digest) {
                return Ok(component);
            }
        }
        let component = Component::new(&self.engine, &invocation.component)
            .map_err(|_| PluginHostError::new("artifact_invalid", "plugin artifact is invalid"))?;
        let mut components = self
            .components
            .lock()
            .map_err(|_| PluginHostError::new("host_unavailable", "plugin host is unavailable"))?;
        Ok(components.insert(
            invocation.artifact_digest.clone(),
            component,
            self.config.max_cached_components,
        ))
    }
}

fn validate_invocation(
    invocation: &Invocation,
    config: &PluginHostConfig,
) -> Result<(), PluginHostError> {
    if invocation.workspace_id.is_empty()
        || invocation.installation_id.is_empty()
        || invocation.plugin_id.is_empty()
        || invocation.plugin_version.is_empty()
        || invocation.capability.is_empty()
    {
        return Err(PluginHostError::new(
            "identity_invalid",
            "plugin invocation identity is incomplete",
        ));
    }
    if invocation.component.len() > config.max_component_bytes {
        return Err(PluginHostError::new(
            "artifact_too_large",
            "plugin artifact exceeds the configured limit",
        ));
    }
    serde_json::from_str::<serde_json::Value>(&invocation.input_json)
        .map_err(|_| PluginHostError::new("input_invalid", "plugin input must be valid JSON"))?;
    let Some(expected) = invocation.artifact_digest.strip_prefix(SHA256_PREFIX) else {
        return Err(PluginHostError::new(
            "artifact_digest_invalid",
            "plugin artifact digest is invalid",
        ));
    };
    let actual = format!("{:x}", Sha256::digest(&invocation.component));
    if expected != actual {
        return Err(PluginHostError::new(
            "artifact_digest_mismatch",
            "plugin artifact does not match its installation digest",
        ));
    }
    Ok(())
}
