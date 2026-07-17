/**
 * ANSI escape-sequence primitives. Kept as pure string constants and tiny
 * builders so the renderer can compose output without external dependencies.
 */

export const ESC = "\x1b";
export const CSI = `${ESC}[`;

/** Cursor visibility. */
export const HIDE_CURSOR = `${CSI}?25l`;
export const SHOW_CURSOR = `${CSI}?25h`;

/** Erase the whole display and reset cursor to home. */
export const CLEAR_SCREEN = `${CSI}2J${CSI}1;1H`;

/** Move cursor to a 1-indexed (row, col). */
export function cursorTo(row: number, col: number): string {
  return `${CSI}${row};${col}H`;
}

/** Move cursor up/down/forward/back by n cells. */
export const cursorUp = (n = 1): string => `${CSI}${n}A`;
export const cursorDown = (n = 1): string => `${CSI}${n}B`;
export const cursorForward = (n = 1): string => `${CSI}${n}C`;
export const cursorBack = (n = 1): string => `${CSI}${n}D`;

/** Save / restore cursor position (DECSC/DECRC). */
export const SAVE_CURSOR = `${ESC}7`;
export const RESTORE_CURSOR = `${ESC}8`;

/** Erase from cursor to end of line. */
export const CLEAR_LINE = `${CSI}K`;

export interface Style {
  fg?: number;
  bg?: number;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

const RESET = `${CSI}0m`;

function colorCode(prefix: string, n: number): string {
  if (n >= 0 && n <= 7) return `${CSI}${prefix}${n}m`;
  if (n >= 8 && n <= 15) return `${CSI}${prefix + 8}${n - 8}m`;
  return `${CSI}${prefix}8;5;${n}m`;
}

/**
 * Build an SGR sequence for a style. Emits a reset first so every styled run
 * is self-contained and order-independent during differential rendering.
 */
export function sgr(s: Style | undefined): string {
  if (!s) return RESET;
  const parts: string[] = ["0"];
  if (s.bold) parts.push("1");
  if (s.dim) parts.push("2");
  if (s.italic) parts.push("3");
  if (s.underline) parts.push("4");
  if (s.inverse) parts.push("7");
  if (typeof s.fg === "number") {
    if (s.fg <= 7) parts.push(`${30 + s.fg}`);
    else if (s.fg <= 15) parts.push(`${90 + (s.fg - 8)}`);
    else parts.push(`38;5;${s.fg}`);
  }
  if (typeof s.bg === "number") {
    if (s.bg <= 7) parts.push(`${40 + s.bg}`);
    else if (s.bg <= 15) parts.push(`${100 + (s.bg - 8)}`);
    else parts.push(`48;5;${s.bg}`);
  }
  return `${CSI}${parts.join(";")}m`;
}

/** Structural equality for styles (used by the diff renderer). */
export function styleEqual(a: Style | undefined, b: Style | undefined): boolean {
  return (
    a?.fg === b?.fg &&
    a?.bg === b?.bg &&
    a?.bold === b?.bold &&
    a?.dim === b?.dim &&
    a?.italic === b?.italic &&
    a?.underline === b?.underline &&
    (a?.inverse ?? false) === (b?.inverse ?? false)
  );
}

export { RESET };

/** Common color aliases (base 16). */
export const Color = {
  black: 0,
  red: 1,
  green: 2,
  yellow: 3,
  blue: 4,
  magenta: 5,
  cyan: 6,
  white: 7,
  brightBlack: 8,
  brightRed: 9,
  brightGreen: 10,
  brightYellow: 11,
  brightBlue: 12,
  brightMagenta: 13,
  brightCyan: 14,
  brightWhite: 15,
} as const;

void colorCode; // retained for potential 256-color direct use by callers
