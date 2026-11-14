# Braino plugin host

The plugin host is the only process that executes third-party plugin code. It
runs WebAssembly Components implementing the canonical
`braino:plugin/plugin@0.1.0` world published by `@doco/plugin-runtime`.

Every call creates a new Wasmtime store and component instance. A guest has no
WASI environment, filesystem, clocks, random source, or sockets. Its only host
imports are configuration lookup, secret lookup, and an HTTPS request broker.
The broker permits only manifest-approved hosts, pins DNS to a public address,
blocks redirects and transport headers, and limits response bytes and time.
An operator can expose one exact private service, such as `ollama:11434`, via
`BRAINO_PLUGIN_LOCAL_NETWORK_HOSTS`; a plugin must independently declare the
same host before local HTTP is permitted. No other private address is opened.

Compiled components are cached by verified SHA-256 digest in a bounded cache.
Guest memory, secrets, configuration, fuel, and writable state are never
cached. The service also caps linear memory, tables, instances, execution fuel,
wall time, component bytes, and response bytes.

The HTTP service is private to the Braino Compose network and requires
`BRAINO_PLUGIN_HOST_API_TOKEN`. It has no published host port. Self-hosted
instances run their own host; plugin inputs, secrets, and provider responses do
not pass through Braino Cloud or another Braino instance. The application
broker, not a browser or plugin, resolves the workspace installation and its
content-addressed component from PostgreSQL before making this private call.

## Developing the host

Rust 1.100+ and the `wasm32-wasip2` target are required. The no-std echo
component is a protocol fixture and deliberately imports only the Braino host
interface.

```sh
rustup target add wasm32-wasip2
cargo build --locked --release --target wasm32-wasip2 \
  --manifest-path services/plugin-host/fixtures/echo-plugin/Cargo.toml
cargo test --locked --manifest-path services/plugin-host/Cargo.toml
```
