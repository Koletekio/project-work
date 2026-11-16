import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, request } from 'node:http';

const password = process.env.VIDEO_SHARE_PASSWORD;
if (!password) throw new Error('请先设置 VIDEO_SHARE_PASSWORD。');
const upstreamAuth = `Basic ${Buffer.from(`video:${password}`).toString('base64')}`;
const key = randomBytes(32);
const cookie = 'video_job';
const jobPath = /^\/analysis\/([a-f0-9]{32})(\/video|\/questions(?:\/[a-f0-9]{32})?)?$/;
const cookieLifetime = 24 * 60 * 60;
const maxUpload = 80 * 1024 * 1024;
const noStore = { 'Cache-Control': 'private, no-store' };

function signature(id, expires) {
  return createHmac('sha256', key).update(`${id}.${expires}`).digest('hex');
}

function allowed(headers, id) {
  const cookies = (headers.cookie ?? '').split(';');
  return cookies.some((entry) => {
    const [name, value] = entry.trim().split('=', 2);
    if (name !== cookie || !value) return false;
    const [expires, token, ...rest] = value.split('.');
    if (rest.length || !/^\d{10}$/.test(expires) || !/^[a-f0-9]{64}$/.test(token ?? '')) return false;
    return Number(expires) > Math.floor(Date.now() / 1000) &&
      timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(signature(id, expires), 'hex'));
  });
}

function reject(res, status, detail) {
  if (res.headersSent) return res.destroy();
  res.writeHead(status, { ...noStore, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ detail }));
}

function forward(req, res, upload) {
  const headers = { Authorization: upstreamAuth };
  for (const name of ['content-type', 'content-length', 'range', 'if-range']) {
    if (req.headers[name]) headers[name] = req.headers[name];
  }
  const upstream = request({
    hostname: '127.0.0.1', port: 8010, path: req.url.split('?', 1)[0], method: req.method, headers,
  }, (incoming) => {
    const outgoingHeaders = { ...noStore, 'X-Content-Type-Options': 'nosniff' };
    for (const header of ['content-type', 'content-length', 'accept-ranges', 'content-range']) {
      if (incoming.headers[header]) outgoingHeaders[header] = incoming.headers[header];
    }
    incoming.on('error', () => reject(res, 502, '视频服务暂时不可用。'));
    if (!upload || incoming.statusCode < 200 || incoming.statusCode >= 300) {
      res.writeHead(incoming.statusCode, outgoingHeaders);
      incoming.pipe(res);
      return;
    }
    const chunks = [];
    let size = 0;
    incoming.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        incoming.destroy();
        reject(res, 502, '分段结果过大。');
      } else {
        chunks.push(chunk);
      }
    });
    incoming.on('end', () => {
      const body = Buffer.concat(chunks);
      let id;
      try {
        id = JSON.parse(body).upload_id;
      } catch {
        return reject(res, 502, '未收到有效的上传结果。');
      }
      if (!/^[a-f0-9]{32}$/.test(id ?? '')) return reject(res, 502, '未收到上传编号。');
      const expires = Math.floor(Date.now() / 1000) + cookieLifetime;
      outgoingHeaders['Set-Cookie'] = `${cookie}=${expires}.${signature(id, expires)}; ` +
        `Path=/analysis/${id}; Max-Age=${cookieLifetime}; HttpOnly; Secure; SameSite=Lax`;
      res.writeHead(incoming.statusCode, outgoingHeaders);
      res.end(body);
    });
  });
  upstream.setTimeout(120_000, () => upstream.destroy());
  upstream.on('error', () => reject(res, 502, '视频服务暂时不可用。'));
  res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
  req.pipe(upstream);
}

createServer((req, res) => {
  const target = req.url.split('?', 1)[0];
  const read = req.method === 'GET' || req.method === 'HEAD';
  const post = req.method === 'POST';
  if (post && req.headers['sec-fetch-site'] === 'cross-site') return reject(res, 403, '请在网站内提交。');
  if (read && target === '/') return forward(req, res, false);
  const upload = post && target === '/upload';
  const job = jobPath.exec(target);
  const question = post && job?.[2] === '/questions';
  const readJob = read && job && job[2] !== '/questions';
  if (!upload && !question && !readJob) return reject(res, 404, '找不到这个页面。');
  if (!upload && !allowed(req.headers, job[1])) return reject(res, 404, '找不到这次分析任务，请重新上传视频。');
  if (post) {
    const header = req.headers['content-length'] ?? '';
    if (!/^\d{1,10}$/.test(header)) return reject(res, 411, '缺少文件大小。');
    if (Number(header) > (upload ? maxUpload : 8192)) return reject(res, 413, '上传内容过大。');
    const contentType = req.headers['content-type'] ?? '';
    if (!(upload ? /^multipart\/form-data\s*;/i : /^application\/json(?:\s*;|$)/i).test(contentType)) {
      return reject(res, 415, '上传格式不正确。');
    }
  }
  forward(req, res, upload);
}).listen(8011, '127.0.0.1', () => console.log('Public sharing origin listening on 127.0.0.1:8011'));
