# 本機交付：圖片明細記帳與居家風格網頁

日期：2026-09-12（Asia/Taipei）。狀態：本機修改與針對性驗證完成，交付候選版；尚未推送、發布或啟用圖片辨識。所有既有未提交變更保留。

基底 Git：`main` / `3f06eb9d1c0bdf7d90130c90fa23bbdfe4e4cbc7`。這只是基底，不能當成未提交候選版的版本證據；交付包內 `manifest.json` 記錄實際檔案 SHA-256。AGENTS.md 與 docs/agents/skill-maintenance.md 為既有非功能變更，未納入交付包或修改。

## 已完成

- 保留多行完整解析、確認後整批原子入帳、Render.com 支出規則、年度及 12 月設定與空 ETF 清單的保存。
- 圖片：使用者告知／同意、限流、8 MB／40 筆限制、下載與 API 逾時、只接受完整可核對的台幣明細、確認／取消與重複防護。
- 補強：錯誤訊息去除內部內容；格式簽章檢查；缺少完成狀態與異常描述拒絕；同張重複、AI 誤標繳款／轉帳再由規則拒絕；一對一聊天限定；取消或停用與非同步回應競爭時不恢復草稿；總開關關閉後也不能確認舊圖片草稿。
- 隱私：候選加密、原圖僅記憶體、Responses `store:false`、不轉發模型原始警告、刪除帳號／全部資料涵蓋新增表、每分鐘清理過期候選。
- 網頁：居家風格、長條與數字明細、儲存按鈕、同意錯誤不重疊且立即清除、聯絡卡片深色文字、來源卡片換行、可見時才播放長條動畫。減少動態設定下仍保留可讀內容。
- 發布範圍：共用 21 個公開檔案的白名單；Pages 僅上傳 `dist/public`；正式後端 HTTP 不提供程式、`.env`、資料庫與測試檔。程式快取重新驗證；失敗回應不蓋掉離線頁。Service Worker 版本 `cashflow-map-v31`。

## 實際驗證結果

| 驗證 | 結果 |
|---|---|
| `node webapp/scripts/run-ledger-regressions.js` | 10 項腳本全數通過 |
| 原圖文字案例 | 22 筆候選；21 筆付款合計 54,733、收入 68,981；確認前不入帳 |
| Render.com 案例 | 四筆支出合計 2,758，投資 0 |
| 整批回滾、設定重開、空 ETF | 通過 |
| 圖片隱私／fail-closed | 關閉、未同意、群組、無 key、無效格式／結果、取消競爭、撤銷後重啟、逾期、重複、刪除與錯誤遮蔽通過 |
| 公開檔案邊界 | 實際本機 HTTP 拒絕私密路徑；21 個公開檔案打包位元組一致 |
| 快取契約 | 新版重新驗證、HTTP 500 不覆蓋快取、離線回退通過（VM 單元測試） |
| CUA 網頁 | 390×844 與 1440×900：第六步錯誤間距 24 px；勾選同意即清除；來源卡片與頁面橫向溢出 0；聯絡文字深色、opacity 1；更新隱私頁可讀 |
| JavaScript 語法與 `git diff --check` | 通過 |

日誌：`webapp/reports/ledger-regressions-20260912-final.log`（本機忽略檔，交付包另附副本）。圖片分支只在隔離測試程序、虛構金鑰與攔截網路的環境中模擬啟用；未修改本機私密環境檔、Render 設定或正式開關，真實圖片／LINE 外部呼叫為 0。

未執行：完整 `--browser` CLI 套件（其使用 raw CDP；本次 UI 依工具限制使用 CUA）、真實 OCR、LINE 手機端、跨裝置登入同步、Docker build、Render CLI Blueprint 驗證及 GitHub 雲端 CI。Docker／Render CLI 本機未找到。這些項目不得標成通過，完整 CI 與發布清單仍是發布前後的必要驗收。

## 交付內容及使用方式

`dist/handoff-20260912/` 只在本機建立，包含 `public/`、可放回儲存庫的 `source/`、測試日誌與 SHA-256 manifest。`public/` 是公開檔案候選產物，不含後端與測試資料。其 `runtime-config.js` 仍是本機／同源預設（API base 空白）；GitHub Pages 必須先注入已核對的 BACKEND_API_BASE 再重新打包，不能直接當作已設定好的正式站。

重建公開內容：在新的空目錄執行 `node webapp/scripts/build-public-site.js <destination>`；目錄已有檔案會拒絕，以免殘留私密資料混入。CI 已串接同一打包器。後端使用 source/webapp 的 Docker context；本機未建立 Docker image。

## 剩餘外部設定與發布關卡

1. Render：核對既有持久磁碟 `/data`、CUSTOMER_DATA_KEY／ACCESS_CODE_PEPPER／ADMIN_API_KEY 與資料備份。不得重新產生既有加密 key；確認 `SMOKE_TEST` 未設定或為 0，Blueprint `checksPass` 確實套用。
2. LINE：核對 Messaging API secret、access token、webhook URL／簽章；登入 channel、callback、LIFF 與網站 CORS 對應。此次沒有登入控制台、讀取或更動實際值。
3. Pages：設定 BACKEND_API_BASE、聯絡 LINE URL 與既有價格參數；重新 build runtime config，再白名單打包。檢查前後端實際版本一致；先後端再前端。
4. 圖片功能保持 `LINE_IMAGE_PARSER_ENABLED=0`。日後另行核准後，核對 OPENAI_API_KEY、OPENAI_STATEMENT_MODEL（預設 gpt-4.1-mini）、模型存取／計費與第三方資料政策，先用合成圖片在真實 LINE 一對一流程驗收，再決定開放。`store:false` 不是第三方所有用途的零留存保證。
5. 發布前完整 CI（含手機／桌面 CLI 套件）及 Docker／Blueprint 驗證；發布後執行 `ledger-release-checklist.md`。既有錯帳需逐筆另行核對，不能透過重複新增來修正。

此交付沒有 commit、push、部署、送出 LINE 訊息、付費辨識、改寫正式帳目或更新 Obsidian／記憶。
