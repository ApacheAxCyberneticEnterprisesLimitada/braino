use std::time::Duration;

#[derive(Clone, Debug)]
pub struct PluginHostConfig {
    pub max_component_bytes: usize,
    pub max_memory_bytes: usize,
    pub max_response_bytes: usize,
    pub max_execution_time: Duration,
    pub http_timeout: Duration,
    pub max_fuel: u64,
    pub max_cached_components: usize,
    /// Exact host:port pairs that an operator exposes to plugins on the
    /// instance-private network. Guests still have to declare the same host
    /// in their manifest; this second gate is what permits plain HTTP and a
    /// private address without weakening public-provider SSRF protection.
    pub local_network_hosts: Vec<String>,
}

impl Default for PluginHostConfig {
    fn default() -> Self {
        Self {
            max_component_bytes: 16 * 1024 * 1024,
            max_memory_bytes: 64 * 1024 * 1024,
            max_response_bytes: 8 * 1024 * 1024,
            max_execution_time: Duration::from_secs(30),
            http_timeout: Duration::from_secs(15),
            max_fuel: 100_000_000,
            max_cached_components: 16,
            local_network_hosts: Vec::new(),
        }
    }
}

impl PluginHostConfig {
    pub fn for_tests() -> Self {
        Self {
            max_execution_time: Duration::from_secs(5),
            http_timeout: Duration::from_secs(2),
            max_fuel: 1_000_000,
            ..Self::default()
        }
    }
}

#[derive(Clone, Debug)]
pub struct AppConfig {
    pub api_token: String,
    pub host: PluginHostConfig,
}

impl AppConfig {
    pub fn from_env() -> Result<Self, String> {
        let api_token = std::env::var("BRAINO_PLUGIN_HOST_API_TOKEN")
            .map_err(|_| "BRAINO_PLUGIN_HOST_API_TOKEN is required".to_string())?;
        if api_token.trim().len() < 32 {
            return Err("BRAINO_PLUGIN_HOST_API_TOKEN must be at least 32 characters".to_string());
        }
        let defaults = PluginHostConfig::default();
        Ok(Self {
            api_token,
            host: PluginHostConfig {
                max_component_bytes: env_usize(
                    "BRAINO_PLUGIN_MAX_COMPONENT_BYTES",
                    defaults.max_component_bytes,
                )?,
                max_memory_bytes: env_usize(
                    "BRAINO_PLUGIN_MAX_MEMORY_BYTES",
                    defaults.max_memory_bytes,
                )?,
                max_response_bytes: env_usize(
                    "BRAINO_PLUGIN_MAX_RESPONSE_BYTES",
                    defaults.max_response_bytes,
                )?,
                max_execution_time: Duration::from_millis(env_u64(
                    "BRAINO_PLUGIN_MAX_EXECUTION_MS",
                    duration_millis(defaults.max_execution_time),
                )?),
                http_timeout: Duration::from_millis(env_u64(
                    "BRAINO_PLUGIN_HTTP_TIMEOUT_MS",
                    duration_millis(defaults.http_timeout),
                )?),
                max_fuel: env_u64("BRAINO_PLUGIN_MAX_FUEL", defaults.max_fuel)?,
                max_cached_components: env_usize(
                    "BRAINO_PLUGIN_MAX_CACHED_COMPONENTS",
                    defaults.max_cached_components,
                )?,
                local_network_hosts: env_hosts("BRAINO_PLUGIN_LOCAL_NETWORK_HOSTS")?,
            },
        })
    }
}

fn env_hosts(name: &str) -> Result<Vec<String>, String> {
    let Ok(value) = std::env::var(name) else {
        return Ok(Vec::new());
    };
    value
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            let Some((host, port)) = value.rsplit_once(':') else {
                return Err(format!("{name} entries must be exact host:port pairs"));
            };
            if host.is_empty()
                || host.contains(['*', '/', '@'])
                || port.parse::<u16>().ok().filter(|port| *port > 0).is_none()
            {
                return Err(format!("{name} contains an invalid host:port pair"));
            }
            Ok(format!("{}:{port}", host.to_ascii_lowercase()))
        })
        .collect()
}

fn duration_millis(duration: Duration) -> u64 {
    duration.as_millis().try_into().unwrap_or(u64::MAX)
}

fn env_usize(name: &str, fallback: usize) -> Result<usize, String> {
    match std::env::var(name) {
        Ok(value) => value
            .parse::<usize>()
            .ok()
            .filter(|value| *value > 0)
            .ok_or_else(|| format!("{name} must be a positive integer")),
        Err(_) => Ok(fallback),
    }
}

fn env_u64(name: &str, fallback: u64) -> Result<u64, String> {
    match std::env::var(name) {
        Ok(value) => value
            .parse::<u64>()
            .ok()
            .filter(|value| *value > 0)
            .ok_or_else(|| format!("{name} must be a positive integer")),
        Err(_) => Ok(fallback),
    }
}
