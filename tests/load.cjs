// 從 index.html 取出真正的程式，在 Node 裡執行核心（畫面部分會因為沒有 document 而跳過）
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
module.exports = function load(file = path.join(__dirname, '..', 'index.html')) {
  const html = fs.readFileSync(file, 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const context = vm.createContext({ atob, console: undefined });
  vm.runInContext(script + '\nglobalThis.__engine = ContextMask;', context);
  return { engine: context.__engine, html, script };
};
