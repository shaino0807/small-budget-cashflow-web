# 批次資料紀錄與 FinMind 小範圍驗證

## 更新流程

Pages 與後端共用 `webapp/scripts/refresh-official-database.js`，在暫存副本更新、驗證保留規則及內容，通過後才替換正式檔案。來源不完整但可保留舊值時，結果為 `pass_with_gaps`，不宣稱全市場全欄位通過。

每批 JSON 紀錄包含：批次 ID、來源／查詢 URL、取得時間、每個資料集及來源的涵蓋日期與筆數、缺日期筆數、來源接受／拒收／保留資訊、更新步驟結果、格式版本、Node 與程式版本、前版檔案 SHA-256、產出檔案 SHA-256、內容檢查結果及未驗證範圍。

雜湊用於比對檔案位元組，不等同內容正確。內容另檢查唯一鍵、日曆日期、未來日期、新價格正值及可用 OHLC 關係、成交量與配息金額非負、持股權重範圍；並阻擋既有主檔、歷史行情流失與日期倒退。原本已存在的缺值仍列為缺口，不捏造新數字。

紀錄保存位置：

- Pages：`webapp/data/batches/<batchId>.json`，與正式資料一起版本管理；執行失敗的紀錄也會保存在 Actions artifact。
- Render：既有持久磁碟 `/data/market-batches`，可用 `DATA_BATCH_DIR` 覆寫；不混入客戶資料。
- 正式 JSON 的 `metadata.dataBatch` 提供該批摘要。完整紀錄的 `promotion=validated_candidate` 表示已驗證候選；以實際正式檔 batchId 和 outputFileSha256 比對確認是否已採用，避免跨檔案寫入被誤稱為資料庫交易。

獨立執行 updater 屬維護工具；正式入口應使用整批更新器。多人／多程序更新仍非完整的交易鎖協調。

## FinMind 試點

執行日期：2026-10-15，Asia/Taipei。範圍：0050、0056；2026-09-01 至 2026-09-30。

- FinMind `TaiwanStockPrice` 與 TWSE `STOCK_DAY` 分別讀取，未使用還原價。
- 以 ETF 代號、日期對齊；新臺幣開高低收及成交量（股）逐筆比對，未猜測或套用倍率。
- 每檔 20 個交易日、100 個數值；合計 40 筆日行情、200 個數值全部一致，缺日、重複與無效 OHLC 均為零。
- 原始回應、來源時間及 SHA-256、JSON 報告和逐欄 CSV 存在本地驗收目錄；本公開 repo 僅保存可重現程式和摘要，沒有 FinMind 原始行情。
- 結果不能推廣成 FinMind 全市場、歷史全期間、成分股或配息資料已驗收。正式行情仍使用既有官方來源；FinMind 未接入產品的正式更新流程。

重現試點（會連線官方來源及 FinMind，輸出目錄須使用私人本地路徑）：

```text
node webapp/scripts/verify-finmind-pilot.js <private-local-output-directory>
```

如帳戶需要權限，可透過環境變數 `FINMIND_TOKEN` 提供；程式不記錄 token。公開商業整合前仍須獨立核對資料授權及服務限制。

來源文件：[FinMind 日行情](https://finmind.github.io/tutor/TaiwanMarket/Technical/)、[FinMind 資料授權](https://finmind.github.io/Disclaimer/)。

## 驗證

```text
node --test webapp/scripts/test-updater-guards.js webapp/scripts/test-data-batch.js
node webapp/scripts/run-ledger-regressions.js --browser
```

本地 Node 26.1.0：42 項更新器／批次／比對測試通過；16 支既有回歸與兩種瀏覽器尺寸通過。Node 22 的遠端結果以此 PR 的 Actions 為準，不把本地結果替代 CI。

官方候選批次收錄 359 檔 ETF；242 筆 TWSE 回應中 00415A 缺發行人，拒收 1 筆；TPEx 接受 118 筆。仍有來源／既有缺值，批次狀態為 `pass_with_gaps`。TWSE 股票行情來源日 10/13、TPEx 最新日及 ETF 價格／持股／NAV 基準日 10/14，不以執行日 10/15 取代官方日期。
