const express = require('express');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const phoneCity = require('./phoneCity');

const app = express();
const PORT = process.env.PORT || config.port;
const SESSION_SECRET = process.env.SESSION_SECRET || config.sessionSecret;

const DATA_DIR = path.join(__dirname, 'data');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SUGGESTIONS_FILE = path.join(DATA_DIR, 'suggestions.json');
const FIXED_SOURCES = ['美团', '百度', '高德'];
const FIXED_PRODUCTS = [];
const SUGGESTION_THRESHOLD = 5;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: SESSION_SECRET, resave: false, saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 }
}));

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(ORDERS_FILE)) fs.writeFileSync(ORDERS_FILE, '[]');
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, JSON.stringify(config.defaultUsers, null, 2));
if (!fs.existsSync(SUGGESTIONS_FILE)) fs.writeFileSync(SUGGESTIONS_FILE, JSON.stringify({ sources:{}, products:{}, stores:{} }, null, 2));

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return []; }
}
function writeJSON(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

function trackSuggestion(type, value) {
  if (!value || value.trim() === '') return;
  const data = readJSON(SUGGESTIONS_FILE);
  if (!data[type]) data[type] = {};
  data[type][value] = (data[type][value] || 0) + 1;
  writeJSON(SUGGESTIONS_FILE, data);
}

function getSuggestions(type, city) {
  const data = readJSON(SUGGESTIONS_FILE);
  let fixed = type === 'sources' ? FIXED_SOURCES : FIXED_PRODUCTS;
  const counts = data[type] || {};
  // For stores, filter by city prefix
  let entries = Object.entries(counts);
  if (type === 'stores' && city) {
    entries = entries.filter(([k]) => k.startsWith(city + '|'));
  }
  const smart = entries
    .filter(([_, c]) => c >= SUGGESTION_THRESHOLD)
    .map(([name, c]) => ({ name: type === 'stores' ? name.replace(/^[^|]*\|/, '') : name, count: c }))
    .sort((a, b) => b.count - a.count);
  return { fixed, smart };
}

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
  const phone = req.query.phone || '';
  const city = phoneCity.lookup(phone);
  res.json({ city });
});

app.get('/api/suggestions', requireAuth, (req, res) => {
  const city = req.query.city || '';
  res.json({
    sources: getSuggestions('sources'),
    products: getSuggestions('products'),
    stores: getSuggestions('stores', city),
  });
});

// Auth
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  const users = readJSON(USERS_FILE);
  const user = users.find(u => u.username === username && u.password === password);
  if (!user) return res.status(401).json({ error: '账号或密码错误' });
  req.session.user = { id: user.id, username: user.username, role: user.role, name: user.name };
  res.json({ success: true, user: req.session.user });
});
app.post('/api/auth/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });
app.get('/api/auth/me', requireAuth, (req, res) => { res.json({ user: req.session.user }); });

// Users (admin)
app.get('/api/users', requireAuth, requireRole('admin'), (req, res) => {
  res.json({ users: readJSON(USERS_FILE).map(u => ({ id: u.id, username: u.username, role: u.role, name: u.name, phone: u.phone || '', createdAt: u.createdAt || '' })) });
});
app.post('/api/users', requireAuth, requireRole('admin'), (req, res) => {
  const { username, password, name, phone } = req.body;
  if (!username || !password || !name) return res.status(400).json({ error: '请填写完整信息' });
  const users = readJSON(USERS_FILE);
  if (users.find(u => u.username === username)) return res.status(400).json({ error: '账号已存在' });
  users.push({ id: 'u' + Date.now(), username, password, role: 'sales', name, phone: phone || '', createdAt: new Date().toISOString() });
  writeJSON(USERS_FILE, users);
  res.json({ success: true });
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
  res.json({ success: true });
});
app.delete('/api/users/:id', requireAuth, requireRole('admin'), (req, res) => {
  if (req.params.id === req.session.user.id) return res.status(400).json({ error: '不能删除自己' });
  let users = readJSON(USERS_FILE);
  const u = users.find(x => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  if (u.role === 'admin') return res.status(400).json({ error: '不能删除管理员' });
  users = users.filter(x => x.id !== req.params.id);
  writeJSON(USERS_FILE, users);
  res.json({ success: true });
});

// Orders
app.get('/api/orders', requireAuth, (req, res) => {
  const orders = readJSON(ORDERS_FILE);
  const user = req.session.user;
  let filtered = user.role === 'admin' ? orders :
    user.role === 'sales' ? orders.filter(o => o.salesPersonId === user.id) :
    orders.filter(o => o.visitStatus === 'visited');
  filtered.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ orders: filtered });
});

app.post('/api/orders', requireAuth, requireRole('admin', 'sales'), (req, res) => {
  const { custName, custPhone, custSource, custProduct, custNote, custCity, storeAddress } = req.body;
  if (!custName || !custPhone) return res.status(400).json({ error: '请填写客户姓名和电话' });
  const orders = readJSON(ORDERS_FILE);
  const now = new Date().toISOString();
  const orderNo = 'SO' + new Date().getFullYear() + String(new Date().getMonth()+1).padStart(2,'0') + String(new Date().getDate()).padStart(2,'0') + String(orders.length + 1).padStart(4,'0');
  const order = {
    id: 'ORD' + Date.now(), orderNo,
    custName, custPhone,
    custCity: custCity || '',
    custSource: custSource || '',
    custProduct: custProduct || '',
    storeAddress: storeAddress || '',
    custNote: custNote || '',
    salesPersonId: req.session.user.id,
    salesPersonName: req.session.user.name,
    visitStatus: null, visitAt: null, followCount: 0, lastFollowAt: null, followNote: null,
    dealStatus: null,
    dealAmount: null, dealLiveAmount: null, dealSupplyAmount: null, dealProfit: null,
    dealAt: null, dealNote: null,
    createdAt: now,
  };
  orders.push(order);
  writeJSON(ORDERS_FILE, orders);
  if (custSource) trackSuggestion('sources', custSource);
  if (custProduct) trackSuggestion('products', custProduct);
  if (storeAddress && custCity) trackSuggestion('stores', custCity + '|' + storeAddress);
  res.json({ success: true, order });
});

app.put('/api/orders/:id', requireAuth, (req, res) => {
  const orders = readJSON(ORDERS_FILE);
  const idx = orders.findIndex(o => o.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '订单不存在' });
  const o = orders[idx];
  if (req.session.user.role === 'sales' && o.salesPersonId !== req.session.user.id) return res.status(403).json({ error: '只能操作自己的订单' });
  const fields = ['custName','custPhone','custSource','custProduct','custNote','custCity','storeAddress'];
  fields.forEach(f => { if (req.body[f] !== undefined) o[f] = req.body[f]; });
  writeJSON(ORDERS_FILE, orders);
  if (req.body.custSource) trackSuggestion('sources', req.body.custSource);
  if (req.body.custProduct) trackSuggestion('products', req.body.custProduct);
  if (req.body.storeAddress && o.custCity) trackSuggestion('stores', o.custCity + '|' + req.body.storeAddress);
  res.json({ success: true, order: o });
});

app.post('/api/orders/:id/follow', requireAuth, requireRole('admin', 'sales'), (req, res) => {
  const orders = readJSON(ORDERS_FILE);
  const idx = orders.findIndex(o => o.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '订单不存在' });
  const o = orders[idx];
  if (o.visitStatus !== null || o.dealStatus !== null) return res.status(400).json({ error: '该订单已处理' });
  if (req.session.user.role === 'sales' && o.salesPersonId !== req.session.user.id) return res.status(403).json({ error: '只能跟进自己的订单' });
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

app.post('/api/orders/:id/deal', requireAuth, requireRole('admin', 'finance'), (req, res) => {
  const orders = readJSON(ORDERS_FILE);
  const idx = orders.findIndex(o => o.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '订单不存在' });
  const o = orders[idx];
  if (o.visitStatus !== 'visited') return res.status(400).json({ error: '该订单客户尚未到店' });
  if (o.dealStatus !== null) return res.status(400).json({ error: '该订单已处理过成交状态' });
  const { dealStatus, liveAmount, supplyAmount, profit, note } = req.body;
  const now = new Date().toISOString();
  o.dealStatus = dealStatus;
  if (dealStatus === 'closed') {
    o.dealLiveAmount = liveAmount || 0;
    o.dealSupplyAmount = supplyAmount || 0;
    o.dealProfit = profit || 0;
    o.dealAmount = (liveAmount || 0) + (supplyAmount || 0) + (profit || 0);
  } else {
    o.dealAmount = 0;
  }
  o.dealAt = now;
  o.dealNote = note || '';
  writeJSON(ORDERS_FILE, orders);
  res.json({ success: true, order: o });
});

// Stats (admin)
app.get('/api/stats', requireAuth, requireRole('admin'), (req, res) => {
  const orders = readJSON(ORDERS_FILE);
  const now = new Date();
  const isT = d => { const dt = new Date(d); return dt.getFullYear()===now.getFullYear()&&dt.getMonth()===now.getMonth()&&dt.getDate()===now.getDate(); };
  const isW = d => { const dt=new Date(d); const day=now.getDay()||7; const mon=new Date(now); mon.setDate(now.getDate()-day+1); mon.setHours(0,0,0,0); const sun=new Date(mon); sun.setDate(mon.getDate()+6); sun.setHours(23,59,59,999); return dt>=mon&&dt<=sun; };
  const isM = d => { const dt=new Date(d); return dt.getFullYear()===now.getFullYear()&&dt.getMonth()===now.getMonth(); };

  const stats = {};
  ['today','week','month','all'].forEach(p => {
    let f = p==='today'?orders.filter(o=>isT(o.createdAt)):p==='week'?orders.filter(o=>isW(o.createdAt)):p==='month'?orders.filter(o=>isM(o.createdAt)):orders;
    const closed = f.filter(o=>o.dealStatus==='closed');
    stats[p] = {
      total: f.length, visited: f.filter(o=>o.visitStatus==='visited').length,
      notVisited: f.filter(o=>o.visitStatus==='not_visited').length,
      closed: closed.length, notClosed: f.filter(o=>o.dealStatus==='not_closed').length,
      revenue: closed.reduce((s,o)=>s+(o.dealAmount||0),0),
      liveRevenue: closed.reduce((s,o)=>s+(o.dealLiveAmount||0),0),
      supplyRevenue: closed.reduce((s,o)=>s+(o.dealSupplyAmount||0),0),
      profit: closed.reduce((s,o)=>s+(o.dealProfit||0),0),
    };
  });

  const trend = [];
  for (let i=6;i>=0;i--) {
    const d = new Date(now); d.setDate(d.getDate()-i);
    const dayO = orders.filter(o=>{const od=new Date(o.createdAt);return od.getFullYear()===d.getFullYear()&&od.getMonth()===d.getMonth()&&od.getDate()===d.getDate();});
    const closed = dayO.filter(o=>o.dealStatus==='closed');
    trend.push({label:`${d.getMonth()+1}/${d.getDate()}`,orders:dayO.length,visited:dayO.filter(o=>o.visitStatus==='visited').length,closed:closed.length,revenue:closed.reduce((s,o)=>s+(o.dealAmount||0),0)});
  }

  const salesMap = {};
  orders.forEach(o => {
    if(!salesMap[o.salesPersonId]) salesMap[o.salesPersonId]={id:o.salesPersonId,name:o.salesPersonName,total:0,visited:0,closed:0,revenue:0,liveRevenue:0,supplyRevenue:0,profit:0};
    salesMap[o.salesPersonId].total++;
    if(o.visitStatus==='visited') salesMap[o.salesPersonId].visited++;
    if(o.dealStatus==='closed'){salesMap[o.salesPersonId].closed++;salesMap[o.salesPersonId].revenue+=(o.dealAmount||0);salesMap[o.salesPersonId].liveRevenue+=(o.dealLiveAmount||0);salesMap[o.salesPersonId].supplyRevenue+=(o.dealSupplyAmount||0);salesMap[o.salesPersonId].profit+=(o.dealProfit||0);}
  });
  res.json({ stats, trend, ranking: Object.values(salesMap).sort((a,b)=>b.revenue-a.revenue) });
});

// City stats for map
app.get('/api/cityStats', requireAuth, requireRole('admin'), (req, res) => {
  const orders = readJSON(ORDERS_FILE);
  const map = {};
  orders.forEach(o => {
    const c = o.custCity || '未知';
    if (!map[c]) map[c] = { city: c, orders: 0, visited: 0, closed: 0 };
    map[c].orders++;
    if (o.visitStatus === 'visited') map[c].visited++;
    if (o.dealStatus === 'closed') map[c].closed++;
  });
  res.json({ cities: Object.values(map).sort((a,b) => b.orders - a.orders) });
});

app.get('/api/export', requireAuth, requireRole('admin'), (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename=export-'+new Date().toISOString().slice(0,10)+'.json');
  res.json({ exportTime: new Date().toISOString(), orders: readJSON(ORDERS_FILE), users: readJSON(USERS_FILE), suggestions: readJSON(SUGGESTIONS_FILE) });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/healthz', (req, res) => res.status(200).send('ok'));

app.listen(PORT, '0.0.0.0', () => console.log(`销售订单管理系统已启动: http://0.0.0.0:${PORT}`));
