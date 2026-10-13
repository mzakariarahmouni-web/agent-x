// Embarque le dossier extension/ dans le Worker (worker/src/generated/extension.ts) pour le téléchargement
// depuis la page de configuration. Usage : node scripts/build-extension.mjs (le test vérifie que c'est à jour).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

export function render() {
  const files = readdirSync("extension")
    .filter((f) => /\.(js|json|html)$/.test(f) && f !== "config.js")
    .sort()
    .map((f) => [f, readFileSync(`extension/${f}`, "utf8")]);
  return `// Fichier généré par scripts/build-extension.mjs — ne pas modifier à la main.\nexport const EXTENSION_FILES: Record<string, string> = ${JSON.stringify(Object.fromEntries(files), null, 2)};\n`;
}

if (process.argv[1]?.endsWith("build-extension.mjs")) {
  mkdirSync("worker/src/generated", { recursive: true });
  writeFileSync("worker/src/generated/extension.ts", render());
  console.log("extension embarquée");
}
