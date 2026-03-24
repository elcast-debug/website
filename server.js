import http from "http";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = 3000;
const PUBLIC_DIR = "./public";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";

// Simple session store
const sessions = new Map();

function generateSessionId() {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

function isAuthenticated(cookieHeader) {
  const cookie = cookieHeader || "";
  const sessionMatch = cookie.match(/sessionId=([^;]+)/);
  if (!sessionMatch) return false;
  const sessionId = sessionMatch[1];
  return sessions.has(sessionId) && Date.now() - sessions.get(sessionId) < 24 * 60 * 60 * 1000;
}

function getDomainFolder(hostname) {
  const domain = hostname.split(":")[0];
  return path.join(PUBLIC_DIR, domain);
}

// Helper: read full request body as text/buffer
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Helper: parse multipart/form-data manually (single file)
function parseMultipart(buffer, boundary) {
  const boundaryBuffer = Buffer.from("--" + boundary);
  const parts = [];
  let start = 0;

  while (start < buffer.length) {
    const boundaryIndex = buffer.indexOf(boundaryBuffer, start);
    if (boundaryIndex === -1) break;

    const headerStart = boundaryIndex + boundaryBuffer.length + 2; // skip \r\n
    const headerEnd = buffer.indexOf(Buffer.from("\r\n\r\n"), headerStart);
    if (headerEnd === -1) break;

    const headerStr = buffer.slice(headerStart, headerEnd).toString();
    const dataStart = headerEnd + 4;
    const nextBoundary = buffer.indexOf(boundaryBuffer, dataStart);
    const dataEnd = nextBoundary === -1 ? buffer.length : nextBoundary - 2; // strip \r\n

    const nameMatch = headerStr.match(/name="([^"]+)"/);
    const filenameMatch = headerStr.match(/filename="([^"]+)"/);

    if (nameMatch) {
      parts.push({
        name: nameMatch[1],
        filename: filenameMatch ? filenameMatch[1] : null,
        data: buffer.slice(dataStart, dataEnd),
      });
    }

    start = nextBoundary === -1 ? buffer.length : nextBoundary;
  }

  return parts;
}

// Helper: send JSON response
function sendJSON(res, data, status = 200, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

// Helper: send HTML response
function sendHTML(res, html) {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(html);
}

// Helper: get MIME type
function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
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
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
    ".txt": "text/plain",
    ".pdf": "application/pdf",
  };
  return mimeTypes[ext] || "application/octet-stream";
}

async function handleFileManager(req, res, pathname, query) {
  const cookieHeader = req.headers["cookie"] || "";

  // Login endpoint
  if (pathname === "/api/login" && req.method === "POST") {
    const raw = await readBody(req);
    let body;
    try {
      body = JSON.parse(raw.toString());
    } catch {
      return sendJSON(res, { error: "Invalid JSON" }, 400);
    }

    if (body.password === ADMIN_PASSWORD) {
      const sessionId = generateSessionId();
      sessions.set(sessionId, Date.now());
      return sendJSON(res, { success: true, sessionId }, 200, {
        "Set-Cookie": `sessionId=${sessionId}; Path=/; HttpOnly; Max-Age=86400`,
      });
    }
    return sendJSON(res, { success: false, error: "Invalid password" }, 401);
  }

  // Check authentication
  if (!isAuthenticated(cookieHeader)) {
    if (pathname === "/" || pathname === "/index.html") {
      return sendHTML(res, getLoginPage());
    }
    return sendJSON(res, { error: "Unauthorized" }, 401);
  }

  // List files
  if (pathname === "/api/files" && req.method === "GET") {
    const domain = query.get("domain");
    if (!domain) return sendJSON(res, { error: "Domain required" }, 400);

    const domainPath = path.join(PUBLIC_DIR, domain);
    try {
      if (!fs.existsSync(domainPath)) fs.mkdirSync(domainPath, { recursive: true });
      const files = fs.readdirSync(domainPath, { withFileTypes: true });
      const fileList = files.map((file) => ({
        name: file.name,
        isDirectory: file.isDirectory(),
        size: file.isDirectory() ? null : fs.statSync(path.join(domainPath, file.name)).size,
      }));
      return sendJSON(res, fileList);
    } catch (error) {
      return sendJSON(res, { error: error.message }, 500);
    }
  }

  // Upload file
  if (pathname === "/api/upload" && req.method === "POST") {
    const domain = query.get("domain");
    if (!domain) return sendJSON(res, { error: "Domain required" }, 400);

    const domainPath = path.join(PUBLIC_DIR, domain);
    const contentType = req.headers["content-type"] || "";
    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) return sendJSON(res, { error: "Invalid multipart boundary" }, 400);

    try {
      const buffer = await readBody(req);
      const parts = parseMultipart(buffer, boundaryMatch[1]);
      const filePart = parts.find((p) => p.name === "file" && p.filename);
      if (!filePart) return sendJSON(res, { error: "No file provided" }, 400);

      const filename = path.basename(filePart.filename); // sanitize
      const filepath = path.join(domainPath, filename);

      if (!filepath.startsWith(path.resolve(domainPath))) {
        return sendJSON(res, { error: "Invalid file path" }, 400);
      }

      if (!fs.existsSync(domainPath)) fs.mkdirSync(domainPath, { recursive: true });
      fs.writeFileSync(filepath, filePart.data);
      return sendJSON(res, { success: true, filename });
    } catch (error) {
      return sendJSON(res, { error: error.message }, 500);
    }
  }

  // Delete file
  if (pathname === "/api/delete" && req.method === "POST") {
    const domain = query.get("domain");
    const filename = query.get("filename");
    if (!domain || !filename) return sendJSON(res, { error: "Domain and filename required" }, 400);

    const domainPath = path.resolve(PUBLIC_DIR, domain);
    const filepath = path.resolve(domainPath, filename);

    if (!filepath.startsWith(domainPath)) {
      return sendJSON(res, { error: "Invalid file path" }, 400);
    }

    try {
      if (fs.existsSync(filepath)) {
        fs.rmSync(filepath, { recursive: true });
        return sendJSON(res, { success: true });
      }
      return sendJSON(res, { error: "File not found" }, 404);
    } catch (error) {
      return sendJSON(res, { error: error.message }, 500);
    }
  }

  // Download file
  if (pathname === "/api/download" && req.method === "GET") {
    const domain = query.get("domain");
    const filename = query.get("filename");
    if (!domain || !filename) return sendJSON(res, { error: "Domain and filename required" }, 400);

    const domainPath = path.resolve(PUBLIC_DIR, domain);
    const filepath = path.resolve(domainPath, filename);

    if (!filepath.startsWith(domainPath)) {
      return sendJSON(res, { error: "Invalid file path" }, 400);
    }

    try {
      if (fs.existsSync(filepath) && fs.statSync(filepath).isFile()) {
        const stat = fs.statSync(filepath);
        res.writeHead(200, {
          "Content-Disposition": `attachment; filename="${path.basename(filename)}"`,
          "Content-Type": "application/octet-stream",
          "Content-Length": stat.size,
        });
        fs.createReadStream(filepath).pipe(res);
        return;
      }
      return sendJSON(res, { error: "File not found" }, 404);
    } catch (error) {
      return sendJSON(res, { error: error.message }, 500);
    }
  }

  // Dashboard
  if (pathname === "/" || pathname === "/index.html") {
    return sendHTML(res, getDashboardPage());
  }

  res.writeHead(404);
  res.end("Not found");
}

// Main server
const server = http.createServer(async (req, res) => {
  const fullUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = fullUrl.pathname;
  const query = fullUrl.searchParams;

  // File manager routes
  if (pathname.startsWith("/api/") || pathname === "/" || pathname === "/index.html") {
    try {
      await handleFileManager(req, res, pathname, query);
    } catch (err) {
      sendJSON(res, { error: "Internal server error" }, 500);
    }
    return;
  }

  // Static file serving based on domain
  const hostname = req.headers["host"] || "localhost";
  const domainFolder = getDomainFolder(hostname);
  let filePath = path.join(domainFolder, pathname === "/" ? "index.html" : pathname);

  // Security: prevent directory traversal
  if (!filePath.startsWith(path.resolve(domainFolder))) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, "index.html");
    }

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const stat = fs.statSync(filePath);
      res.writeHead(200, {
        "Content-Type": getMimeType(filePath),
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
