import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

/**
 * `npm run ops:bundle -- --output <dir>` (task 4.6, spec §9): the offline /
 * air-gap delivery bundle. Contents come ONLY from release-manifest.json —
 * a curated include-list, so customer data, .env and secrets can never
 * leak in by accident (there is no recursive copy of the repo).
 *
 * Produced layout:
 *   <out>/images/<image>.tar        docker save output (skipped if the
 *                                   image is absent locally or --no-images)
 *   <out>/compose.yaml              deployment file (image-only install:
 *                                   `docker compose up` uses the loaded
 *                                   tar without rebuilding)
 *   <out>/.env.example              config template — the operator copies
 *                                   it to .env and fills real secrets
 *   <out>/docs/operations/*.md      Vietnamese runbooks
 *   <out>/release-manifest.json     the include-list this build used
 *   <out>/SHA256SUMS                integrity file covering every artifact
 *   <out>/MANIFEST.json             generated build receipt (sizes, digests)
 *
 * Excluded BY CONSTRUCTION (manifest "never" list + fixed file list):
 * customer databases/dumps, .env, APP_KEY/JWT/key material, and LLM model
 * weights — the model is provisioned on the customer's own host.
 */

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

interface ReleaseManifest {
  release: string;
  version: string;
  images: { name: string; required?: boolean }[];
  files: string[];
  never: string[];
}

const USAGE = `usage: npm run ops:bundle -- --output <dir> [--no-images]

  --output <dir>   Bundle destination (created; must not already contain
                   a MANIFEST.json — refuse to mix bundle generations)
  --no-images      Skip docker save (docs/config-only refresh bundle)
`;

function parseArgs(argv: string[]): { output: string; noImages: boolean } {
  let output: string | undefined;
  let noImages = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--output") {
      const v = argv[++i];
      if (!v) throw new Error("--output requires a value");
      output = v;
    } else if (arg === "--no-images") {
      noImages = true;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(USAGE);
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!output) throw new Error("--output is required");
  return { output: path.resolve(output), noImages };
}

function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function assertNoForbiddenName(rel: string, never: string[]): void {
  const base = path.basename(rel);
  for (const pattern of never) {
    const re = new RegExp(
      "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, ".*")
        .replace(/\*/g, "[^/]*") + "$",
    );
    if (re.test(rel) || re.test(base)) {
      throw new Error(
        `bundle refused: "${rel}" matches the manifest's never-list "${pattern}"`,
      );
    }
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = path.join(REPO_ROOT, "release-manifest.json");
  const manifest = JSON.parse(
    readFileSync(manifestPath, "utf8"),
  ) as ReleaseManifest;

  const out = args.output;
  if (existsSync(path.join(out, "MANIFEST.json"))) {
    throw new Error(
      `refusing to write into ${out} — it already contains a bundle ` +
        "(MANIFEST.json present). Use a fresh directory.",
    );
  }
  mkdirSync(path.join(out, "images"), { recursive: true });
  mkdirSync(path.join(out, "docs", "operations"), { recursive: true });

  const produced: { file: string; sha256: string; bytes: number }[] = [];
  const add = (srcAbs: string, destRel: string) => {
    assertNoForbiddenName(destRel, manifest.never);
    const destAbs = path.join(out, destRel);
    mkdirSync(path.dirname(destAbs), { recursive: true });
    copyFileSync(srcAbs, destAbs);
    produced.push({
      file: destRel,
      sha256: sha256File(destAbs),
      bytes: statSync(destAbs).size,
    });
  };

  // 1. Image archives — docker save per image. Missing images are an
  //    error for required ones unless --no-images was passed (a docs-only
  //    refresh is legitimate; an air-gap install without the app image is
  //    not).
  if (!args.noImages) {
    for (const img of manifest.images) {
      const tar = `${img.name.replaceAll(/[/:]/g, "_")}.tar`;
      const destAbs = path.join(out, "images", tar);
      const inspect = spawnSync("docker", ["image", "inspect", img.name], {
        stdio: "ignore",
      });
      if (inspect.status !== 0) {
        if (img.required) {
          throw new Error(
            `image ${img.name} is not available locally — ` +
              "build/pull it first (docker compose build app; docker pull " +
              `${img.name}) or pass --no-images for a docs-only bundle`,
          );
        }
        continue;
      }
      const res = spawnSync("docker", ["save", "-o", destAbs, img.name], {
        stdio: ["ignore", "inherit", "inherit"],
      });
      if (res.status !== 0) {
        throw new Error(`docker save ${img.name} failed (${res.status})`);
      }
      produced.push({
        file: `images/${tar}`,
        sha256: sha256File(destAbs),
        bytes: statSync(destAbs).size,
      });
    }
  }

  // 2. Manifest-listed files — fixed list, each verified to exist. Docs
  //    land under docs/operations/; everything else keeps its name at root.
  for (const rel of manifest.files) {
    const srcAbs = path.join(REPO_ROOT, rel);
    if (!existsSync(srcAbs) || !statSync(srcAbs).isFile()) {
      throw new Error(
        `release-manifest lists ${rel} but it does not exist — ` +
          "update the manifest or create the file",
      );
    }
    const destRel = rel.startsWith("docs/")
      ? rel
      : path.basename(rel) === ".env.example"
        ? ".env.example"
        : rel;
    add(srcAbs, destRel);
  }
  add(manifestPath, "release-manifest.json");

  // 3. Integrity file + build receipt.
  const sums =
    produced.map((p) => `${p.sha256}  ${p.file}`).join("\n") + "\n";
  writeFileSync(path.join(out, "SHA256SUMS"), sums);
  const receipt = {
    release: manifest.release,
    version: manifest.version,
    builtAt: new Date().toISOString(),
    imageArchives: produced
      .filter((p) => p.file.startsWith("images/"))
      .map((p) => p.file),
    files: produced.length,
    sha256sums: "SHA256SUMS",
    excludes:
      "customer data, .env/secrets, APP_KEY/JWT material, LLM model weights",
  };
  writeFileSync(
    path.join(out, "MANIFEST.json"),
    JSON.stringify(receipt, null, 2) + "\n",
  );

  console.log(
    `bundle written to ${out}: ${produced.length} file(s)` +
      (args.noImages ? " (images skipped)" : ""),
  );
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  try {
    main();
  } catch (err) {
    console.error(
      "ops:bundle failed:",
      err instanceof Error ? err.message : err,
    );
    process.exit(1);
  }
}

export { main as bundleMain };
