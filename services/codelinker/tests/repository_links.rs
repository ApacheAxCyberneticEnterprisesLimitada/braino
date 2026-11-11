use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use braino_codelinker::{
    app, extract_repository_links, AppConfig, RepositoryLinksRequest, RepositorySnapshot,
    SourceFile,
};
use http_body_util::BodyExt;
use tower::ServiceExt;

fn file(path: &str, content: &str) -> SourceFile {
    SourceFile {
        path: path.to_string(),
        content: content.to_string(),
    }
}

fn repository(id: &str, files: Vec<SourceFile>) -> RepositorySnapshot {
    RepositorySnapshot {
        id: id.to_string(),
        files,
    }
}

#[test]
fn links_java_clients_using_repository_derived_aliases() {
    let output = extract_repository_links(RepositoryLinksRequest {
        repositories: vec![
            repository(
                "example/orders",
                vec![file(
                    "src/Clients.java",
                    r#"
                    @RegisterRestClient(baseUri = "http://carts/")
                    interface CartsClient {}
                    @RegisterRestClient(baseUri = "http://user/")
                    interface UsersClient {}
                    @GrpcChannel(name = "payment")
                    PaymentService payment;
                    "#,
                )],
            ),
            repository("example/carts", vec![]),
            repository("example/users", vec![]),
            repository("example/payment", vec![]),
        ],
    })
    .expect("links");

    for target in ["example/carts", "example/users", "example/payment"] {
        assert!(output
            .links
            .iter()
            .any(|link| link.from == "example/orders" && link.to == target));
    }
}

#[test]
fn ignores_shared_product_hostnames_comments_and_local_variables() {
    let output = extract_repository_links(RepositoryLinksRequest {
        repositories: vec![
            repository("example/sockshop", vec![]),
            repository("example/orders", vec![]),
            repository("example/carts", vec![]),
            repository(
                "example/catalog",
                vec![
                    file(
                        "src/Catalog.java",
                        r#"
                        class Catalog {
                            void connect(Config config) {
                                Config carts = config.get("db");
                                client(carts.get("host"));
                            }
                        }
                        "#,
                    ),
                    file(
                        "src/openapi.yaml",
                        "servers:\n  - url: http://api.core.sockshop.example/\n",
                    ),
                    file(
                        "src/Payment.java",
                        "/** Requests are received from Orders service. */\nclass Payment {}\n",
                    ),
                ],
            ),
        ],
    })
    .expect("links");

    assert!(
        output.links.is_empty(),
        "unexpected links: {:#?}",
        output.links
    );
}

#[test]
fn does_not_treat_unstructured_json_values_as_service_configuration() {
    let output = extract_repository_links(RepositoryLinksRequest {
        repositories: vec![
            repository(
                "example/catalog",
                vec![file(
                    "icons.json",
                    r#"["home", "target", "radar", "sensor", "settings"]"#,
                )],
            ),
            repository("example/radar", vec![]),
            repository("example/sensor", vec![]),
        ],
    })
    .expect("links");

    assert!(
        output.links.is_empty(),
        "unexpected links: {:#?}",
        output.links
    );
}

#[test]
fn links_exact_repository_urls_without_organization_rules() {
    let output = extract_repository_links(RepositoryLinksRequest {
        repositories: vec![
            repository(
                "example/platform",
                vec![file(
                    "README.md",
                    "The cart service lives at [carts](https://github.com/example/carts).",
                )],
            ),
            repository("example/carts", vec![]),
        ],
    })
    .expect("links");

    let link = output
        .links
        .iter()
        .find(|link| link.from == "example/platform" && link.to == "example/carts")
        .expect("repository link");
    assert_eq!(link.relation, "REPOSITORY");
    assert_eq!(link.confidence, "exact");
}

#[tokio::test]
async fn exposes_repository_linking_through_the_authenticated_service() {
    let request = RepositoryLinksRequest {
        repositories: vec![
            repository(
                "example/orders",
                vec![file(
                    "src/Client.java",
                    r#"@GrpcChannel(name = "payment") PaymentService payment;"#,
                )],
            ),
            repository("example/payment", vec![]),
        ],
    };
    let response = app(AppConfig {
        api_token: "test-token".to_string(),
        max_files: 100,
        max_file_bytes: 200_000,
        max_total_bytes: 2_000_000,
    })
    .oneshot(
        Request::builder()
            .method("POST")
            .uri("/v1/repository-links")
            .header("content-type", "application/json")
            .header("authorization", "Bearer test-token")
            .body(Body::from(serde_json::to_vec(&request).unwrap()))
            .unwrap(),
    )
    .await
    .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["links"][0]["from"], "example/orders");
    assert_eq!(json["links"][0]["to"], "example/payment");
}
