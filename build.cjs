// 把 src/ 裡的 HTML、CSS、JavaScript 組成專案根目錄的單一 index.html，並計算 CSP 需要的 SHA-256 雜湊。
// 只在開發時使用；網頁本身不需要這個檔案。
// 用法：node build.cjs
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const dir = __dirname;
const read = (name) => fs.readFileSync(path.join(dir, 'src', name), 'utf8').replace(/\r\n/g, '\n');
const css = read('style.css');
const js = read('app.js');
const body = read('body.html');

const styleText = '\n' + css;
const scriptText = '\n' + js;
const hash = (text) => 'sha256-' + createHash('sha256').update(text, 'utf8').digest('base64');

const csp = [
  "default-src 'none'",
  `script-src '${hash(scriptText)}'`,
  `style-src '${hash(styleText)}'`,
  "connect-src 'none'",
  "img-src 'none'",
  "font-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "require-trusted-types-for 'script'",
  "trusted-types 'none'",
].join('; ');

const html = `<!doctype html>
<html lang="zh-Hant" translate="no" class="notranslate">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="google" content="notranslate">
<meta name="referrer" content="no-referrer">
<meta name="description" content="貼給AI除錯前，把程式碼、設定檔和錯誤訊息裡的隱私換成代號；AI回覆後再換回來。全部在瀏覽器裡處理。">
<title>ContextMask｜貼給AI前先遮住隱私</title>
<style>${styleText}</style>
</head>
<body>
${body}<script>${scriptText}</script>
</body>
</html>
`;

fs.writeFileSync(path.join(dir, 'index.html'), html, 'utf8');
console.log(`index.html：${Buffer.byteLength(html)} bytes`);
console.log(csp);
