const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

class ApiClient {
  constructor(baseUrl) { this.baseUrl = baseUrl; this.cookie = ""; this.csrf = ""; }

  async request(url, options = {}) {
    const headers = new Headers(options.headers || {});
    if (this.cookie) headers.set("Cookie", this.cookie);
    if (options.method && options.method !== "GET" && this.csrf) headers.set("X-CSRF-Token", this.csrf);
    const response = await fetch(`${this.baseUrl}${url}`, { ...options, headers });
    const cookie = response.headers.getSetCookie?.()[0];
    if (cookie) this.cookie = cookie.split(";")[0];
    const data = await response.json().catch(() => ({}));
    if (data.csrfToken) this.csrf = data.csrfToken;
    return { response, data };
  }

  async openSession() { await this.request("/api/auth/me"); }
  async login(email, password, role) {
    return this.request("/api/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, role })
    });
  }
}

test("complete demo API workflows enforce roles, ownership, validation, and audit", { timeout: 45000 }, async (t) => {
  const port = await availablePort();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tribscholar-test-"));
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      SESSION_SECRET: "test-secret-that-is-long-enough-for-session-signing",
      DATABASE_PATH: path.join(temp, "db.sqlite"),
      UPLOAD_DIR: path.join(temp, "uploads"),
      OCR_PROVIDER: "demo"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await new Promise((resolve) => child.once("close", resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  });

  const unauthenticated = new ApiClient(baseUrl);
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const { response } = await unauthenticated.request("/api/auth/me");
      if (response.ok) { ready = true; break; }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(ready, true, `server did not start: ${output}`);
  let protectedResult = await unauthenticated.request("/api/student/applications");
  assert.equal(protectedResult.response.status, 401);

  const student = new ApiClient(baseUrl);
  await student.openSession();
  let result = await student.login("student@demo.local", "StudentDemo!2026", "student");
  assert.equal(result.response.status, 200);
  assert.equal(result.data.user.role, "student");
  result = await student.request("/api/student/applications");
  assert.equal(result.response.status, 200);
  assert.ok(result.data.applications.some((item) => item.applicationId === "DEMO-2026-001"));
  const incompleteFixture = result.data.applications.find((item) => item.applicationId === "DEMO-2026-002");
  assert.equal(incompleteFixture.applicant.annualIncome, null);

  result = await student.request("/api/admin/dashboard");
  assert.equal(result.response.status, 403);
  result = await student.request("/api/student/applications", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fullName: "Incomplete" })
  });
  assert.equal(result.response.status, 400);
  result = await student.request("/api/student/applications", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fullName: "Fictional Test Applicant", state: "Jharkhand", category: "Scheduled Tribe (ST)",
      course: "B.Sc. Test", institution: "Demo College", scheme: "Post-Matric Scholarship",
      annualIncome: 120000, contact: "test@example.test"
    })
  });
  assert.equal(result.response.status, 201);
  const createdId = result.data.application.id;

  const otherStudent = new ApiClient(baseUrl);
  await otherStudent.openSession();
  result = await otherStudent.request("/api/auth/register", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Other Fictional User", email: "other@example.test", password: "OtherStudent!2026" })
  });
  assert.equal(result.response.status, 201);
  result = await otherStudent.request(`/api/applications/${createdId}`);
  assert.equal(result.response.status, 404);

  const tinyPng = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const upload = new FormData();
  upload.append("documentType", "identity");
  upload.append("document", new Blob([tinyPng], { type: "image/png" }), "fictional.png");
  result = await student.request(`/api/student/applications/${createdId}/documents`, { method: "POST", body: upload });
  assert.equal(result.response.status, 201);
  assert.equal(result.data.document.processing_status, "demo_mode");

  const badContent = new FormData();
  badContent.append("documentType", "identity");
  badContent.append("document", new Blob(["not an image"], { type: "image/png" }), "not-image.png");
  result = await student.request(`/api/student/applications/${createdId}/documents`, { method: "POST", body: badContent });
  assert.equal(result.response.status, 400);

  const oversized = new FormData();
  oversized.append("documentType", "identity");
  oversized.append("document", new Blob([Buffer.alloc(5 * 1024 * 1024 + 1)], { type: "image/png" }), "large.png");
  result = await student.request(`/api/student/applications/${createdId}/documents`, { method: "POST", body: oversized });
  assert.equal(result.response.status, 413);

  const admin = new ApiClient(baseUrl);
  await admin.openSession();
  result = await admin.login("admin@demo.local", "AdminDemo!2026", "admin");
  assert.equal(result.response.status, 200);
  result = await admin.request(`/api/admin/applications/${createdId}/notes`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ note: "Please confirm the original document during review." })
  });
  assert.equal(result.response.status, 201);
  result = await admin.request("/api/admin/applications?sort=invalid");
  assert.equal(result.response.status, 400);
  result = await admin.request("/api/admin/applications?sort=applicationId");
  assert.equal(result.response.status, 200);
  assert.ok(result.data.applications.length >= 3);
  result = await admin.request(`/api/admin/applications/${createdId}/status`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "Under Review" })
  });
  assert.equal(result.response.status, 200);
  result = await admin.request(`/api/admin/applications/${createdId}/audit`);
  assert.equal(result.response.status, 200);
  assert.ok(result.data.events.some((event) => event.action === "status_changed"));
  assert.ok(result.data.events.some((event) => event.action === "reviewer_note_added"));

  result = await admin.request(`/api/admin/applications/${createdId}/status`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "Needs Correction" })
  });
  assert.equal(result.response.status, 200);
  result = await student.request(`/api/student/applications/${createdId}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fullName: "Fictional Test Applicant Updated", state: "Jharkhand", category: "Scheduled Tribe (ST)",
      course: "B.Sc. Test", institution: "Demo College", scheme: "Post-Matric Scholarship",
      annualIncome: 120000, contact: "test@example.test"
    })
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.application.status, "Submitted");
});
