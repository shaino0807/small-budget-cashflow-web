# 記帳測試月份依賴修正與本地跨月回歸

驗證日期：2026-10-11（Asia/Taipei）。本次成果為本地測試修正；GitHub CI、正式部署及資料更新尚未執行。

## 問題與修正

`test-ledger-improvements.js` 的案例使用 9 月帳目，但原斷言以未指定月份的 `lineLedgerSummary(user)` 查詢執行當月。10 月執行時，確認入帳後仍得到 10 月支出 0，因此與案例的 54,733 不符。修正前已在本機重現同一失敗。

批次預覽、確認入帳、重複確認及 Render.com 分類測試，改為明確查詢解析結果的帳目月份；保留 22 筆、支出 54,733、Render.com 案例支出 2,758，以及非投資的原斷言。圖片確認前的零入帳斷言也明確查詢圖片的 `2026-09` 月份，避免在其他月份執行時只查到空白當月。

另保留預設統計的行為驗證：預設月份為台北當月，同月份應有案例支出，其他月份應為 0。產品程式沒有修改。

新增 `test-fixture-clock.js`，僅在跨月測試的子程序中以 Node.js 內建 `node:test` 模擬 Date；不修改作業系統時間或真實計時器。`test-ledger-month-independence.js` 每個情境啟動獨立程序，執行完整的改善測試。新測試已加入 `run-ledger-regressions.js`，既有 CI 入口會執行它。

## 跨月證據

下列六個情境在 Node 26.1.0 與 Node 24.19.0 各通過一次。每個情境均保留確認前零入帳、重複確認、取消、原子回滾、設定重開、圖片同意及重複防護等既有斷言。

| 模擬台北時間 | 預設統計月份 | 月日案例解析月份 | 結果 |
|---|---|---|---|
| 2026-09-15 12:00:00 | 2026-09 | 2026-09 | 通過 |
| 2026-09-30 23:59:59 | 2026-09 | 2026-09 | 通過 |
| 2026-10-01 00:00:00 | 2026-10 | 2026-09 | 通過 |
| 2026-10-11 12:00:00 | 2026-10 | 2026-09 | 通過 |
| 2026-12-31 23:59:59 | 2026-12 | 2026-09 | 通過 |
| 2027-01-01 00:00:00 | 2027-01 | 2027-09 | 通過 |

月日案例未指定年份，因此依原本產品規則使用模擬當年的年份；固定年份的圖片案例仍是 2026-09。上述情境驗證各日期下的月份獨立性，不是同一筆待確認交易跨午夜的專門測試。

## 完整本地回歸

Node 26.1.0 執行 `node webapp/scripts/run-ledger-regressions.js --browser`：13 個測試腳本與手機 390×844、桌面 1440×900，共 15 項全部通過。

兩個瀏覽器尺寸的 consoleErrors、runtimeErrors、failedRequests、badResponses、failedApiResponses 均為空陣列。資料保存、重開、失敗後草稿保留及重試等既有操作斷言通過。瀏覽器使用 Chrome 154.0.8037.99，獨立 headless profile 與暫存客戶資料。

第一次完整回歸停在 localhost `EACCES`，屬沙箱連線限制。以所需權限重跑後完整通過；未放寬斷言。測試使用合成資料、模擬 LINE／付款／GitHub API；關閉正式模型、LINE 回覆、rich menu 自動部署與正式 GitHub dispatch。

主要證據位於本機忽略目錄 `webapp/reports/month-dependency-20261011/`：

- `before.log`：修正前 0 與 54,733 的失敗。
- `matrix-node26.log`、`matrix-node24.log`：六日期情境。
- `full-regression-node26-local.log`：完整回歸及兩個瀏覽器尺寸。
- `protected-files.json`：產品程式、資料庫與既有使用者變更的 SHA-256 保留檢查。
- `summary.json`：驗證摘要。

## 重跑命令

在專案根目錄執行：

```powershell
node webapp/scripts/test-ledger-month-independence.js
node webapp/scripts/run-ledger-regressions.js --browser
git diff --check
```

完整回歸需要本機 loopback 連線與已安裝的 Chrome／Edge。避免從含正式憑證的環境執行：本次執行時明確將 `LINE_RICH_MENU_AUTO_DEPLOY=0`、`LINE_VOICE_TRANSCRIPTION_ENABLED=0`、`OPENAI_API_KEY` 與 `GITHUB_ACTIONS_TOKEN` 清空；測試腳本另提供自己的合成憑證及 localhost mock。

## 範圍與下一階段

本次四個程式檔均位於 `webapp/scripts/`，另新增本報告；`.agent-system` 與測試日誌僅供本地交付管理。產品程式、正式 ETF 資料、既有 AGENTS.md 及 docs/agents 內容經 SHA-256 確認保持原狀。

本機已找到的 Node runtime 為 26.1.0 與內建 24.19.0；未找到與 GitHub CI 相同的 Node 22，未安裝依賴。後續需在既有 Node 22 CI 取得成功證據，才能宣稱 CI 修復完成。LINE 最新真人辨識不在本次驗收範圍。

未 stage、commit、push、建立 PR、合併、部署、更新正式資料或寫入 Obsidian。後續可先確認「僅提交測試修正與此報告、建立 PR 驗證 Node 22」的範圍；合併 main 會觸發既有 Pages 資料更新與部署，並可能觸發 Render 自動部署，需另行確認。後端市場更新 API 若要手動呼叫，也需明確授權。前次盤點的 Pages 9/30 與後端 10/2 資料日期是先前查驗狀態，本次未刷新正式資料。
