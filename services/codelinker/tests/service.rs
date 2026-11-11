use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use braino_codelinker::{app, build_graph, AppConfig, GraphRequest, Language, SourceFile};
use http_body_util::BodyExt;
use tower::ServiceExt;

fn file(path: &str, content: &str) -> SourceFile {
    SourceFile {
        path: path.to_string(),
        content: content.to_string(),
    }
}

#[test]
fn links_python_imports_calls_and_inheritance() {
    let graph = build_graph(GraphRequest {
        language: Language::Python,
        files: vec![
            file(
                "app/handler.py",
                "from .client import Client\nclass Handler(Client):\n    def run(self):\n        return Client()\n",
            ),
            file("app/client.py", "class Client:\n    pass\n"),
        ],
    })
    .expect("graph");

    assert_eq!(graph.stats.source_files, 2);
    assert!(graph.edges.iter().any(|edge| {
        edge.from == "app/handler.py" && edge.to == "app/client.py" && edge.edge_type == "IMPORTS"
    }));
    assert!(graph.edges.iter().any(|edge| edge.edge_type == "CALLS"));
    assert!(graph.edges.iter().any(|edge| edge.edge_type == "EXTENDS"));
}

#[test]
fn links_scala_imports_calls_and_inheritance() {
    let graph = build_graph(GraphRequest {
        language: Language::Scala,
        files: vec![
            file(
                "app/Foo.scala",
                "package app\nimport app.Bar\nclass Foo extends Bar { def run = Bar.execute() }\n",
            ),
            file(
                "app/Bar.scala",
                "package app\nclass Bar\nobject Bar { def execute() = () }\n",
            ),
        ],
    })
    .expect("graph");

    assert_eq!(graph.stats.parse_errors, 0);
    assert!(graph.edges.iter().any(|edge| edge.edge_type == "IMPORTS"));
    assert!(graph.edges.iter().any(|edge| edge.edge_type == "CALLS"));
    assert!(graph.edges.iter().any(|edge| edge.edge_type == "EXTENDS"));
}

#[test]
fn scala_imports_never_create_blank_edge_labels() {
    let graph = build_graph(GraphRequest {
        language: Language::Scala,
        files: vec![
            file("app/Foo.scala", "package app\nimport app.Bar\nclass Foo\n"),
            file("app/Bar.scala", "package app\nclass Bar\n"),
            file(
                "test/BarSpec.scala",
                "package test\nimport app.Bar\nclass BarSpec\n",
            ),
        ],
    })
    .expect("graph");

    assert!(graph.edges.iter().all(|edge| !edge.label.trim().is_empty()));
}

#[test]
fn uses_the_retrieval_graph_confidence_vocabulary() {
    let graph = build_graph(GraphRequest {
        language: Language::Python,
        files: vec![
            file("app.py", "def main():\n    return run()\n"),
            file("service.py", "def run():\n    return 1\n"),
        ],
    })
    .expect("graph");

    assert!(graph.edges.iter().any(|edge| {
        edge.edge_type == "CALLS"
            && edge.from == "app.py"
            && edge.to == "service.py"
            && edge.confidence == "heuristic"
    }));
    assert!(graph
        .edges
        .iter()
        .all(|edge| matches!(edge.confidence.as_str(), "exact" | "heuristic")));
}

#[tokio::test]
async fn health_is_public_but_graph_building_requires_the_bearer_token() {
    let router = app(AppConfig {
        api_token: "test-token".to_string(),
        max_files: 100,
        max_file_bytes: 200_000,
        max_total_bytes: 2_000_000,
    });

    let health = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/healthz")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(health.status(), StatusCode::OK);

    let payload = serde_json::to_vec(&GraphRequest {
        language: Language::Python,
        files: vec![file("main.py", "def main():\n    return 1\n")],
    })
    .unwrap();
    let unauthorized = router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/graphs")
                .header("content-type", "application/json")
                .body(Body::from(payload.clone()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

    let response = router
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/graphs")
                .header("content-type", "application/json")
                .header("authorization", "Bearer test-token")
                .body(Body::from(payload))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["stats"]["source_files"], 1);
}

#[tokio::test]
async fn rejects_unsafe_paths_and_oversized_files() {
    let config = AppConfig {
        api_token: "test-token".to_string(),
        max_files: 100,
        max_file_bytes: 8,
        max_total_bytes: 100,
    };
    for (source, expected) in [
        (
            file("../secret.py", "pass\n"),
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
        (
            file("large.py", "0123456789"),
            StatusCode::PAYLOAD_TOO_LARGE,
        ),
    ] {
        let payload = serde_json::to_vec(&GraphRequest {
            language: Language::Python,
            files: vec![source],
        })
        .unwrap();
        let response = app(config.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/graphs")
                    .header("content-type", "application/json")
                    .header("authorization", "Bearer test-token")
                    .body(Body::from(payload))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), expected);
    }
}
