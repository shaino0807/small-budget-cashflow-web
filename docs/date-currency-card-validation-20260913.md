# 中文日期、台幣預設及圖片結算卡片

修正語音中文金額正規化未涵蓋中文年月日，導致「二零二六年九月十三號」被判缺少日期。支援中文／阿拉伯數字及空格日期，逐筆保留不同年份；不存在日期不入帳。預覽保留轉錄文字，使用者需核對；程式不能還原轉錄服務聽錯的年份。

依使用者要求，圖片未標示幣別時以台幣計，在預覽告知；明確外幣仍拒絕、不換匯。只缺年份時補年份即可完成整批入帳，不再詢問台幣。日期、用途、金額、重複與原子交易檢查保留。

圖片補充成功後保留完整入帳明細，並附既有 Flex 月結卡片，使用實際入帳月份的資料庫統計。跨月份按月份產生卡片，以 LINE 五則訊息上限為限，完整文字收據仍保留。

本機完整回歸 `node webapp/scripts/run-ledger-regressions.js --browser` 通過（12 項腳本、手機及桌面）；補充日期有效性及備註清理後，釐清及 LINE webhook 測試再通過。證據：`webapp/reports/date-currency-card-regressions.log`、`webapp/reports/date-card-webhook.log`。

新增案例：2022 與 2026 中文／數字日期各 180、不存在日期拒絕、未知幣別預設台幣、明確外幣阻擋、只補年份後 8 筆 5,036、實際回覆 payload 含 Flex 月統計卡片。測試完全攔截外部呼叫，未上傳真實截圖、未追加付費辨識。真人 LINE 轉錄結果仍需使用者驗收。

## 正式發布與續工驗證

- 首次 PR CI 的手機標題斷言失敗：快照擷取時仍顯示「官方資料庫已更新」短暫通知。改為最多等候 12 秒讓通知自然結束，保留精確標題斷言；手機本機複驗及最新完整 CI 均通過。
- PR #8 已合併。最終 PR head `4fdba51035a4a6c36b0f277168692e8511cc2808` 的 CI `34765803697` 通過；合併版本 `69e3828fe0614d30a09e52ba421e63adfcf85b3b` 的 Pages 流程 `34765956798` 完成且 success。
- Render 部署 `dep-dajc5q8jo6nc73c8maa0` 為相同合併版本，於 2026-09-13 15:37:14 UTC 完成，狀態 live。
- 2026-09-14 01:12 台灣時間續工複驗：Pages 與 Render 各 18 個公開檔案符合 Git 版本，各 5 個私密路徑均 404；runtime API 來源正確。檔案比對不含 ETF 動態資料、runtime-config 與 .nojekyll；runtime-config 另驗來源。
- 正式健康狀態 ok；圖片與語音啟用、資料儲存正常、LINE 回覆未停用。證據：`webapp/reports/date-card-public-final.json`、`webapp/reports/date-card-health.json`、`webapp/reports/date-card-pr-final-checks.log`。
- 上次使用上限造成最後網路驗證未執行；此次已補完，未追加模型呼叫。既有 AGENTS.md 與 docs/agents 未提交變更保留。
- 真人驗收仍需重新傳圖片及錄音：中文年月日保留各筆年份；無幣別圖片預設台幣，補年份後整批入帳並附月統計卡片。模型若轉錄錯年份，仍須在確認前取消並重說，不能以本機測試宣稱真人辨識已通過。
