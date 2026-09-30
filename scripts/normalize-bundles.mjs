import { readFile, writeFile } from "node:fs/promises";

const bundles = ["plugins/deepseek-harness/dist/bin.mjs"];

for (const bundle of bundles) {
  const source = await readFile(bundle, "utf8");
  await writeFile(bundle, source.replace(/[\t ]+$/gmu, ""), "utf8");
}
