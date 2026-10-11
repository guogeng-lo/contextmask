# ContextMask開發檔案

網頁本身只需要根目錄的`index.html`：HTML、CSS、JavaScript都在這一個檔案裡，打開就能用，不用安裝任何東西。這個資料夾裡的其他檔案，是用來產生和測試它的。

## 檔案

| 檔案 | 用途 |
| --- | --- |
| `index.html` | 網頁本體，GitHub Pages直接用這個檔案 |
| `src/` | 網頁的三個部分：`body.html`、`style.css`、`app.js`。要改網頁請改這裡 |
| `build.cjs` | 把`src/`組成`index.html`，並重新計算CSP雜湊 |
| `tools/update-csp.cjs` | 直接改過`index.html`之後，重新計算CSP雜湊 |
| `tests/engine.test.cjs` | v1.0的核心規則測試 |
| `tests/engine-v1.1.test.cjs` | v1.1新增的測試：漏遮修正（包含另外一輪漏遮審查和Codex依要求補測找到的寫法）、沒遮完整時的確認（D03、D04，以及補充審查的R07、R08）、跳號、還原摘要、隨機測試、效能 |
| `tests/e2e.cjs` | 瀏覽器實測：桌機、平板、手機寬度、file://、斷網、CSP、剪貼簿，以及最上面的步驟說明和複製前的引導 |
| `tests/fixtures/` | 測試用的虛構資料 |
| `LICENSE`、`NOTICE` | Apache License 2.0的授權全文，和作者、著作權的聲明 |
| `package.json` | 開發工具設定，只有測試用的Playwright |

## 需要的東西

- Node.js 18以上
- 瀏覽器實測另外需要Playwright和它的Chromium（第一次要下載）

## 指令

下面的指令都在專案資料夾（有`package.json`的那一層）執行。Windows用PowerShell或命令提示字元都可以，開一個視窗就夠，不用另外開伺服器。

1. 第一次使用：安裝測試工具

   ```
   npm install
   npx playwright install chromium
   ```

2. 改完`src/`之後，產生`index.html`

   ```
   npm run build
   ```

3. 核心測試（不用開瀏覽器）

   ```
   npm test
   ```

   隨機測試預設跑5,000組，可以用環境變數`FUZZ_N`調整組數、`FUZZ_SEED`換種子，例如PowerShell：`$env:FUZZ_N=20000; npm test`。

4. 瀏覽器實測

   ```
   npm run test:e2e
   ```

   程式會自己在`127.0.0.1`開一個暫時的本機伺服器，測完就關掉；截圖存在`shots/`。
   想測別的檔案或換截圖資料夾：`node tests/e2e.cjs 檔案路徑 截圖資料夾`。

   預設用Playwright安裝的Chromium。想改用電腦上其他的Chromium，設定環境變數`CHROMIUM_PATH`：

   - PowerShell：`$env:CHROMIUM_PATH="C:\路徑\chrome.exe"; npm run test:e2e`
   - 命令提示字元：`set CHROMIUM_PATH=C:\路徑\chrome.exe`之後再執行`npm run test:e2e`
   - macOS、Linux：`CHROMIUM_PATH=/路徑/chromium npm run test:e2e`

## CSP雜湊

`index.html`用CSP（內容安全政策）限制網頁只能執行檔案裡這一段程式、套用這一段樣式，而且不能對外連線。所以`<script>`或`<style>`裡的內容一改，雜湊就要重算：

- 改`src/`再執行`npm run build`：會自動重算。
- 直接改`index.html`：改完執行`node tools/update-csp.cjs index.html`。
- 沒有重算時，`<script>`對不上，瀏覽器會擋掉整段程式，畫面停在「網頁程式沒有啟動」；`<style>`對不上，只有樣式被擋，功能還在但排版會跑掉。
- 只改`<script>`、`<style>`以外的HTML文字，不影響雜湊。

這幾種情況在`tests/e2e.cjs`裡都有實際測過。

CSP只管得到這個網頁本身。瀏覽器擴充功能、輸入法、剪貼簿工具這些網頁以外的程式，CSP管不到。

## 注意

- 存檔請用UTF-8。換行LF或CRLF都可以，`build.cjs`和`update-csp.cjs`會先統一成LF再算雜湊。
- 範例和測試資料都是虛構的。不要把真實的錯誤訊息、設定檔或帳號放進測試或`tests/fixtures/`。
- 網頁執行時不需要Node.js、Playwright或任何外部套件；這些只用在開發和測試。
