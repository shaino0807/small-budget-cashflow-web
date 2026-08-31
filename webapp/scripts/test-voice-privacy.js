const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const privacy = fs.readFileSync(path.join(root, "privacy.html"), "utf8");
const index = fs.readFileSync(path.join(root, "index.html"), "utf8");
const envExample = fs.readFileSync(path.join(root, ".env.example"), "utf8");
const renderBlueprint = fs.readFileSync(path.join(root, "..", "render.yaml"), "utf8");

const requiredPrivacyCopy = [
  "OpenAI Audio Transcription",
  "原始音訊只在處理期間存在於記憶體",
  "30 分鐘",
  "1,095 天",
  "每日最多送出 30 次",
  "停用語音記帳",
  "刪除全部資料"
];

for (const copy of requiredPrivacyCopy) {
  if (!privacy.includes(copy)) throw new Error(`Privacy page is missing required copy: ${copy}`);
}
if (!index.includes('href="./privacy.html"')) throw new Error("Homepage footer does not link to privacy.html");
if (!envExample.includes("LINE_VOICE_DAILY_LIMIT=30")) throw new Error(".env.example daily voice limit is not 30");
if (!envExample.includes("LINE_VOICE_PILOT_MODE=0")) throw new Error(".env.example is not configured for persistent consent mode");
if (!/key: LINE_VOICE_TRANSCRIPTION_ENABLED\s+value: "0"/.test(renderBlueprint)) {
  throw new Error("Render blueprint must keep voice transcription disabled during code deployment");
}
if (!/key: LINE_VOICE_DAILY_LIMIT\s+value: "30"/.test(renderBlueprint)) {
  throw new Error("Render blueprint daily voice limit is not 30");
}

console.log(JSON.stringify({
  ok: true,
  homepagePrivacyLink: true,
  memoryOnlyAudioDisclosure: true,
  encryptedPendingRetentionDisclosed: true,
  confirmedRetentionDisclosed: true,
  dailyLimit: 30,
  safeDeployDefault: "off"
}, null, 2));
