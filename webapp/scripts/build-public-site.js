const fs = require("node:fs");
const path = require("node:path");
const { publicFiles } = require("../public-files");
const root = path.resolve(__dirname, "..");
function buildPublicSite(destination) {
  // A new directory prevents leftovers from an earlier broad copy leaking into a release.
  fs.mkdirSync(destination, { recursive: true });
  if (fs.readdirSync(destination).length) throw new Error("Public destination must be empty");
  for (const relative of publicFiles) {
    const target = path.join(destination, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, relative), target);
  }
  return publicFiles.length;
}
if (require.main === module) {
  const destination = path.resolve(process.argv[2] || path.join(root, "..", "dist", "public"));
  console.log(JSON.stringify({ destination, files: buildPublicSite(destination) }));
}
module.exports = { buildPublicSite };
