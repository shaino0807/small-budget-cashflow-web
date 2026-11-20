---
title: 小資現金流資安與部署踩坑
date: 2026-11-21
type: project-pitfalls
tags: [小資現金流, 資安, 部署, 踩坑]
---

# 2026-11-21 資安與部署踩坑

範圍：本次 AUTH-01／AUTH-02 修補、GitHub／Render 發布與收工。這是本專案經驗紀錄，不自動變更全域規則。

| 踩到的坑／證據 | 本次處理與下次做法 |
| --- | --- |
| 有 state、PKCE、nonce，仍不能單憑它們證明回呼屬於發起登入的瀏覽器。 | 綁定每次登入的 HttpOnly Cookie；先驗證再消耗交易。補缺漏、偽造、其他交易、重放與多分頁測試。 |
| 多個 Set-Cookie 若互相覆蓋，可能清除交易時連 Session 也丟失。 | 使用追加方式；每筆交易有獨立 Cookie。回歸同時檢查交易清除與 Session 保留。 |
| 非同步 HTTP handler 的 URL 解碼例外可能跳過既有錯誤處理，終止程序。 | 解碼失敗回 400，請求邊界處理 rejection；測完異常後再驗證正常請求，不只看單一錯誤回應。 |
| 本機 Node 26 通過不代表正式 Node 24 Alpine 已通過。 | 使用 PR 與 main 的 Node 24 Alpine CI 實際證據，再分別記錄本機與正式驗證。 |
| 正式端畸形 URL 有 HTML 400、Cloudflare 520，與本機 JSON 400 不同。 | 原始失敗證據保留，後續測試繼續收集各案例但不放寬斷言。健康檢查及空的事件查詢不能證明根因；520 尚待追查。 |
| GitHub 外掛能讀不代表能寫；提交樹與 PR 操作收到 403 Resource not accessible by integration。 | 改用已驗證且有授權的 Git／GitHub CLI。先確認外部回執，不盲目重送，也不輸出憑證。 |
| 根目錄 main、隔離 checkout、遠端 main 與實際部署版本不同，且既有 dirty work 不能丟。 | 用明確檔案清單與獨立 Git index 建立修補提交；比對最新 main，保留排程 ETF 資料及所有未提交變更。不得 git add 全目錄或 reset。 |
| merge 成功不等於 Pages 與 Render 已生效；排程也會另提交 ETF 資料。 | 分別核對 Actions jobs、Pages deployment、Render live SHA 及公開程式內容。遇純資料後繼提交時比對差異，不聲稱所有 SHA 相同。 |
| 中斷、額度限制或逾時後重送外部動作，可能造成重複發布。 | 恢復時先查 PR、分支、Actions、Render 回執。修補已上線，本次收工不重新部署。舊 run 逾時歷史保留，新 run 只涵蓋新授權工作。 |
| 指定 Obsidian 駕駛艙路徑不存在，其他已註冊 Vault 也不一定是主要 Vault。 | 以 open vault 設定與連接器實際路徑確認主要 Vault；沿用既有 Codex Logs，追加可辨識記錄並讀回。不另造 Vault，不把讀回當雲端同步證明。 |
| 收款、辨認付款者與會員開通是不同流程；有後台開通不代表已有付款自動化。 | LINE Pay 設定與付款者對應各列待辦，明確保留管理員核對、開通／撤銷與稽核需求。 |

## 可重複使用的收工順序

1. 先核對 repo、分支、dirty work 及已存在的外部回執。
2. 分開記錄程式修補版本、資料更新版本、CI、Pages 與 Render。
3. 檢查公開網址與必要行為；區分通過、失敗、未執行。
4. 只提交明確允許的公開檔案；私人證據與客戶資料留在本機。
5. 追加 Obsidian 記錄並讀回，保留舊筆記；已部署就不再部署。

本次狀態與客戶入口見 [資安部署收工](security-closeout-20261121.md)。
