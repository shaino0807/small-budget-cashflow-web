# 2026-09-12 對外版本驗證

此文件記錄後續發布進度；先前 `local-release-handoff-20260912.md` 與 `dist/handoff-20260912` 為較早的本機候選證據，保留不覆寫，不代表本次上線版本。

## 範圍與狀態

已獲准執行本機完整瀏覽器測試、功能提交／推送、GitHub Pages 與既有 Render 服務發布，及合成圖片外部辨識。保留既有 AGENTS.md、docs/agents/skill-maintenance.md，未納入功能提交；保留遠端 ETF 資料更新。

## 本機驗證

- 10 項非瀏覽器測試及 390×844、1440×900 瀏覽器測試通過。涵蓋文字 22 筆、Render.com 支出、原子回滾、完整設定保存與清空 ETF、錯誤保留草稿、圖片同意／撤銷／重複／逾期、公開檔案白名單與快取。
- 瀏覽器測試改為核對新版頁面標題、實際導覽與圖片載入，保留財務數字和權限檢查；修正登入後工具列高度，仍須符合原 66 px 上限。
- 合成圖片實際 OpenAI API 初次：正常收支與轉帳／繳卡費通過；缺年份／缺金額未通過測試預期。舊診斷只記錄 assertion，無法從該次紀錄確定是候選數或疑慮數差異，不宣稱已確認模型當次回應。
- 追加診斷：缺漏圖片回傳 0 候選、5 項待釐清。另補 `dateEvidence`：必須抄錄原圖可見完整年月日，並由伺服器核對正規化日期一致，缺漏或不一致則拒絕。這是額外約束，不能保證 OCR 永不犯錯，仍需使用者逐筆確認。
- 新日期規則實際複驗通過（2026-09-12 07:21 UTC）：正常圖保留 3 筆（支出 230、970；收入 68,981），缺漏圖 0 筆候選／5 項待釐清。共使用原授權 3 次與追加 3 次；不再呼叫付費辨識。規則修改後完整本機回歸再次通過，日誌 `release-final-regressions.log`。
- 外部辨識原圖只用本機合成資料，Responses 使用 `store:false`。不在 CI 執行付費測試，不使用真實帳單、不自動重試。

重現本機測試：`node webapp/scripts/run-ledger-regressions.js --browser`。
合成圖片：Windows 執行 `webapp/scripts/create-synthetic-statements.ps1`；取得付費授權後才執行 `node webapp/scripts/verify-live-statement.js --allow-three-synthetic-calls`，可用 `--case=statement-incomplete` 限定單張。
本機日誌位於 `webapp/reports/release-*.log`，不公開到網站。

## 外部驗收（待完成時不得標示通過）

首批程式已合併：PR #1，`2c9a9a9218633ccc2c566f726dc41e433d047cb9`。PR 的完整 GitHub 回歸成功（run 34680716863）；Render 部署 dep-daifu42q185c73a6440g 已 live，18 個程式／畫面／素材公開檔案與 Git 位元組一致，5 個私密路徑回傳 404。

Pages run 34680814497 的回歸通過，但資料日期驗證失敗：股票更新已有保留前次完整快照的機制，finalize 卻改讀本次失敗 attempt 的空日期，丟失保留資料真正的日期。後續修正直接取已保存 TPEx 官方行情列日期，並明確顯示「保留前次資料」與本次 attempt 狀態；保留原驗證，新增來源日期與資料列一致檢查及離線回歸。原先 Pages 尚未換版，不能宣稱完成。

Render 已經由 Blueprint 自動同步為 checksPass，無須管理頁登入。但同步也把原本已啟用的語音改回 Blueprint 預設 0；恢复語音與開啟圖片的外部設定操作分別被自動核准審查拒絕，已詢問明確的外部資料處理授權。兩個開關仍為 0，沒有繞過拒絕改寫 Blueprint。

- GitHub PR 回歸、Pages 成功與公開資源比對：待執行。
- Render 對應 Git SHA、健康與私人路徑拒絕：待執行。
- 既有 Render 自動部署仍為 commit，管理介面登入待完成；目標為 checksPass。
- LINE 圖片開關仍維持關閉，等待外部測試與發布確認。
- 真正 LINE 手機確認、圖片重傳、跨裝置設定重開：需使用者測試帳號實際操作，不以本機或健康檢查代替。
- LINE Pay 尚未配置正式支付資格與憑證，維持申請中並禁用付款，不宣稱可以收款。

## 回復

先關閉 `LINE_IMAGE_PARSER_ENABLED` 可立即停止新辨識及舊圖片候選確認；不刪除客戶資料。上一個線上程式版本為 `a1a939e49cbdf78a63dd23bec8886308e72fa531`（ETF 資料更新）。資料庫新增表與欄位採相容方式，不以刪資料回復。既有加密金鑰不得重新產生或替換。
