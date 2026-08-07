const express = require('express');
const session = require('express-session');
const path = require('path');
const fsSync = require('fs');
const multer = require('multer');
const config = require('./config');
const phoneCity = require('./phoneCity');
const excel = require('./excel');

const app = express();
const PORT = process.env.PORT || config.port;
const SESSION_SECRET = process.env.SESSION_SECRET || config.sessionSecret;

const FIXED_SOURCES = ['美团', '百度', '高德'];
const FIXED_PRODUCTS = [];
const SUGGESTION_THRESHOLD = 5;

// ====== 时区工具（UTC+8 / Asia/Shanghai，无夏令时）======
// 所有时间以 ISO 8601 UTC 落库；「今日」口径与 Excel 时间格式化一律走这里，
// 绝不依赖容器本地时区（云托管默认 TZ=UTC，会导致北京时间 00:00-08:00 的数据被算到前一天）。
const TZ_OFFSET_MS = excel.TZ_OFFSET_MS;
/** 取 ISO 时间在北京时区的自然日，返回 'YYYY-MM-DD'；无效输入返回 ''。 */
const bjDateKey = excel.bjDateKey;
/** 格式化为北京时间 'YYYY-MM-DD HH:mm'；无效输入返回 ''。 */
const fmtBJ = excel.fmtBJ;
/** 把 'YYYY-MM-DD HH:mm'（北京时间）解析为 ISO UTC；空返回 null，非法返回 undefined。 */
const parseBJ = excel.parseBJ;

// ====== 成交流程常量 ======
// Q2：成交流程合并为一步 —— pending_visit 可直接成交，成交即视为到店。
const ALLOW_DEAL_FROM = ['pending_visit', 'visited'];

// ====== 导入上传（multer 内存存储，不落盘）======
const uploadXlsx = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const name = String(file.originalname || '');
    if (!/\.xlsx$/i.test(name)) {
      const err = new Error('仅支持 .xlsx 格式');
      err.code = 'INVALID_FILE_TYPE';
      return cb(err);
    }
    cb(null, true);
  },
}).single('file');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: SESSION_SECRET, resave: false, saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 }
}));

// ====== DATA LAYER (CloudBase DB or local JSON) ======
// 数据持久化说明：
//   - 云端（CloudBase 云托管容器）：必须使用 CloudBase 文档数据库。容器文件系统是临时的，
//     每次「更新服务」都会重建容器，写在 data/*.json 里的数据会被重置 —— 这正是历史丢数据的原因。
//   - 本地开发：使用 data/*.json，行为保持不变。
const DATA_COLLECTIONS = ['users', 'orders', 'suggestions', 'stores'];

let db = null;              // CloudBase 数据库实例；为 null 表示当前走本地 JSON
let isCloudRuntime = false; // 是否运行在腾讯云 CloudBase 云托管 / 云函数容器内
let localReady = false;     // 本地 JSON 存储是否已完成初始化

/**
 * 检测当前进程是否运行在腾讯云 CloudBase 云托管 / 云函数容器内。
 * 云托管容器会注入 TENCENTCLOUD_RUNENV=SCF；容器编排环境会注入 KUBERNETES_SERVICE_HOST；
 * 部分环境会注入 TCB_ENV / TCB_ENV_ID。任一命中即判定为云端环境。
 * 可用 FORCE_LOCAL_STORAGE=1 / FORCE_CLOUD_DB=1 手动覆盖（便于本地联调）。
 * @returns {boolean} true 表示处于云端环境
 */
function detectCloudRuntime() {
  if (process.env.FORCE_LOCAL_STORAGE === '1') {
    console.log('FORCE_LOCAL_STORAGE=1，强制使用本地 JSON 存储');
    return false;
  }
  if (process.env.FORCE_CLOUD_DB === '1') {
    console.log('FORCE_CLOUD_DB=1，强制按云端环境处理');
    return true;
  }
  const hits = [];
  if (process.env.TENCENTCLOUD_RUNENV === 'SCF') hits.push('TENCENTCLOUD_RUNENV=SCF');
  if (process.env.TCB_ENV) hits.push('TCB_ENV=' + process.env.TCB_ENV);
  if (process.env.TCB_ENV_ID) hits.push('TCB_ENV_ID=' + process.env.TCB_ENV_ID);
  if (process.env.KUBERNETES_SERVICE_HOST) hits.push('KUBERNETES_SERVICE_HOST');
  if (hits.length === 0) return false;
  console.log('检测到云端运行环境: ' + hits.join(', '));
  return true;
}

/**
 * 解析 CloudBase 环境 ID。显式配置优先；都没有时返回空串，
 * 由 SDK 通过容器内置服务身份自动识别当前环境。
 * @returns {string} 环境 ID，未显式配置时为空串
 */
function resolveCloudEnvId() {
  return process.env.TCB_ENV_ID || process.env.TCB_ENV || '';
}

/**
 * 判断错误是否为「集合不存在」。此类错误说明连接是通的，只是集合还没建。
 * @param {Error & {code?: string, errCode?: string|number}} err 捕获到的异常
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
 * 判断错误是否为「集合已存在」，并发创建时可安全忽略。
 * @param {Error & {code?: string, errCode?: string|number}} err 捕获到的异常
 * @returns {boolean}
 */
function isCollectionExistsError(err) {
  const code = String((err && (err.code || err.errCode)) || '');
  const msg = String((err && err.message) || '');
  return code.indexOf('ALREADY_EXIST') >= 0 || /already\s+exist/i.test(msg) || msg.indexOf('已存在') >= 0;
}

/**
 * 连通性验证：发起一次真实查询确认云数据库可达。
 * 「集合不存在」说明数据库已正常响应，同样视为连通。
 * @param {object} database CloudBase database 实例
 * @returns {Promise<void>} 不连通时抛出异常
 */
async function probeCloudConnection(database) {
  try {
    await database.collection('users').limit(1).get();
  } catch (e) {
    if (!isCollectionMissingError(e)) throw e;
  }
}

/**
 * 尽力确保集合存在（best-effort，不影响已验证通过的连接状态）。
 * @param {object} database CloudBase database 实例
 * @param {string} name 集合名
 * @returns {Promise<boolean>} 集合是否可用
 */
async function ensureCollection(database, name) {
  try {
    await database.collection(name).limit(1).get();
    return true;
  } catch (e) {
    if (!isCollectionMissingError(e)) {
      console.error('检查集合失败 ' + name + ': ' + e.message);
      return false;
    }
  }
  if (typeof database.createCollection !== 'function') {
    console.error('当前 SDK 不支持自动建集合，请在 CloudBase 控制台手动创建集合: ' + name);
    return false;
  }
  try {
    await database.createCollection(name);
    console.log('已自动创建 CloudBase 集合: ' + name);
    return true;
  } catch (e) {
    if (isCollectionExistsError(e)) return true;
    console.error('创建集合失败 ' + name + ': ' + e.message);
    return false;
  }
}

/**
 * 首次部署时向空的 users 集合写入默认账号，避免云端无账号可登录。
 * 只在集合为空时执行，绝不覆盖已有数据；多实例并发导致的重复插入会被忽略。
 * @param {object} database CloudBase database 实例
 * @returns {Promise<void>}
 */
async function seedCloudDefaultUsers(database) {
  const res = await database.collection('users').limit(1).get();
  if (res && Array.isArray(res.data) && res.data.length > 0) return;
  let seeded = 0;
  for (const user of config.defaultUsers) {
    try {
      await database.collection('users').add({ ...user, _id: user.id });
      seeded++;
    } catch (e) {
      // 并发实例可能已抢先写入，重复主键属正常情况，忽略即可
      console.error('播种默认账号 ' + user.username + ' 跳过: ' + e.message);
    }
  }
  if (seeded > 0) console.log('云端 users 集合为空，已写入 ' + seeded + ' 个默认账号');
}

/**
 * 首次部署时向空的 stores 集合写入种子卖场（data/stores.json，随代码包发布）。
 * 只在集合为空时执行，绝不覆盖已有数据；按 city+name 去重由业务接口负责，
 * 这里仅做「集合为空 → 全量播种」，重复主键异常忽略。
 * @param {object} database CloudBase database 实例
 * @returns {Promise<void>}
 */
async function seedCloudDefaultStores(database) {
  const res = await database.collection('stores').limit(1).get();
  if (res && Array.isArray(res.data) && res.data.length > 0) return;
  let seed = [];
  try {
    seed = JSON.parse(fsSync.readFileSync(path.join(__dirname, 'data', 'stores.json'), 'utf-8'));
  } catch (e) {
    console.error('读取 data/stores.json 失败，云端默认卖场播种跳过: ' + e.message);
    return;
  }
  if (!Array.isArray(seed)) return;
  let seeded = 0;
  for (const store of seed) {
    if (!store || !store.id) continue;
    try {
      await database.collection('stores').add({ ...store, _id: store.id });
      seeded++;
    } catch (e) {
      // 并发实例可能已抢先写入，重复主键属正常情况，忽略即可
      console.error('播种默认卖场 ' + (store.name || store.id) + ' 跳过: ' + e.message);
    }
  }
  if (seeded > 0) console.log('云端 stores 集合为空，已写入 ' + seeded + ' 个默认卖场');
}

/**
 * 初始化 CloudBase 数据库连接。
 * 只有在「检测到云端环境」且「真实查询验证通过」后才会把 db 赋值，
 * 避免出现「以为连上了云库、实际写进临时文件」的静默丢数据。
 * @returns {Promise<boolean>} true 表示云数据库可用
 */
async function initCloudBase() {
  isCloudRuntime = detectCloudRuntime();
  if (!isCloudRuntime) {
    console.log('未检测到云端运行环境，按本地开发模式使用 data/*.json 存储');
    return false;
  }
  const envId = resolveCloudEnvId();
  try {
    const tcb = require('@cloudbase/node-sdk');
    // @cloudbase/node-sdk v2：云端容器内 init({}) 会自动使用内置服务身份连接当前环境
    const tcbApp = tcb.init(envId ? { env: envId } : {});
    const database = tcbApp.database();
    // 关键一步：真实查询验证连通性，失败即视为云库不可用（绝不静默退回临时文件）
    await probeCloudConnection(database);
    // 以下为 best-effort，失败不影响已确认可用的连接
    for (const name of DATA_COLLECTIONS) {
      await ensureCollection(database, name);
    }
    try {
      await seedCloudDefaultUsers(database);
    } catch (e) {
      console.error('默认账号播种跳过: ' + (e && e.message ? e.message : String(e)));
    }
    try {
      await seedCloudDefaultStores(database);
    } catch (e) {
      console.error('默认卖场播种跳过: ' + (e && e.message ? e.message : String(e)));
    }
    db = database;
    console.log('CloudBase 数据库已连接' + (envId ? ' (env=' + envId + ')' : ' (使用容器内置服务身份)'));
    return true;
  } catch (e) {
    db = null;
    console.error('==================== 严重告警 ====================');
    console.error('⚠️ 云端环境但无法连接 CloudBase 数据库，请检查云托管服务身份/环境变量');
    console.error('⚠️ 错误信息: ' + (e && e.message ? e.message : String(e)));
    console.error('⚠️ 当前将退化为容器内临时 JSON 文件存储，容器重建（更新服务）后数据会丢失！');
    console.error('⚠️ 请立即为云托管服务开启「CloudBase 服务身份」或配置 TCB_ENV_ID 环境变量后重新部署。');
    console.error('==================================================');
    return false;
  }
}

// In-memory cache for local fallback
let localData = {};
function initLocal() {
  const fs = require('fs');
  const dir = path.join(__dirname, 'data');
  const files = { orders: 'orders.json', users: 'users.json', suggestions: 'suggestions.json', stores: 'stores.json' };
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  for (const [key, file] of Object.entries(files)) {
    const filePath = path.join(dir, file);
    if (!fs.existsSync(filePath)) {
      const defaults = key === 'users' ? config.defaultUsers :
        key === 'suggestions' ? { sources: {}, products: {}, stores: {} } :
        key === 'stores' ? [] : [];
      fs.writeFileSync(filePath, JSON.stringify(defaults, null, 2));
    }
    localData[key] = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  }
  localReady = true;
  console.log('Using local JSON storage');
  if (isCloudRuntime) {
    console.error('⚠️ 提醒：当前处于云端环境却在使用临时 JSON 存储，数据不会持久化，请尽快修复数据库连接！');
  }
  return true;
}

/**
 * 云库操作失败时的兜底取值。只有本地存储已初始化才回落到 localData，
 * 否则返回结构正确的空值，避免 undefined 引发 TypeError。
 * @param {string} name 集合名
 * @returns {Array<object>|object}
 */
function localFallback(name) {
  if (localReady && localData[name] !== undefined) return localData[name];
  return name === 'suggestions' ? { sources: {}, products: {}, stores: {} } : [];
}

/**
 * 确保本地数组集合可写，返回是否可用。
 * @param {string} name 集合名
 * @returns {boolean}
 */
function ensureLocalArray(name) {
  if (!localReady) {
    console.error('本地存储未初始化，写操作被忽略（集合: ' + name + '）');
    return false;
  }
  if (!Array.isArray(localData[name])) localData[name] = [];
  return true;
}

async function getCollection(name) {
  if (db) {
    try {
      const coll = db.collection(name);
      if (name === 'suggestions') {
        let doc = (await coll.limit(1).get()).data[0];
        if (!doc) { await coll.add({ sources: {}, products: {}, stores: {} }); doc = (await coll.limit(1).get()).data[0]; }
        return doc;
      }
      return coll;
    } catch (e) { console.error('getCollection error: ' + e.message); }
  }
  return localFallback(name);
}

async function readAll(name) {
  if (db) {
    try {
      if (name === 'suggestions') {
        const doc = (await db.collection(name).limit(1).get()).data[0];
        return doc ? { sources: doc.sources || {}, products: doc.products || {}, stores: doc.stores || {} } : { sources: {}, products: {}, stores: {} };
      }
      const res = await db.collection(name).limit(1000).get();
      // 云端文档以 _id 为主键，前端统一使用 id，这里做一次兜底对齐
      return (res.data || []).map(item => (item.id ? item : { ...item, id: item._id }));
    } catch (e) { console.error('readAll error (' + name + '): ' + e.message); }
  }
  const local = localFallback(name);
  return Array.isArray(local) ? [...local] : { ...local };
}

/**
 * 全量读取集合，绕过 CloudBase 单次 1000 条上限（A7）。
 * 本地模式直接委托 readAll；云端模式循环 skip/limit 分页直到取尽。
 * 导出、导入去重校验、统计类接口一律使用本函数，严禁直接用 readAll。
 * @param {string} name 集合名
 * @returns {Promise<Array<object>|object>} 全量数据
 */
async function readAllPaged(name) {
  if (!db || name === 'suggestions') return readAll(name);
  const PAGE = 1000, MAX_PAGES = 100; // 安全上限 10 万条，防御死循环
  const out = [];
  try {
    for (let p = 0; p < MAX_PAGES; p++) {
      const res = await db.collection(name).skip(p * PAGE).limit(PAGE).get();
      const rows = res.data || [];
      out.push(...rows.map(i => (i.id ? i : { ...i, id: i._id })));
      if (rows.length < PAGE) return out;
    }
    console.error('readAllPaged 触达安全上限 ' + (MAX_PAGES * PAGE) + ' 条，数据可能不完整: ' + name);
    return out;
  } catch (e) {
    console.error('readAllPaged error (' + name + '): ' + e.message);
    return readAll(name);
  }
}

async function writeAll(name, data) {
  if (db) {
    try {
      const coll = db.collection(name);
      if (name === 'suggestions') {
        const docs = (await coll.limit(10).get()).data;
        const payload = { ...data };
        delete payload._id; // _id 为云端主键，不可作为更新字段
        if (docs.length > 0) {
          await coll.doc(docs[0]._id).update(payload);
          // 防御性收敛：suggestions 约定为单文档，清理历史并发产生的多余文档
          for (let i = 1; i < docs.length; i++) await coll.doc(docs[i]._id).remove();
        } else {
          await coll.add(payload);
        }
        return;
      }
      const existing = (await coll.limit(1000).get()).data;
      for (const doc of existing) await coll.doc(doc._id).remove();
      for (const item of data) await coll.add(toCloudDoc(item));
      return;
    } catch (e) { console.error('writeAll error (' + name + '): ' + e.message); return; }
  }
  if (!localReady) { console.error('本地存储未初始化，writeAll 被忽略（集合: ' + name + '）'); return; }
  const fs = require('fs');
  const file = path.join(__dirname, 'data', name + '.json');
  localData[name] = data;
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

/**
 * 把本地结构的记录转换为云端文档：用业务 id 作为云端 _id，
 * 使 doc(id).update/remove/get 这类按 id 定位的操作在云端同样成立。
 * @param {object} item 业务记录，需含 id 字段
 * @returns {object} 云端文档
 */
function toCloudDoc(item) {
  const doc = { ...item };
  if (doc.id && !doc._id) doc._id = doc.id;
  return doc;
}

async function addItem(name, item) {
  if (db) {
    const doc = toCloudDoc(item);
    try {
      const res = await db.collection(name).add(doc);
      return doc._id || (res && res.id);
    } catch (e) {
      console.error('addItem error (' + name + '): ' + e.message);
      try { // 少数环境不允许自定义 _id，退化为由云端生成主键
        const { _id, ...rest } = doc;
        const res = await db.collection(name).add(rest);
        return res && res.id;
      } catch (e2) { console.error('addItem retry failed (' + name + '): ' + e2.message); return null; }
    }
  }
  if (!ensureLocalArray(name)) return null;
  localData[name].push(item);
  await writeAll(name, localData[name]);
  return item.id || item._id;
}

async function updateItem(name, id, updates) {
  if (db) {
    try {
      const payload = { ...updates };
      delete payload._id; // _id 为云端主键，不可出现在更新字段中
      await db.collection(name).doc(id).update(payload);
      return;
    } catch (e) { console.error('updateItem error (' + name + '/' + id + '): ' + e.message); return; }
  }
  if (!ensureLocalArray(name)) return;
  const idx = localData[name].findIndex(i => i.id === id);
  if (idx >= 0) { Object.assign(localData[name][idx], updates); await writeAll(name, localData[name]); }
}

async function removeItem(name, id) {
  if (db) {
    try { await db.collection(name).doc(id).remove(); return; }
    catch (e) { console.error('removeItem error (' + name + '/' + id + '): ' + e.message); return; }
  }
  if (!ensureLocalArray(name)) return;
  localData[name] = localData[name].filter(i => i.id !== id);
  await writeAll(name, localData[name]);
}

async function findById(name, id) {
  if (db) {
    try {
      const doc = (await db.collection(name).doc(id).get()).data[0] || null;
      if (doc) return doc.id ? doc : { ...doc, id: doc._id };
      // 兼容历史数据：_id 与业务 id 不一致时按 id 字段再查一次
      const res = await db.collection(name).where({ id }).limit(1).get();
      const found = res && res.data && res.data[0];
      return found ? (found.id ? found : { ...found, id: found._id }) : null;
    } catch (e) { console.error('findById error (' + name + '/' + id + '): ' + e.message); return null; }
  }
  const local = localFallback(name);
  return Array.isArray(local) ? (local.find(i => i.id === id) || null) : null;
}

// ====== 工单状态工具（订单→工单 增量改造）======
// 5 态字符串枚举（前后端统一）：
//   pending(待处理) → appointed(已预约到店) → deal(已成交) → collected(已完结, 终态)
//   另加 noshow(未到店, 财务搁置态)
// status 为权威字段；旧字段（visitStatus/dealStatus/collected）双写镜像，兼容历史数据。
const WORK_STATUSES = ['pending', 'appointed', 'deal', 'collected', 'noshow'];
const WORK_STATUS_CN = { pending: '待处理', appointed: '已预约到店', deal: '已成交', collected: '已完结', noshow: '未到店' };

/**
 * 剥离城市名的「省/市」前后缀，统一为短名，如 甘肃兰州→兰州、江苏镇江→镇江、上海→上海。
 * @param {*} raw 原始城市文本
 * @returns {string} 标准化后的城市短名（空输入返回空串）
 */
function normalizeCityName(raw) {
  if (raw === null || raw === undefined) return '';
  let s = String(raw).trim();
  if (!s) return '';
  const provFull = ['北京市', '上海市', '天津市', '重庆市', '河北省', '山西省', '辽宁省', '吉林省', '黑龙江省', '江苏省', '浙江省', '安徽省', '福建省', '江西省', '山东省', '河南省', '湖北省', '湖南省', '广东省', '海南省', '四川省', '贵州省', '云南省', '陕西省', '甘肃省', '青海省', '台湾省', '内蒙古自治区', '广西壮族自治区', '西藏自治区', '宁夏回族自治区', '新疆维吾尔自治区', '香港特别行政区', '澳门特别行政区'];
  for (const p of provFull) {
    if (s.startsWith(p) && s.length > p.length) { s = s.slice(p.length); break; }
  }
  const provShort = ['北京', '上海', '天津', '重庆', '河北', '山西', '辽宁', '吉林', '黑龙江', '江苏', '浙江', '安徽', '福建', '江西', '山东', '河南', '湖北', '湖南', '广东', '海南', '四川', '贵州', '云南', '陕西', '甘肃', '青海', '台湾', '内蒙古', '广西', '西藏', '宁夏', '新疆', '香港', '澳门'];
  for (const p of provShort) {
    if (s.startsWith(p) && s.length > p.length) { s = s.slice(p.length); break; }
  }
  s = s.replace(/市$/, '');
  return s || String(raw).trim().replace(/市$/, '');
}

/**
 * 由工单/订单对象推导 5 态 status。status 字段存在且合法时直接采用；
 * 否则由旧字段（collected/dealStatus/visitStatus）按权威镜像表反推，兼容历史数据。
 * @param {object} o 工单/订单记录
 * @returns {string} 'pending'|'appointed'|'deal'|'collected'|'noshow'
 */
function deriveStatus(o) {
  if (!o) return 'pending';
  if (o.status && WORK_STATUSES.includes(o.status)) return o.status;
  if (o.collected === true) return 'collected';
  if (o.dealStatus === 'closed') return 'deal';
  if (o.visitStatus === 'not_visited') return 'noshow';
  if (o.visitStatus === 'visited') return 'deal';
  if (o.visitStatus === 'pending_visit') return 'appointed';
  return 'pending';
}

/**
 * 旧流程路由（visit/deal/follow 兼容入口）改完旧字段后调用，
 * 把 status 同步为与旧字段镜像一致的值（status 双写）。
 * 注意：必须忽略当前 status 字段本身（status 优先级最高会掩盖旧字段的新变化），
 * 因此先临时删除 status，再按旧字段镜像重推。
 * @param {object} o 工单/订单记录
 * @returns {string} 同步后的 status
 */
function syncStatus(o) {
  delete o.status; // 强制按旧字段镜像重推，避免 status 自身优先级掩盖旧流程写入
  const s = deriveStatus(o);
  o.status = s;
  return s;
}

/**
 * 生成当日自增工单号：'GD' + YYYYMMDD(北京时间) + '-' + 4位序号（如 GD20260807-0001）。
 * @param {Array<object>} orders 全量工单/订单
 * @param {string} dateKey 北京时区自然日 'YYYY-MM-DD'
 * @returns {string} 新的工单号
 */
function nextWorkOrderNo(orders, dateKey) {
  const prefix = 'GD' + String(dateKey || '').replace(/-/g, '') + '-';
  let max = 0;
  for (const o of (Array.isArray(orders) ? orders : [])) {
    const no = o && o.workOrderNo ? String(o.workOrderNo) : '';
    if (no.startsWith(prefix)) {
      const n = parseInt(no.slice(prefix.length), 10);
      if (!Number.isNaN(n) && n > max) max = n;
    }
  }
  return prefix + String(max + 1).padStart(4, '0');
}

// ====== INIT ======
// 初始化改为异步（需要真实查询验证云库连通性），实际执行放在文件末尾的启动 IIFE 中，
// 服务在初始化完成后才 listen，因此路由处理时 db / localData 一定已就绪，无竞态。
let usingDb = false;

// ====== MIDDLEWARE ======
function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: '请先登录' });
  next();
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user) return res.status(401).json({ error: '请先登录' });
    if (!roles.includes(req.session.user.role)) return res.status(403).json({ error: '无权限访问' });
    next();
  };
}

// ====== API ======
app.get('/api/phoneCity', requireAuth, (req, res) => {
  res.json({ city: phoneCity.lookup(req.query.phone || '') });
});

app.get('/api/suggestions', requireAuth, async (req, res) => {
  const data = await readAll('suggestions');
  const city = req.query.city || '';
  const getSmart = (type) => {
    const counts = data[type] || {};
    let entries = Object.entries(counts);
    if (type === 'stores' && city) entries = entries.filter(([k]) => k.startsWith(city + '|'));
    return entries.filter(([,c]) => c >= SUGGESTION_THRESHOLD)
      .map(([name,c]) => ({ name: type === 'stores' ? name.replace(/^[^|]*\|/, '') : name, count: c }))
      .sort((a,b) => b.count - a.count);
  };
  res.json({
    sources: { fixed: FIXED_SOURCES, smart: getSmart('sources') },
    products: { fixed: FIXED_PRODUCTS, smart: getSmart('products') },
    stores: { fixed: [], smart: getSmart('stores') },
  });
});

// suggestions 是「读-改-写」同一份单文档的操作，调用方为并发触发（下单时同时记录来源/产品/门店）。
// 用串行队列保证依次执行，避免并发下互相覆盖计数、甚至重复创建多份 suggestions 文档。
let suggestionQueue = Promise.resolve();

/**
 * 累加一次联想词命中次数（内部实现，必须串行调用）。
 * @param {string} type sources | products | stores
 * @param {string} value 词条内容
 * @param {string} [city] 门店类型下用于区分城市
 * @returns {Promise<void>}
 */
async function applyTrackSuggestion(type, value, city) {
  const data = await readAll('suggestions');
  const key = (type === 'stores' && city) ? city + '|' + value : value;
  if (!data[type]) data[type] = {};
  data[type][key] = (data[type][key] || 0) + 1;
  await writeAll('suggestions', data);
}

/**
 * 累加一次联想词命中次数。调用方可不 await（内部已捕获异常，不会产生未处理的 Promise 拒绝）。
 * @param {string} type sources | products | stores
 * @param {string} value 词条内容
 * @param {string} [city] 门店类型下用于区分城市
 * @returns {Promise<void>}
 */
function trackSuggestion(type, value, city) {
  if (!value || typeof value !== 'string' || value.trim() === '') return suggestionQueue;
  suggestionQueue = suggestionQueue
    .then(() => applyTrackSuggestion(type, value, city))
    .catch(e => console.error('trackSuggestion error (' + type + '): ' + (e && e.message ? e.message : String(e))));
  return suggestionQueue;
}

// Auth
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  const users = await readAll('users');
  const user = users.find(u => u.username === username && u.password === password);
  if (!user) return res.status(401).json({ error: '账号或密码错误' });
  req.session.user = { id: user.id, username: user.username, role: user.role, name: user.name };
  res.json({ success: true, user: req.session.user });
});
app.post('/api/auth/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });
app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: req.session.user }));

// Users
app.get('/api/users', requireAuth, requireRole('admin'), async (req, res) => {
  const users = await readAll('users');
  res.json({ users: users.map(u => ({ id: u.id, username: u.username, role: u.role, name: u.name, phone: u.phone || '', createdAt: u.createdAt || '' })) });
});
app.post('/api/users', requireAuth, requireRole('admin'), async (req, res) => {
  const { username, password, name, phone, role } = req.body;
  if (!username || !password || !name) return res.status(400).json({ error: '请填写' });
  // ★ 增量：建号角色白名单（不允许 admin），新增 finance_collect
  const allowedRoles = ['sales', 'finance', 'finance_collect'];
  const r = role || 'sales';
  if (!allowedRoles.includes(r)) return res.status(400).json({ error: '角色不合法' });
  const users = await readAll('users');
  if (users.find(u => u.username === username)) return res.status(400).json({ error: '账号已存在' });
  const n = { id: 'u' + Date.now(), username, password, role: r, name, phone: phone || '', createdAt: new Date().toISOString() };
  await addItem('users', n);
  res.json({ success: true });
});
app.put('/api/users/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const { username, name, password } = req.body;
  const u = await findById('users', req.params.id);
  if (!u) return res.status(404).json({ error: '不存在' });
  if (username && u.role !== 'admin') u.username = username;
  if (name) u.name = name;
  if (password) u.password = password;
  await updateItem('users', req.params.id, u);
  res.json({ success: true });
});
app.delete('/api/users/:id', requireAuth, requireRole('admin'), async (req, res) => {
  if (req.params.id === req.session.user.id) return res.status(400).json({ error: '不能删自己' });
  const u = await findById('users', req.params.id);
  if (!u) return res.status(404).json({ error: '不存在' });
  if (u.role === 'admin') return res.status(400).json({ error: '不能删管理员' });
  await removeItem('users', req.params.id);
  res.json({ success: true });
});

// 修改自己密码
app.put('/api/auth/password', requireAuth, async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (!oldPassword || !newPassword) return res.status(400).json({ error: '请填写新旧密码' });
  const u = await findById('users', req.session.user.id);
  if (!u || u.password !== oldPassword) return res.status(400).json({ error: '旧密码不正确' });
  u.password = newPassword;
  await updateItem('users', req.session.user.id, u);
  res.json({ success: true });
});

// Orders
app.get('/api/orders', requireAuth, async (req, res) => {
  let orders = await readAll('orders');
  const user = req.session.user;
  // ★ 增量：按角色 + status 可见性
  //   admin=全部；sales=本人；finance=非 pending；finance_collect=deal|collected
  if (user.role === 'sales') {
    orders = orders.filter(o => o.salesPersonId === user.id);
  } else if (user.role === 'finance') {
    orders = orders.filter(o => deriveStatus(o) !== 'pending');
  } else if (user.role === 'finance_collect') {
    orders = orders.filter(o => ['deal', 'collected'].includes(deriveStatus(o)));
  }
  orders.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ orders });
});

app.post('/api/orders', requireAuth, requireRole('admin', 'sales'), async (req, res) => {
  const { custName, custPhone, custSource, custProduct, custNote, custCity, store, storeAddress } = req.body;
  // ★ 增量：校验改为 电话 + 意向品种 必填（不再要求姓名）
  if (!custPhone || !custProduct) return res.status(400).json({ error: '请填写电话和意向品种' });
  const orders = await readAll('orders');
  const now = new Date().toISOString();
  const city = normalizeCityName(custCity || '') || (custCity || '');
  const storeVal = store !== undefined ? String(store) : (storeAddress || '');
  const order = {
    id: 'ORD' + Date.now(),
    orderNo: 'SO' + new Date().getFullYear() + String(new Date().getMonth()+1).padStart(2,'0') + String(new Date().getDate()).padStart(2,'0') + String(orders.length+1).padStart(4,'0'),
    workOrderNo: nextWorkOrderNo(orders, bjDateKey(now)),
    custName: custName || '', custPhone, custCity: city, custSource: custSource || '', custProduct,
    store: storeVal, storeAddress: storeVal, custNote: custNote || '',
    salesPersonId: req.session.user.id, salesPersonName: req.session.user.name,
    status: 'pending',
    visitStatus: null, visitAt: null, followCount: 0, lastFollowAt: null, followNote: null,
    dealStatus: null, dealAmount: null, dealLiveAmount: null, dealSupplyAmount: null, dealProfit: null,
    amountLive: null, amountSupply: null, amountProfit: null,
    collected: false,
    dealAt: null, dealNote: null, createdAt: now,
  };
  await addItem('orders', order);
  if (custSource) trackSuggestion('sources', custSource);
  if (custProduct) trackSuggestion('products', custProduct);
  if (storeVal && city) trackSuggestion('stores', storeVal, city);
  res.json({ success: true, order });
});

app.put('/api/orders/:id', requireAuth, async (req, res) => {
  const orders = await readAll('orders');
  const idx = orders.findIndex(o => o.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '不存在' });
  const o = orders[idx];
  if (req.session.user.role === 'sales' && o.salesPersonId !== req.session.user.id) return res.status(403).json({ error: '只能操作自己的' });
  // ★ 增量：可编辑字段加 store(+镜像 storeAddress)、custCity（城市名标准化）
  ['custName','custPhone','custSource','custProduct','custNote','custCity','storeAddress','store'].forEach(f => {
    if (req.body[f] !== undefined) {
      o[f] = f === 'custCity' ? (normalizeCityName(req.body[f]) || req.body[f]) : req.body[f];
    }
  });
  if (req.body.store !== undefined) o.storeAddress = req.body.store;
  if (req.body.storeAddress !== undefined) o.store = req.body.storeAddress;
  await updateItem('orders', req.params.id, o);
  if (req.body.custSource) trackSuggestion('sources', req.body.custSource);
  if (req.body.custProduct) trackSuggestion('products', req.body.custProduct);
  if (req.body.storeAddress && o.custCity) trackSuggestion('stores', req.body.storeAddress, o.custCity);
  res.json({ success: true, order: o });
});

// Sales 一键报单：设置即将到店（★ 增量：改为 5 态模型 —— 仅 pending 可转 appointed）
app.post('/api/orders/:id/report', requireAuth, requireRole('admin', 'sales'), async (req, res) => {
  const o = await findById('orders', req.params.id);
  if (!o) return res.status(404).json({ error: '不存在' });
  if (deriveStatus(o) !== 'pending') return res.status(400).json({ error: '仅待处理工单可一键预约到店' });
  if (req.session.user.role === 'sales' && o.salesPersonId !== req.session.user.id) return res.status(403).json({ error: '只能操作自己的' });
  const now = new Date().toISOString();
  o.status = 'appointed';
  o.visitStatus = 'pending_visit';
  o.lastFollowAt = now;
  o.followCount = (o.followCount || 0) + 1;
  await updateItem('orders', req.params.id, o);
  res.json({ success: true, order: o });
});

// ★ 增量：已到店（仅 appointed 可转 deal），body 三金额可空/非必填
app.put('/api/orders/:id/visit', requireAuth, requireRole('admin', 'finance'), async (req, res) => {
  const o = await findById('orders', req.params.id);
  if (!o) return res.status(404).json({ error: '不存在' });
  if (!['appointed', 'noshow'].includes(deriveStatus(o))) return res.status(400).json({ error: '仅已预约到店或未到店工单可确认到店' });
  const toNum = v => (v === undefined || v === null || v === '') ? null : (Number.isFinite(Number(v)) ? Number(v) : null);
  const amountLive = toNum(req.body.amountLive);
  const amountSupply = toNum(req.body.amountSupply);
  const amountProfit = toNum(req.body.amountProfit);
  const now = new Date().toISOString();
  o.status = 'deal';
  o.visitStatus = 'visited';
  o.dealStatus = 'closed';
  o.dealAt = now;
  if (!o.visitAt) o.visitAt = now; // A11：存量 visitAt 不覆盖
  o.amountLive = amountLive;
  o.amountSupply = amountSupply;
  o.amountProfit = amountProfit;
  o.dealLiveAmount = amountLive;
  o.dealSupplyAmount = amountSupply;
  o.dealProfit = amountProfit;
  o.dealAmount = (amountLive || 0) + (amountSupply || 0); // A9：合计=活体+用品，利润不参与
  o.collected = false;
  await updateItem('orders', req.params.id, o);
  res.json({ success: true, order: o });
});

// ★ 增量：未到店（仅 appointed 可转 noshow，单向不回退）
app.put('/api/orders/:id/noshow', requireAuth, requireRole('admin', 'finance'), async (req, res) => {
  const o = await findById('orders', req.params.id);
  if (!o) return res.status(404).json({ error: '不存在' });
  if (deriveStatus(o) !== 'appointed') return res.status(400).json({ error: '仅已预约到店工单可标记未到店' });
  o.status = 'noshow';
  o.visitStatus = 'not_visited';
  await updateItem('orders', req.params.id, o);
  res.json({ success: true, order: o });
});

// ★ 增量：确认已收款（仅 deal 可转 collected；三价格必填才可完结）
app.put('/api/orders/:id/collect', requireAuth, requireRole('admin', 'finance_collect'), async (req, res) => {
  const o = await findById('orders', req.params.id);
  if (!o) return res.status(404).json({ error: '不存在' });
  if (deriveStatus(o) !== 'deal') return res.status(400).json({ error: '仅已成交工单可确认收款' });
  const filled = v => v != null && v !== ''; // 0/负数视为已填，仅拦截 null/undefined/空串
  if (!(filled(o.amountLive) && filled(o.amountSupply) && filled(o.amountProfit))) {
    return res.status(400).json({ error: '请先填写活体/用品/利润三项价格' });
  }
  o.status = 'collected';
  o.collected = true;
  await updateItem('orders', req.params.id, o);
  res.json({ success: true, order: o });
});

// ★ 增量：改价（失焦自动保存；仅 deal/collected 可改；三金额→双写+重算 dealAmount）
app.put('/api/orders/:id/price', requireAuth, requireRole('admin', 'finance_collect'), async (req, res) => {
  const o = await findById('orders', req.params.id);
  if (!o) return res.status(404).json({ error: '不存在' });
  const st = deriveStatus(o);
  if (st !== 'deal' && st !== 'collected') return res.status(400).json({ error: '仅已成交工单可改价' });
  const toNum = v => (v === undefined || v === null || v === '') ? null : (Number.isFinite(Number(v)) ? Number(v) : null);
  const amountLive = toNum(req.body.amountLive);
  const amountSupply = toNum(req.body.amountSupply);
  const amountProfit = toNum(req.body.amountProfit);
  if (amountLive === null && amountSupply === null && amountProfit === null) {
    return res.status(400).json({ error: '请填写至少一个金额' });
  }
  if (amountLive !== null) { o.amountLive = amountLive; o.dealLiveAmount = amountLive; }
  if (amountSupply !== null) { o.amountSupply = amountSupply; o.dealSupplyAmount = amountSupply; }
  if (amountProfit !== null) { o.amountProfit = amountProfit; o.dealProfit = amountProfit; }
  o.dealAmount = (o.amountLive || 0) + (o.amountSupply || 0); // A9：利润不参与合计
  await updateItem('orders', req.params.id, o);
  res.json({ success: true, order: o });
});

// ====== 卖场管理（★ 增量）======
app.get('/api/stores', requireAuth, async (req, res) => {
  let stores = await readAll('stores');
  const city = String(req.query.city || '').trim();
  if (city) stores = stores.filter(s => s.city === city);
  stores.sort((a, b) => String(a.city || '').localeCompare(String(b.city || ''), 'zh-CN') || String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN'));
  res.json({ stores });
});
app.post('/api/stores', requireAuth, requireRole('admin'), async (req, res) => {
  const city = normalizeCityName(req.body.city || '');
  const name = String(req.body.name || '').trim();
  if (!city || !name) return res.status(400).json({ error: '请填写城市和名称' });
  const stores = await readAll('stores');
  if (stores.find(s => s.city === city && s.name === name)) return res.status(400).json({ error: '卖场已存在' });
  const store = { id: 's' + Date.now(), city, name };
  await addItem('stores', store);
  res.json({ success: true, store });
});
app.put('/api/stores/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const s = await findById('stores', req.params.id);
  if (!s) return res.status(404).json({ error: '不存在' });
  if (req.body.city !== undefined && String(req.body.city).trim() !== '') s.city = normalizeCityName(req.body.city);
  if (req.body.name !== undefined && String(req.body.name).trim() !== '') s.name = String(req.body.name).trim();
  await updateItem('stores', req.params.id, s);
  res.json({ success: true, store: s });
});
app.delete('/api/stores/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const s = await findById('stores', req.params.id);
  if (!s) return res.status(404).json({ error: '不存在' });
  await removeItem('stores', req.params.id);
  res.json({ success: true });
});
// 导入初始卖场：读 data/stores.json 合并（按 city+name 去重跳过）
app.post('/api/stores/seed', requireAuth, requireRole('admin'), async (req, res) => {
  let seed = [];
  try {
    seed = JSON.parse(fsSync.readFileSync(path.join(__dirname, 'data', 'stores.json'), 'utf-8'));
  } catch (e) {
    return res.status(500).json({ success: false, error: '读取种子文件失败' });
  }
  if (!Array.isArray(seed)) return res.status(500).json({ success: false, error: '种子文件格式错误' });
  const stores = await readAll('stores');
  const keySet = new Set(stores.map(s => s.city + '|' + s.name));
  let added = 0, skipped = 0;
  for (const item of seed) {
    const city = normalizeCityName(item.city || '');
    const name = String(item.name || '').trim();
    if (!city || !name) { skipped++; continue; }
    const key = city + '|' + name;
    if (keySet.has(key)) { skipped++; continue; }
    keySet.add(key);
    await addItem('stores', { id: item.id || ('s' + Date.now() + '_' + added), city, name });
    added++;
  }
  res.json({ success: true, added, skipped });
});

// Finance 确认到店
app.post('/api/orders/:id/visit', requireAuth, requireRole('admin', 'finance'), async (req, res) => {
  const o = await findById('orders', req.params.id);
  if (!o) return res.status(404).json({ error: '不存在' });
  const { visitStatus } = req.body;
  if (!visitStatus || !['visited','not_visited'].includes(visitStatus)) return res.status(400).json({ error: '无效状态' });
  const now = new Date().toISOString();
  o.visitStatus = visitStatus;
  if (visitStatus === 'visited') o.visitAt = now;
  syncStatus(o); // ★ 增量：status 镜像同步（visited→deal，not_visited→noshow）
  await updateItem('orders', req.params.id, o);
  res.json({ success: true, order: o });
});

app.post('/api/orders/:id/follow', requireAuth, requireRole('admin', 'sales'), async (req, res) => {
  const o = await findById('orders', req.params.id);
  if (!o) return res.status(404).json({ error: '不存在' });
  if (o.visitStatus !== null || o.dealStatus !== null) return res.status(400).json({ error: '已处理' });
  if (req.session.user.role === 'sales' && o.salesPersonId !== req.session.user.id) return res.status(403).json({ error: '只能跟自己的' });
  const { note, visitStatus } = req.body; const now = new Date().toISOString();
  o.followCount = (o.followCount || 0) + 1; o.lastFollowAt = now; o.followNote = note || '';
  if (visitStatus === 'visited') { o.visitStatus = 'visited'; o.visitAt = now; }
  else if (visitStatus === 'not_visited') o.visitStatus = 'not_visited';
  syncStatus(o); // ★ 增量：status 镜像同步
  await updateItem('orders', req.params.id, o);
  res.json({ success: true, order: o });
});

// 一步成交（变更 2 / P0-3 + P0-4）：
//   - 放宽校验至 pending_visit | visited，pending_visit 可直接成交（成交即视为到店）
//   - 成交时一次性写 visited + visitAt（A11：存量 visitAt 不覆盖）+ closed + dealAt + dealProfit
//   - A9 铁律：dealAmount = 活体 + 用品，利润不参与合计
app.post('/api/orders/:id/deal', requireAuth, requireRole('admin', 'finance'), async (req, res) => {
  const o = await findById('orders', req.params.id);
  if (!o) return res.status(404).json({ error: '不存在' });
  if (!ALLOW_DEAL_FROM.includes(o.visitStatus)) {
    return res.status(400).json({ error: o.visitStatus === 'not_visited' ? '客户未到店，不可成交' : '订单未报单，不可成交' });
  }
  if (o.dealStatus !== null && o.dealStatus !== undefined) return res.status(400).json({ error: '已处理' });
  const { dealStatus, liveAmount, supplyAmount, profit, note } = req.body;
  if (!['closed', 'not_closed'].includes(dealStatus)) return res.status(400).json({ error: '无效成交状态' });
  const now = new Date().toISOString();
  o.dealStatus = dealStatus;
  if (dealStatus === 'closed') {
    // Q2：成交即视为到店；A11：visitAt 已有值时不覆盖，保留原到店时间
    o.visitStatus = 'visited';
    if (!o.visitAt) o.visitAt = now;
    const live = Number(liveAmount) || 0;
    const supply = Number(supplyAmount) || 0;
    o.dealLiveAmount = live;
    o.dealSupplyAmount = supply;
    o.dealProfit = Number(profit) || 0;      // 允许负数（亏损单）
    o.dealAmount = live + supply;            // 合计不含利润
  } else {
    o.dealAmount = 0; o.dealLiveAmount = 0; o.dealSupplyAmount = 0;
  }
  o.dealAt = now; o.dealNote = note || '';
  syncStatus(o); // ★ 增量：status 镜像同步（dealStatus closed → deal）
  await updateItem('orders', req.params.id, o);
  res.json({ success: true, order: o });
});

// Stats
app.get('/api/stats', requireAuth, requireRole('admin', 'finance_collect'), async (req, res) => {
  const orders = await readAllPaged('orders'); const now = new Date();
  const isT = d => { const dt = new Date(d); return dt.getFullYear()===now.getFullYear()&&dt.getMonth()===now.getMonth()&&dt.getDate()===now.getDate(); };
  const isW = d => { const dt=new Date(d); const day=now.getDay()||7; const mon=new Date(now); mon.setDate(now.getDate()-day+1); mon.setHours(0,0,0,0); return dt>=mon&&dt<=new Date(mon.getTime()+6*86400000); };
  const isM = d => { const dt=new Date(d); return dt.getFullYear()===now.getFullYear()&&dt.getMonth()===now.getMonth(); };
  const stats = {};
  ['today','week','month','all'].forEach(p => {
    let f = p==='today'?orders.filter(o=>isT(o.createdAt)):p==='week'?orders.filter(o=>isW(o.createdAt)):p==='month'?orders.filter(o=>isM(o.createdAt)):orders;
    const closed = f.filter(o=>o.dealStatus==='closed');
    stats[p] = { total: f.length, visited: f.filter(o=>o.visitStatus==='visited').length, notVisited: f.filter(o=>o.visitStatus==='not_visited').length, closed: closed.length, notClosed: f.filter(o=>o.dealStatus==='not_closed').length, revenue: closed.reduce((s,o)=>s+(o.dealAmount||0),0), liveRevenue: closed.reduce((s,o)=>s+(o.dealLiveAmount||0),0), supplyRevenue: closed.reduce((s,o)=>s+(o.dealSupplyAmount||0),0) };
  });
  const trend = [];
  for (let i=6;i>=0;i--) { const d=new Date(now); d.setDate(d.getDate()-i); const dayO=orders.filter(o=>{const od=new Date(o.createdAt);return od.getFullYear()===d.getFullYear()&&od.getMonth()===d.getMonth()&&od.getDate()===d.getDate();}); const c=dayO.filter(o=>o.dealStatus==='closed'); trend.push({label:`${d.getMonth()+1}/${d.getDate()}`,orders:dayO.length,visited:dayO.filter(o=>o.visitStatus==='visited').length,closed:c.length,revenue:c.reduce((s,o)=>s+(o.dealLiveAmount||0),0)}); } // P0-1：趋势 revenue 改活体口径，与营收卡片对齐
  const sm = {};
  orders.forEach(o => { if(!sm[o.salesPersonId])sm[o.salesPersonId]={id:o.salesPersonId,name:o.salesPersonName,total:0,visited:0,closed:0,revenue:0,liveRevenue:0,supplyRevenue:0}; sm[o.salesPersonId].total++; if(o.visitStatus==='visited')sm[o.salesPersonId].visited++; if(o.dealStatus==='closed'){sm[o.salesPersonId].closed++;sm[o.salesPersonId].revenue+=(o.dealAmount||0);sm[o.salesPersonId].liveRevenue+=(o.dealLiveAmount||0);sm[o.salesPersonId].supplyRevenue+=(o.dealSupplyAmount||0);} });
  // P0-2：排行排序键改活体口径，与前端金额列展示保持一致（revenue/supplyRevenue 字段仍保留返回）
  res.json({ stats, trend, ranking: Object.values(sm).sort((a,b)=>b.liveRevenue-a.liveRevenue) });
});

app.get('/api/cityStats', requireAuth, requireRole('admin'), async (req, res) => {
  const orders = await readAllPaged('orders'); const map = {};
  orders.forEach(o => { const c = o.custCity || '未知'; if(!map[c])map[c]={city:c,orders:0,visited:0,closed:0}; map[c].orders++; if(o.visitStatus==='visited')map[c].visited++; if(o.dealStatus==='closed')map[c].closed++; });
  res.json({ cities: Object.values(map).sort((a,b)=>b.orders-a.orders) });
});

app.get('/api/export', requireAuth, requireRole('admin'), async (req, res) => {
  res.setHeader('Content-Type','application/json');
  res.setHeader('Content-Disposition','attachment; filename=export-'+new Date().toISOString().slice(0,10)+'.json');
  res.json({ exportTime: new Date().toISOString(), orders: await readAllPaged('orders'), users: await readAllPaged('users'), suggestions: await readAll('suggestions') });
});

// ====== 地图大屏数据源（变更 3 / P0-6 + P0-7）======
// 一个接口取代「cityStats + stats + 前端二次排序」的三段式；今日口径一律走 bjDateKey（北京时区）。
app.get('/api/mapStats', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 5, 1), 20);
    const orders = await readAllPaged('orders');
    const today = bjDateKey(new Date().toISOString());

    const todayVisited = orders.filter(o => o.visitStatus === 'visited' && bjDateKey(o.visitAt) === today).length;
    const todayClosed = orders.filter(o => o.dealStatus === 'closed' && bjDateKey(o.dealAt) === today).length;
    // ★ 增量：今日新增客资 = 当日新建订单数量（按 createdAt 的北京自然日统计）
    const todayNew = orders.filter(o => bjDateKey(o.createdAt) === today).length;

    const cm = {};
    const sm = {};
    orders.forEach(o => {
      const c = o.custCity || '未知';
      if (!cm[c]) cm[c] = { city: c, orders: 0, visited: 0, closed: 0 };
      cm[c].orders++;
      if (o.visitStatus === 'visited') cm[c].visited++;
      if (o.dealStatus === 'closed') cm[c].closed++;

      const k = o.salesPersonId || o.salesPersonName || '未知';
      if (!sm[k]) sm[k] = { id: o.salesPersonId || '', name: o.salesPersonName || '未知', total: 0, visited: 0, closed: 0, liveRevenue: 0 };
      sm[k].total++;
      if (o.visitStatus === 'visited') sm[k].visited++;
      if (o.dealStatus === 'closed') { sm[k].closed++; sm[k].liveRevenue += (o.dealLiveAmount || 0); }
    });

    res.json({
      todayVisited,
      todayClosed,
      todayNew,
      cityTop: Object.values(cm).sort((a, b) => b.orders - a.orders).slice(0, limit),
      salesTop: Object.values(sm).sort((a, b) => b.total - a.total).slice(0, limit), // 按订单总数倒序（非金额）
      updatedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error('mapStats error: ' + (e && e.stack ? e.stack : String(e)));
    res.status(500).json({ error: '统计失败' });
  }
});

// ====== Excel 导出 / 模板 / 导入 ======

/**
 * 按查询条件过滤导出订单。
 * 日期按 createdAt 的北京自然日过滤（沿用旧实现口径，不按 dealAt，避免改变财务使用习惯）。
 * 日期参数同时兼容 start/end（财务旧页、数据管理）与 df/dt（工单工作台导出）两套命名。
 * @param {Array<object>} orders 订单数组
 * @param {object} query Express req.query
 * @returns {Array<object>} 过滤后的订单
 */
function applyExportFilters(orders, query) {
  let list = orders;
  const start = String(query.start || query.df || '').trim();
  const end = String(query.end || query.dt || '').trim();
  const dealStatus = String(query.dealStatus || '').trim();
  const salesPersonId = String(query.salesPersonId || '').trim();
  if (start) list = list.filter(o => bjDateKey(o.createdAt) >= start);
  if (end) list = list.filter(o => bjDateKey(o.createdAt) <= end);
  if (dealStatus === 'pending') list = list.filter(o => o.dealStatus === null || o.dealStatus === undefined);
  else if (dealStatus === 'closed' || dealStatus === 'not_closed') list = list.filter(o => o.dealStatus === dealStatus);
  if (salesPersonId) list = list.filter(o => o.salesPersonId === salesPersonId);
  return list;
}

/**
 * 设置 xlsx 文件下载响应头（中文文件名按 RFC 5987 编码）。
 * @param {object} res Express response
 * @param {string} fileName 中文文件名（含扩展名）
 * @param {string} asciiName ASCII 兜底文件名
 * @returns {void}
 */
function setXlsxHeaders(res, fileName, asciiName) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition',
    'attachment; filename="' + asciiName + '"; filename*=UTF-8\'\'' + encodeURIComponent(fileName));
  res.setHeader('Cache-Control', 'no-store');
}

// 订单详单导出（P0-9）：admin + finance。
// ★ 财务范围收敛为 visited|pending_visit，但**不过滤 dealStatus** —— 财务对账必须能导出已成交单。
//   这与财务待办列表口径「故意不同」，切勿顺手对齐。
app.get('/api/export/orders.xlsx', requireAuth, requireRole('admin', 'finance', 'finance_collect'), async (req, res) => {
  try {
    let orders = await readAllPaged('orders');
    if (req.session.user.role === 'finance') {
      orders = orders.filter(o => o.visitStatus === 'visited' || o.visitStatus === 'pending_visit');
    } else if (req.session.user.role === 'finance_collect') {
      // ★ 增量：财务收款确认 只可导出其权限范围内的工单（已成交/已完结）
      orders = orders.filter(o => ['deal', 'collected'].includes(deriveStatus(o)));
    }
    orders = applyExportFilters(orders, req.query);
    orders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const buf = await excel.buildOrdersWorkbook(orders);
    setXlsxHeaders(res, '订单详单-' + bjDateKey(new Date().toISOString()) + '.xlsx', 'orders.xlsx');
    res.end(Buffer.from(buf));
  } catch (e) {
    console.error('export orders.xlsx error: ' + (e && e.stack ? e.stack : String(e)));
    res.status(500).json({ error: '导出失败' });
  }
});

// 导入模板下载（P0-11）：仅 admin
app.get('/api/import/template.xlsx', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const buf = await excel.buildTemplateWorkbook();
    setXlsxHeaders(res, '历史数据导入模板.xlsx', 'import-template.xlsx');
    res.end(Buffer.from(buf));
  } catch (e) {
    console.error('export template.xlsx error: ' + (e && e.stack ? e.stack : String(e)));
    res.status(500).json({ error: '模板生成失败' });
  }
});

// 备份策略（P0-12 / 用户 q-2「强制先备份」的落地方式）：
// 采用「写时强制备份」而非「前置存在校验」——每次导入前必定生成一份新的
// data/backup/backup-<ts>.json 回滚点；备份写入失败则整体中止导入（500），
// 保证任何一次导入之前都存在可回滚快照。不要求管理员事先手动备份，
// 避免出现"备份过期"或"忘记备份"导致的数据风险。
/**
 * 导入写库前强制备份全量数据到 data/backup/backup-<ts>.json。
 * 备份失败即中止导入（用户决策 3：强制备份才允许执行）。
 * @returns {Promise<string>} 备份文件的相对路径
 */
async function backupBeforeImport() {
  const dir = path.join(__dirname, 'data', 'backup');
  if (!fsSync.existsSync(dir)) fsSync.mkdirSync(dir, { recursive: true });
  const payload = {
    exportTime: new Date().toISOString(),
    orders: await readAllPaged('orders'),
    users: await readAllPaged('users'),
    suggestions: await readAll('suggestions'),
  };
  const file = 'backup-' + Date.now() + '.json';
  fsSync.writeFileSync(path.join(dir, file), JSON.stringify(payload, null, 2), 'utf-8');
  return 'data/backup/' + file;
}

/**
 * 处理 multer 上传错误，统一转为 400 JSON（否则 Express 会返回 HTML 错误页）。
 * @param {Error} err multer 抛出的错误
 * @param {object} res Express response
 * @returns {void}
 */
function handleUploadError(err, res) {
  if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: '文件超过 5MB' });
  if (err && err.code === 'INVALID_FILE_TYPE') return res.status(400).json({ error: '仅支持 .xlsx 格式' });
  if (err && err.code === 'LIMIT_FILE_COUNT') return res.status(400).json({ error: '一次只能上传一个文件' });
  console.error('upload error: ' + (err && err.stack ? err.stack : String(err)));
  return res.status(400).json({ error: '文件上传失败' });
}

// 历史数据导入（P0-12）：仅 admin。两阶段 Validate-then-Write，写库前强制 JSON 备份。
app.post('/api/import/xlsx', requireAuth, requireRole('admin'),
  (req, res, next) => { uploadXlsx(req, res, (err) => (err ? handleUploadError(err, res) : next())); },
  async (req, res) => {
    try {
      if (!req.file || !req.file.buffer || req.file.buffer.length === 0) {
        return res.status(400).json({ error: '请选择要导入的文件' });
      }

      // ① 解析 + 全量校验（只读，不写库）
      let parsed;
      try {
        parsed = await excel.parseImportWorkbook(req.file.buffer);
      } catch (e) {
        if (e && (e.code === 'PARSE_FAILED' || e.code === 'NO_SHEET')) {
          return res.status(400).json({ success: false, error: e.message });
        }
        throw e;
      }
      if (parsed.errors.length > 0) {
        return res.status(400).json({
          success: false,
          error: '文件校验未通过，未写入任何数据',
          errors: parsed.errors.slice(0, 200),
          errorCount: parsed.errors.length,
        });
      }
      if (parsed.users.length === 0 && parsed.orders.length === 0) {
        return res.status(400).json({ success: false, error: '文件中没有可导入的有效数据行' });
      }

      // ② 校验通过后、写库前强制备份（用户决策 3）
      let backupFile = '';
      try {
        backupFile = await backupBeforeImport();
      } catch (e) {
        console.error('backupBeforeImport error: ' + (e && e.stack ? e.stack : String(e)));
        return res.status(500).json({ success: false, error: '导入前备份失败，为保护数据已中止导入' });
      }

      const batchTs = Date.now();
      const warnings = parsed.warnings.slice();
      const defaultPasswordUsers = [];

      // ③ 写用户：username 去重（库内已存在则跳过），addItem 逐条写，明文密码
      const existUsers = await readAllPaged('users');
      const userByName = new Map();
      const existUsernames = new Set();
      existUsers.forEach(u => { existUsernames.add(u.username); if (u.name) userByName.set(u.name, u); });

      const userResult = { added: 0, skipped: 0, failed: 0 };
      for (let i = 0; i < parsed.users.length; i++) {
        const row = parsed.users[i];
        if (existUsernames.has(row.username)) { userResult.skipped++; continue; }
        const u = {
          id: 'u' + batchTs + '_' + String(i).padStart(4, '0'),
          username: row.username,
          password: row.password,
          role: row.role,
          name: row.name,
          phone: '',
          createdAt: new Date().toISOString(),
        };
        try {
          await addItem('users', u);
          existUsernames.add(u.username);
          if (u.name) userByName.set(u.name, u);
          userResult.added++;
          if (row.usedDefaultPassword) defaultPasswordUsers.push(u.username);
        } catch (e) {
          userResult.failed++;
          warnings.push({ sheet: excel.SHEET_USERS, row: row._row, column: '账号', message: '写入失败：' + (e && e.message ? e.message : String(e)) });
        }
      }

      // ④ 写订单：orderNo 去重，addItem 逐条写（严禁 writeAll）
      const existOrders = await readAllPaged('orders');
      const existOrderNos = new Set(existOrders.map(o => o.orderNo));
      const orderResult = { added: 0, skipped: 0, failed: 0 };
      const nowIso = new Date().toISOString();

      for (let i = 0; i < parsed.orders.length; i++) {
        const row = parsed.orders[i];
        if (existOrderNos.has(row.orderNo)) { orderResult.skipped++; continue; }
        const matched = row.salesPersonName ? userByName.get(row.salesPersonName) : null;
        if (row.salesPersonName && !matched) {
          warnings.push({ sheet: excel.SHEET_ORDERS, row: row._row, column: '销售人员', message: '销售人员「' + row.salesPersonName + '」未匹配到账号，已存为文本' });
        }
        const order = {
          id: 'ORD' + batchTs + '_' + String(i).padStart(4, '0'),
          orderNo: row.orderNo,
          custName: row.custName,
          custPhone: row.custPhone || '',
          custCity: row.custCity || '',
          custSource: row.custSource || '',
          custProduct: row.custProduct || '',
          storeAddress: row.storeAddress || '',
          custNote: row.custNote || '',
          salesPersonId: matched ? matched.id : '',
          salesPersonName: row.salesPersonName || '',
          visitStatus: row.visitStatus === undefined ? null : row.visitStatus,
          visitAt: row.visitAt || null,
          followCount: Number(row.followCount) || 0,
          lastFollowAt: null,
          followNote: null,
          dealStatus: row.dealStatus === undefined ? null : row.dealStatus,
          dealAmount: Number(row.dealAmount) || 0,
          dealLiveAmount: Number(row.dealLiveAmount) || 0,
          dealSupplyAmount: Number(row.dealSupplyAmount) || 0,
          dealProfit: Number(row.dealProfit) || 0,
          dealAt: row.dealAt || null,
          dealNote: '',
          createdAt: row.createdAt || nowIso,
        };
        try {
          await addItem('orders', order);
          existOrderNos.add(order.orderNo);
          orderResult.added++;
        } catch (e) {
          orderResult.failed++;
          warnings.push({ sheet: excel.SHEET_ORDERS, row: row._row, column: '订单编号', message: '写入失败：' + (e && e.message ? e.message : String(e)) });
        }
      }

      res.json({
        success: true,
        backupFile,
        users: userResult,
        orders: orderResult,
        warnings: warnings.slice(0, 200),
        warningCount: warnings.length,
        defaultPasswordUsers,
        defaultPassword: excel.DEFAULT_IMPORT_PASSWORD,
      });
    } catch (e) {
      console.error('import xlsx error: ' + (e && e.stack ? e.stack : String(e)));
      res.status(500).json({ success: false, error: '导入失败' });
    }
  });

app.get('/healthz', (req, res) => res.status(200).send('ok'));

// ============================================================
// ⚠️ 所有 API 路由必须注册在本行以上！
//    下方 app.get('*') 是 SPA 兜底，会吞掉其后注册的一切 GET 路由
//    （Express 按注册顺序匹配，之后注册的 GET 永远命中不到，
//     表现为「下载到的是 index.html 的 HTML 内容」）。
// ============================================================
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ====== STARTUP ======
// 先完成数据层初始化（含云库连通性验证），再开始监听端口，避免请求打在未就绪的数据层上。
(async () => {
  try {
    usingDb = await initCloudBase();
  } catch (e) {
    usingDb = false;
    console.error('数据层初始化异常: ' + (e && e.message ? e.message : String(e)));
  }
  if (!usingDb) { initLocal(); }
  app.listen(PORT, '0.0.0.0', () => console.log(`系统已启动: ${PORT}, ${usingDb ? 'CloudBase数据库' : '本地JSON存储'}`));
})();
