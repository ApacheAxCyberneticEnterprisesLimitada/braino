#!/usr/bin/env node
// The Doco hook: one script that briefs an agent before it acts, for Claude
// Code, Codex and Gemini CLI, GitHub Copilot and Cursor. Served at
// /agents/doco-hook.mjs; a project keeps it at .doco/hook.mjs and names it in
// its client's hooks (lib/doco-hook-install.ts): Claude Code, Codex and Gemini
// CLI run `node .doco/hook.mjs`, and their events name themselves; Copilot runs
// `node .doco/hook.mjs copilot <event>`, since its events don't; Cursor runs
// `node .doco/hook.mjs cursor`. Every client's event becomes one of these:
//
//   A session's start (SessionStart; Copilot's and Cursor's sessionStart):
//     Doco's instructions for agents, opened in a new thread by the line
//     asking the agent to first ask the user whether to use Doco for it,
//     recommending the project's workspace (decision_01M5DTG8JAH9SJ8WC79MG4HBEJ;
//     a resumed or compacted thread keeps its answer); then the workspace's
//     standing orders, with what changed since the last session started from
//     this project; on Copilot, a brief about the task it started with.
//   A prompt (UserPromptSubmit in Claude Code and Codex, BeforeAgent in
//     Gemini CLI): the reminder line, then a brief about the prompt.
//   A file (PreToolUse on Edit, Write or MultiEdit in Claude Code and Codex;
//     Copilot's postToolUse after an edit): a brief on the file, once per
//     session and file.
//   The end of a turn (Copilot's agentStop; Cursor's stop after a turn that
//     edited files): once, the line asking the agent to record what the
//     workspace's constitution asks before it stops, as another turn.
//   Cursor's cloud agents run no sessionStart and let no hook add to a
//     prompt, so Cursor's beforeSubmitPrompt only keeps the prompt, and the
//     first postToolUse after it brings what the start would have (the first
//     of the conversation) and the prompt's brief (the first of the turn).
//   prepare-commit-msg (git): the commit stamp below.
//   commit-msg (git): the commit gate below.
//
// Copilot and Cursor also read Claude Code's settings beside their own, so a
// project with both files hears of one event twice: Cursor's run of Claude
// Code's settings adds nothing, and a session's start counts once a minute.
//
// The commit stamp (decision_01M653M1AH6JN4VHH04ZQMG4MR; Alexander,
// 2026-10-29, "Spot agents committing without Doco"): a brief Doco can open
// again ends with the `Doco-Brief:` line each commit after it carries. The hook remembers the latest one for the project,
// and at session start installs a prepare-commit-msg git hook in the checkout
// that runs this script, which ends each commit message made within two hours
// of that brief with the line, so the pull request shows the work went
// through Doco. Only in the checkout's own hooks folder, and never over a
// prepare-commit-msg it didn't write; delete the git hook to stop it. A
// commit with an empty message stays empty, and a failing stamp never stops a
// commit.
//
// The commit gate (Alexander, 2026-11-04, "Find options more reliable than
// agents.md"): for an agent that runs no hook, nothing stamps its commits and
// nothing briefs it, so a project can choose to refuse its commits instead.
// `node <this script> install-commit-gate`, run once in a checkout (a cloud
// environment's setup script runs it for every task), installs a commit-msg
// git hook, on the same terms as the stamp's. A commit whose message ends with
// a `Doco-Brief:` line passes, as does one made within two hours of a brief,
// which the gate stamps with that brief's line. Any other is stopped once:
// the gate briefs the agent on what the commit says and the files it stages,
// prints the brief, and remembers its line, so the same commit tried again,
// once the agent has read the brief and recorded what it asks, passes with
// the line. A merge passes. Without a token the gate stops the commit and
// says how to give it one; when Doco can't be reached, the commit passes.
//
// The instructions and the reminder line come from GET
// <origin>/agents/instructions.md?at=…, which Doco serves to anyone, so the
// hook holds no wording of its own and a project never saves it again for a
// change of words (Alexander, 2026-10-07: with the hook, forget about
// AGENTS.md; 2026-10-21: the hook's lines too). The brief comes from GET
// <origin>/api/v1/brief.json (the standing orders from
// /api/v1/standing-orders.json) with a hook token (.doco/hook-tokens.json
// keyed by workspace handle, or DOCO_TOKEN) or an OAuth token (DOCO_ACCESS).
// The workspace and the origin come from the URL in the project's
// .doco/workspace, or DOCO_WORKSPACE and DOCO_ORIGIN. The output is the JSON
// each client reads: hookSpecificOutput.additionalContext for Claude Code,
// Codex and Gemini CLI, additionalContext (a stop's decision and reason) for
// Copilot, additional_context (a stop's followup_message) for Cursor. Without a
// token (the file stays out of git, so a fresh clone has none), or with one
// Doco refuses (revoked, or a project token from before hook tokens), it tells
// the agent to get its person's from Doco's doco_hook_token, at session start
// and after the reminder on a prompt. Anything that fails, including the
// deadline, fails open: whatever of the two came; exit 0 either way. No
// dependencies; Node 18 or later.
//
// What leaves the machine: the workspace's handle and when the last session
// started, at a session's start; the first 2,000 characters of a prompt, before
// it; the path of a file, before it changes; the first 2,000 characters of a
// commit message and the paths it stages, when the gate stops it; each with
// the token, and nothing else. Without the token, only the workspace's handle,
// for the instructions of a new thread. The commit stamp sends nothing: its
// line leaves with the commits, by git, when they are pushed.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Where Doco serves its instructions for agents (AGENT_INSTRUCTIONS_TEXT_PATH in lib/agent-instructions.ts). */
export const INSTRUCTIONS_PATH = "/agents/instructions.md";

const DEFAULT_ORIGIN = "https://doco.to";
const PROMPT_BUDGET = 4000;
const FILE_BUDGET = 1500;
const ABOUT_MAX = 2000;
const DEFAULT_TIMEOUT_MS = 8000;
/** A file's brief holds for the session this long before it is fetched again. */
const FILE_BRIEF_TTL_MS = 30 * 60_000;
/** The SessionStart sources that go on with a thread rather than start one. */
const RESUMED_SOURCES = new Set(["resume", "compact"]);
const PROMPT_EVENTS = new Set(["UserPromptSubmit", "BeforeAgent"]);
/** The tools whose use changes a file, by the names Copilot and Cursor give them. */
const EDIT_TOOLS = /edit|write|create|replace|patch/i;
/** Two runs of one session's start within this long are one start. */
const SAME_START_MS = 60_000;
/** How long the hook remembers that a conversation or a turn got what it gets once. */
const ONCE_MS = 12 * 60 * 60_000;
/** A brief stamps the commits made in its checkout for this long. */
const STAMP_TTL_MS = 2 * 60 * 60_000;
/** The line a brief ends with for the commits after it (BRIEF_TRAILER in lib/brief/brief.ts). */
const STAMP_LINE = /^Doco-Brief: \S+$/m;
/** How the git hooks the stamp and the gate install know themselves. */
const STAMP_MARK = "Installed by the Doco hook";
/** The cut line of `git commit --verbose`: what follows is the diff. */
const SCISSORS = /^# -+ >8 -+$/;
/** The most staged paths the gate names in its brief. */
const GATE_PATHS = 50;

/** Walk up from `cwd` to the first directory holding one of `names`. */
function findUp(cwd, names) {
  let dir = resolve(cwd);
  for (;;) {
    for (const name of names) {
      const path = join(dir, name);
      if (existsSync(path)) return { dir, path };
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The project's workspace: the URL in its .doco/workspace. */
export function readProjectWorkspace(cwd) {
  const found = findUp(cwd, [join(".doco", "workspace")]);
  if (!found) return null;
  try {
    const url = new URL(readFileSync(found.path, "utf8").trim());
    const workspace = url.pathname.match(/\/workspaces\/([^/]+)/)?.[1] ?? null;
    return { root: found.dir, origin: url.origin, workspace };
  } catch {
    return { root: found.dir, origin: null, workspace: null };
  }
}

/** The token saved at .doco/hook-tokens.json, for the workspace or the only one. */
export function readHookToken(cwd, workspace) {
  const found = findUp(cwd, [join(".doco", "hook-tokens.json")]);
  if (!found) return null;
  try {
    const entries = Object.entries(JSON.parse(readFileSync(found.path, "utf8")));
    const named = entries.find(([key]) => key === workspace);
    const [, token] = named ?? (entries.length === 1 ? entries[0] : []);
    return typeof token === "string" && token ? token : null;
  } catch {
    return null;
  }
}

export function resolveConfig(env, cwd) {
  const project = readProjectWorkspace(cwd);
  const workspace = env.DOCO_WORKSPACE || project?.workspace || null;
  return {
    root: project?.root ?? resolve(cwd),
    origin: (env.DOCO_ORIGIN || project?.origin || DEFAULT_ORIGIN).replace(/\/+$/, ""),
    workspace,
    // The saved token first: it is the one doco_hook_token gave the agent.
    token: readHookToken(cwd, workspace) || env.DOCO_TOKEN || env.DOCO_ACCESS || null,
    timeoutMs: Number(env.DOCO_HOOK_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    budget: Number(env.DOCO_BRIEF_BUDGET) || PROMPT_BUDGET,
  };
}

const text = (value) => (typeof value === "string" ? value : "");

/** The path a tool's arguments name, as an object or a JSON string of one. */
function pathIn(args) {
  let value = args;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const raw = value?.file_path ?? value?.path ?? value?.target_file;
  return typeof raw === "string" && raw.trim() ? raw : null;
}

/**
 * One client's event as the hook acts on it, or null for one it leaves be:
 * `kind` is session, prompt, file, stop, prompt-seen or tool (both Cursor's),
 * with the session (`session`), the turn (`turn`, Cursor's generation),
 * whether a start resumes a thread (`resumed`), the prompt (`prompt`), the
 * file a tool changed or is about to (`path`), and whether a stop is one the
 * hook already sent back (`again`). `client` is the word the client's hook
 * settings pass the script, `named` the event Copilot names there.
 */
export function readEvent(raw, client = null, named = null) {
  if (!raw || typeof raw !== "object") return null;
  const roots = Array.isArray(raw.workspace_roots) ? raw.workspace_roots : [];
  const base = { cwd: text(raw.cwd) || text(roots[0]) || null };
  if (client === "copilot") {
    const session = text(raw.sessionId ?? raw.session_id) || null;
    if (named === "sessionStart") {
      return {
        ...base,
        kind: "session",
        session,
        resumed: raw.source === "resume",
        prompt: text(raw.initialPrompt).trim(),
      };
    }
    if (named === "postToolUse") {
      const path = EDIT_TOOLS.test(text(raw.toolName)) ? pathIn(raw.toolArgs) : null;
      return path ? { ...base, kind: "file", session, path } : null;
    }
    if (named === "agentStop") {
      return {
        ...base,
        kind: "stop",
        session,
        turn: session,
        again: raw.stop_hook_active === true,
      };
    }
    return null;
  }
  if (client === "cursor") {
    const session = text(raw.conversation_id) || null;
    const turn = text(raw.generation_id) || null;
    switch (raw.hook_event_name) {
      case "sessionStart":
        return { ...base, kind: "session", session, resumed: false, prompt: "" };
      case "beforeSubmitPrompt":
        return { ...base, kind: "prompt-seen", session, turn, prompt: text(raw.prompt).trim() };
      case "postToolUse":
        return {
          ...base,
          kind: "tool",
          session,
          turn,
          path: EDIT_TOOLS.test(text(raw.tool_name)) ? pathIn(raw.tool_input) : null,
        };
      case "stop":
        return {
          ...base,
          kind: "stop",
          session,
          turn,
          again: raw.status !== "completed" || Number(raw.loop_count) > 0,
        };
      default:
        return null;
    }
  }
  // Cursor runs Claude Code's settings too; its own .cursor/hooks.json serves it.
  if (raw.cursor_version) return null;
  const name = text(raw.hook_event_name);
  const session = text(raw.session_id) || null;
  if (name === "SessionStart") {
    return { ...base, kind: "session", session, resumed: RESUMED_SOURCES.has(text(raw.source)) };
  }
  if (PROMPT_EVENTS.has(name)) {
    return { ...base, kind: "prompt", session, prompt: text(raw.prompt).trim() };
  }
  if (name === "PreToolUse") {
    const path = pathIn(raw.tool_input);
    return path ? { ...base, kind: "file", session, path } : null;
  }
  return null;
}

/** Where the hook keeps what it remembers for this project and workspace. */
function projectFile(config, kind) {
  const key = createHash("sha1")
    .update(`${config.root}|${config.workspace ?? ""}`)
    .digest("hex");
  return join(tmpdir(), "doco-hook", kind, key);
}

/** When a session last started from this project and workspace, as the standing orders' `since`. */
function lastSeenFile(config) {
  return projectFile(config, "last-seen");
}

/** The latest brief's `Doco-Brief:` line for this project and workspace, written when it came. */
function stampFile(config) {
  return projectFile(config, "stamp");
}

/** What the hook keeps about one session or turn: a mark, or Cursor's prompt. */
function noteFile(kind, key) {
  return join(tmpdir(), "doco-hook", kind, createHash("sha1").update(key).digest("hex"));
}

/**
 * Whether this is the first time within `ttlMs` that `key` gets `kind`, which
 * it then marks; true when there is no key to tell. Two runs at once can't
 * both be first.
 */
export function once(kind, key, ttlMs) {
  if (!key) return true;
  const file = noteFile(kind, key);
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "", { flag: "wx" });
    return true;
  } catch (error) {
    if (error?.code !== "EEXIST") return true;
  }
  try {
    if (Date.now() - statSync(file).mtimeMs < ttlMs) return false;
    writeFileSync(file, "");
  } catch {
    /* counted as first */
  }
  return true;
}

function marked(kind, key, ttlMs) {
  if (!key) return false;
  try {
    return Date.now() - statSync(noteFile(kind, key)).mtimeMs < ttlMs;
  } catch {
    return false;
  }
}

function mark(kind, key) {
  if (!key) return;
  try {
    const file = noteFile(kind, key);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "");
  } catch {
    /* forgotten */
  }
}

/** Cursor's prompt, kept until a tool of the same turn can bring its brief. */
function keepPrompt(event) {
  if (!event.session) return;
  try {
    const file = noteFile("prompt", event.session);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ turn: event.turn, prompt: event.prompt }));
  } catch {
    /* the turn goes unbriefed */
  }
}

function keptPrompt(event) {
  try {
    const kept = JSON.parse(readFileSync(noteFile("prompt", event.session ?? ""), "utf8"));
    return kept.turn === event.turn ? text(kept.prompt) : "";
  } catch {
    return "";
  }
}

/** Remember the line a brief ends with, for the commits after it. */
function rememberStamp(config, brief) {
  const line = brief.match(STAMP_LINE)?.[0];
  if (!line) return;
  try {
    const file = stampFile(config);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, line);
  } catch {
    /* the commits go unstamped */
  }
}

/** The latest brief's line, while it still speaks for the commits. */
function freshStamp(config) {
  try {
    const file = stampFile(config);
    if (Date.now() - statSync(file).mtimeMs > STAMP_TTL_MS) return null;
    const line = readFileSync(file, "utf8").trim();
    return STAMP_LINE.test(line) ? line : null;
  } catch {
    return null;
  }
}

function git(cwd, ...args) {
  const run = spawnSync("git", args, { cwd, encoding: "utf8" });
  return run.status === 0 ? run.stdout.trim() : null;
}

/** What each git hook the Doco hook installs does, said in its file. */
const GIT_HOOKS = {
  "prepare-commit-msg":
    "ends each commit message made\n# here within two hours of a Doco brief with that brief's Doco-Brief line, so\n# the pull request shows the work went through Doco.",
  "commit-msg":
    "stops a commit that shows no\n# Doco brief once, and briefs the agent on it, so no work leaves this checkout\n# without going through Doco.",
};

/** A git hook the Doco hook installs: it runs this script, whatever it finds, and passes when it can't. */
function gitHook(name, script) {
  const path = script.replace(/\\/g, "/").replace(/'/g, "'\\''");
  return `#!/bin/sh
# ${STAMP_MARK} (${path}): ${GIT_HOOKS[name]} Delete this file to stop it.
script='${path}'
if [ -f "$script" ] && command -v node >/dev/null 2>&1; then
  exec node "$script" ${name} "$@"
fi
exit 0
`;
}

/**
 * Install one of the Doco hook's git hooks in the project's checkout: only in
 * the checkout's own hooks folder, never in one the project commits
 * (core.hooksPath), and never over a hook it didn't write. The path it
 * installed, or null.
 */
export function installGitHook(config, name, script = fileURLToPath(import.meta.url)) {
  const hooks = git(config.root, "rev-parse", "--git-path", "hooks");
  const common = git(config.root, "rev-parse", "--git-common-dir");
  if (!hooks || !common) return null;
  const dir = resolve(config.root, hooks);
  const inside = relative(resolve(config.root, common), dir);
  if (inside.startsWith("..") || isAbsolute(inside)) return null;
  const path = join(dir, name);
  const hook = gitHook(name, script);
  let existing = null;
  try {
    existing = readFileSync(path, "utf8");
  } catch {
    /* none yet */
  }
  if (existing !== null && !existing.includes(STAMP_MARK)) return null;
  if (existing !== hook) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, hook);
  }
  chmodSync(path, 0o755);
  return path;
}

/** Whether a commit message says anything: a line that is no comment, before the diff. */
function saysSomething(message) {
  return said(message) !== "";
}

/** What a commit message says: its lines that are no comment, before the diff. */
function said(message) {
  const lines = [];
  for (const line of message.split("\n")) {
    if (SCISSORS.test(line)) break;
    if (!line.startsWith("#")) lines.push(line);
  }
  return lines.join("\n").trim();
}

/** End the commit message at `path` with `line`, one such line, replaced on an amend. */
function addStamp(cwd, path, line) {
  return (
    git(
      cwd,
      "interpret-trailers",
      "--in-place",
      "--if-exists",
      "replace",
      "--trailer",
      line,
      path,
    ) !== null
  );
}

/**
 * The git hook's work: end the commit message in `messageFile` with the
 * latest brief's line, when it came within two hours and the message says
 * something; one line, replaced by a later brief's on an amend.
 */
export function stampCommit(messageFile, env = process.env, cwd = process.cwd()) {
  if (!messageFile) return false;
  const line = freshStamp(resolveConfig(env, cwd));
  if (!line) return false;
  const path = resolve(cwd, messageFile);
  try {
    if (!saysSomething(readFileSync(path, "utf8"))) return false;
  } catch {
    return false;
  }
  return addStamp(cwd, path, line);
}

/**
 * The commit gate's verdict on the commit message in `messageFile`: whether
 * the commit may go on, and what to tell whoever made it (stderr). A message
 * with a `Doco-Brief:` line, an empty one (git refuses it anyway) and a merge
 * pass; so does one made within two hours of a brief, stamped with its line.
 * Any other gets a brief on what it says and what it stages, whose line the
 * gate remembers for the commit tried again, and is stopped.
 */
export async function gateCommit(messageFile, env = process.env, cwd = process.cwd()) {
  if (!messageFile) return { pass: true, say: null };
  const path = resolve(cwd, messageFile);
  let message;
  try {
    message = said(readFileSync(path, "utf8"));
  } catch {
    return { pass: true, say: null };
  }
  if (!message || STAMP_LINE.test(message)) return { pass: true, say: null };
  if (git(cwd, "rev-parse", "-q", "--verify", "MERGE_HEAD") !== null) {
    return { pass: true, say: null };
  }
  const config = resolveConfig(env, cwd);
  const line = freshStamp(config);
  if (line && addStamp(cwd, path, line)) return { pass: true, say: null };
  if (!config.token || !config.workspace) {
    return {
      pass: false,
      say: `Doco's commit gate stopped this commit: it shows no Doco brief, and the gate can't brief you without ${config.workspace ? "a token" : "the project's workspace"}. ${config.workspace ? `Call doco_hook_token for ${config.workspace} and save the token as it says, or set DOCO_TOKEN` : "Save the workspace's URL in .doco/workspace"}, then commit again. To turn the gate off here, delete .git/hooks/commit-msg.`,
    };
  }
  const staged = (git(cwd, "diff", "--cached", "--name-only") ?? "")
    .split("\n")
    .filter(Boolean)
    .slice(0, GATE_PATHS);
  const params = new URLSearchParams({ workspace: config.workspace, format: "text" });
  params.set("about", message.length > ABOUT_MAX ? message.slice(0, ABOUT_MAX) : message);
  for (const file of staged) params.append("touching", file);
  params.set("budget", String(config.budget));
  params.set("synthesize", "0");
  let fetched = null;
  try {
    fetched = await fetchText(`${config.origin}/api/v1/brief.json?${params}`, config, config.token);
  } catch {
    fetched = null;
  }
  if (fetched?.refused) {
    return {
      pass: false,
      say: `Doco's commit gate stopped this commit: Doco refused its token. Call doco_hook_token for ${config.workspace}, save the token as it says, then commit again.`,
    };
  }
  const brief = fetched?.text ?? null;
  if (!brief) {
    return {
      pass: true,
      say: "Doco's commit gate let this commit through without a brief: Doco didn't answer.",
    };
  }
  rememberStamp(config, brief);
  return {
    pass: false,
    say: `Doco's commit gate stopped this commit: nothing in it shows the work went through Doco. Here is Doco's brief on it. Obey it, record what the workspace's constitution asks with doco_capture, then make the same commit again: it will end with this brief's Doco-Brief line.\n\n${brief}`,
  };
}

function readLastSeen(config) {
  try {
    const seen = readFileSync(lastSeenFile(config), "utf8").trim();
    return Number.isNaN(Date.parse(seen)) ? null : seen;
  } catch {
    return null;
  }
}

/**
 * Where Doco serves what the hook tells the agent at a moment, before any
 * brief (agentInstructionsAt in lib/agent-instructions.ts): at a new thread's
 * start, the instructions opened by the question to ask first; at a resumed
 * one's, the instructions; before a prompt, the reminder line; at a turn's
 * end, the line asking to record what the turn did.
 */
export function leadUrl(at, config) {
  const params = new URLSearchParams({ at });
  if (at === "new-thread" && config.workspace) params.set("workspace", config.workspace);
  return `${config.origin}${INSTRUCTIONS_PATH}?${params}`;
}

/** The standing orders for a session's start, with what changed since the last start here. */
function standingOrders(config) {
  const params = new URLSearchParams();
  if (config.workspace) params.set("workspace", config.workspace);
  params.set("format", "text");
  const since = readLastSeen(config);
  if (since) params.set("since", since);
  return {
    url: `${config.origin}/api/v1/standing-orders.json?${params}`,
    cacheKey: null,
    marksSeen: true,
  };
}

/** A brief about a prompt or a task, or null for an empty one or a slash command. */
function promptBrief(prompt, config) {
  if (!prompt || prompt.startsWith("/")) return null;
  const params = new URLSearchParams();
  if (config.workspace) params.set("workspace", config.workspace);
  params.set("format", "text");
  params.set("about", prompt.length > ABOUT_MAX ? prompt.slice(0, ABOUT_MAX) : prompt);
  params.set("budget", String(config.budget));
  params.set("synthesize", "0");
  return { url: `${config.origin}/api/v1/brief.json?${params}`, cacheKey: null, marksSeen: false };
}

/** A brief on one file, once per session and file. */
function fileBrief(raw, config) {
  const path =
    isAbsolute(raw) && !relative(config.root, raw).startsWith("..")
      ? relative(config.root, raw)
      : raw;
  const params = new URLSearchParams();
  if (config.workspace) params.set("workspace", config.workspace);
  params.set("format", "text");
  params.set("touching", path);
  params.set("budget", String(Math.min(FILE_BUDGET, config.budget)));
  params.set("synthesize", "0");
  return {
    url: `${config.origin}/api/v1/brief.json?${params}`,
    cacheKey: `file:${path}`,
    marksSeen: false,
  };
}

/**
 * What the hook tells the agent at an event: the lines Doco serves anyone
 * (`leads`, fetched without the token) and what it asks Doco with the token
 * (`requests`), in the order they reach the agent, leads first. Marks what
 * an event gets once, so call it once per event.
 */
export function planFor(event, config) {
  // A turn is known within its session: Cursor's generation ids needn't be unique.
  const turn = event.turn ? `${event.session ?? ""}|${event.turn}` : null;
  const start = () => ({
    leads: [leadUrl(event.resumed ? "session" : "new-thread", config)],
    requests: [standingOrders(config)],
  });
  switch (event.kind) {
    case "session": {
      if (!once("start", event.session, SAME_START_MS)) return null;
      mark("lead", event.session);
      const plan = start();
      const task = promptBrief(event.prompt, config);
      if (task) plan.requests.push(task);
      return plan;
    }
    case "prompt": {
      const brief = promptBrief(event.prompt, config);
      return brief
        ? { leads: [leadUrl("prompt", config)], requests: [brief] }
        : { leads: [leadUrl("prompt", config)], requests: [] };
    }
    case "file":
      return { leads: [], requests: [fileBrief(event.path, config)] };
    case "prompt-seen":
      keepPrompt(event);
      return null;
    case "tool": {
      if (event.path) mark("edited", turn);
      const plan = { leads: [], requests: [] };
      if (once("lead", event.session, ONCE_MS)) {
        const first = start();
        plan.leads.push(...first.leads);
        plan.requests.push(...first.requests);
      }
      const prompt = keptPrompt(event);
      const brief = prompt && once("prompt", turn, ONCE_MS) ? promptBrief(prompt, config) : null;
      if (brief) {
        plan.leads.push(leadUrl("prompt", config));
        plan.requests.push(brief);
      }
      return plan.leads.length + plan.requests.length > 0 ? plan : null;
    }
    case "stop": {
      if (event.again || !config.workspace || !config.token) return null;
      // Cursor's turns only when they changed files; Copilot's task once.
      if (event.turn !== event.session && !marked("edited", turn, ONCE_MS)) return null;
      if (!once("stop", turn, ONCE_MS)) return null;
      return { leads: [leadUrl("stop", config)], requests: [] };
    }
    default:
      return null;
  }
}

/** The JSON a client reads from what the hook tells the agent, or null for nothing. */
export function render(client, raw, event, context) {
  if (!context) return null;
  if (client === "copilot") {
    return JSON.stringify(
      event.kind === "stop"
        ? { decision: "block", reason: context }
        : { additionalContext: context },
    );
  }
  if (client === "cursor") {
    return JSON.stringify(
      event.kind === "stop" ? { followup_message: context } : { additional_context: context },
    );
  }
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: raw.hook_event_name, additionalContext: context },
  });
}

function cacheFile(sessionId, cacheKey) {
  const dir = join(tmpdir(), "doco-hook", String(sessionId || "no-session"));
  return join(dir, `${createHash("sha1").update(cacheKey).digest("hex")}.txt`);
}

function freshInCache(path) {
  try {
    return Date.now() - statSync(path).mtimeMs < FILE_BRIEF_TTL_MS;
  } catch {
    return false;
  }
}

/** GET a text, with the token when one is given. */
async function fetchText(url, config, token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), Accept: "text/plain" },
      signal: controller.signal,
    });
    if (res.status === 401) return { refused: true };
    if (!res.ok) return null;
    const text = (await res.text()).trim();
    return text ? { text } : null;
  } finally {
    clearTimeout(timer);
  }
}

/** One of the plan's requests with the token: its text, null, or refused. */
async function ask(request, event, config) {
  const cache = request.cacheKey ? cacheFile(event.session, request.cacheKey) : null;
  if (cache && freshInCache(cache)) return { cached: true };
  let fetched = null;
  try {
    fetched = await fetchText(request.url, config, config.token);
  } catch (error) {
    process.stderr.write(`Doco hook: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  if (fetched?.refused) return fetched;
  const brief = fetched?.text ?? null;
  if (brief && cache) {
    try {
      mkdirSync(dirname(cache), { recursive: true });
      writeFileSync(cache, brief);
    } catch {
      /* a cache miss next time is fine */
    }
  }
  if (brief && !request.marksSeen) rememberStamp(config, brief);
  if (brief && request.marksSeen) {
    try {
      const seen = lastSeenFile(config);
      mkdirSync(dirname(seen), { recursive: true });
      writeFileSync(seen, new Date().toISOString());
    } catch {
      /* the next session gets the default window */
    }
  }
  return brief ? { text: brief } : null;
}

/**
 * The hook's stdout for one event's stdin, or null for nothing. `client` is
 * the word the client's hook settings pass the script (copilot, cursor, or
 * none), `named` the event Copilot names there.
 */
export async function main(
  stdinText,
  env = process.env,
  cwd = process.cwd(),
  client = null,
  named = null,
) {
  let raw;
  try {
    raw = JSON.parse(stdinText);
  } catch {
    return null;
  }
  const event = readEvent(raw, client, named);
  if (!event) return null;
  const config = resolveConfig(env, event.cwd ?? cwd);
  const plan = planFor(event, config);
  if (!plan) return null;
  // What Doco tells the agent at this event leads, whatever else comes.
  const leads = Promise.all(
    plan.leads.map((url) => fetchText(url, config, null).catch(() => null)),
  );
  const output = async (...context) =>
    render(
      client,
      raw,
      event,
      [...(await leads).map((lead) => lead?.text), ...context].filter(Boolean).join("\n\n"),
    );
  if (plan.requests.length === 0) return output();
  // Without a token Doco takes, the agent gets its person's from doco_hook_token.
  const askForToken = (why) =>
    event.kind === "file"
      ? null
      : output(
          `${why}: call doco_hook_token${config.workspace ? ` for ${config.workspace}` : ""}, save the token as it says, and the hook briefs you from the next prompt on.`,
        );
  if (!config.token) return askForToken("The Doco hook has no token here");
  if (event.kind === "session" && config.workspace) {
    try {
      installGitHook(config, "prepare-commit-msg");
    } catch {
      /* the commits go unstamped */
    }
  }
  const answers = await Promise.all(plan.requests.map((request) => ask(request, event, config)));
  if (answers.some((answer) => answer?.refused)) {
    return askForToken("Doco refused the Doco hook's token");
  }
  if (answers.every((answer) => answer?.cached)) return null;
  return output(...answers.map((answer) => answer?.text));
}

/** Install the commit gate in the checkout at `cwd`, saying what it did. */
function installCommitGate(cwd) {
  const config = resolveConfig(process.env, cwd);
  const path = installGitHook(config, "commit-msg");
  if (path) {
    process.stdout.write(
      `Doco's commit gate is on here (${path}): a commit that shows no Doco brief is stopped once, with a brief on it.\n`,
    );
    return 0;
  }
  process.stderr.write(
    "Doco's commit gate isn't on here: this is no git checkout, the project keeps its git hooks in a folder of its own (core.hooksPath), or a commit-msg hook the Doco hook didn't write is there already.\n",
  );
  return 1;
}

async function run() {
  const [word, arg] = process.argv.slice(2);
  // As the stamp's git hook: argv holds the commit message's file, and stdin
  // is not an event.
  if (word === "prepare-commit-msg") {
    try {
      stampCommit(arg);
    } catch (error) {
      process.stderr.write(
        `Doco hook: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    process.exit(0);
  }
  if (word === "commit-msg") {
    let verdict = { pass: true, say: null };
    try {
      verdict = await gateCommit(arg);
    } catch (error) {
      process.stderr.write(
        `Doco hook: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    if (verdict.say) process.stderr.write(`${verdict.say}\n`);
    process.exit(verdict.pass ? 0 : 1);
  }
  if (word === "install-commit-gate") process.exit(installCommitGate(process.cwd()));
  let input = "";
  try {
    for await (const chunk of process.stdin) input += chunk;
    const out = await main(input, process.env, process.cwd(), word ?? null, arg ?? null);
    if (out) process.stdout.write(`${out}\n`);
  } catch (error) {
    process.stderr.write(`Doco hook: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exit(0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
