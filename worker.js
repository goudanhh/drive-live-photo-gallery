export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (err) {
      return json({ ok: false, error: String(err?.message || err) }, 500);
    }
  }
};

const COOKIE_NAME = "media_session";
const CHUNK_SIZE_HINT = 5 * 1024 * 1024;

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === "GET" && path === "/") {
    return html(INDEX_HTML);
  }

  if (request.method === "POST" && path === "/api/login") {
    const body = await request.json().catch(() => ({}));

    if (!body.password || body.password !== env.ADMIN_PASSWORD) {
      return json({ ok: false, error: "密码错误" }, 401);
    }

    const token = await signSession(env.ADMIN_PASSWORD);

    return json(
      { ok: true },
      200,
      {
        "Set-Cookie": `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`
      }
    );
  }

  if (request.method === "POST" && path === "/api/logout") {
    return json(
      { ok: true },
      200,
      {
        "Set-Cookie": `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
      }
    );
  }

  if (request.method === "GET" && path === "/api/me") {
    const authed = await checkAuth(request, env.ADMIN_PASSWORD);
    return json({ ok: true, authed });
  }

  const authed = await checkAuth(request, env.ADMIN_PASSWORD);

  if (!authed) {
    if (path.startsWith("/api/") || path.startsWith("/file/")) {
      return json({ ok: false, error: "未登录" }, 401);
    }

    return html(INDEX_HTML);
  }

  if (request.method === "GET" && path === "/api/files") {
    const keyword = url.searchParams.get("q") || "";
    const type = url.searchParams.get("type") || "all";
    const accessToken = await getGoogleAccessToken(env);
    const files = await listDriveFiles(env, accessToken, keyword, type);
    return json({ ok: true, files });
  }

  if (request.method === "POST" && path === "/api/resumable/start") {
    const body = await request.json().catch(() => ({}));

    const fileName = String(body.fileName || `upload_${Date.now()}`);
    const mimeType = String(body.mimeType || "application/octet-stream");
    const size = Number(body.size || 0);
    const appProperties = sanitizeAppProperties(body.appProperties || {});

    const accessToken = await getGoogleAccessToken(env);

    const result = await startResumableUpload(env, accessToken, {
      fileName,
      mimeType,
      size,
      appProperties
    });

    return json({ ok: true, ...result });
  }

  if (request.method === "PUT" && path === "/api/resumable/chunk") {
    const uploadUrl = request.headers.get("X-Upload-URL");
    const contentRange = request.headers.get("Content-Range");
    const contentType = request.headers.get("Content-Type") || "application/octet-stream";

    if (!uploadUrl) {
      return json({ ok: false, error: "缺少 X-Upload-URL" }, 400);
    }

    if (!contentRange) {
      return json({ ok: false, error: "缺少 Content-Range" }, 400);
    }

    const result = await uploadChunkToGoogle(uploadUrl, request.body, contentRange, contentType);
    return json(result, result.httpStatus || 200);
  }

  if (request.method === "GET" && path.startsWith("/file/")) {
    const fileId = decodeURIComponent(path.replace("/file/", ""));
    const accessToken = await getGoogleAccessToken(env);
    return await streamDriveFile(accessToken, fileId, request);
  }

  if (request.method === "POST" && path === "/api/batch/delete") {
    const body = await request.json().catch(() => ({}));
    const ids = Array.isArray(body.ids) ? body.ids : [];

    const accessToken = await getGoogleAccessToken(env);
    const results = [];

    for (const id of ids) {
      try {
        await deleteDriveFile(accessToken, String(id));
        results.push({ id, ok: true });
      } catch (err) {
        results.push({ id, ok: false, error: String(err?.message || err) });
      }
    }

    return json({ ok: true, results });
  }

  return new Response("Not Found", { status: 404 });
}

async function getGoogleAccessToken(env) {
  const required = [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_REFRESH_TOKEN"
  ];

  for (const key of required) {
    if (!env[key]) {
      throw new Error(`缺少 Cloudflare 环境变量：${key}`);
    }
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token"
    })
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(`Google token error: ${JSON.stringify(data)}`);
  }

  return data.access_token;
}

async function listDriveFiles(env, accessToken, keyword, type) {
  if (!env.GOOGLE_FOLDER_ID) {
    throw new Error("缺少 Cloudflare 环境变量：GOOGLE_FOLDER_ID");
  }

  const safeKeyword = keyword.trim().replace(/'/g, "\\'");
  let q = `'${env.GOOGLE_FOLDER_ID}' in parents and trashed=false`;

  if (safeKeyword) {
    q += ` and name contains '${safeKeyword}'`;
  }

  if (type === "image") {
    q += ` and mimeType contains 'image/'`;
  }

  if (type === "video") {
    q += ` and mimeType contains 'video/'`;
  }

  const params = new URLSearchParams({
    q,
    orderBy: "createdTime desc",
    pageSize: "300",
    fields: "files(id,name,mimeType,size,createdTime,modifiedTime,thumbnailLink,webViewLink,appProperties)"
  });

  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(`Google list error: ${JSON.stringify(data)}`);
  }

  let files = data.files || [];

  if (type === "live") {
    files = files.filter(file => {
      const app = file.appProperties || {};
      return !!app.liveGroup;
    });
  }

  if (type === "other") {
    files = files.filter(file => {
      const mime = file.mimeType || "";
      const app = file.appProperties || {};
      return !mime.startsWith("image/") && !mime.startsWith("video/") && !app.liveGroup;
    });
  }

  return files;
}

async function startResumableUpload(env, accessToken, options) {
  if (!env.GOOGLE_FOLDER_ID) {
    throw new Error("缺少 Cloudflare 环境变量：GOOGLE_FOLDER_ID");
  }

  const originalName = options.fileName || `upload_${Date.now()}`;
  const mimeType = options.mimeType || "application/octet-stream";
  const safeName = buildSafeFileName(originalName);

  const metadata = {
    name: safeName,
    parents: [env.GOOGLE_FOLDER_ID],
    appProperties: {
      originalName,
      uploadedBy: "cloudflare-worker-private-media",
      ...options.appProperties
    }
  };

  const res = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,mimeType,size,createdTime,modifiedTime,webViewLink,appProperties",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": mimeType,
        "X-Upload-Content-Length": String(options.size || 0)
      },
      body: JSON.stringify(metadata)
    }
  );

  const text = await res.text();
  const uploadUrl = res.headers.get("Location");

  if (!res.ok || !uploadUrl) {
    throw new Error(`Google resumable start error: ${text}`);
  }

  return {
    uploadUrl,
    fileName: safeName,
    originalName,
    chunkSize: CHUNK_SIZE_HINT
  };
}

async function uploadChunkToGoogle(uploadUrl, body, contentRange, contentType) {
  const res = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": contentType,
      "Content-Range": contentRange
    },
    body
  });

  const text = await res.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (res.status === 308) {
    return {
      ok: true,
      done: false,
      httpStatus: 200,
      range: res.headers.get("Range") || ""
    };
  }

  if (!res.ok) {
    return {
      ok: false,
      done: false,
      httpStatus: res.status,
      error: data || text || "Google chunk upload error"
    };
  }

  return {
    ok: true,
    done: true,
    httpStatus: 200,
    file: data
  };
}

async function streamDriveFile(accessToken, fileId, request) {
  const meta = await getDriveFileMeta(accessToken, fileId);

  const headers = {
    Authorization: `Bearer ${accessToken}`
  };

  const range = request.headers.get("Range");

  if (range) {
    headers.Range = range;
  }

  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
    { headers }
  );

  if (!res.ok && res.status !== 206) {
    const text = await res.text();

    return new Response(`读取文件失败：${text}`, {
      status: res.status,
      headers: {
        "Content-Type": "text/plain; charset=utf-8"
      }
    });
  }

  const responseHeaders = new Headers(res.headers);

  responseHeaders.set("Content-Type", meta.mimeType || "application/octet-stream");
  responseHeaders.set("Content-Disposition", makeInlineDisposition(meta.name || "file"));
  responseHeaders.set("Cache-Control", "private, max-age=3600");
  responseHeaders.set("Accept-Ranges", "bytes");

  return new Response(res.body, {
    status: res.status,
    headers: responseHeaders
  });
}

async function getDriveFileMeta(accessToken, fileId) {
  const params = new URLSearchParams({
    fields: "id,name,mimeType,size"
  });

  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?${params}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    }
  );

  const data = await res.json();

  if (!res.ok) {
    throw new Error(`Google file meta error: ${JSON.stringify(data)}`);
  }

  return data;
}

function makeInlineDisposition(filename) {
  const safeAscii = String(filename)
    .replace(/[\\"]/g, "_")
    .replace(/[^\x20-\x7E]/g, "_");

  const encoded = encodeURIComponent(filename);

  return `inline; filename="${safeAscii}"; filename*=UTF-8''${encoded}`;
}

async function deleteDriveFile(accessToken, fileId) {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    }
  );

  if (!res.ok && res.status !== 204) {
    const text = await res.text();
    throw new Error(`Google delete error: ${text}`);
  }
}

function buildSafeFileName(originalName) {
  const now = new Date();
  const stamp =
    now.getFullYear().toString() +
    pad2(now.getMonth() + 1) +
    pad2(now.getDate()) +
    "_" +
    pad2(now.getHours()) +
    pad2(now.getMinutes()) +
    pad2(now.getSeconds());

  const clean = String(originalName)
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 120);

  return `${stamp}_${clean}`;
}

function sanitizeAppProperties(obj) {
  const out = {};

  if (!obj || typeof obj !== "object") {
    return out;
  }

  for (const [key, value] of Object.entries(obj)) {
    if (!/^[a-zA-Z0-9_]+$/.test(key)) continue;

    const v = String(value ?? "").slice(0, 120);

    if (v) {
      out[key] = v;
    }
  }

  return out;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

async function signSession(secret) {
  const data = `ok:${Math.floor(Date.now() / 1000)}`;
  const sig = await sha256(`${data}:${secret}`);
  return btoa(`${data}:${sig}`);
}

async function checkAuth(request, secret) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));

  if (!match) return false;

  try {
    const raw = atob(match[1]);
    const parts = raw.split(":");

    if (parts.length !== 3) return false;

    const data = `${parts[0]}:${parts[1]}`;
    const ts = Number(parts[1]);
    const sig = parts[2];

    if (!ts) return false;

    const now = Date.now() / 1000;
    const maxAge = 604800;

    if (now - ts > maxAge) return false;

    const expected = await sha256(`${data}:${secret}`);
    return timingSafeEqual(sig, expected);
  } catch {
    return false;
  }
}

async function sha256(text) {
  const buf = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", buf);

  return [...new Uint8Array(hash)]
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;

  let out = 0;

  for (let i = 0; i < a.length; i++) {
    out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return out === 0;
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders
    }
  });
}

function html(content) {
  return new Response(content, {
    headers: {
      "Content-Type": "text/html; charset=utf-8"
    }
  });
}

const INDEX_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1.0" />
  <title>私人实况相册</title>
  <style>
    * { box-sizing: border-box; }

    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
      background: #f5f6f8;
      color: #111827;
      -webkit-tap-highlight-color: transparent;
    }

    header {
      padding: 22px 28px;
      background: #111827;
      color: white;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    header h1 {
      margin: 0;
      font-size: 24px;
      font-weight: 800;
    }

    header span {
      opacity: .75;
      font-size: 13px;
    }

    main {
      max-width: 1280px;
      margin: 24px auto;
      padding: 0 18px;
    }

    .card {
      background: white;
      border-radius: 18px;
      box-shadow: 0 8px 24px rgba(0,0,0,.06);
      padding: 22px;
      margin-bottom: 22px;
    }

    .login-box {
      max-width: 420px;
      margin: 80px auto;
    }

    input, button, select {
      font: inherit;
    }

    input[type="password"],
    input[type="text"],
    input[type="file"],
    select {
      width: 100%;
      border: 1px solid #d1d5db;
      border-radius: 12px;
      padding: 12px 14px;
      outline: none;
      background: white;
    }

    button {
      border: none;
      background: #111827;
      color: white;
      border-radius: 12px;
      padding: 11px 16px;
      cursor: pointer;
      font-weight: 700;
      white-space: nowrap;
    }

    button.secondary {
      background: #e5e7eb;
      color: #111827;
    }

    button.danger {
      background: #b91c1c;
    }

    button:disabled {
      opacity: .5;
      cursor: not-allowed;
    }

    .row {
      display: flex;
      gap: 12px;
      align-items: center;
      flex-wrap: wrap;
    }

    .row > * {
      flex: 1;
    }

    .toolbar {
      display: grid;
      grid-template-columns: 1.5fr 160px auto auto;
      gap: 12px;
      align-items: center;
    }

    .batchbar {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      align-items: center;
      margin-top: 14px;
    }

    .tabs {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }

    .tab {
      background: #e5e7eb;
      color: #111827;
      padding: 9px 14px;
      border-radius: 999px;
    }

    .tab.active {
      background: #111827;
      color: white;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
      gap: 18px;
    }

    .item {
      background: white;
      border-radius: 16px;
      overflow: hidden;
      box-shadow: 0 5px 18px rgba(0,0,0,.06);
      border: 1px solid #eef0f3;
      position: relative;
    }

    .select-box {
      position: absolute;
      top: 10px;
      left: 10px;
      z-index: 20;
      width: 20px;
      height: 20px;
    }

    .preview {
      height: 220px;
      background: #000;
      display: flex;
      justify-content: center;
      align-items: center;
      overflow: hidden;
      cursor: pointer;
      position: relative;
    }

    .preview img,
    .preview video {
      width: 100%;
      height: 100%;
      object-fit: contain;
      background: #000;
    }

    .live-viewer {
      width: 100%;
      height: 100%;
      position: relative;
      background: #000;
      overflow: hidden;
      user-select: none;
      touch-action: manipulation;
      cursor: pointer;
    }

    .live-viewer .live-img,
    .live-viewer .live-video {
      width: 100%;
      height: 100%;
      object-fit: contain;
      background: #000;
      display: block;
    }

    .live-viewer .live-video {
      display: none;
    }

    .live-viewer.playing .live-img {
      display: none;
    }

    .live-viewer.playing .live-video {
      display: block;
    }

    .live-hint {
      position: absolute;
      left: 50%;
      bottom: 10px;
      transform: translateX(-50%);
      background: rgba(17,24,39,.82);
      color: white;
      border-radius: 999px;
      padding: 5px 11px;
      font-size: 12px;
      z-index: 10;
      pointer-events: none;
      opacity: .92;
    }

    .live-viewer.playing .live-hint {
      opacity: 0;
    }

    .preview .icon {
      font-size: 46px;
      opacity: .55;
      color: white;
    }

    .live-badge {
      position: absolute;
      top: 10px;
      right: 10px;
      background: rgba(17,24,39,.88);
      color: white;
      border-radius: 999px;
      padding: 5px 9px;
      font-size: 12px;
      z-index: 20;
    }

    .info {
      padding: 14px;
    }

    .name {
      font-weight: 800;
      font-size: 14px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      margin-bottom: 8px;
    }

    .meta {
      font-size: 12px;
      color: #6b7280;
      margin-bottom: 12px;
      line-height: 1.5;
    }

    .actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }

    .actions button {
      padding: 8px 10px;
      font-size: 12px;
      border-radius: 10px;
    }

    .hidden {
      display: none !important;
    }

    .msg, .progress, .speed-line, .download-status {
      margin-top: 10px;
      font-size: 13px;
      color: #374151;
      word-break: break-word;
      line-height: 1.55;
    }

    .error {
      color: #b91c1c !important;
    }

    .success {
      color: #047857 !important;
    }

    .progress-wrap {
      width: 100%;
      height: 10px;
      background: #e5e7eb;
      border-radius: 999px;
      overflow: hidden;
      margin-top: 10px;
    }

    .progress-bar {
      width: 0%;
      height: 100%;
      background: #111827;
      transition: width .15s ease;
    }

    .queue {
      display: grid;
      gap: 12px;
      margin-top: 12px;
    }

    .queue-item {
      border: 1px solid #e5e7eb;
      border-radius: 14px;
      padding: 12px;
      background: #fafafa;
    }

    .queue-title {
      font-weight: 800;
      margin-bottom: 6px;
      word-break: break-all;
    }

    .timeline-title {
      font-size: 18px;
      margin: 26px 0 14px;
      font-weight: 900;
    }

    .modal-mask {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,.45);
      display: flex;
      justify-content: center;
      align-items: center;
      z-index: 9999;
      padding: 18px;
    }

    .modal {
      width: min(960px, 96vw);
      max-height: 92vh;
      overflow: auto;
      background: white;
      border-radius: 20px;
      padding: 22px;
      box-shadow: 0 20px 70px rgba(0,0,0,.3);
    }

    .modal-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      margin-bottom: 14px;
    }

    .modal-title {
      font-size: 20px;
      font-weight: 900;
      word-break: break-all;
    }

    .detail-preview {
      background: #000;
      border-radius: 16px;
      overflow: hidden;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 420px;
      margin-bottom: 14px;
    }

    .detail-preview .live-viewer {
      min-height: 420px;
      border-radius: 16px;
    }

    .detail-preview img,
    .detail-preview video {
      max-width: 100%;
      max-height: 75vh;
      object-fit: contain;
      background: #000;
    }

    .detail-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
    }

    .detail-table td {
      padding: 8px 6px;
      border-bottom: 1px solid #eef0f3;
      word-break: break-all;
    }

    .detail-table td:first-child {
      color: #6b7280;
      width: 120px;
    }

    @media (max-width: 860px) {
      .toolbar {
        grid-template-columns: 1fr;
      }

      header {
        display: block;
      }

      header span {
        display: block;
        margin-top: 6px;
      }

      #logoutBtn {
        margin-top: 12px;
      }

      .preview {
        height: 260px;
      }

      .detail-preview {
        min-height: 360px;
      }

      .detail-preview .live-viewer {
        min-height: 360px;
      }
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>私人实况相册</h1>
      <span>下拉选择上传类型 · 保持原始比例</span>
    </div>
    <button id="logoutBtn" class="secondary hidden" type="button">退出登录</button>
  </header>

  <main>
    <section id="loginPanel" class="card login-box">
      <h2>登录</h2>
      <p style="color:#6b7280;font-size:14px;">输入你的管理密码后才能访问文件。</p>
      <input id="password" type="password" placeholder="请输入登录密码" />
      <div style="height:12px"></div>
      <button id="loginBtn" type="button">登录</button>
      <div id="loginMsg" class="msg"></div>
    </section>

    <section id="appPanel" class="hidden">
      <div class="card">
        <h2>上传文件</h2>
        <p style="color:#6b7280;font-size:14px;">
          请选择上传类型。照片、实况图、视频分开上传；实况图需要选择一张照片和一个 MOV/MP4 视频。
        </p>

        <div class="row">
          <select id="uploadType">
            <option value="photo">上传照片</option>
            <option value="live">上传实况图</option>
            <option value="video">上传视频</option>
          </select>
        </div>

        <div style="height:14px"></div>

        <div id="photoUploadPanel">
          <div class="row">
            <input id="photoCustomName" type="text" placeholder="照片自定义文件名，可不填" />
            <input id="photoInput" type="file" multiple accept="image/*,.heic,.heif,.jpg,.jpeg,.png,.webp" />
          </div>
          <div id="photoUploadMsg" class="progress"></div>
        </div>

        <div id="liveUploadPanel" class="hidden">
          <div class="row">
            <input id="liveTitle" type="text" placeholder="实况图标题，可不填" />
            <input id="livePhotoInput" type="file" accept="image/*,.heic,.heif,.jpg,.jpeg,.png,.webp" />
            <input id="liveMotionInput" type="file" accept="video/*,.mov,.mp4,.webm" />
          </div>
          <div id="liveUploadMsg" class="progress"></div>
        </div>

        <div id="videoUploadPanel" class="hidden">
          <div class="row">
            <input id="videoCustomName" type="text" placeholder="视频自定义文件名，可不填" />
            <input id="videoInput" type="file" multiple accept="video/*,.mp4,.mov,.webm" />
          </div>
          <div id="videoUploadMsg" class="progress"></div>
        </div>

        <div style="height:14px"></div>

        <button id="mainUploadBtn" type="button">开始上传</button>
      </div>

      <div class="card">
        <h2>上传队列</h2>
        <div id="uploadQueue" class="queue"></div>
      </div>

      <div class="card">
        <div class="tabs">
          <button class="tab active" type="button" data-type="all">全部</button>
          <button class="tab" type="button" data-type="image">图片</button>
          <button class="tab" type="button" data-type="video">视频</button>
          <button class="tab" type="button" data-type="live">实况图</button>
          <button class="tab" type="button" data-type="other">其他</button>
        </div>

        <div style="height:16px"></div>

        <div class="toolbar">
          <input id="searchInput" type="text" placeholder="搜索文件名，例如 IMG、mp4、jpg" />
          <select id="viewMode">
            <option value="timeline">时间轴</option>
            <option value="grid">普通网格</option>
          </select>
          <button id="refreshBtn" type="button">搜索/刷新</button>
          <button id="clearSearchBtn" class="secondary" type="button">清空</button>
        </div>

        <div class="batchbar">
          <button id="selectAllBtn" class="secondary" type="button">全选当前页</button>
          <button id="clearSelectBtn" class="secondary" type="button">取消选择</button>
          <button id="batchCopyBtn" class="secondary" type="button">批量复制链接</button>
          <button id="batchDownloadBtn" class="secondary" type="button">批量下载</button>
          <button id="batchDeleteBtn" class="danger" type="button">批量删除</button>
          <span id="selectedCount" style="color:#6b7280;font-size:13px;">已选择 0 个</span>
        </div>
      </div>

      <div id="fileContainer"></div>
    </section>
  </main>

  <div id="detailModal" class="modal-mask hidden"></div>

  <script>
    var currentType = "all";
    var currentFiles = [];
    var selectedIds = new Set();
    var DEFAULT_CHUNK_SIZE = 5 * 1024 * 1024;

    document.addEventListener("DOMContentLoaded", function () {
      bindEvents();
      showLogin();
      switchUploadPanel();
      checkLogin();
    });

    function bindEvents() {
      qs("loginBtn").addEventListener("click", login);
      qs("password").addEventListener("keydown", function (event) {
        if (event.key === "Enter") login();
      });

      qs("logoutBtn").addEventListener("click", logout);

      qs("uploadType").addEventListener("change", switchUploadPanel);
      qs("mainUploadBtn").addEventListener("click", uploadBySelectedType);

      qs("refreshBtn").addEventListener("click", loadFiles);
      qs("clearSearchBtn").addEventListener("click", clearSearch);
      qs("selectAllBtn").addEventListener("click", selectAllVisible);
      qs("clearSelectBtn").addEventListener("click", clearSelection);
      qs("batchCopyBtn").addEventListener("click", batchCopyLinks);
      qs("batchDownloadBtn").addEventListener("click", batchDownload);
      qs("batchDeleteBtn").addEventListener("click", batchDelete);

      qs("searchInput").addEventListener("keydown", function (event) {
        if (event.key === "Enter") loadFiles();
      });

      qs("viewMode").addEventListener("change", renderFiles);

      document.querySelectorAll(".tab").forEach(function (btn) {
        btn.addEventListener("click", function () {
          setType(btn.dataset.type);
        });
      });

      qs("fileContainer").addEventListener("click", function (event) {
        var liveBox = event.target.closest(".live-viewer");
        if (liveBox) {
          event.preventDefault();
          event.stopPropagation();
          toggleLiveBox(liveBox);
          return;
        }

        var actionEl = event.target.closest("[data-action]");
        if (!actionEl) return;

        var action = actionEl.dataset.action;
        var id = actionEl.dataset.id;

        if (action === "detail") openDetail(id);
        if (action === "preview") previewFile(id);
        if (action === "download") downloadOne(id);
        if (action === "copy") copyOneLink(id);
        if (action === "delete") deleteOne(id);
      });

      qs("fileContainer").addEventListener("change", function (event) {
        if (!event.target.classList.contains("select-box")) return;
        toggleSelect(event.target.dataset.id, event.target.checked);
      });

      qs("detailModal").addEventListener("click", function (event) {
        var liveBox = event.target.closest(".live-viewer");
        if (liveBox) {
          event.preventDefault();
          event.stopPropagation();
          toggleLiveBox(liveBox);
          return;
        }

        if (event.target.id === "detailModal") closeDetail();
      });
    }

    function switchUploadPanel() {
      var type = qs("uploadType").value;

      qs("photoUploadPanel").classList.add("hidden");
      qs("liveUploadPanel").classList.add("hidden");
      qs("videoUploadPanel").classList.add("hidden");

      if (type === "photo") {
        qs("photoUploadPanel").classList.remove("hidden");
      }

      if (type === "live") {
        qs("liveUploadPanel").classList.remove("hidden");
      }

      if (type === "video") {
        qs("videoUploadPanel").classList.remove("hidden");
      }
    }

    async function uploadBySelectedType() {
      var type = qs("uploadType").value;

      if (type === "photo") {
        await uploadPhotoFiles();
        return;
      }

      if (type === "live") {
        await uploadLivePhotoManual();
        return;
      }

      if (type === "video") {
        await uploadVideoFiles();
        return;
      }
    }

    function toggleLiveBox(liveBox) {
      if (liveBox.classList.contains("playing")) {
        stopLiveBox(liveBox);
      } else {
        playLiveBox(liveBox);
      }
    }

    function playLiveBox(liveBox) {
      var video = liveBox.querySelector(".live-video");
      if (!video) return;

      document.querySelectorAll(".live-viewer.playing").forEach(function (box) {
        if (box !== liveBox) stopLiveBox(box);
      });

      liveBox.classList.add("playing");
      video.currentTime = 0;
      video.muted = true;
      video.playsInline = true;

      var p = video.play();
      if (p && p.catch) {
        p.catch(function () {
          stopLiveBox(liveBox);
        });
      }
    }

    function stopLiveBox(liveBox) {
      var video = liveBox.querySelector(".live-video");
      if (!video) return;

      video.pause();
      video.currentTime = 0;
      liveBox.classList.remove("playing");
    }

    function qs(id) {
      return document.getElementById(id);
    }

    async function checkLogin() {
      showLogin();

      try {
        var res = await fetch("/api/me", { method: "GET", cache: "no-store" });
        var data = await res.json();

        if (data.ok && data.authed) {
          showApp();
          await loadFiles();
        } else {
          showLogin();
        }
      } catch (err) {
        console.error("checkLogin error:", err);
        showLogin();
      }
    }

    async function login() {
      var passwordInput = qs("password");
      var msg = qs("loginMsg");
      var loginBtn = qs("loginBtn");

      msg.classList.remove("error");
      msg.textContent = "登录中...";
      loginBtn.disabled = true;

      try {
        var res = await fetch("/api/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: passwordInput.value })
        });

        var data = await res.json();

        if (!data.ok) {
          msg.classList.add("error");
          msg.textContent = data.error || "登录失败";
          return;
        }

        msg.textContent = "登录成功";
        passwordInput.value = "";
        showApp();
        await loadFiles();
      } catch (err) {
        msg.classList.add("error");
        msg.textContent = "登录请求失败：" + String(err && err.message ? err.message : err);
      } finally {
        loginBtn.disabled = false;
      }
    }

    async function logout() {
      await fetch("/api/logout", { method: "POST" });

      qs("password").value = "";
      qs("loginMsg").textContent = "";

      qs("photoUploadMsg").textContent = "";
      qs("liveUploadMsg").textContent = "";
      qs("videoUploadMsg").textContent = "";

      qs("photoCustomName").value = "";
      qs("photoInput").value = "";

      qs("liveTitle").value = "";
      qs("livePhotoInput").value = "";
      qs("liveMotionInput").value = "";

      qs("videoCustomName").value = "";
      qs("videoInput").value = "";

      qs("uploadType").value = "photo";
      switchUploadPanel();

      qs("uploadQueue").innerHTML = "";
      qs("fileContainer").innerHTML = "";

      selectedIds.clear();
      updateSelectedCount();
      showLogin();
    }

    function showApp() {
      qs("loginPanel").classList.add("hidden");
      qs("appPanel").classList.remove("hidden");
      qs("logoutBtn").classList.remove("hidden");
    }

    function showLogin() {
      qs("loginPanel").classList.remove("hidden");
      qs("appPanel").classList.add("hidden");
      qs("logoutBtn").classList.add("hidden");
    }

    function setType(type) {
      currentType = type;

      document.querySelectorAll(".tab").forEach(function (btn) {
        btn.classList.toggle("active", btn.dataset.type === type);
      });

      clearSelection();
      loadFiles();
    }

    function clearSearch() {
      qs("searchInput").value = "";
      loadFiles();
    }

    async function loadFiles() {
      var q = qs("searchInput").value.trim();
      var container = qs("fileContainer");

      container.innerHTML = "<div style='color:#6b7280'>加载中...</div>";

      try {
        var res = await fetch("/api/files?q=" + encodeURIComponent(q) + "&type=" + encodeURIComponent(currentType), {
          method: "GET",
          cache: "no-store"
        });

        var data = await res.json();

        if (!data.ok) {
          if (res.status === 401) {
            showLogin();
            return;
          }

          container.innerHTML = "<div class='error'>加载失败：" + escapeHtml(data.error || "未知错误") + "</div>";
          return;
        }

        currentFiles = normalizeLiveFiles(data.files || []);
        selectedIds.clear();
        updateSelectedCount();
        renderFiles();
      } catch (err) {
        container.innerHTML = "<div class='error'>加载失败：" + escapeHtml(String(err && err.message ? err.message : err)) + "</div>";
      }
    }

    function normalizeLiveFiles(files) {
      var groupMap = new Map();
      var normal = [];

      files.forEach(function (file) {
        var app = file.appProperties || {};

        if (app.liveGroup) {
          if (!groupMap.has(app.liveGroup)) {
            groupMap.set(app.liveGroup, {
              id: "live_" + app.liveGroup,
              name: app.liveTitle || app.originalName || "Live Photo",
              mimeType: "application/x-live-photo",
              size: 0,
              createdTime: file.createdTime,
              modifiedTime: file.modifiedTime,
              isLive: true,
              liveGroup: app.liveGroup,
              photo: null,
              motion: null,
              children: []
            });
          }

          var group = groupMap.get(app.liveGroup);
          group.children.push(file);

          var s = Number(file.size || 0);
          group.size += Number.isFinite(s) ? s : 0;

          if (new Date(file.createdTime) < new Date(group.createdTime)) {
            group.createdTime = file.createdTime;
          }

          if (app.liveRole === "photo") group.photo = file;
          if (app.liveRole === "motion") group.motion = file;
        } else {
          normal.push(file);
        }
      });

      return Array.from(groupMap.values()).concat(normal).sort(function (a, b) {
        return new Date(b.createdTime || 0) - new Date(a.createdTime || 0);
      });
    }

    function renderFiles() {
      var container = qs("fileContainer");

      if (!currentFiles.length) {
        container.innerHTML = "<div style='color:#6b7280'>没有文件</div>";
        return;
      }

      container.innerHTML = "";

      if (qs("viewMode").value === "timeline") {
        renderTimeline(container);
      } else {
        var grid = createEl("div", "grid");
        currentFiles.forEach(function (file) {
          grid.appendChild(createFileCard(file));
        });
        container.appendChild(grid);
      }

      restoreCheckboxes();
    }

    function renderTimeline(container) {
      var groups = {};

      currentFiles.forEach(function (file) {
        var d = file.createdTime ? new Date(file.createdTime) : new Date();
        var key = d.getFullYear() + " 年 " + (d.getMonth() + 1) + " 月";
        if (!groups[key]) groups[key] = [];
        groups[key].push(file);
      });

      Object.keys(groups).forEach(function (title) {
        var titleEl = createEl("div", "timeline-title", title);
        var grid = createEl("div", "grid");

        groups[title].forEach(function (file) {
          grid.appendChild(createFileCard(file));
        });

        container.appendChild(titleEl);
        container.appendChild(grid);
      });
    }

    function createFileCard(file) {
      var isLive = !!file.isLive;
      var id = file.id;
      var item = createEl("div", "item");

      var checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "select-box";
      checkbox.dataset.id = id;
      item.appendChild(checkbox);

      if (isLive) {
        var badge = createEl("div", "live-badge", "Live");
        item.appendChild(badge);
      }

      var preview = createEl("div", "preview");

      if (isLive) {
        if (file.photo && file.motion) {
          preview.appendChild(createLiveViewer(file.photo.id, file.motion.id, false));
        } else if (file.photo) {
          var img = document.createElement("img");
          img.src = "/file/" + encodeURIComponent(file.photo.id);
          img.loading = "lazy";
          preview.appendChild(img);
        } else if (file.motion) {
          var v = document.createElement("video");
          v.src = "/file/" + encodeURIComponent(file.motion.id);
          v.controls = true;
          v.preload = "metadata";
          preview.appendChild(v);
        } else {
          preview.appendChild(createEl("div", "icon", "◎"));
        }
      } else {
        preview.dataset.action = "detail";
        preview.dataset.id = id;

        var url = "/file/" + encodeURIComponent(file.id);
        var mime = file.mimeType || "";

        if (mime.indexOf("image/") === 0) {
          var img2 = document.createElement("img");
          img2.src = url;
          img2.loading = "lazy";
          preview.appendChild(img2);
        } else if (mime.indexOf("video/") === 0) {
          var v2 = document.createElement("video");
          v2.src = url;
          v2.controls = true;
          v2.preload = "metadata";
          preview.appendChild(v2);
        } else {
          preview.appendChild(createEl("div", "icon", "📄"));
        }
      }

      item.appendChild(preview);

      var info = createEl("div", "info");
      var name = createEl("div", "name", file.name || "-");
      name.title = file.name || "-";

      var meta = createEl(
        "div",
        "meta",
        "类型：" + (isLive ? "Live Photo" : (file.mimeType || "-")) + "\\n" +
        "大小：" + (file.size ? formatSize(Number(file.size)) : "-") + "\\n" +
        "时间：" + (file.createdTime ? new Date(file.createdTime).toLocaleString() : "-")
      );
      meta.innerHTML = meta.textContent.replaceAll("\\n", "<br>");

      var actions = createEl("div", "actions");
      actions.appendChild(actionBtn("详情", "detail", id, ""));
      actions.appendChild(actionBtn("预览", "preview", id, "secondary"));
      actions.appendChild(actionBtn("下载", "download", id, "secondary"));
      actions.appendChild(actionBtn("复制链接", "copy", id, "secondary"));
      actions.appendChild(actionBtn("删除", "delete", id, "danger"));

      var status = createEl("div", "download-status");
      status.id = "download-status-" + id;

      info.appendChild(name);
      info.appendChild(meta);
      info.appendChild(actions);
      info.appendChild(status);
      item.appendChild(info);

      return item;
    }

    function createLiveViewer(photoId, motionId, large) {
      var liveBox = createEl("div", "live-viewer");
      if (large) liveBox.classList.add("live-viewer-large");

      var img = document.createElement("img");
      img.className = "live-img";
      img.src = "/file/" + encodeURIComponent(photoId);
      img.loading = "lazy";

      var video = document.createElement("video");
      video.className = "live-video";
      video.src = "/file/" + encodeURIComponent(motionId);
      video.muted = true;
      video.defaultMuted = true;
      video.playsInline = true;
      video.setAttribute("playsinline", "");
      video.setAttribute("webkit-playsinline", "");
      video.preload = "metadata";

      var hint = createEl("div", "live-hint", "点击播放");

      liveBox.appendChild(img);
      liveBox.appendChild(video);
      liveBox.appendChild(hint);

      return liveBox;
    }

    function actionBtn(text, action, id, cls) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = text;
      btn.dataset.action = action;
      btn.dataset.id = id;
      if (cls) btn.className = cls;
      return btn;
    }

    function createEl(tag, cls, text) {
      var el = document.createElement(tag);
      if (cls) el.className = cls;
      if (text !== undefined) el.textContent = text;
      return el;
    }

    function findFile(id) {
      return currentFiles.find(function (f) { return f.id === id; });
    }

    function getDownloadTargets(file) {
      if (!file) return [];

      if (file.isLive) {
        var arr = [];
        if (file.photo) arr.push(file.photo);
        if (file.motion) arr.push(file.motion);
        return arr;
      }

      return [file];
    }

    function previewFile(id) {
      var file = findFile(id);
      if (!file) return;

      var targets = getDownloadTargets(file);
      if (!targets.length) return;

      if (file.isLive) {
        openDetail(id);
        return;
      }

      window.open("/file/" + encodeURIComponent(targets[0].id), "_blank");
    }

    function isPhotoFile(file) {
      return /\\.(jpg|jpeg|png|webp|heic|heif)$/i.test(file.name) ||
        String(file.type || "").startsWith("image/");
    }

    function isVideoFile(file) {
      return /\\.(mov|mp4|webm)$/i.test(file.name) ||
        String(file.type || "").startsWith("video/");
    }

    function getExt(name) {
      var m = String(name).match(/(\\.[^.]+)$/);
      return m ? m[1] : "";
    }

    function stripExt(name) {
      return String(name).replace(/\\.[^.]+$/, "");
    }

    function sanitizeClientName(name) {
      return String(name || "")
        .trim()
        .replace(/[\\\\/:*?"<>|]/g, "_")
        .replace(/\\s+/g, "_")
        .slice(0, 80);
    }

    function buildCustomFileName(customName, originalName, index, total) {
      var custom = sanitizeClientName(customName);

      if (!custom) {
        return originalName;
      }

      var originalExt = getExt(originalName);
      var customExt = getExt(custom);
      var base = customExt ? stripExt(custom) : custom;
      var ext = customExt || originalExt;

      if (total > 1) {
        base = base + "_" + String(index + 1).padStart(3, "0");
      }

      return base + ext;
    }

    async function uploadPhotoFiles() {
      var input = qs("photoInput");
      var customName = qs("photoCustomName").value;
      var msg = qs("photoUploadMsg");

      msg.classList.remove("error", "success");

      if (!input.files.length) {
        msg.classList.add("error");
        msg.textContent = "请先选择照片";
        return;
      }

      var files = Array.from(input.files);

      msg.textContent = "准备上传照片：" + files.length + " 个";

      for (var i = 0; i < files.length; i++) {
        var file = files[i];

        if (!isPhotoFile(file)) {
          msg.classList.add("error");
          msg.textContent = "包含非图片文件：" + file.name;
          return;
        }

        var finalName = buildCustomFileName(customName, file.name, i, files.length);

        await uploadSingleFileWithQueue(file, finalName, {
          mediaType: "photo",
          customNameUsed: customName ? "yes" : "no"
        });
      }

      input.value = "";
      msg.classList.add("success");
      msg.textContent = "照片上传完成：" + files.length + " 个";

      await loadFiles();
    }

    async function uploadVideoFiles() {
      var input = qs("videoInput");
      var customName = qs("videoCustomName").value;
      var msg = qs("videoUploadMsg");

      msg.classList.remove("error", "success");

      if (!input.files.length) {
        msg.classList.add("error");
        msg.textContent = "请先选择视频";
        return;
      }

      var files = Array.from(input.files);

      msg.textContent = "准备上传视频：" + files.length + " 个";

      for (var i = 0; i < files.length; i++) {
        var file = files[i];

        if (!isVideoFile(file)) {
          msg.classList.add("error");
          msg.textContent = "包含非视频文件：" + file.name;
          return;
        }

        var finalName = buildCustomFileName(customName, file.name, i, files.length);

        await uploadSingleFileWithQueue(file, finalName, {
          mediaType: "video",
          customNameUsed: customName ? "yes" : "no"
        });
      }

      input.value = "";
      msg.classList.add("success");
      msg.textContent = "视频上传完成：" + files.length + " 个";

      await loadFiles();
    }

    async function uploadLivePhotoManual() {
      var titleInput = qs("liveTitle");
      var photoInput = qs("livePhotoInput");
      var motionInput = qs("liveMotionInput");
      var msg = qs("liveUploadMsg");

      msg.classList.remove("error", "success");

      var photo = photoInput.files[0];
      var motion = motionInput.files[0];

      if (!photo || !motion) {
        msg.classList.add("error");
        msg.textContent = "请同时选择照片文件和 MOV/MP4 视频文件";
        return;
      }

      if (!isPhotoFile(photo)) {
        msg.classList.add("error");
        msg.textContent = "照片文件格式不正确：" + photo.name;
        return;
      }

      if (!isVideoFile(motion)) {
        msg.classList.add("error");
        msg.textContent = "动态视频格式不正确：" + motion.name;
        return;
      }

      var liveGroup = "live_" + Date.now() + "_" + Math.random().toString(16).slice(2);
      var defaultTitle = stripExt(photo.name);
      var liveTitle = sanitizeClientName(titleInput.value) || sanitizeClientName(defaultTitle) || "LivePhoto";

      msg.textContent = "开始上传实况图：" + liveTitle;

      var photoName = liveTitle + "_photo" + getExt(photo.name);
      var motionName = liveTitle + "_motion" + getExt(motion.name);

      await uploadSingleFileWithQueue(photo, photoName, {
        mediaType: "live",
        liveGroup: liveGroup,
        liveRole: "photo",
        liveTitle: liveTitle
      });

      await uploadSingleFileWithQueue(motion, motionName, {
        mediaType: "live",
        liveGroup: liveGroup,
        liveRole: "motion",
        liveTitle: liveTitle
      });

      titleInput.value = "";
      photoInput.value = "";
      motionInput.value = "";

      msg.classList.add("success");
      msg.textContent = "实况图上传完成：" + liveTitle;

      await loadFiles();
    }

    function uploadChunkWithProgress(options) {
      return new Promise(function (resolve, reject) {
        var uploadUrl = options.uploadUrl;
        var chunk = options.chunk;
        var file = options.file;
        var offset = options.offset;
        var end = options.end;
        var total = options.total;
        var bar = options.bar;
        var line = options.line;
        var stat = options.stat;

        var xhr = new XMLHttpRequest();

        xhr.upload.onprogress = function (event) {
          var now = Date.now();
          var currentLoaded = event.lengthComputable ? offset + event.loaded : offset;
          var percent = total > 0 ? currentLoaded / total * 100 : 100;
          var elapsed = (now - stat.startTime) / 1000;
          var instantElapsed = (now - stat.lastTime) / 1000;
          var avgSpeed = elapsed > 0 ? currentLoaded / elapsed : 0;
          var instantSpeed = instantElapsed > 0 ? (currentLoaded - stat.lastLoaded) / instantElapsed : 0;
          var remainBytes = total - currentLoaded;
          var remainSeconds = avgSpeed > 0 ? remainBytes / avgSpeed : 0;

          bar.style.width = percent.toFixed(1) + "%";

          line.textContent =
            "正在上传到服务器 ｜ " +
            "进度：" + percent.toFixed(1) + "% ｜ " +
            "已上传：" + formatSize(currentLoaded) + " / " + formatSize(total) + " ｜ " +
            "当前分片：" + formatSize(end - offset) + " ｜ " +
            "实时速度：" + formatSpeed(instantSpeed) + " ｜ " +
            "平均速度：" + formatSpeed(avgSpeed) + " ｜ " +
            "预计剩余：" + formatDuration(remainSeconds);

          stat.lastTime = now;
          stat.lastLoaded = currentLoaded;
        };

        xhr.onload = function () {
          var data = {};

          try {
            data = JSON.parse(xhr.responseText || "{}");
          } catch (err) {
            reject(new Error("服务器返回内容无法解析：" + xhr.responseText));
            return;
          }

          if (xhr.status < 200 || xhr.status >= 300 || !data.ok) {
            reject(new Error(data.error ? JSON.stringify(data.error) : "分片上传失败"));
            return;
          }

          line.textContent = "分片已上传，正在写入 Google Drive...";
          resolve(data);
        };

        xhr.onerror = function () {
          reject(new Error("网络错误，分片上传失败"));
        };

        xhr.onabort = function () {
          reject(new Error("上传已取消"));
        };

        xhr.open("PUT", "/api/resumable/chunk");
        xhr.setRequestHeader("X-Upload-URL", uploadUrl);
        xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
        xhr.setRequestHeader("Content-Range", "bytes " + offset + "-" + (end - 1) + "/" + total);
        xhr.send(chunk);
      });
    }

    async function uploadSingleFileWithQueue(file, finalFileName, appProperties) {
      var queue = qs("uploadQueue");
      var itemId = "q_" + Math.random().toString(16).slice(2);

      var item = createEl("div", "queue-item");
      item.id = itemId;

      var title = createEl("div", "queue-title", file.name + " → " + finalFileName);
      var wrap = createEl("div", "progress-wrap");
      var bar = createEl("div", "progress-bar");
      var line = createEl("div", "speed-line", "等待上传...");

      wrap.appendChild(bar);
      item.appendChild(title);
      item.appendChild(wrap);
      item.appendChild(line);
      queue.appendChild(item);

      try {
        var startRes = await fetch("/api/resumable/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fileName: finalFileName || file.name,
            mimeType: file.type || "application/octet-stream",
            size: file.size,
            appProperties: appProperties
          })
        });

        var startData = await startRes.json();

        if (!startData.ok) {
          throw new Error(startData.error || "创建分片上传失败");
        }

        var uploadUrl = startData.uploadUrl;
        var chunkSize = startData.chunkSize || DEFAULT_CHUNK_SIZE;
        var total = file.size;
        var offset = 0;
        var finalFile = null;

        var stat = {
          startTime: Date.now(),
          lastTime: Date.now(),
          lastLoaded: 0
        };

        while (offset < total) {
          var end = Math.min(offset + chunkSize, total);
          var chunk = file.slice(offset, end);

          var data = await uploadChunkWithProgress({
            uploadUrl: uploadUrl,
            chunk: chunk,
            file: file,
            offset: offset,
            end: end,
            total: total,
            bar: bar,
            line: line,
            stat: stat
          });

          offset = end;

          if (data.done) {
            finalFile = data.file;
          }
        }

        bar.style.width = "100%";
        line.classList.add("success");
        line.textContent = "上传完成：" + ((finalFile && finalFile.name) || finalFileName || file.name);
        return finalFile;
      } catch (err) {
        line.classList.add("error");
        line.textContent = "上传失败：" + String(err && err.message ? err.message : err);
        throw err;
      }
    }

    function toggleSelect(id, checked) {
      if (checked) selectedIds.add(id);
      else selectedIds.delete(id);
      updateSelectedCount();
    }

    function restoreCheckboxes() {
      document.querySelectorAll(".select-box").forEach(function (box) {
        box.checked = selectedIds.has(box.dataset.id);
      });
    }

    function updateSelectedCount() {
      var el = qs("selectedCount");
      if (el) el.textContent = "已选择 " + selectedIds.size + " 个";
    }

    function selectAllVisible() {
      currentFiles.forEach(function (file) {
        selectedIds.add(file.id);
      });
      restoreCheckboxes();
      updateSelectedCount();
    }

    function clearSelection() {
      selectedIds.clear();
      restoreCheckboxes();
      updateSelectedCount();
    }

    async function batchCopyLinks() {
      var links = [];

      selectedIds.forEach(function (id) {
        var file = findFile(id);
        getDownloadTargets(file).forEach(function (target) {
          links.push(location.origin + "/file/" + target.id);
        });
      });

      if (!links.length) {
        alert("没有选择文件");
        return;
      }

      await navigator.clipboard.writeText(links.join("\\n"));
      alert("已复制 " + links.length + " 条链接");
    }

    async function batchDownload() {
      if (!selectedIds.size) {
        alert("没有选择文件");
        return;
      }

      for (var id of selectedIds) {
        await downloadOne(id);
        await sleep(400);
      }
    }

    async function batchDelete() {
      if (!selectedIds.size) {
        alert("没有选择文件");
        return;
      }

      if (!confirm("确定批量删除选中的文件吗？实况照片会删除照片和视频两个文件。")) return;

      var ids = [];

      selectedIds.forEach(function (id) {
        var file = findFile(id);
        getDownloadTargets(file).forEach(function (target) {
          ids.push(target.id);
        });
      });

      var res = await fetch("/api/batch/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: ids })
      });

      var data = await res.json();

      if (!data.ok) {
        alert("批量删除失败：" + (data.error || "未知错误"));
        return;
      }

      selectedIds.clear();
      updateSelectedCount();
      await loadFiles();
    }

    async function copyOneLink(id) {
      var file = findFile(id);
      var targets = getDownloadTargets(file);

      if (!targets.length) return;

      var links = targets.map(function (t) {
        return location.origin + "/file/" + t.id;
      });

      await navigator.clipboard.writeText(links.join("\\n"));
      alert("已复制");
    }

    async function deleteOne(id) {
      var file = findFile(id);
      var targets = getDownloadTargets(file);

      if (!targets.length) return;
      if (!confirm("确定删除这个文件吗？")) return;

      var ids = targets.map(function (t) { return t.id; });

      var res = await fetch("/api/batch/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: ids })
      });

      var data = await res.json();

      if (!data.ok) {
        alert("删除失败：" + (data.error || "未知错误"));
        return;
      }

      selectedIds.delete(id);
      await loadFiles();
    }

    async function downloadOne(id) {
      var file = findFile(id);
      var targets = getDownloadTargets(file);

      for (var i = 0; i < targets.length; i++) {
        await downloadFileWithSpeed(
          "/file/" + encodeURIComponent(targets[i].id),
          targets[i].name,
          "download-status-" + id
        );
      }
    }

    async function downloadFileWithSpeed(url, fileName, statusId) {
      var statusEl = qs(statusId);

      if (statusEl) {
        statusEl.classList.remove("error", "success");
        statusEl.textContent = "准备下载...";
      }

      var startTime = Date.now();
      var lastTime = startTime;
      var lastLoaded = 0;
      var loaded = 0;

      try {
        var res = await fetch(url, { method: "GET", cache: "no-store" });

        if (!res.ok) {
          var text = await res.text();
          throw new Error(text || "下载失败");
        }

        var total = Number(res.headers.get("Content-Length") || 0);
        var reader = res.body.getReader();
        var chunks = [];

        while (true) {
          var result = await reader.read();
          if (result.done) break;

          var value = result.value;
          chunks.push(value);
          loaded += value.length;

          var now = Date.now();
          var elapsed = (now - startTime) / 1000;
          var instantElapsed = (now - lastTime) / 1000;
          var avgSpeed = elapsed > 0 ? loaded / elapsed : 0;
          var instantSpeed = instantElapsed > 0 ? (loaded - lastLoaded) / instantElapsed : 0;

          var percentText = "";
          var remainText = "";

          if (total > 0) {
            var percent = loaded / total * 100;
            var remainBytes = total - loaded;
            var remainSeconds = avgSpeed > 0 ? remainBytes / avgSpeed : 0;
            percentText = "进度：" + percent.toFixed(1) + "% ｜ ";
            remainText = " ｜ 预计剩余：" + formatDuration(remainSeconds);
          }

          if (statusEl) {
            statusEl.textContent =
              "下载中 ｜ " +
              percentText +
              "已下载：" + formatSize(loaded) +
              (total > 0 ? " / " + formatSize(total) : "") +
              " ｜ 实时速度：" + formatSpeed(instantSpeed) +
              " ｜ 平均速度：" + formatSpeed(avgSpeed) +
              remainText;
          }

          lastTime = now;
          lastLoaded = loaded;
        }

        var blob = new Blob(chunks);
        var blobUrl = URL.createObjectURL(blob);

        var a = document.createElement("a");
        a.href = blobUrl;
        a.download = fileName || "download";
        document.body.appendChild(a);
        a.click();
        a.remove();

        setTimeout(function () {
          URL.revokeObjectURL(blobUrl);
        }, 1000);

        if (statusEl) {
          var totalElapsed = (Date.now() - startTime) / 1000;
          var finalAvgSpeed = totalElapsed > 0 ? loaded / totalElapsed : 0;
          statusEl.classList.add("success");
          statusEl.textContent = "下载完成 ｜ 文件大小：" + formatSize(loaded) + " ｜ 平均速度：" + formatSpeed(finalAvgSpeed);
        }
      } catch (err) {
        if (statusEl) {
          statusEl.classList.add("error");
          statusEl.textContent = "下载失败：" + String(err && err.message ? err.message : err);
        }
      }
    }

    function openDetail(id) {
      var file = findFile(id);
      if (!file) return;

      var targets = getDownloadTargets(file);
      var modal = qs("detailModal");
      modal.innerHTML = "";

      var box = createEl("div", "modal");
      var head = createEl("div", "modal-head");
      var title = createEl("div", "modal-title", file.name || "-");
      var closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.className = "secondary";
      closeBtn.textContent = "关闭";
      closeBtn.addEventListener("click", closeDetail);

      head.appendChild(title);
      head.appendChild(closeBtn);

      var preview = createEl("div", "detail-preview");

      if (file.isLive) {
        if (file.photo && file.motion) {
          preview.appendChild(createLiveViewer(file.photo.id, file.motion.id, true));
        } else if (file.photo) {
          var img = document.createElement("img");
          img.src = "/file/" + encodeURIComponent(file.photo.id);
          preview.appendChild(img);
        } else if (file.motion) {
          var v = document.createElement("video");
          v.src = "/file/" + encodeURIComponent(file.motion.id);
          v.controls = true;
          v.preload = "metadata";
          preview.appendChild(v);
        }
      } else {
        var url = "/file/" + encodeURIComponent(file.id);
        var mime = file.mimeType || "";

        if (mime.indexOf("image/") === 0) {
          var img2 = document.createElement("img");
          img2.src = url;
          preview.appendChild(img2);
        } else if (mime.indexOf("video/") === 0) {
          var v2 = document.createElement("video");
          v2.src = url;
          v2.controls = true;
          v2.preload = "metadata";
          preview.appendChild(v2);
        } else {
          preview.appendChild(createEl("div", "", "📄"));
        }
      }

      var table = document.createElement("table");
      table.className = "detail-table";

      addRow(table, "类型", file.isLive ? "Live Photo" : (file.mimeType || "-"));
      addRow(table, "大小", file.size ? formatSize(Number(file.size)) : "-");
      addRow(table, "创建时间", file.createdTime ? new Date(file.createdTime).toLocaleString() : "-");
      addRow(table, "修改时间", file.modifiedTime ? new Date(file.modifiedTime).toLocaleString() : "-");
      addRow(table, "链接", targets.map(function (t) { return location.origin + "/file/" + t.id; }).join("\\n"));

      var actions = createEl("div", "actions");
      actions.appendChild(detailBtn("下载", function () { downloadOne(id); }));
      actions.appendChild(detailBtn("复制链接", function () { copyOneLink(id); }, "secondary"));
      actions.appendChild(detailBtn("删除", function () { deleteOne(id); }, "danger"));

      box.appendChild(head);
      box.appendChild(preview);
      box.appendChild(table);
      box.appendChild(document.createElement("br"));
      box.appendChild(actions);

      modal.appendChild(box);
      modal.classList.remove("hidden");
    }

    function addRow(table, k, v) {
      var tr = document.createElement("tr");
      var td1 = document.createElement("td");
      var td2 = document.createElement("td");
      td1.textContent = k;
      td2.textContent = v;
      td2.innerHTML = td2.textContent.replaceAll("\\n", "<br>");
      tr.appendChild(td1);
      tr.appendChild(td2);
      table.appendChild(tr);
    }

    function detailBtn(text, fn, cls) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = text;
      if (cls) btn.className = cls;
      btn.addEventListener("click", fn);
      return btn;
    }

    function closeDetail() {
      document.querySelectorAll(".live-viewer.playing").forEach(function (box) {
        stopLiveBox(box);
      });

      qs("detailModal").classList.add("hidden");
      qs("detailModal").innerHTML = "";
    }

    function formatSize(size) {
      if (!Number.isFinite(size)) return "-";
      if (size < 1024) return size + " B";
      if (size < 1024 * 1024) return (size / 1024).toFixed(1) + " KB";
      if (size < 1024 * 1024 * 1024) return (size / 1024 / 1024).toFixed(1) + " MB";
      return (size / 1024 / 1024 / 1024).toFixed(2) + " GB";
    }

    function formatSpeed(bytesPerSecond) {
      if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "0 B/s";
      if (bytesPerSecond < 1024) return bytesPerSecond.toFixed(0) + " B/s";
      if (bytesPerSecond < 1024 * 1024) return (bytesPerSecond / 1024).toFixed(1) + " KB/s";
      if (bytesPerSecond < 1024 * 1024 * 1024) return (bytesPerSecond / 1024 / 1024).toFixed(2) + " MB/s";
      return (bytesPerSecond / 1024 / 1024 / 1024).toFixed(2) + " GB/s";
    }

    function formatDuration(seconds) {
      if (!Number.isFinite(seconds) || seconds <= 0) return "-";
      if (seconds < 60) return Math.ceil(seconds) + " 秒";
      var min = Math.floor(seconds / 60);
      var sec = Math.ceil(seconds % 60);
      return min + " 分 " + sec + " 秒";
    }

    function escapeHtml(str) {
      return String(str)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
    }

    function sleep(ms) {
      return new Promise(function (resolve) {
        setTimeout(resolve, ms);
      });
    }
  </script>
</body>
</html>`;
