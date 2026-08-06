const express = require('express');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const app = express();
const PORT = config.port;

// 数据目录
const DATA_DIR = path.join(__dirname, 'data');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SUGGESTIONS_FILE = path.join(DATA_DIR, 'suggestions.json');

// 固定预设
const FIXED_SOURCES = ['美团', '百度', '高德'];
const FIXED_PRODUCTS = [];
const SUGGESTION_THRESHOLD = 5;

// 中间件
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 } // 8小时
}));

// ====== 初始化数据 ======
if (!fs.existsSync(ORDERS_FILE)) fs.writeFileSync(ORDERS_FILE, '[]');
if (!fs.existsSync(USERS_FILE)) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(config.defaultUsers, null, 2));
}
if (!fs.existsSync(SUGGESTIONS_FILE)) {
  fs.writeFileSync(SUGGESTIONS_FILE, JSON.stringify({ sources: {}, products: {} }, null, 2));
}

// 智能建议：记录手动输入并返回超过阈值的
function trackSuggestion(type, value) {
  if (!value || value.trim() === '') return;
  const fixed = type === 'sources' ? FIXED_SOURCES : FIXED_PRODUCTS;
  if (fixed.includes(value)) return;
  const data = readJSON(SUGGESTIONS_FILE);
  if (!data[type]) data[type] = {};
  data[type][value] = (data[type][value] || 0) + 1;
  writeJSON(SUGGESTIONS_FILE, data);
}

function getSuggestions(type) {
  const data = readJSON(SUGGESTIONS_FILE);
  const fixed = type === 'sources' ? FIXED_SOURCES : FIXED_PRODUCTS;
  const counts = data[type] || {};
  const smart = Object.entries(counts)
    .filter(([_, count]) => count >= SUGGESTION_THRESHOLD)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
  return { fixed, smart };
}

function readJSON(file) {
  try {
    const data = fs.readFileSync(file, 'utf-8');
    return JSON.parse(data);
  } catch { return []; }
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ====== 鉴权中间件 ======
function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: '请先登录' });
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user) return res.status(401).json({ error: '请先登录' });
    if (!roles.includes(req.session.user.role)) {
      return res.status(403).json({ error: '无权限访问' });
    }
    next();
  };
}

// ====== 智能建议接口 ======
app.get('/api/suggestions', requireAuth, (req, res) => {
  const sources = getSuggestions('sources');
  const products = getSuggestions('products');
  res.json({ sources, products });
});

// ====== 认证接口 ======
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  const users = readJSON(USERS_FILE);
  const user = users.find(u => u.username === username && u.password === password);
  if (!user) {
    return res.status(401).json({ error: '账号或密码错误' });
  }
  req.session.user = { id: user.id, username: user.username, role: user.role, name: user.name };
  res.json({ success: true, user: req.session.user });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.session.user });
});

// ====== 用户管理（仅管理员） ======
app.get('/api/users', requireAuth, requireRole('admin'), (req, res) => {
  const users = readJSON(USERS_FILE).map(u => ({
    id: u.id, username: u.username, role: u.role, name: u.name, phone: u.phone || '',
    createdAt: u.createdAt || ''
  }));
  res.json({ users });
});

app.post('/api/users', requireAuth, requireRole('admin'), (req, res) => {
  const { username, password, name, phone } = req.body;
  if (!username || !password || !name) {
    return res.status(400).json({ error: '请填写完整信息' });
  }
  const users = readJSON(USERS_FILE);
  if (users.find(u => u.username === username)) {
    return res.status(400).json({ error: '账号已存在' });
  }
  const newUser = {
    id: 'u' + Date.now(),
    username, password, role: 'sales', name, phone: phone || '',
    createdAt: new Date().toISOString()
  };
  users.push(newUser);
  writeJSON(USERS_FILE, users);
  res.json({ success: true, user: { id: newUser.id, username, role: 'sales', name, phone: newUser.phone } });
});

app.put('/api/users/:id', requireAuth, requireRole('admin'), (req, res) => {
  const { name, phone, password } = req.body;
  const users = readJSON(USERS_FILE);
  const idx = users.findIndex(u => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '用户不存在' });
  if (name) users[idx].name = name;
  if (phone !== undefined) users[idx].phone = phone;
  if (password) users[idx].password = password;
  writeJSON(USERS_FILE, users);
  res.json({ success: true, user: { id: users[idx].id, username: users[idx].username, role: users[idx].role, name: users[idx].name, phone: users[idx].phone } });
});

app.delete('/api/users/:id', requireAuth, requireRole('admin'), (req, res) => {
  if (req.params.id === req.session.user.id) {
    return res.status(400).json({ error: '不能删除自己' });
  }
  let users = readJSON(USERS_FILE);
  const user = users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  if (user.role === 'admin') return res.status(400).json({ error: '不能删除管理员' });
  users = users.filter(u => u.id !== req.params.id);
  writeJSON(USERS_FILE, users);
  res.json({ success: true });
});

// ====== 订单接口 ======
// 销售：只能看自己创建的订单
// 财务：可以看所有已到店的订单
// 管理员：看全部

app.get('/api/orders', requireAuth, (req, res) => {
  const orders = readJSON(ORDERS_FILE);
  const user = req.session.user;

  let filtered;
  if (user.role === 'admin') {
    filtered = orders;
  } else if (user.role === 'sales') {
    filtered = orders.filter(o => o.salesPersonId === user.id);
  } else if (user.role === 'finance') {
    filtered = orders.filter(o => o.visitStatus === 'visited');
  } else {
    filtered = [];
  }

  filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ orders: filtered });
});

app.post('/api/orders', requireAuth, requireRole('admin', 'sales'), (req, res) => {
  const { custName, custPhone, custSource, custProduct, custNote } = req.body;
  if (!custName || !custPhone) {
    return res.status(400).json({ error: '请填写客户姓名和电话' });
  }
  const orders = readJSON(ORDERS_FILE);
  const now = new Date().toISOString();
  const orderNo = 'SO' + new Date().getFullYear() +
    String(new Date().getMonth()+1).padStart(2,'0') +
    String(new Date().getDate()).padStart(2,'0') +
    String(orders.length + 1).padStart(4,'0');

  const order = {
    id: 'ORD' + Date.now(),
    orderNo,
    custName, custPhone, custSource: custSource || '线上推广',
    custProduct: custProduct || '', custNote: custNote || '',
    salesPersonId: req.session.user.id,
    salesPersonName: req.session.user.name,
    visitStatus: null,
    visitAt: null,
    followCount: 0,
    lastFollowAt: null,
    followNote: null,
    dealStatus: null,
    dealAmount: null,
    dealAt: null,
    dealNote: null,
    createdAt: now,
  };
  orders.push(order);
  writeJSON(ORDERS_FILE, orders);

  // 追踪智能建议
  if (custSource) trackSuggestion('sources', custSource);
  if (custProduct) trackSuggestion('products', custProduct);

  res.json({ success: true, order });
});

app.put('/api/orders/:id', requireAuth, (req, res) => {
  const orders = readJSON(ORDERS_FILE);
  const idx = orders.findIndex(o => o.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '订单不存在' });

  const o = orders[idx];
  const user = req.session.user;

  // 权限检查
  if (user.role === 'sales' && o.salesPersonId !== user.id) {
    return res.status(403).json({ error: '只能操作自己的订单' });
  }

  // 更新基本字段
  const { custName, custPhone, custSource, custProduct, custNote } = req.body;
  if (custName !== undefined) o.custName = custName;
  if (custPhone !== undefined) o.custPhone = custPhone;
  if (custSource !== undefined) o.custSource = custSource;
  if (custProduct !== undefined) o.custProduct = custProduct;
  if (custNote !== undefined) o.custNote = custNote;

  writeJSON(ORDERS_FILE, orders);
  // 追踪建议
  if (custSource) trackSuggestion('sources', custSource);
  if (custProduct) trackSuggestion('products', custProduct);
  res.json({ success: true, order: o });
});

// 销售跟进
app.post('/api/orders/:id/follow', requireAuth, requireRole('admin', 'sales'), (req, res) => {
  const orders = readJSON(ORDERS_FILE);
  const idx = orders.findIndex(o => o.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '订单不存在' });

  const o = orders[idx];
  if (o.visitStatus !== null || o.dealStatus !== null) {
    return res.status(400).json({ error: '该订单已处理，无需再次跟进' });
  }
  if (req.session.user.role === 'sales' && o.salesPersonId !== req.session.user.id) {
    return res.status(403).json({ error: '只能跟进自己的订单' });
  }

  const { note, visitStatus } = req.body;
  const now = new Date().toISOString();
  o.followCount = (o.followCount || 0) + 1;
  o.lastFollowAt = now;
  o.followNote = note || '';

  if (visitStatus === 'visited') { o.visitStatus = 'visited'; o.visitAt = now; }
  else if (visitStatus === 'not_visited') { o.visitStatus = 'not_visited'; }

  writeJSON(ORDERS_FILE, orders);
  res.json({ success: true, order: o });
});

// 财务确认成交
app.post('/api/orders/:id/deal', requireAuth, requireRole('admin', 'finance'), (req, res) => {
  const orders = readJSON(ORDERS_FILE);
  const idx = orders.findIndex(o => o.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '订单不存在' });

  const o = orders[idx];
  if (o.visitStatus !== 'visited') {
    return res.status(400).json({ error: '该订单客户尚未到店' });
  }
  if (o.dealStatus !== null) {
    return res.status(400).json({ error: '该订单已处理过成交状态' });
  }

  const { dealStatus, amount, note } = req.body;
  const now = new Date().toISOString();
  o.dealStatus = dealStatus;
  o.dealAmount = dealStatus === 'closed' ? (amount || 0) : 0;
  o.dealAt = now;
  o.dealNote = note || '';

  writeJSON(ORDERS_FILE, orders);
  res.json({ success: true, order: o });
});

// 统计看板（仅管理员）
app.get('/api/stats', requireAuth, requireRole('admin'), (req, res) => {
  const orders = readJSON(ORDERS_FILE);
  const now = new Date();

  const isToday = (d) => {
    const dt = new Date(d); return dt.getFullYear()===now.getFullYear()&&dt.getMonth()===now.getMonth()&&dt.getDate()===now.getDate();
  };
  const isThisWeek = (d) => {
    const dt = new Date(d); const day = now.getDay()||7;
    const mon = new Date(now); mon.setDate(now.getDate()-day+1); mon.setHours(0,0,0,0);
    const sun = new Date(mon); sun.setDate(mon.getDate()+6); sun.setHours(23,59,59,999);
    return dt>=mon&&dt<=sun;
  };
  const isThisMonth = (d) => {
    const dt = new Date(d); return dt.getFullYear()===now.getFullYear()&&dt.getMonth()===now.getMonth();
  };

  const stats = {};
  for (const period of ['today','week','month','all']) {
    let filtered;
    if (period==='today') filtered = orders.filter(o => isToday(o.createdAt));
    else if (period==='week') filtered = orders.filter(o => isThisWeek(o.createdAt));
    else if (period==='month') filtered = orders.filter(o => isThisMonth(o.createdAt));
    else filtered = orders;

    stats[period] = {
      total: filtered.length,
      visited: filtered.filter(o => o.visitStatus==='visited').length,
      notVisited: filtered.filter(o => o.visitStatus==='not_visited').length,
      closed: filtered.filter(o => o.dealStatus==='closed').length,
      notClosed: filtered.filter(o => o.dealStatus==='not_closed').length,
      revenue: filtered.filter(o => o.dealStatus==='closed').reduce((s,o) => s+(o.dealAmount||0), 0),
    };
  }

  // 近7天趋势
  const trend = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now); d.setDate(d.getDate() - i);
    const dayOrders = orders.filter(o => {
      const oDate = new Date(o.createdAt);
      return oDate.getFullYear()===d.getFullYear()&&oDate.getMonth()===d.getMonth()&&oDate.getDate()===d.getDate();
    });
    trend.push({
      label: `${d.getMonth()+1}/${d.getDate()}`,
      orders: dayOrders.length,
      visited: dayOrders.filter(o => o.visitStatus==='visited').length,
      closed: dayOrders.filter(o => o.dealStatus==='closed').length,
      revenue: dayOrders.filter(o => o.dealStatus==='closed').reduce((s,o) => s+(o.dealAmount||0), 0),
    });
  }

  // 销售排名
  const salesMap = {};
  orders.forEach(o => {
    const key = o.salesPersonId;
    if (!salesMap[key]) salesMap[key] = { id: key, name: o.salesPersonName, total: 0, visited: 0, closed: 0, revenue: 0 };
    salesMap[key].total++;
    if (o.visitStatus === 'visited') salesMap[key].visited++;
    if (o.dealStatus === 'closed') { salesMap[key].closed++; salesMap[key].revenue += (o.dealAmount||0); }
  });
  const ranking = Object.values(salesMap).sort((a,b) => b.revenue - a.revenue);

  res.json({ stats, trend, ranking });
});

// 数据导出（仅管理员）
app.get('/api/export', requireAuth, requireRole('admin'), (req, res) => {
  const orders = readJSON(ORDERS_FILE);
  const users = readJSON(USERS_FILE).map(u => ({ id: u.id, username: u.username, role: u.role, name: u.name }));
  const suggestions = readJSON(SUGGESTIONS_FILE);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename=export-' + new Date().toISOString().slice(0,10) + '.json');
  res.json({ exportTime: new Date().toISOString(), orders, users, suggestions });
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`销售订单管理系统已启动: http://0.0.0.0:${PORT}`);
});
