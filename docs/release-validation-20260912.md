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

Render 已經由 Blueprint 自動同步為 checksPass，無須管理頁登入。但同步也把原本已啟用的語音改回 Blueprint 預設 0；當時恢復語音與開啟圖片的外部設定操作分別被自動核准審查拒絕，因此保持關閉並詢問明確授權。後續授權與啟用結果見下方正式啟用紀錄。

- PR #2 的完整回歸通過（run 34681366254），合併版本 `ee2ee97d7ea878722da1363c0c177ae5165aeb72`；Pages run 34681492569 已成功。
- Render 部署 dep-daig6puk1f9s73f1jao0 已 live，對應相同程式 SHA；自動部署已確認為 checksPass。
- 2026-09-13 01:09 台北時間重新核對兩個正式網址：各 18 個公開程式／畫面／素材位元組一致，各 5 個私密路徑回傳 404。Render 使用同網域 API，Pages 的 API base 正確指向 Render。原驗收工具誤把同網域空 base 當失敗，已修正且重跑通過。
- 正式站會員 bootstrap、管理報告與無簽章 LINE webhook 皆拒絕未授權請求（401）。手機版聯絡卡片字色 rgb(36,69,59)、opacity 1，無橫向溢出；長條實際使用 cashflow-grow 0.9 秒動畫；LINE 登入入口成功導向 LINE 授權頁，尚未登入真人測試帳號。
- GitHub Pages 的資料更新產生 `212818a`（僅資料），Render 程式仍為 `ee2ee97`。兩者不應假定資料快照完全相同；程式資源已分別核對。
- 2026-09-13 01:09 台北時間的健康檢查當時圖片與語音為關閉，文字記帳及 LINE 登入設定正常。已完成 6 次獲准合成圖片 API 測試，不再額外呼叫；開關後續狀態見下方紀錄。
- 後續設定修正將兩個開關改成 `sync: false`，讓部署保留正式設定；此修正不把任何開關設為 1。新建服務時須先填 0，程式對缺少開關亦預設停用。依 [Render Blueprint 規格](https://render.com/docs/blueprint-spec)，既有服務同步會略過這些變數。
- 真正 LINE 手機確認、圖片重傳、跨裝置設定重開：需使用者測試帳號實際操作，不以本機或健康檢查代替。
- LINE Pay 尚未配置正式支付資格與憑證，維持申請中並禁用付款，不宣稱可以收款。

## 正式啟用紀錄（2026-09-13 台北時間）

- 使用者明確回覆「授權啟用圖片與恢復語音及上述處理」：已閱讀告知並同意的使用者，圖片送往 OpenAI 辨識、語音送往 OpenAI 轉錄，預覽確認後才入帳。
- PR #3 已合併為 `bb1d768cf1bd0098785ea6a621c4ef8da24292a1`。兩個開關採 `sync: false`，缺少設定仍預設關閉；新增未設定時不得下載圖片／語音的回歸。完整 CI run 34707770580 通過（11 項非瀏覽器及手機／桌面瀏覽器），Pages run 34707873156 回歸、資料驗證與發布全部成功。
- 正式環境以保留其他變數的方式設定 `LINE_IMAGE_PARSER_ENABLED=1`、`LINE_VOICE_TRANSCRIPTION_ENABLED=1`、`OPENAI_STATEMENT_MODEL=gpt-4.1-mini`。沒有更换金鑰或變更客戶資料。
- Render 部署 `dep-daiok6oae00c73fbuaa0` 已 live，程式版本 `7915c5a7879b48809dc47b6af2fe25ca8abc4ece`；此提交與 PR #3 合併版本只差經 Pages 驗證的 ETF 資料更新。
- 2026-09-13 01:24:37 台北時間正式健康檢查：`imageParserConfigured=true`、`voiceTranscriptionConfigured=true`、`replyDisabled=false`、會員登入及資料庫配置正常。自動部署維持 checksPass，原 /data 持久磁碟仍保留。證據：`webapp/reports/release-activation-health-20260913.json`。
- 啟用後重新核對 Render 與 Pages：各 18 個公開程式／畫面／素材檔案符合 Git，各 5 個私密路徑 404，兩站 API 目的地正確。證據：`webapp/reports/release-public-final.json`。這次沒有額外呼叫付費辨識 API。
- 待真人驗收：LINE 告知同意、圖片／語音預覽與確認、圖片重傳、網站儲存後跨裝置重新登入；需要測試帳號操作，不能以健康檢查取代。
- 外部配置尚缺正式 LINE Pay 商店資格／憑證，以及諮詢 LINE 聯絡網址。付款維持停用；不影響免費記帳與網站開放。尚不能宣稱已可正式收款。

## 回復

先關閉 `LINE_IMAGE_PARSER_ENABLED` 可立即停止新辨識及舊圖片候選確認；不刪除客戶資料。上一個線上程式版本為 `a1a939e49cbdf78a63dd23bec8886308e72fa531`（ETF 資料更新）。資料庫新增表與欄位採相容方式，不以刪資料回復。既有加密金鑰不得重新產生或替換。
