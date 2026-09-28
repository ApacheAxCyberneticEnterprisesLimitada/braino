// Text chunking for embeddings, shared by graph entities and mirror rows:
// windows of about 1,600 characters (roughly 400 tokens), cut on a paragraph
// break, a line break, a sentence end or a space when one falls in the second
// half of the window, overlapping by about 200 characters so a passage split
// in two is still whole in one of them. Pure.

export const CHUNK_CHARS = 1600;
export const CHUNK_OVERLAP_CHARS = 200;

const BOUNDARIES = ["\n\n", "\n", ". ", "! ", "? ", " "];

export function chunkText(
  text: string,
  opts: { maxChars?: number; overlapChars?: number } = {},
): string[] {
  const max = Math.max(1, opts.maxChars ?? CHUNK_CHARS);
  const overlap = Math.min(opts.overlapChars ?? CHUNK_OVERLAP_CHARS, Math.floor(max / 2));
  const clean = text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
  if (!clean) return [];
  if (clean.length <= max) return [clean];
  const chunks: string[] = [];
  let start = 0;
  for (;;) {
    let end = Math.min(clean.length, start + max);
    if (end < clean.length) end = start + cutPoint(clean.slice(start, end));
    const chunk = clean.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= clean.length) return chunks;
    // Step back for the overlap, then forward to a word boundary so no chunk
    // opens mid-word.
    let next = Math.max(end - overlap, start + 1);
    const space = clean.indexOf(" ", next);
    if (space !== -1 && space < end) next = space + 1;
    start = next;
  }
}

/** Where to cut a full window: after the last boundary in its second half,
 *  else at its end. */
function cutPoint(window: string): number {
  const floor = Math.floor(window.length / 2);
  for (const boundary of BOUNDARIES) {
    const at = window.lastIndexOf(boundary);
    if (at >= floor) return at + boundary.length;
  }
  return window.length;
}

// Identifying fields to index when a node has no prose yet. Order is the
// fallback preference; deduped at join time.
const FALLBACK_INDEX_FIELDS = ["locator", "name", "verb"] as const;

/**
 * The text to index for a node, its full-text body and its embedding input:
 * the node's `prose`, its one text home. When the prose is empty, a
 * content-thin node such as a freshly created Reference whose title hasn't
 * been written yet, the node's identifying fields stand in so it still
 * enters the index. Pure.
 */
export function nodeIndexText(
  prose: string | null | undefined,
  data: Record<string, unknown> | null | undefined,
): string {
  const trimmed = prose?.trim() ?? "";
  if (trimmed) return trimmed;
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const key of FALLBACK_INDEX_FIELDS) {
    const raw = data?.[key];
    if (typeof raw !== "string") continue;
    const value = raw.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    parts.push(value);
  }
  return parts.join(" — ");
}
