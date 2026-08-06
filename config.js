// 默认账号配置
module.exports = {
  // 预设账号
  defaultUsers: [
    { id: 'u1', username: 'admin', password: 'admin123', role: 'admin', name: '管理员', phone: '' },
    { id: 'u2', username: 'sales', password: 'sales123', role: 'sales', name: '销售员', phone: '' },
    { id: 'u3', username: 'finance', password: 'finance123', role: 'finance', name: '财务', phone: '' },
  ],
  // 服务器端口
  port: 3000,
  // 会话密钥
  sessionSecret: 'sales-order-system-secret-key-2026',
};
