const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { extractKnownFields, processDocument } = require("../src/processing");

test("known-field extraction preserves absent values and source text", () => {
  const fields = extractKnownFields("Name: Asha Kumari\nAnnual income: Rs. 120,000");
  assert.equal(fields.name.value, "Asha Kumari");
  assert.equal(fields.name.source, "Name: Asha Kumari");
  assert.equal(fields.annualIncome.value, "120000");
  assert.equal(fields.certificateNumber.value, null);
  assert.equal(fields.certificateNumber.verification, "not_found");
});

test("corrupt PDF processing is surfaced as a failed result, not guessed data", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tribscholar-pdf-test-"));
  const filePath = path.join(directory, "corrupt.pdf");
  const priorProvider = process.env.OCR_PROVIDER;
  process.env.OCR_PROVIDER = "demo";
  try {
    fs.writeFileSync(filePath, "%PDF-1.4\nthis is not a valid PDF");
    const result = await processDocument(filePath, "application/pdf");
    assert.equal(result.status, "processing_failed");
    assert.equal(result.extracted.name.value, null);
    assert.equal(result.missingFields.length, 5);
  } finally {
    if (priorProvider === undefined) delete process.env.OCR_PROVIDER;
    else process.env.OCR_PROVIDER = priorProvider;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("demo OCR mode clearly reports unavailable extraction without guessing", async () => {
  const priorProvider = process.env.OCR_PROVIDER;
  process.env.OCR_PROVIDER = "demo";
  try {
    const result = await processDocument("unused-in-demo-mode", "image/png");
    assert.equal(result.status, "demo_mode");
    assert.equal(result.extracted.name.value, null);
    assert.equal(result.missingFields.length, 5);
  } finally {
    if (priorProvider === undefined) delete process.env.OCR_PROVIDER;
    else process.env.OCR_PROVIDER = priorProvider;
  }
});
