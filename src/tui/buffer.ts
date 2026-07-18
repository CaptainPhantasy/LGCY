/**
 * Screen buffer — an in-memory grid of styled cells. The renderer diffs two
 * buffers to produce minimal ANSI updates. Every cell is monospace width-1.
 *
 * Cell/wide-char policy (documented v1 limitation):
 *  - A cell holds a single BMP code point. Graphemes outside the BMP
 *    (emoji, many CJK extension chars — UTF-16 surrogate pairs) do not fit
 *    a width-1 cell and are rendered as "?" instead of a broken
 *    half-surrogate.
 *  - setCell with a multi-character string keeps only the FIRST code point.
 *  - Cells are immutable by convention: every write REPLACES a cell object,
 *    never mutates one. This lets clear()/clone() share cell objects safely.
 */

import { type Style, styleEqual } from "./ansi";

export interface Cell {
  /** A single character; space represents an empty cell. */
  char: string;
  style: Style | undefined;
}

export const EMPTY_CELL: Readonly<Cell> = Object.freeze({
  char: " ",
  style: undefined,
});

export class ScreenBuffer {
  readonly width: number;
  readonly height: number;
  readonly rows: Cell[][];

  constructor(width: number, height: number) {
    if (width <= 0 || height <= 0) throw new Error(`invalid buffer size ${width}x${height}`);
    this.width = width;
    this.height = height;
    this.rows = Array.from({ length: height }, () => Array.from({ length: width }, () => cell(" ")));
  }

  /**
   * Reset every cell. A single shared fill object is used — safe because
   * cells are immutable by convention (all writes replace, never mutate).
   */
  clear(char = " ", style?: Style): void {
    const fill = cell(char, style);
    for (const row of this.rows) {
      for (let x = 0; x < row.length; x++) row[x] = fill;
    }
  }

  getCell(x: number, y: number): Cell {
    return this.rows[y]![x]!;
  }

  /**
   * Write one cell. Multi-character input keeps only the first code point;
   * non-BMP code points (surrogate pairs) render as "?" (see module docs).
   */
  setCell(x: number, y: number, char: string, style?: Style): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.rows[y]![x] = cell(char, style);
  }

  /**
   * Write a string starting at (x, y). Returns the ending column. When wrap is
   * true, text flows to the next row (clipped to the buffer bottom).
   */
  writeText(x: number, y: number, text: string, style?: Style, wrap = false): { x: number; y: number } {
    let cx = x;
    let cy = y;
    for (const ch of text) {
      if (ch === "\n") {
        if (!wrap) return { x: cx, y: cy };
        cx = 0;
        cy++;
        if (cy >= this.height) return { x: cx, y: cy };
        continue;
      }
      if (cx >= this.width) {
        if (!wrap) return { x: cx, y: cy };
        cx = 0;
        cy++;
        if (cy >= this.height) return { x: cx, y: cy };
      }
      this.setCell(cx, cy, ch === "\t" ? " " : ch, style);
      cx++;
    }
    return { x: cx, y: cy };
  }

  /** Fill a horizontal run on row y from x0..x1 with a character + style. */
  fillRow(y: number, x0: number, x1: number, char = " ", style?: Style): void {
    for (let x = Math.max(0, x0); x <= Math.min(this.width - 1, x1); x++) {
      this.rows[y]![x] = cell(char, style);
    }
  }

  /**
   * Copy the grid. Cell objects are shared by reference (they are immutable
   * by convention), so cloning allocates only the row arrays — no per-cell
   * object allocation on the streaming hot path.
   */
  clone(): ScreenBuffer {
    const copy = new ScreenBuffer(this.width, this.height);
    for (let y = 0; y < this.height; y++) {
      const src = this.rows[y]!;
      const dst = copy.rows[y]!;
      for (let x = 0; x < this.width; x++) dst[x] = src[x]!;
    }
    return copy;
  }
}

function cell(char: string, style?: Style): Cell {
  if (char.length === 0) return { char: " ", style };
  const first = String.fromCodePoint(char.codePointAt(0)!);
  // Wide graphemes (outside the BMP → surrogate pairs) don't fit a width-1
  // cell; render a placeholder instead of a broken half-surrogate.
  return { char: first.length > 1 ? "?" : first, style };
}

export function cellEqual(a: Cell, b: Cell): boolean {
  return a.char === b.char && styleEqual(a.style, b.style);
}
