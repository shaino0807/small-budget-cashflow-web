# 共用市場快照與公開頁可及性

Pages 排程是正式整包資料的唯一產生端。發布時，`build-public-site.js` 以資料中的 batchId 找到已驗證 manifest，檢查精確位元組 SHA-256 後，同時發布 `data/etf-database.json` 與 `data/latest-batch.json`。資料 JSON 固定 LF，避免 Windows checkout 改動雜湊。

Render 在 `RENDER` 環境自動使用本專案 Pages 的 HTTPS 來源；可用 `MARKET_SNAPSHOT_BASE_URL` 指向另一個受信任發布站。GET `/api/market/database` 或 `/data/etf-database.json` 會檢查已發布批次，最多每 60 秒檢查一次；同時進來的請求共用下載。新批次必須通過 manifest 身分、版本、日期、雜湊、內容與保留規則，才切換持久快照指標。

快照與 manifest 保存於 `CUSTOMER_DATA_DIR/market-snapshots`，與客戶資料檔分開。`GET /api/market/snapshot` 實際從磁碟讀回當前檔案及紀錄，回傳 batchId、sha256、persistentReadback、manifestVerified 和同步狀態，不回傳磁碟路徑或客戶資料。寫入故障、來源斷線或發布期間兩個檔案不一致時，保留前次快照並顯示 `preserved_previous`；重新檢查成功後恢復。部署切換期間不是跨站分散式交易，正常收斂窗口為下一個請求及最多 60 秒檢查間隔。

正式後端的 `/api/market/refresh` 現在同步 Pages 已發布批次，不會自行產生另一批，也不需要 GitHub Actions token。要產生新整包資料，執行既有 Pages workflow；個別 ETF 查詢仍走原本官方來源／15 分鐘快取。未設定遠端快照的本機維護環境保留原有更新入口。

公開 ETF 頁修正：來源狀態不再固定寫 403、分類檢查接受證交所與櫃買中心來源、未知價格保留 null。新增圖表每日數值表、可聚焦捲動表格、換頁標題焦點、輸入錯誤標記、移除比較後焦點回復、44px 比較控制項及縮放時的圖表寬度限制。整包與個別查詢日期分開說明。

驗證命令：

```text
node --test webapp/scripts/test-updater-guards.js webapp/scripts/test-data-batch.js webapp/scripts/test-market-snapshot.js
node webapp/scripts/run-ledger-regressions.js --browser
node webapp/scripts/test-market-accessibility.js http://127.0.0.1:5188/ <local-evidence-directory>
```

最後一項需要先啟動本機 `SMOKE_TEST=1` 服務，使用既有 Chrome／Edge，不安裝相依套件。測試 320／390／1440 CSS px、數字／中文搜尋、鍵盤、焦點、錯誤、圖表替代數據、控制項尺寸、代表性文字對比、減少動態及 200% CSS 縮放。這不是完整 WCAG 認證，也不能替代真人輔助科技或實體 iOS／Android 測試。

標準參考：[W3C Reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html)、[Contrast Minimum](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)、[Focus Visible](https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html)。

全市場 ETF 成分股、殖利率及追蹤指數逐檔驗收另行進行。官方未提供來源日、既有缺值仍如實保留；通過格式／同步檢查不代表所有金融數值均已獨立查證。
