use crate::{GraphError, SourceFile};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap},
    sync::LazyLock,
    time::Instant,
};
use tree_sitter::{Node, Parser};

static GITHUB_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)https?://github\.com/([a-z0-9_.-]+)/([a-z0-9_.-]+?)(?:\.git)?(?:[/#?\s)\]}>.,;]|$)",
    )
    .unwrap()
});
static QUOTED_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"["']([^"']+)["']"#).unwrap());
static URL_HOST_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^[a-z][a-z0-9+.-]*://([^/:?#]+)").unwrap());
static CONFIG_VALUE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?i)\b(?:base[_-]?url|url|endpoint|host|hostname|service|channel|target|upstream)\b["']?\s*[:=]\s*["']?([^"',}\]\s]+)"#,
    )
    .unwrap()
});

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RepositorySnapshot {
    pub id: String,
    pub files: Vec<SourceFile>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RepositoryLinksRequest {
    pub repositories: Vec<RepositorySnapshot>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct RepositoryLinkEvidence {
    pub file: String,
    pub line: usize,
    pub kind: String,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct RepositoryLink {
    pub from: String,
    pub to: String,
    pub relation: String,
    pub confidence: String,
    pub evidence: Vec<RepositoryLinkEvidence>,
}

#[derive(Clone, Debug, Serialize)]
pub struct RepositoryLinkStats {
    pub repositories: usize,
    pub source_files: usize,
    pub links: usize,
    pub build_ms: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct RepositoryLinksOutput {
    pub stats: RepositoryLinkStats,
    pub links: Vec<RepositoryLink>,
}

#[derive(Default)]
struct AliasIndex {
    owners: HashMap<String, Option<String>>,
}

impl AliasIndex {
    fn from_repositories(repositories: &[RepositorySnapshot]) -> Self {
        let mut index = Self::default();
        for repository in repositories {
            let name = repository.id.rsplit('/').next().unwrap_or(&repository.id);
            for alias in service_aliases(name) {
                index.insert(alias, &repository.id);
            }
        }
        index
    }

    fn insert(&mut self, alias: String, repository: &str) {
        match self.owners.get_mut(&alias) {
            None => {
                self.owners.insert(alias, Some(repository.to_string()));
            }
            Some(owner) if owner.as_deref() != Some(repository) => *owner = None,
            Some(_) => {}
        }
    }

    fn resolve(&self, alias: &str) -> Option<&str> {
        self.owners
            .get(&normalize_alias(alias))
            .and_then(Option::as_deref)
    }
}

fn normalize_alias(value: &str) -> String {
    value
        .trim()
        .trim_matches(|character: char| !character.is_ascii_alphanumeric())
        .to_ascii_lowercase()
        .replace(['_', ' '], "-")
}

fn service_aliases(name: &str) -> Vec<String> {
    let normalized = normalize_alias(name);
    let mut aliases = vec![normalized.clone()];
    if normalized.ends_with("ies") && normalized.len() > 3 {
        aliases.push(format!("{}y", &normalized[..normalized.len() - 3]));
    } else if normalized.ends_with('s') && !normalized.ends_with("ss") && normalized.len() > 1 {
        aliases.push(normalized[..normalized.len() - 1].to_string());
    } else if !normalized.is_empty() {
        aliases.push(format!("{normalized}s"));
    }
    aliases.sort();
    aliases.dedup();
    aliases
}

fn annotation_can_name_service(name: &str) -> bool {
    let lowered = name.to_ascii_lowercase();
    [
        "channel", "client", "endpoint", "feign", "grpc", "host", "rest", "service",
    ]
    .iter()
    .any(|signal| lowered.contains(signal))
}

fn value_alias(value: &str) -> Option<String> {
    if let Some(capture) = URL_HOST_RE.captures(value) {
        let host = capture.get(1)?.as_str();
        return host.split('.').next().map(normalize_alias);
    }
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.len() > 120
        || !trimmed
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "-_.".contains(character))
    {
        return None;
    }
    trimmed.split('.').next().map(normalize_alias)
}

fn node_text<'a>(node: Node<'a>, source: &'a [u8]) -> &'a str {
    node.utf8_text(source).unwrap_or("")
}

fn single_line(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn walk_java_annotations(
    node: Node<'_>,
    source: &[u8],
    file: &SourceFile,
    source_repository: &str,
    aliases: &AliasIndex,
    links: &mut LinkAccumulator,
) {
    if node.kind() == "annotation" {
        let annotation_name = node
            .child_by_field_name("name")
            .map(|child| node_text(child, source))
            .or_else(|| node.named_child(0).map(|child| node_text(child, source)))
            .unwrap_or("");
        if annotation_can_name_service(annotation_name) {
            let text = node_text(node, source);
            for capture in QUOTED_RE.captures_iter(text) {
                let Some(alias) = value_alias(&capture[1]) else {
                    continue;
                };
                let Some(target) = aliases.resolve(&alias) else {
                    continue;
                };
                links.add(
                    source_repository,
                    target,
                    "CALLS_SERVICE",
                    RepositoryLinkEvidence {
                        file: file.path.clone(),
                        line: node.start_position().row + 1,
                        kind: "java_annotation".to_string(),
                        text: single_line(text),
                    },
                );
            }
        }
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        walk_java_annotations(child, source, file, source_repository, aliases, links);
    }
}

fn extract_java_links(
    file: &SourceFile,
    source_repository: &str,
    aliases: &AliasIndex,
    links: &mut LinkAccumulator,
) -> Result<(), GraphError> {
    let mut parser = Parser::new();
    parser
        .set_language(&tree_sitter_java::LANGUAGE.into())
        .map_err(|error| GraphError::invalid(format!("could not load Java parser: {error}")))?;
    let tree = parser
        .parse(&file.content, None)
        .ok_or_else(|| GraphError::invalid(format!("could not parse {}", file.path)))?;
    walk_java_annotations(
        tree.root_node(),
        file.content.as_bytes(),
        file,
        source_repository,
        aliases,
        links,
    );
    Ok(())
}

fn extract_config_links(
    file: &SourceFile,
    source_repository: &str,
    aliases: &AliasIndex,
    links: &mut LinkAccumulator,
) {
    let extension = file.path.rsplit('.').next().unwrap_or("");
    if !matches!(
        extension,
        "conf" | "env" | "json" | "properties" | "toml" | "xml" | "yaml" | "yml"
    ) {
        return;
    }
    for (index, line) in file.content.lines().enumerate() {
        for capture in CONFIG_VALUE_RE.captures_iter(line) {
            let Some(alias) = value_alias(&capture[1]) else {
                continue;
            };
            let Some(target) = aliases.resolve(&alias) else {
                continue;
            };
            links.add(
                source_repository,
                target,
                "CALLS_SERVICE",
                RepositoryLinkEvidence {
                    file: file.path.clone(),
                    line: index + 1,
                    kind: "configuration".to_string(),
                    text: line.trim().to_string(),
                },
            );
        }
    }
}

fn extract_repository_references(
    file: &SourceFile,
    source_repository: &str,
    repository_ids: &HashMap<String, String>,
    links: &mut LinkAccumulator,
) {
    for capture in GITHUB_RE.captures_iter(&file.content) {
        let canonical = format!(
            "{}/{}",
            capture[1].to_ascii_lowercase(),
            capture[2]
                .trim_end_matches(".git")
                .trim_end_matches(['.', ',', ';'])
                .to_ascii_lowercase()
        );
        let Some(target) = repository_ids.get(&canonical) else {
            continue;
        };
        let matched = capture.get(0).expect("full repository URL match");
        let line = file.content[..matched.start()]
            .bytes()
            .filter(|byte| *byte == b'\n')
            .count()
            + 1;
        links.add(
            source_repository,
            target,
            "REPOSITORY",
            RepositoryLinkEvidence {
                file: file.path.clone(),
                line,
                kind: "repository_url".to_string(),
                text: matched
                    .as_str()
                    .trim_end_matches(['.', ',', ';'])
                    .to_string(),
            },
        );
    }
}

#[derive(Default)]
struct LinkAccumulator {
    evidence: BTreeMap<(String, String, String), Vec<RepositoryLinkEvidence>>,
}

impl LinkAccumulator {
    fn add(&mut self, from: &str, to: &str, relation: &str, evidence: RepositoryLinkEvidence) {
        if from == to {
            return;
        }
        let values = self
            .evidence
            .entry((from.to_string(), to.to_string(), relation.to_string()))
            .or_default();
        if !values.contains(&evidence) {
            values.push(evidence);
        }
    }

    fn finish(self) -> Vec<RepositoryLink> {
        self.evidence
            .into_iter()
            .map(|((from, to, relation), mut evidence)| {
                evidence.sort_by(|left, right| {
                    (&left.file, left.line, &left.kind).cmp(&(&right.file, right.line, &right.kind))
                });
                RepositoryLink {
                    from,
                    to,
                    relation,
                    confidence: "exact".to_string(),
                    evidence,
                }
            })
            .collect()
    }
}

pub fn extract_repository_links(
    request: RepositoryLinksRequest,
) -> Result<RepositoryLinksOutput, GraphError> {
    let started = Instant::now();
    let aliases = AliasIndex::from_repositories(&request.repositories);
    let repository_ids: HashMap<String, String> = request
        .repositories
        .iter()
        .map(|repository| (repository.id.to_ascii_lowercase(), repository.id.clone()))
        .collect();
    let source_files = request
        .repositories
        .iter()
        .map(|repository| repository.files.len())
        .sum();
    let mut links = LinkAccumulator::default();
    for repository in &request.repositories {
        for file in &repository.files {
            extract_repository_references(file, &repository.id, &repository_ids, &mut links);
            if file.path.ends_with(".java") {
                extract_java_links(file, &repository.id, &aliases, &mut links)?;
            } else {
                extract_config_links(file, &repository.id, &aliases, &mut links);
            }
        }
    }
    let links = links.finish();
    Ok(RepositoryLinksOutput {
        stats: RepositoryLinkStats {
            repositories: request.repositories.len(),
            source_files,
            links: links.len(),
            build_ms: started.elapsed().as_secs_f64() * 1000.0,
        },
        links,
    })
}
