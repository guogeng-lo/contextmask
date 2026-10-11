// 直接修改 index.html 裡的 <script> 或 <style> 之後，用這個重新計算 CSP 的 SHA-256 雜湊。
// 用法：node tools/update-csp.cjs index.html
//
// 沒有重新計算的話：
//   <script> 的雜湊對不上 → 瀏覽器擋掉整段程式，畫面會停在「網頁程式沒有啟動」。
//   <style> 的雜湊對不上 → 只有樣式被擋，功能還在，但排版會跑掉。
// 只改 <script>、<style> 以外的 HTML 文字，不影響雜湊。
const fs = require('node:fs');
const { createHash } = require('node:crypto');

const file = process.argv[2] || 'index.html';
let html = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'); // 統一成 LF，雜湊才會一致
const style = html.match(/<style>([\s\S]*?)<\/style>/);
const script = html.match(/<script>([\s\S]*?)<\/script>/);
if (!style || !script) {
  console.error('找不到 <style> 或 <script>。');
  process.exit(1);
}
const hash = (text) => 'sha256-' + createHash('sha256').update(text, 'utf8').digest('base64');
html = html
  .replace(/script-src 'sha256-[^']+'/, `script-src '${hash(script[1])}'`)
  .replace(/style-src 'sha256-[^']+'/, `style-src '${hash(style[1])}'`);
fs.writeFileSync(file, html, 'utf8');
console.log('已更新 CSP 雜湊：', file);
