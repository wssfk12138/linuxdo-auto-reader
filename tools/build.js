// 把 src/auto-read.user.js 打成 dist/auto-read.user.js。
// 用户脚本不需要编译，这里做的是三件事：校验版本号、语法检查、复制产物。
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const srcPath = path.join(root, "src", "auto-read.user.js");
const distDir = path.join(root, "dist");
const distPath = path.join(distDir, "auto-read.user.js");

const content = fs.readFileSync(srcPath, "utf8");

function headerField(name) {
  const m = content.match(new RegExp("^//\\s*@" + name + "\\s+(.+?)\\s*$", "m"));
  return m ? m[1].trim() : null;
}

const version = headerField("version");
const name = headerField("name");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

const problems = [];
if (!version) problems.push("src/auto-read.user.js 里没有 @version");
if (!name) problems.push("src/auto-read.user.js 里没有 @name");
if (version && pkg.version !== version) {
  problems.push("版本不一致：package.json 是 " + pkg.version + "，脚本是 " + version);
}
if (!/^\/\/ ==UserScript==/.test(content)) problems.push("缺少 ==UserScript== 头部");
if (problems.length) {
  problems.forEach((p) => console.error("构建失败：" + p));
  process.exit(1);
}

// 语法检查：解析不过就直接失败，别把坏产物发出去
try {
  new vm.Script(content, { filename: srcPath });
} catch (e) {
  console.error("构建失败：语法错误 " + e.message);
  process.exit(1);
}

fs.mkdirSync(distDir, { recursive: true });
fs.writeFileSync(distPath, content, "utf8");

const bytes = Buffer.byteLength(content);
console.log("构建完成：" + name + " @" + version + " -> dist/auto-read.user.js（" + bytes + " 字节）");

