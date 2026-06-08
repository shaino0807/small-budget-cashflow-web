# 小資現金流APP或網頁開發

## 專案用途

本專案用於開發「小資現金流APP或網頁」，目標是完成可給客戶使用的對外網頁或可在手機使用的 App 型產品。

相關資料來源或工作脈絡：

- `C:\Users\shaino\Documents\理財產品組合包\obsidian_sync`
- 本專案不得直接修改上述來源資料夾；需要使用其內容時，先複製到本專案工作目錄內再繼續。
- 目前本地副本：`C:\Users\shaino\Documents\小資現金流APP或網頁\reference\obsidian_sync`

## 主要工作目錄

- `C:\Users\shaino\Documents\小資現金流APP或網頁`

## Git / GitHub

- 本地 Git：使用中
- 預設 branch：`main`
- GitHub repo：使用者已要求建立，但目前 GitHub CLI token 失效，待重新登入後再建立
- GitHub Pages：未啟用

## Obsidian

- Obsidian vault：`C:\Users\shaino\Documents\理財產品組合包\obsidian_sync`
- 專案駕駛艙：`小資現金流APP或網頁/專案工作流程.md`

## 工作桌 + 三個家

- 工作桌：`C:\Users\shaino\Documents\小資現金流APP或網頁`
- AGENTS.md：固定規則、路徑、專案邊界
- Obsidian 專案駕駛艙：進度、下一步、踩坑與收工紀錄
- Git / GitHub：版本管理；GitHub repo 只在使用者明確要求且 GitHub CLI 可用時建立

## 開工、收工、新專案初始化規則

- 使用者說「開工」時，先讀本檔與 Obsidian 專案駕駛艙，再確認 Git 狀態。
- 使用者說「收工」時，更新 Obsidian 專案駕駛艙，檢查 Git 狀態，必要時整理 commit。
- 使用者說「初始化專案」、「新專案初始化」或 `project-init-sync` 時，依 `project-init-sync` 技能補齊缺口。

## 主要檔案

- `AGENTS.md`
- `README.md`
- `.gitignore`
- Obsidian：`小資現金流APP或網頁/專案工作流程.md`

## 安全規則

- 不提交 API key、token、密碼、`.env` 或本機私密設定。
- 不提交 `.codex/`、`.claude/` 等本機 agent 設定。
- 不主動設定 Firebase MCP；Firebase 欄位預設為未使用。
- 不覆蓋既有 `AGENTS.md`、`README.md`、`.gitignore`。
- 不使用破壞性 Git 指令處理使用者未提交變更。

## Firebase

- 狀態：未使用
