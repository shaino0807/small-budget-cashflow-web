const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { publicFiles } = require("../public-files");
const { buildPublicSite } = require("./build-public-site");
const root = path.resolve(__dirname, "../..");
const destination = path.join(root, "dist", "handoff-20260912");
if (fs.existsSync(destination)) throw new Error("Handoff already exists; preserve it and use a new dated candidate");
const files = new Set([
  ...publicFiles.map(file => `webapp/${file}`),
  ...fs.readdirSync(path.join(root, "webapp")).filter(file => file.endsWith(".js")).map(file => `webapp/${file}`),
  ...fs.readdirSync(path.join(root, "webapp/scripts")).filter(file => file.endsWith(".js")).map(file => `webapp/scripts/${file}`),
  "webapp/Dockerfile", "webapp/.dockerignore", "webapp/.env.example",
  "webapp/assets/line-rich-menu.png", "webapp/assets/line-rich-menu.html",
  "webapp/data/import-templates/holdings.csv", "webapp/data/import-templates/nav-series.csv",
  "render.yaml", ".github/workflows/pages.yml", ".github/workflows/ledger-regressions.yml",
  "design-qa.md", "docs/ledger-improvements.md", "docs/ledger-release-checklist.md",
  "docs/journal-redesign.md", "docs/local-release-handoff-20260912.md"
]);
for (const file of files) {
  const absolute = path.join(root, file);
  if (!fs.statSync(absolute).isFile()) throw new Error(`Missing source file: ${file}`);
  if (/\.(?:js|yml|html|md)$/.test(file) && /sk-(?:proj-)?[A-Za-z0-9_-]{40,}|-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/.test(fs.readFileSync(absolute, "utf8"))) {
    throw new Error(`Possible secret in candidate: ${file}`);
  }
}
fs.mkdirSync(destination, { recursive: true });
buildPublicSite(path.join(destination, "public"));
for (const file of files) {
  const target = path.join(destination, "source", file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(root, file), target);
}
fs.copyFileSync(path.join(root, "webapp/reports/ledger-regressions-20260912-final.log"), path.join(destination, "local-regressions.log"));
const entries = [];
function walk(directory) {
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, item.name);
    if (item.isDirectory()) walk(absolute);
    else entries.push({ path: path.relative(destination, absolute).split(path.sep).join("/"), sha256: crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex") });
  }
}
walk(destination);
fs.writeFileSync(path.join(destination, "manifest.json"), JSON.stringify({ createdAt: new Date().toISOString(), baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), uncommittedCandidate: true, imageParserEnabled: false, productionConfigured: false, files: entries }, null, 2));
console.log(JSON.stringify({ destination, sourceFiles: files.size, publicFiles: publicFiles.length, hashedFiles: entries.length }));
