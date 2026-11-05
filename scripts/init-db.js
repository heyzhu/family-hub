'use strict';
/**
 * 初始化数据库：创建 data 目录与 family.db，并建好全部表。
 *
 *   npm run init-db     或     node scripts/init-db.js
 *
 * 说明：服务启动时本来就会自动建表，这个脚本用于「先建好再启动」
 * 或部署前检查数据库是否可用。
 */
const fs = require('node:fs');
const config = require('../src/config');
const { db } = require('../src/db');

const TABLES = ['users', 'sessions', 'todos', 'posts', 'comments', 'records'];

console.log('');
// 站名用运行时的 config.siteName（db.js 已在 require 时把库里的自定义名称套上来了）
console.log(`${config.siteName} · 数据库初始化`);
console.log('─'.repeat(52));
console.log(`  引擎      ${db.kind}`);
console.log(`  文件      ${db.file}`);

const rows = db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
const names = rows.map((r) => r.name);
let missing = 0;
for (const t of TABLES) {
  const exists = names.includes(t);
  if (!exists) missing++;
  const count = exists ? db.get(`SELECT COUNT(*) AS n FROM ${t}`).n : 0;
  console.log(`  ${exists ? '✔' : '✘'} ${t.padEnd(16)} ${exists ? `${count} 行` : '缺失'}`);
}
console.log(`  图片目录  ${config.uploadDir}${fs.existsSync(config.uploadDir) ? '' : '（将在首次上传时创建）'}`);
console.log('─'.repeat(52));
console.log(missing ? `  ✘ 有 ${missing} 张表缺失，请检查 src/schema.sql` : '  ✔ 数据库就绪');
console.log('');

db.close();
process.exit(missing ? 1 : 0);
