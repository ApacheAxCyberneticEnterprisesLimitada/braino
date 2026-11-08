import {
  type ConnectorAdapter,
  type ConnectorDocument,
  ConnectorError,
  type ConnectorFetcher,
  type ConnectorSource,
} from "../connectors.js";

const API = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";

interface NotionList<T> {
  object?: string;
  results?: T[];
  has_more?: boolean;
  next_cursor?: string | null;
}

interface NotionPage {
  object?: string;
  id?: string;
  created_time?: string;
  last_edited_time?: string;
  in_trash?: boolean;
  archived?: boolean;
  url?: string;
  properties?: Record<string, NotionProperty>;
}

interface NotionProperty {
  type?: string;
  [key: string]: unknown;
}

interface NotionBlock {
  object?: string;
  id?: string;
  type?: string;
  has_children?: boolean;
  [key: string]: unknown;
}

interface RichText {
  plain_text?: string;
  href?: string | null;
}

async function notionJson<T>(
  fetcher: ConnectorFetcher,
  path: string,
  credential: string,
  init: { method?: "GET" | "POST"; body?: Record<string, unknown> } = {},
): Promise<T> {
  const response = await fetcher(`${API}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${credential}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      "User-Agent": "doco-self-hosted",
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
  if (!response.ok) {
    let detail = "";
    try {
      const value = (await response.json()) as { message?: unknown };
      detail = typeof value.message === "string" ? `: ${value.message}` : "";
    } catch {
      // The status is still enough to produce an operator-safe error.
    }
    throw new ConnectorError(
      response.status === 401 || response.status === 403
        ? "Notion rejected the integration token or cannot read the shared pages."
        : `Notion returned HTTP ${response.status}${detail}.`,
      "notion_request_failed",
      502,
    );
  }
  return (await response.json()) as T;
}

function richText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((item) => {
      const text = item as RichText;
      const plain = typeof text.plain_text === "string" ? text.plain_text : "";
      return plain && text.href ? `[${plain}](${text.href})` : plain;
    })
    .join("");
}

function named(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const name = (value as { name?: unknown }).name;
  return typeof name === "string" ? name : "";
}

function propertyText(property: NotionProperty): string {
  const type = property.type;
  if (!type) return "";
  const value = property[type];
  if (type === "title" || type === "rich_text") return richText(value);
  if (type === "select" || type === "status") return named(value);
  if (type === "multi_select" && Array.isArray(value))
    return value.map(named).filter(Boolean).join(", ");
  if (type === "people" && Array.isArray(value)) return value.map(named).filter(Boolean).join(", ");
  if (type === "relation" && Array.isArray(value)) {
    return value
      .map((entry) =>
        entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string"
          ? String((entry as { id: string }).id)
          : "",
      )
      .filter(Boolean)
      .join(", ");
  }
  if (type === "date" && value && typeof value === "object") {
    const date = value as { start?: unknown; end?: unknown };
    const start = typeof date.start === "string" ? date.start : "";
    const end = typeof date.end === "string" ? date.end : "";
    return end ? `${start} – ${end}` : start;
  }
  if (type === "formula" && value && typeof value === "object") {
    const formula = value as Record<string, unknown>;
    const formulaType = typeof formula.type === "string" ? formula.type : "";
    return formulaType && formula[formulaType] != null ? String(formula[formulaType]) : "";
  }
  if (type === "rollup" && value && typeof value === "object") {
    const rollup = value as Record<string, unknown>;
    const rollupType = typeof rollup.type === "string" ? rollup.type : "";
    return rollupType && rollup[rollupType] != null ? String(rollup[rollupType]) : "";
  }
  if (type === "files" && Array.isArray(value)) {
    return value
      .map((file) => {
        if (!file || typeof file !== "object") return "";
        const record = file as Record<string, unknown>;
        const fileType = typeof record.type === "string" ? record.type : "";
        const location =
          fileType && record[fileType] && typeof record[fileType] === "object"
            ? (record[fileType] as { url?: unknown }).url
            : null;
        return typeof location === "string" ? location : named(file);
      })
      .filter(Boolean)
      .join(", ");
  }
  if (["number", "checkbox", "url", "email", "phone_number"].includes(type)) {
    return value == null ? "" : String(value);
  }
  return "";
}

function pageTitle(page: NotionPage): string {
  for (const property of Object.values(page.properties ?? {})) {
    if (property.type === "title") {
      const title = propertyText(property).trim();
      if (title) return title;
    }
  }
  return "Untitled Notion page";
}

function pageProperties(page: NotionPage): string[] {
  return Object.entries(page.properties ?? {})
    .filter(([, property]) => property.type !== "title")
    .map(([name, property]) => [name, propertyText(property).trim()] as const)
    .filter((entry) => entry[1])
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}: ${value}`);
}

function blockData(block: NotionBlock): Record<string, unknown> {
  if (!block.type) return {};
  const value = block[block.type];
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function fileUrl(data: Record<string, unknown>): string {
  const type = typeof data.type === "string" ? data.type : "";
  const nested =
    type && data[type] && typeof data[type] === "object"
      ? (data[type] as { url?: unknown }).url
      : null;
  return typeof nested === "string" ? nested : "";
}

function renderBlock(block: NotionBlock): string {
  const data = blockData(block);
  const text = richText(data.rich_text).trim();
  switch (block.type) {
    case "heading_1":
      return `# ${text}`;
    case "heading_2":
      return `## ${text}`;
    case "heading_3":
      return `### ${text}`;
    case "bulleted_list_item":
      return `- ${text}`;
    case "numbered_list_item":
      return `1. ${text}`;
    case "to_do":
      return `- [${data.checked ? "x" : " "}] ${text}`;
    case "quote":
    case "callout":
      return `> ${text}`;
    case "toggle":
      return text ? `**${text}**` : "";
    case "code":
      return `\`\`\`${typeof data.language === "string" ? data.language : ""}\n${richText(data.rich_text)}\n\`\`\``;
    case "equation":
      return typeof data.expression === "string" ? `$$${data.expression}$$` : "";
    case "divider":
      return "---";
    case "bookmark":
    case "link_preview":
      return typeof data.url === "string" ? data.url : "";
    case "image":
    case "video":
    case "audio":
    case "file":
    case "pdf":
      return fileUrl(data);
    case "child_page":
    case "child_database":
      return typeof data.title === "string" ? `## ${data.title}` : "";
    case "table_row": {
      const cells = Array.isArray(data.cells) ? data.cells.map(richText) : [];
      return cells.length ? `| ${cells.join(" | ")} |` : "";
    }
    case "unsupported":
      return "";
    default:
      return text;
  }
}

async function blockChildren(
  fetcher: ConnectorFetcher,
  credential: string,
  blockId: string,
): Promise<NotionBlock[]> {
  const blocks: NotionBlock[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 1_000; page += 1) {
    const query = new URLSearchParams({ page_size: "100" });
    if (cursor) query.set("start_cursor", cursor);
    const value = await notionJson<NotionList<NotionBlock>>(
      fetcher,
      `/blocks/${encodeURIComponent(blockId)}/children?${query}`,
      credential,
    );
    if (!Array.isArray(value.results)) {
      throw new ConnectorError("Notion returned an invalid block list.", "source_invalid", 502);
    }
    blocks.push(...value.results);
    cursor = value.has_more && value.next_cursor ? value.next_cursor : null;
    if (!cursor) return blocks;
  }
  throw new ConnectorError("A Notion page exceeded 100,000 blocks.", "source_too_large", 422);
}

async function renderChildren(
  fetcher: ConnectorFetcher,
  credential: string,
  blockId: string,
  depth = 0,
): Promise<string[]> {
  if (depth > 32) {
    throw new ConnectorError(
      "A Notion page exceeded 32 nested block levels.",
      "source_too_large",
      422,
    );
  }
  const rendered: string[] = [];
  for (const block of await blockChildren(fetcher, credential, blockId)) {
    const line = renderBlock(block).trim();
    if (line) rendered.push(line);
    if (block.has_children && block.id) {
      rendered.push(...(await renderChildren(fetcher, credential, block.id, depth + 1)));
    }
  }
  return rendered;
}

async function verify(input: {
  credential: string;
  fetcher: ConnectorFetcher;
}): Promise<ConnectorSource> {
  const user = await notionJson<{
    id?: string;
    name?: string | null;
    bot?: { workspace_id?: string; workspace_name?: string | null };
  }>(input.fetcher, "/users/me", input.credential);
  if (!user.id) {
    throw new ConnectorError(
      "Notion returned an invalid integration identity.",
      "source_invalid",
      502,
    );
  }
  return {
    id: user.bot?.workspace_id?.trim() || user.id,
    name: user.bot?.workspace_name?.trim() || user.name?.trim() || "Notion workspace",
    config: { bot_id: user.id },
  };
}

async function listPages(fetcher: ConnectorFetcher, credential: string): Promise<NotionPage[]> {
  const pages: NotionPage[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 1_000; page += 1) {
    const value: NotionList<NotionPage> = await notionJson<NotionList<NotionPage>>(
      fetcher,
      "/search",
      credential,
      {
        method: "POST",
        body: {
          page_size: 100,
          filter: { property: "object", value: "page" },
          sort: { direction: "descending", timestamp: "last_edited_time" },
          ...(cursor ? { start_cursor: cursor } : {}),
        },
      },
    );
    if (!Array.isArray(value.results)) {
      throw new ConnectorError("Notion returned an invalid page list.", "source_invalid", 502);
    }
    pages.push(...value.results);
    cursor = value.has_more && value.next_cursor ? value.next_cursor : null;
    if (!cursor) return pages;
  }
  throw new ConnectorError("Notion pagination exceeded 100,000 pages.", "source_too_large", 422);
}

async function listDocuments(input: {
  credential: string;
  source: ConnectorSource;
  fetcher: ConnectorFetcher;
}): Promise<ConnectorDocument[]> {
  const documents: ConnectorDocument[] = [];
  for (const page of await listPages(input.fetcher, input.credential)) {
    if (
      page.object !== "page" ||
      !page.id ||
      !page.url ||
      !page.created_time ||
      !page.last_edited_time ||
      page.in_trash ||
      page.archived
    ) {
      continue;
    }
    const title = pageTitle(page);
    const properties = pageProperties(page);
    const blocks = await renderChildren(input.fetcher, input.credential, page.id);
    documents.push({
      externalId: page.id,
      title,
      content: [...properties, ...blocks].join("\n\n").trim() || title,
      url: page.url,
      createdAt: page.created_time,
      updatedAt: page.last_edited_time,
      metadata: { property_names: Object.keys(page.properties ?? {}).sort() },
    });
  }
  return documents.sort((left, right) => left.externalId.localeCompare(right.externalId));
}

export const notionConnector: ConnectorAdapter = {
  provider: "notion",
  verify,
  listDocuments,
};
