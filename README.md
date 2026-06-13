# 小資現金流APP或網頁開發

本專案用於開發可給客戶使用的理財現金流 App 或對外網頁，目標是能在手機情境中使用。

## 工作模式

- 固定規則與專案邊界記在 `AGENTS.md`。
- 進度、下一步、踩坑與收工紀錄記在 Obsidian 專案駕駛艙。
- 本地使用 Git 管理版本；GitHub repo 已建立並使用 GitHub Pages 部署。

## Web App

目前已先把原 iOS App 的「月份財務資料、ETF 分批買入、免費報告、mock 付費牆、完整報告、資產模擬、月曆、PDF/列印匯出」改做成靜態 PWA 原型。

- 入口：`webapp/index.html`
- 本地伺服器：`node webapp\server.js`
- 預設網址：`http://localhost:5188`
- 對外網址：`https://shaino0807.github.io/small-budget-cashflow-web/`
- 手機測試：電腦與手機連同一個網路後，用手機瀏覽 `http://<電腦區網IP>:5188`

ETF / 股票資料庫透過 `fetch()` 載入，正式測試請使用本地伺服器，不建議直接用 `file://` 開啟。本地 server 會提供 `/api/update-database`，網頁開啟後會嘗試背景更新官方資料；若更新失敗，App 會沿用最後通過驗證的快照。此版本不串真實金流；升級流程是本地 mock purchase。

GitHub Pages 由 `.github/workflows/pages.yml` 部署，排程為每日台灣時間 08:30 左右更新官方資料並重新部署。

## ETF / 股票資料庫

目前已加入官方來源快照：

- `webapp/data/etf-database.json`：ETF 全市場主檔、近期配息、資料來源與品質標記。
- `webapp/scripts/validate-etf-data.js`：檢查 ETF 主檔、配息資料、資料日期與缺漏欄位。
- `webapp/scripts/update-etf-master.js`：從 TWSE ETF e添富投資篩選器更新全市場 ETF 主檔與官方篩選器分類。
- `webapp/scripts/update-market-data.js`：從 TWSE OpenAPI 下載上市 ETF 日成交快照。
- `webapp/scripts/update-price-series.js`：從 TWSE `STOCK_DAY` 下載月內價格折線。
- `webapp/scripts/import-official-csv.js`：匯入投信官方成分股或 NAV/折溢價 CSV。
- `webapp/scripts/update-stock-master.js`：從 TWSE / TPEx 官方來源補股票主檔與每日行情，支援直接股票與 ETF 底層股票重疊度。
- `webapp/data/import-templates/holdings.csv`：成分股匯入格式。
- `webapp/data/import-templates/nav-series.csv`：NAV/折溢價匯入格式。

執行檢查：

```powershell
node webapp\scripts\validate-etf-data.js
```

目前已接上 TWSE ETF e添富全市場 ETF 主檔，目前 229 檔。
目前已接上：0056、00878、006208 的近期配息。
目前已接上 TWSE 官方月內價格折線；價格折線更新只針對 `metadata.featuredTickers`，避免全市場逐檔呼叫。
目前已接上 0056 / 006208 官方成分股與 NAV/折溢價，00878 已接 NAV/折溢價。
目前已接上 TWSE 上市與 TPEx 上櫃股票主檔 / 日行情，用於直接股票辨識與整體股票重疊度。
ETF 主檔會保留 TWSE 官方篩選器可讀分類：`managerType`、`rewardTypes`、`themes`。由於 TWSE 投資篩選器 `assetType` 資產類別參數目前回 `HTTP 403`，`assetTypes` 仍保留官方缺口；前端另使用 `displayClassification` 顯示層分類，來源只限 TWSE 官方主檔欄位、官方 hashtag / rewardType 篩選器與透明關鍵字規則，不把它偽裝成官方 `assetType`。
目前前端會把官方產業代碼顯示成可讀名稱，並歸納成半導體業、電子科技業、金融股、醫療與生技、景氣循環股等分析族群；這是顯示層分類，不會把猜測分類寫回官方資料庫。
仍待補齊：00878 官方成分股權重；TWSE `assetType` 正式可讀端點。

## 對應位置

- 工作資料夾：`C:\Users\shaino\Documents\小資現金流APP或網頁`
- Obsidian vault：`C:\Users\shaino\Documents\理財產品組合包\obsidian_sync`
- 專案駕駛艙：`小資現金流APP或網頁/專案工作流程.md`

## 安全原則

不提交 API key、token、密碼、`.env`、`.codex/`、`.claude/` 或其他本機私密設定。

## Portable project skills

Portable project-local skills live in:

```text
project-skills/
```

To restore skills on a new computer:

```powershell
.\scripts\restore-skills.ps1
```

The restore script copies missing skills into the user's global Codex skills folder and does not overwrite existing global skills.
