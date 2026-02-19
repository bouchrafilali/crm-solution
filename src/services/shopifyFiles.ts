import { assertShopifyShop, getShopifyAdminToken } from "./shopifyAdminAuth.js";

type StagedUploadTarget = {
  url: string;
  resourceUrl: string;
  parameters: Array<{ name: string; value: string }>;
};

async function graphqlAdmin<T>(shop: string, token: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(`https://${shop}/admin/api/2026-01/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token
    },
    body: JSON.stringify({ query, variables })
  });

  const raw = await res.text();
  let json: { data?: T; errors?: unknown } | null = null;
  try {
    json = JSON.parse(raw) as { data?: T; errors?: unknown };
  } catch {
    json = null;
  }

  if (!res.ok || !json || json.errors || !json.data) {
    throw new Error(`Shopify GraphQL failed (${res.status}): ${raw.slice(0, 500)}`);
  }

  return json.data;
}

async function createStagedUpload(shop: string, token: string, filename: string, size: number): Promise<StagedUploadTarget> {
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
      userErrors: Array<{ message: string }>;
    };
  }>(shop, token, mutation, {
    input: [
      {
        resource: "FILE",
        filename,
        mimeType: "application/pdf",
        httpMethod: "POST",
        fileSize: String(size)
      }
    ]
  });

  if (data.stagedUploadsCreate.userErrors.length > 0) {
    throw new Error(data.stagedUploadsCreate.userErrors.map((e) => e.message).join("; "));
  }

  const target = data.stagedUploadsCreate.stagedTargets[0];
  if (!target) {
    throw new Error("Shopify staged upload target missing.");
  }
  return target;
}

async function uploadToStagedTarget(target: StagedUploadTarget, filename: string, buffer: Buffer): Promise<void> {
  const form = new FormData();
  target.parameters.forEach((parameter) => {
    form.append(parameter.name, parameter.value);
  });
  form.append("file", new Blob([buffer], { type: "application/pdf" }), filename);

  const uploadRes = await fetch(target.url, {
    method: "POST",
    body: form
  });

  if (!uploadRes.ok) {
    const body = await uploadRes.text();
    throw new Error(`Staged file upload failed (${uploadRes.status}): ${body.slice(0, 400)}`);
  }
}

async function createShopifyFile(shop: string, token: string, originalSource: string, filename: string): Promise<string> {
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
      files: Array<{ id: string; fileStatus?: string; url?: string }>;
      userErrors: Array<{ message: string }>;
    };
  }>(shop, token, mutation, {
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
    throw new Error(created.fileCreate.userErrors.map((e) => e.message).join("; "));
  }

  const file = created.fileCreate.files[0];
  if (!file) throw new Error("fileCreate returned no file.");
  if (file.url) return file.url;

  const pollQuery = `
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

  for (let i = 0; i < 12; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const polled = await graphqlAdmin<{
      node: { fileStatus?: string; url?: string } | null;
    }>(shop, token, pollQuery, { id: file.id });
    if (polled.node?.url) return polled.node.url;
  }

  throw new Error("Shopify file URL not ready in time.");
}

export async function uploadPdfToShopifyFiles(filename: string, buffer: Buffer): Promise<string> {
  const shop = assertShopifyShop();
  const token = await getShopifyAdminToken(shop);
  const staged = await createStagedUpload(shop, token, filename, buffer.length);
  await uploadToStagedTarget(staged, filename, buffer);
  return await createShopifyFile(shop, token, staged.resourceUrl, filename);
}
