/**
 * Differential ANSI renderer. Compares a new buffer against the previously
 * rendered frame and emits only the minimal escape sequences needed to update
 * the terminal — no full-screen redraw per token (ADR-0001 requirement).
 *
 * Render output is a plain string, so the renderer is fully unit-testable via
 * render-to-string without a live terminal.
 */

import { CLEAR_SCREEN, RESET, cursorTo, sgr, styleEqual, type Style } from "./ansi";
import { type Cell, ScreenBuffer, cellEqual } from "./buffer";

export class Renderer {
  #previous: ScreenBuffer | undefined;

  /** Reset to a blank slate so the next render is a full paint. */
  reset(): void {
    this.#previous = undefined;
  }

  render(current: ScreenBuffer): string {
    const prev = this.#previous;
    this.#previous = current.clone();
    // A dimension change (including terminal resize and buffer shrink) forces
    // a full paint: CLEAR_SCREEN drops stale cells that a min-clamped diff
    // would leave behind on the terminal.
    if (!prev || prev.width !== current.width || prev.height !== current.height) {
      return this.#fullPaint(current);
    }
    return this.#diffPaint(prev, current);
  }

  #fullPaint(buf: ScreenBuffer): string {
    let out = CLEAR_SCREEN;
    // Style state carries across rows: cursor positioning does not reset SGR,
    // so re-emitting the same style at each row start would be wasted bytes.
    let activeStyle: Style | undefined;
    for (let y = 0; y < buf.height; y++) {
      const row = buf.rows[y]!;
      out += cursorTo(y + 1, 1);
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
   * Precondition: prev and current have identical dimensions (render()
   * full-paints on any dimension change), so the min-clamps below are only
   * defensive. Output always ends with a RESET so the terminal's SGR state
   * is predictable after every frame.
   */
  #diffPaint(prev: ScreenBuffer, current: ScreenBuffer): string {
    const height = Math.min(prev.height, current.height);
    const width = Math.min(prev.width, current.width);
    let out = "";

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
        let run = "";
        let runStyle: Style | undefined;
        let segmentStart = x;
        while (x < width && !cellEqual(prevRow[x]!, curRow[x]!)) {
          const c = curRow[x]!;
          if (!styleEqual(runStyle, c.style)) {
            if (run.length > 0) {
              out += cursorTo(y + 1, segmentStart + 1) + sgr(runStyle) + run;
              run = "";
            }
            runStyle = c.style;
            segmentStart = x;
          }
          run += c.char;
          x++;
        }
        if (run.length > 0) {
          out += cursorTo(y + 1, segmentStart + 1) + sgr(runStyle) + run;
        }
      }
    }
    // Every styled run is self-contained (sgr() resets first), and the frame
    // ends in a known state.
    if (out.length > 0) out += RESET;
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
