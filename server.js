import Bun from "bun";
import path from "path";
import fs from "fs";

const PORT = 3000;
const PUBLIC_DIR = "./public";
const ADMIN_PASSWORD = Bun.env.ADMIN_PASSWORD || "admin123";

// Simple session store
const sessions = new Map();

function generateSessionId() {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

function isAuthenticated(req) {
  const cookie = req.headers.get("cookie") || "";
  const sessionMatch = cookie.match(/sessionId=([^;]+)/);
  if (!sessionMatch) return false;
  const sessionId = sessionMatch[1];
  return sessions.has(sessionId) && Date.now() - sessions.get(sessionId) < 24 * 60 * 60 * 1000;
}

function getDomainFolder(hostname) {
  const domain = hostname.split(":")[0];
  return path.join(PUBLIC_DIR, domain);
}

async function handleFileManager(req, pathname) {
  const url = new URL(req.url, `http://${req.headers.get("host")}`);

  // Login endpoint
  if (pathname === "/api/login" && req.method === "POST") {
    const body = await req.json();
    if (body.password === ADMIN_PASSWORD) {
      const sessionId = generateSessionId();
      sessions.set(sessionId, Date.now());
      return new Response(JSON.stringify({ success: true, sessionId }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Set-Cookie": `sessionId=${sessionId}; Path=/; HttpOnly; Max-Age=86400`,
        },
      });
    }
    return new Response(JSON.stringify({ success: false, error: "Invalid password" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Check authentication
  if (!isAuthenticated(req)) {
    if (pathname === "/" || pathname === "/index.html") {
      return new Response(getLoginPage(), {
        headers: { "Content-Type": "text/html" },
      });
    }
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // List files
  if (pathname === "/api/files" && req.method === "GET") {
    const domain = url.searchParams.get("domain");
    if (!domain) {
      return new Response(JSON.stringify({ error: "Domain required" }), { status: 400 });
    }

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
      return new Response(JSON.stringify(fileList), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
  }

  // Upload file
  if (pathname === "/api/upload" && req.method === "POST") {
    const domain = url.searchParams.get("domain");
    if (!domain) {
      return new Response(JSON.stringify({ error: "Domain required" }), { status: 400 });
    }

    const domainPath = path.join(PUBLIC_DIR, domain);
    try {
      const formData = await req.formData();
      const file = formData.get("file");
      if (!file) {
        return new Response(JSON.stringify({ error: "No file provided" }), { status: 400 });
      }

      const filename = file.name;
      const filepath = path.join(domainPath, filename);

      if (!filepath.startsWith(domainPath)) {
        return new Response(JSON.stringify({ error: "Invalid file path" }), { status: 400 });
      }

      const buffer = await file.arrayBuffer();
      fs.writeFileSync(filepath, Buffer.from(buffer));

      return new Response(JSON.stringify({ success: true, filename }), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
  }

  // Delete file
  if (pathname === "/api/delete" && req.method === "POST") {
    const domain = url.searchParams.get("domain");
    const filename = url.searchParams.get("filename");
    if (!domain || !filename) {
      return new Response(JSON.stringify({ error: "Domain and filename required" }), { status: 400 });
    }

    const filepath = path.join(PUBLIC_DIR, domain, filename);
    const domainPath = path.join(PUBLIC_DIR, domain);

    if (!filepath.startsWith(domainPath)) {
      return new Response(JSON.stringify({ error: "Invalid file path" }), { status: 400 });
    }

    try {
      if (fs.existsSync(filepath)) {
        fs.rmSync(filepath, { recursive: true });
        return new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "File not found" }), { status: 404 });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
  }

  // Download file
  if (pathname === "/api/download" && req.method === "GET") {
    const domain = url.searchParams.get("domain");
    const filename = url.searchParams.get("filename");
    if (!domain || !filename) {
      return new Response(JSON.stringify({ error: "Domain and filename required" }), { status: 400 });
    }

    const filepath = path.join(PUBLIC_DIR, domain, filename);
    const domainPath = path.join(PUBLIC_DIR, domain);

    if (!filepath.startsWith(domainPath)) {
      return new Response(JSON.stringify({ error: "Invalid file path" }), { status: 400 });
    }

    try {
      if (fs.existsSync(filepath) && fs.statSync(filepath).isFile()) {
        const file = Bun.file(filepath);
        return new Response(file, {
          headers: {
            "Content-Disposition": `attachment; filename="${filename}"`,
          },
        });
      }
      return new Response(JSON.stringify({ error: "File not found" }), { status: 404 });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
  }

  // Dashboard
  if (pathname === "/" || pathname === "/index.html") {
    return new Response(getDashboardPage(), {
      headers: { "Content-Type": "text/html" },
    });
  }

  return new Response("Not found", { status: 404 });
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
Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const pathname = url.pathname;

    // File manager routes
    if (pathname.startsWith("/api/") || pathname === "/" || pathname === "/index.html") {
      return handleFileManager(req, pathname);
    }

    // Static file serving based on domain
    const hostname = req.headers.get("host") || "localhost";
    const domainFolder = getDomainFolder(hostname);

    let filePath = path.join(domainFolder, pathname === "/" ? "index.html" : pathname);

    // Security: prevent directory traversal
    if (!filePath.startsWith(domainFolder)) {
      return new Response("Forbidden", { status: 403 });
    }

    try {
      // Check if it's a directory, serve index.html
      if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
        filePath = path.join(filePath, "index.html");
      }

      if (fs.existsSync(filePath)) {
        const file = Bun.file(filePath);
        return new Response(file);
      }

      return new Response("Not found", { status: 404 });
    } catch (error) {
      return new Response("Server error", { status: 500 });
    }
  },
});

console.log(`🚀 Server running on http://localhost:${PORT}`);
console.log(`📁 Static files served from ./public/{domain}`);
console.log(`🔐 File manager available at http://localhost:${PORT}`);
