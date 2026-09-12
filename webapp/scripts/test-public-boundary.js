const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { publicFiles, isPublicFile } = require("../public-files");
const { buildPublicSite } = require("./build-public-site");
const root = path.resolve(__dirname, "..");
const blocked = [".env.local", ".env.example", "server.js", "customer-store.js", "statement-reader.js", "public-files.js", "scripts/test-image-privacy.js", "private-data/customers.sqlite", "reports/journal-dashboard-fixture.html", "data/../server.js", "assets/../../.env.local", "Dockerfile"];
async function main() {
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), "cashflow-public-"));
  assert.equal(buildPublicSite(destination), publicFiles.length);
  assert.throws(() => buildPublicSite(destination), /must be empty/);
  for (const file of blocked) {
    assert.equal(isPublicFile(file), false);
    assert.equal(fs.existsSync(path.join(destination, file)), false);
  }
  for (const file of publicFiles) assert.deepEqual(fs.readFileSync(path.join(destination, file)), fs.readFileSync(path.join(root, file)));
  const port = 6000 + Math.floor(Math.random() * 500);
  const server = spawn(process.execPath, [path.join(root, "server.js")], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(port), SMOKE_TEST: "0", LINE_REPLY_DISABLED: "1", LINE_IMAGE_PARSER_ENABLED: "0", LINE_AI_PARSER_ENABLED: "0", LINE_RICH_MENU_AUTO_DEPLOY: "0", GITHUB_ACTIONS_TOKEN: "", CUSTOMER_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "public-boundary-db-")), CUSTOMER_DATA_KEY: crypto.randomBytes(32).toString("base64"), ACCESS_CODE_PEPPER: crypto.randomBytes(32).toString("hex"), ADMIN_API_KEY: crypto.randomBytes(32).toString("hex") }
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Server startup timeout")), 10000);
      server.once("error", reject);
      server.once("exit", code => { clearTimeout(timer); reject(new Error(`Server exited ${code}`)); });
      server.stdout.on("data", chunk => { if (String(chunk).includes("webapp:")) { clearTimeout(timer); resolve(); } });
    });
    for (const file of blocked.concat(["%2eenv.local", "private-data%2fcustomers.sqlite"])) {
      const response = await fetch(`http://127.0.0.1:${port}/${file}`);
      assert.equal(response.status, 404, file);
    }
    for (const file of ["index.html", "journal.css", "app.js", "privacy.html", "assets/icons/house.svg"]) {
      const response = await fetch(`http://127.0.0.1:${port}/${file}`);
      assert.equal(response.status, 200, file);
      if (file === "app.js") assert.equal(response.headers.get("cache-control"), "no-cache");
    }
  } finally { server.kill(); }
  const blueprint = fs.readFileSync(path.join(root, "..", "render.yaml"), "utf8");
  assert.match(blueprint, /key: LINE_IMAGE_PARSER_ENABLED\s+value: "0"/);
  assert.match(fs.readFileSync(path.join(root, ".env.example"), "utf8"), /LINE_IMAGE_PARSER_ENABLED=0/);
  assert.match(fs.readFileSync(path.join(root, "..", ".github/workflows/pages.yml"), "utf8"), /path: dist\/public/);
  // Exercise the service-worker cache contract without a browser or network.
  const handlers = {};
  let cachedWrites = 0, fetchOptions, failNetwork = false, status = 200;
  const sandbox = {
    URL, self: { addEventListener: (name, handler) => { handlers[name] = handler; } },
    fetch: async (_, options) => { fetchOptions = options; if (failNetwork) throw new Error("offline"); return new Response("fresh", { status }); },
    caches: { open: async () => ({ put: () => { cachedWrites++; } }), match: async () => new Response("cached") }
  };
  require("node:vm").runInNewContext(fs.readFileSync(path.join(root, "sw.js"), "utf8"), sandbox);
  async function loadShell() {
    let response;
    handlers.fetch({ request: { method: "GET", mode: "navigate", url: "https://local.test/index.html" }, respondWith: promise => { response = promise; } });
    return (await response).text();
  }
  assert.equal(await loadShell(), "fresh");
  assert.equal(fetchOptions.cache, "no-cache");
  assert.equal(cachedWrites, 1);
  status = 500; await loadShell(); assert.equal(cachedWrites, 1, "server errors must not replace the offline shell");
  failNetwork = true; assert.equal(await loadShell(), "cached");
  console.log(JSON.stringify({ passed: true, publicFiles: publicFiles.length, backendAndSecretsBlocked: true, publicArtifactExact: true, productionImageDefault: "off", externalCalls: 0 }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
