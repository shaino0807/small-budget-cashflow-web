# 溫暖生活理財版型：本機交付

更新：2026-09-11。狀態：本機完成，尚未發布。

採用使用者選擇的第二種居家雜誌風格，融入第三種的大數字、比例長條及交易明細。首頁使用米白、深綠與赭黃，搭配閱讀角落與筆記本照片；填寫、月總覽與儲存區沿用同一套視覺。

## 實作

- `webapp/journal.css`：主題、響應式排版、按鍵回饋、表格與動態減量樣式。
- `webapp/index.html`：首頁、示範收支、關於 Dino、標準導覽圖示。
- `webapp/cashflow-visual.js`：收入、支出、投資與剩餘的比例計算；零值與缺口不製造假收入。
- `webapp/app.js`：串接實際帳目長條與明細表，保留預算及實際帳的區分。
- `webapp/sw.js`：快取版本 `cashflow-map-v31`，包含新樣式與視覺計算模組。
- `webapp/scripts/test-cashflow-visual.js`：比例、投資、無收入、空資料與超支案例，已納入回歸入口。

## 素材

`assets/journal-home.png` 與 `assets/journal-notebook.png` 為本次生成素材。`assets/icons/` 使用 Bootstrap Icons 1.13.1，MIT 授權保留於同目錄 LICENSE.txt。字體使用 Google Fonts 的 Noto Sans TC / Noto Serif TC，並有系統字體備援。

## 驗證與續作

完整驗收見根目錄 `design-qa.md`。本次八項非瀏覽器回歸腳本通過；桌面、手機、套用全年後重開，以及 ETF 刪除後重開均已做本機檢查。手機表格最終實測寬度 335px，四欄無橫向溢出。

先前五項記帳防護與儲存修正繼續保留，詳見 `ledger-improvements.md`。圖片 AI 的真實辨識品質、正式 LINE 與正式帳號同步仍需發布後驗證；本機測試不代表線上客戶已使用修正版。

補驗修正：第六步錯誤提示改為正常文流，勾選同意立即清除提示；聯絡卡片恢復深色文字；來源日期卡片可換行且改中文標籤。進場、依序淡入、按鍵回饋與長條展開已補強，長條滑入畫面才播放。詳細量測及先前驗收遺漏已記錄於 `design-qa.md`。

本機預覽：http://localhost:5198/ 。`webapp/reports/` 內比對與合成資料頁只供本機驗收，不應加入發布內容。
