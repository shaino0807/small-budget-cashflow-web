# 小資現金流APP或網頁開發

本專案用於開發可給客戶使用的理財現金流 App 或對外網頁，目標是能在手機情境中使用。

## 工作模式

- 固定規則與專案邊界記在 `AGENTS.md`。
- 進度、下一步、踩坑與收工紀錄記在 Obsidian 專案駕駛艙。
- 本地使用 Git 管理版本；GitHub repo 待 GitHub CLI 重新登入後建立。

## Web App

目前已先把原 iOS App 的「輸入資料、免費報告、mock 付費牆、完整報告、10 年模擬、12 個月現金流月曆、PDF/列印匯出」改做成靜態 PWA 原型。

- 入口：`webapp/index.html`
- 本地伺服器：`node webapp\server.js`
- 預設網址：`http://localhost:5188`
- 手機測試：電腦與手機連同一個網路後，用手機瀏覽 `http://<電腦區網IP>:5188`

ETF / 股票資料庫透過 `fetch()` 載入，正式測試請使用本地伺服器，不建議直接用 `file://` 開啟。本地 server 會提供 `/api/update-database`，網頁開啟後會嘗試背景更新官方資料；若更新失敗，App 會沿用最後通過驗證的快照。此版本不串真實金流；升級流程是本地 mock purchase。

## ETF / 股票資料庫

目前已加入官方來源快照：

- `webapp/data/etf-database.json`：ETF 主檔、近期配息、資料來源與品質標記。
- `webapp/scripts/validate-etf-data.js`：檢查 ETF 主檔、配息資料、資料日期與缺漏欄位。
- `webapp/scripts/update-market-data.js`：從 TWSE OpenAPI 下載上市 ETF 日成交快照。
- `webapp/scripts/update-price-series.js`：從 TWSE `STOCK_DAY` 下載月內價格折線。
- `webapp/scripts/import-official-csv.js`：匯入投信官方成分股或 NAV/折溢價 CSV。
- `webapp/scripts/update-stock-master.js`：從 TWSE OpenAPI 補上市股票主檔與每日行情，支援直接股票與 ETF 底層股票重疊度。
- `webapp/data/import-templates/holdings.csv`：成分股匯入格式。
- `webapp/data/import-templates/nav-series.csv`：NAV/折溢價匯入格式。

執行檢查：

```powershell
node webapp\scripts\validate-etf-data.js
```

目前已接上：0056、00878、006208 的官方主檔與近期配息。  
目前已接上 TWSE 官方月內價格折線。  
目前已接上 TWSE 上市股票主檔與每日行情，用於直接股票辨識與整體股票重疊度。  
仍待補齊：0056 完整官方成分股與 NAV/折溢價、00878 官方成分股權重；未來若要支援上櫃股票，需再接 TPEx 正式資料來源。

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
