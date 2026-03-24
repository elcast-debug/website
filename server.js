import http from "http";
import path from "path";
import fs from "fs";

const PORT = 3000;
const PUBLIC_DIR = "./public";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";

// MIME type map for static file serving
const MIME_TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".txt": "text/plain",
  ".xml": "application/xml",
};

// Simple session store
const sessions = new Map();

function generateSessionId() {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

function isAuthenticated(headers) {
  const cookie = headers["cookie"] || "";
  const sessionMatch = cookie.match(/sessionId=([^;]+)/);
  if (!sessionMatch) return false;
  const sessionId = sessionMatch[1];
  return sessions.has(sessionId) && Date.now() - sessions.get(sessionId) < 24 * 60 * 60 * 1000;
}

function getDomainFolder(hostname) {
  const domain = hostname.split(":")[0];
  return path.join(PUBLIC_DIR, domain);
}

// Read the full request body as a Buffer
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Parse multipart/form-data — returns { fields, files: [{ fieldname, filename, data }] }
function parseMultipart(body, boundary) {
  const files = [];
  const fields = {};
  const boundaryBuf = Buffer.from("--" + boundary);
  const parts = [];

  let start = 0;
  while (start < body.length) {
    const boundaryIdx = body.indexOf(boundaryBuf, start);
    if (boundaryIdx === -1) break;
    const afterBoundary = boundaryIdx + boundaryBuf.length;
    // Check for final boundary (--)
    if (body[afterBoundary] === 0x2d && body[afterBoundary + 1] === 0x2d) break;
    // Skip CRLF after boundary
    const headerStart = afterBoundary + 2;
    // Find end of headers (double CRLF)
    const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"), headerStart);
    if (headerEnd === -1) break;
    const headerStr = body.slice(headerStart, headerEnd).toString("utf8");
    const dataStart = headerEnd + 4;
    // Find next boundary
    const nextBoundary = body.indexOf(boundaryBuf, dataStart);
    const dataEnd = nextBoundary === -1 ? body.length : nextBoundary - 2; // strip trailing CRLF
    const data = body.slice(dataStart, dataEnd);
    parts.push({ headerStr, data });
    start = nextBoundary === -1 ? body.length : nextBoundary;
  }

  for (const { headerStr, data } of parts) {
    const dispositionMatch = headerStr.match(/Content-Disposition:[^\r\n]*name="([^"]+)"/i);
    const filenameMatch = headerStr.match(/Content-Disposition:[^\r\n]*filename="([^"]+)"/i);
    if (!dispositionMatch) continue;
    const fieldname = dispositionMatch[1];
    if (filenameMatch) {
      files.push({ fieldname, filename: filenameMatch[1], data });
    } else {
      fields[fieldname] = data.toString("utf8");
    }
  }

  return { fields, files };
}

// Send a JSON response
function sendJSON(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

// Send an HTML response
function sendHTML(res, status, html, extraHeaders = {}) {
  res.writeHead(status, { "Content-Type": "text/html", ...extraHeaders });
  res.end(html);
}

async function handleFileManager(req, res, pathname, searchParams) {
  // Login endpoint
  if (pathname === "/api/login" && req.method === "POST") {
    let body;
    try {
      const raw = await readBody(req);
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      return sendJSON(res, 400, { error: "Invalid JSON" });
    }
    if (body.password === ADMIN_PASSWORD) {
      const sessionId = generateSessionId();
      sessions.set(sessionId, Date.now());
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Set-Cookie": `sessionId=${sessionId}; Path=/; HttpOnly; Max-Age=86400`,
      });
      return res.end(JSON.stringify({ success: true, sessionId }));
    }
    return sendJSON(res, 401, { success: false, error: "Invalid password" });
  }

  // Check authentication for all other routes
  if (!isAuthenticated(req.headers)) {
    if (pathname === "/" || pathname === "/index.html") {
      return sendHTML(res, 200, getLoginPage());
    }
    return sendJSON(res, 401, { error: "Unauthorized" });
  }

  // List files
  if (pathname === "/api/files" && req.method === "GET") {
    const domain = searchParams.get("domain");
    if (!domain) return sendJSON(res, 400, { error: "Domain required" });

    const domainPath = path.join(PUBLIC_DIR, domain);
    try {
      if (!fs.existsSync(domainPath)) {
        fs.mkdirSync(domainPath, { recursive: true });
      }
      const files = fs.readdirSync(domainPath, { withFileTypes: true });
      const fileList = files.map((file) => ({
        name: file.name,
        isDirectory: file.isDirectory(),
        size: file.isDirectory() ? null : fs.statSync(path.join(domainPath, file.name)).size,
      }));
      return sendJSON(res, 200, fileList);
    } catch (error) {
      return sendJSON(res, 500, { error: error.message });
    }
  }

  // Upload file
  if (pathname === "/api/upload" && req.method === "POST") {
    const domain = searchParams.get("domain");
    if (!domain) return sendJSON(res, 400, { error: "Domain required" });

    const domainPath = path.join(PUBLIC_DIR, domain);
    try {
      const contentType = req.headers["content-type"] || "";
      const boundaryMatch = contentType.match(/boundary=(.+)$/);
      if (!boundaryMatch) return sendJSON(res, 400, { error: "Invalid multipart request" });

      const body = await readBody(req);
      const { files } = parseMultipart(body, boundaryMatch[1]);

      if (!files.length) return sendJSON(res, 400, { error: "No file provided" });

      if (!fs.existsSync(domainPath)) {
        fs.mkdirSync(domainPath, { recursive: true });
      }

      for (const file of files) {
        const filename = path.basename(file.filename);
        const filepath = path.join(domainPath, filename);
        if (!path.resolve(filepath).startsWith(path.resolve(domainPath))) {
          return sendJSON(res, 400, { error: "Invalid file path" });
        }
        fs.writeFileSync(filepath, file.data);
      }

      return sendJSON(res, 200, { success: true, filename: files[0].filename });
    } catch (error) {
      return sendJSON(res, 500, { error: error.message });
    }
  }

  // Delete file
  if (pathname === "/api/delete" && req.method === "POST") {
    const domain = searchParams.get("domain");
    const filename = searchParams.get("filename");
    if (!domain || !filename) return sendJSON(res, 400, { error: "Domain and filename required" });

    const domainPath = path.join(PUBLIC_DIR, domain);
    const filepath = path.join(domainPath, filename);

    if (!path.resolve(filepath).startsWith(path.resolve(domainPath))) {
      return sendJSON(res, 400, { error: "Invalid file path" });
    }

    try {
      if (fs.existsSync(filepath)) {
        fs.rmSync(filepath, { recursive: true });
        return sendJSON(res, 200, { success: true });
      }
      return sendJSON(res, 404, { error: "File not found" });
    } catch (error) {
      return sendJSON(res, 500, { error: error.message });
    }
  }

  // Download file
  if (pathname === "/api/download" && req.method === "GET") {
    const domain = searchParams.get("domain");
    const filename = searchParams.get("filename");
    if (!domain || !filename) return sendJSON(res, 400, { error: "Domain and filename required" });

    const domainPath = path.join(PUBLIC_DIR, domain);
    const filepath = path.join(domainPath, filename);

    if (!path.resolve(filepath).startsWith(path.resolve(domainPath))) {
      return sendJSON(res, 400, { error: "Invalid file path" });
    }

    try {
      if (fs.existsSync(filepath) && fs.statSync(filepath).isFile()) {
        const stat = fs.statSync(filepath);
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="${path.basename(filename)}"`,
          "Content-Length": stat.size,
        });
        fs.createReadStream(filepath).pipe(res);
        return;
      }
      return sendJSON(res, 404, { error: "File not found" });
    } catch (error) {
      return sendJSON(res, 500, { error: error.message });
    }
  }

  // Dashboard
  if (pathname === "/" || pathname === "/index.html") {
    return sendHTML(res, 200, getDashboardPage());
  }

  sendJSON(res, 404, { error: "Not found" });
}

function getLoginPage() {
  return `<!DOCTYPE html>
<html>
<head>
  <title>File Manager - Login</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .login-container { background: white; padding: 40px; border-radius: 10px; box-shadow: 0 10px 25px rgba(0,0,0,0.2); width: 100%; max-width: 400px; }
    h1 { margin-bottom: 30px; color: #333; text-align: center; }
    .form-group { margin-bottom: 20px; }
    label { display: block; margin-bottom: 8px; color: #555; font-weight: 500; }
    input { width: 100%; padding: 12px; border: 1px solid #ddd; border-radius: 5px; font-size: 16px; }
    input:focus { outline: none; border-color: #667eea; box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1); }
    button { width: 100%; padding: 12px; background: #667eea; color: white; border: none; border-radius: 5px; font-size: 16px; font-weight: 600; cursor: pointer; transition: background 0.3s; }
    button:hover { background: #5568d3; }
    .error { color: #e74c3c; margin-top: 10px; text-align: center; }
  </style>
</head>
<body>
  <div class="login-container">
    <h1>File Manager</h1>
    <form id="loginForm">
      <div class="form-group">
        <label for="password">Password</label>
        <input type="password" id="password" required>
      </div>
      <button type="submit">Login</button>
      <div id="error" class="error"></div>
    </form>
  </div>
  <script>
    document.getElementById('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const password = document.getElementById('password').value;
      try {
        const res = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password })
        });
        const data = await res.json();
        if (data.success) {
          window.location.href = '/';
        } else {
          document.getElementById('error').textContent = 'Invalid password';
        }
      } catch (err) {
        document.getElementById('error').textContent = 'Login failed';
      }
    });
  </script>
</body>
</html>`;
}

function getDashboardPage() {
  return `<!DOCTYPE html>
<html>
<head>
  <title>File Manager</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; }
    .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
    header { background: white; padding: 20px; border-radius: 8px; margin-bottom: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); display: flex; justify-content: space-between; align-items: center; }
    h1 { color: #333; }
    .domain-selector { display: flex; gap: 10px; }
    input[type="text"] { padding: 10px; border: 1px solid #ddd; border-radius: 5px; width: 300px; }
    button { padding: 10px 20px; background: #667eea; color: white; border: none; border-radius: 5px; cursor: pointer; font-weight: 600; }
    button:hover { background: #5568d3; }
    .content { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .file-list { list-style: none; }
    .file-item { padding: 12px; border-bottom: 1px solid #eee; display: flex; justify-content: space-between; align-items: center; }
    .file-item:last-child { border-bottom: none; }
    .file-name { display: flex; align-items: center; gap: 8px; flex: 1; }
    .file-icon { font-size: 18px; }
    .file-actions { display: flex; gap: 8px; }
    .btn-small { padding: 6px 12px; font-size: 12px; background: #667eea; color: white; border: none; border-radius: 4px; cursor: pointer; }
    .btn-small:hover { background: #5568d3; }
    .btn-delete { background: #e74c3c; }
    .btn-delete:hover { background: #c0392b; }
    .upload-area { border: 2px dashed #667eea; border-radius: 8px; padding: 30px; text-align: center; cursor: pointer; transition: background 0.3s; margin-bottom: 20px; }
    .upload-area:hover { background: #f0f4ff; }
    .upload-area.dragover { background: #e8ecff; }
    .file-size { color: #999; font-size: 12px; }
    .empty { color: #999; text-align: center; padding: 40px 20px; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>📁 File Manager</h1>
      <div class="domain-selector">
        <input type="text" id="domainInput" placeholder="e.g., elcast.org" value="elcast.org">
        <button onclick="loadFiles()">Load Domain</button>
      </div>
    </header>
    <div class="content">
      <div class="upload-area" id="uploadArea">
        <p>📤 Drag files here or click to upload</p>
        <input type="file" id="fileInput" style="display: none;" multiple>
      </div>
      <h3>Files in <span id="currentDomain">elcast.org</span></h3>
      <ul class="file-list" id="fileList"></ul>
    </div>
  </div>

  <script>
    const domainInput = document.getElementById('domainInput');
    const fileInput = document.getElementById('fileInput');
    const uploadArea = document.getElementById('uploadArea');
    const fileList = document.getElementById('fileList');
    const currentDomainSpan = document.getElementById('currentDomain');

    uploadArea.addEventListener('click', () => fileInput.click());
    uploadArea.addEventListener('dragover', (e) => {
      e.preventDefault();
      uploadArea.classList.add('dragover');
    });
    uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('dragover'));
    uploadArea.addEventListener('drop', (e) => {
      e.preventDefault();
      uploadArea.classList.remove('dragover');
      handleFiles(e.dataTransfer.files);
    });

    fileInput.addEventListener('change', (e) => handleFiles(e.target.files));

    async function handleFiles(files) {
      const domain = domainInput.value.trim();
      if (!domain) {
        alert('Please enter a domain');
        return;
      }
      for (const file of files) {
        const formData = new FormData();
        formData.append('file', file);
        try {
          const res = await fetch(\`/api/upload?domain=\${encodeURIComponent(domain)}\`, {
            method: 'POST',
            body: formData
          });
          if (res.ok) {
            loadFiles();
          } else {
            alert('Upload failed');
          }
        } catch (err) {
          alert('Upload error: ' + err.message);
        }
      }
      fileInput.value = '';
    }

    async function loadFiles() {
      const domain = domainInput.value.trim();
      if (!domain) {
        alert('Please enter a domain');
        return;
      }
      currentDomainSpan.textContent = domain;
      try {
        const res = await fetch(\`/api/files?domain=\${encodeURIComponent(domain)}\`);
        const files = await res.json();
        fileList.innerHTML = '';
        if (files.length === 0) {
          fileList.innerHTML = '<div class="empty">No files yet</div>';
          return;
        }
        files.forEach(file => {
          const li = document.createElement('li');
          li.className = 'file-item';
          const icon = file.isDirectory ? '📁' : '📄';
          const size = file.size ? \` (\${(file.size / 1024).toFixed(2)} KB)\` : '';
          li.innerHTML = \`
            <div class="file-name">
              <span class="file-icon">\${icon}</span>
              <div>
                <div>\${file.name}</div>
                <div class="file-size">\${size}</div>
              </div>
            </div>
            <div class="file-actions">
              \${!file.isDirectory ? \`<button class="btn-small" onclick="downloadFile('\${file.name}')">Download</button>\` : ''}
              <button class="btn-small btn-delete" onclick="deleteFile('\${file.name}')">Delete</button>
            </div>
          \`;
          fileList.appendChild(li);
        });
      } catch (err) {
        alert('Error loading files: ' + err.message);
      }
    }

    async function deleteFile(filename) {
      if (!confirm('Delete ' + filename + '?')) return;
      const domain = domainInput.value.trim();
      try {
        const res = await fetch(\`/api/delete?domain=\${encodeURIComponent(domain)}&filename=\${encodeURIComponent(filename)}\`, {
          method: 'POST'
        });
        if (res.ok) {
          loadFiles();
        } else {
          alert('Delete failed');
        }
      } catch (err) {
        alert('Delete error: ' + err.message);
      }
    }

    async function downloadFile(filename) {
      const domain = domainInput.value.trim();
      window.location.href = \`/api/download?domain=\${encodeURIComponent(domain)}&filename=\${encodeURIComponent(filename)}\`;
    }

    loadFiles();
  </script>
</body>
</html>`;
}

// Main server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;
  const searchParams = url.searchParams;

  // File manager routes
  if (pathname.startsWith("/api/") || pathname === "/" || pathname === "/index.html") {
    try {
      await handleFileManager(req, res, pathname, searchParams);
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    }
    return;
  }

  // Static file serving based on domain
  const hostname = req.headers.host || "localhost";
  const domainFolder = getDomainFolder(hostname);

  let filePath = path.join(domainFolder, pathname === "/" ? "index.html" : pathname);

  // Security: prevent directory traversal
  if (!path.resolve(filePath).startsWith(path.resolve(domainFolder))) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    // Check if it's a directory, serve index.html
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, "index.html");
    }

    if (fs.existsSync(filePath)) {
      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || "application/octet-stream";
      const stat = fs.statSync(filePath);
      res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": stat.size,
      });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  } catch (error) {
    res.writeHead(500);
    res.end("Server error");
  }
});

server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📁 Static files served from ./public/{domain}`);
  console.log(`🔐 File manager available at http://localhost:${PORT}`);
});
