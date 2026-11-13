import {
  type ConnectorDocument,
  ConnectorError,
  type ConnectorFetcher,
  type ConnectorSource,
  type SourcePullCapability,
} from "@doco/plugin-runtime";

const API = "https://slack.com/api";

interface SlackResponse {
  ok?: boolean;
  error?: string;
  response_metadata?: { next_cursor?: string };
}

interface SlackChannel {
  id?: string;
  name?: string;
  is_channel?: boolean;
  is_private?: boolean;
  is_archived?: boolean;
  is_shared?: boolean;
  is_ext_shared?: boolean;
}

interface SlackUser {
  id?: string;
  real_name?: string;
  profile?: { display_name?: string; real_name?: string };
}

interface SlackMessage {
  ts?: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  username?: string;
  text?: string;
  reply_count?: number;
  edited?: { ts?: string };
}

async function slackJson<T extends SlackResponse>(
  fetcher: ConnectorFetcher,
  method: string,
  credential: string,
  params: Record<string, string> = {},
): Promise<T> {
  const url = new URL(`${API}/${method}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetcher(url, {
    headers: { Authorization: `Bearer ${credential}`, "User-Agent": "doco-self-hosted" },
  });
  if (!response.ok) {
    throw new ConnectorError(
      `Slack returned HTTP ${response.status}.`,
      "slack_request_failed",
      502,
    );
  }
  const value = (await response.json()) as T;
  if (!value.ok) {
    const rejected = value.error === "invalid_auth" || value.error === "account_inactive";
    throw new ConnectorError(
      rejected
        ? "Slack rejected the bot token."
        : `Slack could not complete ${method}${value.error ? `: ${value.error}` : "."}`,
      "slack_request_failed",
      502,
    );
  }
  return value;
}

async function* paged<T extends SlackResponse, Item>(
  fetcher: ConnectorFetcher,
  method: string,
  credential: string,
  field: keyof T,
  params: Record<string, string> = {},
): AsyncGenerator<Item> {
  let cursor = "";
  let count = 0;
  for (let page = 0; page < 500; page += 1) {
    const value = await slackJson<T>(fetcher, method, credential, {
      ...params,
      limit: "200",
      ...(cursor ? { cursor } : {}),
    });
    const items = value[field];
    if (!Array.isArray(items)) {
      throw new ConnectorError(
        `Slack returned an invalid ${field.toString()} list.`,
        "source_invalid",
        502,
      );
    }
    for (const item of items) {
      count += 1;
      if (count > 100_000) {
        throw new ConnectorError(
          "Slack pagination exceeded 100,000 records.",
          "source_too_large",
          422,
        );
      }
      yield item as Item;
    }
    cursor = value.response_metadata?.next_cursor?.trim() ?? "";
    if (!cursor) return;
  }
  throw new ConnectorError("Slack pagination exceeded 100,000 records.", "source_too_large", 422);
}

function slackTime(value: string): string {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) {
    throw new ConnectorError("Slack returned an invalid message timestamp.", "source_invalid", 502);
  }
  return new Date(seconds * 1000).toISOString();
}

function teamUrl(source: ConnectorSource): string {
  const configured = source.config?.team_url;
  if (typeof configured !== "string" || !configured.startsWith("https://")) {
    throw new ConnectorError("The Slack workspace URL is missing.", "source_invalid", 502);
  }
  return configured.replace(/\/$/, "");
}

async function verify(input: {
  credential: string;
  fetcher: ConnectorFetcher;
}): Promise<ConnectorSource> {
  const value = await slackJson<SlackResponse & { team_id?: string; team?: string; url?: string }>(
    input.fetcher,
    "auth.test",
    input.credential,
  );
  if (!value.team_id || !value.team || !value.url) {
    throw new ConnectorError(
      "Slack returned an incomplete workspace identity.",
      "source_invalid",
      502,
    );
  }
  return {
    id: value.team_id,
    name: value.team,
    config: { team_url: value.url },
  };
}

function messageDocument(
  input: { source: ConnectorSource },
  channel: SlackChannel & { id: string; name: string },
  message: SlackMessage,
  names: Map<string, string>,
): ConnectorDocument | null {
  const text = message.text?.trim();
  if (!message.ts || !text) return null;
  const externalId = `${channel.id}:${message.ts}`;
  const authorId = message.user ?? message.bot_id ?? message.username ?? "unknown";
  const author = names.get(authorId) ?? message.username ?? authorId;
  const postedAt = slackTime(message.ts);
  const updatedAt = message.edited?.ts ? slackTime(message.edited.ts) : postedAt;
  return {
    externalId,
    title: `#${channel.name} · ${author} · ${postedAt}`,
    content: `${author}: ${text}`,
    url: `${teamUrl(input.source)}/archives/${channel.id}/p${message.ts.replace(".", "")}`,
    createdAt: postedAt,
    updatedAt,
    metadata: {
      channel_id: channel.id,
      channel_name: channel.name,
      author_id: authorId,
      author_name: author,
      thread_ts: message.thread_ts ?? null,
    },
  };
}

async function* documents(input: {
  credential: string;
  source: ConnectorSource;
  fetcher: ConnectorFetcher;
}): AsyncGenerator<ConnectorDocument> {
  type UsersResponse = SlackResponse & { members?: SlackUser[] };
  type ChannelsResponse = SlackResponse & { channels?: SlackChannel[] };
  type MessagesResponse = SlackResponse & { messages?: SlackMessage[] };
  const names = new Map<string, string>();
  for await (const user of paged<UsersResponse, SlackUser>(
    input.fetcher,
    "users.list",
    input.credential,
    "members",
  )) {
    if (!user.id) continue;
    names.set(
      user.id,
      user.profile?.display_name?.trim() ||
        user.profile?.real_name?.trim() ||
        user.real_name?.trim() ||
        user.id,
    );
  }

  const seen = new Set<string>();
  for await (const channel of paged<ChannelsResponse, SlackChannel>(
    input.fetcher,
    "conversations.list",
    input.credential,
    "channels",
    { types: "public_channel", exclude_archived: "true" },
  )) {
    if (
      !channel.id ||
      !channel.name ||
      channel.is_channel === false ||
      channel.is_private ||
      channel.is_archived ||
      channel.is_shared ||
      channel.is_ext_shared
    ) {
      continue;
    }
    const publicChannel = channel as SlackChannel & { id: string; name: string };
    for await (const root of paged<MessagesResponse, SlackMessage>(
      input.fetcher,
      "conversations.history",
      input.credential,
      "messages",
      { channel: publicChannel.id, inclusive: "true" },
    )) {
      const rootDocument = messageDocument(input, publicChannel, root, names);
      if (rootDocument && !seen.has(rootDocument.externalId)) {
        seen.add(rootDocument.externalId);
        yield rootDocument;
      }
      if (!root.ts || !root.reply_count || root.reply_count < 1) continue;
      for await (const reply of paged<MessagesResponse, SlackMessage>(
        input.fetcher,
        "conversations.replies",
        input.credential,
        "messages",
        { channel: publicChannel.id, ts: root.ts, inclusive: "true" },
      )) {
        const replyDocument = messageDocument(input, publicChannel, reply, names);
        if (replyDocument && !seen.has(replyDocument.externalId)) {
          seen.add(replyDocument.externalId);
          yield replyDocument;
        }
      }
    }
  }
}

export const slackConnector: SourcePullCapability = {
  provider: "slack",
  verify,
  documents,
};
