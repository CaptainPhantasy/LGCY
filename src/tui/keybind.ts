/**
 * Incremental keystroke decoder. Raw stdin bytes arrive in arbitrary chunks;
 * this state machine accumulates them and emits complete Key events, tolerating
 * partial escape sequences that straddle chunk boundaries (mirrors the SSE
 * parser's incremental model).
 *
 * Modifier encoding (xterm): the code after the semicolon is a value 2-8, NOT
 * a bitmask — 2=Shift, 3=Alt, 4=Shift+Alt, 5=Ctrl, 6=Shift+Ctrl, 7=Alt+Ctrl,
 * 8=Shift+Alt+Ctrl.
 *
 * Documented protocol limitations:
 *  - Tab (0x09) and Ctrl+I are the SAME byte on the wire; the terminal cannot
 *    distinguish them. This decoder always reports 0x09 as Tab. Pasted text
 *    containing control bytes is likewise indistinguishable from typed keys
 *    unless the terminal negotiates bracketed-paste mode (CSI 200~/201~),
 *    which is out of scope for v1.
 *  - Partial UTF-8 sequences straddling feed() calls are held by the
 *    streaming TextDecoder and only surface once complete. flush() finalizes
 *    the decoder: a truncated tail becomes U+FFFD (replacement char) rather
 *    than being silently dropped or mis-decoded.
 */

export interface Key {
  /** Logical name for special keys, otherwise the printable character. */
  key: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

const NAMED_SPECIAL = new Map<string, string>([
  ["A", "ArrowUp"],
  ["B", "ArrowDown"],
  ["C", "ArrowRight"],
  ["D", "ArrowLeft"],
  ["H", "Home"],
  ["F", "End"],
  ["P", "F1"],
  ["Q", "F2"],
  ["R", "F3"],
  ["S", "F4"],
]);

const TILDE_SPECIAL = new Map<string, string>([
  ["1", "Home"],
  ["4", "End"],
  ["5", "PageUp"],
  ["6", "PageDown"],
  ["3", "Delete"],
  ["2", "Insert"],
]);

function parseModifier(mod: number): { ctrl: boolean; alt: boolean; shift: boolean } {
  return {
    shift: mod === 2 || mod === 4 || mod === 6 || mod === 8,
    alt: mod === 3 || mod === 4 || mod === 7 || mod === 8,
    ctrl: mod === 5 || mod === 6 || mod === 7 || mod === 8,
  };
}

export class KeyDecoder {
  #buf = "";
  #decoder = new TextDecoder("utf-8");

  /** Feed raw bytes; returns every fully-decoded key in arrival order. */
  feed(bytes: Uint8Array): Key[] {
    this.#buf += this.#decoder.decode(bytes, { stream: true });
    return this.#drain();
  }

  /**
   * Flush the UTF-8 decoder (call when stdin closes). Any incomplete trailing
   * byte sequence is rejected explicitly: the final decode() surfaces it as
   * U+FFFD, which is then emitted as a literal key like any other code point.
   */
  flush(): Key[] {
    this.#buf += this.#decoder.decode();
    const keys = this.#drain();
    if (this.#buf.length > 0) {
      for (const ch of this.#buf) keys.push(this.#literalKey(ch));
      this.#buf = "";
    }
    return keys;
  }

  #drain(): Key[] {
    const out: Key[] = [];
    let consumed = 0;
    outer: while (consumed < this.#buf.length) {
      const rest = this.#buf.slice(consumed);

      // CSI escape sequence: ESC [
      if (rest.startsWith("\x1b[")) {
        const m = /^(\x1b\[)(\d+(?:;\d+)?)?([A-Za-z~])/.exec(rest);
        if (m) {
          out.push(this.#csiKey(m[2] ?? "", m[3]!));
          consumed += m[0].length;
          continue;
        }
        // Possibly incomplete; stop until more bytes arrive.
        if (/^\x1b\[\d*(?:;\d*)?$/.test(rest)) break outer;
        // Malformed — consume the ESC and treat the rest literally.
        out.push(this.#literalKey("\x1b"));
        consumed += 1;
        continue;
      }

      // ESC + single char → Alt+char (or incomplete lone ESC).
      if (rest.startsWith("\x1b")) {
        if (rest.length < 2) break outer;
        out.push(this.#altKey(rest[1]!));
        consumed += 2;
        continue;
      }

      // Named control characters (before the generic Ctrl+letter range).
      const cc = rest.charCodeAt(0);
      if (cc === 13 || cc === 10) {
        out.push({ key: "Enter", ctrl: false, alt: false, shift: false });
        consumed += 1;
        continue;
      }
      if (cc === 9) {
        out.push({ key: "Tab", ctrl: false, alt: false, shift: false });
        consumed += 1;
        continue;
      }
      if (cc === 127 || cc === 8) {
        out.push({ key: "Backspace", ctrl: false, alt: false, shift: false });
        consumed += 1;
        continue;
      }
      // Ctrl+letter: bytes 1..8, 11..12, 14..26 → a..z (named controls excluded).
      if (cc >= 1 && cc <= 26) {
        out.push({ key: String.fromCharCode(96 + cc), ctrl: true, alt: false, shift: false });
        consumed += 1;
        continue;
      }

      // Literal character — TextDecoder already assembled complete code points.
      const cp = rest.codePointAt(0)!;
      const len = cp > 0xffff ? 2 : 1;
      out.push(this.#literalKey(rest.slice(0, len)));
      consumed += len;
    }
    this.#buf = this.#buf.slice(consumed);
    return out;
  }

  #csiKey(params: string, final: string): Key {
    const segs = params ? params.split(";").map(Number) : [];
    let keyName: string;
    let mods = { ctrl: false, alt: false, shift: false };

    if (final === "~") {
      const num = String(segs[0] ?? "");
      keyName = TILDE_SPECIAL.get(num) ?? `Unknown(${num})`;
      if (segs.length >= 2) mods = parseModifier(segs[1]!);
    } else {
      keyName = NAMED_SPECIAL.get(final) ?? final;
      if (segs.length >= 2) mods = parseModifier(segs[1]!);
    }
    return { key: keyName, ...mods };
  }

  #altKey(ch: string): Key {
    return { key: ch, ctrl: false, alt: true, shift: ch !== ch.toLowerCase() };
  }

  #literalKey(s: string): Key {
    if (s === "\r" || s === "\n") return { key: "Enter", ctrl: false, alt: false, shift: false };
    if (s === "\t") return { key: "Tab", ctrl: false, alt: false, shift: false };
    if (s === "\x7f" || s === "\x08") return { key: "Backspace", ctrl: false, alt: false, shift: false };
    if (s === "\x1b") return { key: "Escape", ctrl: false, alt: false, shift: false };
    if (s === " ") return { key: "Space", ctrl: false, alt: false, shift: false };
    return { key: s, ctrl: false, alt: false, shift: s !== s.toLowerCase() };
  }
}
