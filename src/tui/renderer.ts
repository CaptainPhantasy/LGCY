/**
 * Differential ANSI renderer. Compares a new buffer against the previously
 * rendered frame and emits only the minimal escape sequences needed to update
 * the terminal — no full-screen redraw per token (ADR-0001 requirement).
 *
 * Render output is a plain string, so the renderer is fully unit-testable via
 * render-to-string without a live terminal.
 */

import { CLEAR_SCREEN, cursorTo, sgr, styleEqual, type Style } from "./ansi";
import { type Cell, ScreenBuffer, cellEqual } from "./buffer";

export class Renderer {
  #previous: ScreenBuffer | undefined;

  constructor(width: number, height: number) {
    this.#previous = undefined;
    void width;
    void height;
  }

  /** Reset to a blank slate so the next render is a full paint. */
  reset(): void {
    this.#previous = undefined;
  }

  render(current: ScreenBuffer): string {
    const prev = this.#previous;
    this.#previous = current.clone();
    if (!prev) return this.#fullPaint(current);
    return this.#diffPaint(prev, current);
  }

  #fullPaint(buf: ScreenBuffer): string {
    let out = CLEAR_SCREEN;
    let activeStyle: Style | undefined;
    for (let y = 0; y < buf.height; y++) {
      const row = buf.rows[y]!;
      out += cursorTo(y + 1, 1);
      activeStyle = undefined;
      for (let x = 0; x < buf.width; x++) {
        const c = row[x]!;
        if (!styleEqual(activeStyle, c.style)) {
          out += sgr(c.style);
          activeStyle = c.style;
        }
        out += c.char;
      }
    }
    return out;
  }

  /**
   * Diff each cell. To minimize cursor moves, contiguous changed cells in a
   * row are painted as a single run with a single cursor positioning.
   */
  #diffPaint(prev: ScreenBuffer, current: ScreenBuffer): string {
    const height = Math.min(prev.height, current.height);
    const width = Math.min(prev.width, current.width);
    let out = "";
    let activeStyle: Style | undefined;

    for (let y = 0; y < height; y++) {
      const prevRow = prev.rows[y]!;
      const curRow = current.rows[y]!;
      let x = 0;
      while (x < width) {
        if (cellEqual(prevRow[x]!, curRow[x]!)) {
          x++;
          continue;
        }
        // Start of a changed run — find its extent.
        const runStart = x;
        let run = "";
        let runStyle: Style | undefined;
        while (x < width && !cellEqual(prevRow[x]!, curRow[x]!)) {
          const c = curRow[x]!;
          if (!styleEqual(runStyle, c.style)) {
            if (run.length > 0) {
              out += cursorTo(y + 1, runStart + 1) + sgr(runStyle) + run;
              run = "";
            }
            runStyle = c.style;
          }
          run += c.char;
          x++;
        }
        if (run.length > 0) {
          out += cursorTo(y + 1, runStart + 1) + sgr(runStyle) + run;
        }
        activeStyle = undefined;
        void activeStyle;
      }
    }
    return out;
  }
}

/** Convenience: paint a buffer to a full string (for tests / snapshots). */
export function paintToString(buf: ScreenBuffer): string {
  const lines: string[] = [];
  for (let y = 0; y < buf.height; y++) {
    lines.push(buf.rows[y]!.map((c) => c.char).join(""));
  }
  return lines.join("\n");
}

/** Strip ANSI escape sequences from a render string (for assertions). */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b[78]/g, "");
}
