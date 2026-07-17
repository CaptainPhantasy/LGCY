import { describe, expect, test } from "bun:test";
import { KeyDecoder } from "../../src/tui/keybind";

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe("KeyDecoder", () => {
  const d = () => new KeyDecoder();

  test("single printable char", () => {
    const keys = d().feed(enc("a"));
    expect(keys).toEqual([{ key: "a", ctrl: false, alt: false, shift: false }]);
  });
  test("uppercase letter sets shift", () => {
    const keys = d().feed(enc("A"));
    expect(keys[0]!.shift).toBe(true);
  });
  test("Enter", () => {
    expect(d().feed(enc("\r"))[0]!.key).toBe("Enter");
    expect(d().feed(enc("\n"))[0]!.key).toBe("Enter");
  });
  test("Tab", () => {
    expect(d().feed(enc("\t"))[0]!.key).toBe("Tab");
  });
  test("Backspace (DEL)", () => {
    expect(d().feed(enc("\x7f"))[0]!.key).toBe("Backspace");
  });
  test("Escape standalone via flush", () => {
    const dec = d();
    dec.feed(enc("\x1b"));
    const keys = dec.flush();
    expect(keys[0]!.key).toBe("Escape");
  });

  test("arrow keys", () => {
    expect(d().feed(enc("\x1b[A"))[0]!.key).toBe("ArrowUp");
    expect(d().feed(enc("\x1b[B"))[0]!.key).toBe("ArrowDown");
    expect(d().feed(enc("\x1b[C"))[0]!.key).toBe("ArrowRight");
    expect(d().feed(enc("\x1b[D"))[0]!.key).toBe("ArrowLeft");
  });
  test("Home / End", () => {
    expect(d().feed(enc("\x1b[H"))[0]!.key).toBe("Home");
    expect(d().feed(enc("\x1b[F"))[0]!.key).toBe("End");
  });
  test("Delete / PageUp / PageDown (tilde)", () => {
    expect(d().feed(enc("\x1b[3~"))[0]!.key).toBe("Delete");
    expect(d().feed(enc("\x1b[5~"))[0]!.key).toBe("PageUp");
    expect(d().feed(enc("\x1b[6~"))[0]!.key).toBe("PageDown");
  });

  test("Ctrl+C", () => {
    const keys = d().feed(enc("\x03"));
    expect(keys[0]).toEqual({ key: "c", ctrl: true, alt: false, shift: false });
  });
  test("Ctrl+A", () => {
    expect(d().feed(enc("\x01"))[0]).toEqual({ key: "a", ctrl: true, alt: false, shift: false });
  });

  test("Alt+x", () => {
    const keys = d().feed(enc("\x1bx"));
    expect(keys[0]).toEqual({ key: "x", ctrl: false, alt: true, shift: false });
  });

  test("Ctrl+ArrowUp (\x1b[1;5A)", () => {
    const keys = d().feed(enc("\x1b[1;5A"));
    expect(keys[0]).toEqual({ key: "ArrowUp", ctrl: true, alt: false, shift: false });
  });
  test("Shift+ArrowRight (\x1b[1;2C)", () => {
    const keys = d().feed(enc("\x1b[1;2C"));
    expect(keys[0]!.shift).toBe(true);
    expect(keys[0]!.key).toBe("ArrowRight");
  });

  test("partial escape sequence across chunks is buffered", () => {
    const dec = d();
    expect(dec.feed(enc("\x1b["))).toEqual([]);
    expect(dec.feed(enc("A"))[0]!.key).toBe("ArrowUp");
  });

  test("multi-byte UTF-8 character", () => {
    const keys = d().feed(enc("é"));
    expect(keys).toHaveLength(1);
    expect(keys[0]!.key).toBe("é");
  });
  test("multi-byte UTF-8 split across chunks", () => {
    const bytes = enc("é");
    const dec = d();
    expect(dec.feed(bytes.subarray(0, 1))).toEqual([]);
    const keys = dec.feed(bytes.subarray(1));
    expect(keys).toHaveLength(1);
    expect(keys[0]!.key).toBe("é");
  });

  test("multiple keys in one chunk", () => {
    const keys = d().feed(enc("ab"));
    expect(keys.map((k) => k.key)).toEqual(["a", "b"]);
  });
});
