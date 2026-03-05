import "dotenv/config";
import { randomUUID } from "node:crypto";
import { getDbPool, initDb } from "../client.js";

type SeedLead = {
  clientName: string;
  phoneNumber: string;
  country: string;
  inquirySource: string;
  productReference: string;
  stage:
    | "NEW"
    | "PRODUCT_INTEREST"
    | "QUALIFICATION_PENDING"
    | "PRICE_SENT"
    | "QUALIFIED"
    | "VIDEO_PROPOSED"
    | "DEPOSIT_PENDING"
    | "CONVERTED";
  firstResponseTimeMinutes: number;
  daysAgo: number;
};

const SEED_LEADS: SeedLead[] = [
  {
    clientName: "Rania El Khatib",
    phoneNumber: "+212600001000",
    country: "FR",
    inquirySource: "Instagram",
    productReference: "Kaftan Jade Noctis",
    stage: "PRODUCT_INTEREST",
    firstResponseTimeMinutes: 19,
    daysAgo: 2
  },
  {
    clientName: "Sara Benali",
    phoneNumber: "+212600001001",
    country: "MA",
    inquirySource: "Instagram",
    productReference: "Caftan Heritage",
    stage: "NEW",
    firstResponseTimeMinutes: 22,
    daysAgo: 3
  },
  {
    clientName: "Nora Kabbaj",
    phoneNumber: "+212600001002",
    country: "FR",
    inquirySource: "Website",
    productReference: "Takchita Crystal",
    stage: "QUALIFICATION_PENDING",
    firstResponseTimeMinutes: 18,
    daysAgo: 7
  },
  {
    clientName: "Meriem Lahlou",
    phoneNumber: "+212600001007",
    country: "MA",
    inquirySource: "Direct",
    productReference: "Takchita Saphir",
    stage: "PRICE_SENT",
    firstResponseTimeMinutes: 15,
    daysAgo: 8
  },
  {
    clientName: "Mina El Fassi",
    phoneNumber: "+212600001003",
    country: "AE",
    inquirySource: "Direct",
    productReference: "Jellaba Evening",
    stage: "QUALIFIED",
    firstResponseTimeMinutes: 14,
    daysAgo: 11
  },
  {
    clientName: "Leila Tahri",
    phoneNumber: "+212600001004",
    country: "UK",
    inquirySource: "Instagram",
    productReference: "Kaftan Velvet",
    stage: "VIDEO_PROPOSED",
    firstResponseTimeMinutes: 28,
    daysAgo: 16
  },
  {
    clientName: "Yasmine Alami",
    phoneNumber: "+212600001005",
    country: "US",
    inquirySource: "Website",
    productReference: "Takchita Gold",
    stage: "DEPOSIT_PENDING",
    firstResponseTimeMinutes: 12,
    daysAgo: 21
  },
  {
    clientName: "Salma Idrissi",
    phoneNumber: "+212600001006",
    country: "CA",
    inquirySource: "Direct",
    productReference: "Caftan Signature",
    stage: "CONVERTED",
    firstResponseTimeMinutes: 9,
    daysAgo: 26
  }
];

function mustAllowSeed(): void {
  const nodeEnv = String(process.env.NODE_ENV || "development").toLowerCase();
  if (nodeEnv === "production") {
    throw new Error("Seeding is blocked in production.");
  }
  const confirm = String(process.env.SEED_CONFIRM || "").toLowerCase();
  if (!confirm || (confirm !== "yes" && confirm !== "true" && confirm !== "1")) {
    throw new Error("Set SEED_CONFIRM=yes to run this seed.");
  }
}

async function run(): Promise<void> {
  mustAllowSeed();
  await initDb();
  const db = getDbPool();
  if (!db) throw new Error("DATABASE_URL is not configured.");

  let inserted = 0;
  for (const lead of SEED_LEADS) {
    const createdAt = new Date(Date.now() - lead.daysAgo * 24 * 60 * 60 * 1000).toISOString();
    const result = await db.query(
      `
        insert into whatsapp_leads (
          id,
          client_name,
          phone_number,
          country,
          inquiry_source,
          product_reference,
          price_sent,
          stage,
          first_response_time_minutes,
          last_activity_at,
          created_at,
          updated_at
        )
        select
          $1::uuid,
          $2::text,
          $3::text,
          $4::text,
          $5::text,
          $6::text,
          $7::boolean,
          $8::whatsapp_lead_stage,
          $9::int,
          $10::timestamptz,
          $11::timestamptz,
          $11::timestamptz
        where not exists (
          select 1 from whatsapp_leads where phone_number = $3::text
        )
      `,
      [
        randomUUID(),
        lead.clientName,
        lead.phoneNumber,
        lead.country,
        lead.inquirySource,
        lead.productReference,
        lead.stage !== "NEW",
        lead.stage,
        lead.firstResponseTimeMinutes,
        createdAt,
        createdAt
      ]
    );
    inserted += result.rowCount || 0;
  }

  const total = await db.query<{ count: string }>(
    "select count(*)::text as count from whatsapp_leads where created_at >= now() - interval '30 days'"
  );
  const total30d = Number(total.rows[0]?.count || 0);

  console.log(`[seed:whatsapp] inserted=${inserted}, total_last_30_days=${total30d}`);
  await db.end();
}

run().catch((error) => {
  console.error("[seed:whatsapp] failed", error);
  process.exit(1);
});
