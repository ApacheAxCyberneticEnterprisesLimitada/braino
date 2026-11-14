use crate::bindings::braino::plugin::host::{HttpRequest, HttpResponse};
use reqwest::{header, redirect::Policy, Method, Url};
use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
    time::Duration,
};
use tokio::net::lookup_host;

pub(crate) async fn mediated_request(
    request: HttpRequest,
    allowed_hosts: &[String],
    local_hosts: &[String],
    max_response_bytes: usize,
    timeout: Duration,
) -> Result<HttpResponse, String> {
    let url = Url::parse(&request.url).map_err(|_| "request URL is invalid".to_string())?;
    let local = request_is_local(&request.url, allowed_hosts, local_hosts)?;
    let host = url
        .host_str()
        .ok_or_else(|| "request URL has no host".to_string())?
        .to_ascii_lowercase();
    let port = url.port_or_known_default().unwrap_or(443);
    let address = lookup_host((host.as_str(), port))
        .await
        .map_err(|_| "request host could not be resolved".to_string())?
        .find(|address| local || public_address(address.ip()))
        .ok_or_else(|| {
            if local {
                "local request host could not be resolved".to_string()
            } else {
                "request host does not resolve to a public address".to_string()
            }
        })?;
    let client = reqwest::Client::builder()
        .redirect(Policy::none())
        .timeout(timeout)
        .resolve(&host, address)
        .build()
        .map_err(|_| "HTTP client is unavailable".to_string())?;
    let method = Method::from_bytes(request.method.as_bytes())
        .map_err(|_| "request method is invalid".to_string())?;
    if !matches!(
        method,
        Method::GET | Method::POST | Method::PUT | Method::PATCH | Method::DELETE | Method::HEAD
    ) {
        return Err("request method is not allowed".to_string());
    }
    let mut outbound = client.request(method, url);
    for (name, value) in request.headers {
        let name = header::HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| "request header name is invalid".to_string())?;
        if prohibited_header(&name) {
            return Err("request header is controlled by the host".to_string());
        }
        let value = header::HeaderValue::from_str(&value)
            .map_err(|_| "request header value is invalid".to_string())?;
        outbound = outbound.header(name, value);
    }
    let mut response = outbound
        .body(request.body)
        .send()
        .await
        .map_err(|_| "provider request failed".to_string())?;
    if response
        .content_length()
        .is_some_and(|size| size > max_response_bytes as u64)
    {
        return Err("provider response exceeds the configured limit".to_string());
    }
    let status = response.status().as_u16();
    let headers = response
        .headers()
        .iter()
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.as_str().to_string(), value.to_string()))
        })
        .collect();
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "provider response failed".to_string())?
    {
        if body.len().saturating_add(chunk.len()) > max_response_bytes {
            return Err("provider response exceeds the configured limit".to_string());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(HttpResponse {
        status,
        headers,
        body,
    })
}

fn request_is_local(
    request_url: &str,
    allowed_hosts: &[String],
    local_hosts: &[String],
) -> Result<bool, String> {
    let url = Url::parse(request_url).map_err(|_| "request URL is invalid".to_string())?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err("request URL must not contain credentials".to_string());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "request URL has no host".to_string())?
        .to_ascii_lowercase();
    let port = url
        .port_or_known_default()
        .ok_or_else(|| "request URL has no port".to_string())?;
    if !host_allowed(&host, port, allowed_hosts) {
        return Err("request host is not approved by the plugin manifest".to_string());
    }
    let local = host_allowed(&host, port, local_hosts);
    match (url.scheme(), local) {
        ("https", _) => Ok(local),
        ("http", true) => Ok(true),
        _ => Err(
            "public provider requests require HTTPS; local HTTP requires operator approval"
                .to_string(),
        ),
    }
}

fn host_allowed(host: &str, port: u16, allowed_hosts: &[String]) -> bool {
    allowed_hosts.iter().any(|allowed| {
        let allowed = allowed.to_ascii_lowercase();
        let (allowed_host, allowed_port) = allowed
            .rsplit_once(':')
            .and_then(|(host, port)| port.parse::<u16>().ok().map(|port| (host, port)))
            .unwrap_or((allowed.as_str(), 443));
        if allowed_port != port {
            return false;
        }
        if let Some(suffix) = allowed_host.strip_prefix("*.") {
            host.ends_with(&format!(".{suffix}")) && host.len() > suffix.len() + 1
        } else {
            host == allowed_host
        }
    })
}

fn prohibited_header(name: &header::HeaderName) -> bool {
    matches!(
        name.as_str(),
        "host"
            | "content-length"
            | "connection"
            | "keep-alive"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
            | "proxy-authorization"
            | "proxy-authenticate"
    )
}

fn public_address(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => public_v4(address),
        IpAddr::V6(address) => public_v6(address),
    }
}

fn public_v4(address: Ipv4Addr) -> bool {
    !(address.is_private()
        || address.is_loopback()
        || address.is_link_local()
        || address.is_multicast()
        || address.is_broadcast()
        || address.is_documentation()
        || address.is_unspecified()
        || address.octets()[0] == 0)
}

fn public_v6(address: Ipv6Addr) -> bool {
    if let Some(address) = address.to_ipv4_mapped() {
        return public_v4(address);
    }
    !(address.is_loopback()
        || address.is_multicast()
        || address.is_unspecified()
        || (address.segments()[0] & 0xfe00) == 0xfc00
        || (address.segments()[0] & 0xffc0) == 0xfe80)
}

#[cfg(test)]
mod tests {
    use super::{host_allowed, prohibited_header, public_address, request_is_local};
    use reqwest::header::HeaderName;
    use std::net::{IpAddr, Ipv4Addr};

    #[test]
    fn network_permissions_are_exact_or_strict_subdomains() {
        let allowed = vec!["api.example.com".into(), "*.hooks.example.com:8443".into()];
        assert!(host_allowed("api.example.com", 443, &allowed));
        assert!(!host_allowed("evil-api.example.com", 443, &allowed));
        assert!(host_allowed("tenant.hooks.example.com", 8443, &allowed));
        assert!(!host_allowed("hooks.example.com", 8443, &allowed));
        assert!(!host_allowed("tenant.hooks.example.com", 443, &allowed));
    }

    #[test]
    fn private_and_metadata_addresses_are_not_provider_egress() {
        assert!(!public_address(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1))));
        assert!(!public_address(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1))));
        assert!(!public_address(IpAddr::V4(Ipv4Addr::new(
            169, 254, 169, 254
        ))));
        assert!(!public_address(IpAddr::V6(
            Ipv4Addr::new(127, 0, 0, 1).to_ipv6_mapped()
        )));
        assert!(public_address(IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))));
    }

    #[test]
    fn plugins_cannot_override_transport_headers() {
        assert!(prohibited_header(&HeaderName::from_static("host")));
        assert!(prohibited_header(&HeaderName::from_static(
            "content-length"
        )));
        assert!(!prohibited_header(&HeaderName::from_static(
            "authorization"
        )));
    }

    #[test]
    fn local_http_requires_both_manifest_and_operator_approval() {
        let manifest = vec!["ollama:11434".into()];
        let operator = vec!["ollama:11434".into()];

        assert!(request_is_local("http://ollama:11434/api/embed", &manifest, &operator).unwrap());
        assert!(request_is_local("http://ollama:11434/api/embed", &manifest, &[]).is_err());
        assert!(request_is_local(
            "http://postgres:5432/",
            &["postgres:5432".into()],
            &operator
        )
        .is_err());
    }

    #[test]
    fn public_provider_requests_remain_https_only() {
        assert!(!request_is_local(
            "https://api.openai.com/v1/embeddings",
            &["api.openai.com".into()],
            &[]
        )
        .unwrap());
        assert!(request_is_local(
            "http://api.openai.com/v1/embeddings",
            &["api.openai.com:80".into()],
            &[]
        )
        .is_err());
    }
}
