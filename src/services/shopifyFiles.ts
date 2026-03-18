import { env } from "../config/env.js";

type ShopifyUserError = {
  field?: string[] | null;
  message: string;
};

type StagedUploadTarget = {
  url: string;
  resourceUrl: string;
  parameters: Array<{ name: string; value: string }>;
};

type UploadShopifyFileInput = {
  filename: string;
  buffer: Buffer;
  mimeType?: string;
  shop?: string;
  source?: string;
  provider?: string;
};

const DEFAULT_MIME_TYPE = "application/octet-stream";
const FILE_READY_POLL_ATTEMPTS = 12;
const FILE_READY_POLL_DELAY_MS = 1200;

function isShopDomain(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(value);
}

function resolveShop(): string {
  const shop = String(env.SHOPIFY_SHOP || "").trim().toLowerCase();
  if (!shop || !isShopDomain(shop)) {
    throw new Error("Missing or invalid SHOPIFY_SHOP.");
  }
  return shop;
}

function resolveAdminToken(): string {
  const token = String(env.SHOPIFY_ADMIN_TOKEN || env.SHOPIFY_ADMIN_ACCESS_TOKEN || "").trim();
  if (!token) {
    throw new Error("Missing SHOPIFY_ADMIN_TOKEN.");
  }
  return token;
}

function resolveApiVersion(): string {
  const version = String(env.SHOPIFY_API_VERSION || "2025-01").trim();
  return version || "2025-01";
}

function formatUserErrors(userErrors: ShopifyUserError[]): string {
  return userErrors
    .map((error) => {
      const field = Array.isArray(error.field) && error.field.length > 0 ? `${error.field.join(".")}: ` : "";
      return `${field}${error.message}`;
    })
    .join("; ");
}

function logPrefix(step: string, details: Record<string, unknown>): void {
  console.log("[shopify-files]", step, details);
}

async function graphqlAdmin<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const shop = resolveShop();
  const token = resolveAdminToken();
  const apiVersion = resolveApiVersion();

  logPrefix("graphql_request", {
    shop,
    apiVersion,
    variableKeys: Object.keys(variables)
  });

  const response = await fetch(`https://${shop}/admin/api/${apiVersion}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token
    },
    body: JSON.stringify({ query, variables })
  });

  const raw = await response.text();
  let json: { data?: T; errors?: unknown } | null = null;

  try {
    json = JSON.parse(raw) as { data?: T; errors?: unknown };
  } catch {
    json = null;
  }

  if (!response.ok || !json || json.errors || !json.data) {
    logPrefix("graphql_failure", {
      status: response.status,
      bodyPreview: raw.slice(0, 500)
    });
    throw new Error(`Shopify GraphQL failed (${response.status}).`);
  }

  return json.data;
}

async function createStagedUpload(filename: string, fileSize: number, mimeType: string): Promise<StagedUploadTarget> {
  logPrefix("staged_upload_create_start", { filename, fileSize, mimeType });

  const mutation = `
    mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets {
          url
          resourceUrl
          parameters {
            name
            value
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const data = await graphqlAdmin<{
    stagedUploadsCreate: {
      stagedTargets: StagedUploadTarget[];
      userErrors: ShopifyUserError[];
    };
  }>(mutation, {
    input: [
      {
        resource: "FILE",
        filename,
        mimeType,
        httpMethod: "POST",
        fileSize: String(fileSize)
      }
    ]
  });

  if (data.stagedUploadsCreate.userErrors.length > 0) {
    logPrefix("staged_upload_create_user_errors", {
      userErrors: data.stagedUploadsCreate.userErrors
    });
    throw new Error(formatUserErrors(data.stagedUploadsCreate.userErrors));
  }

  const target = data.stagedUploadsCreate.stagedTargets[0];
  if (!target) {
    throw new Error("Shopify staged upload target missing.");
  }

  logPrefix("staged_upload_create_success", {
    url: target.url,
    resourceUrl: target.resourceUrl,
    parameterCount: target.parameters.length
  });

  return target;
}

async function uploadToStagedTarget(target: StagedUploadTarget, filename: string, buffer: Buffer, mimeType: string): Promise<void> {
  logPrefix("staged_upload_binary_start", {
    filename,
    uploadUrl: target.url,
    size: buffer.length
  });

  const form = new FormData();
  for (const parameter of target.parameters) {
    form.append(parameter.name, parameter.value);
  }
  form.append("file", new Blob([new Uint8Array(buffer)], { type: mimeType }), filename);

  const uploadResponse = await fetch(target.url, {
    method: "POST",
    body: form
  });

  if (!uploadResponse.ok) {
    const body = await uploadResponse.text();
    logPrefix("staged_upload_binary_failure", {
      status: uploadResponse.status,
      bodyPreview: body.slice(0, 400)
    });
    throw new Error(`Staged file upload failed (${uploadResponse.status}).`);
  }

  logPrefix("staged_upload_binary_success", {
    filename,
    status: uploadResponse.status
  });
}

async function pollCreatedFileUrl(fileId: string): Promise<string | null> {
  const query = `
    query getNode($id: ID!) {
      node(id: $id) {
        ... on GenericFile {
          id
          fileStatus
          url
        }
      }
    }
  `;

  for (let attempt = 1; attempt <= FILE_READY_POLL_ATTEMPTS; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, FILE_READY_POLL_DELAY_MS));

    const data = await graphqlAdmin<{
      node: { fileStatus?: string | null; url?: string | null } | null;
    }>(query, { id: fileId });

    logPrefix("file_create_poll", {
      attempt,
      fileId,
      fileStatus: data.node?.fileStatus ?? null,
      hasUrl: Boolean(data.node?.url)
    });

    if (data.node?.url) {
      return data.node.url;
    }
  }

  return null;
}

async function createShopifyFile(originalSource: string, filename: string): Promise<string> {
  logPrefix("file_create_start", { filename, originalSource });

  const mutation = `
    mutation fileCreate($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files {
          id
          fileStatus
          ... on GenericFile {
            url
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const created = await graphqlAdmin<{
    fileCreate: {
      files: Array<{ id: string; fileStatus?: string | null; url?: string | null }>;
      userErrors: ShopifyUserError[];
    };
  }>(mutation, {
    files: [
      {
        contentType: "FILE",
        originalSource,
        filename,
        alt: filename
      }
    ]
  });

  if (created.fileCreate.userErrors.length > 0) {
    logPrefix("file_create_user_errors", {
      userErrors: created.fileCreate.userErrors
    });
    throw new Error(formatUserErrors(created.fileCreate.userErrors));
  }

  const file = created.fileCreate.files[0];
  if (!file) {
    throw new Error("fileCreate returned no file.");
  }

  if (file.url) {
    logPrefix("file_create_success", {
      fileId: file.id,
      fileStatus: file.fileStatus ?? null,
      url: file.url
    });
    return file.url;
  }

  const polledUrl = await pollCreatedFileUrl(file.id);
  if (polledUrl) {
    logPrefix("file_create_success", {
      fileId: file.id,
      fileStatus: file.fileStatus ?? null,
      url: polledUrl
    });
    return polledUrl;
  }

  throw new Error("Shopify file URL not ready in time.");
}

export async function uploadFileToShopify(input: UploadShopifyFileInput): Promise<string> {
  const filename = input.filename.trim();
  if (!filename) {
    throw new Error("Filename is required.");
  }

  const mimeType = input.mimeType?.trim() || DEFAULT_MIME_TYPE;

  logPrefix("upload_start", {
    filename,
    size: input.buffer.length,
    mimeType,
    provider: input.provider ?? null,
    source: input.source ?? null,
    shop: input.shop ?? resolveShop()
  });

  const stagedTarget = await createStagedUpload(filename, input.buffer.length, mimeType);
  await uploadToStagedTarget(stagedTarget, filename, input.buffer, mimeType);
  const url = await createShopifyFile(stagedTarget.resourceUrl, filename);

  logPrefix("upload_complete", {
    filename,
    url
  });

  return url;
}

export async function uploadPdfToShopifyFiles(filename: string, buffer: Buffer): Promise<string> {
  return uploadFileToShopify({
    filename,
    buffer,
    mimeType: "application/pdf"
  });
}
