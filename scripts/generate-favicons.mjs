import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, "public");
const svgPath = join(outDir, "favicon.svg");
const sizes = [
  ["favicon-16.png", 16],
  ["favicon-32.png", 32],
  ["apple-touch-icon.png", 180],
  ["favicon-192.png", 192],
  ["favicon-512.png", 512]
];

function hasCommand(command) {
  const result = spawnSync(command, ["--version"], { stdio: "ignore" });
  return result.status === 0;
}

if (!existsSync(svgPath)) {
  throw new Error(`Cannot generate favicon PNGs: missing source SVG at ${svgPath}`);
}

mkdirSync(outDir, { recursive: true });

if (!hasCommand("rsvg-convert")) {
  const missingPngs = sizes
    .map(([fileName]) => join(outDir, fileName))
    .filter((filePath) => !existsSync(filePath));

  if (missingPngs.length === 0) {
    console.warn("Skipping favicon PNG generation: rsvg-convert is not available and existing PNGs are present.");
    process.exit(0);
  }

  throw new Error(
    "Cannot generate favicon PNGs: rsvg-convert is not available and one or more PNGs are missing.\n" +
      "Install librsvg locally, run npm run generate-favicons, and commit the generated PNGs."
  );
}

for (const [fileName, size] of sizes) {
  execFileSync("rsvg-convert", [
    "--keep-aspect-ratio",
    "-w",
    String(size),
    "-h",
    String(size),
    svgPath,
    "-o",
    join(outDir, fileName)
  ]);
}
