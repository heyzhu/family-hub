'use strict';
/**
 * 冷备份：把数据库导出一份完整、一致的单个 .db 文件。
 *
 *   npm run backup     或     node scripts/backup.js [输出目录]
 *
 * 用的是 SQLite 的 VACUUM INTO，会自动包含 WAL 里尚未落盘的数据，
 * 因此不需要停服务，直接拷走产物即可，恢复时覆盖回 DB_PATH 即可。
 *
 * 备份目录默认 data/backups/，自动保留最近 30 份。
 */
const fs = require('node:fs');
const path = require('node:path');
const config = require('../src/config');
const { db } = require('../src/db');

const KEEP = 30;
const outDir = path.resolve(process.argv[2] || path.join(path.dirname(config.dbPath), 'backups'));

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const target = path.join(outDir, `family-hub-${stamp}.db`);

db.snapshotTo(target);
const size = fs.statSync(target).size;

// 只保留最近 KEEP 份
let removed = 0;
const files = fs.readdirSync(outDir)
  .filter((f) => /^family-hub-.*\.db$/.test(f))
  .map((f) => ({ f, t: fs.statSync(path.join(outDir, f)).mtimeMs }))
  .sort((a, b) => b.t - a.t);
for (const item of files.slice(KEEP)) {
  fs.rmSync(path.join(outDir, item.f), { force: true });
  removed++;
}

const stats = {
  users: db.get('SELECT COUNT(*) AS n FROM users').n,
  todos: db.get('SELECT COUNT(*) AS n FROM todos').n,
  posts: db.get('SELECT COUNT(*) AS n FROM posts').n,
  comments: db.get('SELECT COUNT(*) AS n FROM comments').n,
  records: db.get('SELECT COUNT(*) AS n FROM records').n,
};

console.log('');
// 站名用运行时的 config.siteName（管理员改过名后，备份输出也跟着变）
console.log(`${config.siteName} · 数据库冷备份完成`);
console.log('─'.repeat(52));
console.log(`  备份文件  ${target}`);
console.log(`  文件大小  ${(size / 1024).toFixed(1)} KB`);
console.log(`  数据快照  成员 ${stats.users} · 待办 ${stats.todos} · 动态 ${stats.posts} · 评论 ${stats.comments} · 记录 ${stats.records}`);
if (removed) console.log(`  已清理    ${removed} 份过期备份（保留最近 ${KEEP} 份）`);
console.log('─'.repeat(52));
console.log('  恢复方式：停止服务 → 用该文件覆盖 DB_PATH 指向的文件 → 重启');
console.log('  注意：图片在 data/uploads/ 目录，迁移时请一并拷贝');
console.log('');

db.close();
