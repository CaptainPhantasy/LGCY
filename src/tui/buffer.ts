/**
 * Screen buffer — an in-memory grid of styled cells. The renderer diffs two
 * buffers to produce minimal ANSI updates. Every cell is monospace width-1
 * (wide-grapheme handling is a documented v1 limitation).
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

  clear(char = " ", style?: Style): void {
    for (const row of this.rows) {
      for (let x = 0; x < row.length; x++) row[x] = cell(char, style);
    }
  }

  getCell(x: number, y: number): Cell {
    return this.rows[y]![x]!;
  }

  setCell(x: number, y: number, char: string, style?: Style): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.rows[y]![x] = cell(char.length === 0 ? " " : char[0]!, style);
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

  clone(): ScreenBuffer {
    const copy = new ScreenBuffer(this.width, this.height);
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        copy.rows[y]![x] = { ...this.rows[y]![x]!, style: this.rows[y]![x]!.style };
      }
    }
    return copy;
  }
}

function cell(char: string, style?: Style): Cell {
  return { char: char.length === 0 ? " " : char[0]!, style };
}

export function cellEqual(a: Cell, b: Cell): boolean {
  return a.char === b.char && styleEqual(a.style, b.style);
}
