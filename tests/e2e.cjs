// 瀏覽器實測：用 Playwright 操作真正的頁面。所有輸入都是虛構資料。
//
// 用法（在專案資料夾執行，一個終端機就夠）：
//   node tests/e2e.cjs [index.html 的路徑] [截圖資料夾]
// 不給參數時測專案根目錄的 index.html，截圖存到 shots/。
// 程式會自己在 127.0.0.1 開一個暫時的本機伺服器，測完就關掉，不用另外開 python 伺服器。
// 瀏覽器預設用 Playwright 安裝的 Chromium（npx playwright install chromium）；
// 想改用其他 Chromium，設定環境變數 CHROMIUM_PATH 指到執行檔即可。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

const root = path.join(__dirname, '..');
const target = path.resolve(process.argv[2] || path.join(root, 'index.html'));
const shotDir = path.resolve(process.argv[3] || path.join(root, 'shots'));
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: error.message.split('\n')[0] });
  }
}

// 只提供這一個檔案的本機伺服器
function serve(file) {
  const html = fs.readFileSync(file);
  const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const SAMPLE_SECRETS = ['wang', 'EXAMPLE0000fake', 'demo.student@example.invalid', 'demo_pass', 'A123456789', '0912-345-678'];

function watch(page) {
  const log = { requests: [], console: [], errors: [], dialogs: [] };
  page.on('request', (r) => log.requests.push(r.url()));
  page.on('console', (m) => log.console.push(`${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => log.errors.push(String(e)));
  page.on('dialog', async (d) => {
    log.dialogs.push(d.type());
    await d.accept();
  });
  return log;
}

// 按下按鈕後，等頁面做完（處理中 body 會有 is-busy）
const settled = (page) => page.waitForFunction(() => !document.body.classList.contains('is-busy'));

async function scan(page) {
  await page.click('#btnScan');
  await settled(page);
}

async function scanSample(page) {
  await page.click('#btnSample');
  await scan(page);
}

async function generate(page) {
  await page.click('#btnGenerate');
  await settled(page);
  assert.match(await page.textContent('#resultBadge'), /替換|沒有/);
}

async function scanText(page, text, keywords = []) {
  await page.fill('#source', text);
  for (const [type, value] of keywords) {
    await page.selectOption('#kwType', type);
    await page.fill('#kwText', value);
    await page.click('#kwAdd');
  }
  await scan(page);
}

const currentStep = (page) => page.evaluate(() => {
  const panel = document.querySelector('.panel.is-current');
  return panel ? panel.id : null;
});
const noHorizontalScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const box = (page, id) => page.evaluate((x) => {
  const r = document.getElementById(x).getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), bottom: Math.round(r.bottom) };
}, id);

(async () => {
  fs.mkdirSync(shotDir, { recursive: true });
  const server = await serve(target);
  const httpUrl = `http://127.0.0.1:${server.address().port}/index.html`;
  const fileUrl = pathToFileURL(target).href;
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  console.log(`瀏覽器：Chromium ${browser.version()}；測試檔案：${path.basename(target)}`);

  /* ---------- 桌機：完整流程 ---------- */
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await desktop.newPage();
  const log = watch(page);
  await page.goto(httpUrl);

  await test('瀏覽器翻譯：整頁標示不要翻譯，避免內容被送去翻譯服務', async () => {
    assert.equal(await page.getAttribute('html', 'translate'), 'no');
    assert.equal(await page.locator('meta[name="google"][content="notranslate"]').count(), 1);
  });

  await test('啟動：程式有執行、沒有錯誤，目前步驟是第1步', async () => {
    assert.equal(await page.locator('#bootError').count(), 0);
    assert.equal(log.errors.length, 0, log.errors.join(' | '));
    assert.deepEqual(log.console, []);
    assert.equal(await currentStep(page), 'panelSource');
  });

  await test('A01 載入範例→掃描：列出候選與統計，目前步驟換到第2步', async () => {
    await scanSample(page);
    assert.equal(await page.locator('#kwList li').count(), 3);
    const rows = await page.locator('#candList li.cand').count();
    assert.ok(rows >= 20, `rows=${rows}`);
    assert.match(await page.textContent('#reviewStats'), /遮罩\d+筆、保留\d+筆/);
    assert.match(await page.textContent('#scanNote'), /找到\d+筆/);
    assert.equal(await currentStep(page), 'panelReview');
  });

  await test('UI04 每一筆的判斷依據預設收起來，展開後看得到理由和風險；種類、可信度、遮罩／保留一直看得到', async () => {
    const first = page.locator('#candList li.cand').first();
    assert.equal(await first.locator('details.cand-more').getAttribute('open'), null);
    assert.equal(await first.locator('.why').isVisible(), false);
    assert.ok(await first.locator('.type').isVisible());
    assert.match(await first.locator('.conf').textContent(), /可信度|你指定的/);
    assert.ok(await first.locator('.opt-mask').isVisible() && await first.locator('.opt-keep').isVisible());
    await first.locator('details.cand-more summary').click();
    assert.ok(await first.locator('.why').isVisible());
    assert.match(await first.locator('.why').textContent(), /為什麼被偵測/);
    assert.match(await first.locator('.risk').textContent(), /如果保留/);
  });

  await test('F05 原文標記預覽：標色分開顯示，點標記跳到清單', async () => {
    await page.click('#btnPreview');
    assert.equal(await page.getAttribute('#btnPreview', 'aria-expanded'), 'true');
    const marks = await page.locator('#previewText mark').count();
    assert.ok(marks >= 15, `marks=${marks}`);
    assert.ok(await page.locator('#previewText mark.keep').count() >= 1, '私有IP以保留樣式顯示');
    await page.locator('#previewText mark.mask').nth(3).click();
    const focused = await page.evaluate(() => document.activeElement && document.activeElement.id);
    assert.match(focused || '', /^cand-\d+$/);
  });

  await test('A01 產生遮罩結果：代號、通過的檢查、正常流程不用確認就能複製', async () => {
    await generate(page);
    const masked = await page.textContent('#maskedText');
    assert.ok(masked.includes('C:\\Users\\USER_1\\Desktop\\PROJECT_1\\main.py'));
    assert.ok(masked.includes('sk-proj-KEY_1'));
    for (const secret of SAMPLE_SECRETS) assert.ok(!masked.includes(secret), secret);
    const summary = await page.textContent('#copySummary');
    assert.match(summary, /已遮罩：替換\d+處/);
    assert.match(summary, /2項格式檢查都通過/);
    assert.ok(!/完全安全|沒有敏感資訊/.test(summary), 'UI07：不寫成安全保證');
    assert.equal(await page.isHidden('#confirmBox'), true, 'UI06：正常流程沒有確認框');
    assert.equal(await page.isDisabled('#btnCopy'), false);
    assert.ok(await page.locator('#candList .becomes .tape').count() > 0, '清單顯示換成哪個代號');
    assert.equal(await currentStep(page), 'panelResult');
  });

  let copied = '';
  await test('F09 複製給AI：剪貼簿內容是說明加正文，不含原文；目前步驟換到第4步', async () => {
    await page.click('#btnCopy');
    await page.waitForFunction(() => document.getElementById('copyNote').textContent.includes('已複製'));
    copied = await page.evaluate(() => navigator.clipboard.readText());
    assert.ok(copied.startsWith('以下內容中的USER_1、'));
    for (const secret of SAMPLE_SECRETS) assert.ok(!copied.includes(secret), secret);
    assert.equal(await currentStep(page), 'panelReply');
  });

  await test('A20 關掉代號說明只影響複製內容', async () => {
    await page.click('#optGuide');
    const plain = await page.inputValue('#copyText');
    assert.ok(!plain.startsWith('以下內容中的'));
    assert.ok(copied.endsWith(plain));
    await page.click('#optGuide');
  });

  await test('A01 貼回AI回覆→還原：和原文一字不差；摘要分開列出換回、未知、疑似改寫', async () => {
    const source = await page.inputValue('#source');
    const body = copied.slice(copied.indexOf('\n\n') + 2);
    await page.fill('#reply', `${body}\n補充：USER_9 user_1`);
    await page.click('#btnRestore');
    const restored = await page.textContent('#restoredText');
    assert.equal(restored, `${source}\n補充：USER_9 user_1`, '已知代號換回；不認得的和疑似改寫的保持原樣');
    const summary = await page.textContent('#restoreSummary');
    assert.match(summary, /換回\d+處/);
    assert.match(summary, /不認得的代號[\s\S]*USER_9/);
    assert.match(summary, /看起來被改寫過[\s\S]*user_1（可能是USER_1）/);
    assert.ok(!summary.includes('還原失敗'), 'UI03：不把不同情況統稱為還原失敗');
    assert.match(await page.textContent('#report'), /換回來了/, '完整報告收在下面');
    assert.equal(await page.isHidden('#restoredBadge'), false);
    assert.equal(await currentStep(page), 'panelRestored');
  });

  await test('A22 改回覆會清掉舊的還原結果', async () => {
    await page.type('#reply', ' ');
    assert.match(await page.textContent('#restoredText'), /還原後的內容會出現在這裡/);
    assert.equal(await page.isDisabled('#btnCopyRestored'), true);
  });

  await test('A22 改遮罩／保留會立刻停用舊的複製與還原', async () => {
    await page.locator('#candList .opt-keep').first().click();
    assert.equal(await page.isDisabled('#btnCopy'), true);
    assert.equal(await page.isDisabled('#btnRestore'), true);
    assert.match(await page.textContent('#reviewNote'), /重新按/);
    await generate(page);
    assert.equal(await page.isDisabled('#btnCopy'), false);
    assert.match(await page.textContent('#copySummary'), /你選擇保留/);
  });

  await test('A23 沒有對外請求、沒有儲存、console沒有原文', async () => {
    const external = log.requests.filter((u) => !u.startsWith(httpUrl));
    assert.deepEqual(external, []);
    const storage = await page.evaluate(() => [localStorage.length, sessionStorage.length, document.cookie]);
    assert.deepEqual(storage, [0, 0, '']);
    for (const line of log.console) for (const secret of SAMPLE_SECRETS) assert.ok(!line.includes(secret));
    assert.deepEqual(log.errors, []);
  });

  await test('A23 頁面裡發出的連線會被CSP擋下', async () => {
    const outcome = await page.evaluate(async () => {
      try {
        await fetch('https://example.invalid/collect');
        return 'sent';
      } catch {
        return 'blocked';
      }
    });
    assert.equal(outcome, 'blocked');
    assert.ok(log.console.some((l) => l.includes('Content Security Policy')));
    log.console.length = 0;
  });

  await test('F11 有對照表時離開頁面會先詢問；重新整理後不留資料', async () => {
    await page.reload();
    assert.ok(log.dialogs.includes('beforeunload'), log.dialogs.join(','));
    assert.equal(await page.inputValue('#source'), '');
    assert.equal(await page.locator('#kwList li').count(), 0);
    assert.match(await page.textContent('#reviewBadge'), /還沒掃描/);
    assert.equal(await page.isDisabled('#btnRestore'), true);
  });

  await test('A21 貼上HTML／script只當純文字顯示，不會執行', async () => {
    const evil = '<script>alert(1)</script><img src=x onerror=alert(2)> mail demo@example.invalid';
    await scanText(page, evil);
    await generate(page);
    await page.click('#btnPreview');
    assert.equal(await page.locator('main img, main script').count(), 0);
    assert.ok((await page.textContent('#maskedText')).startsWith('<script>alert(1)</script><img src=x onerror=alert(2)>'));
    await page.fill('#reply', evil);
    await page.click('#btnRestore');
    assert.equal(await page.locator('.restore img').count(), 0);
    assert.deepEqual(log.dialogs.filter((d) => d !== 'beforeunload'), []);
  });

  await test('A22 改原文會清掉掃描結果與對照表', async () => {
    await page.type('#source', 'x');
    assert.match(await page.textContent('#reviewBadge'), /還沒掃描/);
    assert.equal(await page.isDisabled('#btnCopy'), true);
    assert.match(await page.textContent('#scanNote'), /原文有變更/);
  });

  /* ---------- v1.1：跳號原因、還原摘要 ---------- */
  await test('UI02 fixtures/01：原文已有USER_1，結果旁邊直接寫出為什麼從USER_2開始（不用展開）', async () => {
    await scanText(page, fixture('01-fake-path-and-tokens.txt'));
    await generate(page);
    const masked = await page.textContent('#maskedText');
    assert.ok(masked.includes('C:\\Users\\USER_2\\Desktop') && !masked.includes('demo_user'));
    const note = page.locator('#skipNotes .skip-note');
    assert.equal(await note.count(), 1);
    assert.ok(await note.isVisible());
    assert.match(await note.textContent(), /從USER_2開始[\s\S]*原文本來就有USER_1/);
    const resultBox = await box(page, 'maskedText');
    const noteBox = await note.boundingBox();
    assert.ok(noteBox.y >= resultBox.bottom - 1 && noteBox.y - resultBox.bottom < 40, '提示緊接在遮罩結果下面');
  });

  await test('UI03 fixtures/02：還原摘要分開說明換回、原文既有、未知代號', async () => {
    await page.fill('#reply', fixture('02-fake-ai-reply.txt'));
    await page.click('#btnRestore');
    const restored = await page.textContent('#restoredText');
    assert.ok(restored.includes('C:\\Users\\demo_user\\Desktop'));
    assert.ok(restored.includes('USER_1 是程式原本的變數名稱'));
    const summary = await page.textContent('#restoreSummary');
    assert.match(summary, /換回1處[\s\S]*USER_2×1/);
    assert.match(summary, /原文本來就有[\s\S]*USER_1×1/);
    assert.match(summary, /不認得的代號[\s\S]*USER_9×1/);
    assert.ok(await page.locator('#restoreSummary').isVisible(), '摘要直接看得到');
    assert.equal(await page.getAttribute('#reportDetails', 'open'), null, '完整報告預設收起來');
  });

  /* ---------- v1.1：D03 未完整遮罩的確認 ---------- */
  await test('D03 有沒遮完整的項目：複製旁邊列出位置、風險、處理方式；確認框預設沒勾，複製停用', async () => {
    await scanText(page, 'Moved C:\\Users\\wang to D:\\backup\nmail demo@example.invalid');
    assert.match(await page.textContent('#alerts'), /看不出使用者名稱到哪裡為止/);
    await generate(page);
    const summary = await page.textContent('#copySummary');
    assert.match(summary, /第1行・沒有完整遮罩/);
    assert.match(summary, /風險：/);
    assert.match(summary, /可以這樣處理：/);
    assert.equal(await page.isVisible('#confirmBox'), true);
    assert.equal(await page.isChecked('#confirmRisk'), false);
    assert.equal(await page.isDisabled('#btnCopy'), true);
    assert.equal(await page.inputValue('#copyText'), '', '確認前不提供要複製的完整內容');
    assert.match(await page.textContent('#copyNote'), /沒有完整遮罩/);
  });

  await test('D03 勾選確認後可以複製，風險提示仍然看得到', async () => {
    await page.check('#confirmRisk');
    assert.equal(await page.isDisabled('#btnCopy'), false);
    assert.match(await page.textContent('#copySummary'), /沒有完整遮罩/);
    await page.click('#btnCopy');
    await page.waitForFunction(() => document.getElementById('copyNote').textContent.includes('已複製'));
    const text = await page.evaluate(() => navigator.clipboard.readText());
    assert.ok(text.includes('EMAIL_1') && text.includes('C:\\Users\\wang'), '確認過的未完整項目照原樣送出');
    assert.match(await page.textContent('#copyNote'), /確認過/);
  });

  await test('D03 確認只算當次：改遮罩選擇、重新產生、改原文之後都要重新確認', async () => {
    await page.locator('#candList .opt-keep').first().click();
    assert.equal(await page.isDisabled('#btnCopy'), true);
    await page.locator('#candList .opt-mask').first().click();
    await generate(page);
    assert.equal(await page.isChecked('#confirmRisk'), false, '改選擇後重新產生要重新確認');
    assert.equal(await page.isDisabled('#btnCopy'), true);
    await page.check('#confirmRisk');
    await generate(page);
    assert.equal(await page.isChecked('#confirmRisk'), false, '重新產生要重新確認');
    assert.equal(await page.isDisabled('#btnCopy'), true);
    await page.check('#confirmRisk');
    await page.type('#source', ' ');
    assert.equal(await page.isHidden('#confirmBox'), true, '改原文後舊結果和確認都清掉');
    await scan(page);
    await generate(page);
    assert.equal(await page.isChecked('#confirmRisk'), false);
    assert.equal(await page.isDisabled('#btnCopy'), true);
  });

  await test('D03 補上自訂文字後就不用確認', async () => {
    await page.selectOption('#kwType', 'NAME');
    await page.fill('#kwText', 'wang');
    await page.click('#kwAdd');
    await scan(page);
    await generate(page);
    assert.equal(await page.isHidden('#confirmBox'), true);
    assert.equal(await page.isDisabled('#btnCopy'), false);
  });

  await test('A19 JSON被破壞時停用複製並說明', async () => {
    await page.click('#btnClear');
    await page.click('#btnClear');
    await scanText(page, '{"sid":123456}', [['SID', '123456']]);
    await generate(page);
    assert.equal(await page.isDisabled('#btnCopy'), true);
    assert.match(await page.textContent('#copySummary'), /JSON會被破壞/);
    assert.equal(await page.isHidden('#confirmBox'), true, '沒有沒遮完整的項目時不出現確認框');
  });

  await test('D03 JSON被破壞時，就算確認了沒遮完整的項目，還是不能複製', async () => {
    await page.click('#btnClear');
    await page.click('#btnClear');
    await scanText(page, '{"sid":123456,"note":"copy C:\\\\Users\\\\wang and more"}', [['SID', '123456']]);
    await generate(page);
    assert.match(await page.textContent('#copySummary'), /JSON會被破壞/);
    assert.equal(await page.isVisible('#confirmBox'), true);
    await page.check('#confirmRisk');
    assert.equal(await page.isDisabled('#btnCopy'), true);
    assert.match(await page.textContent('#copyNote'), /✕/);
  });

  await test('R04 原文只有一個數字也算JSON：換成代號會被擋下', async () => {
    await page.click('#btnClear');
    await page.click('#btnClear');
    await scanText(page, '123456', [['SID', '123456']]);
    await generate(page);
    assert.equal(await page.isDisabled('#btnCopy'), true);
    assert.match(await page.textContent('#copySummary'), /單獨的數字、true、false、null也算/);
  });

  await test('R01／R02／R03 漏遮修正在畫面上也一樣', async () => {
    const cases = [
      [fixture('03-fake-password-newline.txt'), 'SYNTHETIC_SECRET_ABC'],
      ["password: 'demo''SYNTHETIC_SECRET_SUFFIX'", 'SYNTHETIC_SECRET_SUFFIX'],
      ['password: |\n  SYNTHETIC_SECRET_ABC,;\n  SECOND_SECRET_XYZ;', ',;'],
      ['password = """SYNTHETIC_SECRET_ABC"""', 'SYNTHETIC_SECRET_ABC'],
    ];
    for (const [text, leak] of cases) {
      await scanText(page, text);
      await generate(page);
      const masked = await page.textContent('#maskedText');
      assert.ok(!masked.includes(leak), `${text} 還有 ${leak}`);
      assert.equal(await page.isDisabled('#btnCopy'), false, text);
    }
  });

  await test('補測的三類漏遮在畫面上也遮好，可以直接複製', async () => {
    const cases = [
      'pw = os.getenv("DB_PASSWORD",\n    "SYNTHETIC_A9")',
      '"password": SYNTHETIC_A9\n  SYNTHETIC_B8',
      'config[ "password" ] = "SYNTHETIC_A9"',
    ];
    for (const text of cases) {
      await scanText(page, text);
      await generate(page);
      const masked = await page.textContent('#maskedText');
      assert.ok(!/SYNTHETIC_[AB]\d/.test(masked), `${text} 還有密碼`);
      assert.equal(await page.isDisabled('#btnCopy'), false, text);
    }
  });

  await test('D04 secrets底下的物件：沒遮的值列在複製按鈕上面，要確認；補上自訂文字後就不用確認', async () => {
    await scanText(page, 'secrets:\n  db: SYNTHETIC_DB\n  password: "SYNTHETIC_A9"');
    await generate(page);
    const summary = await page.textContent('#copySummary');
    assert.match(summary, /「secrets」底下的物件只依子欄位的名稱偵測/);
    assert.match(summary, /「db」/);
    assert.ok(!(await page.textContent('#maskedText')).includes('SYNTHETIC_A9'));
    assert.equal(await page.isVisible('#confirmBox'), true);
    assert.equal(await page.isDisabled('#btnCopy'), true);
    await page.selectOption('#kwType', 'WORD');
    await page.fill('#kwText', 'SYNTHETIC_DB');
    await page.click('#kwAdd');
    await scan(page);
    await generate(page);
    assert.equal(await page.isHidden('#confirmBox'), true);
    assert.equal(await page.isDisabled('#btnCopy'), false);
  });

  await test('R07 secrets裡保留中文字串：第3步一定出現確認框，沒勾不能複製', async () => {
    await scanText(page, '{\n  "secrets": {\n    "token": "SYNTHETIC_A9",\n    "db": "虛構測試密碼"\n  }\n}');
    await generate(page);
    assert.ok((await page.textContent('#maskedText')).includes('"db": "虛構測試密碼"'));
    assert.equal(await page.isVisible('#confirmBox'), true);
    assert.equal(await page.isChecked('#confirmRisk'), false);
    assert.equal(await page.isDisabled('#btnCopy'), true);
    await page.check('#confirmRisk');
    assert.equal(await page.isDisabled('#btnCopy'), false);
  });

  await test('R08 超過200行的secrets物件：後面沒檢查到，要確認才能複製', async () => {
    const long = 'secrets:\n' + Array.from({ length: 205 }, (_, i) => `  item_${i}_token: "SYNTHETIC_${i}"`).join('\n') + '\n  db: "SYNTHETIC_TAIL"';
    await scanText(page, long);
    await generate(page);
    assert.match(await page.textContent('#copySummary'), /超過200行/);
    assert.equal(await page.isVisible('#confirmBox'), true);
    assert.equal(await page.isDisabled('#btnCopy'), true);
  });

  await test('R09 JSON換行沒縮排的secrets物件：第3步出現確認框，沒勾不能複製；補上自訂文字後解除', async () => {
    await scanText(page, '{"secrets":{\n"password":"SYNTHETIC_COVERED",\n"db":"SYNTHETIC_UNCHECKED"}}');
    await generate(page);
    assert.ok((await page.textContent('#maskedText')).includes('"db":"SYNTHETIC_UNCHECKED"'));
    assert.match(await page.textContent('#copySummary'), /「secrets」底下的物件只依子欄位的名稱偵測/);
    assert.equal(await page.isVisible('#confirmBox'), true);
    assert.equal(await page.isChecked('#confirmRisk'), false);
    assert.equal(await page.isDisabled('#btnCopy'), true);
    await page.check('#confirmRisk');
    assert.equal(await page.isDisabled('#btnCopy'), false);
    await page.selectOption('#kwType', 'WORD');
    await page.fill('#kwText', 'SYNTHETIC_UNCHECKED');
    await page.click('#kwAdd');
    await scan(page);
    await generate(page);
    assert.equal(await page.isHidden('#confirmBox'), true);
    assert.equal(await page.isDisabled('#btnCopy'), false);
  });

  /* ---------- 新手引導：最上面直接寫5個步驟，目前這一步會亮起來 ---------- */
  await test('UI13 第一次用的5步說明預設打開，寫清楚哪些能給AI，目前步驟跟著流程亮起來', async () => {
    assert.equal(await page.getAttribute('#guideBox', 'open'), '');
    assert.equal(await page.locator('#guideList li').count(), 5);
    assert.ok(await page.isVisible('.guide-rule'));
    assert.match(await page.textContent('.guide-rule'), /只有第3步「複製給AI」複製出來的內容/);
    await scanText(page, 'mail demo@example.invalid');
    assert.equal(await page.getAttribute('#guideList li.is-now', 'data-step'), '2');
    await generate(page);
    assert.equal(await page.getAttribute('#guideList li.is-now', 'data-step'), '3');
    assert.equal(await page.locator('#guideList li[aria-current="step"]').count(), 1);
    // 看過了可以收起來
    await page.click('#guideBox summary');
    assert.equal(await page.getAttribute('#guideBox', 'open'), null);
    assert.equal(await page.isVisible('#guideList'), false);
    await page.click('#guideBox summary');
  });

  /* ---------- v1.1：我操作後的回饋（A41），重要的東西不用點開也看得到 ---------- */
  await test('UI10 工具找得到什麼、找不到什麼放在最上面，不用點開；完整清單可以展開', async () => {
    assert.ok(await page.isVisible('.scope-lines'));
    assert.match(await page.textContent('.scope-lines'), /要你自己加[\s\S]*姓名、學號/);
    assert.equal(await page.getAttribute('#scopeDetails', 'open'), null);
  });

  await test('UI11 複製前直接列出要注意的事，按鈕帶到完整內容、自訂文字和支援範圍', async () => {
    await scanText(page, 'mail demo@example.invalid');
    await generate(page);
    assert.ok(await page.isVisible('.precheck'));
    await page.click('.precheck button:has-text("看完整內容")');
    assert.equal(await page.getAttribute('#copyDetails', 'open'), '');
    assert.match(await page.inputValue('#copyText'), /EMAIL_1/);
    await page.click('.precheck button:has-text("去加自訂文字")');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'kwText');
    await page.click('.precheck button:has-text("看支援範圍和限制")');
    assert.equal(await page.getAttribute('#scopeDetails', 'open'), '');
    await page.evaluate(() => {
      document.getElementById('scopeDetails').open = false;
      document.getElementById('copyDetails').open = false;
    });
  });

  await test('UI12 選了保留的那一筆，風險直接顯示，不用展開', async () => {
    assert.equal(await page.locator('#candList li.cand').first().locator('.kept-risk').count(), 0);
    await page.locator('#candList li.cand').first().locator('.opt-keep').click();
    const risk = page.locator('#candList li.cand').first().locator('.kept-risk');
    assert.ok(await risk.isVisible());
    assert.match(await risk.textContent(), /保留的話/);
  });

  await test('私鑰區塊：提醒並停用複製', async () => {
    await scanText(page, 'key:\n-----BEGIN ' + 'OPENSSH PRIVATE KEY-----\nFAKEFAKEFAKE\n-----END ' + 'OPENSSH PRIVATE KEY-----');
    assert.match(await page.textContent('#alerts'), /私鑰/);
    await generate(page);
    assert.equal(await page.isDisabled('#btnCopy'), true);
    assert.match(await page.textContent('#copySummary'), /原文有私鑰/);
  });

  await test('A08 自訂文字含斜線會被擋下並說明', async () => {
    await page.fill('#kwText', 'a/b');
    await page.click('#kwAdd');
    assert.match(await page.textContent('#kwNote'), /斜線/);
  });

  await test('A08／F01 自訂文字：貼上多行、超過200字都會被擋下，不會默默截斷', async () => {
    await page.fill('#kwText', '王小明\n411000000');
    await page.click('#kwAdd');
    assert.match(await page.textContent('#kwNote'), /換行/);
    await page.fill('#kwText', '密'.repeat(250));
    await page.click('#kwAdd');
    assert.match(await page.textContent('#kwNote'), /200/);
    await page.fill('#kwText', '虛構測試名');
    await page.focus('#kwText');
    await page.keyboard.press('Enter');
    assert.match(await page.textContent('#kwNote'), /已加入/);
  });

  await test('A24 超過100,000字：明確拒絕、不產生結果', async () => {
    await page.fill('#source', 'x'.repeat(100001));
    assert.match(await page.textContent('#srcCount'), /100,001/);
    await page.click('#btnScan');
    await page.waitForFunction(() => document.getElementById('scanNote').textContent.includes('上限'));
    assert.equal(await page.isDisabled('#btnGenerate'), true);
  });

  await test('F11／F12 清除要按兩次；載入範例會先提醒取代', async () => {
    await page.fill('#source', 'something');
    await page.click('#btnSample');
    assert.match(await page.textContent('#btnSample'), /再按一次/);
    assert.equal(await page.inputValue('#source'), 'something');
    await page.click('#btnSample');
    assert.ok((await page.inputValue('#source')).startsWith('# SYNTHETIC ONLY'));
    await page.click('#btnClear');
    assert.match(await page.textContent('#btnClear'), /再按一次/);
    await page.click('#btnClear');
    assert.equal(await page.inputValue('#source'), '');
    assert.equal(await page.locator('#kwList li').count(), 0);
  });

  await test('鍵盤：在原文按Ctrl+Enter可以掃描', async () => {
    await page.fill('#source', 'mail demo@example.invalid');
    await page.focus('#source');
    await page.keyboard.press('Control+Enter');
    await page.waitForFunction(() => document.getElementById('reviewBadge').textContent.includes('筆'));
  });

  await test('UI01 桌機1440px：原文和遮罩結果左右對照，審查清單在中間，沒有橫向捲動', async () => {
    const [source, review, result] = await Promise.all(['panelSource', 'panelReview', 'panelResult'].map((id) => box(page, id)));
    assert.ok(source.x < review.x && review.x < result.x, '由左到右：原文、審查、結果');
    assert.ok(Math.abs(source.y - result.y) < 2, '原文和結果在同一列');
    assert.ok(await noHorizontalScroll(page));
  });

  // 截圖：桌機完整流程
  await page.click('#btnClear');
  await page.click('#btnClear');
  await scanSample(page);
  await generate(page);
  await page.click('#btnCopy');
  await page.fill('#reply', '問題出在 C:\\Users\\USER_1\\Desktop\\PROJECT_1\\config.json 不存在。\n請確認 api_key = "sk-proj-KEY_1" 有沒有設定，或改用 SECRET_1 連線到 HOST_2。\n另外 user_1 這個資料夾也要檢查。');
  await page.click('#btnRestore');
  await page.screenshot({ path: path.join(shotDir, 'desktop-full.png'), fullPage: true });
  await page.locator('.workspace').screenshot({ path: path.join(shotDir, 'desktop-workspace.png') });
  // 截圖：跳號原因和未完整遮罩的確認
  await page.click('#btnClear');
  await page.click('#btnClear');
  await scanText(page, `${fixture('01-fake-path-and-tokens.txt')}password = """SYNTHETIC_SECRET_ABC\nSECOND_LINE`);
  await generate(page);
  await page.locator('#panelResult').screenshot({ path: path.join(shotDir, 'desktop-confirm.png') });
  await page.check('#confirmRisk');
  await page.fill('#reply', fixture('02-fake-ai-reply.txt'));
  await page.click('#btnRestore');
  await page.locator('#panelRestored').screenshot({ path: path.join(shotDir, 'desktop-restore-summary.png') });
  await desktop.close();

  /* ---------- 剪貼簿不能用的時候 ---------- */
  const noClip = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await noClip.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
  });
  const page2 = await noClip.newPage();
  watch(page2);
  await page2.goto(httpUrl);
  await test('A25 剪貼簿不能用：自動選好文字並提示按Ctrl+C', async () => {
    await scanSample(page2);
    await generate(page2);
    await page2.click('#btnCopy');
    assert.match(await page2.textContent('#copyNote'), /Ctrl\+C|⌘\+C/);
    assert.equal(await page2.getAttribute('#copyDetails', 'open'), '');
    const selected = await page2.evaluate(() => {
      const t = document.getElementById('copyText');
      return document.activeElement === t && t.selectionStart === 0 && t.selectionEnd === t.value.length && t.value.length > 0;
    });
    assert.ok(selected);
  });
  await noClip.close();

  /* ---------- 平板寬度 ---------- */
  const tablet = await browser.newContext({ viewport: { width: 1000, height: 900 } });
  const page3 = await tablet.newPage();
  await page3.goto(httpUrl);
  await test('768–1199px：原文和結果並排，審查清單佔一整列，沒有橫向捲動', async () => {
    await scanSample(page3);
    await generate(page3);
    const [source, review, result] = await Promise.all(['panelSource', 'panelReview', 'panelResult'].map((id) => box(page3, id)));
    assert.ok(result.x > source.x && Math.abs(result.y - source.y) < 2, '原文和結果並排');
    assert.ok(review.y > source.y && review.w > source.w * 1.8, '審查清單在下面佔一整列');
    assert.ok(await noHorizontalScroll(page3));
  });
  await page3.screenshot({ path: path.join(shotDir, 'tablet.png'), fullPage: false });
  await tablet.close();

  /* ---------- 手機 390px ---------- */
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, permissions: ['clipboard-read', 'clipboard-write'] });
  const page4 = await phone.newPage();
  const log4 = watch(page4);
  await page4.goto(httpUrl);
  await test('A25 手機390px：單欄、完整流程、沒有整頁橫向捲動、主要按鈕夠大', async () => {
    assert.ok(await noHorizontalScroll(page4));
    await scanSample(page4);
    assert.ok(await noHorizontalScroll(page4));
    await generate(page4);
    assert.ok(await noHorizontalScroll(page4));
    const xs = await Promise.all(['panelSource', 'panelReview', 'panelResult'].map((id) => box(page4, id)));
    assert.ok(xs.every((b) => Math.abs(b.x - xs[0].x) < 2), '單欄');
    await page4.click('#btnCopy');
    const text = await page4.evaluate(() => navigator.clipboard.readText());
    await page4.fill('#reply', text);
    await page4.click('#btnRestore');
    assert.ok((await page4.textContent('#restoredText')).includes(await page4.inputValue('#source')));
    assert.ok(await noHorizontalScroll(page4));
    const heights = await page4.evaluate(() => ['btnScan', 'btnGenerate', 'btnCopy', 'btnRestore'].map((id) => document.getElementById(id).getBoundingClientRect().height));
    assert.ok(heights.every((hgt) => hgt >= 44), heights.join(','));
    const editorScrolls = await page4.evaluate(() => {
      const pre = document.getElementById('maskedText');
      return pre.scrollWidth > pre.clientWidth;
    });
    assert.ok(editorScrolls, '長行在編輯區裡面捲動');
    assert.deepEqual(log4.errors, []);
  });
  await test('手機390px：未完整遮罩的提醒和確認框就在複製按鈕上面，沒有橫向捲動', async () => {
    await page4.click('#btnClear');
    await page4.click('#btnClear');
    await scanText(page4, 'Moved C:\\Users\\wang to D:\\backup');
    await generate(page4);
    const confirmBox = await box(page4, 'confirmBox');
    const copyButton = await box(page4, 'btnCopy');
    const summary = await box(page4, 'copySummary');
    assert.ok(summary.bottom <= confirmBox.y + 1 && confirmBox.bottom <= copyButton.y + 1, '摘要 → 確認 → 複製按鈕');
    assert.ok(copyButton.y - summary.y < 900, '提醒和按鈕距離不遠');
    assert.ok(await noHorizontalScroll(page4));
  });
  await page4.evaluate(() => window.scrollTo(0, 0));
  await page4.screenshot({ path: path.join(shotDir, 'mobile-top.png') });
  await page4.locator('#panelResult').screenshot({ path: path.join(shotDir, 'mobile-result.png') });
  await phone.close();

  /* ---------- 直接開檔、斷網 ---------- */
  const offline = await browser.newContext({ viewport: { width: 1280, height: 900 }, offline: true });
  const page5 = await offline.newPage();
  const log5 = watch(page5);
  await test('A26 斷網、用file://直接開檔也能完成流程', async () => {
    await page5.goto(fileUrl);
    assert.equal(await page5.locator('#bootError').count(), 0);
    await scanSample(page5);
    await generate(page5);
    const body = await page5.textContent('#maskedText');
    await page5.fill('#reply', body);
    await page5.click('#btnRestore');
    assert.equal(await page5.textContent('#restoredText'), await page5.inputValue('#source'));
    assert.deepEqual(log5.requests.filter((u) => !u.startsWith('file:')), []);
    assert.deepEqual(log5.errors, []);
  });
  await offline.close();

  /* ---------- R06：CSP 雜湊對不上時的實際效果 ---------- */
  // 在暫存資料夾做幾個改過的副本，用 file:// 打開來看
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'contextmask-csp-'));
  const original = fs.readFileSync(target, 'utf8');
  const variant = (name, html) => {
    const file = path.join(tmp, name);
    fs.writeFileSync(file, html, 'utf8');
    return pathToFileURL(file).href;
  };
  const cspContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page6 = await cspContext.newPage();
  const started = () => page6.evaluate(() => !document.getElementById('bootError'));
  const styled = () => page6.evaluate(() => getComputedStyle(document.body).backgroundColor !== 'rgba(0, 0, 0, 0)');
  await test('R06 只改 <script>、<style> 以外的文字：程式和樣式都照常', async () => {
    await page6.goto(variant('text-only.html', original.replace('貼給AI除錯之前，先把隱私換成代號', '（改過的說明文字）貼給AI除錯之前，先把隱私換成代號')));
    assert.equal(await started(), true);
    assert.equal(await styled(), true);
  });
  await test('R06 改了 <style> 沒重算雜湊：只有樣式被擋，程式照常執行', async () => {
    await page6.goto(variant('style-changed.html', original.replace('<style>\n', '<style>\n/* 改過 */\n')));
    assert.equal(await started(), true);
    assert.equal(await styled(), false);
  });
  await test('R06 改了 <script> 沒重算雜湊：整段程式被擋，畫面顯示「網頁程式沒有啟動」', async () => {
    await page6.goto(variant('script-changed.html', original.replace('<script>\n', '<script>\n// 改過\n')));
    assert.equal(await started(), false);
    assert.match(await page6.textContent('#bootError'), /網頁程式沒有啟動/);
  });
  await test('R06 用 tools/update-csp.cjs 重算之後，改過的檔案又能正常執行', async () => {
    const file = path.join(tmp, 'script-fixed.html');
    fs.writeFileSync(file, original.replace('<script>\n', '<script>\n// 改過\n').replace('<style>\n', '<style>\n/* 改過 */\n'), 'utf8');
    require('node:child_process').execFileSync(process.execPath, [path.join(root, 'tools', 'update-csp.cjs'), file]);
    await page6.goto(pathToFileURL(file).href);
    assert.equal(await started(), true);
    assert.equal(await styled(), true);
  });
  await cspContext.close();
  fs.rmSync(tmp, { recursive: true, force: true });

  await browser.close();
  server.close();
  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok ? '' : ' — ' + r.error}`);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  console.log(`截圖：${path.relative(process.cwd(), shotDir) || '.'}`);
  process.exitCode = failed.length ? 1 : 0;
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
