// 核心引擎測試：對照規格書第十一節的驗收項目。所有資料都是虛構的。
// 執行：node tests/engine.test.cjs
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { createHash } = require('node:crypto');
const load = require('./load.cjs');

const { engine: E, html, script } = load();
const results = [];
// 沙盒裡建立的陣列和物件，要轉成這邊的物件才能做深度比較
const plain = (x) => JSON.parse(JSON.stringify(x));
const deq = (actual, expected, message) => assert.deepEqual(plain(actual), plain(expected), message);
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: error.message });
  }
}

// 小工具
const run = (text, keywords = []) => {
  const batch = E.createBatch(text, keywords);
  return { batch, result: E.generate(batch) };
};
const roundTrip = (text, keywords = []) => {
  const { batch, result } = run(text, keywords);
  assert.equal(E.restore(result.body, result).text, text, '直接還原要和原文一字不差');
  assert.equal(result.checks.roundTrip, true);
  return { batch, result };
};
const tokensOf = (result) => [...result.activeMap.keys()];
const typeCount = (batch, type) => batch.candidates.filter((c) => c.type === type).length;

const FIXTURE = String.raw`# SYNTHETIC ONLY — 教學測試，並非真實帳號、主機或憑證
Traceback (most recent call last):
  File "C:\Users\wang\Desktop\hw5\main.py", line 42, in load_config
    config = read_config()
FileNotFoundError: C:/Users/wang/Desktop/hw5/config.json:42:7
escaped_path = "C:\\Users\\wang\\Desktop\\hw5\\main.py"
wsl_path = "/mnt/c/Users/wang/Desktop/hw5/main.py"
host = "DESKTOP-DEMO123"
api_key = "sk-proj-EXAMPLE0000fake0000key0000"
email = "demo.student@example.invalid"
student = "SYNTHETIC_SID_001"
author = "王小明"
local_ip = "192.168.1.10"
documentation_ip = "203.0.113.5"`;
const FIXTURE_KEYWORDS = [
  { text: '王小明', type: 'NAME' },
  { text: 'SYNTHETIC_SID_001', type: 'SID' },
  { text: 'hw5', type: 'PROJECT' },
];

/* ---------- A01 主流程 ---------- */
test('A01 規格主fixture：掃描、產生、還原，直接還原與原文相同', () => {
  const { result } = roundTrip(FIXTURE, FIXTURE_KEYWORDS);
  assert.equal(result.copyAllowed, true);
  const body = result.body;
  assert.ok(body.includes(String.raw`File "C:\Users\USER_1\Desktop\PROJECT_1\main.py", line 42`));
  assert.ok(body.includes('C:/Users/USER_1/Desktop/PROJECT_1/config.json:42:7'));
  assert.ok(body.includes(String.raw`"C:\\Users\\USER_1\\Desktop\\PROJECT_1\\main.py"`));
  assert.ok(body.includes('/mnt/c/Users/USER_1/Desktop/PROJECT_1/main.py'));
  assert.ok(body.includes('host = "HOST_1"'));
  assert.ok(body.includes('api_key = "sk-proj-KEY_1"'));
  assert.ok(body.includes('email = "EMAIL_1"'));
  assert.ok(body.includes('student = "SID_1"'));
  assert.ok(body.includes('author = "NAME_1"'));
  assert.ok(body.includes('local_ip = "192.168.1.10"'), '私有IP預設保留');
  assert.ok(body.includes('documentation_ip = "IP_1"'));
  for (const secret of ['wang', 'hw5', 'DEMO123', 'EXAMPLE0000', 'demo.student', 'SYNTHETIC_SID_001', '王小明', '203.0.113.5']) {
    assert.ok(!body.includes(secret), `正文不應該還有 ${secret}`);
  }
});

test('A01 內建範例：整批可以產生、還原', () => {
  const { result } = roundTrip(E.SAMPLE.text, E.SAMPLE.keywords);
  assert.equal(result.copyAllowed, true);
  assert.ok(result.body.includes('postgres://admin:SECRET_1@HOST_2:5432/demo'));
  assert.ok(result.body.includes('DB_PASSWORD=SECRET_1'), '同樣的密碼共用同一個代號');
  assert.ok(result.body.includes('session_token = "TOKEN_1"'));
});

/* ---------- A02 路徑 ---------- */
test('A02 四種Windows/WSL寫法共用USER_1，斜線、檔名、行列號不變', () => {
  const text = String.raw`C:\Users\wang\Desktop\hw5\main.py:42:7
C:\\Users\\wang\\Desktop\\hw5\\main.py:42:7
C:/Users/wang/Desktop/hw5/config.json:42:7
/mnt/c/Users/wang/Desktop/hw5/main.py line 42`;
  const { result } = roundTrip(text);
  deq(tokensOf(result), ['USER_1']);
  assert.equal(result.replacements.length, 4);
  assert.equal(result.body, text.replaceAll('wang', 'USER_1'));
});

test('A02 /home/wang/、/Users/wang/ 也換成同一個代號', () => {
  const { result } = roundTrip('C:\\Users\\wang\\a.py /home/wang/app/main.py /Users/wang/app/main.py');
  deq(tokensOf(result), ['USER_1']);
  assert.equal(result.replacements.length, 3);
});

test('A02 名稱含空白整段遮、重複共用、不和wang共用', () => {
  const text = String.raw`File "C:\Users\Demo User\Desktop\a.py"
C:\Users\Demo User\Desktop\b.py
C:\Users\wang\c.py`;
  const { result } = roundTrip(text);
  assert.equal(result.body, String.raw`File "C:\Users\USER_1\Desktop\a.py"
C:\Users\USER_1\Desktop\b.py
C:\Users\USER_2\c.py`);
  assert.equal(result.activeMap.get('USER_1'), 'Demo User');
});

test('A02 字串結尾的 C:\\Users\\wang 也會遮；看不出範圍時只提醒、不猜', () => {
  const end = run('cd C:\\Users\\wang');
  assert.equal(end.result.body, 'cd C:\\Users\\USER_1');
  const quoted = run('path = "C:\\Users\\wang"');
  assert.equal(quoted.result.body, 'path = "C:\\Users\\USER_1"');
  const prompt = run('C:\\Users\\wang>python main.py');
  assert.equal(prompt.result.body, 'C:\\Users\\USER_1>python main.py');
  const unclear = run('copy C:\\Users\\wang and more text\nnext line');
  assert.equal(typeCount(unclear.batch, 'USER'), 0, '範圍不明時不自動遮');
  assert.equal(unclear.batch.warnings.length, 1);
  assert.equal(unclear.batch.warnings[0].kind, 'path-unclear');
  assert.equal(unclear.batch.warnings[0].line, 1);
});

test('A02 冒號後面的Linux路徑也要遮（PATH、scp）', () => {
  const text = 'PATH=/usr/local/bin:/home/wang/.local/bin\nexport PYTHONPATH=/opt/lib:/Users/wang/lib\nscp x deploy@203.0.113.5:/home/wang/app/';
  const { result } = roundTrip(text);
  assert.equal(result.body, 'PATH=/usr/local/bin:/home/USER_1/.local/bin\nexport PYTHONPATH=/opt/lib:/Users/USER_1/lib\nscp x deploy@IP_1:/home/USER_1/app/');
});

test('A02 使用者名稱只到該停的地方：分號、右括號；接著別的路徑時只提醒', () => {
  assert.equal(run('PATH=C:\\Users\\wang;C:\\Windows'.replace(/\\\\/g, '\\')).result.body, 'PATH=C:\\Users\\USER_1;C:\\Windows'.replace(/\\\\/g, '\\'));
  assert.equal(run('(see C:\\Users\\wang)'.replace(/\\\\/g, '\\')).result.body, '(see C:\\Users\\USER_1)'.replace(/\\\\/g, '\\'));
  assert.equal(run('(/home/wang)').result.body, '(/home/USER_1)');
  const moved = run('Moved C:\\Users\\wang to D:\\backup'.replace(/\\\\/g, '\\'));
  assert.equal(typeCount(moved.batch, 'USER'), 0);
  assert.equal(moved.batch.warnings[0].kind, 'path-unclear');
  assert.ok(!moved.batch.warnings[0].message.includes('「wang」'), '提醒不替使用者猜名稱');
});

test('A02 第二輪審查：一個字母的資料夾、撇號、句尾句點、單引號路徑', () => {
  const cases = [
    ['PATH=/opt/a:/home/wang/bin', 'PATH=/opt/a:/home/USER_1/bin'],
    ["C:\\Users\\O'Brien\\Desktop", 'C:\\Users\\USER_1\\Desktop'],
    ['see C:\\Users\\wang.', 'see C:\\Users\\USER_1.'],
    ["path = 'C:\\Users\\wang'", "path = 'C:\\Users\\USER_1'"],
    ['file:///C:/Users/wang/a.txt', 'file:///C:/Users/USER_1/a.txt'],
  ];
  for (const [input, expected] of cases) {
    const text = input.replace(/\\\\/g, '\\');
    const { batch, result } = roundTrip(text);
    assert.equal(result.body, expected.replace(/\\\\/g, '\\'), input);
    assert.equal(batch.candidates.filter((c) => c.type === 'USER').length, 1, `只列一筆：${input}`);
  }
});

test('A02 網址裡的 /home/、/Users/ 不當成使用者路徑', () => {
  const { batch } = run('https://example.invalid/home/index.html https://example.invalid/Users/list');
  assert.equal(typeCount(batch, 'USER'), 0);
});

/* ---------- A03 大小寫 ---------- */
test('A03 wang和Wang分別配號，同拼字共用，還原保留大小寫', () => {
  const text = 'C:\\Users\\wang\\a C:\\Users\\Wang\\b C:\\Users\\wang\\c';
  const { result } = roundTrip(text);
  assert.equal(result.body, 'C:\\Users\\USER_1\\a C:\\Users\\USER_2\\b C:\\Users\\USER_1\\c');
  assert.equal(result.activeMap.get('USER_2'), 'Wang');
});

/* ---------- A04 撞名 ---------- */
test('A04 原文已有USER_1、USER_2、KEY_1：新代號從USER_3、KEY_2開始', () => {
  const text = 'USER_1 USER_2 KEY_1\nC:\\Users\\wang\\x token = sk-proj-EXAMPLE0000fake0000key0000';
  const { batch, result } = roundTrip(text);
  assert.ok(result.body.includes('C:\\Users\\USER_3\\x'));
  assert.ok(result.body.includes('sk-proj-KEY_2'));
  assert.ok(result.body.startsWith('USER_1 USER_2 KEY_1'), '原文的代號寫法不動');
  deq([...batch.reserved].sort(), ['KEY_1', 'USER_1', 'USER_2']);
});

test('A04 藏在長名稱裡的寫法也保留（保守做法）', () => {
  const { batch, result } = roundTrip('OTHER_USER_1 C:\\Users\\wang\\x');
  assert.ok(batch.reserved.has('USER_1'));
  assert.ok(result.body.includes('USER_2'));
});

/* ---------- A05 還原邊界 ---------- */
test('A05 只還原完整的已知代號，USER_30、OTHER_USER_3、原文既有的USER_1都不動', () => {
  const text = 'USER_1 USER_2 C:\\Users\\wang\\x';
  const { result } = run(text);
  assert.equal(result.activeMap.get('USER_3'), 'wang');
  const out = E.restore('USER_3 USER_30 OTHER_USER_3 USER_1', result);
  assert.equal(out.text, 'wang USER_30 OTHER_USER_3 USER_1');
  deq(out.reservedSeen, [{ token: 'USER_1', count: 1 }]);
  deq(out.unknown, [{ token: 'USER_30', count: 1 }]);
});

test('A05 換回來的原文裡就算有代號字樣，也不會再被替換（單輪）', () => {
  const { result } = run('x = "SECRET_9_value"', [{ text: 'SECRET_9_value', type: 'WORD' }]);
  // SECRET_9 在原文裡（藏在長名稱中），所以被保留；WORD_1 換回後不會再處理裡面的文字
  const out = E.restore('WORD_1', result);
  assert.equal(out.text, 'SECRET_9_value');
});

/* ---------- A06 還原報告 ---------- */
test('A06 次數、未知、未出現、疑似改寫', () => {
  const text = 'C:\\Users\\aa\\x C:\\Users\\bb\\x C:\\Users\\cc\\x hw5';
  const { result } = run(text, [{ text: 'hw5', type: 'PROJECT' }]);
  deq(tokensOf(result), ['USER_1', 'USER_2', 'USER_3', 'PROJECT_1']);
  const out = E.restore('USER_3 USER_3 USER_3 USER_9 user_3 USER-3 使用者3', result);
  deq(out.restored, [{ token: 'USER_3', count: 3 }]);
  deq(out.unknown, [{ token: 'USER_9', count: 1 }]);
  assert.ok(out.absent.includes('PROJECT_1'));
  deq(out.suspected.map((s) => s.text).sort(), ['USER-3', 'user_3', '使用者3'].sort());
  assert.ok(out.suspected.every((s) => s.likely === 'USER_3'));
  assert.equal(out.text, 'cc cc cc USER_9 user_3 USER-3 使用者3', '疑似改寫的不猜、不換');
});

test('A06 原文本來就有的寫法不算疑似改寫', () => {
  const { result } = run('user_1 C:\\Users\\wang\\x');
  const out = E.restore('user_1 USER_1', result);
  assert.equal(out.suspected.length, 0);
});

/* ---------- A07 自訂文字 ---------- */
test('A07 四種自訂類型：正例、重複、大小寫不同不算', () => {
  const text = '王小明 S0000001 Moonlight 內部代號甲 王小明 s0000001 moonlight';
  const keywords = [
    { text: '王小明', type: 'NAME' },
    { text: 'S0000001', type: 'SID' },
    { text: 'Moonlight', type: 'PROJECT' },
    { text: '內部代號甲', type: 'WORD' },
  ];
  const { batch, result } = roundTrip(text, keywords);
  assert.equal(result.body, 'NAME_1 SID_1 PROJECT_1 WORD_1 NAME_1 s0000001 moonlight');
  assert.equal(batch.candidates.length, 5, '每次出現各一筆');
});

test('A07 每次出現都能分開保留', () => {
  const batch = E.createBatch('王小明 王小明', [{ text: '王小明', type: 'NAME' }]);
  batch.candidates[1].selected = false;
  const result = E.generate(batch);
  assert.equal(result.body, 'NAME_1 王小明');
});

/* ---------- A08 自訂文字的限制 ---------- */
test('A08 不能換行、不能有引號括號斜線', () => {
  assert.match(E.checkKeyword('a\nb', 'WORD'), /換行/);
  for (const bad of ['"x"', "x'", 'f(x)', 'a[1]', '{a}', '<a>', 'C:\\x', 'a/b']) {
    assert.match(E.checkKeyword(bad, 'WORD'), /引號、括號或斜線/, bad);
  }
  assert.equal(E.checkKeyword('wang', 'NAME'), null);
  assert.match(E.checkKeyword('wang', 'NAME', [{ text: 'wang', type: 'NAME' }]), /加過/);
  assert.match(E.checkKeyword('x', 'BAD'), /類型/);
  assert.throws(() => E.createBatch('x', [{ text: 'a"b', type: 'WORD' }]), /引號/);
});

test('A08 藏在長識別字裡的不遮，改成提醒，不產生半個代號', () => {
  const { batch, result } = roundTrip('prefixsecretsuffix secret', [{ text: 'secret', type: 'WORD' }]);
  assert.equal(result.body, 'prefixsecretsuffix WORD_1');
  const warning = batch.warnings.find((w) => w.kind === 'keyword-inside');
  assert.ok(warning && warning.message.includes('prefixsecretsuffix'));
});

/* ---------- A09 身分證 ---------- */
test('A09 檢查碼正確為高可信度，錯誤為低可信度但預設仍遮罩，兩者都能保留', () => {
  assert.equal(E.validTaiwanId('A123456789'), true);
  assert.equal(E.validTaiwanId('B120667503'), true, '公報附件的範例');
  assert.equal(E.validTaiwanId('A123456788'), false);
  const { batch } = run('A123456789 A123456788');
  const [good, bad] = batch.candidates;
  assert.equal(good.confidence, '高');
  assert.equal(bad.confidence, '低');
  assert.ok(bad.selected);
  assert.match(bad.reasons[0], /檢查碼不對/);
  batch.candidates.forEach((c) => { c.selected = false; });
  assert.equal(E.generate(batch).body, 'A123456789 A123456788');
});

/* ---------- A10 IPv4 ---------- */
test('A10 私有與回環預設保留、可改遮罩；文件示例預設遮罩；無效IP不算', () => {
  const { batch } = run('10.1.2.3 172.16.0.1 192.168.1.10 127.0.0.1 203.0.113.5 172.32.0.1 256.1.1.1 01.2.3.4');
  const ips = batch.candidates.filter((c) => c.type === 'IP');
  deq(ips.map((c) => c.raw), ['10.1.2.3', '172.16.0.1', '192.168.1.10', '127.0.0.1', '203.0.113.5', '172.32.0.1']);
  deq(ips.map((c) => c.selected), [false, false, false, false, true, true]);
  assert.match(ips[4].reasons[0], /RFC 5737/);
  ips[0].selected = true;
  const again = E.generate(batch);
  assert.ok(again.body.startsWith('IP_3 '), '同一批裡已分配的編號不變，新遮罩的拿下一個號碼');
  assert.equal(again.activeMap.get('IP_1'), '203.0.113.5');
});

test('A10 版本號1.2.3.4可以保留', () => {
  const { batch } = run('version 1.2.3.4');
  assert.equal(batch.candidates[0].type, 'IP');
  batch.candidates[0].selected = false;
  assert.equal(E.generate(batch).body, 'version 1.2.3.4');
});

test('A10 句尾的IP也抓得到', () => {
  const { result } = run('連到203.0.113.9.');
  assert.equal(result.body, '連到IP_1.');
});

/* ---------- A11 不該誤判 ---------- */
test('A11 日期、版本、色碼、短hash、行號、HTTP狀態碼不被遮', () => {
  const { batch } = run('2026-10-10 version 3.11.4 color #AABBCC commit deadbeef line 42 HTTP 404 port 8080');
  assert.equal(batch.candidates.length, 0);
});

/* ---------- A12 已知開頭的金鑰 ---------- */
// 虛構的金鑰故意拆成兩段字串再接起來，避免GitHub的金鑰掃描把測試資料誤判成真的金鑰；執行時接起來的內容不變
test('A12 保留開頭的類型：sk-proj-、sk-ant-、sk-、xoxb-', () => {
  const text = [
    'a = sk-proj-EXAMPLE0000fake0000key0000',
    'b = sk-ant-api03-EXAMPLEfake000000000',
    'c = sk-EXAMPLEfake0000000',
    'd = xox' + 'b-000000000000-EXAMPLEfake00000',
  ].join('\n');
  const { result } = roundTrip(text);
  assert.equal(result.body, 'a = sk-proj-KEY_1\nb = sk-ant-KEY_2\nc = sk-KEY_3\nd = xoxb-KEY_4');
});

test('A12 整串換掉的類型：ghp_、github_pat_、AIza、AKIA', () => {
  const text = [
    'gh' + 'p_EXAMPLEfake000000000000000000000000',
    'github' + '_pat_EXAMPLE_fake_00000000000000000',
    'AI' + 'zaEXAMPLE-fake_000000000000000000000',
    'AK' + 'IAEXAMPLEFAKE00000',
  ].join('\n');
  const { result } = roundTrip(text);
  assert.equal(result.body, 'KEY_1\nKEY_2\nKEY_3\nKEY_4');
  assert.equal(result.activeMap.get('KEY_1'), 'gh' + 'p_EXAMPLEfake000000000000000000000000', '整串（含開頭）都記在對照表');
});

test('A12 反例：長度不夠、AKIA後面不是剛好16碼、前面黏著字', () => {
  const { batch } = run('sk-short12345 gh' + 'p_TOOSHORT000 AK' + 'IAEXAMPLEFAKE0000 AK' + 'IAEXAMPLEFAKE000000 tasksk-proj-EXAMPLE0000fake0000');
  assert.equal(typeCount(batch, 'KEY'), 0);
});

test('A12 很長的金鑰整段遮完，不截斷', () => {
  const long = 'sk-proj-' + 'A'.repeat(400);
  const { result } = roundTrip(`key = "${long}"`);
  assert.equal(result.body, 'key = "sk-proj-KEY_1"');
  assert.equal(result.activeMap.get('KEY_1').length, 400);
});

test('A12 api_key="sk-proj-…" 只採一次前綴策略，理由合併', () => {
  const { batch, result } = roundTrip('api_key="sk-proj-EXAMPLE0000fake0000key0000"');
  assert.equal(batch.candidates.length, 1);
  assert.equal(batch.candidates[0].type, 'KEY');
  assert.ok(batch.candidates[0].reasons.some((r) => r.includes('api_key')));
  assert.equal(result.body, 'api_key="sk-proj-KEY_1"');
});

/* ---------- A13 JWT ---------- */
const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJkZW1vIiwibmFtZSI6IlNZTlRIRVRJQyJ9.SYNTHETIC_signature_only';
test('A13 前兩段是JSON才算JWT，理由說明沒驗證簽章', () => {
  const { batch, result } = roundTrip(`jwt: ${JWT}`);
  const token = batch.candidates.find((c) => c.type === 'TOKEN');
  assert.ok(token);
  assert.match(token.reasons.join(''), /沒有驗證簽章/);
  assert.equal(result.body, 'jwt: TOKEN_1');
});

test('A13 五段JWE、三段版本號、一般檔名不算JWT', () => {
  const jwe = `${JWT}.abcd.efgh`;
  const { batch } = run(`${jwe} v1.20.3 main.test.js self.config.value`);
  assert.equal(typeCount(batch, 'TOKEN'), 0);
});

/* ---------- A14 連線字串 ---------- */
test('A14 密碼和主機分開遮，協定、冒號、@、埠、資料庫名稱不變', () => {
  const text = 'postgres://admin:demo%40pass@db.example.invalid:5432/demo';
  const { result } = roundTrip(text);
  assert.equal(result.body, 'postgres://admin:SECRET_1@HOST_1:5432/demo');
  assert.equal(result.activeMap.get('SECRET_1'), 'demo%40pass');
});

test('A14 localhost保留；IP主機交給IPv4規則', () => {
  const local = run('mysql://root:demo_pw@localhost:3306/app');
  assert.equal(local.result.body, 'mysql://root:SECRET_1@localhost:3306/app');
  const lan = run('mongodb://u:demo_pw@192.168.0.8:27017/db');
  assert.equal(lan.result.body, 'mongodb://u:SECRET_1@192.168.0.8:27017/db');
  const wan = run('postgresql+psycopg2://u:demo_pw@203.0.113.7/db');
  assert.equal(wan.result.body, 'postgresql+psycopg2://u:SECRET_1@IP_1/db');
});

test('A14 多主機、IPv6：做基本遮罩並提醒', () => {
  const multi = run('mongodb://u:demo_pw@h1.example.invalid:27017,h2.example.invalid:27017/db');
  assert.ok(multi.batch.warnings.some((w) => w.kind === 'uri-multi'));
  assert.equal(multi.result.body, 'mongodb://u:SECRET_1@HOST_1:27017,HOST_2:27017/db');
  const v6 = run('postgres://u:demo_pw@[2001:db8::1]:5432/db');
  assert.ok(v6.batch.warnings.some((w) => w.kind === 'uri-ipv6'));
  assert.equal(v6.result.body, 'postgres://u:SECRET_1@[HOST_1]:5432/db');
});

test('A14 密碼有沒編碼的符號：不留下半個密碼', () => {
  const slash = run('postgres://admin:pa/ss@db.example.invalid/demo');
  assert.equal(slash.result.body, 'postgres://admin:SECRET_1@HOST_1/demo');
  assert.ok(slash.batch.warnings.some((w) => w.kind === 'uri-lenient'));
  const quoteInside = run('url = "postgres://admin:pa\'ss@db.example.invalid/demo"');
  assert.equal(quoteInside.result.body, 'url = "postgres://admin:SECRET_1@HOST_1/demo"');
  const unquoted = run("postgres://admin:pa'ss@db.example.invalid/demo");
  assert.equal(unquoted.result.body, 'postgres://admin:SECRET_1@HOST_1/demo');
  const spaced = run('url = "postgres://admin:pa ss@db.example.invalid/demo"');
  assert.equal(spaced.result.body, 'url = "postgres://SECRET_1"');
  assert.ok(spaced.batch.warnings.some((w) => w.kind === 'uri-unclear'));
  const bare = run('postgres://admin:pa ss@db.example.invalid/demo');
  for (const leak of ['pa', 'ss@', 'db.example']) assert.ok(!bare.result.body.includes(leak), leak);
  for (const t of [slash, quoteInside, unquoted, spaced, bare]) assert.equal(E.restore(t.result.body, t.result).text, t.batch.source);
});

test('A14 第二輪審查：密碼裡的 / @ # 、查詢參數裡的信箱、角括號', () => {
  const cases = [
    ['postgres://admin:p@ss/word@db.example.invalid/demo', 'postgres://admin:SECRET_1@HOST_1/demo'],
    ['postgres://u:pw@db.example.invalid/db?fallback=demo.student@example.invalid', 'postgres://u:SECRET_1@HOST_1/db?fallback=EMAIL_1'],
    ['<postgres://admin:pw@db.example.invalid>', '<postgres://admin:SECRET_1@HOST_1>'],
  ];
  for (const [input, expected] of cases) assert.equal(roundTrip(input).result.body, expected, input);
  const hash = roundTrip('mongodb+srv://u:@#X@db.example.invalid:5432');
  for (const leak of ['X@', 'db.example']) assert.ok(!hash.result.body.includes(leak), leak);
  assert.ok(hash.batch.warnings.some((w) => w.kind === 'uri-unclear'));
});

test('A14 第三輪審查：密碼開頭是數字再接 # 或 ?、信箱當帳號', () => {
  for (const input of ['postgres://admin:2024#Summer@db.example.invalid/demo', 'mongodb://u:9999#@localhost/db', 'postgres://u:12?ab@db.example.invalid/x',
    'postgres://demo.student@example.invalid:75230?pw&@db.example.invalid/demo']) {
    const { batch, result } = roundTrip(input);
    for (const leak of ['2024', 'Summer', '9999', '12?ab', '75230', 'db.example']) assert.ok(!result.body.includes(leak), `${input} 露出 ${leak}`);
    assert.ok(batch.warnings.some((w) => w.kind === 'uri-unclear'), input);
  }
  const email = roundTrip('mongodb://demo.student@example.invalid:pw@cluster.example.invalid/db');
  assert.equal(email.result.body, 'mongodb://EMAIL_1:SECRET_1@HOST_1/db');
  assert.ok(!email.batch.warnings.some((w) => w.kind === 'uri-lenient'));
});

test('A14 沒有主機的寫法不誤判', () => {
  const { batch } = run('postgres:///localdb');
  assert.equal(batch.candidates.length, 0);
  assert.equal(batch.warnings.length, 0);
});

test('A14 「密碼@主機」不會被誤認成信箱', () => {
  const { batch } = run('postgres://admin:demo_pass@db.example.invalid:5432/demo');
  assert.equal(typeCount(batch, 'EMAIL'), 0);
});

/* ---------- A15 敏感欄位 ---------- */
test('A15 跳脫引號、超過256字的值完整處理，外側引號不變', () => {
  const value = 'FAKE\\"QUOTED\\\\' + 'x'.repeat(300);
  const text = `password = "${value}"`;
  const { result } = roundTrip(text);
  assert.equal(result.body, 'password = "SECRET_1"');
  assert.equal(result.activeMap.get('SECRET_1'), value);
});

test('A15 找不到結尾引號：遮到行尾並提醒，不默默截斷', () => {
  const { batch, result } = roundTrip('token = "abc def\nnext = 1');
  assert.equal(result.body, 'token = "SECRET_1\nnext = 1');
  assert.ok(batch.warnings.some((w) => w.kind === 'unclosed-quote'));
  assert.equal(batch.candidates[0].confidence, '低');
});

test('A15 各種欄位寫法：.env、JSON、camelCase、HTTP標頭', () => {
  const text = [
    'DB_PASSWORD=hunter2demo',
    '"apiKey": "fake-key-value"',
    'clientSecret: fake_client_secret',
    'Authorization: Bearer FAKE.TOKEN.VALUE',
    'export GITHUB_TOKEN=fake_token_value',
  ].join('\n');
  const { result } = roundTrip(text);
  assert.equal(result.body, [
    'DB_PASSWORD=SECRET_1',
    '"apiKey": "SECRET_2"',
    'clientSecret: SECRET_3',
    'Authorization: Bearer SECRET_4',
    'export GITHUB_TOKEN=SECRET_5',
  ].join('\n'));
});

test('A15 不是秘密的值不遮：程式參照、型別、布林、比較', () => {
  const text = [
    'password = os.getenv("DB_PASSWORD")',
    'token: string',
    'api_key = None',
    'if password == "x":',
    'max_tokens = 1000',
    'tokenizer = load()',
    'const clean = password => password.trim()',
  ].join('\n');
  const { batch } = run(text);
  assert.equal(typeCount(batch, 'SECRET'), 0);
});

test('A15 值看起來像變數或參照時，仍然遮罩但標成低可信度', () => {
  const { batch, result } = roundTrip('DB_PASSWORD=$up3rS3cret\nPASSWORD=john.smith\npassword = config.password');
  assert.equal(result.body, 'DB_PASSWORD=SECRET_1\nPASSWORD=SECRET_2\npassword = SECRET_3');
  assert.ok(batch.candidates.every((c) => c.confidence === '低'));
});

test('A15 審查補強：分號、空白、:=、=>、PGPASSWORD、行尾註解', () => {
  const text = [
    'DB_PASSWORD=Sup3r;Secret',
    'password: correct horse battery staple',
    'PASSWORD=abc(123',
    'password := "hunter2"',
    "'password' => 'hunter3'",
    'PGPASSWORD=hunter4',
    'export DB_PASSWORD=abc # 註解',
    'ODBC: Server=db;Uid=u;Pwd=odbc_pw;',
  ].join('\n');
  const { result } = roundTrip(text);
  assert.equal(result.body, [
    'DB_PASSWORD=SECRET_1',
    'password: SECRET_2',
    'PASSWORD=SECRET_3',
    'password := "SECRET_4"',
    "'password' => 'SECRET_5'",
    'PGPASSWORD=SECRET_6',
    'export DB_PASSWORD=SECRET_7 # 註解',
    'ODBC: Server=db;Uid=u;Pwd=SECRET_8;',
  ].join('\n'));
});

test('A15 第二輪審查：程式碼裡的密碼、物件與陣列、YAML多行、Dockerfile、命令列', () => {
  const cases = [
    ['token = login(user="demo", password="hunter2")', 'token = login(user="demo", password="SECRET_1")'],
    ['auth_token = client.login(password="Sup3rSecret")', 'auth_token = client.login(password="SECRET_1")'],
    ['password=Summer(2024)', 'password=SECRET_1'],
    ['password: hunter[2]', 'password: SECRET_1'],
    ['PASSWORD=~secret', 'PASSWORD=SECRET_1'],
    ['ENV DB_PASSWORD=Sup3r;Secret', 'ENV DB_PASSWORD=SECRET_1'],
    ['PGPASSWORD=hunter2 psql -h db.example.invalid -U admin', 'PGPASSWORD=SECRET_1 psql -h db.example.invalid -U admin'],
    [':password => "rubypw"', ':password => "SECRET_1"'],
    ['credentials: {', 'credentials: {'],
    ['  "token": ["abc", "def"],', '  "token": ["SECRET_1", "SECRET_2"],'],
    ['password: |\n  Sup3rSecret\n  second line\nnext: 1', 'password: |\n  SECRET_1\n  SECRET_2\nnext: 1'],
  ];
  for (const [input, expected] of cases) {
    const { result } = roundTrip(input);
    assert.equal(result.body, expected, input);
  }
});

test('A15／A19 排版過的JSON：外層物件不遮，裡面的密碼遮，JSON仍然有效', () => {
  const text = '{\n  "auth": {\n    "password": "x1",\n    "token": ["a1", "b2"],\n    "max_tokens": 1000\n  }\n}';
  const { result } = roundTrip(text);
  assert.equal(result.checks.json.ok, true);
  assert.equal(result.copyAllowed, true);
  deq(JSON.parse(result.body), { auth: { password: 'SECRET_1', token: ['SECRET_2', 'SECRET_3'], max_tokens: 1000 } });
});

test('A15 第三輪審查：陣列（不加引號、跨行、含物件）、YAML清單裡的多行值', () => {
  const cases = [
    ['token: [abc, def, 42, true]', 'token: [SECRET_1, SECRET_2, 42, true]'],
    ['"token": [\n  "abc123secret",\n  "def456"\n]', '"token": [\n  "SECRET_1",\n  "SECRET_2"\n]'],
    ['{"credentials": [{"user": "demo", "password": "x1"}]}', '{"credentials": [{"user": "demo", "password": "SECRET_1"}]}'],
    ['- password: |\n      Sup3r\n      More\n    user: demo', '- password: |\n      SECRET_1\n      SECRET_2\n    user: demo'],
    ['{"token": [["abc"], ["def", 7]]}', '{"token": [["SECRET_1"], ["SECRET_2", 7]]}'],
    ['auth_token: >\n    a1\n  b2\nnext: 1', 'auth_token: >\n    SECRET_1\n  SECRET_2\nnext: 1'],
  ];
  for (const [input, expected] of cases) assert.equal(roundTrip(input).result.body, expected, input);
});

/* ---------- A16 重疊 ---------- */
test('A16 email和自訂example.invalid重疊只輸出一次；保留其中一筆不影響另一筆', () => {
  const text = 'mail: demo@example.invalid';
  const keywords = [{ text: 'example.invalid', type: 'WORD' }];
  const { batch, result } = roundTrip(text, keywords);
  assert.equal(result.body, 'mail: EMAIL_1');
  assert.equal(result.merged, 1);
  batch.candidates.find((c) => c.type === 'EMAIL').selected = false;
  assert.equal(E.generate(batch).body, 'mail: demo@WORD_1');
});

test('A16 部分交叉的合併成一個WORD代號，對照表和還原一致', () => {
  const text = '這是王小明同學的作業';
  const keywords = [{ text: '王小明', type: 'NAME' }, { text: '小明同學', type: 'WORD' }];
  const { batch, result } = roundTrip(text, keywords);
  assert.equal(result.body, '這是WORD_1的作業');
  assert.equal(result.activeMap.get('WORD_1'), '王小明同學');
  deq(batch.candidates[0].overlaps, [1]);
});

test('A16 緊貼的兩筆合併，避免代號黏在一起', () => {
  const { result } = roundTrip('王小明A123456789', [{ text: '王小明', type: 'NAME' }]);
  assert.equal(result.body, 'WORD_1');
});

/* ---------- A17 換行與縮排 ---------- */
test('A17 CRLF、LF、混合換行、Tab縮排、行號都不變', () => {
  const text = 'line1\r\n\tC:\\Users\\wang\\a.py:42:7\n    mail = demo@example.invalid\r\n\r  end\n';
  const { result } = roundTrip(text);
  assert.equal(result.checks.structure, true);
  assert.equal(result.body, 'line1\r\n\tC:\\Users\\USER_1\\a.py:42:7\n    mail = EMAIL_1\r\n\r  end\n');
});

/* ---------- A18 可逆檢查 ---------- */
test('A18 所有核心fixture都能逐字還原', () => {
  for (const [text, kw] of [[FIXTURE, FIXTURE_KEYWORDS], [E.SAMPLE.text, E.SAMPLE.keywords], ['', []], ['沒有任何敏感資料', []]]) {
    roundTrip(text, kw);
  }
});

test('A18 對照表被破壞時阻擋複製', () => {
  const batch = E.createBatch('C:\\Users\\wang\\a C:\\Users\\Wang\\b');
  batch.allocations.set('USER\u0000wang', 'USER_1');
  batch.allocations.set('USER\u0000Wang', 'USER_1'); // 故意讓兩個原文對到同一個代號
  batch.assigned.add('USER_1');
  const result = E.generate(batch);
  assert.equal(result.checks.roundTrip, false);
  assert.equal(result.copyAllowed, false);
  assert.ok(result.blockers.includes('roundTrip'));
});

test('A18 代號會黏住旁邊的字時阻擋複製', () => {
  const batch = E.createBatch('demo@example.invalid_backup');
  const result = E.generate(batch);
  assert.equal(result.copyAllowed, false);
  assert.equal(result.problems[0].kind, 'glued');
});

/* ---------- A19 JSON ---------- */
test('A19 有效JSON裡的字串遮罩後仍可解析', () => {
  const text = JSON.stringify({ path: 'C:\\Users\\wang\\x.py', email: 'demo@example.invalid', password: 'fake_pw' }, null, 2);
  const { result } = roundTrip(text);
  assert.equal(result.checks.json.applicable, true);
  assert.equal(result.checks.json.ok, true);
  deq(JSON.parse(result.body), { path: 'C:\\Users\\USER_1\\x.py', email: 'EMAIL_1', password: 'SECRET_1' });
});

test('A19 數字被換成代號導致JSON失效：阻擋複製', () => {
  const { result } = roundTrip('{"sid":123456}', [{ text: '123456', type: 'SID' }]);
  assert.equal(result.checks.json.ok, false);
  assert.equal(result.copyAllowed, false);
  assert.ok(result.blockers.includes('json'));
});

test('A19 原文不是JSON時標為不適用', () => {
  const { result } = run('{ email: "demo@example.invalid", }');
  assert.equal(result.checks.json.applicable, false);
  assert.equal(result.copyAllowed, true);
});

/* ---------- A20 代號說明 ---------- */
test('A20 說明只列實際用到的代號，不含原文、對照表或自訂清單', () => {
  const { result } = run('mail demo@example.invalid 王小明', [{ text: '王小明', type: 'NAME' }, { text: '沒出現的字', type: 'WORD' }]);
  const withGuide = E.buildPrompt(result, true);
  const withoutGuide = E.buildPrompt(result, false);
  assert.equal(withoutGuide, result.body);
  assert.ok(withGuide.endsWith('\n\n' + result.body));
  const guide = withGuide.slice(0, withGuide.length - result.body.length);
  assert.ok(guide.includes('EMAIL_1') && guide.includes('NAME_1'));
  for (const leak of ['demo@', '王小明', '沒出現的字', 'WORD_']) assert.ok(!guide.includes(leak), leak);
});

test('A20 沒有代號時不附說明', () => {
  const { result } = run('沒有敏感資料');
  assert.equal(E.buildPrompt(result, true), '沒有敏感資料');
});

/* ---------- A21／A23 靜態檢查 ---------- */
test('A21 程式沒有使用innerHTML這類把字串當HTML的寫法', () => {
  assert.ok(!/\.(?:innerHTML|outerHTML)\b|insertAdjacentHTML|document\.write|\beval\(|new Function/.test(script));
});

test('A23 沒有連網、儲存或console', () => {
  assert.ok(!/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|localStorage|sessionStorage|indexedDB|caches|serviceWorker|document\.cookie|console)\b/.test(script));
  assert.ok(!/<(?:script|link|img|iframe|object|embed)\b[^>]*\b(?:src|href)=/i.test(html));
  assert.ok(!/\son[a-z]+=/i.test(html.replace(/<script>[\s\S]*<\/script>/, '')), '沒有行內事件屬性');
});

test('A23 CSP雜湊和內容相符，連線全部禁止', () => {
  const style = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  const digest = (t) => createHash('sha256').update(t, 'utf8').digest('base64');
  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  assert.ok(csp.includes(`script-src 'sha256-${digest(script)}'`));
  assert.ok(csp.includes(`style-src 'sha256-${digest(style)}'`));
  for (const d of ["default-src 'none'", "connect-src 'none'", "img-src 'none'", "form-action 'none'", "base-uri 'none'"]) assert.ok(csp.includes(d), d);
  assert.ok(!csp.includes('unsafe'));
  assert.equal((html.match(/<script>/g) || []).length, 1);
  assert.equal((html.match(/<style>/g) || []).length, 1);
});

test('A23 所有文字欄位都關閉拼字檢查與自動完成', () => {
  const fields = html.match(/<(?:textarea|input)\b[^>]*>/g).filter((tag) => !/type="checkbox"/.test(tag));
  assert.ok(fields.length >= 4);
  for (const tag of fields) {
    for (const attr of ['spellcheck="false"', 'autocomplete="off"', 'autocorrect="off"', 'autocapitalize="off"']) {
      assert.ok(tag.includes(attr), `${tag} 少了 ${attr}`);
    }
  }
});

/* ---------- A24 上限與效能 ---------- */
test('A24 長度上限：100,000可以、100,001拒絕', () => {
  assert.doesNotThrow(() => E.createBatch('x'.repeat(100000)));
  assert.throws(() => E.createBatch('x'.repeat(100001)), /100,000/);
  const { result } = run('x');
  assert.doesNotThrow(() => E.restore('x'.repeat(100000), result));
  assert.throws(() => E.restore('x'.repeat(100001), result), /100,000/);
});

test('A24 自訂文字上限：50筆可以、51筆拒絕；200字可以、201字拒絕', () => {
  const many = (n) => Array.from({ length: n }, (_, i) => ({ text: `kw${i}`, type: 'WORD' }));
  assert.doesNotThrow(() => E.createBatch('x', many(50)));
  assert.throws(() => E.createBatch('x', many(51)), /50/);
  assert.equal(E.checkKeyword('a'.repeat(200), 'WORD'), null);
  assert.match(E.checkKeyword('a'.repeat(201), 'WORD'), /200/);
});

test('A24 候選上限：1,000可以、1,001拒絕且不給部分結果', () => {
  const mails = (n) => Array.from({ length: n }, (_, i) => `u${i}@example.invalid`).join('\n');
  assert.equal(E.createBatch(mails(1000)).candidates.length, 1000);
  assert.throws(() => E.createBatch(mails(1001)), /1,000/);
});

test('A24 效能：接近100,000字、將近1,000筆的文字在2秒內掃描加遮罩', () => {
  const unit = 'File "C:\\Users\\wang\\Desktop\\project\\main.py", line 42, in load_config: ValueError invalid literal v3.11.4\n';
  const text = unit.repeat(Math.floor(99500 / unit.length));
  const t0 = performance.now();
  const { batch, result } = run(text);
  const ms = performance.now() - t0;
  assert.ok(text.length > 95000 && batch.candidates.length > 800, `${text.length}字、${batch.candidates.length}筆`);
  assert.equal(result.checks.roundTrip, true);
  assert.ok(ms < 2000, `${ms.toFixed(0)} ms`);
  console.log(`  效能：${text.length}字、${batch.candidates.length}筆，掃描加遮罩 ${ms.toFixed(1)} ms`);
});

test('A24 退化輸入（長串同一字元、大量符號）都在2秒內', () => {
  const inputs = [
    'a'.repeat(100000), '1'.repeat(100000), '@'.repeat(100000), 'a@'.repeat(50000), 'a.'.repeat(50000),
    '\\'.repeat(100000), 'C:\\Users\\'.repeat(9000), '/home/'.repeat(16000), '="'.repeat(50000),
    'password='.repeat(11000), 'eyJ.'.repeat(25000), 'sk-'.repeat(33000), ('a'.repeat(63) + '.').repeat(1500),
    'pwd=$'.repeat(20000), 'pwd=('.repeat(20000), 'x pwd=%'.repeat(14000), 'auth=$'.repeat(16000), 'C:\\Users\\a b\n'.repeat(7692),
    'postgres://'.repeat(9000), 'a:b@'.repeat(25000), '"password": "'.repeat(7000),
    'password=' + ','.repeat(99989) + 'x', 'password: a' + ' '.repeat(60000) + 'b', 'token: [' + '"a",'.repeat(24000),
    'password: |\n' + '  x\n'.repeat(30000), ('token = f(' + 'password=g('.repeat(5) + ')\n').repeat(1500),
    'pwd=['.repeat(20000), ' [pwd = '.repeat(12500), 'pwd={{'.repeat(16700), 'pwd={'.repeat(20000), 'x pwd=a('.repeat(12500),
    'postgres://' + 'a,a,a,a,a,a,a,a,a,a@'.repeat(5000), 'postgres://' + 'a@'.repeat(50000), 'postgres://' + 'a@/'.repeat(33000),
    'token: [' + 'a, '.repeat(33000), '"token": [' + '\n "a",'.repeat(16000),
  ];
  for (const text of inputs) {
    const t0 = performance.now();
    try {
      E.generate(E.createBatch(text.slice(0, 100000)));
    } catch (error) {
      if (!(error instanceof E.InputError)) throw error; // 數量太多被拒絕也算正常
    }
    const ms = performance.now() - t0;
    assert.ok(ms < 2000, `${JSON.stringify(text.slice(0, 12))}… 花了 ${ms.toFixed(0)} ms`);
  }
});

/* ---------- 其他 ---------- */
test('私鑰：只有結尾標記也要提醒並擋下複製', () => {
  const { batch, result } = run('FAKEFAKE\n-----END ' + 'RSA PRIVATE KEY-----');
  assert.ok(batch.warnings.some((w) => w.kind === 'private-key' && w.blocking));
  assert.equal(result.copyAllowed, false);
  const both = run('-----BEGIN ' + 'PRIVATE KEY-----\nFAKE\n-----END ' + 'PRIVATE KEY-----');
  assert.equal(both.batch.warnings.length, 1, '完整區塊只提醒一次');
});

test('偵測規則：信箱、手機、電腦名稱的正反例', () => {
  const { batch } = run('a.b+c@example.invalid 0912-345-678 0912345678 +886 912 345 678 DESKTOP-AB12CD3 desktop-preview.jpg lodash@4.17.21');
  const types = batch.candidates.map((c) => `${c.type}:${c.raw}`);
  deq(types, ['EMAIL:a.b+c@example.invalid', 'PHONE:0912-345-678', 'PHONE:0912345678', 'PHONE:+886 912 345 678', 'HOST:DESKTOP-AB12CD3']);
});

test('隨機組合100次都能逐字還原', () => {
  let seed = 42;
  const rand = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const parts = ['C:\\Users\\wang\\', '/home/Demo/', 'demo@example.invalid', 'A123456789', '0912-345-678', '203.0.113.5',
    '192.168.0.1', 'sk-proj-EXAMPLE0000fake0000', 'token = "fake_secret"', 'USER_1', 'user_2', '王小明', '\n', '\r\n', '\t', ' ', '😀', 'x'];
  for (let i = 0; i < 100; i++) {
    const text = Array.from({ length: 40 }, () => parts[rand(parts.length)]).join(rand(2) ? ' ' : '');
    const { result } = run(text, [{ text: '王小明', type: 'NAME' }]);
    if (result.problems.length) continue; // 隨機接在一起可能黏字，那種情況本來就會被擋下
    assert.equal(E.restore(result.body, result).text, text, text);
  }
});

test('同一批重新產生時，代號維持不變', () => {
  const batch = E.createBatch('demo@example.invalid C:\\Users\\wang\\x');
  const first = E.generate(batch).body;
  batch.candidates[0].selected = false;
  E.generate(batch);
  batch.candidates[0].selected = true;
  assert.equal(E.generate(batch).body, first);
});

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok ? '' : ' — ' + r.error}`);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exitCode = failed.length ? 1 : 0;
