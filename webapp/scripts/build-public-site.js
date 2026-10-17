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
    if (relative === "data/latest-batch.json") {
      const bytes = fs.readFileSync(path.join(root, "data/etf-database.json"));
      const id = JSON.parse(bytes).metadata?.dataBatch?.batchId;
      if (!/^[A-Za-z0-9-]{10,100}$/.test(id)) throw new Error("Invalid published batch ID");
      const manifest = JSON.parse(fs.readFileSync(path.join(root, "data/batches", id + ".json")));
      require("../market-snapshot").verifySnapshot(bytes, manifest);
      fs.writeFileSync(target, JSON.stringify(manifest, null, 2) + "\n");
    } else if (relative === "data/etf-catalog.json") {
      const db = JSON.parse(fs.readFileSync(path.join(root,"data/etf-database.json")));
      fs.writeFileSync(target,JSON.stringify(require("../market-view").marketCatalog(db)));
      const service = require("../etf-market").createEtfMarketService({readDatabase:()=>({db,key:db})});
      fs.mkdirSync(path.join(destination,"data/etfs"),{recursive:true});
      for (const etf of db.etfs) {
        const data = service.getSaved(etf.ticker,6);
        fs.writeFileSync(path.join(destination,"data/etfs",etf.ticker+".json"),JSON.stringify({ok:true,data}));
      }
    } else fs.copyFileSync(path.join(root, relative), target);
  }
  return publicFiles.length;
}
if (require.main === module) {
  const destination = path.resolve(process.argv[2] || path.join(root, "..", "dist", "public"));
  console.log(JSON.stringify({ destination, files: buildPublicSite(destination) }));
}
module.exports = { buildPublicSite };
