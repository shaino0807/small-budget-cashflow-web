---
title: 小資現金流資安部署收工
date: 2026-11-21
type: project-closeout
tags: [小資現金流, 資安, 部署, 收工]
---

# 2026-11-21 資安修補與部署收工

核對日期：2026-11-21，Asia/Taipei。本次沿用已完成部署，沒有再觸發部署、重跑 Actions 或修改金流與客戶權限。

## 網址與版本

- 客戶主要入口：[Chen Dino 個人現金流管理](https://small-budget-cashflow-api.onrender.com/)。登入與日常使用請提供這個網址。
- [GitHub Pages](https://shaino0807.github.io/small-budget-cashflow-web/)、[GitHub repo](https://github.com/shaino0807/small-budget-cashflow-web)。
- 資安修補 [PR #18](https://github.com/shaino0807/small-budget-cashflow-web/pull/18) 已合併，程式版本 `16677b26c252be7644b110a07be09e63404ffd54`。
- 修補發布 [Actions 44460121551](https://github.com/shaino0807/small-budget-cashflow-web/actions/runs/44460121551) 成功；包含 Windows、Node 24 Alpine 與 Pages 工作。
- 最新 [Actions 44696177553](https://github.com/shaino0807/small-budget-cashflow-web/actions/runs/44696177553) 成功；Pages 部署 `7936165829`，部署紀錄 SHA `c4c7ab07869619594d8e9efda70b014d2a8005ac`。
- Render 部署 `dep-dbvvrhgae00c73an9k70` 為 live，同為 `c4c7ab0`，於 2026-11-20 16:00（臺灣時間）完成。此版本相較修補 merge 只增加 ETF 資料更新，保留修補。
- GitHub main 已前進至 `1094df807336a148b684c3fcf50bf225fd7fc555`，比上述部署 SHA 多一筆 ETF 資料提交；差異只有 `webapp/data/` 兩個檔案。排程會更新並提交資料，不能把 workflow head、資料提交與供應商部署紀錄當成必然相同的版本。

## 完成的兩項修補

1. AUTH-01：OAuth state、PKCE、nonce 加入發起瀏覽器的交易 Cookie 綁定。Cookie 採 `__Host-`、Secure、HttpOnly、SameSite=Lax、Path=/；先驗證綁定及期限再消耗交易。缺漏、偽造、其他分頁的 Cookie 不得換入 Session；各分頁交易分開處理。舊的進行中登入需要重新開始。
2. AUTH-02：畸形 URL 解碼例外回傳 400，並在 HTTP 請求邊界接住非同步錯誤，避免未處理例外終止服務。

沒有修改資料庫 schema、付款設定或正式會員資格。

## 驗證與仍有的缺口

- 修補隔離測試 11/11；會員 API 40 項、導覽 7 項、瀏覽器 14 項及既有登入回歸通過。PR 和 main 的 Node 24 Alpine CI 補足本機 Node 26 與正式環境的版本差異。
- 正式 Render、Pages 首頁與靜態檔案可讀；程式資產比對符合修補版。健康檢查與匿名 Session 回應正常；虛構範例報告可開啟。
- 正式 OAuth 起始轉址與 Cookie 屬性、缺失／偽造綁定、取消登入的負向檢查通過；未建立真實 LINE 登入 Session。
- 正式異常網址驗收未全過：`%` 與 `%E0%A4%A` 回傳 Cloudflare HTML 520；`%GG` 為 HTML 400，未符合原定應用程式 JSON 400；`%FF` 為預期 JSON 400。後續檢查共 22/24 通過，保留失敗，不改低驗收標準。
- 各異常請求後健康檢查仍為 200；觀察期間未查到對應 Render 重啟事件或 URIError 日誌。但沒有程序 PID 證據，520 的來源仍待釐清，不能宣稱完全沒有重啟或已證明是代理層問題。
- 真實 LINE 帳號登入、跨裝置登入及登入後會員操作仍待本次修補後驗收。這不是全站資安合格證明。
- 本地發布驗收狀態保留 `needs_review`；部署成功與完整驗收分開記錄。

## 下次待辦

1. 追查畸形網址 520／HTML 400 回應來源並依原測試回歸。
2. 以擁有人帳號完成 LINE 登入與會員／管理員實際操作驗收。
3. 設定擁有人的 LINE Pay 收款方式；先確認個人轉帳或商家金流及顯示方式，避免公開敏感帳戶資訊。
4. 決定付款者、訂單與會員如何對應；收款核對後由管理員開通／撤銷並保留操作紀錄，涵蓋重複付款與退款。尚未建立自動對帳或自動開通承諾。

付款兩項另存於本專案 `docs/payment-todos-20261030.md`，本次只記錄，不變更付款功能。

## 收工交接

- 踩坑與防再犯做法另見 [資安與部署踩坑](security-pitfalls-20261121.md)。
- 本次只將這兩份公開文件提交至既有 `codex/security-fixes-20261119` 分支；不合併 main。文件提交使用 `[skip ci] [skip render]`，避免重新發布。
- 私人測試證據保留於本機 `security-audit/20261119-release/`；不提交 `.agent-system`、客戶資料、Cookie、金鑰或測試資料庫。
- 保留根目錄及隔離 checkout 未提交變更，不 reset、stash 或全目錄 stage。
- Obsidian 沿用已確認的主要 Vault 既有 `Codex Logs`，分開保存收工與踩坑，並追加知識庫操作日誌。指定專案駕駛艙路徑不存在，不另建替代 Vault。Vault 寫入讀回不代表 Google Drive 雲端同步已驗證。
