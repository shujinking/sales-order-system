/**
 * excel.js —— Excel 导出 / 模板 / 导入解析能力模块（纯函数，不依赖 Express 与存储层）
 *
 * 设计约束（见 docs/设计-增量-功能变更.md 第六章）：
 *  1. ORDER_COLUMNS / USER_COLUMNS 是列定义的**唯一事实来源**，导出、模板、导入表头映射全部引用它，
 *     禁止在任何地方硬编码列名数组 —— 这是「导出原样导回 = 全部重复」闭环成立的机制保障。
 *  2. 中文状态映射双向严格对称：fromCN(map, toCN(map, v)) === v。
 *  3. 时间一律按北京时区（UTC+8）解读与格式化，不依赖容器本地时区。
 *  4. 金额/次数一律写 JS number（不写字符串），保证 Excel 可直接 SUM。
 *  5. DEFAULT_IMPORT_PASSWORD 从 config.js 引入，本模块不硬编码字面量。
 */

const ExcelJS = require('exceljs');
const { DEFAULT_IMPORT_PASSWORD } = require('./config');

// ============================================================
// 常量
// ============================================================

/** 北京时区（Asia/Shanghai，无夏令时）相对 UTC 的偏移毫秒数 */
const TZ_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 单次导入允许的最大有效数据行数（用户 + 订单合计口径按各自 sheet 独立判定） */
const MAX_IMPORT_ROWS = 2000;

/** 工作表名称常量 */
const SHEET_USERS = '用户';
const SHEET_ORDERS = '订单';
const SHEET_README = '填写说明';

/**
 * 订单导出/导入列定义（19 列）。唯一事实来源。
 * type: text | phone | enum | date | int | money
 * cnMap: VISIT | DEAL | ROLE，指向中文映射表
 */
const ORDER_COLUMNS = [
  { header: '订单编号', field: 'orderNo', type: 'text', width: 20, required: true },
  { header: '客户姓名', field: 'custName', type: 'text', width: 12, required: true },
  { header: '客户电话', field: 'custPhone', type: 'phone', width: 14, numFmt: '@' },
  { header: '城市', field: 'custCity', type: 'text', width: 10 },
  { header: '客户来源', field: 'custSource', type: 'text', width: 10 },
  { header: '意向产品', field: 'custProduct', type: 'text', width: 14 },
  { header: '到店门店', field: 'storeAddress', type: 'text', width: 22 },
  { header: '备注', field: 'custNote', type: 'text', width: 26 },
  { header: '销售人员', field: 'salesPersonName', type: 'text', width: 10 },
  { header: '到店状态', field: 'visitStatus', type: 'enum', width: 10, cnMap: 'VISIT' },
  { header: '到店时间', field: 'visitAt', type: 'date', width: 18 },
  { header: '跟进次数', field: 'followCount', type: 'int', width: 9, numFmt: '0' },
  { header: '成交状态', field: 'dealStatus', type: 'enum', width: 10, cnMap: 'DEAL' },
  { header: '活体金额', field: 'dealLiveAmount', type: 'money', width: 13, numFmt: '#,##0.00' },
  { header: '用品金额', field: 'dealSupplyAmount', type: 'money', width: 13, numFmt: '#,##0.00' },
  { header: '合计金额', field: 'dealAmount', type: 'money', width: 13, numFmt: '#,##0.00', recalcOnImport: true },
  { header: '利润', field: 'dealProfit', type: 'money', width: 13, numFmt: '#,##0.00', allowNegative: true },
  { header: '成交时间', field: 'dealAt', type: 'date', width: 18 },
  { header: '创建时间', field: 'createdAt', type: 'date', width: 18 },
];

/** 用户导入列定义（4 列）。唯一事实来源。 */
const USER_COLUMNS = [
  { header: '账号', field: 'username', type: 'text', width: 16, required: true },
  { header: '姓名', field: 'name', type: 'text', width: 12, required: true },
  { header: '角色', field: 'role', type: 'enum', width: 10, cnMap: 'ROLE', required: true },
  { header: '初始密码', field: 'password', type: 'text', width: 14 },
];

/** 到店状态 枚举 ⇄ 中文 */
const VISIT_STATUS_CN = { pending_visit: '即将到店', visited: '已到店', not_visited: '未到店', null: '未报单' };
/** 成交状态 枚举 ⇄ 中文 */
const DEAL_STATUS_CN = { closed: '已成交', not_closed: '未成交', null: '待确认' };
/** 角色 枚举 ⇄ 中文 */
const ROLE_CN = { admin: '管理员', sales: '销售', finance: '财务' };

/** cnMap 名称 → 映射表实例 */
const CN_MAPS = { VISIT: VISIT_STATUS_CN, DEAL: DEAL_STATUS_CN, ROLE: ROLE_CN };

/** 导入允许的角色白名单（用户拍板：仅 sales / finance，禁止导入 admin） */
const IMPORTABLE_ROLES = ['sales', 'finance'];

/** 模板示例行内容（解析时若整行与示例完全一致则自动跳过） */
const USER_SAMPLE = { username: 'zhangsan', name: '张三', role: '销售', password: '' };
const ORDER_SAMPLE = {
  orderNo: 'SO202601010001', custName: '张先生', custPhone: '13800138000', custCity: '杭州',
  custSource: '美团', custProduct: '布偶猫', storeAddress: '杭州市西湖区XX店', custNote: '示例行，导入前请删除',
  salesPersonName: '张三', visitStatus: '已到店', visitAt: '2026-01-01 14:30', followCount: 2,
  dealStatus: '已成交', dealLiveAmount: 12800, dealSupplyAmount: 2400, dealAmount: 15200,
  dealProfit: 3600, dealAt: '2026-01-01 15:00', createdAt: '2026-01-01 10:00',
};

// ============================================================
// 工具函数
// ============================================================

/**
 * 格式化 ISO 时间为北京时间 'YYYY-MM-DD HH:mm'。
 * @param {string|null|undefined} iso ISO 8601 时间字符串
 * @returns {string} 格式化结果；输入为空或非法时返回空串
 */
function fmtBJ(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  return new Date(t + TZ_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ');
}

/**
 * 取 ISO 时间在北京时区的自然日 'YYYY-MM-DD'。
 * @param {string|null|undefined} iso ISO 8601 时间字符串
 * @returns {string} 'YYYY-MM-DD'；输入为空或非法时返回空串
 */
function bjDateKey(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  return new Date(t + TZ_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * 把 'YYYY-MM-DD HH:mm'（按北京时间解读）解析为 ISO 8601 UTC 字符串。
 * @param {*} text 待解析文本；也接受 Date 实例（Excel 日期单元格）
 * @returns {string|null|undefined} ISO 字符串；空输入返回 null；无法解析返回 undefined（调用方判 error）
 */
function parseBJ(text) {
  if (text === null || text === undefined || text === '') return null;
  if (text instanceof Date) {
    // exceljs 把日期单元格读成 Date（以 UTC 存储的墙上时间），直接取其 UTC 字段按北京时间解读
    const t = text.getTime();
    if (Number.isNaN(t)) return undefined;
    return new Date(t - TZ_OFFSET_MS).toISOString();
  }
  const s = String(text).trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return undefined;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const h = Number(m[4] || 0), mi = Number(m[5] || 0), sec = Number(m[6] || 0);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || sec > 59) return undefined;
  const ts = Date.UTC(y, mo - 1, d, h, mi, sec) - TZ_OFFSET_MS;
  if (Number.isNaN(ts)) return undefined;
  return new Date(ts).toISOString();
}

/**
 * 枚举值 → 中文。
 * @param {Object<string,string>} map 映射表
 * @param {*} v 枚举值（null/undefined/'' 视为 null 项）
 * @returns {string} 中文文案；未知值返回空串
 */
function toCN(map, v) {
  const key = (v === null || v === undefined || v === '') ? 'null' : String(v);
  const hit = map[key];
  return hit === undefined ? '' : hit;
}

/**
 * 中文 → 枚举值（同时兼容直接填英文枚举值）。
 * @param {Object<string,string>} map 映射表
 * @param {*} text 中文文案或枚举值
 * @returns {string|null|undefined} 枚举值；空输入返回 null；无法识别返回 undefined（调用方判 error）
 */
function fromCN(map, text) {
  const t = String(text === null || text === undefined ? '' : text).trim();
  if (t === '') return null;
  const hit = Object.entries(map).find(([k, cn]) => cn === t || k === t);
  if (!hit) return undefined;
  return hit[0] === 'null' ? null : hit[0];
}

/**
 * 取单元格的原始值，抹平 exceljs 的富文本 / 公式 / 超链接包装。
 * @param {*} cell exceljs Cell 实例
 * @returns {*} 原始值
 */
function cellValue(cell) {
  if (!cell) return null;
  let v = cell.value;
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map(r => r.text).join('');
    if (v.text !== undefined) return v.text;
    if (v.result !== undefined) return v.result;
    if (v.hyperlink !== undefined && v.text === undefined) return v.hyperlink;
    if (v instanceof Date) return v;
  }
  return v;
}

/**
 * 单元格值转字符串并 trim。
 * @param {*} v 原始值
 * @returns {string}
 */
function s(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return fmtBJ(v.toISOString());
  return String(v).trim();
}

/**
 * 电话号码规范化：Excel 可能把纯数字电话存成 number，需还原为整数字符串避免科学计数法。
 * @param {*} v 原始值
 * @returns {string} 规范化后的电话文本
 */
function normalizePhone(v) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return '';
    return Number.isInteger(v) ? String(BigInt(Math.round(v))) : String(v);
  }
  const t = String(v).trim();
  // 兼容被 Excel 转成科学计数法后又转回字符串的情况，如 1.38001e+10
  if (/^\d+(\.\d+)?e\+?\d+$/i.test(t)) {
    const n = Number(t);
    if (Number.isFinite(n) && Number.isInteger(n)) return String(BigInt(Math.round(n)));
  }
  return t;
}

/**
 * 解析数字单元格。
 * @param {*} v 原始值
 * @returns {number|null|undefined} 数字；空输入返回 null；无法解析返回 undefined（调用方判 error）
 */
function parseNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  const t = String(v).trim().replace(/[,¥￥\s]/g, '');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * 把订单对象的某一列转换为写入 Excel 的单元格值。
 * @param {object} col ORDER_COLUMNS 中的列定义
 * @param {object} order 订单记录
 * @returns {string|number} 单元格值
 */
function orderCellValue(col, order) {
  const raw = order[col.field];
  switch (col.type) {
    case 'enum':
      return toCN(CN_MAPS[col.cnMap], raw);
    case 'date':
      return fmtBJ(raw);
    case 'money':
      return Number(raw) || 0;
    case 'int':
      return Math.trunc(Number(raw) || 0);
    case 'phone':
      return normalizePhone(raw);
    default:
      return raw === null || raw === undefined ? '' : String(raw);
  }
}

/**
 * 统一的表头样式装饰。
 * @param {*} sheet exceljs Worksheet
 * @param {Array<object>} columns 列定义
 * @returns {void}
 */
function decorateHeader(sheet, columns) {
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: 'FF1F2937' } };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
  headerRow.height = 22;
  for (let i = 1; i <= columns.length; i++) {
    headerRow.getCell(i).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF3F9' } };
    headerRow.getCell(i).border = {
      top: { style: 'thin', color: { argb: 'FFD0D7E2' } },
      left: { style: 'thin', color: { argb: 'FFD0D7E2' } },
      bottom: { style: 'thin', color: { argb: 'FFD0D7E2' } },
      right: { style: 'thin', color: { argb: 'FFD0D7E2' } },
    };
  }
  headerRow.commit();
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
}

/**
 * 按列定义把列宽与数字格式应用到工作表。
 * @param {*} sheet exceljs Worksheet
 * @param {Array<object>} columns 列定义
 * @returns {void}
 */
function applyColumnFormats(sheet, columns) {
  columns.forEach((col, idx) => {
    const column = sheet.getColumn(idx + 1);
    column.width = Math.min(col.width || 12, 40);
    if (col.numFmt) column.numFmt = col.numFmt;
    if (col.type === 'phone') column.alignment = { horizontal: 'left' };
  });
}

// ============================================================
// 导出 / 模板
// ============================================================

/**
 * 构建订单详单工作簿。
 * @param {Array<object>} orders 订单数组
 * @returns {Promise<Buffer>} xlsx 文件 Buffer
 */
async function buildOrdersWorkbook(orders) {
  const list = Array.isArray(orders) ? orders : [];
  const wb = new ExcelJS.Workbook();
  wb.creator = '销售订单管理系统';
  wb.created = new Date();
  const sheet = wb.addWorksheet(SHEET_ORDERS, { views: [{ state: 'frozen', ySplit: 1 }] });

  sheet.addRow(ORDER_COLUMNS.map(c => c.header));
  for (const order of list) {
    sheet.addRow(ORDER_COLUMNS.map(c => orderCellValue(c, order)));
  }
  applyColumnFormats(sheet, ORDER_COLUMNS);
  decorateHeader(sheet, ORDER_COLUMNS);

  // 电话列强制文本格式，防科学计数法/前导 0 丢失
  const phoneIdx = ORDER_COLUMNS.findIndex(c => c.type === 'phone');
  if (phoneIdx >= 0) {
    for (let r = 2; r <= list.length + 1; r++) {
      sheet.getRow(r).getCell(phoneIdx + 1).numFmt = '@';
    }
  }
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

/**
 * 构建历史数据导入模板工作簿（用户 / 订单 / 填写说明 三 Sheet）。
 * @returns {Promise<Buffer>} xlsx 文件 Buffer
 */
async function buildTemplateWorkbook() {
  const wb = new ExcelJS.Workbook();
  wb.creator = '销售订单管理系统';
  wb.created = new Date();

  // ---- Sheet 1: 用户 ----
  const us = wb.addWorksheet(SHEET_USERS, { views: [{ state: 'frozen', ySplit: 1 }] });
  us.addRow(USER_COLUMNS.map(c => c.header));
  const uSample = us.addRow(USER_COLUMNS.map(c => {
    const v = USER_SAMPLE[c.field];
    return v === undefined ? '' : v;
  }));
  uSample.font = { italic: true, color: { argb: 'FF9AA5B1' } };
  applyColumnFormats(us, USER_COLUMNS);
  decorateHeader(us, USER_COLUMNS);

  // ---- Sheet 2: 订单（与导出 19 列完全同构）----
  const os = wb.addWorksheet(SHEET_ORDERS, { views: [{ state: 'frozen', ySplit: 1 }] });
  os.addRow(ORDER_COLUMNS.map(c => c.header));
  const oSample = os.addRow(ORDER_COLUMNS.map(c => {
    const v = ORDER_SAMPLE[c.field];
    return v === undefined ? '' : v;
  }));
  oSample.font = { italic: true, color: { argb: 'FF9AA5B1' } };
  applyColumnFormats(os, ORDER_COLUMNS);
  decorateHeader(os, ORDER_COLUMNS);
  const phoneIdx = ORDER_COLUMNS.findIndex(c => c.type === 'phone');
  if (phoneIdx >= 0) os.getRow(2).getCell(phoneIdx + 1).numFmt = '@';

  // ---- Sheet 3: 填写说明 ----
  const rs = wb.addWorksheet(SHEET_README);
  rs.getColumn(1).width = 20;
  rs.getColumn(2).width = 96;
  const lines = [
    ['章节', '说明'],
    ['总体规则', '本模板共两个数据表：「' + SHEET_USERS + '」与「' + SHEET_ORDERS + '」。只需填写要导入的表，另一个可留空。'],
    ['示例行', '两张表的第 2 行为灰色斜体示例行，导入前请删除；若未删除，系统会自动识别并跳过。'],
    ['表头', '请勿修改、删除或调整表头文字；列顺序可以调整（系统按列名匹配），但列名必须与模板一致。'],
    ['校验方式', '导入采用「先全量校验，再统一写入」。只要有任意一行校验失败，本次导入整体拒绝、零写入，并返回出错的表名、行号、列名与原因。'],
    ['去重规则', '用户按「账号」去重、订单按「订单编号」去重：库中已存在的记录会被跳过（不会覆盖），仅新增不存在的记录。'],
    ['表内重复', '同一张表内出现重复的「账号」或「订单编号」会判为错误，请先自行去重。'],
    ['行数上限', '单次导入每张表最多 ' + MAX_IMPORT_ROWS + ' 行有效数据，超出请分批导入。'],
    ['—— 用户表 ——', ''],
    ['账号', '必填。登录用的用户名，不可与系统已有账号重复。'],
    ['姓名', '必填。用于订单表「销售人员」列的关联匹配，请与订单表保持一致。'],
    ['角色', '必填。仅支持填写：' + IMPORTABLE_ROLES.map(r => ROLE_CN[r]).join(' / ') + '（也可直接填 ' + IMPORTABLE_ROLES.join(' / ') + '）。不支持导入管理员账号，请联系系统维护人员手动创建。'],
    ['初始密码', '可留空。留空时统一使用默认密码 ' + DEFAULT_IMPORT_PASSWORD + '，导入完成后请通知相关人员尽快修改密码。'],
    ['—— 订单表 ——', ''],
    ['订单编号', '必填。系统内唯一，重复则跳过。'],
    ['客户姓名', '必填。'],
    ['客户电话', '建议将该列设置为「文本」格式，避免 Excel 把号码转成科学计数法。'],
    ['销售人员', '按「姓名」与系统用户匹配；匹配不到时仍会导入，销售人员按文本保留，但无法归属到具体账号（会在导入结果中以警告列出）。'],
    ['到店状态', '可填：' + Object.keys(VISIT_STATUS_CN).filter(k => k !== 'null').map(k => VISIT_STATUS_CN[k]).join(' / ') + '；留空表示未报单。'],
    ['成交状态', '可填：' + Object.keys(DEAL_STATUS_CN).filter(k => k !== 'null').map(k => DEAL_STATUS_CN[k]).join(' / ') + '；留空表示待确认。'],
    ['金额列', '活体金额 / 用品金额 / 利润 请填写纯数字（不带 ¥ 与千分位）。其中利润允许为负数，其余金额不得为负。'],
    ['合计金额', '导入时由系统按「活体金额 + 用品金额」自动重算，表内填写的值不会被采用（利润不参与合计）。'],
    ['时间列', '格式 YYYY-MM-DD HH:mm 或 YYYY-MM-DD，按北京时间（UTC+8）解读。创建时间留空时取导入时刻。'],
    ['跟进次数', '整数，留空按 0 处理。'],
  ];
  lines.forEach(l => rs.addRow(l));
  const rHead = rs.getRow(1);
  rHead.font = { bold: true };
  rHead.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF3F9' } };
  rHead.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF3F9' } };
  rs.getColumn(2).alignment = { wrapText: true, vertical: 'top' };

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

// ============================================================
// 导入解析
// ============================================================

/**
 * 建立「列名 → 列索引」映射（按列名匹配，与列顺序无关）。
 * @param {*} sheet exceljs Worksheet
 * @param {Array<object>} columns 列定义
 * @returns {{map: Object<string, number>, missing: string[]}} 字段→列号映射与缺失的必需列
 */
function buildHeaderMap(sheet, columns) {
  const headerRow = sheet.getRow(1);
  const byHeader = {};
  const colCount = Math.max(sheet.columnCount || 0, columns.length);
  for (let c = 1; c <= colCount; c++) {
    const text = s(cellValue(headerRow.getCell(c)));
    if (text) byHeader[text] = c;
  }
  const map = {};
  const missing = [];
  for (const col of columns) {
    const idx = byHeader[col.header];
    if (idx) map[col.field] = idx;
    else if (col.required) missing.push(col.header);
  }
  return { map, missing };
}

/**
 * 判断一行是否为全空行。
 * @param {*} row exceljs Row
 * @param {Object<string, number>} headerMap 字段→列号映射
 * @returns {boolean}
 */
function isBlankRow(row, headerMap) {
  return Object.values(headerMap).every(c => s(cellValue(row.getCell(c))) === '');
}

/**
 * 判断一行是否与模板示例行完全一致（容错：用户忘删示例行时自动跳过）。
 * @param {object} data 已解析的原始字符串字典（字段→字符串）
 * @param {object} sample 示例数据字典
 * @param {Array<object>} columns 列定义
 * @returns {boolean}
 */
function isSampleRow(data, sample, columns) {
  let matched = 0;
  for (const col of columns) {
    const expect = sample[col.field];
    if (expect === undefined || expect === '') continue;
    if (s(data[col.field]) !== s(expect)) return false;
    matched++;
  }
  return matched > 0;
}

/**
 * 解析「用户」工作表。
 * @param {*} sheet exceljs Worksheet
 * @param {{errors: Array, warnings: Array}} acc 错误/警告累加器
 * @returns {Array<object>} 解析出的用户行
 */
function parseUsersSheet(sheet, acc) {
  const users = [];
  const { map, missing } = buildHeaderMap(sheet, USER_COLUMNS);
  if (missing.length > 0) {
    acc.errors.push({ sheet: SHEET_USERS, row: 1, column: missing.join('、'), message: '缺少必需列：' + missing.join('、') });
    return users;
  }
  const seen = new Map();
  const lastRow = sheet.rowCount || 1;
  let validCount = 0;

  for (let r = 2; r <= lastRow; r++) {
    const row = sheet.getRow(r);
    if (isBlankRow(row, map)) continue;

    const raw = {};
    for (const col of USER_COLUMNS) raw[col.field] = s(cellValue(row.getCell(map[col.field])));
    if (isSampleRow(raw, USER_SAMPLE, USER_COLUMNS)) continue;

    validCount++;
    if (validCount > MAX_IMPORT_ROWS) {
      acc.errors.push({ sheet: SHEET_USERS, row: r, column: '-', message: '单次导入每张表不得超过 ' + MAX_IMPORT_ROWS + ' 行' });
      break;
    }

    let bad = false;
    if (!raw.username) { acc.errors.push({ sheet: SHEET_USERS, row: r, column: '账号', message: '账号不能为空' }); bad = true; }
    if (!raw.name) { acc.errors.push({ sheet: SHEET_USERS, row: r, column: '姓名', message: '姓名不能为空' }); bad = true; }

    const role = fromCN(ROLE_CN, raw.role);
    if (role === undefined || role === null) {
      acc.errors.push({
        sheet: SHEET_USERS, row: r, column: '角色',
        message: '角色必须为 ' + IMPORTABLE_ROLES.map(x => ROLE_CN[x]).join(' / ') + '，当前值「' + (raw.role || '(空)') + '」',
      });
      bad = true;
    } else if (!IMPORTABLE_ROLES.includes(role)) {
      acc.errors.push({
        sheet: SHEET_USERS, row: r, column: '角色',
        message: '不支持导入管理员账号，请联系系统维护人员手动创建',
      });
      bad = true;
    }

    if (raw.username) {
      if (seen.has(raw.username)) {
        acc.errors.push({ sheet: SHEET_USERS, row: r, column: '账号', message: '账号「' + raw.username + '」在表内重复（第 ' + seen.get(raw.username) + ' 行已出现）' });
        bad = true;
      } else {
        seen.set(raw.username, r);
      }
    }

    if (bad) continue;

    const useDefaultPassword = raw.password === '';
    if (useDefaultPassword) {
      acc.warnings.push({ sheet: SHEET_USERS, row: r, column: '初始密码', message: '账号「' + raw.username + '」未填密码，已使用默认密码 ' + DEFAULT_IMPORT_PASSWORD });
    }
    users.push({
      username: raw.username,
      name: raw.name,
      role,
      password: useDefaultPassword ? DEFAULT_IMPORT_PASSWORD : raw.password,
      usedDefaultPassword: useDefaultPassword,
      _row: r,
    });
  }
  return users;
}

/**
 * 解析「订单」工作表。
 * @param {*} sheet exceljs Worksheet
 * @param {{errors: Array, warnings: Array}} acc 错误/警告累加器
 * @returns {Array<object>} 解析出的订单行
 */
function parseOrdersSheet(sheet, acc) {
  const orders = [];
  const { map, missing } = buildHeaderMap(sheet, ORDER_COLUMNS);
  if (missing.length > 0) {
    acc.errors.push({ sheet: SHEET_ORDERS, row: 1, column: missing.join('、'), message: '缺少必需列：' + missing.join('、') });
    return orders;
  }
  const seen = new Map();
  const lastRow = sheet.rowCount || 1;
  let validCount = 0;

  for (let r = 2; r <= lastRow; r++) {
    const row = sheet.getRow(r);
    if (isBlankRow(row, map)) continue;

    const rawCells = {};
    for (const col of ORDER_COLUMNS) {
      rawCells[col.field] = map[col.field] ? cellValue(row.getCell(map[col.field])) : null;
    }
    const rawText = {};
    for (const col of ORDER_COLUMNS) rawText[col.field] = s(rawCells[col.field]);
    if (isSampleRow(rawText, ORDER_SAMPLE, ORDER_COLUMNS)) continue;

    validCount++;
    if (validCount > MAX_IMPORT_ROWS) {
      acc.errors.push({ sheet: SHEET_ORDERS, row: r, column: '-', message: '单次导入每张表不得超过 ' + MAX_IMPORT_ROWS + ' 行' });
      break;
    }

    let bad = false;
    const item = { _row: r };

    for (const col of ORDER_COLUMNS) {
      const rawValue = rawCells[col.field];
      const text = rawText[col.field];

      if (col.required && text === '') {
        acc.errors.push({ sheet: SHEET_ORDERS, row: r, column: col.header, message: col.header + '不能为空' });
        bad = true;
        continue;
      }

      switch (col.type) {
        case 'phone':
          item[col.field] = normalizePhone(rawValue);
          break;
        case 'enum': {
          const v = fromCN(CN_MAPS[col.cnMap], text);
          if (v === undefined) {
            const allowed = Object.values(CN_MAPS[col.cnMap]).filter(Boolean).join(' / ');
            acc.errors.push({ sheet: SHEET_ORDERS, row: r, column: col.header, message: col.header + '必须为 ' + allowed + '，当前值「' + text + '」' });
            bad = true;
          } else {
            item[col.field] = v;
          }
          break;
        }
        case 'date': {
          const v = parseBJ(rawValue);
          if (v === undefined) {
            acc.errors.push({ sheet: SHEET_ORDERS, row: r, column: col.header, message: col.header + '格式无法识别，应为 YYYY-MM-DD HH:mm，当前值「' + text + '」' });
            bad = true;
          } else {
            item[col.field] = v;
          }
          break;
        }
        case 'money': {
          const v = parseNumber(rawValue);
          if (v === undefined) {
            acc.errors.push({ sheet: SHEET_ORDERS, row: r, column: col.header, message: col.header + '必须为数字，当前值「' + text + '」' });
            bad = true;
          } else if (v !== null && v < 0 && !col.allowNegative) {
            acc.errors.push({ sheet: SHEET_ORDERS, row: r, column: col.header, message: col.header + '不能为负数，当前值「' + text + '」' });
            bad = true;
          } else {
            item[col.field] = v === null ? 0 : v;
          }
          break;
        }
        case 'int': {
          const v = parseNumber(rawValue);
          if (v === undefined) {
            acc.errors.push({ sheet: SHEET_ORDERS, row: r, column: col.header, message: col.header + '必须为数字，当前值「' + text + '」' });
            bad = true;
          } else if (v !== null && v < 0) {
            acc.errors.push({ sheet: SHEET_ORDERS, row: r, column: col.header, message: col.header + '不能为负数，当前值「' + text + '」' });
            bad = true;
          } else {
            item[col.field] = v === null ? 0 : Math.trunc(v);
          }
          break;
        }
        default:
          item[col.field] = text;
      }
    }

    if (item.orderNo) {
      if (seen.has(item.orderNo)) {
        acc.errors.push({ sheet: SHEET_ORDERS, row: r, column: '订单编号', message: '订单编号「' + item.orderNo + '」在表内重复（第 ' + seen.get(item.orderNo) + ' 行已出现）' });
        bad = true;
      } else {
        seen.set(item.orderNo, r);
      }
    }

    if (bad) continue;

    // A9 铁律：合计恒等于 活体 + 用品，导入时重算，不信任表内值；利润永不参与合计
    item.dealAmount = (Number(item.dealLiveAmount) || 0) + (Number(item.dealSupplyAmount) || 0);
    orders.push(item);
  }
  return orders;
}

/**
 * 解析导入工作簿：定位工作表 → 建表头映射 → 逐行校验。只解析与校验，不写库。
 * @param {Buffer} buffer xlsx 文件内容
 * @returns {Promise<{users: Array<object>, orders: Array<object>, errors: Array<object>, warnings: Array<object>}>}
 * @throws {Error} 文件无法解析时抛出 code='PARSE_FAILED'；缺少两个数据表时抛出 code='NO_SHEET'
 */
async function parseImportWorkbook(buffer) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch (e) {
    const err = new Error('文件解析失败，请确认为有效的 Excel 文件');
    err.code = 'PARSE_FAILED';
    throw err;
  }

  const userSheet = wb.getWorksheet(SHEET_USERS);
  const orderSheet = wb.getWorksheet(SHEET_ORDERS);
  if (!userSheet && !orderSheet) {
    const err = new Error('未找到「' + SHEET_USERS + '」或「' + SHEET_ORDERS + '」工作表');
    err.code = 'NO_SHEET';
    throw err;
  }

  const acc = { errors: [], warnings: [] };
  const users = userSheet ? parseUsersSheet(userSheet, acc) : [];
  const orders = orderSheet ? parseOrdersSheet(orderSheet, acc) : [];
  return { users, orders, errors: acc.errors, warnings: acc.warnings };
}

module.exports = {
  ORDER_COLUMNS,
  USER_COLUMNS,
  VISIT_STATUS_CN,
  DEAL_STATUS_CN,
  ROLE_CN,
  CN_MAPS,
  IMPORTABLE_ROLES,
  DEFAULT_IMPORT_PASSWORD,
  MAX_IMPORT_ROWS,
  TZ_OFFSET_MS,
  SHEET_USERS,
  SHEET_ORDERS,
  SHEET_README,
  fmtBJ,
  bjDateKey,
  parseBJ,
  toCN,
  fromCN,
  normalizePhone,
  parseNumber,
  buildOrdersWorkbook,
  buildTemplateWorkbook,
  parseImportWorkbook,
};
