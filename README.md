# Tribal Scholarship AI

A runnable, fictional SIH26239 prototype for scholarship application intake and human-led document review. It demonstrates student submission, private document upload, optional local OCR/text extraction, missing-document warnings, reviewer notes, status transitions, and audit events.

> **Prototype notice:** This is not an official government portal. Seeded applicant data is fictional. Scheme names are demo configuration only; the app does not implement official eligibility rules, verify certificate authenticity, award scholarships, or disburse funds.

## Features

- Student and administrator sessions with role checks, password hashing, CSRF tokens, and demo credentials.
- Student registration, application creation, application correction/resubmission, and status tracking.
- Uploads limited to PDF, JPG/JPEG, and PNG, 5 MB by default; extension, declared type, and file signature are checked.
- Uploads stored outside the static web directory and streamed only after application ownership or administrator authorization checks.
- Optional English Tesseract.js OCR for uploaded images; PDFs use local text extraction. Deterministic field extraction leaves absent values empty and records the matched source text/confidence.
- Clearly labeled demo-mode response when OCR is disabled. OCR is never treated as certificate validation or an eligibility decision.
- Admin search/filter, dashboard metrics, secure preview, reviewer notes, constrained status transitions, reprocessing endpoint, and audit trail.
- SQLite schema initialized at startup and idempotent fictional seed accounts/application data.
- Responsive vanilla HTML/CSS/JavaScript interface. No frontend framework or inline event handlers.

## Architecture

- `server.js` — Express app, sessions, CSRF, validation, role/ownership checks, REST API, secure file routes, audit events.
- `src/db.js` — SQLite schema, indexes, and idempotent fictional demo seed data.
- `src/processing.js` — modular document processor and deterministic extraction. It selects demo behavior or local image OCR from environment configuration.
- `public/` — accessible single-page vanilla JavaScript interface and responsive styles.
- `test/` — unit tests for extraction and API integration tests for important access-control and workflow behavior.
- `storage/uploads/` — private local upload directory; not served as static content.

## Prerequisites

- Node.js 20 or newer (tested with Node 22)
- npm

The OCR worker downloads language data on its first OCR use, so an internet connection may be needed initially when selecting Tesseract mode. Demo mode and PDF text extraction do not need a third-party AI API.

## Installation

From the project root:

```powershell
npm install
Copy-Item .env.example .env
```

Update `.env` before deployment. At minimum, replace `SESSION_SECRET` with a long random secret and set `NODE_ENV=production` behind HTTPS. The default database and private upload paths are created automatically.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP listen port |
| `NODE_ENV` | `development` | Set to `production` to require a session secret and mark cookies secure |
| `SESSION_SECRET` | development fallback | Session signing secret; **must be changed for production** |
| `DATABASE_PATH` | `./data/scholarship.sqlite` | SQLite database path |
| `UPLOAD_DIR` | `./storage/uploads` | Private upload location |
| `MAX_UPLOAD_MB` | `5` | Maximum upload size in MB |
| `OCR_PROVIDER` | `demo` | `demo` or `tesseract`; Tesseract mode runs on image uploads. PDF text extraction is local. |

Copy `.env.example` as a starting point. `.env`, SQLite data, uploads, and `node_modules` are excluded by `.gitignore`.

## Database and seeding

The schema and indexes are initialized by `src/db.js` whenever the server starts. `INSERT OR IGNORE` and a stable demo application ID keep seeding idempotent. To reset local demo data, stop the server and remove the configured SQLite database file; this also removes locally stored application records. Uploaded files live separately in `UPLOAD_DIR`.

Two fictional applications are seeded for the student:

- `DEMO-2026-001` — Asha Kumari, Jharkhand, B.Sc. Computer Science, Demo Government College, Post-Matric Scholarship, annual family income ₹120,000. A fictional identity, ST certificate, and income certificate are listed as fixture records; the academic marksheet is missing. Fixture records are not actual files.
- `DEMO-2026-002` — fictional incomplete application with income set to zero and all required document categories missing.

## Run

```powershell
npm start
```

Development with Node's built-in watcher:

```powershell
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) (or the configured port).

### Demo credentials

| Role | Email | Password |
| --- | --- | --- |
| Student | `student@demo.local` | `StudentDemo!2026` |
| Administrator | `admin@demo.local` | `AdminDemo!2026` |

These credentials are for local demonstration only. Do not reuse them in a public deployment. New applicants can register through the sign-in page.

## API overview

JSON responses use `{ ... }` on success and `{ "error": "..." }` on expected failures. State-changing requests must send the session's `X-CSRF-Token`, returned by `/api/auth/me` or the login/register response. Browser clients automatically preserve the session cookie.

| Method | Endpoint | Access |
| --- | --- | --- |
| `GET` | `/api/auth/csrf`, `/api/auth/me` | Public/session |
| `POST` | `/api/auth/login`, `/api/auth/logout`, `/api/auth/register` | Public/session |
| `GET` | `/api/schemes` | Public demo configuration |
| `GET`, `POST` | `/api/student/applications` | Student |
| `PATCH` | `/api/student/applications/:id` | Owning student; Needs Correction only |
| `POST` | `/api/student/applications/:id/documents` | Owning student |
| `GET` | `/api/applications/:id`, `/api/applications/:id/documents` | Owner or admin |
| `GET` | `/api/documents/:id/file` | Owner or admin |
| `GET` | `/api/admin/dashboard`, `/api/admin/applications` | Admin |
| `GET` | `/api/admin/applications/:id` | Admin |
| `POST` | `/api/admin/applications/:id/notes` | Admin |
| `PATCH` | `/api/admin/applications/:id/status` | Admin |
| `POST` | `/api/admin/applications/:id/reprocess` | Admin |
| `GET` | `/api/admin/applications/:id/audit`, `/api/admin/audit` | Admin |

## OCR and extraction

The demo default (`OCR_PROVIDER=demo`) does not call a cloud AI service. Image uploads receive an explicit `demo_mode` processing result and blank fields; the app does not fabricate extracted values. For PDFs, the local `pdf-parse` text extractor reads embedded text even in demo mode. With `OCR_PROVIDER=tesseract`, uploaded images are passed to Tesseract.js using its English model; PDFs still use text extraction and scanned PDFs are not OCRed.

`src/processing.js` keeps OCR and deterministic extraction separate. It currently recognizes a small set of labeled values (name, certificate number, issue date, annual income, institution); extracted values retain source text and are marked for human review. Empty, absent, low-confidence, and failed processing results remain warnings. A production LLM provider is **not implemented**; no real external AI integration is claimed. Add a vetted provider behind the processing service only after configuring secrets, validating a strict response schema, and reviewing privacy/security obligations.

## Manual testing checklist

Automated tests cover server startup, demo student/admin login, student application creation, upload acceptance/rejection/size limit, role and ownership denial, reviewer notes, status-change audit events, and extraction behavior. For a presentation, also verify:

1. Student opens `DEMO-2026-001`, sees missing academic marksheet, and uploads a fictional sample image/PDF.
2. The processing state is labeled demo mode or displays extracted text when configured for a tested provider; absent values stay blank.
3. Admin opens the application, securely previews an uploaded file, adds a note, and changes status to Needs Correction or Under Review.
4. Student sees the update, edits application fields or uploads a replacement, and resubmits.
5. Admin confirms the audit trail reflects the review actions.
6. Attempt invalid extension/content and a file larger than the configured limit; each should be rejected with a clear error.

Run automated checks with:

```powershell
npm test
```

## Security limitations

- This is a hackathon prototype. Express's in-memory session store is used: sessions are lost on restart and the store is not appropriate for production or multiple server instances. Replace it with a durable production session store.
- Local uploaded files and the SQLite database need operational backups, access controls, malware scanning, retention/deletion policies, and encrypted storage for real personal information.
- The demo lacks production account recovery, rate limiting, email verification, deployment hardening, and formal privacy/compliance review.
- HTTPS is required for secure cookies in production. Set a strong `SESSION_SECRET`, run behind a trusted TLS proxy, and review proxy/trust configuration before deployment.
- OCR output and document appearance cannot establish genuineness, eligibility, or entitlement. All consequential review remains human-led.
- Seeded fictional data is only for local demos. Do not upload actual Aadhaar numbers, certificates, or other sensitive data to this prototype.

## Known limitations and future improvements

- No official government integrations, DigiLocker/Aadhaar, eligibility rules, scholarship disbursement, multilingual chatbot, or real LLM provider.
- OCR is English-only; scanned PDF OCR and advanced regional-language support are not implemented.
- Document category replacement currently adds a new record; it does not erase prior versions.
- Suggested next steps: durable session storage, deployment security review, encrypted object storage, document lifecycle/version management, configurable scheme policies backed by authoritative sources, consent and retention workflows, localization/accessibility review with users, and more provider-specific integration tests.
