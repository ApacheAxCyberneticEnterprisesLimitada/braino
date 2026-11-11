use braino_codelinker::{app, healthcheck, AppConfig};
use std::net::SocketAddr;

#[tokio::main]
async fn main() {
    let port = std::env::var("PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(8080);
    if std::env::args().nth(1).as_deref() == Some("healthcheck") {
        if let Err(error) = healthcheck(port) {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }

    let config = AppConfig::from_env().unwrap_or_else(|error| {
        eprintln!("configuration error: {error}");
        std::process::exit(1);
    });
    let address = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(address)
        .await
        .unwrap_or_else(|error| {
            eprintln!("could not bind {address}: {error}");
            std::process::exit(1);
        });
    println!("braino-codelinker listening on {address}");
    axum::serve(listener, app(config))
        .with_graceful_shutdown(shutdown())
        .await
        .unwrap_or_else(|error| {
            eprintln!("server failed: {error}");
            std::process::exit(1);
        });
}

async fn shutdown() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("install Ctrl+C handler");
    };
    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("install SIGTERM handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}
