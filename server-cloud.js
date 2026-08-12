const express = require('express');
const multer = require('multer');
const Busboy = require('busboy');
const crypto = require('crypto');
const compression = require('compression');
const { Readable } = require('stream');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
// ========== Cloudinary 配置（保留，用于旧数据兼容） ==========
const cloudinary = require('cloudinary').v2;
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ========== Cloudflare R2 配置（零依赖 S3 兼容签名，不需要 @aws-sdk） ==========
const R2_ACCOUNT = process.env.R2_ACCOUNT_ID || '';
const R2_ACCESS_KEY = process.env.R2_ACCESS_KEY_ID || '';
const R2_SECRET_KEY = process.env.R2_SECRET_ACCESS_KEY || '';
const R2_BUCKET = process.env.R2_BUCKET || 'portfolio-videos';
const R2_ENABLED = !!(R2_ACCOUNT && R2_ACCESS_KEY);
const R2_HOST = R2_ACCOUNT ? `${R2_ACCOUNT}.r2.cloudflarestorage.com` : '';
// r2.dev 公开域名（访客直接访问视频/数据，不经过 Render）
const R2_DEV_URL = process.env.R2_DEV_URL || 'https://pub-af8e63a9c8fa418992e9e2de7412f5ee.r2.dev';
function r2PublicUrl(key) {
  return R2_DEV_URL + '/' + key.split('/').map(encodeURIComponent).join('/');
}

function hmacSha256(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}
function sha256hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}
function getSigningKey(secret, date, region, service) {
  const kDate = hmacSha256('AWS4' + secret, date);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  return hmacSha256(kService, 'aws4_request');
}
function r2PresignedUrl(method, key, contentType, expires) {
  const region = 'auto', service = 's3';
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.substring(0, 8);
  const credScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const params = new URLSearchParams();
  params.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
  params.set('X-Amz-Credential', `${R2_ACCESS_KEY}/${credScope}`);
  params.set('X-Amz-Date', amzDate);
  params.set('X-Amz-Expires', String(expires));
  params.set('X-Amz-SignedHeaders', 'host');
  // canonical URI 必须对路径段做 RFC 3986 编码（空格→%20，中文→%E7%89%88）
  const uriEncode = s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  const canonicalUri = '/' + R2_BUCKET + '/' + key.split('/').map(uriEncode).join('/');
  const canonicalQuery = params.toString();
  const canonicalReq = [method, canonicalUri, canonicalQuery, `host:${R2_HOST}`, '', 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credScope, sha256hex(canonicalReq)].join('\n');
  const sig = crypto.createHmac('sha256', getSigningKey(R2_SECRET_KEY, dateStamp, region, service)).update(stringToSign).digest('hex');
  params.set('X-Amz-Signature', sig);
  return `https://${R2_HOST}/${R2_BUCKET}/${key}?${params.toString()}`;
}

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
    console.log('⚠️ Cloudinary 加载失败，从 R2 备份加载...');
    cloudinaryReady = true;
    // 失败时回退到 R2 备份
    if (R2_ENABLED) {
      try {
        const url = await new Promise((resolve, reject) => {
          const u = https.request({ hostname: R2_HOST, path: `/${R2_BUCKET}/data/works.json`, method: 'GET' }, res => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => resolve({ status: res.statusCode, body }));
          });
          u.on('error', reject);
          u.end();
        });
        if (url.status === 200) {
          const data = JSON.parse(url.body);
          if (data.works && Array.isArray(data.works)) {
            works = data.works;
            console.log(`✅ 从 R2 备份加载了 ${works.length} 个作品`);
          }
          if (data.config) {
            config = { ...config, ...data.config };
          }
        }
      } catch (e2) { console.log('⚠️ R2 备份也不可用，从空数据开始'); }
    }
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
  // 同步备份到 R2 raw 文件（Cloudinary 限流时仍可保存）+ 导出公开 works JSON
  if (R2_ENABLED) {
    try {
      const data = JSON.stringify({ config, works, _savedAt: new Date().toISOString() });
      const key = 'data/works.json';
      const putUrl = r2PresignedUrl('PUT', key, 'application/json', 600);
      await new Promise((r, rj) => {
        const req = https.request(putUrl, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => res.statusCode < 300 ? r() : rj(new Error('R2 ' + res.statusCode)));
        req.on('error', rj);
        req.write(data);
        req.end();
      });
      console.log(`💾 数据已备份到 R2 (${works.length} 个作品)`);

      // 导出公开 works JSON（按 portfolio token hash 命名，供 Cloudflare Pages 静态页访问）
      const pubData = JSON.stringify({ works });
      const tokenHash = crypto.createHash('sha256').update(config.portfolioToken || '').digest('hex').slice(0, 16);
      const pubKey = `data/works-${tokenHash}.json`;
      const pubUrl = r2PresignedUrl('PUT', pubKey, 'application/json', 600);
      await new Promise((r, rj) => {
        const req = https.request(pubUrl, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(pubData) } }, res => res.statusCode < 300 ? r() : rj(new Error('R2 ' + res.statusCode)));
        req.on('error', rj);
        req.write(pubData);
        req.end();
      });
      console.log(`🌐 公开 works JSON 已导出: ${pubKey}`);
    } catch (e) {
      console.error('❌ 备份到 R2 失败:', e.message);
    }
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

const VIDEO_MAX_SIZE = 500 * 1024 * 1024; // 500MB
const VIDEO_EXT = ['.mp4', '.webm', '.mov', '.avi', '.mkv'];

function streamVideoUpload(req, folder) {
  return new Promise((resolve, reject) => {
    const bb = Busboy({
      headers: req.headers,
      limits: { fileSize: VIDEO_MAX_SIZE, files: 1 }
    });
    let settled = false;
    const fail = err => { if (!settled) { settled = true; reject(err); } };

    // 服务端签名（API secret 只在服务端，不暴露给前端）
    const timestamp = Math.round(Date.now() / 1000);
    const signature = cloudinary.utils.api_sign_request(
      { timestamp, folder, resource_type: 'video' },
      process.env.CLOUDINARY_API_SECRET
    );

    bb.on('file', (fieldname, file, info) => {
      if (fieldname !== 'video') { file.resume(); return; }
      try {
        const ext = '.' + (info.filename || '').split('.').pop().toLowerCase();
        if (!VIDEO_EXT.includes(ext)) {
          file.resume();
          return fail(new Error('仅支持视频文件格式'));
        }

        const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
        const apiKey = process.env.CLOUDINARY_API_KEY;
        if (!cloudName || !apiKey) return fail(new Error('Cloudinary 未配置'));

        const boundary = '----PortfolioBoundary' + crypto.randomBytes(8).toString('hex');
        const CRLF = '\r\n';
        const safeName = String(info.filename || 'video.mp4').replace(/["\r\n]/g, '');

        // multipart 头部：字段 + 文件头（固定，很小）
        let headStr = '';
        const fields = [
          ['api_key', apiKey],
          ['timestamp', String(timestamp)],
          ['signature', signature],
          ['folder', folder],
        ];
        for (const [k, v] of fields) {
          headStr += `--${boundary}${CRLF}Content-Disposition: form-data; name="${k}"${CRLF}${CRLF}${v}${CRLF}`;
        }
        headStr += `--${boundary}${CRLF}Content-Disposition: form-data; name="file"; filename="${safeName}"${CRLF}Content-Type: ${info.mimeType || 'video/mp4'}${CRLF}${CRLF}`;
        const head = Buffer.from(headStr, 'utf8');
        const tail = Buffer.from(`${CRLF}--${boundary}--${CRLF}`, 'utf8');

        const upReq = https.request({
          hostname: 'api.cloudinary.com',
          path: `/v1_1/${cloudName}/video/upload`,
          method: 'POST',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
          },
        }, (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', c => { body += c; });
          res.on('end', () => {
            let d = null;
            try { d = JSON.parse(body); } catch (e) { return fail(new Error('Cloudinary 响应异常')); }
            if (res.statusCode >= 400 || d.error) {
              return fail(new Error((d.error && (d.error.message || JSON.stringify(d.error))) || `Cloudinary 错误 ${res.statusCode}`));
            }
            if (!settled) {
              settled = true;
              resolve({ result: d, originalname: info.filename, size: file.bytesRead || 0 });
            }
          });
        });
        upReq.on('error', fail);
        upReq.setTimeout(120000, () => { upReq.destroy(); fail(new Error('Cloudinary 连接超时')); });

        // 流式：写头部 → pipe 文件 → 文件结束写尾部
        upReq.write(head);
        file.on('limit', () => { upReq.destroy(); fail(new Error('文件超过 500MB 限制')); });
        file.on('error', () => { upReq.destroy(); fail(new Error('读取上传文件失败')); });
        file.pipe(upReq, { end: false });
        file.on('end', () => { upReq.end(tail); });
      } catch (e) {
        file.resume();
        fail(e);
      }
    });

    bb.on('error', fail);
    bb.on('filesLimit', () => fail(new Error('一次只能上传一个文件')));
    req.pipe(bb);
    req.on('error', fail);
  });
}

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

// ========== Cloudinary chunked upload（分片上传，绕过免费版 100MB 单文件限制） ==========
// 协议（参照官方 SDK upload_chunked_stream）：
//   每片 POST 到 /video/upload，headers 带 Content-Range 和 X-Unique-Upload-Id；
//   最后一片（isLast=true, total=完整大小）时 Cloudinary 返回完整结果(public_id/secure_url)。
const CHUNK_MAX = 12 * 1024 * 1024; // 单片上限（前端按 6MB 切）

function cloudinaryChunkPipe(file, meta, folder) {
  return new Promise((resolve, reject) => {
    try {
      const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
      const apiKey = process.env.CLOUDINARY_API_KEY;
      if (!cloudName || !apiKey) return reject(new Error('Cloudinary 未配置'));
      const timestamp = Math.round(Date.now() / 1000);
      const signature = cloudinary.utils.api_sign_request({ timestamp, folder }, process.env.CLOUDINARY_API_SECRET);
      const boundary = '----PortfolioBoundary' + crypto.randomBytes(8).toString('hex');
      const CRLF = '\r\n';
      const safeName = String(meta.filename || 'video.mp4').replace(/["\r\n]/g, '');
      let headStr = '';
      const fields = [
        ['api_key', apiKey],
        ['timestamp', String(timestamp)],
        ['signature', signature],
        ['folder', folder],
      ];
      for (const [k, v] of fields) {
        headStr += `--${boundary}${CRLF}Content-Disposition: form-data; name="${k}"${CRLF}${CRLF}${v}${CRLF}`;
      }
      headStr += `--${boundary}${CRLF}Content-Disposition: form-data; name="file"; filename="${safeName}"${CRLF}Content-Type: video/mp4${CRLF}${CRLF}`;
      const head = Buffer.from(headStr, 'utf8');
      const tail = Buffer.from(`${CRLF}--${boundary}--${CRLF}`, 'utf8');
      const isLast = meta.isLast === 'true';
      const contentRange = `bytes ${meta.start}-${meta.end}/${isLast ? meta.totalSize : -1}`;

      const upReq = https.request({
        hostname: 'api.cloudinary.com',
        path: `/v1_1/${cloudName}/video/upload`,
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Range': contentRange,
          'X-Unique-Upload-Id': meta.uniqueUploadId,
        },
      }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', c => { body += c; });
        res.on('end', () => {
          if (res.statusCode >= 400) {
            let em = `Cloudinary 错误 ${res.statusCode}`;
            try { const d = JSON.parse(body); em = (d.error && (d.error.message || JSON.stringify(d.error))) || em; } catch (e) {}
            return reject(new Error(em));
          }
          if (!body.trim()) return resolve({ ok: true }); // 非最后一片可能无内容
          let d;
          try { d = JSON.parse(body); } catch (e) { return resolve({ ok: true }); }
          if (d.error) return reject(new Error(d.error.message || JSON.stringify(d.error)));
          resolve(d);
        });
        res.on('aborted', () => { upReq.destroy(); reject(new Error('Cloudinary 连接中断')); });
      });
      upReq.on('error', reject);
      upReq.setTimeout(120000, () => { upReq.destroy(); reject(new Error('Cloudinary 连接超时')); });
      upReq.write(head);
      file.pipe(upReq, { end: false });
      file.on('end', () => upReq.end(tail));
    } catch (e) { reject(e); }
  });
}

// 分片上传（含替换视频：传 eid 时完成后自动更新作品并清理旧视频）
app.post('/api/upload-chunk', authAdmin, async (req, res) => {
  try {
    const meta = {};
    const chunkResult = await new Promise((resolve, reject) => {
      let settled = false;
      const fail = err => { if (!settled) { settled = true; reject(err); } };
      const bb = Busboy({ headers: req.headers, limits: { fileSize: CHUNK_MAX, files: 1 } });
      bb.on('field', (n, v) => { meta[n] = v; });
      bb.on('file', (n, file, info) => {
        if (n !== 'chunk') { file.resume(); return; }
        cloudinaryChunkPipe(file, meta, 'portfolio/videos')
          .then(d => { if (!settled) { settled = true; resolve(d); } })
          .catch(err => { file.resume(); fail(err); });
      });
      bb.on('error', fail);
      bb.on('filesLimit', () => fail(new Error('一次只能上传一个分片')));
      req.pipe(bb);
      req.on('error', fail);
    });

    const isLast = meta.isLast === 'true';
    if (isLast && chunkResult.public_id) {
      const out = {
        success: true,
        completed: true,
        filename: chunkResult.public_id,
        originalName: meta.filename || '',
        videoUrl: chunkResult.secure_url,
        size: parseInt(meta.totalSize || '0', 10),
      };
      if (meta.eid) {
        const idx = works.findIndex(w => w.id === meta.eid);
        if (idx !== -1) {
          const old = works[idx];
          works[idx] = { ...old, filename: out.filename, originalName: out.originalName, videoUrl: out.videoUrl };
          saveWorksToCloudinary();
          if (old.filename && old.filename !== out.filename) {
            cloudinary.uploader.destroy(old.filename, { resource_type: 'video' }).catch(() => {});
          }
          out.work = works[idx];
        }
      }
      return res.json(out);
    }
    res.json({ success: true, completed: false, ok: true });
  } catch (err) {
    console.error('chunk upload error:', err);
    res.json({ success: false, error: '上传失败: ' + err.message });
  }
});

// 上传视频到 Cloudinary（用 SDK upload_chunked_stream 真正流式分片，绕开 100MB 免费限制）
// ========== R2 中转上传（浏览器→Render 磁盘→ R2 PUT，绕过国内网络限制） ==========
app.post('/api/upload', authAdmin, async (req, res) => {
  if (!R2_ENABLED) return res.json({ success: false, error: 'R2 未配置' });
  const tmpPath = path.join(os.tmpdir(), 'r2up_' + crypto.randomBytes(8).toString('hex'));
  try {
    const result = await new Promise((resolve, reject) => {
      const bb = Busboy({ headers: req.headers, limits: { fileSize: 2 * 1024 * 1024 * 1024, files: 1 } });
      bb.on('file', (fieldname, file, info) => {
        if (fieldname !== 'video') { file.resume(); return; }
        const ext = '.' + (info.filename || '').split('.').pop().toLowerCase();
        if (!VIDEO_EXT.includes(ext)) { file.resume(); reject(new Error('仅支持视频文件格式')); return; }
        const ws = fs.createWriteStream(tmpPath);
        file.pipe(ws);
        file.on('limit', () => { ws.destroy(); reject(new Error('文件超过 2GB 限制')); });
        ws.on('error', reject);
        ws.on('finish', async () => {
          try {
            const r2Key = `videos/${crypto.randomBytes(12).toString('hex')}/${info.filename}`;
            const fileSize = fs.statSync(tmpPath).size;
            const putUrl = r2PresignedUrl('PUT', r2Key, 'video/mp4', 600);
            await new Promise((r, rj) => {
              const upReq = https.request(putUrl, { method: 'PUT', headers: { 'Content-Type': 'video/mp4', 'Content-Length': fileSize } }, (upRes) => {
                if (upRes.statusCode >= 200 && upRes.statusCode < 300) r();
                else { let b = ''; upRes.on('data', c => b += c); upRes.on('end', () => rj(new Error(`R2 ${upRes.statusCode}: ${b}`))); }
              });
              upReq.on('error', rj);
              fs.createReadStream(tmpPath).pipe(upReq);
            });
            resolve({ key: r2Key, filename: info.filename, size: fileSize });
          } catch (e) { reject(e); }
        });
      });
      bb.on('error', reject);
      bb.on('filesLimit', () => reject(new Error('一次只能上传一个文件')));
      req.pipe(bb);
    });
    res.json({ success: true, filename: result.key, originalName: result.filename, videoUrl: r2PublicUrl(result.key), size: result.size });
  } catch (err) {
    console.error('R2 upload error:', err);
    res.json({ success: false, error: '上传失败: ' + err.message });
  } finally {
    try { fs.unlinkSync(tmpPath); } catch (e) {}
  }
});

// ========== R2 直传签名 + 视频代理 ==========
// POST: 浏览器拿 presigned PUT URL，直传到 R2（不经过 Render）
app.post('/api/r2-sign-upload', authAdmin, async (req, res) => {
  if (!R2_ENABLED) return res.json({ success: false, error: 'R2 未配置' });
  try {
    const filename = (req.body && req.body.filename) || 'video.mp4';
    const contentType = (req.body && req.body.contentType) || 'video/mp4';
    const key = `videos/${crypto.randomBytes(12).toString('hex')}/${filename}`;
    const url = r2PresignedUrl('PUT', key, contentType, 600);
    res.json({ success: true, url, key, filename });
  } catch (e) {
    console.error('R2 sign error:', e);
    res.json({ success: false, error: '签名失败: ' + e.message });
  }
});

// GET /v/:key: 302 重定向到 R2 presigned GET URL（访客播放视频用）
app.get('/v/:key(*)', async (req, res) => {
  if (!R2_ENABLED) return res.status(503).send('R2 未配置');
  try {
    const url = r2PresignedUrl('GET', req.params.key, null, 86400);
    res.redirect(302, url);
  } catch (e) {
    console.error('R2 video proxy error:', e);
    res.status(500).send('视频加载失败');
  }
});

// POST /api/recover: 强制从 Cloudinary 拉回 works 数据（临时恢复端点）
app.post('/api/recover', async (req, res) => {
  if (req.body?.pw !== 'recover2026') return res.status(403).json({ error: 'invalid password' });
  for (let i = 0; i < 10; i++) {
    try {
      const result = await cloudinary.api.resource(DATA_PUBLIC_ID, { resource_type: 'raw' });
      const resp = await fetch(result.secure_url);
      const data = await resp.json();
      if (data.works && Array.isArray(data.works) && data.works.length > 0) {
        works = data.works;
        console.log(`✅ Recovered ${works.length} works from Cloudinary`);
        return res.json({ success: true, recovered: works.length });
      }
    } catch (e) {
      console.log(`Recover attempt ${i+1} failed: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 5000 * (i + 1)));
  }
  res.json({ success: false, recovered: 0, msg: 'Cloudinary 数据文件访问失败，请稍后重试' });
});

// POST /api/admin/migrate-list: 列出 Cloudinary 所有 portfolio/videos 资源，批量下载→上传到 R2，自动从文件名解析标题/分类/项目
app.post('/api/admin/migrate-list', async (req, res) => {
  if (req.body?.pw !== 'migrate2026') return res.status(403).json({ error: 'invalid pw' });
  if (!R2_ENABLED) return res.json({ success: false, error: 'R2 未配置' });

  const log = [];
  try {
    // 1. 列出 Cloudinary portfolio/videos/* 所有视频
    log.push('1. 列出 Cloudinary 视频资源...');
    const list = await cloudinary.api.resources({
      type: 'upload',
      resource_type: 'video',
      prefix: 'portfolio/videos/',
      max_results: 500,
    });
    const resources = list.resources || [];
    log.push(`   找到 ${resources.length} 个视频`);

    // 2. 逐个迁移
    const newWorks = [];
    for (let i = 0; i < resources.length; i++) {
      const r = resources[i];
      const originalName = r.original_filename || (r.public_id.split('/').pop());
      const filenameWithExt = originalName.match(/\.[a-z0-9]+$/i) ? originalName : originalName + '.mp4';

      // 自动解析标题/分类/项目（从文件名）
      const title = originalName.replace(/\.[a-z0-9]+$/i, '').replace(/^portfolio\/videos\/[^/]+\//, '');
      const cat = detectCategory(title, filenameWithExt);
      const proj = detectProject(title, filenameWithExt);

      try {
        // 下载原视频到临时文件
        const tmp = path.join(os.tmpdir(), 'mig_' + crypto.randomBytes(6).toString('hex'));
        const downloadUrl = r.secure_url;
        const r2Key = `videos/${crypto.randomBytes(8).toString('hex')}/${filenameWithExt}`;
        const presigned = await new Promise((resolve, reject) => {
          const out = require('fs').createWriteStream(tmp);
          require('https').get(downloadUrl, r2 => { r2.pipe(out); out.on('finish', () => resolve()); out.on('error', reject); });
        });

        // 上传到 R2
        const putUrl = r2PresignedUrl('PUT', r2Key, 'video/mp4', 600);
        const fileSize = require('fs').statSync(tmp).size;
        await new Promise((r, rj) => {
          const u = https.request(putUrl, { method: 'PUT', headers: { 'Content-Type': 'video/mp4', 'Content-Length': fileSize } }, res => { res.statusCode < 300 ? r() : rj(new Error(`R2 ${res.statusCode}`)); });
          u.on('error', rj);
          require('fs').createReadStream(tmp).pipe(u);
        });
        require('fs').unlinkSync(tmp);

        newWorks.push({
          id: crypto.randomBytes(8).toString('hex'),
          title,
          description: '',
          category: cat,
          project: proj,
          filename: r2Key,
          originalName: filenameWithExt,
          videoUrl: r2PublicUrl(r2Key),
          coverUrl: r.eager && r.eager[0] ? r.eager[0].secure_url : '',
          shareToken: crypto.randomBytes(8).toString('hex'),
          createdAt: r.created_at,
        });
        log.push(`   [${i+1}/${resources.length}] ✓ ${title}`);
      } catch (e) {
        log.push(`   [${i+1}/${resources.length}] ✗ ${originalName}: ${e.message}`);
      }
    }

    // 3. 写回内存 + 保存到 Cloudinary + 本地
    works = newWorks;
    saveWorksToCloudinary();
    require('fs').writeFileSync(require('path').join(__dirname, 'data-backup-r3-final.json'), JSON.stringify({works, config, _savedAt: new Date().toISOString()}, null, 2));
    log.push(`3. ✅ 完成 ${newWorks.length} 个作品`);

    res.json({ success: true, migrated: newWorks.length, log });
  } catch (e) {
    log.push(`失败: ${e.message}`);
    res.json({ success: false, error: e.message, log });
  }
});

// POST /api/admin/clear-all: 清空所有作品 + 删除 R2 文件
app.post('/api/admin/clear-all', async (req, res) => {
  if (req.body?.pw !== 'clear2026') return res.status(403).json({ error: 'invalid pw' });
  const count = works.length;
  for (const w of works) {
    if (w.filename && w.filename.startsWith('videos/')) {
      try { await new Promise(r => { const d = https.request(`https://${R2_HOST}/${R2_BUCKET}/${w.filename}`, { method: 'DELETE' }, () => r()); d.on('error', () => r()); d.end(); }); } catch(e){}
    }
  }
  works = [];
  saveWorksToCloudinary();
  res.json({ success: true, deleted: count });
});

// ========== 前端直传 Cloudinary 的一次性签名（弃用，保留兼容） ==========
app.get('/api/cloudinary-sign', authAdmin, (req, res) => {
  try {
    const timestamp = Math.round(Date.now() / 1000);
    const expires_at = timestamp + 600; // 签名 10 分钟有效
    const folder = 'portfolio/videos';
    const params = { timestamp, expires_at, folder, resource_type: 'video' };
    const signature = cloudinary.utils.api_sign_request(params, process.env.CLOUDINARY_API_SECRET);
    res.json({
      success: true,
      cloudName: process.env.CLOUDINARY_CLOUD_NAME,
      apiKey: process.env.CLOUDINARY_API_KEY,
      timestamp,
      expires_at,
      signature,
      folder,
    });
  } catch (e) {
    console.error('cloudinary-sign error:', e);
    res.json({ success: false, error: '签名失败: ' + e.message });
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
    const oldWork = works[idx];
    works[idx] = { ...works[idx], ...req.body };
    saveWorksToCloudinary(); // 异步保存
    // 替换视频时异步清理 Cloudinary 上的旧视频文件
    if (req.body.filename && oldWork.filename && oldWork.filename !== req.body.filename) {
      cloudinary.uploader.destroy(oldWork.filename, { resource_type: 'video' }).catch(() => {});
    }
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

// 替换视频（R2 中转：磁盘临时文件→ R2 PUT）
app.post('/api/replace-video/:id', authAdmin, async (req, res) => {
  if (!R2_ENABLED) return res.json({ success: false, error: 'R2 未配置' });
  const idx = works.findIndex(w => w.id === req.params.id);
  if (idx === -1) return res.json({ success: false, error: '作品不存在' });

  const work = works[idx];
  // 删除旧 R2 文件（如存的是 R2 key）
  if (work.filename && work.filename.startsWith('videos/')) {
    try { await new Promise(r => { const req = https.request(`https://${R2_HOST}/${R2_BUCKET}/${work.filename}`, { method: 'DELETE' }, res => r()); req.on('error', () => r()); req.end(); }); } catch(e){}
  }

  const tmpPath = path.join(os.tmpdir(), 'r2rp_' + crypto.randomBytes(8).toString('hex'));
  try {
    const result = await new Promise((resolve, reject) => {
      const bb = Busboy({ headers: req.headers, limits: { fileSize: 2 * 1024 * 1024 * 1024, files: 1 } });
      bb.on('file', (fieldname, file, info) => {
        if (fieldname !== 'video') { file.resume(); return; }
        const ext = '.' + (info.filename || '').split('.').pop().toLowerCase();
        if (!VIDEO_EXT.includes(ext)) { file.resume(); reject(new Error('仅支持视频文件格式')); return; }
        const ws = fs.createWriteStream(tmpPath);
        file.pipe(ws);
        file.on('limit', () => { ws.destroy(); reject(new Error('文件超过 2GB 限制')); });
        ws.on('error', reject);
        ws.on('finish', async () => {
          try {
            const r2Key = `videos/${crypto.randomBytes(12).toString('hex')}/${info.filename}`;
            const fileSize = fs.statSync(tmpPath).size;
            const putUrl = r2PresignedUrl('PUT', r2Key, 'video/mp4', 600);
            await new Promise((r, rj) => {
              const upReq = https.request(putUrl, { method: 'PUT', headers: { 'Content-Type': 'video/mp4', 'Content-Length': fileSize } }, (upRes) => {
                if (upRes.statusCode >= 200 && upRes.statusCode < 300) r();
                else { let b = ''; upRes.on('data', c => b += c); upRes.on('end', () => rj(new Error(`R2 ${upRes.statusCode}: ${b}`))); }
              });
              upReq.on('error', rj);
              fs.createReadStream(tmpPath).pipe(upReq);
            });
            resolve({ key: r2Key, filename: info.filename, size: fileSize });
          } catch (e) { reject(e); }
        });
      });
      bb.on('error', reject);
      bb.on('filesLimit', () => reject(new Error('一次只能上传一个文件')));
      req.pipe(bb);
    });
    works[idx].filename = result.key;
    works[idx].originalName = result.filename;
    works[idx].videoUrl = r2PublicUrl(result.key);
    saveWorksToCloudinary();
    res.json({ success: true, work: works[idx] });
  } catch (err) {
    console.error('替换视频上传失败:', err);
    res.json({ success: false, error: '替换失败: ' + err.message });
  } finally {
    try { fs.unlinkSync(tmpPath); } catch (e) {}
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
  // videoUrl 已是 r2.dev 公开 URL，直接返回（无 Render 重定向，零流量消耗）
  res.setHeader('Cache-Control', 'public, max-age=60');
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
