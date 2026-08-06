/**
 * migrate-to-cloud.js —— 把本地 data/*.json 的真实业务数据迁移到 CloudBase 云数据库。
 *
 * 用途：
 *   历史版本在云托管容器里误用了容器内临时 JSON 文件存储，每次「更新服务」重建容器都会清空数据。
 *   本脚本用于把仍保存在本地 data/*.json（或备份目录）里的订单、账号、suggestions 抢救进云端文档数据库。
 *
 * 运行方式（必须在能连上 CloudBase 的环境执行）：
 *
 *   方式一：在 CloudBase 云托管容器 / 云函数内（推荐，无需密钥，走内置服务身份）
 *       node migrate-to-cloud.js
 *
 *   方式二：在本机/CI 运行，需提供环境 ID 与 API 密钥
 *       set TCB_ENV_ID=your-env-id                （Windows CMD；PowerShell 用 $env:TCB_ENV_ID="...")
 *       set TENCENTCLOUD_SECRETID=your-secret-id
 *       set TENCENTCLOUD_SECRETKEY=your-secret-key
 *       node migrate-to-cloud.js
 *
 *   可选参数：
 *       --data-dir <path>   指定数据源目录，默认 ./data
 *                           例：node migrate-to-cloud.js --data-dir data-backup-20260806-180046
 *       --dry-run           只打印将要迁移的内容，不写云端
 *
 * 幂等性：
 *   users / orders 以本地 id 字段为匹配键做 upsert（云端已存在则 update，不存在则 add），
 *   重复执行不会产生重复记录。suggestions 为单文档，按计数取「本地与云端的较大值」合并，重复执行结果稳定。
 *
 * 注意：本脚本刻意不 require('./server.js')，因为 server.js 会启动 HTTP 监听。
 *       云端检测与 tcb.init 逻辑与 server.js 保持一致，此处为有意的独立实现。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DATA_COLLECTIONS = ['users', 'orders', 'suggestions'];
const ARRAY_COLLECTIONS = ['users', 'orders'];

/**
 * 解析命令行参数。
 * @returns {{dataDir: string, dryRun: boolean}}
 */
function parseArgs() {
  const argv = process.argv.slice(2);
  let dataDir = path.join(__dirname, 'data');
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--data-dir' && argv[i + 1]) {
      dataDir = path.isAbsolute(argv[i + 1]) ? argv[i + 1] : path.join(__dirname, argv[i + 1]);
      i++;
    } else if (argv[i] === '--dry-run') {
      dryRun = true;
    }
  }
  return { dataDir, dryRun };
}

/**
 * 检测是否运行在腾讯云 CloudBase 云托管 / 云函数容器内（与 server.js 保持一致）。
 * @returns {boolean}
 */
function detectCloudRuntime() {
  if (process.env.FORCE_CLOUD_DB === '1') return true;
  return process.env.TENCENTCLOUD_RUNENV === 'SCF' ||
    Boolean(process.env.TCB_ENV) ||
    Boolean(process.env.TCB_ENV_ID) ||
    Boolean(process.env.KUBERNETES_SERVICE_HOST);
}

/**
 * 解析 CloudBase 环境 ID（与 server.js 保持一致）。
 * @returns {string}
 */
function resolveCloudEnvId() {
  return process.env.TCB_ENV_ID || process.env.TCB_ENV || '';
}

/**
 * 判断错误是否为「集合不存在」。
 * @param {Error & {code?: string, errCode?: string|number}} err
 * @returns {boolean}
 */
function isCollectionMissingError(err) {
  const code = String((err && (err.code || err.errCode)) || '');
  const msg = String((err && err.message) || '');
  return code.indexOf('DATABASE_COLLECTION_NOT_EXIST') >= 0 ||
    code === '-502005' ||
    /collection\s+not\s+exist/i.test(msg) ||
    msg.indexOf('集合不存在') >= 0;
}

/**
 * 判断错误是否为「集合已存在」。
 * @param {Error & {code?: string, errCode?: string|number}} err
 * @returns {boolean}
 */
function isCollectionExistsError(err) {
  const code = String((err && (err.code || err.errCode)) || '');
  const msg = String((err && err.message) || '');
  return code.indexOf('ALREADY_EXIST') >= 0 || /already\s+exist/i.test(msg) || msg.indexOf('已存在') >= 0;
}

/**
 * 确保集合存在且可读，缺失时自动创建。
 * @param {object} db CloudBase database 实例
 * @param {string} name 集合名
 * @returns {Promise<void>}
 */
async function ensureCollection(db, name) {
  try {
    await db.collection(name).limit(1).get();
    return;
  } catch (e) {
    if (!isCollectionMissingError(e)) throw e;
  }
  if (typeof db.createCollection !== 'function') {
    const err = new Error('集合 ' + name + ' 不存在，且当前 SDK 不支持自动创建，请先在 CloudBase 控制台手动创建该集合。');
    err.isUsageError = true;
    throw err;
  }
  try {
    await db.createCollection(name);
    console.log('  已自动创建集合: ' + name);
  } catch (e) {
    if (!isCollectionExistsError(e)) throw e;
  }
}

/**
 * 连接 CloudBase 数据库（含连通性验证）。
 * @returns {Promise<object>} CloudBase database 实例
 */
async function connectCloudBase() {
  const inCloud = detectCloudRuntime();
  const envId = resolveCloudEnvId();
  const secretId = process.env.TENCENTCLOUD_SECRETID || '';
  const secretKey = process.env.TENCENTCLOUD_SECRETKEY || '';

  if (!inCloud && !(envId && secretId && secretKey)) {
    const err = new Error(
      '当前不在 CloudBase 云端环境，且未提供 TCB_ENV_ID + TENCENTCLOUD_SECRETID + TENCENTCLOUD_SECRETKEY，无法连接云数据库。\n' +
      '请在云托管容器内执行 node migrate-to-cloud.js，或先设置上述环境变量。'
    );
    err.isUsageError = true; // 属于使用方式提示，无需打印调用栈
    throw err;
  }

  const tcb = require('@cloudbase/node-sdk');
  const initOptions = {};
  if (envId) initOptions.env = envId;
  if (secretId && secretKey) { initOptions.secretId = secretId; initOptions.secretKey = secretKey; }

  const tcbApp = tcb.init(initOptions);
  const db = tcbApp.database();
  for (const name of DATA_COLLECTIONS) {
    await ensureCollection(db, name);
  }
  console.log('已连接 CloudBase 数据库' + (envId ? ' (env=' + envId + ')' : ' (使用容器内置服务身份)'));
  return db;
}

/**
 * 读取本地 JSON 数据文件。
 * @param {string} dataDir 数据目录
 * @param {string} name 集合名
 * @returns {Array<object>|object|null} 文件不存在或解析失败时返回 null
 */
function readLocalJson(dataDir, name) {
  const filePath = path.join(dataDir, name + '.json');
  if (!fs.existsSync(filePath)) {
    console.log('  跳过：文件不存在 ' + filePath);
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (e) {
    console.error('  解析失败 ' + filePath + ': ' + e.message);
    return null;
  }
}

/**
 * 按业务 id upsert 一批记录到云端集合。
 * @param {object} db CloudBase database 实例
 * @param {string} name 集合名
 * @param {Array<object>} items 本地记录数组
 * @param {boolean} dryRun 为 true 时只打印不写入
 * @returns {Promise<{added: number, updated: number, skipped: number, failed: number}>}
 */
async function upsertById(db, name, items, dryRun) {
  const result = { added: 0, updated: 0, skipped: 0, failed: 0 };
  for (const item of items) {
    const localId = item.id || item._id;
    if (!localId) {
      console.error('  跳过无 id 记录: ' + JSON.stringify(item).slice(0, 120));
      result.skipped++;
      continue;
    }
    const payload = { ...item, id: localId };
    delete payload._id;

    try {
      const existing = await db.collection(name).where({ id: localId }).limit(1).get();
      const found = existing && existing.data && existing.data[0];
      if (found) {
        if (dryRun) { console.log('  [dry-run] update ' + name + '/' + localId); }
        else { await db.collection(name).doc(found._id).update(payload); }
        result.updated++;
      } else {
        if (dryRun) { console.log('  [dry-run] add ' + name + '/' + localId); }
        else { await addWithId(db, name, localId, payload); }
        result.added++;
      }
    } catch (e) {
      console.error('  迁移失败 ' + name + '/' + localId + ': ' + e.message);
      result.failed++;
    }
  }
  return result;
}

/**
 * 新增文档，优先用业务 id 作为云端 _id（与 server.js 的 toCloudDoc 保持一致）；
 * 若环境不允许自定义 _id，则退化为由云端生成主键。
 * @param {object} db CloudBase database 实例
 * @param {string} name 集合名
 * @param {string} localId 业务 id
 * @param {object} payload 文档内容（不含 _id）
 * @returns {Promise<void>}
 */
async function addWithId(db, name, localId, payload) {
  try {
    await db.collection(name).add({ ...payload, _id: localId });
  } catch (e) {
    await db.collection(name).add({ ...payload });
  }
}

/**
 * 迁移 suggestions 单文档：与云端已有计数按较大值合并，保证可重复执行。
 * @param {object} db CloudBase database 实例
 * @param {object} local 本地 suggestions 对象
 * @param {boolean} dryRun 为 true 时只打印不写入
 * @returns {Promise<{keys: number, mode: string}>}
 */
async function migrateSuggestions(db, local, dryRun) {
  const normalized = {
    sources: local.sources || {},
    products: local.products || {},
    stores: local.stores || {},
  };
  const coll = db.collection('suggestions');
  const res = await coll.limit(1).get();
  const remote = (res && res.data && res.data[0]) || null;

  const merged = { sources: {}, products: {}, stores: {} };
  for (const type of ['sources', 'products', 'stores']) {
    const remoteCounts = (remote && remote[type]) || {};
    const localCounts = normalized[type] || {};
    const keys = new Set([...Object.keys(remoteCounts), ...Object.keys(localCounts)]);
    for (const key of keys) {
      merged[type][key] = Math.max(Number(remoteCounts[key]) || 0, Number(localCounts[key]) || 0);
    }
  }
  const keyCount = Object.keys(merged.sources).length + Object.keys(merged.products).length + Object.keys(merged.stores).length;

  if (dryRun) {
    console.log('  [dry-run] suggestions => ' + JSON.stringify(merged));
    return { keys: keyCount, mode: remote ? 'update' : 'add' };
  }
  if (remote) { await coll.doc(remote._id).update(merged); return { keys: keyCount, mode: 'update' }; }
  await coll.add(merged);
  return { keys: keyCount, mode: 'add' };
}

/**
 * 主流程。
 * @returns {Promise<void>}
 */
async function main() {
  const { dataDir, dryRun } = parseArgs();
  console.log('==================================================');
  console.log('CloudBase 数据迁移' + (dryRun ? '（DRY-RUN 演练模式，不写入）' : ''));
  console.log('数据源目录: ' + dataDir);
  console.log('==================================================');

  if (!fs.existsSync(dataDir)) {
    throw new Error('数据源目录不存在: ' + dataDir);
  }

  const db = await connectCloudBase();
  const summary = [];

  for (const name of ARRAY_COLLECTIONS) {
    console.log('\n-> 迁移集合: ' + name);
    const items = readLocalJson(dataDir, name);
    if (!items) { summary.push(name + ': 无数据文件，跳过'); continue; }
    if (!Array.isArray(items)) { console.error('  ' + name + '.json 不是数组，跳过'); summary.push(name + ': 格式异常，跳过'); continue; }
    const r = await upsertById(db, name, items, dryRun);
    console.log('  本地 ' + items.length + ' 条 => 新增 ' + r.added + '，更新 ' + r.updated + '，跳过 ' + r.skipped + '，失败 ' + r.failed);
    summary.push(name + ': 本地 ' + items.length + ' 条，新增 ' + r.added + '，更新 ' + r.updated + '，失败 ' + r.failed);
  }

  console.log('\n-> 迁移集合: suggestions');
  const suggestions = readLocalJson(dataDir, 'suggestions');
  if (suggestions && typeof suggestions === 'object' && !Array.isArray(suggestions)) {
    const r = await migrateSuggestions(db, suggestions, dryRun);
    console.log('  已' + (r.mode === 'add' ? '创建' : '合并更新') + ' suggestions 文档，共 ' + r.keys + ' 个统计项');
    summary.push('suggestions: ' + r.keys + ' 个统计项（' + (r.mode === 'add' ? '创建' : '合并更新') + '）');
  } else {
    console.log('  跳过：无有效 suggestions 数据');
    summary.push('suggestions: 无数据，跳过');
  }

  console.log('\n==================== 迁移摘要 ====================');
  summary.forEach(line => console.log('  ' + line));
  console.log('==================================================');
  console.log(dryRun ? 'DRY-RUN 结束，未写入任何数据。' : '迁移完成。请登录系统核对订单与账号是否齐全。');
}

main().catch(err => {
  console.error('\n迁移失败: ' + (err && err.message ? err.message : String(err)));
  if (err && err.stack && !err.isUsageError) console.error(err.stack);
  process.exit(1);
});
