const http = require("http");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = __dirname;
const port = Number(process.env.PORT || 5188);
let updatePromise = null;

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8"
};

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload, null, 2));
}

function runScript(scriptName) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(root, "scripts", scriptName)], { cwd: root, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${scriptName}: ${stderr || stdout || error.message}`.trim()));
        return;
      }
      resolve({ script: scriptName, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

async function updateDatabase() {
  if (updatePromise) return updatePromise;
  updatePromise = (async () => {
    const startedAt = new Date().toISOString();
    const steps = [];
    for (const script of ["update-etf-master.js", "update-price-series.js", "update-issuer-official-data.js", "update-stock-master.js", "validate-etf-data.js"]) {
      steps.push(await runScript(script));
    }
    return { ok: true, startedAt, finishedAt: new Date().toISOString(), steps };
  })().finally(() => {
    updatePromise = null;
  });
  return updatePromise;
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, `http://localhost:${port}`).pathname);
  if (urlPath === "/api/database-status") {
    sendJson(res, 200, { ok: true, updateRunning: Boolean(updatePromise) });
    return;
  }
  if (urlPath === "/api/update-database") {
    if (process.env.SMOKE_TEST === "1") {
      sendJson(res, 200, { ok: true, skipped: true, reason: "smoke-test" });
      return;
    }
    updateDatabase()
      .then((result) => sendJson(res, 200, result))
      .catch((error) => sendJson(res, 500, { ok: false, error: error.message }));
    return;
  }

  if (urlPath === "/favicon.ico") {
    fs.readFile(path.join(root, "icon.svg"), (error, data) => {
      if (error) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      res.writeHead(200, { "Content-Type": "image/svg+xml; charset=utf-8" });
      res.end(data);
    });
    return;
  }

  const requested = urlPath === "/" ? "index.html" : urlPath.slice(1);
  const cleanPath = path.normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(root, cleanPath);

  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": types[path.extname(filePath)] || "application/octet-stream"
    });
    res.end(data);
  });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`小資現金流地圖 webapp: http://localhost:${port}`);
});
