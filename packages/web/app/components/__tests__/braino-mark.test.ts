import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrainoMark } from "../braino-mark";

// Alexander, 2026-10-03: "Add biomorphic [neumorphic] design to the logo of
// Braino in the home page", then, once the site was one clay, "The purple/letter
// should be solid." The raised logo is solid purple standing out of the page
// like a key: a highlight above it, a shadow below it, a thin contact shadow
// where it meets the page, and nothing drawn on the purple itself.
const appCss = readFileSync(new URL("../../app.css", import.meta.url), "utf8");

function render(props: Parameters<typeof BrainoMark>[0]): string {
  return renderToStaticMarkup(createElement(BrainoMark, props));
}

describe("BrainoMark", () => {
  it("keeps the purple solid when raised", () => {
    const html = render({ height: 72, raised: true });
    expect(html).toMatch(/<svg[^>]*class="[^"]*\bbraino-mark-raised\b/);
    // No bevel, gradient or filter on the orb or the wordmark: the relief is
    // only the shadow and highlight the page gives it (`.braino-mark-raised`).
    expect(html).not.toContain("<filter");
    expect(html).not.toMatch(/<g[^>]* filter=/);
    expect(html).not.toContain("Gradient");
    expect(html.match(/fill="#9945A1"/g)).toHaveLength(2);
  });

  it("stays flat everywhere else", () => {
    for (const html of [
      render({ height: 28 }),
      render({ height: 28, variant: "mark", active: true }),
    ]) {
      expect(html).not.toContain("braino-mark-raised");
      expect(html).not.toContain("<filter");
    }
  });

  it("stands on a contact shadow under the lifted key's shadow and highlight", () => {
    // One clay (Alexander, 2026-10-03, "D grounded key"): the logo is a solid
    // key lifted a little (`--neu-key-hover`'s numbers) and grounded by a thin
    // contact shadow, so it sits on the page instead of floating over it.
    const key = appCss.match(
      /--neu-key-hover: (\S+ \S+ \S+) var\(--neu-shadow\), (\S+ \S+ \S+) var\(--neu-highlight\);/,
    );
    expect(key).toBeTruthy();
    const at = appCss.indexOf("\n.braino-mark-raised {");
    expect(at).toBeGreaterThan(0);
    const rule = appCss.slice(at, appCss.indexOf("}", at)).replace(/\s+/g, " ");
    expect(rule).toContain(
      `filter: drop-shadow(1px 2px 1px color-mix(in oklch, var(--color-foreground) 24%, transparent)) drop-shadow(${key?.[1]} var(--neu-shadow)) drop-shadow(${key?.[2]} var(--neu-highlight))`,
    );
  });
});
