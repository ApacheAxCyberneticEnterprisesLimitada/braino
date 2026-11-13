use braino_plugin_host::{app, AppConfig};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use tokio::net::TcpListener;

#[tokio::main]
async fn main() {
    if std::env::args().nth(1).as_deref() == Some("healthcheck") {
        healthcheck().await;
        return;
    }
    let config = AppConfig::from_env().unwrap_or_else(|error| panic!("{error}"));
    let port = std::env::var("PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(8080);
    let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), port);
    let listener = TcpListener::bind(address)
        .await
        .unwrap_or_else(|error| panic!("failed to bind plugin host: {error}"));
    println!("braino-plugin-host listening on {address}");
    axum::serve(listener, app(config).expect("plugin host must initialize"))
        .with_graceful_shutdown(shutdown())
        .await
        .expect("plugin host server failed");
}

async fn healthcheck() {
    let port = std::env::var("PORT").unwrap_or_else(|_| "8080".to_string());
    let healthy = reqwest::get(format!("http://127.0.0.1:{port}/healthz"))
        .await
        .is_ok_and(|response| response.status().is_success());
    std::process::exit(if healthy { 0 } else { 1 });
}

async fn shutdown() {
    let _ = tokio::signal::ctrl_c().await;
}
