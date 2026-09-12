// One explicit release boundary shared by the HTTP server and Pages packaging.
const publicFiles = [
  "index.html", "privacy.html", "styles.css", "journal.css", "app.js",
  "cashflow-visual.js", "runtime-config.js", "sw.js", "manifest.webmanifest", "icon.svg", ".nojekyll",
  "data/etf-database.json", "assets/journal-home.png", "assets/journal-notebook.png",
  "assets/icons/LICENSE.txt", "assets/icons/arrow-right.svg", "assets/icons/calendar3.svg",
  "assets/icons/file-earmark-text.svg", "assets/icons/graph-up.svg", "assets/icons/house.svg",
  "assets/icons/journal-text.svg"
];
const allowed = new Set(publicFiles);
function isPublicFile(relativePath) { return allowed.has(relativePath); }
module.exports = { publicFiles, isPublicFile };
