/**
 * Settings store — persisted application configuration at ~/.lgcy/config.json.
 * Merge-on-write semantics: partial updates are layered onto existing settings
 * so callers never clobber unrelated keys. Injectable path for tests.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export interface AppSettings {
  defaultProviderId?: string;
  defaultModel?: string;
  theme?: "dark" | "light" | "auto";
  /** Provider → model list overrides (user-curated catalogs). */
  models?: Record<string, string[]>;
  /** Arbitrary key/value preferences surfaced by the TUI. */
  preferences?: Record<string, unknown>;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "auto",
};

export interface SettingsStoreOptions {
  path?: string;
}

export class SettingsStore {
  readonly #path: string;
  #cache: AppSettings | undefined;

  constructor(opts: SettingsStoreOptions = {}) {
    this.#path = opts.path ?? join(homedir(), ".lgcy", "config.json");
  }

  get path(): string {
    return this.#path;
  }

  async load(): Promise<AppSettings> {
    if (this.#cache) return this.#cache;
    try {
      const raw = await readFile(this.#path, "utf-8");
      const parsed = JSON.parse(raw) as AppSettings;
      this.#cache = { ...DEFAULT_SETTINGS, ...parsed };
    } catch {
      this.#cache = { ...DEFAULT_SETTINGS };
    }
    return this.#cache;
  }

  async save(settings: AppSettings): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    await writeFile(this.#path, JSON.stringify(settings, null, 2), "utf-8");
    this.#cache = settings;
  }

  /** Layer a partial update onto the current settings and persist. */
  async update(partial: Partial<AppSettings>): Promise<AppSettings> {
    const current = await this.load();
    const merged: AppSettings = {
      ...current,
      ...partial,
      models: { ...current.models, ...partial.models },
      preferences: { ...current.preferences, ...partial.preferences },
    };
    await this.save(merged);
    return merged;
  }
}
