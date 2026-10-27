"use strict";

const http = require("http");
const url = require("url");
const fs = require("fs");
const path = require("path");
const appLauncher = require("./app-launcher");

let appInstance = null;
let shellInstance = null;
let tokenFilePath = null;

// Read credentials from .env
function getCredentials() {
  const envPath = path.join(__dirname, ".env");
  let clientId = process.env.GOOGLE_CLIENT_ID || "";
  let clientSecret = process.env.GOOGLE_CLIENT_SECRET || "";

  if ((!clientId || !clientSecret || clientId.includes("PASTE_")) && fs.existsSync(envPath)) {
    try {
      const content = fs.readFileSync(envPath, "utf8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("GOOGLE_CLIENT_ID=")) {
          clientId = trimmed.replace("GOOGLE_CLIENT_ID=", "").trim();
        }
        if (trimmed.startsWith("GOOGLE_CLIENT_SECRET=")) {
          clientSecret = trimmed.replace("GOOGLE_CLIENT_SECRET=", "").trim();
        }
      }
    } catch (_) {}
  }

  // Strip wrapping quotes
  clientId = clientId.replace(/^["']|["']$/g, "").trim();
  clientSecret = clientSecret.replace(/^["']|["']$/g, "").trim();

  // Fallback to credentials.json if downloaded from Google Cloud Console
  if (!clientId || !clientSecret) {
    const credPath = path.join(__dirname, "credentials.json");
    if (fs.existsSync(credPath)) {
      try {
        const json = JSON.parse(fs.readFileSync(credPath, "utf8"));
        const installed = json.installed || json.web || {};
        clientId = clientId || installed.client_id || "";
        clientSecret = clientSecret || installed.client_secret || "";
      } catch (_) {}
    }
  }

  return { clientId, clientSecret };
}

function getTokenPath() {
  if (tokenFilePath && fs.existsSync(tokenFilePath)) return tokenFilePath;
  const projectTokenPath = path.join(__dirname, "classroom-token.json");
  if (appInstance && typeof appInstance.getPath === "function") {
    try {
      const userTokenPath = path.join(appInstance.getPath("userData"), "classroom-token.json");
      if (fs.existsSync(userTokenPath)) {
        tokenFilePath = userTokenPath;
        return tokenFilePath;
      }
      if (fs.existsSync(projectTokenPath)) {
        try {
          fs.mkdirSync(path.dirname(userTokenPath), { recursive: true });
          fs.copyFileSync(projectTokenPath, userTokenPath);
        } catch (_) {}
        tokenFilePath = userTokenPath;
        return tokenFilePath;
      }
      tokenFilePath = userTokenPath;
      return tokenFilePath;
    } catch (_) {
      tokenFilePath = projectTokenPath;
      return tokenFilePath;
    }
  }
  tokenFilePath = projectTokenPath;
  return tokenFilePath;
}

function loadSavedToken() {
  const p = getTokenPath();
  if (fs.existsSync(p)) {
    try {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch (_) {}
  }
  const projectToken = path.join(__dirname, "classroom-token.json");
  if (p !== projectToken && fs.existsSync(projectToken)) {
    try {
      return JSON.parse(fs.readFileSync(projectToken, "utf8"));
    } catch (_) {}
  }
  return null;
}

function saveToken(tokenData) {
  const p = getTokenPath();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(tokenData, null, 2), "utf8");
    const projectPath = path.join(__dirname, "classroom-token.json");
    if (p !== projectPath) {
      try {
        fs.writeFileSync(projectPath, JSON.stringify(tokenData, null, 2), "utf8");
      } catch (_) {}
    }
    return true;
  } catch (err) {
    console.error("[GoogleClassroom] Failed to save token:", err);
    return false;
  }
}

let memoryCache = null;

function getCachePath() {
  if (appInstance && typeof appInstance.getPath === "function") {
    try {
      return path.join(appInstance.getPath("userData"), "classroom-cache.json");
    } catch (_) {}
  }
  return path.join(__dirname, "classroom-cache.json");
}

function loadCachedClassroom() {
  if (memoryCache) return memoryCache;
  const p = getCachePath();
  if (fs.existsSync(p)) {
    try {
      memoryCache = JSON.parse(fs.readFileSync(p, "utf8"));
      return memoryCache;
    } catch (_) {}
  }
  const fallback = path.join(__dirname, "classroom-cache.json");
  if (p !== fallback && fs.existsSync(fallback)) {
    try {
      memoryCache = JSON.parse(fs.readFileSync(fallback, "utf8"));
      return memoryCache;
    } catch (_) {}
  }
  return null;
}

function saveCachedClassroom(data) {
  memoryCache = data;
  const p = getCachePath();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf8");
    const fallback = path.join(__dirname, "classroom-cache.json");
    if (p !== fallback) {
      try {
        fs.writeFileSync(fallback, JSON.stringify(data, null, 2), "utf8");
      } catch (_) {}
    }
  } catch (err) {
    console.warn("[GoogleClassroom] Failed to save classroom cache:", err.message);
  }
}

function getClassroomSummaryText() {
  if (!isConnected()) return "";
  const data = loadCachedClassroom();
  if (!data || !data.courses) return "Google Classroom is connected.";
  const courses = data.courses || [];
  const pending = data.pendingAssignments || data.assignments || [];
  const submitted = data.submittedAssignments || [];
  const total = data.totalCount || (pending.length + submitted.length);

  const courseLines = courses.map((c) => {
    const details = [c.subject, c.section ? `Sec ${c.section}` : ""].filter(Boolean).join(", ");
    return `- ${c.name}${details ? ` (${details})` : ""}`;
  }).join("\n");

  const pendingLines = pending.slice(0, 10).map((a) => {
    return `- "${a.title}" (${a.courseName}) — ${a.dueDateFormatted || "No due date"}`;
  }).join("\n");

  const submittedLines = submitted.slice(0, 10).map((a) => {
    return `- "${a.title}" (${a.courseName}) — Turned in`;
  }).join("\n");

  return [
    "Google Classroom integration status: Connected",
    `Enrolled Subjects / Courses (${courses.length}):`,
    courseLines || "(none)",
    `Assignments Summary (Total: ${total}, Pending: ${pending.length}, Submitted: ${submitted.length}):`,
    pending.length > 0 ? `Pending assignments:\n${pendingLines}` : "No pending assignments (all submitted or none posted).",
    submitted.length > 0 ? `Submitted assignments (recent):\n${submittedLines}` : "",
  ].filter(Boolean).join("\n");
}

function clearToken() {
  memoryCache = null;
  const paths = [getTokenPath(), path.join(__dirname, "classroom-token.json"), getCachePath(), path.join(__dirname, "classroom-cache.json")];
  for (const p of paths) {
    if (p && fs.existsSync(p)) {
      try {
        fs.unlinkSync(p);
      } catch (_) {}
    }
  }
}

// Refresh access token if expired
async function getValidAccessToken() {
  let token = loadSavedToken();
  if (!token || !token.refresh_token) {
    return null;
  }

  const now = Date.now();
  // If still valid for at least 60 seconds
  if (token.access_token && token.expires_at && now < token.expires_at - 60000) {
    return token.access_token;
  }

  // Need to refresh
  const { clientId, clientSecret } = getCredentials();
  if (!clientId || !clientSecret) return null;

  try {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: token.refresh_token,
        grant_type: "refresh_token",
      }),
    });

    if (!response.ok) {
      console.error("[GoogleClassroom] Token refresh failed:", response.status);
      return null;
    }

    const data = await response.json();
    token.access_token = data.access_token;
    token.expires_at = Date.now() + (data.expires_in || 3600) * 1000;
    saveToken(token);
    return token.access_token;
  } catch (err) {
    console.error("[GoogleClassroom] Token refresh error:", err);
    return null;
  }
}

/**
 * Start OAuth 2.0 loopback flow in user's browser.
 */
function startAuthFlow() {
  const { clientId, clientSecret } = getCredentials();
  if (!clientId || !clientSecret || clientId.includes("PASTE_")) {
    return Promise.reject(new Error("Please configure GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env"));
  }

  return new Promise((resolve, reject) => {
    // Ephemeral local server on random available port
    const server = http.createServer(async (req, res) => {
      try {
        const parsedUrl = url.parse(req.url, true);
        if (parsedUrl.pathname === "/oauth2callback" || parsedUrl.pathname === "/") {
          const code = parsedUrl.query.code;
          const error = parsedUrl.query.error;

          if (error) {
            res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
            res.end("<h3>Google authorization cancelled or failed. You can close this tab.</h3>");
            server.close();
            reject(new Error(`Authorization failed: ${error}`));
            return;
          }

          if (code) {
            // Exchange code for tokens
            const redirectUri = `http://127.0.0.1:${server.address().port}/oauth2callback`;
            const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                code: String(code),
                client_id: clientId,
                client_secret: clientSecret,
                redirect_uri: redirectUri,
                grant_type: "authorization_code",
              }),
            });

            if (!tokenRes.ok) {
              const errBody = await tokenRes.text();
              res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
              res.end("<h3>Failed to exchange token with Google. Check console.</h3>");
              server.close();
              reject(new Error(`Token exchange failed: ${errBody}`));
              return;
            }

            const tokenData = await tokenRes.json();
            tokenData.expires_at = Date.now() + (tokenData.expires_in || 3600) * 1000;
            saveToken(tokenData);

            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(`
              <!DOCTYPE html>
              <html>
              <head>
                <title>Connected to Furry!</title>
                <style>
                  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; text-align: center; padding: 50px; background: #121212; color: #fff; }
                  .card { background: #1e1e1e; padding: 40px; border-radius: 20px; display: inline-block; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
                  h1 { color: #4ade80; margin-bottom: 10px; }
                  p { color: #a1a1aa; font-size: 16px; }
                </style>
              </head>
              <body>
                <div class="card">
                  <h1>🐾 Google Classroom Connected!</h1>
                  <p>Furry can now automatically fetch your assignments and notify you of upcoming deadlines.</p>
                  <p>You can close this browser tab and return to your desktop pet.</p>
                </div>
              </body>
              </html>
            `);

            server.close();
            resolve({ ok: true, message: "Connected successfully" });
          }
        }
      } catch (err) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal error");
        server.close();
        reject(err);
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;

      const scopes = [
        "https://www.googleapis.com/auth/classroom.courses.readonly",
        "https://www.googleapis.com/auth/classroom.coursework.me.readonly",
        "https://www.googleapis.com/auth/classroom.student-submissions.me.readonly",
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/calendar.readonly",
        "https://www.googleapis.com/auth/calendar.events.readonly",
      ].join(" ");

      const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` + new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: scopes,
        access_type: "offline",
        prompt: "select_account consent",
      }).toString();

      console.log(`[GoogleClassroom] Auth loopback listening on port ${port}. Opening browser...`);
      appLauncher.openInBrave(authUrl, shellInstance);
      console.log(`\nIf your browser didn't open automatically, visit this URL:\n${authUrl}\n`);
    });

    // Timeout after 3 minutes if user leaves the tab open
    setTimeout(() => {
      try { server.close(); } catch (_) {}
    }, 180000);
  });
}

/**
 * Fetch all active courses and pending assignments with deadlines.
 */
async function fetchAssignments() {
  const accessToken = await getValidAccessToken();
  if (!accessToken) {
    return { ok: false, error: "NOT_CONNECTED", message: "Google Classroom is not connected." };
  }

  try {
    // 1. Fetch active courses
    const coursesRes = await fetch("https://classroom.googleapis.com/v1/courses?courseStates=ACTIVE&studentId=me", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!coursesRes.ok) {
      if (coursesRes.status === 401) {
        clearToken();
        return { ok: false, error: "AUTH_EXPIRED", message: "Google authorization expired. Please reconnect." };
      }
      return { ok: false, error: "API_ERROR", message: `Classroom API error: ${coursesRes.status}` };
    }

    const coursesData = await coursesRes.json();
    const courses = coursesData.courses || [];
    if (courses.length === 0) {
      const emptyResult = {
        ok: true,
        courses: [],
        assignments: [],
        pendingAssignments: [],
        submittedAssignments: [],
        allAssignments: [],
        totalCount: 0,
        pendingCount: 0,
        submittedCount: 0,
        upcomingCount: 0,
        coursesCount: 0,
        message: "No active courses found.",
      };
      saveCachedClassroom(emptyResult);
      return emptyResult;
    }

    const pendingAssignments = [];
    const submittedAssignments = [];
    const allAssignments = [];

    // 2. Fetch coursework for each course
    for (const course of courses) {
      try {
        const cwRes = await fetch(`https://classroom.googleapis.com/v1/courses/${course.id}/courseWork?courseWorkStates=PUBLISHED`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        if (!cwRes.ok) continue;

        const cwData = await cwRes.json();
        const courseWorkList = cwData.courseWork || [];

        for (const cw of courseWorkList) {
          let dueDateIso = null;
          let dueDateFormatted = "No due date";
          let dueTimestamp = Number.MAX_SAFE_INTEGER;
          let dueInHours = null;
          let isOverdue = false;

          if (cw.dueDate) {
            const year = cw.dueDate.year;
            const month = String(cw.dueDate.month).padStart(2, "0");
            const day = String(cw.dueDate.day).padStart(2, "0");
            const hours = cw.dueTime ? String(cw.dueTime.hours || 0).padStart(2, "0") : "23";
            const minutes = cw.dueTime ? String(cw.dueTime.minutes || 0).padStart(2, "0") : "59";

            const dueDateObj = new Date(`${year}-${month}-${day}T${hours}:${minutes}:00`);
            dueTimestamp = dueDateObj.getTime();
            dueDateIso = dueDateObj.toISOString();
            dueDateFormatted = dueDateObj.toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            });
            const diffMs = dueTimestamp - Date.now();
            dueInHours = Math.round(diffMs / (1000 * 60 * 60));
            isOverdue = diffMs < 0;
          }

          // Check student submission status
          let isSubmitted = false;
          let submissionState = "CREATED";
          try {
            const subRes = await fetch(
              `https://classroom.googleapis.com/v1/courses/${course.id}/courseWork/${cw.id}/studentSubmissions?userId=me`,
              { headers: { Authorization: `Bearer ${accessToken}` } }
            );
            if (subRes.ok) {
              const subData = await subRes.json();
              const submissions = subData.studentSubmissions || [];
              if (submissions.length > 0) {
                submissionState = submissions[0].state || "CREATED";
                if (submissions.some((s) => s.state === "TURNED_IN" || s.state === "RETURNED")) {
                  isSubmitted = true;
                }
              }
            }
          } catch (_) {}

          const item = {
            id: `gc-${course.id}-${cw.id}`,
            courseId: course.id,
            title: cw.title || "Untitled Assignment",
            courseName: course.name || "Course",
            courseSubject: course.subject || course.section || "",
            dueDate: dueDateIso,
            dueDateFormatted,
            dueTimestamp,
            dueInHours,
            isOverdue,
            hasDueDate: Boolean(cw.dueDate),
            isSubmitted,
            submissionState,
            link: cw.alternateLink || `https://classroom.google.com/c/${course.id}`,
            source: "Google Classroom",
          };

          allAssignments.push(item);
          if (isSubmitted) {
            submittedAssignments.push(item);
          } else {
            pendingAssignments.push(item);
          }
        }
      } catch (cwErr) {
        console.warn(`[GoogleClassroom] Failed to fetch coursework for course ${course.id}:`, cwErr);
      }
    }

    // Sort pending: nearest deadlines first, then items with no due date
    pendingAssignments.sort((a, b) => a.dueTimestamp - b.dueTimestamp);

    const courseList = courses.map((c) => ({
      id: c.id,
      name: c.name || "Untitled Course",
      section: c.section || "",
      subject: c.subject || "",
      alternateLink: c.alternateLink || `https://classroom.google.com/c/${c.id}`,
    }));

    const result = {
      ok: true,
      courses: courseList,
      assignments: pendingAssignments,
      pendingAssignments,
      submittedAssignments,
      allAssignments,
      totalCount: allAssignments.length,
      pendingCount: pendingAssignments.length,
      submittedCount: submittedAssignments.length,
      upcomingCount: pendingAssignments.filter((a) => !a.isOverdue && a.hasDueDate).length,
      coursesCount: courseList.length,
    };

    saveCachedClassroom(result);
    return result;
  } catch (err) {
    console.error("[GoogleClassroom] Fetch assignments error:", err);
    return { ok: false, error: "NETWORK_ERROR", message: err.message };
  }
}

function isConnected() {
  const token = loadSavedToken();
  return Boolean(token && (token.access_token || token.refresh_token));
}

function init(options = {}) {
  appInstance = options.app || null;
  shellInstance = options.shell || null;

  if (isConnected()) {
    // Refresh cache in the background
    fetchAssignments().catch(() => {});
  }

  if (options.ipcMain) {
    const ipc = options.ipcMain;

    ipc.handle("classroom-is-connected", () => isConnected());

    ipc.handle("classroom-connect", async () => {
      try {
        const result = await startAuthFlow();
        return result;
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    ipc.handle("classroom-disconnect", () => {
      clearToken();
      return { ok: true };
    });

    ipc.handle("classroom-fetch-assignments", async () => {
      return await fetchAssignments();
    });
  }
}

module.exports = {
  init,
  isConnected,
  startAuthFlow,
  fetchAssignments,
  clearToken,
  getCredentials,
  getTokenPath,
  getValidAccessToken,
  loadCachedClassroom,
  getClassroomSummaryText,
};
