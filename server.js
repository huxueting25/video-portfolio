const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const { Readable } = require('stream');
const fs = require('fs');
const path = require('path');

// ========== Cloudinary 配置 ==========
const cloudinary = require('cloudinary').v2;
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.RENDER ? '/data' : path.join(__dirname, 'data');

// ========== 数据存储 ==========
let config = {
  password: process.env.ADMIN_PASSWORD || 'portfolio2026',
  adminToken: process.env.ADMIN_TOKEN || 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
  portfolioToken: process.env.PORTFOLIO_TOKEN || 'f2ed6d2a9d760bd0dea0a45c',
};

let works = [];

// 从本地文件加载数据（Render 持久化磁盘 /data）
function loadData() {
  try {
    const configPath = path.join(DATA_DIR, 'config.json');
    const worksPath = path.join(DATA_DIR, 'works.json');
    
    if (fs.existsSync(configPath)) {
      const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (saved.password) config.password = saved.password;
      if (saved.adminToken) config.adminToken = saved.adminToken;
      if (saved.portfolioToken) config.portfolioToken = saved.portfolioToken;
      console.log('✅ 从磁盘加载配置');
    }
    
    if (fs.existsSync(worksPath)) {
      works = JSON.parse(fs.readFileSync(worksPath, 'utf8'));
      console.log(`✅ 从磁盘加载了 ${works.length} 个作品`);
    }
  } catch (e) {
    console.log('⚠️ 从磁盘加载数据失败:', e.message);
  }
}

// 保存数据到磁盘
function saveData() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(path.join(DATA_DIR, 'config.json'), JSON.stringify(config, null, 2));
    fs.writeFileSync(path.join(DATA_DIR, 'works.json'), JSON.stringify(works, null, 2));
  } catch (e) {
    console.error('❌ 保存数据失败:', e.message);
  }
}

// 启动时加载数据
loadData();

// ========== 中间件 ==========
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// 管理面板鉴权
function authAdmin(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token === config.adminToken) return next();
  res.status(401).json({ error: '未授权访问' });
}

// 分享链接鉴权
function authShare(req, res, next) {
  const shareToken = req.query.s;
  const portfolioTokenParam = req.query.p;
  
  if (portfolioTokenParam === config.portfolioToken) {
    req.isPortfolio = true;
    return next();
  }
  
  if (!shareToken) return res.status(403).send('访问需要有效的分享链接');
  const work = works.find(w => w.shareToken === shareToken);
  if (!work) return res.status(404).send('分享链接无效或已失效');
  req.work = work;
  req.isPortfolio = false;
  next();
}

// ========== Cloudinary 上传辅助 ==========
function uploadToCloudinary(buffer, options) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(options, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
    Readable.from(buffer).pipe(stream);
  });
}

// Multer 内存存储
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.mp4', '.webm', '.mov', '.avi', '.mkv'];
    const ext = '.' + file.originalname.split('.').pop().toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('仅支持视频文件格式'));
  }
});

const coverUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// ========== API 路由 ==========

// 登录验证
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password === config.password) {
    res.json({ success: true, token: config.adminToken });
  } else {
    res.json({ success: false, error: '密码错误' });
  }
});

// 修改密码
app.post('/api/change-password', authAdmin, (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) {
    return res.json({ success: false, error: '密码至少6位' });
  }
  config.password = newPassword;
  saveData();
  res.json({ success: true });
});

// 上传视频到 Cloudinary
app.post('/api/upload', authAdmin, upload.single('video'), async (req, res) => {
  if (!req.file) return res.json({ success: false, error: '未收到文件' });
  try {
    const result = await uploadToCloudinary(req.file.buffer, {
      resource_type: 'video',
      folder: 'portfolio/videos',
      public_id: crypto.randomBytes(8).toString('hex'),
      chunk_size: 6000000,
    });
    res.json({
      success: true,
      filename: result.public_id,
      originalName: req.file.originalname,
      videoUrl: result.secure_url,
      size: req.file.size,
    });
  } catch (err) {
    console.error('Cloudinary upload error:', err);
    res.json({ success: false, error: '上传失败: ' + err.message });
  }
});

// 上传封面图到 Cloudinary
app.post('/api/upload-cover', authAdmin, coverUpload.single('cover'), async (req, res) => {
  if (!req.file) return res.json({ success: false, error: '未收到文件' });
  try {
    const result = await uploadToCloudinary(req.file.buffer, {
      resource_type: 'image',
      folder: 'portfolio/covers',
      public_id: 'cover_' + crypto.randomBytes(8).toString('hex'),
    });
    res.json({
      success: true,
      coverFilename: result.public_id,
      coverUrl: result.secure_url,
    });
  } catch (err) {
    console.error('Cloudinary cover upload error:', err);
    res.json({ success: false, error: '封面上传失败: ' + err.message });
  }
});

// 创建/更新作品
app.post('/api/works', authAdmin, (req, res) => {
  const { id, title, description, filename, originalName, coverUrl, coverFilename, videoUrl } = req.body;

  if (id) {
    const idx = works.findIndex(w => w.id === id);
    if (idx === -1) return res.json({ success: false, error: '作品不存在' });
    works[idx] = { ...works[idx], ...req.body };
    saveData();
    res.json({ success: true, work: works[idx] });
  } else {
    const shareToken = crypto.randomBytes(12).toString('hex');
    const work = {
      id: crypto.randomBytes(8).toString('hex'),
      title: title || '未命名作品',
      description: description || '',
      filename: filename || '',
      originalName: originalName || '',
      videoUrl: videoUrl || '',
      coverUrl: req.body.coverUrl || '',
      coverFilename: req.body.coverFilename || '',
      shareToken,
      createdAt: new Date().toISOString(),
      order: works.length
    };
    works.push(work);
    saveData();
    res.json({ success: true, work });
  }
});

// 删除作品
app.delete('/api/works/:id', authAdmin, async (req, res) => {
  const idx = works.findIndex(w => w.id === req.params.id);
  if (idx === -1) return res.json({ success: false, error: '作品不存在' });
  const work = works[idx];
  
  // 从 Cloudinary 删除视频
  if (work.filename) {
    try {
      await cloudinary.uploader.destroy(work.filename, { resource_type: 'video' });
    } catch (e) { console.error('删除视频失败:', e); }
  }
  // 从 Cloudinary 删除封面
  if (work.coverFilename) {
    try {
      await cloudinary.uploader.destroy(work.coverFilename, { resource_type: 'image' });
    } catch (e) { console.error('删除封面失败:', e); }
  }
  
  works.splice(idx, 1);
  saveData();
  res.json({ success: true });
});

// 替换视频
app.post('/api/replace-video/:id', authAdmin, upload.single('video'), async (req, res) => {
  if (!req.file) return res.json({ success: false, error: '未收到文件' });
  const idx = works.findIndex(w => w.id === req.params.id);
  if (idx === -1) return res.json({ success: false, error: '作品不存在' });
  
  const work = works[idx];
  // 删除旧视频
  if (work.filename) {
    try {
      await cloudinary.uploader.destroy(work.filename, { resource_type: 'video' });
    } catch (e) { console.error('删除旧视频失败:', e); }
  }
  
  try {
    const result = await uploadToCloudinary(req.file.buffer, {
      resource_type: 'video',
      folder: 'portfolio/videos',
      public_id: crypto.randomBytes(8).toString('hex'),
      chunk_size: 6000000,
    });
    works[idx].filename = result.public_id;
    works[idx].originalName = req.file.originalname;
    works[idx].videoUrl = result.secure_url;
    saveData();
    res.json({ success: true, work: works[idx] });
  } catch (err) {
    console.error('替换视频上传失败:', err);
    res.json({ success: false, error: '替换失败: ' + err.message });
  }
});

// 重新生成分享链接
app.post('/api/works/:id/regenerate-token', authAdmin, (req, res) => {
  const idx = works.findIndex(w => w.id === req.params.id);
  if (idx === -1) return res.json({ success: false, error: '作品不存在' });
  works[idx].shareToken = crypto.randomBytes(12).toString('hex');
  saveData();
  res.json({ success: true, shareToken: works[idx].shareToken });
});

// 获取配置
app.get('/api/config', authAdmin, (req, res) => {
  res.json({ portfolioToken: config.portfolioToken });
});

// 重新生成作品集 token
app.post('/api/regenerate-portfolio-token', authAdmin, (req, res) => {
  config.portfolioToken = crypto.randomBytes(12).toString('hex');
  saveData();
  res.json({ success: true, portfolioToken: config.portfolioToken });
});

// 保存排序
app.post('/api/works/reorder', authAdmin, (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) return res.json({ success: false, error: '参数错误' });
  order.forEach((id, idx) => {
    const w = works.find(w => w.id === id);
    if (w) w.order = idx;
  });
  saveData();
  res.json({ success: true });
});

// 获取所有作品
app.get('/api/works', authAdmin, (req, res) => {
  res.json(works);
});

// 导出数据
app.get('/api/export', authAdmin, (req, res) => {
  res.json({ config, works });
});

// 导入数据
app.post('/api/import', authAdmin, (req, res) => {
  const { config: newConfig, works: newWorks } = req.body;
  if (newWorks && Array.isArray(newWorks)) {
    works = newWorks;
  }
  if (newConfig) {
    config = { ...config, ...newConfig };
  }
  saveData();
  res.json({ success: true, count: works.length });
});

// ========== 分享数据接口 ==========

app.get('/api/share-data', authShare, (req, res) => {
  if (req.isPortfolio) {
    res.json(works);
  } else {
    res.json(req.work);
  }
});

app.get('/api/portfolio-data', authShare, (req, res) => {
  res.json(works);
});

// ========== 页面路由 ==========

app.get('/admin', (req, res) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/share', authShare, (req, res) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  if (req.isPortfolio) {
    res.sendFile(path.join(__dirname, 'public', 'portfolio.html'));
  } else {
    res.sendFile(path.join(__dirname, 'public', 'share.html'));
  }
});

app.get('/portfolio', authShare, (req, res) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.sendFile(path.join(__dirname, 'public', 'portfolio.html'));
});

// 静态文件
app.use('/static', express.static(path.join(__dirname, 'public'), {
  setHeaders: (res) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  }
}));

// 所有页面设置 noindex
app.use((req, res, next) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  next();
});

// 根路径重定向
app.get('/', (req, res) => {
  res.redirect('/admin');
});

// ========== 启动 ==========

app.listen(PORT, () => {
  console.log(`\n✨ 私密作品集网站已启动`);
  console.log(`   管理面板: http://localhost:${PORT}/admin`);
  console.log(`   密码: ${config.password}`);
  console.log(`   作品集分享链接: /portfolio?p=${config.portfolioToken}`);
  console.log(`   作品数: ${works.length}\n`);
});
