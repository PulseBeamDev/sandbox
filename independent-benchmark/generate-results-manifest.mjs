import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname);
const resultsDir = path.resolve(process.argv[2] ?? path.join(root, "results-fair-gcp-20260718"));
const output = path.join(resultsDir, "SHA256SUMS");
const files = (await walk(resultsDir))
  .filter((file) => path.resolve(file) !== output)
  .sort((a, b) => a.localeCompare(b));
const lines = [];
for (const file of files) {
  const digest = crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
  lines.push(`${digest}  ${path.relative(resultsDir, file)}`);
}
await fs.writeFile(output, lines.join("\n") + "\n");
console.log(`${output} (${files.length} files)`);

async function walk(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(target));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}
