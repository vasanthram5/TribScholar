require("dotenv").config();

const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const multer = require("multer");
const bcrypt = require("bcryptjs");
const { db, seed } = require("./src/db");
const { processDocument } = require("./src/processing");

const app = express();
const port = Number(process.env.PORT || 3000);
const uploadDir = path.resolve(process.env.UPLOAD_DIR || "./storage/uploads");
const maxUploadBytes = Math.max(1, Number(process.env.MAX_UPLOAD_MB || 5)) * 1024 * 1024;
const sessionSecret = process.env.SESSION_SECRET || "development-only-change-me";

if (process.env.NODE_ENV === "production" && sessionSecret === "development-only-change-me") {
  throw new Error("SESSION_SECRET must be set in production.");
}
fs.mkdirSync(uploadDir, { recursive: true });
seed(bcrypt);

app.disable("x-powered-by");
app.use(helmet({
  crossOriginResourcePolicy: { policy: "same-origin" },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "blob:"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"]
    }
  }
}));
app.use(express.json({ limit: "100kb" }));
app.use(session({
  name: "tribscholar.sid",
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 8
  }
}));

function issueCsrf(req) {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString("hex");
  return req.session.csrfToken;
}

function csrf(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const submitted = req.get("x-csrf-token");
  if (!req.session.csrfToken || !submitted || submitted !== req.session.csrfToken) {
    return res.status(403).json({ error: "Your session token expired. Refresh the page and try again." });
  }
  next();
}

app.use("/api", csrf);

function fail(res, status, error) {
  return res.status(status).json({ error });
}

function requireAuth(req, res, next) {
  if (!req.session.user) return fail(res, 401, "Please sign in to continue.");
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user) return fail(res, 401, "Please sign in to continue.");
  if (req.session.user.role !== "admin") return fail(res, 403, "Administrator access is required.");
  next();
}

function audit(userId, applicationId, action, details = {}) {
  db.prepare(`INSERT INTO audit_logs (user_id, application_id, action, details_json, created_at)
    VALUES (?, ?, ?, ?, ?)`).run(userId, applicationId || null, action, JSON.stringify(details), new Date().toISOString());
}

function getApplicationForUser(id, user) {
  const row = db.prepare("SELECT * FROM applications WHERE id = ?").get(id);
  if (!row || (user.role !== "admin" && row.user_id !== user.id)) return null;
  return row;
}

function validateApplicationInput(data) {
  const required = ["fullName", "state", "category", "course", "institution", "scheme", "contact"];
  if (required.some((field) => typeof data[field] !== "string" || !data[field].trim() || data[field].trim().length > 150)) return false;
  const income = Number(data.annualIncome);
  const schemes = ["Pre-Matric Scholarship", "Post-Matric Scholarship", "Top Class Scholarship", "National Fellowship for ST Students (NFST)", "National Overseas Scholarship (NOS)"];
  const contact = data.contact.trim();
  const validContact = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact) || /^\+?[0-9()\-\s]{7,20}$/.test(contact);
  return Number.isFinite(income) && income >= 0 && income <= 100000000 &&
    data.category.trim() === "Scheduled Tribe (ST)" && schemes.includes(data.scheme.trim()) && validContact;
}

function serializeApplication(row, includePrivate = true) {
  const docs = db.prepare(`SELECT id, document_type, original_name, mime_type, size_bytes, processing_status,
    extracted_json, missing_fields_json, created_at FROM documents WHERE application_id = ? ORDER BY created_at`).all(row.id);
  const notes = db.prepare(`SELECT n.id, n.note, n.created_at, u.name AS reviewer_name
    FROM reviewer_notes n JOIN users u ON u.id = n.reviewer_id WHERE n.application_id = ? ORDER BY n.created_at DESC`).all(row.id);
  return {
    id: row.id,
    applicationId: row.application_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    applicant: {
      fullName: row.full_name,
      state: row.state,
      category: row.category,
      course: row.course,
      institution: row.institution,
      scheme: row.scheme,
      annualIncome: row.annual_income,
      contact: includePrivate ? row.contact : undefined
    },
    documents: docs.map((doc) => ({
      ...doc,
      extracted: JSON.parse(doc.extracted_json || "{}"),
      missingFields: JSON.parse(doc.missing_fields_json || "[]"),
      extracted_json: undefined,
      missing_fields_json: undefined
    })),
    notes
  };
}

app.get("/api/auth/csrf", (req, res) => res.json({ csrfToken: issueCsrf(req) }));
app.get("/api/auth/me", (req, res) => res.json({ user: req.session.user || null, csrfToken: issueCsrf(req) }));

app.post("/api/auth/login", (req, res) => {
  const { email, password, role } = req.body || {};
  if (typeof email !== "string" || typeof password !== "string") return fail(res, 400, "Enter a valid email and password.");
  const user = db.prepare("SELECT id, name, email, role, password_hash FROM users WHERE lower(email) = lower(?)").get(email.trim());
  if (!user || !bcrypt.compareSync(password, user.password_hash) || (role && user.role !== role)) {
    return fail(res, 401, "Email or password is incorrect.");
  }
  req.session.regenerate((error) => {
    if (error) return fail(res, 500, "Unable to start a session. Please try again.");
    req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role };
    issueCsrf(req);
    audit(user.id, null, "login");
    res.json({ user: req.session.user, csrfToken: req.session.csrfToken });
  });
});

app.post("/api/auth/logout", requireAuth, (req, res) => {
  audit(req.session.user.id, null, "logout");
  req.session.destroy((error) => {
    if (error) return fail(res, 500, "Unable to sign out. Please try again.");
    res.clearCookie("tribscholar.sid", { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production" });
    res.json({ ok: true });
  });
});

app.post("/api/auth/register", (req, res) => {
  const input = req.body || {};
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  const password = typeof input.password === "string" ? input.password : "";
  if (name.length < 2 || name.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 10 || password.length > 200) {
    return fail(res, 400, "Provide a name, valid email, and password with at least 10 characters.");
  }
  try {
    const id = db.prepare(`INSERT INTO users (name, email, role, password_hash, created_at)
      VALUES (?, ?, 'student', ?, ?)`).run(name, email, bcrypt.hashSync(password, 12), new Date().toISOString()).lastInsertRowid;
    req.session.user = { id, name, email, role: "student" };
    req.session.regenerate((error) => {
      if (error) return fail(res, 500, "Unable to start a session.");
      req.session.user = { id, name, email, role: "student" };
      issueCsrf(req);
      res.status(201).json({ user: req.session.user, csrfToken: req.session.csrfToken });
    });
  } catch (error) {
    if (String(error.code).startsWith("SQLITE_CONSTRAINT")) return fail(res, 409, "That email is already registered.");
    throw error;
  }
});

app.get("/api/schemes", (req, res) => res.json({ schemes: [
  "Pre-Matric Scholarship", "Post-Matric Scholarship", "Top Class Scholarship",
  "National Fellowship for ST Students (NFST)", "National Overseas Scholarship (NOS)"
], demoConfiguration: true }));

app.get("/api/student/applications", requireAuth, (req, res) => {
  if (req.session.user.role !== "student") return fail(res, 403, "Student access is required.");
  const rows = db.prepare("SELECT * FROM applications WHERE user_id = ? ORDER BY created_at DESC").all(req.session.user.id);
  res.json({ applications: rows.map((row) => serializeApplication(row)) });
});

app.post("/api/student/applications", requireAuth, (req, res) => {
  if (req.session.user.role !== "student") return fail(res, 403, "Student access is required.");
  const data = req.body || {};
  const income = Number(data.annualIncome);
  if (!validateApplicationInput(data)) return fail(res, 400, "Complete all required fields with valid values, including a listed demo scheme and annual family income.");
  const now = new Date().toISOString();
  const row = db.prepare(`INSERT INTO applications
    (application_id, user_id, full_name, state, category, course, institution, scheme, annual_income, contact, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Submitted', ?, ?)`)
    .run(`TS-${new Date().getFullYear()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`,
      req.session.user.id, data.fullName.trim(), data.state.trim(), data.category.trim(), data.course.trim(),
      data.institution.trim(), data.scheme.trim(), income, data.contact.trim(), now, now);
  audit(req.session.user.id, row.lastInsertRowid, "application_created", { status: "Submitted" });
  res.status(201).json({ application: serializeApplication(db.prepare("SELECT * FROM applications WHERE id = ?").get(row.lastInsertRowid)) });
});

app.patch("/api/student/applications/:id", requireAuth, (req, res) => {
  if (req.session.user.role !== "student") return fail(res, 403, "Student access is required.");
  const row = getApplicationForUser(Number(req.params.id), req.session.user);
  if (!row) return fail(res, 404, "Application not found.");
  if (row.status !== "Needs Correction") return fail(res, 409, "Applications can only be edited when marked Needs Correction.");
  const data = req.body || {};
  if (!validateApplicationInput(data)) return fail(res, 400, "Complete all required fields with valid values, including a listed demo scheme and annual family income.");
  db.prepare(`UPDATE applications SET full_name=?,state=?,category=?,course=?,institution=?,scheme=?,annual_income=?,contact=?,updated_at=? WHERE id=?`)
    .run(data.fullName.trim(), data.state.trim(), data.category.trim(), data.course.trim(), data.institution.trim(), data.scheme.trim(),
      Number(data.annualIncome), data.contact.trim(), new Date().toISOString(), row.id);
  db.prepare("UPDATE applications SET status='Submitted' WHERE id=?").run(row.id);
  audit(req.session.user.id, row.id, "application_updated");
  audit(req.session.user.id, row.id, "status_changed", { from: "Needs Correction", to: "Submitted" });
  res.json({ application: serializeApplication(db.prepare("SELECT * FROM applications WHERE id=?").get(row.id)) });
});

function magicMime(buffer) {
  if (buffer.subarray(0, 5).toString() === "%PDF-") return "application/pdf";
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  return null;
}

const uploader = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (_req, _file, callback) => callback(null, `${crypto.randomUUID()}.upload`)
  }),
  limits: { fileSize: maxUploadBytes, files: 1 },
  fileFilter: (_req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    const known = { ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };
    if (!known[extension]) return callback(new Error("Unsupported file type. Choose a PDF, JPG, JPEG, or PNG."));
    callback(null, true);
  }
});

app.post("/api/student/applications/:id/documents", requireAuth, uploader.single("document"), async (req, res, next) => {
  try {
    if (req.session.user.role !== "student") {
      if (req.file) fs.unlinkSync(req.file.path);
      return fail(res, 403, "Student access is required.");
    }
    const application = getApplicationForUser(Number(req.params.id), req.session.user);
    if (!application) {
      if (req.file) fs.unlinkSync(req.file.path);
      return fail(res, 404, "Application not found.");
    }
    if (!req.file) return fail(res, 400, "Choose a file to upload.");
    if (!["Submitted", "Needs Correction"].includes(application.status)) {
      fs.unlinkSync(req.file.path);
      return fail(res, 409, "Documents can only be uploaded while an application is Submitted or Needs Correction.");
    }
    const buffer = fs.readFileSync(req.file.path);
    const actualMime = magicMime(buffer);
    const extension = path.extname(req.file.originalname).toLowerCase();
    const extensionMime = { ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" }[extension];
    if (!actualMime || actualMime !== req.file.mimetype || actualMime !== extensionMime) {
      fs.unlinkSync(req.file.path);
      return fail(res, 400, "The file contents do not match a supported PDF, JPG, or PNG type.");
    }
    const allowedTypes = ["identity", "st_certificate", "income_certificate", "marksheet"];
    const documentType = req.body.documentType;
    if (!allowedTypes.includes(documentType)) {
      fs.unlinkSync(req.file.path);
      return fail(res, 400, "Choose a valid document category.");
    }
    const parsed = await processDocument(req.file.path, actualMime);
    const now = new Date().toISOString();
    const created = db.prepare(`INSERT INTO documents
      (application_id, document_type, original_name, stored_name, mime_type, size_bytes, processing_status,
       ocr_text, extracted_json, missing_fields_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(application.id, documentType, path.basename(req.file.originalname).slice(0, 160), path.basename(req.file.path),
        actualMime, req.file.size, parsed.status, parsed.text.slice(0, 20000),
        JSON.stringify(parsed.extracted), JSON.stringify(parsed.missingFields), now);
    const nextStatus = application.status === "Needs Correction" ? "Submitted" : application.status;
    db.prepare("UPDATE applications SET updated_at=?,status=? WHERE id=?").run(now, nextStatus, application.id);
    audit(req.session.user.id, application.id, "document_uploaded", { documentType, processing: parsed.status });
    if (nextStatus !== application.status) audit(req.session.user.id, application.id, "status_changed", { from: application.status, to: nextStatus });
    const document = db.prepare(`SELECT id, document_type, original_name, mime_type, size_bytes, processing_status,
      extracted_json, missing_fields_json, created_at FROM documents WHERE id=?`).get(created.lastInsertRowid);
    res.status(201).json({ document: {
      ...document, extracted: JSON.parse(document.extracted_json), missingFields: JSON.parse(document.missing_fields_json),
      extracted_json: undefined, missing_fields_json: undefined
    } });
  } catch (error) {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    next(error);
  }
});

app.get("/api/applications/:id", requireAuth, (req, res) => {
  const row = getApplicationForUser(Number(req.params.id), req.session.user);
  if (!row) return fail(res, 404, "Application not found.");
  res.json({ application: serializeApplication(row) });
});

app.get("/api/applications/:id/documents", requireAuth, (req, res) => {
  const row = getApplicationForUser(Number(req.params.id), req.session.user);
  if (!row) return fail(res, 404, "Application not found.");
  res.json({ documents: serializeApplication(row).documents });
});

app.get("/api/documents/:id/file", requireAuth, (req, res) => {
  const doc = db.prepare(`SELECT d.*, a.user_id FROM documents d JOIN applications a ON a.id=d.application_id WHERE d.id=?`).get(Number(req.params.id));
  if (!doc || (req.session.user.role !== "admin" && doc.user_id !== req.session.user.id)) return fail(res, 404, "Document not found.");
  const filePath = path.join(uploadDir, path.basename(doc.stored_name));
  if (!fs.existsSync(filePath)) return fail(res, 404, "The uploaded file is no longer available.");
  res.setHeader("Content-Type", doc.mime_type);
  res.setHeader("Content-Disposition", `${req.query.download === "1" ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(doc.original_name)}`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  fs.createReadStream(filePath).pipe(res);
});

app.post("/api/admin/applications/:id/reprocess", requireAdmin, async (req, res, next) => {
  try {
    const doc = db.prepare("SELECT * FROM documents WHERE id=? AND application_id=?").get(Number(req.body.documentId), Number(req.params.id));
    if (!doc) return fail(res, 404, "Document not found.");
    const filePath = path.join(uploadDir, path.basename(doc.stored_name));
    if (!fs.existsSync(filePath)) return fail(res, 404, "The uploaded file is no longer available.");
    const output = await processDocument(filePath, doc.mime_type);
    db.prepare("UPDATE documents SET processing_status=?,ocr_text=?,extracted_json=?,missing_fields_json=? WHERE id=?")
      .run(output.status, output.text.slice(0, 20000), JSON.stringify(output.extracted), JSON.stringify(output.missingFields), doc.id);
    audit(req.session.user.id, doc.application_id, "document_reprocessed", { documentId: doc.id, processing: output.status });
    res.json({ ok: true, processingStatus: output.status });
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/dashboard", requireAdmin, (_req, res) => {
  const counts = db.prepare(`SELECT COUNT(*) AS total,
    SUM(CASE WHEN status IN ('Submitted','Processing','Under Review') THEN 1 ELSE 0 END) AS pending,
    SUM(CASE WHEN status IN ('Needs Correction') THEN 1 ELSE 0 END) AS attention,
    SUM(CASE WHEN status IN ('Reviewed','Approved','Rejected') THEN 1 ELSE 0 END) AS reviewed
    FROM applications`).get();
  res.json({ metrics: { total: counts.total, pending: counts.pending || 0, attention: counts.attention || 0, reviewed: counts.reviewed || 0 } });
});

app.get("/api/admin/applications", requireAdmin, (req, res) => {
  const { search = "", status = "", scheme = "", state = "", sort = "newest" } = req.query;
  if ([search, status, scheme, state].some((item) => typeof item !== "string" || item.length > 100)) return fail(res, 400, "Invalid search or filter.");
  const validStatuses = ["Submitted", "Processing", "Needs Correction", "Under Review", "Reviewed", "Approved", "Rejected"];
  if (status && !validStatuses.includes(status)) return fail(res, 400, "Invalid application status filter.");
  const orderOptions = {
    newest: "created_at DESC",
    oldest: "created_at ASC",
    applicationId: "application_id ASC",
    status: "status ASC",
    scheme: "scheme ASC",
    state: "state ASC"
  };
  if (typeof sort !== "string" || !orderOptions[sort]) return fail(res, 400, "Invalid application sort.");
  const orderBy = orderOptions[sort];
  const rows = db.prepare(`SELECT * FROM applications WHERE
    (?='' OR full_name LIKE '%'||?||'%' OR application_id LIKE '%'||?||'%') AND
    (?='' OR status=?) AND (?='' OR scheme=?) AND (?='' OR state=?)
    ORDER BY ${orderBy}`).all(search, search, search, status, status, scheme, scheme, state, state);
  res.json({ applications: rows.map((row) => serializeApplication(row, false)) });
});

app.get("/api/admin/applications/:id", requireAdmin, (req, res) => {
  const row = db.prepare("SELECT * FROM applications WHERE id=?").get(Number(req.params.id));
  if (!row) return fail(res, 404, "Application not found.");
  res.json({ application: serializeApplication(row) });
});

app.post("/api/admin/applications/:id/notes", requireAdmin, (req, res) => {
  const row = db.prepare("SELECT id FROM applications WHERE id=?").get(Number(req.params.id));
  const note = typeof req.body?.note === "string" ? req.body.note.trim() : "";
  if (!row) return fail(res, 404, "Application not found.");
  if (!note || note.length > 2000) return fail(res, 400, "Enter a note of 1–2000 characters.");
  const now = new Date().toISOString();
  db.prepare("INSERT INTO reviewer_notes (application_id, reviewer_id, note, created_at) VALUES (?, ?, ?, ?)")
    .run(row.id, req.session.user.id, note, now);
  audit(req.session.user.id, row.id, "reviewer_note_added");
  res.status(201).json({ ok: true });
});

app.patch("/api/admin/applications/:id/status", requireAdmin, (req, res) => {
  const row = db.prepare("SELECT * FROM applications WHERE id=?").get(Number(req.params.id));
  const status = req.body?.status;
  const statuses = ["Submitted", "Processing", "Needs Correction", "Under Review", "Reviewed", "Approved", "Rejected"];
  const transitions = {
    Submitted: ["Processing", "Needs Correction", "Under Review"],
    Processing: ["Needs Correction", "Under Review"],
    "Needs Correction": ["Submitted", "Processing"],
    "Under Review": ["Needs Correction", "Reviewed", "Approved", "Rejected"],
    Reviewed: ["Needs Correction", "Approved", "Rejected", "Under Review"],
    Approved: ["Under Review"],
    Rejected: ["Under Review"]
  };
  if (!row) return fail(res, 404, "Application not found.");
  if (!statuses.includes(status) || !transitions[row.status].includes(status)) return fail(res, 409, "That status transition is not allowed.");
  if (["Approved", "Rejected"].includes(status) && req.body?.confirmed !== true) return fail(res, 400, "Confirm this demo-only decision before continuing.");
  db.prepare("UPDATE applications SET status=?,updated_at=? WHERE id=?").run(status, new Date().toISOString(), row.id);
  audit(req.session.user.id, row.id, "status_changed", { from: row.status, to: status, demoDecision: ["Approved", "Rejected"].includes(status) });
  res.json({ application: serializeApplication(db.prepare("SELECT * FROM applications WHERE id=?").get(row.id)) });
});

app.get("/api/admin/applications/:id/audit", requireAdmin, (req, res) => {
  const exists = db.prepare("SELECT id FROM applications WHERE id=?").get(Number(req.params.id));
  if (!exists) return fail(res, 404, "Application not found.");
  const events = db.prepare(`SELECT l.id,l.action,l.details_json,l.created_at,u.name AS actor
    FROM audit_logs l LEFT JOIN users u ON u.id=l.user_id WHERE l.application_id=? ORDER BY l.created_at DESC`).all(exists.id);
  res.json({ events: events.map((event) => ({ ...event, details: JSON.parse(event.details_json || "{}"), details_json: undefined })) });
});

app.get("/api/admin/audit", requireAdmin, (_req, res) => {
  const events = db.prepare(`SELECT l.id,l.action,l.details_json,l.created_at,u.name AS actor,a.application_id
    FROM audit_logs l LEFT JOIN users u ON u.id=l.user_id LEFT JOIN applications a ON a.id=l.application_id
    ORDER BY l.created_at DESC LIMIT 100`).all();
  res.json({ events: events.map((event) => ({ ...event, details: JSON.parse(event.details_json || "{}"), details_json: undefined })) });
});

app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use((error, req, res, _next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") return fail(res, 413, `File exceeds the ${Math.floor(maxUploadBytes / 1024 / 1024)} MB limit.`);
    return fail(res, 400, "The file could not be uploaded.");
  }
  if (error.message?.startsWith("Unsupported file type")) return fail(res, 400, error.message);
  console.error("Request failed:", error.message);
  res.status(500).json({ error: "Something went wrong. Please try again." });
});

const server = app.listen(port, () => {
  console.log(`Tribal Scholarship AI prototype is running at http://localhost:${port}`);
  console.log(`OCR provider: ${process.env.OCR_PROVIDER || "demo"}`);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

module.exports = { app, server };
