// Task 0.1 placeholder: the real allowlist copy + esbuild bundling lands in
// task 0.5. For now we only ensure the public-build directory exists so that
// `npm run build` (tsx scripts/build-public.ts && tsc -p tsconfig.build.json)
// resolves and succeeds.
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const publicBuildDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "public-build",
);

mkdirSync(publicBuildDir, { recursive: true });
console.log(
  `build-public placeholder: ensured ${path.relative(process.cwd(), publicBuildDir)}/ exists` +
    " (allowlist bundling arrives in task 0.5)",
);
