import { describe, expect, test } from "bun:test";
import { cellEqual, EMPTY_CELL, ScreenBuffer } from "../../src/tui/buffer";
import { Color } from "../../src/tui/ansi";

describe("ScreenBuffer", () => {
  test("constructs blank grid of spaces", () => {
    const b = new ScreenBuffer(3, 2);
    expect(b.width).toBe(3);
    expect(b.height).toBe(2);
    expect(b.getCell(0, 0).char).toBe(" ");
  });
  test("zero/negative size throws", () => {
    expect(() => new ScreenBuffer(0, 1)).toThrow();
    expect(() => new ScreenBuffer(1, 0)).toThrow();
  });
  test("setCell writes first char; out-of-bounds ignored", () => {
    const b = new ScreenBuffer(2, 2);
    b.setCell(1, 0, "AB");
    expect(b.getCell(1, 0).char).toBe("A");
    b.setCell(5, 5, "x"); // ignored, no throw
    expect(b.getCell(0, 0).char).toBe(" ");
  });
  test("writeText without wrap stops at width", () => {
    const b = new ScreenBuffer(3, 1);
    b.writeText(0, 0, "hello");
    expect(b.getCell(0, 0).char).toBe("h");
    expect(b.getCell(2, 0).char).toBe("l");
    // position 3,4 out of range; "lo" dropped
  });
  test("writeText with wrap flows to next row", () => {
    const b = new ScreenBuffer(3, 3);
    b.writeText(0, 0, "abcde", undefined, true);
    expect(b.getCell(2, 0).char).toBe("c");
    expect(b.getCell(0, 1).char).toBe("d");
    expect(b.getCell(1, 1).char).toBe("e");
  });
  test("fillRow paints a run", () => {
    const b = new ScreenBuffer(5, 1);
    b.fillRow(0, 1, 3, "-");
    expect(b.getCell(0, 0).char).toBe(" ");
    expect(b.getCell(1, 0).char).toBe("-");
    expect(b.getCell(3, 0).char).toBe("-");
    expect(b.getCell(4, 0).char).toBe(" ");
  });
  test("clone is independent", () => {
    const b = new ScreenBuffer(2, 1);
    b.setCell(0, 0, "x");
    const c = b.clone();
    c.setCell(0, 0, "y");
    expect(b.getCell(0, 0).char).toBe("x");
    expect(c.getCell(0, 0).char).toBe("y");
  });
  test("clear fills grid", () => {
    const b = new ScreenBuffer(2, 2);
    b.setCell(0, 0, "x");
    b.clear(".");
    expect(b.getCell(0, 0).char).toBe(".");
  });
  test("style is preserved on cells", () => {
    const b = new ScreenBuffer(1, 1);
    b.setCell(0, 0, "x", { fg: Color.red, bold: true });
    expect(b.getCell(0, 0).style).toEqual({ fg: 1, bold: true });
  });
});

describe("cellEqual", () => {
  test("same char + style equal", () => {
    expect(cellEqual(EMPTY_CELL, { char: " ", style: undefined })).toBe(true);
  });
  test("different char not equal", () => {
    expect(cellEqual({ char: "a", style: undefined }, { char: "b", style: undefined })).toBe(false);
  });
  test("different style not equal", () => {
    expect(cellEqual({ char: "a", style: { bold: true } }, { char: "a", style: undefined })).toBe(false);
  });
});
