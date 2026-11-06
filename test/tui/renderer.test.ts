import { describe, expect, test } from "bun:test";
import { ScreenBuffer } from "../../src/tui/buffer";
import { paintToString, Renderer, stripAnsi } from "../../src/tui/renderer";
import { Color } from "../../src/tui/ansi";

describe("paintToString", () => {
  test("renders buffer content row-major joined by newline", () => {
    const b = new ScreenBuffer(3, 2);
    b.writeText(0, 0, "ab");
    b.writeText(0, 1, "cd");
    expect(paintToString(b)).toBe("ab \ncd ");
  });
});

describe("Renderer", () => {
  test("first render is a full paint with clear screen", () => {
    const r = new Renderer();
    const b = new ScreenBuffer(3, 1);
    b.writeText(0, 0, "hi");
    const out = r.render(b);
    expect(out.startsWith("\x1b[2J")).toBe(true);
    expect(stripAnsi(out)).toBe("hi ");
  });

  test("re-render with no changes emits nothing", () => {
    const r = new Renderer();
    const b = new ScreenBuffer(3, 1);
    b.writeText(0, 0, "hi");
    r.render(b);
    expect(r.render(b.clone())).toBe("");
  });

  test("re-render with one changed cell emits only that cell", () => {
    const r = new Renderer();
    const b = new ScreenBuffer(3, 1);
    b.writeText(0, 0, "abc");
    r.render(b);
    const next = b.clone();
    next.setCell(1, 0, "X");
    const out = r.render(next);
    expect(stripAnsi(out)).toBe("X");
  });

  test("re-render with a changed row emits the run", () => {
    const r = new Renderer();
    const b = new ScreenBuffer(5, 1);
    b.writeText(0, 0, "hello");
    r.render(b);
    const next = b.clone();
    next.writeText(0, 0, "HELLO");
    const out = r.render(next);
    expect(stripAnsi(out)).toBe("HELLO");
  });

  test("change on second row positions cursor to row 2", () => {
    const r = new Renderer();
    const b = new ScreenBuffer(2, 2);
    b.writeText(0, 0, "ab");
    b.writeText(0, 1, "cd");
    r.render(b);
    const next = b.clone();
    next.setCell(0, 1, "Z");
    const out = r.render(next);
    expect(out).toContain("\x1b[2;1H");
    expect(stripAnsi(out)).toBe("Z");
  });

  test("reset forces full paint on next render", () => {
    const r = new Renderer();
    const b = new ScreenBuffer(2, 1);
    b.writeText(0, 0, "hi");
    r.render(b);
    r.reset();
    expect(r.render(b.clone()).startsWith("\x1b[2J")).toBe(true);
  });

  test("style change alone triggers a repaint of that cell", () => {
    const r = new Renderer();
    const b = new ScreenBuffer(2, 1);
    b.writeText(0, 0, "hi");
    r.render(b);
    const next = b.clone();
    next.setCell(0, 0, "h", { fg: Color.red });
    const out = r.render(next);
    expect(stripAnsi(out)).toBe("h");
  });

  test("style run emits sgr then resets", () => {
    const r = new Renderer();
    const b = new ScreenBuffer(3, 1);
    b.writeText(0, 0, "abc", { bold: true });
    r.render(b);
    const next = b.clone();
    next.clear();
    next.writeText(0, 0, "xyz", { fg: Color.green });
    const out = r.render(next);
    // The green foreground code (32) should appear
    expect(out).toContain("32");
    expect(stripAnsi(out)).toBe("xyz");
  });
});

describe("Renderer — item #8/#57 dimension-change full paint", () => {
  test("shrinking buffer resets screen with CLEAR_SCREEN", () => {
    const r = new Renderer();
    const big = new ScreenBuffer(5, 2);
    big.writeText(0, 0, "hello");
    big.writeText(0, 1, "world");
    r.render(big);
    const small = new ScreenBuffer(3, 1);
    small.writeText(0, 0, "abc");
    const out = r.render(small);
    expect(out.startsWith("\x1b[2J")).toBe(true);
  });
  test("growing buffer also full-paints", () => {
    const r = new Renderer();
    r.render(new ScreenBuffer(2, 1));
    const out = r.render(new ScreenBuffer(3, 2));
    expect(out.startsWith("\x1b[2J")).toBe(true);
  });
});

describe("Renderer — item #41 style reused across rows in fullPaint", () => {
  test("same bold style on both rows emits SGR once, not twice", () => {
    const r = new Renderer();
    const buf = new ScreenBuffer(3, 2);
    buf.fillRow(0, 0, 2, " ", { bold: true });
    buf.fillRow(1, 0, 2, " ", { bold: true });
    const out = r.render(buf);
    // sgr({bold:true}) = \x1b[0;1m — should appear exactly once
    const occurrences = out.split("\x1b[0;1m").length - 1;
    expect(occurrences).toBe(1);
  });
});

describe("Renderer — item #42 diffPaint ends with RESET", () => {
  test("changed cell output ends with RESET", () => {
    const r = new Renderer();
    const b = new ScreenBuffer(3, 1);
    b.writeText(0, 0, "abc");
    r.render(b);
    const next = b.clone();
    next.setCell(1, 0, "X");
    const out = r.render(next);
    expect(out.endsWith("\x1b[0m")).toBe(true);
  });
  test("no-change renders empty (no trailing RESET)", () => {
    const r = new Renderer();
    const b = new ScreenBuffer(3, 1);
    r.render(b);
    expect(r.render(b.clone())).toBe("");
  });
});

describe("Renderer — Codex P2 style transition within a changed run", () => {
  test("shorter status label positions following divider at the new column", () => {
    const r = new Renderer();
    const blue = { fg: Color.blue };
    const dim = { dim: true };

    const prev = new ScreenBuffer(16, 1);
    prev.writeText(0, 0, "anthropic", blue);
    prev.writeText(9, 0, "---", dim);
    r.render(prev);

    const next = new ScreenBuffer(16, 1);
    next.writeText(0, 0, "openai", blue);
    next.writeText(6, 0, "---", dim);
    const out = r.render(next);

    expect(out).toContain("\x1b[1;1H");
    expect(out).toContain("\x1b[1;7H");
    expect(stripAnsi(out)).toContain("openai---");
  });
});
