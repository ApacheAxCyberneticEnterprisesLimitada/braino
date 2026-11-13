mod api;
mod config;
mod egress;
mod error;
mod sandbox;

pub(crate) mod bindings {
    wasmtime::component::bindgen!({
        world: "plugin",
        path: "../../packages/plugin-runtime/wit",
        imports: { default: async },
        exports: { default: async },
    });
}

pub use api::app;
pub use config::{AppConfig, PluginHostConfig};
pub use error::PluginHostError;
pub use sandbox::{Invocation, InvocationResult, PluginHost};
