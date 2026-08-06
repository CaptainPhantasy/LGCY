import { lstat, mkdir, readlink, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..");
const builtBinary = join(projectRoot, "dist", "lgcy");
const localBin = join(process.env.HOME ?? "", ".local", "bin");
const launcher = join(localBin, "lgcy");

if (!process.env.HOME) {
  console.error("install: HOME is not set");
  process.exit(1);
}

const build = Bun.spawnSync(["bun", "run", "build"], {
  cwd: projectRoot,
  stdout: "inherit",
  stderr: "inherit",
});
if (build.exitCode !== 0) process.exit(build.exitCode);

await mkdir(dirname(launcher), { recursive: true });

try {
  const existing = await lstat(launcher);
  if (!existing.isSymbolicLink()) {
    console.error(`install: refusing to replace existing non-link: ${launcher}`);
    process.exit(1);
  }
  const target = resolve(dirname(launcher), await readlink(launcher));
  if (target !== builtBinary) {
    console.error(`install: refusing to replace unrelated link: ${launcher} -> ${target}`);
    process.exit(1);
  }
  console.log(`${launcher} already links to ${builtBinary}`);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  await symlink(builtBinary, launcher);
  console.log(`linked ${launcher} -> ${builtBinary}`);
}
