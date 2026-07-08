# Data Inbox — 上傳 NSW VG 資料到這裡

NSW Valuer General 的網站會擋 GitHub 的伺服器（403），所以資料無法自動下載，
需要手動上傳。**只有真實解析成功的 VG 資料會被發佈到網站**。

## 每週更新步驟

1. 在自己的電腦開啟 NSW VG 的 bulk PSI 下載頁：
   <https://valuation.property.nsw.gov.au/embed/propertySalesInformation>
2. 下載最新一週的 **Weekly Sales** ZIP 檔（每週一發佈）。
3. 回到本 repo 的 `data-inbox/` 資料夾（main branch）→ **Add file → Upload files**
   → 把 ZIP 拖進來 → Commit changes。
4. 完成。GitHub Actions 會自動：解析 ZIP → 合併進
   `public/data/properties.json` → 刪除已處理的 ZIP → 部署網站。
   約 2–3 分鐘後網站就會顯示新資料。

## 歷史資料回填（一次性）

同一個頁面也有 **Yearly** 年度檔（2023、2024、2025）。上傳方式相同，
可一次上傳多個檔案。年度檔如果超過 GitHub 網頁上傳的 25 MB 限制，
改用 `git add data-inbox/xxx.zip && git push` 從本機推上來即可。

## 注意

- 支援 `.zip`（含巢狀 ZIP 的年度檔）和 `.dat` 檔。
- 上傳的檔案若解析不出任何雪梨地區的成交紀錄，workflow 會失敗並通知你，
  網站不會被改動。
- 處理完成後原始檔會自動從這個資料夾刪除，保持 repo 輕量。
