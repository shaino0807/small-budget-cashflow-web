const fs = require("fs");
const path = require("path");

const apiBase = "https://api.line.me";
const dataBase = "https://api-data.line.me";
const menuName = `Chen Dino 現金流記帳 ${process.env.LINE_RICH_MENU_VERSION || "v1"}`;
const siteUrl = String(process.env.SITE_PUBLIC_BASE_URL || "https://shaino0807.github.io/small-budget-cashflow-web/");
const imageArg = process.argv.find((value) => value.startsWith("--image="));
const imagePath = path.resolve(imageArg ? imageArg.slice("--image=".length) : path.join(__dirname, "..", "assets", "line-rich-menu.png"));
const dryRun = process.argv.includes("--dry-run");
const force = process.argv.includes("--force");

const richMenu = {
  size: { width: 2500, height: 843 },
  selected: true,
  name: menuName,
  chatBarText: "開啟現金流選單",
  areas: [
    { bounds: { x: 0, y: 0, width: 833, height: 421 }, action: { type: "message", label: "記一筆支出", text: "記一筆支出" } },
    { bounds: { x: 833, y: 0, width: 834, height: 421 }, action: { type: "message", label: "記一筆收入", text: "記一筆收入" } },
    { bounds: { x: 1667, y: 0, width: 833, height: 421 }, action: { type: "message", label: "ETF 配置", text: "ETF 配置" } },
    { bounds: { x: 0, y: 421, width: 833, height: 422 }, action: { type: "message", label: "本月摘要", text: "本月摘要" } },
    { bounds: { x: 833, y: 421, width: 834, height: 422 }, action: { type: "uri", label: "完整報告", uri: siteUrl } },
    { bounds: { x: 1667, y: 421, width: 833, height: 422 }, action: { type: "message", label: "綁定網頁", text: "綁定網頁帳號" } }
  ]
};

function token() {
  const value = String(process.env.LINE_CHANNEL_ACCESS_TOKEN || "");
  if (value.length < 32) throw new Error("LINE_CHANNEL_ACCESS_TOKEN 尚未設定");
  return value;
}

async function lineRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${token()}`, ...(options.headers || {}) },
    signal: AbortSignal.timeout(20000)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`LINE API HTTP ${response.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}

async function main() {
  if (!fs.existsSync(imagePath)) throw new Error(`找不到 Rich Menu 圖片：${imagePath}`);
  const image = fs.readFileSync(imagePath);
  if (image.length > 1024 * 1024) throw new Error("Rich Menu 圖片超過 LINE 1 MB 限制");
  if (dryRun) {
    console.log(JSON.stringify({ ok: true, dryRun: true, imagePath, imageBytes: image.length, richMenu }, null, 2));
    return;
  }
  await lineRequest(`${apiBase}/v2/bot/richmenu/validate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(richMenu)
  });
  const existing = await lineRequest(`${apiBase}/v2/bot/richmenu/list`);
  const reusable = (existing.richmenus || []).find((menu) => menu.name === menuName);
  if (reusable && !force) {
    await lineRequest(`${apiBase}/v2/bot/user/all/richmenu/${encodeURIComponent(reusable.richMenuId)}`, { method: "POST" });
    console.log(JSON.stringify({ ok: true, richMenuId: reusable.richMenuId, reused: true }, null, 2));
    return;
  }
  const created = await lineRequest(`${apiBase}/v2/bot/richmenu`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(richMenu)
  });
  const richMenuId = created.richMenuId;
  await lineRequest(`${dataBase}/v2/bot/richmenu/${encodeURIComponent(richMenuId)}/content`, {
    method: "POST",
    headers: { "Content-Type": "image/png" },
    body: image
  });
  await lineRequest(`${apiBase}/v2/bot/user/all/richmenu/${encodeURIComponent(richMenuId)}`, { method: "POST" });
  const replaced = (existing.richmenus || []).filter((menu) => menu.name === menuName && menu.richMenuId !== richMenuId);
  for (const menu of replaced) {
    await lineRequest(`${apiBase}/v2/bot/richmenu/${encodeURIComponent(menu.richMenuId)}`, { method: "DELETE" });
  }
  console.log(JSON.stringify({ ok: true, richMenuId, replaced: replaced.map((menu) => menu.richMenuId) }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
