/**
 * Settings store — persisted application configuration at ~/.lgcy/config.json.
 * Merge-on-write semantics: partial updates are layered onto existing settings
 * so callers never clobber unrelated keys. Injectable path for tests.
 *
 * Load-time hygiene: the file is schema-validated on load — unknown keys are
 * stripped and invalid values dropped, so a malformed or older-version file
 * can never inject unexpected state downstream.
 *
 * Deletion semantics (update): passing an explicit `undefined` value deletes
 * the key from the per-user layer — at the top level ({ defaultModel: undefined })
 * and inside the models / preferences maps ({ models: { openai: undefined } }).
 * This applies to the user's own config only: keys inherited from the
 * machine-wide shared defaults are NOT removed, and the shared value keeps
 * appearing in the effective settings returned by load()/update().
 *
 * Preferences are NOT a secret store: saving credential-shaped values under
 * known credential key names triggers an onWarn callback (default: stderr).
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { ALWAYS_SECRET_KEY_RE, looksLikeSecret } from "../core/secrets";

export interface AppSettings {
  defaultProviderId?: string;
  defaultModel?: string;
  theme?: "dark" | "light" | "auto";
  /** Provider → model list overrides (user-curated catalogs). */
  models?: Record<string, string[]>;
  /** Arbitrary key/value preferences surfaced by the TUI. */
  preferences?: Record<string, unknown>;
}

/**
 * Patch shape for update(): identical to Partial<AppSettings> except the
 * models/preferences maps accept `undefined` values to request deletion.
 */
export interface SettingsPatch extends Omit<Partial<AppSettings>, "models" | "preferences"> {
  models?: Record<string, string[] | undefined>;
  preferences?: Record<string, unknown>;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "auto",
};

const KNOWN_KEYS = new Set(["defaultProviderId", "defaultModel", "theme", "models", "preferences"]);

/**
 * Machine-wide defaults, layered under the user's own config so a fresh
 * account on this host inherits working settings. Override the location
 * with LGCY_SHARED_DIR. User settings always win; writes stay per-user.
 */
const SHARED_DIR = process.env.LGCY_SHARED_DIR ?? "/usr/local/share/lgcy";

async function loadSharedDefaults(sharedDir: string): Promise<Partial<AppSettings>> {
  try {
    const raw = await readFile(join(sharedDir, "config.json"), "utf-8");
    return sanitizeSettings(JSON.parse(raw));
  } catch {
    return {};
  }
}

export interface SettingsStoreOptions {
  path?: string;
  /**
   * Directory holding machine-wide defaults (config.json). Defaults to
   * LGCY_SHARED_DIR or /usr/local/share/lgcy; pass a non-existent directory
   * to isolate a store from host state.
   */
  sharedDir?: string;
  /** Called when credential-shaped values are saved into preferences. */
  onWarn?: (message: string) => void;
}

export class SettingsStore {
  readonly #path: string;
  readonly #sharedDir: string;
  readonly #onWarn: (message: string) => void;
  /** User-layer settings as read from this.#path — the only layer persisted. */
  #cache: AppSettings | undefined;
  /** Machine-wide defaults, loaded once; layered only in effective views. */
  #shared: Partial<AppSettings> | undefined;

  constructor(opts: SettingsStoreOptions = {}) {
    this.#path = opts.path ?? join(homedir(), ".lgcy", "config.json");
    this.#sharedDir = opts.sharedDir ?? SHARED_DIR;
    this.#onWarn = opts.onWarn ?? ((m) => console.error(`lgcy settings: ${m}`));
  }

  get path(): string {
    return this.#path;
  }

  async load(): Promise<AppSettings> {
    if (this.#cache) return this.#effective();
    this.#shared = await loadSharedDefaults(this.#sharedDir);
    try {
      const raw = await readFile(this.#path, "utf-8");
      this.#cache = sanitizeSettings(JSON.parse(raw));
    } catch {
      this.#cache = {};
    }
    return this.#effective();
  }

  /**
   * Effective settings: defaults + machine-wide shared defaults layered under
   * the user's own settings. The shared layer is never persisted — update() and
   * save() operate on the user layer only, so writes stay per-user and a later
   * change to the shared file keeps reaching this user.
   */
  #effective(): AppSettings {
    // Merge the models/preferences maps key-by-key so user entries in one map
    // do not hide inherited shared entries in the same map.
    const models = { ...this.#shared?.models, ...this.#cache?.models };
    const preferences = { ...this.#shared?.preferences, ...this.#cache?.preferences };
    return {
      ...DEFAULT_SETTINGS,
      ...this.#shared,
      ...this.#cache,
      ...(Object.keys(models).length > 0 ? { models } : {}),
      ...(Object.keys(preferences).length > 0 ? { preferences } : {}),
    };
  }

  async save(settings: AppSettings): Promise<void> {
    this.#warnOnCredentialPreferences(settings);
    await mkdir(dirname(this.#path), { recursive: true });
    await writeFile(this.#path, JSON.stringify(settings, null, 2), "utf-8");
    this.#cache = settings;
  }

  /**
   * Layer a partial update onto the current settings and persist. Explicit
   * `undefined` values delete the corresponding key from the per-user layer
   * only (see module docs): keys inherited from the shared defaults reappear
   * in the effective settings returned by this method.
   */
  async update(partial: SettingsPatch): Promise<AppSettings> {
    if (!this.#cache) await this.load(); // ensures #shared is populated too
    // Layer onto the user-only settings so inherited defaults are not materialised.
    const current = this.#cache!;
    const merged: AppSettings = { ...current };
    for (const [k, v] of Object.entries(partial)) {
      if (k === "models" || k === "preferences") continue; // deep-merged below
      if (v === undefined) delete (merged as Record<string, unknown>)[k];
      else (merged as Record<string, unknown>)[k] = v;
    }
    if (partial.models) {
      const models: Record<string, string[]> = { ...current.models };
      for (const [k, v] of Object.entries(partial.models)) {
        if (v === undefined) delete models[k];
        else models[k] = v;
      }
      merged.models = models;
    }
    if (partial.preferences) {
      const preferences: Record<string, unknown> = { ...current.preferences };
      for (const [k, v] of Object.entries(partial.preferences)) {
        if (v === undefined) delete preferences[k];
        else preferences[k] = v;
      }
      merged.preferences = preferences;
    }
    await this.save(merged);
    return await this.load();
  }

  #warnOnCredentialPreferences(settings: AppSettings): void {
    if (!settings.preferences) return;
    for (const [k, v] of Object.entries(settings.preferences)) {
      if (ALWAYS_SECRET_KEY_RE.test(k) || looksLikeSecret(v)) {
        this.#onWarn(
          `preferences.${k} looks like a credential — preferences are plaintext and not a secret store`,
        );
      }
    }
  }
}

/**
 * Validate a parsed config file: keep only known keys, coerce only
 * correctly-typed values, drop everything else.
 */
export function sanitizeSettings(raw: unknown): AppSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const out: AppSettings = {};
  for (const key of Object.keys(r)) {
    if (!KNOWN_KEYS.has(key)) continue; // strip unknown keys
    const v = r[key];
    switch (key) {
      case "defaultProviderId":
      case "defaultModel":
        if (typeof v === "string" && v.length > 0) out[key] = v;
        break;
      case "theme":
        if (v === "dark" || v === "light" || v === "auto") out.theme = v;
        break;
      case "models": {
        if (!v || typeof v !== "object" || Array.isArray(v)) break;
        const models: Record<string, string[]> = {};
        for (const [p, list] of Object.entries(v as Record<string, unknown>)) {
          if (Array.isArray(list) && list.every((m) => typeof m === "string")) {
            models[p] = list as string[];
          }
        }
        if (Object.keys(models).length > 0) out.models = models;
        break;
      }
      case "preferences":
        if (v && typeof v === "object" && !Array.isArray(v)) {
          out.preferences = { ...(v as Record<string, unknown>) };
        }
        break;
    }
  }
  return out;
}
