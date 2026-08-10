const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const compression = require('compression');
const { Readable } = require('stream');
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

// ========== 性能优化 ==========
// 1. Gzip 压缩 - 减少网络传输 70%+
app.use(compression({ level: 6, threshold: 1024 }));
// 2. 静态文件长缓存
app.use('/static', express.static(path.join(__dirname, 'public'), {
  maxAge: '7d',
  etag: true,
  setHeaders: (res, path) => {
    if (path.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    else res.setHeader('Cache-Control', 'public, max-age=604800');
  }
}));

// ========== 数据存储（内存 + Cloudinary 持久化） ==========
let config = {
  password: process.env.ADMIN_PASSWORD || 'portfolio2026',
  adminToken: process.env.ADMIN_TOKEN || crypto.randomBytes(16).toString('hex'),
  portfolioToken: process.env.PORTFOLIO_TOKEN || crypto.randomBytes(12).toString('hex'),
};

let works = [];
let cloudinaryReady = false;

// ========== Cloudinary 数据持久化 ==========
const DATA_PUBLIC_ID = 'portfolio/data/works';

async function loadWorksFromCloudinary() {
  try {
    const result = await cloudinary.api.resource(DATA_PUBLIC_ID, { resource_type: 'raw' });
    const response = await fetch(result.secure_url);
    const data = await response.json();
    if (data.works && Array.isArray(data.works)) {
      works = data.works;
      console.log(`✅ 从 Cloudinary 加载了 ${works.length} 个作品`);
    }
    if (data.config) {
      config = { ...config, ...data.config };
    }
    cloudinaryReady = true;
  } catch (e) {
    // 首次运行时文件不存在，这是正常的
    console.log('⚠️ Cloudinary 数据文件不存在，从空数据开始');
    cloudinaryReady = true;
  }
}

async function saveWorksToCloudinary() {
  try {
    const data = JSON.stringify({ config, works });
    const buffer = Buffer.from(data, 'utf-8');

    // 先尝试覆盖，如果不存在则上传
    try {
      await cloudinary.uploader.destroy(DATA_PUBLIC_ID, { resource_type: 'raw' });
    } catch (e) { /* 忽略 */ }

    const result = await uploadToCloudinary(buffer, {
      resource_type: 'raw',
      public_id: DATA_PUBLIC_ID,
      overwrite: true,
    });
    console.log(`💾 数据已保存到 Cloudinary (${works.length} 个作品)`);
  } catch (e) {
    console.error('❌ 保存到 Cloudinary 失败:', e.message);
  }
}

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

// Multer 内存存储（上传到 Cloudinary 不需要本地文件）
// 限制文件大小 200MB 防止内存爆掉
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 },
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
  saveWorksToCloudinary(); // 异步保存
  res.json({ success: true, hint: '密码已修改并保存到云端。' });
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

// 根据标题自动识别市场分类
function detectCategory(title, originalName) {
  const text = (title + ' ' + (originalName || '')).toUpperCase();
  if (/[_\s-]JP[_\s-]|_JP_|_JP$|^JP_|^JP[_\s-]/.test(text)) return 'JP';
  if (/[_\s-]CN[_\s-]|_CN_|_CN$|^CN_|^CN[_\s-]/.test(text)) return 'CN';
  if (/[_\s-]KR[_\s-]|_KR_|_KR$|^KR_|^KR[_\s-]/.test(text)) return 'KR';
  if (/[_\s-]EN[_\s-]|_EN_|_EN$|^EN_|^EN[_\s-]/.test(text)) return 'EN';
  return 'EN';
}

// 根据标题自动识别项目（绯色回响 / 少年三国志 / Zomline / 代号GR）
function detectProject(title, originalName) {
  const text = (title + ' ' + (originalName || '')).toLowerCase();
  if (/少年三国|少三|shaonian|young3/i.test(text)) return 'shaonian';
  if (/zomline|zombie/i.test(text)) return 'zomline';
  if (/代号gr|gr\d|codename.*gr/i.test(text)) return 'gr';
  // 默认归到绯色回响
  return 'echocalypse';
}

// 创建/更新作品
app.post('/api/works', authAdmin, (req, res) => {
  const { id, title, description, filename, originalName, coverUrl, coverFilename, videoUrl, category } = req.body;

  if (id) {
    const idx = works.findIndex(w => w.id === id);
    if (idx === -1) return res.json({ success: false, error: '作品不存在' });
    works[idx] = { ...works[idx], ...req.body };
    saveWorksToCloudinary(); // 异步保存
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
      category: category || detectCategory(title, originalName),
      project: req.body.project || detectProject(title, originalName),
      shareToken,
      createdAt: new Date().toISOString(),
      order: works.length
    };
    works.push(work);
    saveWorksToCloudinary(); // 异步保存
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
  saveWorksToCloudinary(); // 异步保存
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
    saveWorksToCloudinary(); // 异步保存
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
  saveWorksToCloudinary(); // 异步保存
  res.json({ success: true, shareToken: works[idx].shareToken });
});

// 获取配置
app.get('/api/config', authAdmin, (req, res) => {
  res.json({ portfolioToken: config.portfolioToken });
});

// 重新生成作品集 token
app.post('/api/regenerate-portfolio-token', authAdmin, (req, res) => {
  config.portfolioToken = crypto.randomBytes(12).toString('hex');
  saveWorksToCloudinary(); // 异步保存
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
  saveWorksToCloudinary(); // 异步保存
  res.json({ success: true });
});

// 获取所有作品
app.get('/api/works', authAdmin, (req, res) => {
  res.json(works);
});

// 一键自动归类（批量给所有作品打 category 标签）
app.post('/api/works/auto-categorize', authAdmin, (req, res) => {
  let count = 0;
  works.forEach(w => {
    if (!w.category) {
      w.category = detectCategory(w.title, w.originalName);
      count++;
    }
  });
  saveWorksToCloudinary();
  res.json({ success: true, categorized: count, total: works.length });
});

// 一键给所有现有作品分配项目（绯色回响 / 少年三国志等）
app.post('/api/works/auto-project', authAdmin, (req, res) => {
  let count = 0;
  works.forEach(w => {
    if (!w.project) {
      w.project = detectProject(w.title, w.originalName);
      count++;
    }
  });
  saveWorksToCloudinary();
  res.json({ success: true, assigned: count, total: works.length });
});

// 导出数据（用于备份/迁移）
app.get('/api/export', authAdmin, (req, res) => {
  res.json({ config, works });
});

// 导入数据（用于恢复）
app.post('/api/import', authAdmin, (req, res) => {
  const { config: newConfig, works: newWorks } = req.body;
  if (newWorks && Array.isArray(newWorks)) {
    works = newWorks;
  }
  if (newConfig) {
    config = { ...config, ...newConfig };
  }
  saveWorksToCloudinary(); // 异步保存
  res.json({ success: true, count: works.length });
});

// ========== 分享数据接口 ==========

// 单个作品数据
app.get('/api/share-data', authShare, (req, res) => {
  if (req.isPortfolio) {
    res.json(works);
  } else {
    res.json(req.work);
  }
});

// 作品集数据
app.get('/api/portfolio-data', authShare, (req, res) => {
  // 短缓存让 5 秒内多个访客共享同一份响应
  res.setHeader('Cache-Control', 'public, max-age=5');
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

// 静态文件已在上方配置（带缓存头条）

// 所有页面设置 noindex
app.use((req, res, next) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  next();
});

// 根路径重定向
app.get('/', (req, res) => {
  res.redirect('/admin');
});

// ========== 健康检查（保活用） ==========
// 这个端点返回极简响应，不触发任何 Cloudinary 调用，
// 用于 GitHub Actions 每 14 分钟 ping 一次保活 Render
app.get('/ping', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('text/plain').send('pong');
});

// ========== 启动 ==========
// 先启动服务器，再异步加载 Cloudinary 数据
app.listen(PORT, () => {
  console.log(`\n✨ 私密作品集网站已启动`);
  console.log(`   管理面板: http://localhost:${PORT}/admin`);
  console.log(`   密码: ${config.password}`);
  console.log(`   作品集分享链接: /portfolio?p=${config.portfolioToken}`);
  console.log(`   作品数: ${works.length}\n`);
});

// 异步加载 Cloudinary 数据
loadWorksFromCloudinary().then(() => {
  console.log(`🎉 数据加载完成，当前共 ${works.length} 个作品`);
}).catch(e => {
  console.error('❌ 加载 Cloudinary 数据失败:', e.message);
});
