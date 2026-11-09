import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const app = resolve(import.meta.dirname);
const css = readFileSync(resolve(app, "app.css"), "utf8");
const root = readFileSync(resolve(app, "root.tsx"), "utf8");
const home = readFileSync(resolve(app, "routes/_index.tsx"), "utf8");
const mark = readFileSync(resolve(app, "components/braino-mark.tsx"), "utf8");

describe("Braino's design language", () => {
  it("uses the same typography and one-clay color tokens as Braino", () => {
    expect(css).toContain("Merriweather:ital,wght@0,300..900;1,300..900");
    expect(css).toContain('--font-serif: "Merriweather", Georgia');
    expect(css).toContain('--font-mono: "Ubuntu Mono"');
    expect(css).toContain("--color-background: oklch(0.961 0.0054 95.1)");
    expect(css).toContain("--color-primary: oklch(0.54 0.17 324)");
  });

  it("keeps surfaces grooved, fields inset, and only clickables raised", () => {
    expect(css).toMatch(/\.neu-surface\s*\{[^}]*box-shadow:\s*var\(--neu-groove\)/s);
    expect(css).toMatch(/\.neu-well\s*\{[^}]*box-shadow:\s*var\(--neu-inset\)/s);
    expect(css).toMatch(/\.neu-button\s*\{[^}]*box-shadow:\s*var\(--neu-key\)/s);
    expect(css).toMatch(/input:not\([^}]*box-shadow:\s*var\(--neu-inset\)/s);
  });

  it("uses Braino's real mark, site header, and workspace page primitives", () => {
    expect(root).toContain('from "~/components/braino-mark"');
    expect(root).toContain("<BrainoMark height={28}");
    expect(root).toContain("h-14 border-b border-border bg-card");
    expect(mark).toContain("braino-mark-glyph-motion");
    expect(mark).toContain("braino-mark-spark-lg");
    expect(mark).not.toContain("<img");
    expect(home).toContain("<NarrowPageMain");
    expect(home).toContain("<PageMain");
    expect(home).toContain("neu-button");
    expect(home).toContain("neu-surface");
    expect(home).not.toContain('className="panel"');
    expect(home).not.toContain('className="card"');
  });
});
