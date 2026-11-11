use axum::{
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    path::{Component, Path, PathBuf},
    sync::{Arc, LazyLock},
    time::Instant,
};
use tree_sitter::{Language as TreeSitterLanguage, Node, Parser};

mod repository_links;

pub use repository_links::{
    extract_repository_links, RepositoryLink, RepositoryLinkEvidence, RepositoryLinksOutput,
    RepositoryLinksRequest, RepositorySnapshot,
};

static IDENT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[A-Za-z_$][A-Za-z0-9_$]*").unwrap());
static PY_FROM_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)^\s*from\s+([.A-Za-z0-9_]+)\s+import\s+(.+)$").unwrap());
static PY_IMPORT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)^\s*import\s+(.+)$").unwrap());
static PY_CLASS_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^\s*class\s+[A-Za-z_][A-Za-z0-9_]*\s*\(([^)]*)\)").unwrap());
static SCALA_CLASS_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?m)^\s*(?:case\s+)?(?:class|trait|object)\s+[A-Za-z_$][A-Za-z0-9_$]*(?:[^\n=]*)?\s+extends\s+([A-Za-z_$][A-Za-z0-9_$]*(?:\s+with\s+[A-Za-z_$][A-Za-z0-9_$]*)*)",
    )
    .unwrap()
});

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Language {
    Python,
    Scala,
}

impl Language {
    fn extension(self) -> &'static str {
        match self {
            Self::Python => ".py",
            Self::Scala => ".scala",
        }
    }

    fn parser_language(self) -> TreeSitterLanguage {
        match self {
            Self::Python => tree_sitter_python::LANGUAGE.into(),
            Self::Scala => tree_sitter_scala::LANGUAGE.into(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SourceFile {
    pub path: String,
    pub content: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct GraphRequest {
    pub language: Language,
    pub files: Vec<SourceFile>,
}

#[derive(Clone, Debug, Serialize)]
pub struct FileOutput {
    pub path: String,
    pub symbols: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct EdgeOutput {
    pub from: String,
    pub to: String,
    #[serde(rename = "type")]
    pub edge_type: String,
    pub label: String,
    pub confidence: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct Stats {
    pub language: Language,
    pub source_files: usize,
    pub parsed_files: usize,
    pub parse_errors: usize,
    pub symbols: usize,
    pub edges: usize,
    pub build_ms: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct GraphOutput {
    pub stats: Stats,
    pub files: Vec<FileOutput>,
    pub edges: Vec<EdgeOutput>,
}

#[derive(Clone, Debug)]
struct ImportFact {
    module: String,
    bindings: Vec<String>,
}

#[derive(Clone, Debug)]
struct RawFile {
    path: String,
    symbols: Vec<String>,
    imports: Vec<ImportFact>,
    calls: Vec<String>,
    inherits: Vec<String>,
    module_refs: Vec<String>,
    identifier_counts: HashMap<String, usize>,
    parse_error: bool,
}

#[derive(Clone, Debug)]
pub struct AppConfig {
    pub api_token: String,
    pub max_files: usize,
    pub max_file_bytes: usize,
    pub max_total_bytes: usize,
}

impl AppConfig {
    pub fn from_env() -> Result<Self, String> {
        let api_token = std::env::var("BRAINO_CODELINKER_API_TOKEN")
            .map_err(|_| "BRAINO_CODELINKER_API_TOKEN is required".to_string())?;
        if api_token.trim().len() < 32 {
            return Err("BRAINO_CODELINKER_API_TOKEN must be at least 32 characters".to_string());
        }
        Ok(Self {
            api_token,
            max_files: env_usize("BRAINO_CODELINKER_MAX_FILES", 10_000)?,
            max_file_bytes: env_usize("BRAINO_CODELINKER_MAX_FILE_BYTES", 200_000)?,
            max_total_bytes: env_usize("BRAINO_CODELINKER_MAX_TOTAL_BYTES", 64 * 1024 * 1024)?,
        })
    }
}

fn env_usize(name: &str, fallback: usize) -> Result<usize, String> {
    match std::env::var(name) {
        Ok(value) => value
            .parse::<usize>()
            .ok()
            .filter(|parsed| *parsed > 0)
            .ok_or_else(|| format!("{name} must be a positive integer")),
        Err(_) => Ok(fallback),
    }
}

#[derive(Debug)]
pub struct GraphError {
    status: StatusCode,
    message: String,
}

impl GraphError {
    fn invalid(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::UNPROCESSABLE_ENTITY,
            message: message.into(),
        }
    }

    fn too_large(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::PAYLOAD_TOO_LARGE,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for GraphError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for GraphError {}

impl IntoResponse for GraphError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(serde_json::json!({ "error": self.message })),
        )
            .into_response()
    }
}

pub fn app(config: AppConfig) -> Router {
    let body_limit = config
        .max_total_bytes
        .saturating_add(config.max_files.saturating_mul(512))
        .saturating_add(1024 * 1024);
    Router::new()
        .route("/healthz", get(health))
        .route("/v1/graphs", post(create_graph))
        .route("/v1/repository-links", post(create_repository_links))
        .layer(DefaultBodyLimit::max(body_limit))
        .with_state(Arc::new(config))
}

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "ok": true, "service": "braino-codelinker" }))
}

async fn create_graph(
    State(config): State<Arc<AppConfig>>,
    headers: HeaderMap,
    Json(request): Json<GraphRequest>,
) -> Result<Json<GraphOutput>, GraphError> {
    authorize(&headers, &config)?;
    validate_request(&request, &config)?;
    build_graph(request).map(Json)
}

async fn create_repository_links(
    State(config): State<Arc<AppConfig>>,
    headers: HeaderMap,
    Json(request): Json<RepositoryLinksRequest>,
) -> Result<Json<RepositoryLinksOutput>, GraphError> {
    authorize(&headers, &config)?;
    validate_repository_links_request(&request, &config)?;
    extract_repository_links(request).map(Json)
}

fn authorize(headers: &HeaderMap, config: &AppConfig) -> Result<(), GraphError> {
    let expected = format!("Bearer {}", config.api_token);
    let authorized = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value == expected);
    if authorized {
        Ok(())
    } else {
        Err(GraphError {
            status: StatusCode::UNAUTHORIZED,
            message: "unauthorized".to_string(),
        })
    }
}

fn validate_repository_links_request(
    request: &RepositoryLinksRequest,
    config: &AppConfig,
) -> Result<(), GraphError> {
    if request.repositories.is_empty() {
        return Err(GraphError::invalid("repositories must not be empty"));
    }
    let mut repository_ids = HashSet::new();
    let mut total_files = 0usize;
    let mut total_bytes = 0usize;
    for repository in &request.repositories {
        if repository.id.trim().is_empty() || !repository_ids.insert(repository.id.as_str()) {
            return Err(GraphError::invalid(format!(
                "invalid or duplicate repository id: {:?}",
                repository.id
            )));
        }
        let mut paths = HashSet::new();
        for file in &repository.files {
            validate_path(&file.path)?;
            if !paths.insert(file.path.as_str()) {
                return Err(GraphError::invalid(format!(
                    "duplicate path in {}: {}",
                    repository.id, file.path
                )));
            }
            let bytes = file.content.len();
            if bytes > config.max_file_bytes {
                return Err(GraphError::too_large(format!(
                    "{}:{} has {bytes} bytes; per-file limit is {}",
                    repository.id, file.path, config.max_file_bytes
                )));
            }
            total_files = total_files.saturating_add(1);
            total_bytes = total_bytes.saturating_add(bytes);
        }
    }
    if total_files > config.max_files {
        return Err(GraphError::too_large(format!(
            "request has {total_files} files; limit is {}",
            config.max_files
        )));
    }
    if total_bytes > config.max_total_bytes {
        return Err(GraphError::too_large(format!(
            "source has {total_bytes} bytes; total limit is {}",
            config.max_total_bytes
        )));
    }
    Ok(())
}

fn validate_request(request: &GraphRequest, config: &AppConfig) -> Result<(), GraphError> {
    if request.files.is_empty() {
        return Err(GraphError::invalid("files must not be empty"));
    }
    if request.files.len() > config.max_files {
        return Err(GraphError::too_large(format!(
            "repository has {} files; limit is {}",
            request.files.len(),
            config.max_files
        )));
    }
    let mut total_bytes = 0usize;
    let mut paths = HashSet::new();
    for file in &request.files {
        validate_path(&file.path)?;
        if !file.path.ends_with(request.language.extension()) {
            return Err(GraphError::invalid(format!(
                "{} does not match the selected language",
                file.path
            )));
        }
        if !paths.insert(file.path.as_str()) {
            return Err(GraphError::invalid(format!(
                "duplicate path: {}",
                file.path
            )));
        }
        let bytes = file.content.len();
        if bytes > config.max_file_bytes {
            return Err(GraphError::too_large(format!(
                "{} has {bytes} bytes; per-file limit is {}",
                file.path, config.max_file_bytes
            )));
        }
        total_bytes = total_bytes.saturating_add(bytes);
        if total_bytes > config.max_total_bytes {
            return Err(GraphError::too_large(format!(
                "source has {total_bytes} bytes; total limit is {}",
                config.max_total_bytes
            )));
        }
    }
    Ok(())
}

fn validate_path(path: &str) -> Result<(), GraphError> {
    if path.is_empty() || path.starts_with('/') || path.contains('\0') {
        return Err(GraphError::invalid(format!(
            "invalid source path: {path:?}"
        )));
    }
    if Path::new(path)
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(GraphError::invalid(format!(
            "invalid source path: {path:?}"
        )));
    }
    Ok(())
}

pub fn build_graph(request: GraphRequest) -> Result<GraphOutput, GraphError> {
    let started = Instant::now();
    let file_set: HashSet<String> = request.files.iter().map(|file| file.path.clone()).collect();
    let raw_files = request
        .files
        .iter()
        .map(|file| parse_file(file, request.language))
        .collect::<Result<Vec<_>, _>>()?;

    let mut symbol_files: HashMap<String, Vec<String>> = HashMap::new();
    for file in &raw_files {
        for symbol in &file.symbols {
            symbol_files
                .entry(symbol.clone())
                .or_default()
                .push(file.path.clone());
        }
    }

    let mut edges = Vec::new();
    let mut seen = HashSet::new();
    for file in &raw_files {
        let mut binding_targets: HashMap<String, String> = HashMap::new();
        for import in &file.imports {
            let module_target = match request.language {
                Language::Python => resolve_python_module(&file.path, &import.module, &file_set),
                Language::Scala => resolve_scala_module(&import.module, &file_set),
            };
            if let Some(target) = &module_target {
                push_edge(
                    &mut edges,
                    &mut seen,
                    &file.path,
                    target,
                    "IMPORTS",
                    &import.module,
                    "exact",
                );
            }
            for binding in &import.bindings {
                let symbol_target = symbol_files
                    .get(binding)
                    .filter(|paths| paths.len() == 1)
                    .map(|paths| paths[0].clone());
                let submodule_target = if request.language == Language::Python {
                    let separator = if import.module.ends_with('.') {
                        ""
                    } else {
                        "."
                    };
                    resolve_python_module(
                        &file.path,
                        &format!("{}{separator}{binding}", import.module),
                        &file_set,
                    )
                } else {
                    None
                };
                let target = symbol_target
                    .or(submodule_target)
                    .or_else(|| module_target.clone());
                if let Some(target) = target {
                    if file
                        .identifier_counts
                        .get(binding)
                        .copied()
                        .unwrap_or_default()
                        > 1
                    {
                        push_edge(
                            &mut edges,
                            &mut seen,
                            &file.path,
                            &target,
                            "REFERENCES",
                            binding,
                            "exact",
                        );
                    }
                    binding_targets.insert(binding.clone(), target);
                }
            }
        }

        if request.language == Language::Python {
            for module in &file.module_refs {
                if let Some(target) = resolve_python_module(&file.path, module, &file_set) {
                    push_edge(
                        &mut edges,
                        &mut seen,
                        &file.path,
                        &target,
                        "ROUTES_TO",
                        module,
                        "exact",
                    );
                }
            }
        }

        let resolve = |name: &str| -> Option<(String, &'static str)> {
            if let Some(target) = binding_targets.get(name) {
                return Some((target.clone(), "exact"));
            }
            let candidates = symbol_files.get(name)?;
            if candidates.len() == 1 {
                Some((candidates[0].clone(), "heuristic"))
            } else {
                None
            }
        };
        for call in &file.calls {
            let first = first_identifier(call).unwrap_or("");
            let last = last_identifier(call).unwrap_or(first);
            for name in [first, last] {
                if let Some((target, confidence)) = resolve(name) {
                    push_edge(
                        &mut edges, &mut seen, &file.path, &target, "CALLS", call, confidence,
                    );
                    break;
                }
            }
        }
        for parent in &file.inherits {
            if let Some((target, confidence)) = resolve(parent) {
                push_edge(
                    &mut edges, &mut seen, &file.path, &target, "EXTENDS", parent, confidence,
                );
            }
        }
    }

    let stats = Stats {
        language: request.language,
        source_files: request.files.len(),
        parsed_files: raw_files.len(),
        parse_errors: raw_files.iter().filter(|file| file.parse_error).count(),
        symbols: raw_files.iter().map(|file| file.symbols.len()).sum(),
        edges: edges.len(),
        build_ms: started.elapsed().as_secs_f64() * 1000.0,
    };
    let files = raw_files
        .into_iter()
        .map(|file| FileOutput {
            path: file.path,
            symbols: file.symbols,
        })
        .collect();
    Ok(GraphOutput {
        stats,
        files,
        edges,
    })
}

fn node_text<'a>(node: Node<'a>, source: &'a [u8]) -> &'a str {
    node.utf8_text(source).unwrap_or("")
}

fn identifiers(text: &str) -> Vec<String> {
    IDENT_RE
        .find_iter(text)
        .map(|matched| matched.as_str().to_string())
        .collect()
}

fn imported_name(part: &str) -> Option<String> {
    let clean = part
        .trim()
        .trim_matches(|character| matches!(character, '{' | '}' | '(' | ')'));
    if clean.is_empty() || clean == "_" {
        return None;
    }
    let words = identifiers(clean);
    if let Some(index) = words.iter().position(|word| word == "as" || word == "=>") {
        return words.get(index + 1).cloned();
    }
    words.last().cloned()
}

fn parse_python_import(text: &str) -> Vec<ImportFact> {
    if let Some(capture) = PY_FROM_RE.captures(text) {
        let bindings = capture[2].split(',').filter_map(imported_name).collect();
        return vec![ImportFact {
            module: capture[1].to_string(),
            bindings,
        }];
    }
    if let Some(capture) = PY_IMPORT_RE.captures(text) {
        return capture[1]
            .split(',')
            .filter_map(|part| {
                let words = identifiers(part);
                let module = words.first()?.clone();
                let binding = words
                    .iter()
                    .position(|word| word == "as")
                    .and_then(|index| words.get(index + 1))
                    .cloned()
                    .unwrap_or_else(|| module.clone());
                Some(ImportFact {
                    module: part.split_whitespace().next()?.to_string(),
                    bindings: vec![binding],
                })
            })
            .collect();
    }
    Vec::new()
}

fn parse_scala_import(text: &str) -> Vec<ImportFact> {
    let body = text.trim().strip_prefix("import").unwrap_or(text).trim();
    let module = body
        .split('{')
        .next()
        .unwrap_or(body)
        .trim()
        .trim_end_matches('.')
        .to_string();
    if module.is_empty() {
        return Vec::new();
    }
    let bindings = if let (Some(start), Some(end)) = (body.find('{'), body.rfind('}')) {
        body[start + 1..end]
            .split(',')
            .filter_map(imported_name)
            .collect()
    } else {
        imported_name(body).into_iter().collect()
    };
    vec![ImportFact { module, bindings }]
}

fn symbol_kind(language: Language, kind: &str) -> bool {
    match language {
        Language::Python => matches!(kind, "class_definition" | "function_definition"),
        Language::Scala => matches!(
            kind,
            "class_definition"
                | "trait_definition"
                | "object_definition"
                | "function_definition"
                | "function_declaration"
                | "val_definition"
                | "var_definition"
                | "case_class_definition"
                | "case_object_definition"
        ),
    }
}

fn walk(node: Node<'_>, source: &[u8], language: Language, facts: &mut RawFile) {
    let kind = node.kind();
    if symbol_kind(language, kind) {
        if let Some(name) = node.child_by_field_name("name") {
            let value = node_text(name, source).trim();
            if !value.is_empty() && value.len() <= 120 {
                facts.symbols.push(value.to_string());
            }
        }
    }
    if (language == Language::Python
        && matches!(kind, "import_statement" | "import_from_statement"))
        || (language == Language::Scala && kind.contains("import"))
    {
        let text = node_text(node, source);
        facts.imports.extend(if language == Language::Python {
            parse_python_import(text)
        } else {
            parse_scala_import(text)
        });
    }
    if matches!(kind, "call" | "call_expression" | "method_call") {
        let function = node
            .child_by_field_name("function")
            .or_else(|| node.named_child(0));
        if let Some(function) = function {
            let value = node_text(function, source).trim();
            if !value.is_empty() && value.len() <= 180 {
                facts.calls.push(value.to_string());
            }
        }
    }
    if matches!(
        kind,
        "string" | "string_literal" | "interpolated_string_expression"
    ) {
        let value =
            node_text(node, source).trim_matches(|character| character == '\'' || character == '"');
        if (value.starts_with('/') || value.starts_with("http")) && value.len() <= 180 {
            facts.symbols.push(value.to_string());
        }
        if value.contains('.')
            && value.split('.').all(|part| {
                !part.is_empty()
                    && part
                        .chars()
                        .all(|character| character.is_ascii_alphanumeric() || character == '_')
            })
        {
            facts.module_refs.push(value.to_string());
        }
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        walk(child, source, language, facts);
    }
}

fn parse_file(file: &SourceFile, language: Language) -> Result<RawFile, GraphError> {
    let mut parser = Parser::new();
    parser
        .set_language(&language.parser_language())
        .map_err(|error| GraphError::invalid(format!("could not load parser: {error}")))?;
    let tree = parser
        .parse(&file.content, None)
        .ok_or_else(|| GraphError::invalid(format!("could not parse {}", file.path)))?;
    let mut facts = RawFile {
        path: file.path.clone(),
        symbols: Vec::new(),
        imports: Vec::new(),
        calls: Vec::new(),
        inherits: Vec::new(),
        module_refs: Vec::new(),
        identifier_counts: HashMap::new(),
        parse_error: tree.root_node().has_error(),
    };
    walk(
        tree.root_node(),
        file.content.as_bytes(),
        language,
        &mut facts,
    );
    match language {
        Language::Python => {
            for capture in PY_CLASS_RE.captures_iter(&file.content) {
                facts
                    .inherits
                    .extend(capture[1].split(',').filter_map(imported_name));
            }
        }
        Language::Scala => {
            for capture in SCALA_CLASS_RE.captures_iter(&file.content) {
                facts
                    .inherits
                    .extend(capture[1].split(" with ").filter_map(imported_name));
            }
        }
    }
    facts.symbols.sort();
    facts.symbols.dedup();
    facts.calls.sort();
    facts.calls.dedup();
    facts.inherits.sort();
    facts.inherits.dedup();
    facts.module_refs.sort();
    facts.module_refs.dedup();
    for value in identifiers(&file.content) {
        *facts.identifier_counts.entry(value).or_default() += 1;
    }
    Ok(facts)
}

fn normalize(path: &Path) -> String {
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                parts.pop();
            }
            Component::Normal(part) => parts.push(part.to_string_lossy().to_string()),
            _ => {}
        }
    }
    parts.join("/")
}

fn resolve_python_module(from: &str, module: &str, files: &HashSet<String>) -> Option<String> {
    let leading = module
        .chars()
        .take_while(|character| *character == '.')
        .count();
    let tail = module.trim_start_matches('.').replace('.', "/");
    let base = if leading > 0 {
        let mut parent = Path::new(from)
            .parent()
            .unwrap_or(Path::new(""))
            .to_path_buf();
        for _ in 1..leading {
            parent = parent.parent().unwrap_or(Path::new("")).to_path_buf();
        }
        parent.join(tail)
    } else {
        PathBuf::from(tail)
    };
    let value = normalize(&base);
    [format!("{value}.py"), format!("{value}/__init__.py")]
        .into_iter()
        .find(|candidate| files.contains(candidate))
}

fn resolve_scala_module(module: &str, files: &HashSet<String>) -> Option<String> {
    let suffix = module.replace('.', "/");
    let exact = format!("{suffix}.scala");
    if files.contains(&exact) {
        return Some(exact);
    }
    files.iter().find(|path| path.ends_with(&exact)).cloned()
}

fn first_identifier(value: &str) -> Option<&str> {
    IDENT_RE.find(value).map(|matched| matched.as_str())
}

fn last_identifier(value: &str) -> Option<&str> {
    IDENT_RE
        .find_iter(value)
        .last()
        .map(|matched| matched.as_str())
}

fn push_edge(
    edges: &mut Vec<EdgeOutput>,
    seen: &mut HashSet<String>,
    from: &str,
    to: &str,
    edge_type: &str,
    label: &str,
    confidence: &str,
) {
    if from == to {
        return;
    }
    let key = format!("{from}|{to}|{edge_type}|{label}");
    if seen.insert(key) {
        edges.push(EdgeOutput {
            from: from.to_string(),
            to: to.to_string(),
            edge_type: edge_type.to_string(),
            label: label.to_string(),
            confidence: confidence.to_string(),
        });
    }
}

pub fn healthcheck(port: u16) -> Result<(), String> {
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::time::Duration;

    let mut stream = TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}")
            .parse()
            .map_err(|error| format!("invalid health address: {error}"))?,
        Duration::from_secs(2),
    )
    .map_err(|error| format!("health connection failed: {error}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .map_err(|error| error.to_string())?;
    stream
        .write_all(b"GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        .map_err(|error| error.to_string())?;
    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|error| error.to_string())?;
    if response.starts_with("HTTP/1.1 200") {
        Ok(())
    } else {
        Err("health endpoint did not return 200".to_string())
    }
}
