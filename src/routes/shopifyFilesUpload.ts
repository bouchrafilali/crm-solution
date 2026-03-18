import { Router, type Request as ExpressRequest, type Response } from "express";
import { Readable } from "node:stream";
import { uploadFileToShopify } from "../services/shopifyFiles.js";

export const shopifyFilesUploadRouter = Router();

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const ALLOWED_METHODS = "POST, OPTIONS";
const ALLOWED_HEADERS = "Content-Type, Authorization";

function applyCors(res: Response): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", ALLOWED_METHODS);
  res.setHeader("Access-Control-Allow-Headers", ALLOWED_HEADERS);
}

function getContentLength(req: ExpressRequest): number | null {
  const raw = req.headers["content-length"];
  const parsed = typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function getBaseUrl(req: ExpressRequest): string {
  const protocol = req.headers["x-forwarded-proto"] === "https" ? "https" : req.protocol || "http";
  const host = req.headers.host || "localhost";
  return `${protocol}://${host}`;
}

async function parseMultipartForm(req: ExpressRequest): Promise<FormData> {
  const request = new Request(`${getBaseUrl(req)}${req.originalUrl}`, {
    method: req.method,
    headers: req.headers as HeadersInit,
    body: Readable.toWeb(req) as BodyInit,
    duplex: "half"
  });

  return request.formData();
}

function sanitizeTextField(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function inferHttpStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : "Unknown error";

  if (/missing shopify_/i.test(message) || /invalid shopify_shop/i.test(message)) return 500;
  if (/filename is required|multipart|formdata|boundary|uploaded file/i.test(message)) return 400;

  return 502;
}

shopifyFilesUploadRouter.options("/api/shopify/files/upload", (_req, res) => {
  applyCors(res);
  res.status(204).send();
});

shopifyFilesUploadRouter.post("/api/shopify/files/upload", async (req, res) => {
  applyCors(res);

  const contentLength = getContentLength(req);
  if (contentLength !== null && contentLength > MAX_UPLOAD_BYTES) {
    console.error("[shopify-files-route] upload_rejected_too_large", {
      contentLength,
      maxBytes: MAX_UPLOAD_BYTES
    });
    res.status(413).json({ error: `File too large. Max ${MAX_UPLOAD_BYTES} bytes.` });
    return;
  }

  const contentType = String(req.headers["content-type"] || "");
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    res.status(400).json({ error: "Content-Type must be multipart/form-data." });
    return;
  }

  try {
    console.log("[shopify-files-route] upload_request_started", {
      path: req.originalUrl,
      contentLength,
      contentType
    });

    const form = await parseMultipartForm(req);
    const provider = sanitizeTextField(form.get("provider"));
    const source = sanitizeTextField(form.get("source"));
    const fileField = form.get("file");

    console.log("[shopify-files-route] upload_request_fields", {
      provider,
      source,
      hasFile: Boolean(fileField)
    });

    if (!(fileField instanceof File)) {
      res.status(400).json({ error: 'Missing multipart field "file".' });
      return;
    }

    if (!fileField.name.trim()) {
      res.status(400).json({ error: "Uploaded file must include a filename." });
      return;
    }

    if (fileField.size > MAX_UPLOAD_BYTES) {
      console.error("[shopify-files-route] upload_rejected_file_too_large", {
        filename: fileField.name,
        fileSize: fileField.size,
        maxBytes: MAX_UPLOAD_BYTES
      });
      res.status(413).json({ error: `File too large. Max ${MAX_UPLOAD_BYTES} bytes.` });
      return;
    }

    const buffer = Buffer.from(await fileField.arrayBuffer());

    const url = await uploadFileToShopify({
      filename: fileField.name,
      buffer,
      mimeType: fileField.type || undefined,
      provider: provider ?? undefined,
      source: source ?? undefined
    });

    console.log("[shopify-files-route] upload_request_success", {
      filename: fileField.name,
      mimeType: fileField.type || null,
      size: fileField.size,
      url
    });

    res.status(200).json({ url });
  } catch (error) {
    const status = inferHttpStatus(error);
    const message = error instanceof Error ? error.message : "Unexpected upload error.";

    console.error("[shopify-files-route] upload_request_failed", {
      status,
      error: message
    });

    res.status(status).json({ error: message });
  }
});
