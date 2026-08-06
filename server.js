const express = require('express');
const session = require('express-session');
const path = require('path');
const config = require('./config');
const phoneCity = require('./phoneCity');

const app = express();
const PORT = process.env.PORT || config.port;
const SESSION_SECRET = process.env.SESSION_SECRET || config.sessionSecret;

const FIXED_SOURCES = ['美团', '百度', '高德'];
const FIXED_PRODUCTS = [];
const SUGGESTION_THRESHOLD = 5;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: SESSION_SECRET, resave: false, saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 }
}));

// ====== DATA LAYER (CloudBase DB or local JSON) ======
let db = null; // CloudBase database instance

function initCloudBase() {
  try {
    if (process.env.TCB_ENV_ID) {
      const tcb = require('@cloudbase/node-sdk');
      const tcbApp = tcb.init({ env: process.env.TCB_ENV_ID });
      db = tcbApp.database();
      console.log('CloudBase database connected: ' + process.env.TCB_ENV_ID);
      return true;
    }
  } catch (e) { console.log('CloudBase init error:', e.message); }
  return false;
}

// In-memory cache for local fallback
let localData = {};
function initLocal() {
  const fs = require('fs');
  const dir = path.join(__dirname, 'data');
  const files = { orders: 'orders.json', users: 'users.json', suggestions: 'suggestions.json' };
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  for (const [key, file] of Object.entries(files)) {
    const filePath = path.join(dir, file);
    if (!fs.existsSync(filePath)) {
      const defaults = key === 'users' ? config.defaultUsers :
        key === 'suggestions' ? { sources: {}, products: {}, stores: {} } : [];
      fs.writeFileSync(filePath, JSON.stringify(defaults, null, 2));
    }
    localData[key] = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  }
  console.log('Using local JSON storage');
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
    } catch (e) { console.log('DB error, falling back to local'); }
  }
  return localData[name];
}

async function readAll(name) {
  if (db) {
    try {
      if (name === 'suggestions') {
        const doc = (await db.collection(name).limit(1).get()).data[0];
        return doc ? { sources: doc.sources || {}, products: doc.products || {}, stores: doc.stores || {} } : { sources: {}, products: {}, stores: {} };
      }
      const res = await db.collection(name).limit(1000).get();
      return res.data || [];
    } catch (e) { console.log('readAll error, using local'); }
  }
  return Array.isArray(localData[name]) ? [...localData[name]] : { ...localData[name] };
}

async function writeAll(name, data) {
  if (db) {
    try {
      if (name === 'suggestions') {
        const coll = db.collection(name);
        const docs = (await coll.limit(1).get()).data;
        if (docs.length > 0) await coll.doc(docs[0]._id).update(data);
        else await coll.add(data);
        return;
      }
      const coll = db.collection(name);
      const existing = (await coll.limit(1000).get()).data;
      for (const doc of existing) await coll.doc(doc._id).remove();
      for (const item of data) await coll.add(item);
      return;
    } catch (e) { console.log('writeAll error, using local'); }
  }
  const fs = require('fs');
  const file = path.join(__dirname, 'data', name + '.json');
  localData[name] = data;
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

async function addItem(name, item) {
  if (db) {
    try {
      return (await db.collection(name).add(item)).id;
    } catch (e) { console.log('addItem error'); }
  }
  localData[name].push(item);
  await writeAll(name, localData[name]);
  return item.id || item._id;
}

async function updateItem(name, id, updates) {
  if (db) {
    try {
      await db.collection(name).doc(id).update(updates);
      return;
    } catch (e) { console.log('updateItem error'); }
  }
  const idx = localData[name].findIndex(i => i.id === id);
  if (idx >= 0) { Object.assign(localData[name][idx], updates); await writeAll(name, localData[name]); }
}

async function removeItem(name, id) {
  if (db) {
    try { await db.collection(name).doc(id).remove(); return; } catch (e) {}
  }
  localData[name] = localData[name].filter(i => i.id !== id);
  await writeAll(name, localData[name]);
}

async function findById(name, id) {
  if (db) {
    try { return (await db.collection(name).doc(id).get()).data[0] || null; } catch (e) { return null; }
  }
  return localData[name].find(i => i.id === id) || null;
}

// ====== INIT ======
const usingDb = initCloudBase();
if (!usingDb) { initLocal(); }

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

async function trackSuggestion(type, value, city) {
  if (!value || value.trim() === '') return;
  const data = await readAll('suggestions');
  const key = (type === 'stores' && city) ? city + '|' + value : value;
  if (!data[type]) data[type] = {};
  data[type][key] = (data[type][key] || 0) + 1;
  await writeAll('suggestions', data);
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
  const { username, password, name, phone } = req.body;
  if (!username || !password || !name) return res.status(400).json({ error: '请填写' });
  const users = await readAll('users');
  if (users.find(u => u.username === username)) return res.status(400).json({ error: '账号已存在' });
  const n = { id: 'u' + Date.now(), username, password, role: 'sales', name, phone: phone || '', createdAt: new Date().toISOString() };
  await addItem('users', n);
  res.json({ success: true });
});
app.put('/api/users/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const { name, phone, password } = req.body;
  const u = await findById('users', req.params.id);
  if (!u) return res.status(404).json({ error: '不存在' });
  const up = {}; if (name) u.name = name; if (phone !== undefined) u.phone = phone; if (password) u.password = password;
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

// Orders
app.get('/api/orders', requireAuth, async (req, res) => {
  let orders = await readAll('orders');
  const user = req.session.user;
  orders = user.role === 'admin' ? orders :
    user.role === 'sales' ? orders.filter(o => o.salesPersonId === user.id) :
    orders.filter(o => o.visitStatus === 'visited' || o.visitStatus === 'pending_visit');
  orders.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ orders });
});

app.post('/api/orders', requireAuth, requireRole('admin', 'sales'), async (req, res) => {
  const { custName, custPhone, custSource, custProduct, custNote, custCity, storeAddress } = req.body;
  if (!custName || !custPhone) return res.status(400).json({ error: '请填写姓名和电话' });
  const orders = await readAll('orders');
  const now = new Date().toISOString();
  const order = {
    id: 'ORD' + Date.now(),
    orderNo: 'SO' + new Date().getFullYear() + String(new Date().getMonth()+1).padStart(2,'0') + String(new Date().getDate()).padStart(2,'0') + String(orders.length+1).padStart(4,'0'),
    custName, custPhone, custCity: custCity || '', custSource: custSource || '', custProduct: custProduct || '',
    storeAddress: storeAddress || '', custNote: custNote || '',
    salesPersonId: req.session.user.id, salesPersonName: req.session.user.name,
    visitStatus: null, visitAt: null, followCount: 0, lastFollowAt: null, followNote: null,
    dealStatus: null, dealAmount: null, dealLiveAmount: null, dealSupplyAmount: null, dealProfit: null,
    dealAt: null, dealNote: null, createdAt: now,
  };
  await addItem('orders', order);
  if (custSource) trackSuggestion('sources', custSource);
  if (custProduct) trackSuggestion('products', custProduct);
  if (storeAddress && custCity) trackSuggestion('stores', storeAddress, custCity);
  res.json({ success: true, order });
});

app.put('/api/orders/:id', requireAuth, async (req, res) => {
  const orders = await readAll('orders');
  const idx = orders.findIndex(o => o.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '不存在' });
  const o = orders[idx];
  if (req.session.user.role === 'sales' && o.salesPersonId !== req.session.user.id) return res.status(403).json({ error: '只能操作自己的' });
  ['custName','custPhone','custSource','custProduct','custNote','custCity','storeAddress'].forEach(f => { if (req.body[f] !== undefined) o[f] = req.body[f]; });
  await updateItem('orders', req.params.id, o);
  if (req.body.custSource) trackSuggestion('sources', req.body.custSource);
  if (req.body.custProduct) trackSuggestion('products', req.body.custProduct);
  if (req.body.storeAddress && o.custCity) trackSuggestion('stores', req.body.storeAddress, o.custCity);
  res.json({ success: true, order: o });
});

app.post('/api/orders/:id/follow', requireAuth, requireRole('admin', 'sales'), async (req, res) => {

// Sales 一键报单：设置即将到店
app.post('/api/orders/:id/report', requireAuth, requireRole('admin', 'sales'), async (req, res) => {
  const o = await findById('orders', req.params.id);
  if (!o) return res.status(404).json({ error: '不存在' });
  if (o.visitStatus !== null && o.visitStatus !== 'pending_visit') return res.status(400).json({ error: '已处理' });
  if (req.session.user.role === 'sales' && o.salesPersonId !== req.session.user.id) return res.status(403).json({ error: '只能操作自己的' });
  const now = new Date().toISOString();
  o.visitStatus = 'pending_visit';
  o.lastFollowAt = now;
  o.followCount = (o.followCount || 0) + 1;
  await updateItem('orders', req.params.id, o);
  res.json({ success: true, order: o });
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
  await updateItem('orders', req.params.id, o);
  res.json({ success: true, order: o });
});

app.post('/api/orders/:id/deal', requireAuth, requireRole('admin', 'finance'), async (req, res) => {
  const o = await findById('orders', req.params.id);
  if (!o) return res.status(404).json({ error: '不存在' });
  if (o.visitStatus !== 'visited') return res.status(400).json({ error: '未到店' });
  if (o.dealStatus !== null) return res.status(400).json({ error: '已处理' });
  const { dealStatus, liveAmount, supplyAmount, note } = req.body; const now = new Date().toISOString();
  o.dealStatus = dealStatus;
  if (dealStatus === 'closed') {
    o.dealLiveAmount = liveAmount || 0; o.dealSupplyAmount = supplyAmount || 0;
    o.dealAmount = (liveAmount || 0) + (supplyAmount || 0);
  } else o.dealAmount = 0;
  o.dealAt = now; o.dealNote = note || '';
  await updateItem('orders', req.params.id, o);
  res.json({ success: true, order: o });
});

// Stats
app.get('/api/stats', requireAuth, requireRole('admin'), async (req, res) => {
  const orders = await readAll('orders'); const now = new Date();
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
  for (let i=6;i>=0;i--) { const d=new Date(now); d.setDate(d.getDate()-i); const dayO=orders.filter(o=>{const od=new Date(o.createdAt);return od.getFullYear()===d.getFullYear()&&od.getMonth()===d.getMonth()&&od.getDate()===d.getDate();}); const c=dayO.filter(o=>o.dealStatus==='closed'); trend.push({label:`${d.getMonth()+1}/${d.getDate()}`,orders:dayO.length,visited:dayO.filter(o=>o.visitStatus==='visited').length,closed:c.length,revenue:c.reduce((s,o)=>s+(o.dealAmount||0),0)}); }
  const sm = {};
  orders.forEach(o => { if(!sm[o.salesPersonId])sm[o.salesPersonId]={id:o.salesPersonId,name:o.salesPersonName,total:0,visited:0,closed:0,revenue:0,liveRevenue:0,supplyRevenue:0}; sm[o.salesPersonId].total++; if(o.visitStatus==='visited')sm[o.salesPersonId].visited++; if(o.dealStatus==='closed'){sm[o.salesPersonId].closed++;sm[o.salesPersonId].revenue+=(o.dealAmount||0);sm[o.salesPersonId].liveRevenue+=(o.dealLiveAmount||0);sm[o.salesPersonId].supplyRevenue+=(o.dealSupplyAmount||0);} });
  res.json({ stats, trend, ranking: Object.values(sm).sort((a,b)=>b.revenue-a.revenue) });
});

app.get('/api/cityStats', requireAuth, requireRole('admin'), async (req, res) => {
  const orders = await readAll('orders'); const map = {};
  orders.forEach(o => { const c = o.custCity || '未知'; if(!map[c])map[c]={city:c,orders:0,visited:0,closed:0}; map[c].orders++; if(o.visitStatus==='visited')map[c].visited++; if(o.dealStatus==='closed')map[c].closed++; });
  res.json({ cities: Object.values(map).sort((a,b)=>b.orders-a.orders) });
});

app.get('/api/export', requireAuth, requireRole('admin'), async (req, res) => {
  res.setHeader('Content-Type','application/json');
  res.setHeader('Content-Disposition','attachment; filename=export-'+new Date().toISOString().slice(0,10)+'.json');
  res.json({ exportTime: new Date().toISOString(), orders: await readAll('orders'), users: await readAll('users'), suggestions: await readAll('suggestions') });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/healthz', (req, res) => res.status(200).send('ok'));

app.listen(PORT, '0.0.0.0', () => console.log(`系统已启动: ${PORT}, ${usingDb ? 'CloudBase数据库' : '本地JSON存储'}`));
