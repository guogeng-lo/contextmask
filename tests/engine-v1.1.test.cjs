// v1.1 新增的核心測試：漏遮修正（R01–R04）、未完整處理的確認流程（D03）、跳號說明、還原摘要，
// 以及開發中審查找到的寫法。
// 所有資料都是虛構的。執行：node tests/engine-v1.1.test.cjs
// 隨機測試的次數和種子可以用環境變數調整，例如 FUZZ_N=20000 FUZZ_SEED=7（預設 5000 組、種子 20261010）。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const load = require('./load.cjs');

const { engine: E } = load();
const results = [];
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

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const run = (text, keywords = []) => {
  const batch = E.createBatch(text, keywords);
  return { batch, result: E.generate(batch) };
};
// 遮罩後直接還原要和原文一字不差，換行縮排也不能變
const check = (text, keywords = []) => {
  const { batch, result } = run(text, keywords);
  assert.equal(E.restore(result.body, result).text, text, '直接還原要和原文一字不差');
  assert.equal(result.checks.roundTrip, true);
  assert.equal(result.checks.structure, true);
  return { batch, result };
};
const body = (text, keywords) => check(text, keywords).result.body;
const kinds = (list) => list.map((w) => w.kind);

/* ---------- R01：值寫在下一行 ---------- */
test('R01 審查報告的例子：JSON 密碼值在下一行，完整遮罩、JSON 仍有效、可以直接複製', () => {
  const text = '{"password":\n "SYNTHETIC_SECRET_ABC"}';
  const { result } = check(text);
  assert.equal(result.body, '{"password":\n "SECRET_1"}');
  assert.equal(result.checks.json.applicable, true);
  assert.equal(result.checks.json.ok, true);
  assert.equal(result.incomplete.length, 0);
  assert.equal(E.copyState(result, false).allowed, true);
});

test('R01 fixtures/03（排版過的 JSON）', () => {
  const text = fixture('03-fake-password-newline.txt');
  const { result } = check(text);
  assert.ok(!result.body.includes('SYNTHETIC_SECRET_ABC'));
  deq(JSON.parse(result.body), { password: 'SECRET_1' });
});

test('R01 各種格式的下一行值：JavaScript、YAML、清單、CRLF、中間有註解行', () => {
  const cases = [
    ['const cfg = {\n  password:\n    "hunter2",\n};', 'const cfg = {\n  password:\n    "SECRET_1",\n};'],
    ['const token =\n  "abc";', 'const token =\n  "SECRET_1";'],
    ['password:\n  hunter2\nuser: bob', 'password:\n  SECRET_1\nuser: bob'],
    ['password:\n  "hunter2"\nuser: bob', 'password:\n  "SECRET_1"\nuser: bob'],
    ['password:\n  - abc\n  - \'def\'\n  - 42\nuser: bob', 'password:\n  - SECRET_1\n  - \'SECRET_2\'\n  - 42\nuser: bob'],
    ['password:\n- abc\n- def\nuser: bob', 'password:\n- SECRET_1\n- SECRET_2\nuser: bob'],
    ['{\r\n  "password":\r\n    "CRLF_VALUE"\r\n}', '{\r\n  "password":\r\n    "SECRET_1"\r\n}'],
    ['password:\n  # 註解\n  hunter2\nuser: x', 'password:\n  # 註解\n  SECRET_1\nuser: x'],
    ['"token":\n  ["a1", "b2"]', '"token":\n  ["SECRET_1", "SECRET_2"]'],
    ["'password':\n    'abc',", "'password':\n    'SECRET_1',"],
  ];
  for (const [input, expected] of cases) assert.equal(body(input), expected, input);
});

test('R01 下一行不是值時不亂遮：空值、下一個欄位、巢狀物件、一般句子', () => {
  for (const text of ['password:\nuser: bob', 'PASSWORD=\nOTHER=1', '"password":\n"user": "bob"', 'Enter the token:\nThen press enter', 'password = (\n  get_password()\n)']) {
    const { batch } = check(text);
    assert.equal(batch.candidates.length, 0, text);
  }
  assert.equal(body('password:\n  user: x\n  token: y'), 'password:\n  user: x\n  token: SECRET_1', '巢狀物件裡的欄位照常檢查');
});

test('R01 JSON 的數字密碼在下一行：照樣遮，JSON 被破壞時擋下複製（和同一行的規則一致）', () => {
  const { result } = check('{"password":\n 123456}');
  assert.equal(result.body, '{"password":\n SECRET_1}');
  assert.equal(result.checks.json.ok, false);
  assert.equal(result.copyAllowed, false);
});

/* ---------- R02：YAML ---------- */
test("R02 YAML 單引號裡的 '' 是同一個字串，整段遮完", () => {
  const { result } = check("password: 'demo''SYNTHETIC_SECRET_SUFFIX'");
  assert.equal(result.body, "password: 'SECRET_1'");
  assert.equal(result.activeMap.get('SECRET_1'), "demo''SYNTHETIC_SECRET_SUFFIX");
  assert.equal(body("db:\n  password: 'it''s'\n  user: \"x\""), "db:\n  password: 'SECRET_1'\n  user: \"x\"");
  assert.equal(body('password = "abc""def"'), 'password = "SECRET_1"');
});

test('R02 YAML 多行值行尾的逗號、分號屬於資料，一起遮', () => {
  const text = 'password: |\n  SYNTHETIC_SECRET_ABC,;\n  SECOND_SECRET_XYZ;';
  const { result } = check(text);
  assert.equal(result.body, 'password: |\n  SECRET_1\n  SECRET_2');
  assert.equal(result.activeMap.get('SECRET_1'), 'SYNTHETIC_SECRET_ABC,;');
  assert.equal(result.activeMap.get('SECRET_2'), 'SECOND_SECRET_XYZ;');
});

test('R02 其他 YAML 多行寫法：>-、|2、!vault |、沒引號的值延續到下一行', () => {
  const cases = [
    ['password: >-\n  folded,\n  text;', 'password: >-\n  SECRET_1\n  SECRET_2'],
    ['api_key: |2\n    indented\n    block', 'api_key: |2\n    SECRET_1\n    SECRET_2'],
    ['password: !vault |\n  $ANSIBLE_VAULT;1.1;AES256\n  6231,;', 'password: !vault |\n  SECRET_1\n  SECRET_2'],
    ['password: abc\n  continued line\nuser: x', 'password: SECRET_1\n  SECRET_2\nuser: x'],
    ['- password: abc\n    cont\n- other', '- password: SECRET_1\n    SECRET_2\n- other'],
  ];
  for (const [input, expected] of cases) assert.equal(body(input), expected, input);
});

test('R02 同一行沒引號的值：YAML 這類行尾的逗號、分號一起遮；看起來是程式變數時才當成標點', () => {
  const { result } = check('password: hunter2,;\nsecret: abc, # 註解\ndb_pass = some_var;');
  assert.equal(result.body, 'password: SECRET_1\nsecret: SECRET_2 # 註解\ndb_pass = SECRET_3;');
  assert.equal(result.activeMap.get('SECRET_1'), 'hunter2,;');
  assert.equal(result.activeMap.get('SECRET_3'), 'some_var');
});

test('R02 YAML「password: #…」：值在下一行就遮下一行；沒有的話保險起見把 # 那段遮住（低可信度）', () => {
  assert.equal(body('password: # 註解\n  hunter2'), 'password: # 註解\n  SECRET_1');
  const { batch, result } = check('password: #MyPass\nuser: x');
  assert.equal(result.body, 'password: SECRET_1\nuser: x');
  assert.equal(batch.candidates[0].confidence, '低');
});

/* ---------- R03：Python 三引號、跨行字串 ---------- */
test('R03 審查報告的例子：同一行的三引號完整遮罩', () => {
  const { result } = check('password = """SYNTHETIC_SECRET_ABC"""');
  assert.equal(result.body, 'password = """SECRET_1"""');
  assert.equal(result.incomplete.length, 0);
  assert.equal(body("password = '''abc'''\ntoken = r\"\"\"x\\\"y\"\"\""), "password = '''SECRET_1'''\ntoken = r\"\"\"SECRET_2\"\"\"");
});

test('R03 跨行的三引號、反引號：每一行分開遮，縮排和換行不動', () => {
  const { result } = check('password = """line1\n    line2,;\nline3"""\nuser = 1');
  assert.equal(result.body, 'password = """SECRET_1\n    SECRET_2\nSECRET_3"""\nuser = 1');
  assert.equal(result.activeMap.get('SECRET_2'), 'line2,;');
  assert.equal(body('password = `abc\n  def`;'), 'password = `SECRET_1\n  SECRET_2`;');
  assert.equal(body('SECRET_KEY = """\nline one\n"""'), 'SECRET_KEY = """\nSECRET_1\n"""');
});

test('R03 三引號找不到結尾：第一行遮到行尾，列為未完整處理，要確認才能複製', () => {
  const { result } = check('password = """never closed\nmore\nlines');
  assert.equal(result.body, 'password = """SECRET_1\nmore\nlines');
  deq(kinds(result.incomplete), ['unclosed-multiline']);
  assert.equal(result.copyAllowed, true, '硬性檢查本身通過');
  assert.equal(E.copyState(result, false).allowed, false);
  assert.equal(E.copyState(result, false).reason, 'confirm');
  assert.equal(E.copyState(result, true).allowed, true);
});

test('R03 跨行字串超過200行：視為找不到結尾（列為未完整處理）', () => {
  const text = 'password = """first\n' + 'x\n'.repeat(250) + '"""';
  const { result } = check(text);
  deq(kinds(result.incomplete), ['unclosed-multiline']);
  assert.ok(result.body.startsWith('password = """SECRET_1\nx\n'));
});

test('R03 接在一起的字串：同一行、括號裡（Python 拆長字串）、行尾的 +', () => {
  const cases = [
    ['password = "abc" "def"', 'password = "SECRET_1" "SECRET_2"'],
    ["token = 'x' + 'y'", "token = 'SECRET_1' + 'SECRET_2'"],
    ["secret = 'p' . 'q'", "secret = 'SECRET_1' . 'SECRET_2'"],
    ['API_TOKEN = (\n    "part_one"\n    "part_two"\n)\nx = 1', 'API_TOKEN = (\n    "SECRET_1"\n    "SECRET_2"\n)\nx = 1'],
    ['const token =\n  "abc" +\n  "def";', 'const token =\n  "SECRET_1" +\n  "SECRET_2";'],
    ['credentials = ("user", "pass")', 'credentials = ("SECRET_1", "SECRET_2")'],
  ];
  for (const [input, expected] of cases) assert.equal(body(input), expected, input);
  assert.equal(body('password = "abc" if x else "def"'), 'password = "SECRET_1" if x else "def"', '不是接在一起的字串不遮');
});

/* ---------- R04：JSON 檢查 ---------- */
test('R04 原文是單獨的數字、布林、null：換成代號後不是有效 JSON，擋下複製', () => {
  for (const [text, type] of [['123456', 'SID'], ['true', 'WORD'], ['null', 'WORD'], ['[1, 2]', 'WORD']]) {
    const keyword = text === '[1, 2]' ? '2' : text;
    const { result } = run(text, [{ text: keyword, type }]);
    assert.equal(result.checks.json.applicable, true, text);
    assert.equal(result.checks.json.ok, false, text);
    assert.equal(result.copyAllowed, false, text);
    assert.ok(result.blockers.includes('json'), text);
    deq(E.copyState(result, true), { allowed: false, reason: 'blocked' }, `${text}：確認也不能越過`);
  }
});

test('R04 原文是 JSON 字串或物件：遮罩後仍可解析就照常放行', () => {
  const { result } = check('"C:\\\\Users\\\\wang\\\\a.txt"');
  assert.equal(result.checks.json.applicable, true);
  assert.equal(result.checks.json.ok, true);
  assert.equal(JSON.parse(result.body), 'C:\\Users\\USER_1\\a.txt');
  const nested = check('{"body": "{\\"password\\": \\"hunter2\\", \\"user\\": \\"bob\\"}"}');
  assert.equal(nested.result.checks.json.ok, true);
  assert.ok(!nested.result.body.includes('hunter2'), '字串裡的 JSON 也會遮');
});

/* ---------- 其他寫法 ---------- */
test('字串裡的欄位名稱：print("password:" "abc")、log("token: " + "xyz")；print("password:") 不誤報', () => {
  const { batch, result } = check('print("password:" "abc")\nlog("token: " + "xyz")\nprint("password:")');
  assert.equal(result.body, 'print("password:" "SECRET_1")\nlog("token: " + "SECRET_2")\nprint("password:")');
  assert.equal(batch.warnings.length, 0);
});

test('陣列裡有物件時，物件前後的字串都遮，物件裡的欄位照常檢查', () => {
  assert.equal(body('"token": ["abc", {"x": 1}, "def"]'), '"token": ["SECRET_1", {"x": 1}, "SECRET_2"]');
  assert.equal(body('"tokens": [{"token": "a1"}, {"token": "b2"}]'), '"tokens": [{"token": "SECRET_1"}, {"token": "SECRET_2"}]');
});

test('陣列沒有結尾：遮找得到的項目，列為未完整處理，不會把下一個欄位當成項目', () => {
  const { result } = check('"token": [\n  "abc",\n  "def",');
  assert.equal(result.body, '"token": [\n  "SECRET_1",\n  "SECRET_2",');
  deq(kinds(result.incomplete), ['unclosed-array']);
  const next = check('token: [abc\npassword: ["x"]');
  assert.equal(next.result.body, 'token: [SECRET_1\npassword: ["SECRET_2"]');
});

/* ---------- D03：未完整處理的敏感欄位 ---------- */
test('D03 看不出使用者名稱範圍：列在 incomplete，要確認；補上自訂文字後就不算未完成', () => {
  const text = 'Moved C:\\Users\\wang to D:\\backup';
  const before = run(text);
  deq(kinds(before.result.incomplete), ['path-unclear']);
  const item = before.result.incomplete[0];
  assert.equal(item.line, 1);
  assert.ok(item.risk && item.fix, '要有風險說明和處理方式');
  assert.equal(E.copyState(before.result, false).reason, 'confirm');
  const after = check(text, [{ text: 'wang', type: 'NAME' }]);
  assert.equal(after.result.incomplete.length, 0);
  assert.equal(E.copyState(after.result, false).allowed, true);
});

test('D03 自訂文字藏在長名稱裡：列在 incomplete；把長名稱也加進自訂文字後解除', () => {
  const kw = [{ text: 'secret', type: 'WORD' }];
  deq(kinds(run('prefixsecretsuffix secret', kw).result.incomplete), ['keyword-inside']);
  const fixed = check('prefixsecretsuffix secret', [...kw, { text: 'prefixsecretsuffix', type: 'WORD' }]);
  assert.equal(fixed.result.incomplete.length, 0);
});

test('D03 找不到結尾引號：列在 incomplete（沒有辦法用自訂文字解除，要改原文）', () => {
  const { result } = check('token = "abc def\nnext = 1');
  deq(kinds(result.incomplete), ['unclosed-quote']);
});

test('D03 只是提醒範圍的（連線字串格式看不懂等）不算未完整處理，不用確認', () => {
  const { result } = run('url = "postgres://admin:pa ss@db.example.invalid/demo"');
  assert.ok(result.notices.some((w) => w.kind === 'uri-unclear'));
  assert.equal(result.incomplete.length, 0);
  assert.equal(E.copyState(result, false).allowed, true);
});

test('D03 硬性阻擋不能用確認越過：私鑰、JSON 被破壞、代號黏住', () => {
  const key = run('Moved C:\\Users\\wang to D:\\backup\n-----BEGIN ' + 'PRIVATE KEY-----\nFAKE\n-----END ' + 'PRIVATE KEY-----');
  assert.equal(key.result.incomplete.length, 1);
  deq(E.copyState(key.result, true), { allowed: false, reason: 'blocked' });
  const json = run('{"sid":123456,"path":"C:\\\\Users\\\\wang and more"}', [{ text: '123456', type: 'SID' }]);
  assert.ok(json.result.blockers.includes('json'));
  assert.equal(E.copyState(json.result, true).allowed, false);
  const glued = run('demo@example.invalid_backup');
  assert.equal(E.copyState(glued.result, true).allowed, false);
});

test('D03 正常流程不用確認：內建範例沒有 incomplete，可以直接複製', () => {
  const { result } = check(E.SAMPLE.text, E.SAMPLE.keywords);
  assert.equal(result.incomplete.length, 0);
  deq(E.copyState(result, false), { allowed: true, reason: 'ok' });
});

test('D03 確認只對傳入的那一次結果有效：copyState 不保存任何狀態', () => {
  const { batch, result } = run('Moved C:\\Users\\wang to D:\\backup');
  assert.equal(E.copyState(result, true).allowed, true);
  const again = E.generate(batch);
  assert.equal(E.copyState(again, undefined).allowed, false, '新的結果要重新確認');
  assert.equal(E.copyState(again, 'yes').allowed, false, '只有 true 才算確認');
});

/* ---------- UI02：跳號原因 ---------- */
test('UI02 fixtures/01：原文已有 USER_1，新代號用 USER_2，跳號原因由實際分配算出', () => {
  const text = fixture('01-fake-path-and-tokens.txt');
  const { result } = check(text);
  assert.equal((result.body.match(/USER_2/g) || []).length, 3);
  assert.ok(!result.body.includes('demo_user'));
  deq(result.skipped, [{ type: 'USER', used: ['USER_2'], reserved: ['USER_1'], earlier: [] }]);
});

test('UI02 同一批之前分配過、現在改成保留的編號也會列出來；沒有跳號時是空的', () => {
  const batch = E.createBatch('203.0.113.5 198.51.100.7');
  E.generate(batch);
  batch.candidates[0].selected = false;
  const result = E.generate(batch);
  assert.equal(result.body, '203.0.113.5 IP_2');
  deq(result.skipped, [{ type: 'IP', used: ['IP_2'], reserved: [], earlier: ['IP_1'] }]);
  deq(run('demo@example.invalid').result.skipped, []);
});

/* ---------- UI03：還原摘要用的資料 ---------- */
test('UI03 fixtures/01 + 02：本次代號換回、原文既有的 USER_1 不動、未知的 USER_9 列出來', () => {
  const { result } = check(fixture('01-fake-path-and-tokens.txt'));
  const reply = fixture('02-fake-ai-reply.txt');
  const out = E.restore(reply, result);
  deq(out.restored, [{ token: 'USER_2', count: 1 }]);
  deq(out.reservedSeen, [{ token: 'USER_1', count: 1 }]);
  deq(out.unknown, [{ token: 'USER_9', count: 1 }]);
  assert.ok(out.text.includes('C:\\Users\\demo_user\\Desktop'));
  assert.ok(out.text.includes('USER_1 是程式原本的變數名稱'));
  assert.ok(out.text.includes('C:/Users/USER_9/Desktop'));
});

/* ---------- 開發中審查找到的寫法 ---------- */
const none = (text) => assert.equal(check(text).batch.candidates.length, 0, text);

test('開發中審查：型別標註、中括號、Go 的宣告', () => {
  const cases = [
    ['def connect(password: str = "SYN_A1"):', 'def connect(password: str = "SECRET_1"):'],
    ['let password: &str = "SYN_A1";', 'let password: &str = "SECRET_1";'],
    ['config["password"] = "SYN_A1"', 'config["password"] = "SECRET_1"'],
    ["config['db']['password'] = 'SYN_A1'", "config['db']['password'] = 'SECRET_1'"],
    ['var password string = "SYN_A1"', 'var password string = "SECRET_1"'],
  ];
  for (const [input, expected] of cases) assert.equal(body(input), expected, input);
});

test('開發中審查：讀設定時的預設值、|| 和 ?? 後面的預設值、名稱和值都當成參數的呼叫', () => {
  const cases = [
    ['SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY", "SYN_A1")', 'SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY", "SECRET_1")'],
    ['pw = os.getenv("DB_PASSWORD", "SYN_A1")', 'pw = os.getenv("DB_PASSWORD", "SECRET_1")'],
    ['x = {password: getPw() || "SYN_A1"}', 'x = {password: getPw() || "SECRET_1"}'],
    ['const token = await getToken() ?? "SYN_A1";', 'const token = await getToken() ?? "SECRET_1";'],
    ["define('DB_PASSWORD', 'SYN_A1');", "define('DB_PASSWORD', 'SECRET_1');"],
    ['props.setProperty("password", "SYN_A1");', 'props.setProperty("password", "SECRET_1");'],
    ["localStorage.setItem('token', 'SYN_A1');", "localStorage.setItem('token', 'SECRET_1');"],
    ['res.setHeader("Authorization", "Bearer SYN_A1");', 'res.setHeader("Authorization", "Bearer SECRET_1");'],
  ];
  for (const [input, expected] of cases) assert.equal(body(input), expected, input);
});

test('開發中審查：欄位名稱在字串裡（提示文字、格式化字串、SQL）', () => {
  const cases = [
    ['labels = {"title": "Password:", "token": "SYN_A1"}', 'labels = {"title": "Password:", "token": "SECRET_1"}'],
    ['{"msg": "token=", "token": "SYN_A1"}', '{"msg": "token=", "token": "SECRET_1"}'],
    ['log.info("password=%s", "SYN_A1")', 'log.info("password=%s", "SECRET_1")'],
    ['log("user=%s password=%s token=%s", u, "SYN_A1", "SYN_A2")', 'log("user=%s password=%s token=%s", u, "SECRET_1", "SECRET_2")'],
    ['"password={} token={}".format("SYN_A1", "SYN_A2")', '"password={} token={}".format("SECRET_1", "SECRET_2")'],
    ["db.execute(\"SELECT * FROM users WHERE name = 'demo' AND password = 'SYN_A1'\")", "db.execute(\"SELECT * FROM users WHERE name = 'demo' AND password = 'SECRET_1'\")"],
    ['"{\\"token\\": [\\"SYN_A1\\", \\"SYN_A2\\"]}"', '"{\\"token\\": [\\"SECRET_1\\", \\"SECRET_2\\"]}"'],
    ["curl -d 'password=SYN_A1&user=demo&token=SYN_A2' https://x.invalid", "curl -d 'password=SECRET_1&user=demo&token=SECRET_2' https://x.invalid"],
  ];
  for (const [input, expected] of cases) assert.equal(body(input), expected, input);
  none('print("Enter password:")');
});

test('開發中審查：和寫死的字串比對；型別檢查和變數不算', () => {
  assert.equal(body('if password == "SYN_A1":'), 'if password == "SECRET_1":');
  assert.equal(body("if (token === 'SYN_A1') {"), "if (token === 'SECRET_1') {");
  none('if (typeof token === "string") {}');
  none('if password == PASSWORD:');
  none('if (password !== "") return;');
});

test('開發中審查：命令列和設定檔的寫法', () => {
  const cases = [
    ['DB_PASSWORD==SYN_A1', 'DB_PASSWORD=SECRET_1'],
    ['DB_PASSWORD=>SYN_A1', 'DB_PASSWORD=SECRET_1'],
    ['docker run -e DB_PASSWORD=SYN_A1,SYN_A2 img', 'docker run -e DB_PASSWORD=SECRET_1 img'],
    ['DB_PASSWORD=SYN_A1\\ SYN_A2', 'DB_PASSWORD=SECRET_1'],
    ['DB_PASSWORD={SSHA}SYN_A1', 'DB_PASSWORD=SECRET_1'],
    ['[db]\npassword=SYN_A1 SYN_A2', '[db]\npassword=SECRET_1'],
    ['API_KEYS=SYN_A1,SYN_A2', 'API_KEYS=SECRET_1'],
    ['{"Password ": "SYN_A1"}', '{"Password ": "SECRET_1"}'],
  ];
  for (const [input, expected] of cases) assert.equal(body(input), expected, input);
  assert.equal(body('config.secret_key_base = "SYN_A1"'), 'config.secret_key_base = "SECRET_1"');
  none('const f = async TOKEN=>1');
  none('max_tokens: 100');
});

test('開發中審查：大寫環境變數後面還有文字時，要使用者確認；補上自訂文字後解除', () => {
  const { result } = check('PGPASSWORD=SYN_A1 psql -h db');
  assert.equal(result.body, 'PGPASSWORD=SECRET_1 psql -h db');
  deq(kinds(result.incomplete), ['shell-rest']);
  assert.equal(E.copyState(result, false).reason, 'confirm');
  const fixed = check('DB_PASSWORD=SYN_A1 SYN_A2', [{ text: 'SYN_A2', type: 'WORD' }]);
  assert.equal(fixed.result.body, 'DB_PASSWORD=SECRET_1 WORD_1');
  assert.equal(fixed.result.incomplete.length, 0);
  assert.equal(check('NODE_ENV=production DB_PASSWORD=SYN_A1 node app.js').result.incomplete.length, 0, '命令裡的其他設定不用確認');
});

test('開發中審查：大括號開頭的值和真的物件', () => {
  assert.equal(body('password = {SYN_A1'), 'password = SECRET_1');
  assert.equal(body('password: {SSHA}SYN_A1'), 'password: SECRET_1');
  none('password = {\n  "a": 1\n}');
  none('password = { // c\n  a: 1\n}');
});

test('開發中審查：程式寫法的值不遮，呼叫裡的欄位照常檢查', () => {
  none('const token = getToken(user);');
  none('const token = await jwt.sign({ id: user.id }, KEY);');
  none('#     token = create_token(data["username"])');
  none('const token = tokens[0];');
  assert.equal(body('const token = sign({ secret: "SYN_A1" });'), 'const token = sign({ secret: "SECRET_1" });');
});

test('開發中審查：Authorization 的佔位和分成幾段的寫法', () => {
  assert.equal(body('headers = {"Authorization": "Bearer " + "SYN_A1"}'), 'headers = {"Authorization": "Bearer " + "SECRET_1"}');
  assert.equal(body('Authorization: Bearer {SYN_A1'), 'Authorization: Bearer SECRET_1');
  none('Authorization: Bearer $TOKEN');
  none('Authorization: Bearer <token>');
});

test('開發中審查：三引號跨行後同一行還有欄位、YAML 排版的細節', () => {
  assert.equal(body('password = """\nSYN_A1"""; token = """SYN_A2"""'), 'password = """\nSECRET_1"""; token = """SECRET_2"""');
  assert.equal(body('password:\n    SYN_A1\n  user: x'), 'password:\n    SECRET_1\n  user: x');
  assert.equal(body('password:\n  - - SYN_A1\n    - SYN_A2\n'), 'password:\n  - - SECRET_1\n    - SECRET_2\n');
});

/* ---------- 我補測找到的三類漏遮 ---------- */
test('補測：呼叫的密碼參數換行也要遮；字串沒貼完整時遮第一行並列為要確認', () => {
  const cases = [
    ['pw = os.getenv("DB_PASSWORD",\n    "SYN_A1")', 'pw = os.getenv("DB_PASSWORD",\n    "SECRET_1")'],
    ['props.setProperty("password",\n    "SYN_A1");', 'props.setProperty("password",\n    "SECRET_1");'],
    ["define('DB_PASSWORD',\n  'SYN_A1');", "define('DB_PASSWORD',\n  'SECRET_1');"],
    ['log("password=%s",\n    "SYN_A1")', 'log("password=%s",\n    "SECRET_1")'],
    ['log(\n  "password=%s",\n  # 註解\n  "SYN_A1")', 'log(\n  "password=%s",\n  # 註解\n  "SECRET_1")'],
    ['"password=%s" %\n    ("SYN_A1",)', '"password=%s" %\n    ("SECRET_1",)'],
  ];
  for (const [input, expected] of cases) assert.equal(body(input), expected, input);
  const { result } = check('pw = os.getenv("DB_PASSWORD", "SYN_A1');
  assert.equal(result.body, 'pw = os.getenv("DB_PASSWORD", "SECRET_1');
  deq(kinds(result.incomplete), ['unclosed-quote']);
});

test('補測：YAML 欄位名稱加引號，延續到下一行的值也要遮', () => {
  const cases = [
    ['"password": SYN_A1\n  SYN_B2', '"password": SECRET_1\n  SECRET_2'],
    ["'password': SYN_A1\n  SYN_B2\nuser: x", "'password': SECRET_1\n  SECRET_2\nuser: x"],
    ['"password":\n  SYN_A1\n  SYN_B2', '"password":\n  SECRET_1\n  SECRET_2'],
    ['"password":\n  - SYN_A1\n  - SYN_B2', '"password":\n  - SECRET_1\n  - SECRET_2'],
  ];
  for (const [input, expected] of cases) assert.equal(body(input), expected, input);
  assert.equal(body('{\n  "password": 123456,\n  "user": "x"\n}'), '{\n  "password": SECRET_1,\n  "user": "x"\n}', 'JSON 的下一個欄位不算延續');
});

test('補測：中括號裡有空白也要遮', () => {
  const cases = [
    ['config[ "password" ] = "SYN_A1"', 'config[ "password" ] = "SECRET_1"'],
    ["config[ 'password' ]= 'SYN_A1'", "config[ 'password' ]= 'SECRET_1'"],
    ['$cfg[  "api_key"  ] = "SYN_A1";', '$cfg[  "api_key"  ] = "SECRET_1";'],
  ];
  for (const [input, expected] of cases) assert.equal(body(input), expected, input);
  none('list = [ "password" ]');
});

/* ---------- D04：敏感欄位底下的物件 ---------- */
test('D04 secrets 底下的物件：password 照常遮，db 不遮但列為要確認；補上自訂文字後解除', () => {
  const text = 'secrets:\n  db: SYN_DB\n  password: "SYN_A1"\nuser: demo';
  const { result } = check(text);
  assert.equal(result.body, 'secrets:\n  db: SYN_DB\n  password: "SECRET_1"\nuser: demo');
  deq(kinds(result.incomplete), ['secret-object']);
  assert.ok(result.incomplete[0].message.includes('secrets'));
  assert.ok(result.incomplete[0].risk.includes('db'));
  assert.equal(E.copyState(result, false).reason, 'confirm');
  assert.equal(E.copyState(result, true).allowed, true);
  const fixed = check(text, [{ text: 'SYN_DB', type: 'WORD' }]);
  assert.equal(fixed.result.incomplete.length, 0);
  assert.equal(E.copyState(fixed.result, false).allowed, true);
});

test('D04 JSON、陣列裡的物件、YAML 清單裡的物件也一樣；子欄位全部遮到時不用確認', () => {
  for (const text of [
    '{"credentials": [{"user": "demo", "password": "x1"}]}',
    '{"passwords": {"db": "SYN_A1"}}',
    'const cfg = {\n  credentials: {\n    clientId: "abc",\n    secret: "s9",\n  },\n};',
    'imagePullSecrets:\n  - name: regcred',
    'password:\n  abc: ',
  ]) deq(kinds(check(text).result.incomplete), ['secret-object'], text);
  for (const text of [
    '"tokens": [{"token": "a1"}, {"token": "b2"}]',
    'auth: { user: "me@example.invalid", pass: "pw9" }',
    'jobs:\n  a:\n    secrets:\n      token: ${{ secrets.X }}',
  ]) assert.equal(check(text).result.incomplete.length, 0, text);
});

test('D04 子欄位的密碼改成保留時，還是要確認', () => {
  const batch = E.createBatch('"tokens": [{"token": "a1"}]');
  assert.equal(E.generate(batch).incomplete.length, 0);
  batch.candidates[0].selected = false;
  deq(kinds(E.generate(batch).incomplete), ['secret-object']);
});

// 補充審查R07：敏感物件裡的字串不管內容像什麼，沒遮到就要確認
test('R07 敏感物件裡的中文、符號、"false"、"demo()" 字串沒遮到時也要確認；補上自訂文字後解除', () => {
  const values = ['虛構測試密碼', '!@#$%^&', 'false', 'demo()', 'null', '+'];
  for (const v of values) {
    for (const text of [`{"secrets":{"db":"${v}"}}`, `secrets:\n  db: "${v}"`, `secrets:\n  db: '${v}'`]) {
      const { result } = check(text);
      deq(kinds(result.incomplete), ['secret-object'], text);
      assert.equal(E.copyState(result, false).reason, 'confirm', text);
    }
  }
  // 審查報告的例子：token 遮了，db 的中文還在
  const sample = '{\n  "secrets": {\n    "token": "SYNTHETIC_A9",\n    "db": "虛構測試密碼"\n  }\n}';
  const { result } = check(sample);
  assert.match(result.body, /"token": "SECRET_1"/);
  deq(kinds(result.incomplete), ['secret-object']);
  assert.equal(E.copyState(result, false).allowed, false);
  // YAML 沒引號的中文也算值
  deq(kinds(check('secrets:\n  db: 虛構測試密碼').result.incomplete), ['secret-object']);
  // 補上自訂文字就不用確認
  const fixed = check(sample, [{ type: 'WORD', text: '虛構測試密碼' }]).result;
  assert.equal(fixed.incomplete.length, 0);
  assert.equal(E.copyState(fixed, false).allowed, true);
  // 沒引號的程式寫法還是不算值：運算子、布林值、函式呼叫、YAML 多行標記
  for (const text of ['secrets:\n  enabled: false\n  token: SYNTHETIC_A9', 'secrets:\n  db: get_db()\n  token: SYNTHETIC_A9']) {
    assert.equal(check(text).result.incomplete.length, 0, text);
  }
});

// 補充審查R08：超過行數上限的物件，不能只看前面就當成全部處理好
test('R08 敏感物件超過200行：後面沒檢查到，一定要確認；200行內全部遮到時不用確認', () => {
  const yaml = 'secrets:\n' + Array.from({ length: 205 }, (_, i) => `  item_${i}_token: "SYNTHETIC_${i}"`).join('\n') + '\n  db: "SYNTHETIC_TAIL"';
  const json = '{\n  "secrets": {\n' + Array.from({ length: 205 }, (_, i) => `    "item_${i}_token": "SYNTHETIC_${i}",`).join('\n') + '\n    "db": "SYNTHETIC_TAIL"\n  }\n}';
  for (const text of [yaml, json]) {
    const { result } = check(text);
    deq(kinds(result.incomplete), ['secret-object']);
    assert.match(result.incomplete[0].message, /超過200行/);
    assert.equal(E.copyState(result, false).reason, 'confirm');
    assert.equal(E.copyState(result, true).allowed, true);
  }
  // 範圍內全部遮到：照常不用確認
  const short = 'secrets:\n' + Array.from({ length: 150 }, (_, i) => `  item_${i}_token: "SYNTHETIC_${i}"`).join('\n');
  assert.equal(check(short).result.incomplete.length, 0);
});

test('R08 欄位和值中間隔了超過200行的空行或註解：列為要確認；值真的是空的就不用', () => {
  const comments = Array.from({ length: 201 }, () => '  # 虛構註解').join('\n');
  for (const text of [`secrets:\n${comments}\n  db: SYNTHETIC_A9`, `password:\n${comments}\n  SYNTHETIC_A9`]) {
    const { result } = check(text);
    deq(kinds(result.incomplete), ['value-too-far'], text.slice(0, 10));
    assert.equal(E.copyState(result, false).reason, 'confirm');
  }
  // 下一個有內容的行沒有比欄位深：欄位本身就是空的
  assert.equal(check(`password:\n${comments}\nuser: demo`).result.incomplete.length, 0);
  // 200行以內照常往下找
  const near = Array.from({ length: 150 }, () => '  # 虛構註解').join('\n');
  assert.match(body(`password:\n${near}\n  SYNTHETIC_A9`), /SECRET_1/);
});

// 上傳前驗收R09：JSON換行但沒有縮排時，大括號物件也要照括號配對判斷範圍
test('R09 JSON換行沒縮排的secrets物件：沒遮的值要確認；單行、正常縮排照舊；補上自訂文字後解除', () => {
  const short = '{"secrets":{\n"password":"SYNTHETIC_COVERED",\n"db":"SYNTHETIC_UNCHECKED"}}';
  const { result } = check(short);
  assert.match(result.body, /"password":"SECRET_1"/);
  assert.ok(result.body.includes('"db":"SYNTHETIC_UNCHECKED"'));
  deq(kinds(result.incomplete), ['secret-object']);
  assert.equal(E.copyState(result, false).reason, 'confirm');
  assert.equal(E.copyState(result, true).allowed, true);
  assert.equal(result.checks.json.ok, true);
  // 對照組：單行、正常縮排
  for (const text of ['{"secrets":{"password":"SYNTHETIC_COVERED","db":"SYNTHETIC_UNCHECKED"}}',
    '{\n  "secrets": {\n    "password": "SYNTHETIC_COVERED",\n    "db": "SYNTHETIC_UNCHECKED"\n  }\n}']) {
    deq(kinds(check(text).result.incomplete), ['secret-object'], text);
  }
  // 其他沒縮排的寫法：CRLF、巢狀、陣列裡的物件、JavaScript物件、Python dict
  for (const text of ['{"secrets":{\r\n"password":"P1",\r\n"db":"D1"}}', '{"a":{"secrets":{\n"db":"X1"}}}',
    '{"tokens":[{\n"user":"U1",\n"token":"T1"}]}', 'const cfg = {secrets: {\npassword: "A1",\ndb: "B2"}};', 'SECRETS = {\n"db": "D1",\n}']) {
    deq(kinds(check(text).result.incomplete), ['secret-object'], JSON.stringify(text));
  }
  // 子欄位全部遮到：不用確認；補上自訂文字：解除
  assert.equal(check('{"secrets":{\n"password":"A1",\n"token":"B2"}}').result.incomplete.length, 0);
  const fixed = check(short, [{ type: 'WORD', text: 'SYNTHETIC_UNCHECKED' }]).result;
  assert.equal(fixed.incomplete.length, 0);
  assert.equal(E.copyState(fixed, false).allowed, true);
});

test('R09 沒縮排的長物件：超過200行或找不到結尾時一定要確認，不能用自訂文字解除', () => {
  const blanks = '{"secrets":{\n' + '\n'.repeat(205) + '"password":"SYNTHETIC_COVERED",\n"db":"SYNTHETIC_UNCHECKED"}}';
  const long = '{"secrets":{\n' + Array.from({ length: 205 }, (_, i) => `"t${i}_token":"S${i}",`).join('\n') + '\n"db":"SYNTHETIC_UNCHECKED"}}';
  const unclosed = '{"secrets":{\n"password":"P1",\n"db":"D1"';
  for (const text of [blanks, long, unclosed]) {
    const { result } = check(text);
    deq(kinds(result.incomplete), ['secret-object']);
    assert.match(result.incomplete[0].message, /超過200行或找不到結尾/);
    assert.equal(E.copyState(result, false).reason, 'confirm');
  }
  assert.equal(check(long, [{ type: 'WORD', text: 'SYNTHETIC_UNCHECKED' }]).result.incomplete.length, 1);
  // 正常縮排的長物件照舊（A47）
  const indented = '{\n  "secrets": {\n' + Array.from({ length: 205 }, (_, i) => `    "t${i}_token": "S${i}",`).join('\n') + '\n    "db": "SYNTHETIC_UNCHECKED"\n  }\n}';
  deq(kinds(check(indented).result.incomplete), ['secret-object']);
});

/* ---------- 隨機測試 ---------- */
// 固定種子（mulberry32），每次跑的內容都一樣，失敗時可以重現
function makeRandom(seed) {
  return (n) => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
}
// 虛構密碼：SYNSEC＋編號＋x，中間隨機夾 0～4 個特殊字元，結尾固定是 q。
// 特殊字元依寫法挑選這種寫法本來就允許的字元（例如雙引號裡不放 " 和 \，命令列不放空白和引號）。
const CHARSET = {
  dq: " !#$%&'()*+,-./:;<=>?@[]^_{|}~", // 雙引號字串裡
  sq: ' !"#$%&()*+,-./:;<=>?@[]^_{|}~', // 單引號字串裡
  sqInDq: ' !#$%&()*+,-./:;<=>?@[]^_{|}~', // 雙引號字串裡的單引號（SQL）
  bt: ' !"#%&\'()*+,-./:;<=>?@[]^_|~', // 反引號字串裡（不放 ` \ $ { }）
  yaml: '!$%&()*+,-./;<=>?@[]^_{|}~', // YAML 沒引號的值：不放空白、冒號、#、引號
  shell: '!%*+,-./:=?@[]^_{}~', // 命令列和 .env 沒引號的值
  rest: '!%*+,-./:?@[]^_{}~', // 命令列空白後面的部分（不放 =，那會被當成下一個變數設定）
  token: '-._~+/', // Bearer 權杖
  uri: '-._~', // 連線字串裡的密碼（沒編碼的特殊字元在 v1.0 的測試裡）
};
let rand = makeRandom(1);
let secretId = 0;
let values = []; // 這一組產生的虛構密碼
const v = (set) => {
  let middle = '';
  const chars = CHARSET[set] || '';
  if (chars) for (let k = rand(5); k > 0; k--) middle += chars[rand(chars.length)];
  // 「空白＋#」和「冒號＋空白」在 YAML 裡是註解和欄位。隨機組合時，縮排的下一段可能被前一段 YAML 的值接下去，
  // 這兩種組合會讓那一行照 YAML 的規則斷開，不是這裡要測的情況，所以拿掉中間的空白。
  // 連續的引號也拿掉：前面沒關上的三引號會在這裡結束（Python 也是這樣讀），同樣不是這裡要測的情況
  while (/ #|: |""|''/.test(middle)) middle = middle.replace(' #', '#').replace(': ', ':').replace('""', '"').replace("''", "'");
  const value = `SYNSEC${++secretId}x${middle}q`;
  values.push(value);
  return value;
};
// 支援的寫法：裡面的虛構密碼一定要整段遮住
const SUPPORTED = [
  () => `password = "${v('dq')}"`, () => `password = '${v('sq')}'`, () => `password = """${v('dq')}"""`, () => `token = '''${v('sq')}'''`,
  () => `secret = \`${v('bt')}\``, () => `password: ${v('yaml')}`, () => `password: ${v('yaml')},;`, () => `password: '${v('sq')}''${v('sq')}'`,
  () => `password: |\n  ${v('dq')}\n  ${v('dq')},;`, () => `password: >-\n    ${v('dq')}\n    ${v('dq')}`, () => `password:\n  ${v('yaml')}`,
  () => `password:\n  "${v('dq')}"`, () => `password:\n  - ${v('yaml')}\n  - "${v('dq')}"`, () => `{"password":\n "${v('dq')}"}`,
  () => `{"password": "${v('dq')}", "user": "demo"}`, () => `"token": ["${v('dq')}", "${v('dq')}"]`, () => `"token": [\n  "${v('dq')}",\n  "${v('dq')}"\n]`,
  () => `PASSWORD=${v('shell')}`, () => `export DB_PASSWORD=${v('shell')}`, () => `password = """${v('dq')}\n    ${v('dq')}\n${v('dq')}"""`,
  () => `API_TOKEN = (\n    "${v('dq')}"\n    "${v('dq')}"\n)`, () => `const token =\n  "${v('dq')}" +\n  "${v('dq')}";`,
  () => `"{\\"password\\": \\"${v('dq')}\\"}"`, () => `Authorization: Bearer ${v('token')}`, () => `"Authorization": "Bearer ${v('token')}"`,
  () => `DATABASE_URL=postgres://demo:${v('uri')}@db.example.invalid:5432/app`, () => `password: ${v('yaml')}\n  ${v('yaml')}`,
  () => `password = "${v('dq')}" + "${v('dq')}"`, () => `password = ("${v('dq')}", "${v('dq')}")`, () => `- password: ${v('yaml')}`,
  // 開發中審查之後加的寫法
  () => `if password == "${v('dq')}":`, () => `cursor.execute("SELECT * FROM users WHERE password = '${v('sqInDq')}'")`,
  () => `log("user=%s password=%s", user, "${v('dq')}")`, () => `{"Password ": "${v('dq')}"}`, () => `password = {SSHA}${v('yaml')}`,
  () => `password: str = "${v('dq')}"`, () => `config["password"] = "${v('dq')}"`, () => `pw = os.getenv("DB_PASSWORD", "${v('dq')}")`,
  () => `const token = process.env.TOKEN || "${v('dq')}";`, () => `var password string = "${v('dq')}"`,
  () => `password = (\n    "${v('dq')}"  # part 1\n    "${v('dq')}"\n)`, () => `headers = {"Authorization": "Bearer " + "${v('token')}"}`,
  () => `docker run -e DB_PASSWORD=${v('shell')} img`, () => `DB_PASSWORD==${v('shell')}`,
  // 我補測找到的三類漏遮
  () => `pw = os.getenv("DB_PASSWORD",\n    "${v('dq')}")`, () => `log("password=%s",\n    "${v('dq')}")`,
  () => `"password": ${v('yaml')}\n  ${v('yaml')}`, () => `config[ "password" ] = "${v('dq')}"`,
];
// 沒辦法完整遮的寫法：有值沒遮完時，一定要列在 incomplete（要使用者確認）
const MUST_FLAG = [
  () => `password = """${v('dq')}\n${v('dq')}`, () => `copy C:\\Users\\${v()} and more`, () => `token = "${v('dq')}\n${v('dq')}"`,
  () => `DB_PASSWORD=${v('shell')} ${v('rest')}`, () => `secrets:\n  db: ${v('yaml')}`,
  () => `{"secrets": {"note": "說明 ${v('dq')}"}}`,
  () => `{"secrets":{\n"password":"${v('dq')}",\n"db":"${v('dq')}"}}`,
];
const NOISE = ['x = 1', '', '# 註解', '  indented: text', 'def f():', '    return None', '}', 'print("ok")', 'user: demo', '  - item'];

// 每一個虛構密碼都要整段落在某個代號換掉的原文裡
const unmasked = (result, list) => {
  const raws = [...result.activeMap.values()];
  return list.filter((value) => !raws.some((raw) => raw.includes(value)));
};

function fuzz(templates, n, seed, onResult) {
  rand = makeRandom(seed);
  const used = new Array(templates.length).fill(0);
  for (let i = 0; i < n; i++) {
    values = [];
    const lines = [];
    const count = 2 + rand(6);
    for (let k = 0; k < count; k++) {
      if (rand(3) === 0) lines.push(NOISE[rand(NOISE.length)]);
      const pick = rand(templates.length);
      used[pick]++;
      const indent = ['', '', '', '  ', '    ', '\t'][rand(6)]; // 有時整段縮排，模擬放在別的欄位底下
      lines.push(templates[pick]().split('\n').map((line) => indent + line).join('\n'));
    }
    const text = lines.join(rand(4) === 0 ? '\r\n' : '\n');
    const { result } = run(text);
    assert.equal(E.restore(result.body, result).text, text, text);
    assert.equal(result.checks.structure, true, text);
    onResult(text, result, unmasked(result, values));
  }
  assert.ok(used.every((x) => x > 0), '每一種寫法都要被抽到');
  return Math.min(...used);
}

const FUZZ_N = Number(process.env.FUZZ_N) || 5000;
const FUZZ_SEED = Number(process.env.FUZZ_SEED) || 20261010;

test('隨機組合（只有支援的寫法）：虛構密碼全部整段遮住，而且都能逐字還原', () => {
  let cautious = 0;
  const least = fuzz(SUPPORTED, FUZZ_N, FUZZ_SEED, (text, result, left) => {
    deq(left, [], `沒有整段遮到：\n${text}\n---\n${result.body}`);
    if (result.incomplete.length) cautious++;
  });
  console.log(`  隨機測試A：${FUZZ_N}組，${SUPPORTED.length}種支援的寫法（每種至少${least}次），每個虛構密碼都整段遮住；其中${cautious}組多列了「未完整處理」`);
});

test('隨機組合（混入沒辦法完整遮的寫法）：只要有虛構密碼沒遮完，一定列在 incomplete', () => {
  let flagged = 0;
  const templates = [...SUPPORTED, ...MUST_FLAG];
  const least = fuzz(templates, FUZZ_N, FUZZ_SEED + 1, (text, result, left) => {
    if (left.length) {
      assert.ok(result.incomplete.length > 0, `沒遮完也沒有列為未完整處理：\n${text}\n---\n${result.body}`);
      flagged++;
    }
  });
  console.log(`  隨機測試B：${FUZZ_N}組，${templates.length}種寫法（每種至少${least}次），${flagged}組有值沒遮完，全部都列為未完整處理`);
});

/* ---------- 效能：新加的寫法也不能被特殊輸入拖慢 ---------- */
test('效能：新寫法的退化輸入都在2秒內', () => {
  const inputs = [
    'password:\n'.repeat(10000), '"password":\n'.repeat(8000), 'password = """\n'.repeat(6000), 'password = """' + 'x'.repeat(99000),
    'password = `\n'.repeat(7000), "password: 'a''".repeat(7000), 'pwd=[{'.repeat(16000), 'pwd=["a", {'.repeat(9000),
    'password: ' + '['.repeat(99000), 'password: [' + '{'.repeat(99000), 'password:\n  - a\n'.repeat(5000), 'password:\n' + '  x\n'.repeat(30000),
    'password: a\n' + '  x\n'.repeat(30000), 'secrets:\n' + '  # c\n'.repeat(20000) + '  db: x', 'secrets:\n' + '  a: "b"\n'.repeat(14000),
    'password:\n' + '\n'.repeat(99000) + '  x', '"secrets":{\n'.repeat(9000), '{"secrets":{\n"a":"b",\n'.repeat(4000),
    '"tokens":[{\n"u":"x",\n'.repeat(4000), 'pwd = (\n'.repeat(12000), 'pwd = ("a", '.repeat(8000), 'token = "a" + \n'.repeat(6000),
    'x = "{\\"password\\": \\"'.repeat(4000), 'password: #\n'.repeat(8000), 'print("password:" '.repeat(5000), 'password: [\n'.repeat(8000),
    'token: [a\n'.repeat(9000), '"a" "a" '.repeat(12000), ('password: |\n' + '  x\n'.repeat(200)).repeat(100),
    // 開發中審查之後加的寫法
    'token: f('.repeat(11000), 'token=f('.repeat(12400), 'x = ' + 'token: f('.repeat(5000) + ')'.repeat(5000),
    '{"password ": '.repeat(7000), 'password = {abc '.repeat(6000), 'password = {'.repeat(8000), 'const token = await x('.repeat(4500),
    '"' + "password = 'a' ".repeat(6000), 'password = {\\"a'.repeat(6000), 'typeof token === "string" '.repeat(3500),
    'log("' + 'password=%s '.repeat(4000) + '", ' + '"a", '.repeat(4000) + ')', 'password = """\na\n"""; token = "b"\n'.repeat(3000),
    // 補測和D04之後加的寫法
    'get("password",\n'.repeat(6000), 'log("password=%s",\n'.repeat(5000), 'x[ "password" ] = '.repeat(5000),
    '"password": a\n  b\n'.repeat(6000), 'password:\n  a: b\n'.repeat(5500), '{"secrets": {'.repeat(7000),
    'password:\n  - a: b\n'.repeat(5000),
  ];
  let slowest = { ms: 0, text: '' };
  for (const text of inputs) {
    const t0 = performance.now();
    try {
      E.generate(E.createBatch(text.slice(0, 100000)));
    } catch (error) {
      if (!(error instanceof E.InputError)) throw error; // 數量太多被拒絕也算正常
    }
    const ms = performance.now() - t0;
    assert.ok(ms < 2000, `${JSON.stringify(text.slice(0, 16))}… 花了 ${ms.toFixed(0)} ms`);
    if (ms > slowest.ms) slowest = { ms, text };
  }
  console.log(`  退化輸入：${inputs.length}種，最慢的是 ${JSON.stringify(slowest.text.slice(0, 16))}…，${slowest.ms.toFixed(1)} ms`);
});

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok ? '' : ' — ' + r.error}`);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exitCode = failed.length ? 1 : 0;
