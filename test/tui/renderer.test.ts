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
