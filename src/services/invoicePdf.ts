import PDFDocument from "pdfkit";
import type { OrderArticle, OrderSnapshot } from "./orderSnapshots.js";

const PT_PER_MM = 72 / 25.4;

const COLORS = {
  text: "#111111",
  muted: "#6f6a63",
  faint: "#b8b1a8",
  line: "#e7e1d8",
  lineStrong: "#d8d0c5",
  ivory: "#fbf8f2",
  ivoryStrong: "#f4efe6",
  accent: "#2a2520",
  danger: "#8f3d2f"
} as const;

type FinancialSummary = {
  subtotal: number;
  discount: number;
  total: number;
  paid: number;
  outstanding: number;
  articlesSubtotal: number;
};

type DocumentPreset = {
  internalTitle: string;
  visibleTitle: string;
  eyebrow: string;
  footerNote: string;
};

function mm(value: number): number {
  return value * PT_PER_MM;
}

function toNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function safeText(value: unknown, fallback: string): string {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return safeText(value, "Date non renseignee");
  const dateLabel = date.toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "long",
    year: "numeric"
  });
  const timeLabel = date.toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit"
  });
  return `${dateLabel} · ${timeLabel}`;
}

function formatMoney(value: number, currency: string): string {
  const amount = Math.abs(Number(value || 0));
  const formatted = new Intl.NumberFormat("fr-FR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(amount);
  const code = String(currency || "MAD").trim().toUpperCase() || "MAD";
  return `${value < 0 ? "-" : ""}${formatted} ${code}`;
}

function paymentStatusFr(order: OrderSnapshot): string {
  const status = String(order.financialStatus || "").toLowerCase();
  if (status === "paid" || Number(order.outstandingAmount || 0) <= 0) return "Reglee";
  if (status === "partially_paid") return "Partiellement reglee";
  return "En attente de reglement";
}

function paymentMethodFr(order: OrderSnapshot): string {
  const gateway = String(order.paymentGateway || "").trim();
  if (!gateway) return "Non renseigne";
  return gateway;
}

function documentPreset(templateChoice: string): DocumentPreset {
  if (templateChoice === "showroom_receipt") {
    return {
      internalTitle: "Recu showroom",
      visibleTitle: "Recu showroom",
      eyebrow: "Document de paiement",
      footerNote: "Creation couture editee pour la cliente et la Maison."
    };
  }
  if (templateChoice === "international_invoice") {
    return {
      internalTitle: "Facture couture internationale",
      visibleTitle: "Facture couture internationale",
      eyebrow: "Document commercial",
      footerNote: "Document edite pour suivi de commande et reglement."
    };
  }
  if (templateChoice === "coin") {
    return {
      internalTitle: "Facture atelier",
      visibleTitle: "Facture atelier",
      eyebrow: "Document commercial",
      footerNote: "Document edite par la Maison pour confirmation de commande."
    };
  }
  return {
    internalTitle: "Facture couture",
    visibleTitle: "Facture couture",
    eyebrow: "Document commercial",
    footerNote: "Document edite par la Maison pour confirmation de commande."
  };
}

function computeFinancialSummary(order: OrderSnapshot): FinancialSummary {
  const articlesSubtotal = (order.articles || []).reduce((sum, article) => {
    const quantity = Math.max(0, toNumber(article.quantity || 0));
    const unitPrice = Math.max(0, toNumber(article.unitPrice || 0));
    return sum + quantity * unitPrice;
  }, 0);

  let subtotal = Math.max(0, toNumber(order.subtotalAmount));
  if (!(subtotal > 0)) subtotal = articlesSubtotal;
  if (articlesSubtotal > subtotal) subtotal = articlesSubtotal;

  let discount = Math.max(0, toNumber(order.discountAmount));
  if (discount > subtotal) discount = subtotal;

  let total = Math.max(0, toNumber(order.totalAmount));
  const expectedTotal = Math.max(0, subtotal - discount);
  if (!(total > 0)) {
    total = expectedTotal;
  } else if (Math.abs(total - expectedTotal) > 0.01) {
    total = expectedTotal;
  }

  const payments = Array.isArray(order.paymentTransactions) ? order.paymentTransactions : [];
  const paidFromTransactions = payments.reduce((sum, entry) => {
    const sameCurrency = !entry.currency || String(entry.currency).toUpperCase() === String(order.currency || "MAD").toUpperCase();
    return sameCurrency ? sum + Math.max(0, toNumber(entry.amount)) : sum;
  }, 0);

  const rawOutstanding = clamp(Math.max(0, toNumber(order.outstandingAmount)), 0, total);
  const paidFromOutstanding = clamp(total - rawOutstanding, 0, total);
  const paid = clamp(paidFromTransactions > 0 ? paidFromTransactions : paidFromOutstanding, 0, total);
  const outstanding = clamp(total - paid, 0, total);

  return {
    subtotal,
    discount,
    total,
    paid,
    outstanding,
    articlesSubtotal
  };
}

function ensureSpace(doc: PDFKit.PDFDocument, neededHeight: number): void {
  const bottomLimit = doc.page.height - doc.page.margins.bottom;
  if (doc.y + neededHeight <= bottomLimit) return;
  doc.addPage();
}

function ensureSpaceWithHeader(
  doc: PDFKit.PDFDocument,
  neededHeight: number,
  order: OrderSnapshot,
  preset: DocumentPreset,
  financials: FinancialSummary
): void {
  const bottomLimit = doc.page.height - doc.page.margins.bottom;
  if (doc.y + neededHeight <= bottomLimit) return;
  doc.addPage();
  drawHeader(doc, order, preset, financials);
}

function drawRule(doc: PDFKit.PDFDocument, y?: number): void {
  const drawY = y ?? doc.y;
  doc
    .moveTo(doc.page.margins.left, drawY)
    .lineTo(doc.page.width - doc.page.margins.right, drawY)
    .lineWidth(0.8)
    .strokeColor(COLORS.line)
    .stroke();
}

function writeMutedLabel(doc: PDFKit.PDFDocument, text: string, x: number, y: number, width: number): void {
  doc.fillColor(COLORS.muted).font("Helvetica").fontSize(8.5).text(text.toUpperCase(), x, y, {
    width,
    characterSpacing: 1
  });
}

function writeValue(doc: PDFKit.PDFDocument, text: string, x: number, y: number, width: number, align: "left" | "right" = "left"): void {
  doc.fillColor(COLORS.text).font("Helvetica").fontSize(11).text(text, x, y, { width, align });
}

function writeStrongValue(doc: PDFKit.PDFDocument, text: string, x: number, y: number, width: number, align: "left" | "right" = "left"): void {
  doc.fillColor(COLORS.text).font("Helvetica-Bold").fontSize(11).text(text, x, y, { width, align });
}

function drawHeader(doc: PDFKit.PDFDocument, order: OrderSnapshot, preset: DocumentPreset, financials: FinancialSummary): void {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const width = right - left;
  const top = doc.page.margins.top;

  doc.fillColor(COLORS.text).font("Helvetica").fontSize(8.5).text(preset.eyebrow.toUpperCase(), left, top, {
    width,
    align: "center",
    characterSpacing: 1.2
  });

  doc.font("Times-Bold").fontSize(24).text("MAISON BOUCHRA FILALI LAHLOU", left, top + mm(6), {
    width,
    align: "center"
  });

  doc.fillColor(COLORS.muted).font("Helvetica").fontSize(9.5).text(
    "Casablanca · contact@bouchrafilalilahlou.com · www.bouchrafilalilahlou.com",
    left,
    top + mm(15.5),
    { width, align: "center" }
  );

  drawRule(doc, top + mm(24));

  const metaTop = top + mm(30);
  const colGap = mm(8);
  const leftColW = width * 0.54;
  const rightColW = width - leftColW - colGap;
  const rightColX = left + leftColW + colGap;

  doc.fillColor(COLORS.text).font("Times-Roman").fontSize(19).text(preset.visibleTitle, left, metaTop, {
    width: leftColW
  });
  doc.fillColor(COLORS.muted).font("Helvetica").fontSize(10).text("Edition du " + formatDateTime(order.createdAt), left, metaTop + mm(8), {
    width: leftColW
  });

  writeMutedLabel(doc, "Commande", rightColX, metaTop, rightColW);
  writeStrongValue(doc, safeText(order.name, "Non renseignee"), rightColX, metaTop + mm(4.8), rightColW);
  writeMutedLabel(doc, "Statut", rightColX, metaTop + mm(13), rightColW);
  writeValue(doc, paymentStatusFr(order), rightColX, metaTop + mm(17.8), rightColW);
  writeMutedLabel(doc, "Total", rightColX, metaTop + mm(26), rightColW);
  writeStrongValue(doc, formatMoney(financials.total, order.currency || "MAD"), rightColX, metaTop + mm(30.8), rightColW);

  doc.y = metaTop + mm(42);
}

function drawClientAndOrderBlocks(
  doc: PDFKit.PDFDocument,
  order: OrderSnapshot,
  preset: DocumentPreset,
  financials: FinancialSummary
): void {
  ensureSpaceWithHeader(doc, mm(42), order, preset, financials);

  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const width = right - left;
  const gap = mm(8);
  const colW = (width - gap) / 2;
  const startY = doc.y;
  const boxHeight = mm(33);

  doc.rect(left, startY, colW, boxHeight).fill(COLORS.ivory);
  doc.rect(left + colW + gap, startY, colW, boxHeight).fill(COLORS.ivory);
  doc.strokeColor(COLORS.line);
  doc.lineWidth(0.8).rect(left, startY, colW, boxHeight).stroke();
  doc.lineWidth(0.8).rect(left + colW + gap, startY, colW, boxHeight).stroke();

  writeMutedLabel(doc, "Cliente", left + mm(4), startY + mm(4), colW - mm(8));
  writeStrongValue(doc, safeText(order.customerLabel, "Cliente non renseignee"), left + mm(4), startY + mm(10), colW - mm(8));
  writeValue(doc, safeText(order.customerPhone, "Telephone non renseigne"), left + mm(4), startY + mm(16.5), colW - mm(8));
  writeValue(doc, safeText(order.customerEmail, "E-mail non renseigne"), left + mm(4), startY + mm(22.5), colW - mm(8));

  writeMutedLabel(doc, "Livraison et paiement", left + colW + gap + mm(4), startY + mm(4), colW - mm(8));
  writeStrongValue(doc, paymentMethodFr(order), left + colW + gap + mm(4), startY + mm(10), colW - mm(8));
  writeValue(
    doc,
    safeText(order.shippingAddress, "Adresse de livraison non renseignee"),
    left + colW + gap + mm(4),
    startY + mm(16.5),
    colW - mm(8)
  );

  doc.y = startY + boxHeight + mm(8);
}

function drawArticlesHeader(doc: PDFKit.PDFDocument): void {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const width = right - left;
  const qtyW = mm(18);
  const amountW = mm(42);
  const articleX = left + qtyW + mm(4);
  const articleW = width - qtyW - amountW - mm(8);

  writeMutedLabel(doc, "Qte", left, doc.y, qtyW);
  writeMutedLabel(doc, "Piece", articleX, doc.y, articleW);
  writeMutedLabel(doc, "Montant", right - amountW, doc.y, amountW);
  doc.y += mm(5);
  drawRule(doc);
  doc.y += mm(3.5);
}

function articleRowHeight(doc: PDFKit.PDFDocument, article: OrderArticle, articleWidth: number): number {
  const titleHeight = doc.heightOfString(safeText(article.title, "Piece couture"), {
    width: articleWidth,
    align: "left"
  });
  return Math.max(mm(10), titleHeight + mm(4.5));
}

function drawArticleRow(
  doc: PDFKit.PDFDocument,
  article: OrderArticle,
  currency: string,
  order: OrderSnapshot,
  preset: DocumentPreset,
  financials: FinancialSummary
): void {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const width = right - left;
  const qtyW = mm(18);
  const amountW = mm(42);
  const articleX = left + qtyW + mm(4);
  const articleW = width - qtyW - amountW - mm(8);
  const rowHeight = articleRowHeight(doc, article, articleW);
  const amount = Math.max(0, toNumber(article.quantity)) * Math.max(0, toNumber(article.unitPrice));
  ensureSpaceWithHeader(doc, rowHeight + mm(6) + mm(10), order, preset, financials);
  const startY = doc.y;

  doc.fillColor(COLORS.text).font("Helvetica").fontSize(10.5).text(String(Math.max(0, toNumber(article.quantity))), left, startY, {
    width: qtyW
  });
  doc.fillColor(COLORS.text).font("Helvetica-Bold").fontSize(10.8).text(safeText(article.title, "Piece couture"), articleX, startY, {
    width: articleW
  });
  doc.fillColor(COLORS.text).font("Helvetica").fontSize(10.5).text(formatMoney(amount, currency), right - amountW, startY, {
    width: amountW,
    align: "right"
  });

  doc.y = Math.max(doc.y, startY + rowHeight);
  drawRule(doc, doc.y);
  doc.y += mm(3.5);
}

function drawArticlesTable(
  doc: PDFKit.PDFDocument,
  order: OrderSnapshot,
  preset: DocumentPreset,
  financials: FinancialSummary
): void {
  drawArticlesHeader(doc);
  const articles = Array.isArray(order.articles) && order.articles.length > 0
    ? order.articles
    : [{ id: "empty", title: "Aucune piece ajoutee", quantity: 0, unitPrice: 0, status: "pending" as const }];

  for (const article of articles) {
    if (doc.y + mm(18) > doc.page.height - doc.page.margins.bottom - mm(55)) {
      doc.addPage();
      drawHeader(doc, order, preset, financials);
      drawArticlesHeader(doc);
    }
    drawArticleRow(doc, article, order.currency || "MAD", order, preset, financials);
  }
}

function drawTotalsBlock(
  doc: PDFKit.PDFDocument,
  order: OrderSnapshot,
  financials: FinancialSummary,
  preset: DocumentPreset
): void {
  ensureSpaceWithHeader(doc, mm(50), order, preset, financials);

  const blockWidth = mm(78);
  const x = doc.page.width - doc.page.margins.right - blockWidth;
  const y = doc.y + mm(3);
  const lineGap = mm(6.4);
  const height = y + (financials.discount > 0 ? mm(34) : mm(28));

  doc.rect(x, y, blockWidth, height - y).fill(COLORS.ivory);
  doc.strokeColor(COLORS.lineStrong).lineWidth(0.8).rect(x, y, blockWidth, height - y).stroke();

  let rowY = y + mm(6);
  writeMutedLabel(doc, "Sous-total", x + mm(4), rowY, blockWidth - mm(8));
  writeStrongValue(doc, formatMoney(financials.subtotal, order.currency || "MAD"), x + mm(4), rowY + mm(4.2), blockWidth - mm(8), "right");
  rowY += lineGap;

  if (financials.discount > 0) {
    writeMutedLabel(doc, "Remise", x + mm(4), rowY, blockWidth - mm(8));
    writeValue(doc, formatMoney(-financials.discount, order.currency || "MAD"), x + mm(4), rowY + mm(4.2), blockWidth - mm(8), "right");
    rowY += lineGap;
  }

  writeMutedLabel(doc, "Total", x + mm(4), rowY, blockWidth - mm(8));
  writeStrongValue(doc, formatMoney(financials.total, order.currency || "MAD"), x + mm(4), rowY + mm(4.2), blockWidth - mm(8), "right");
  rowY += lineGap;

  writeMutedLabel(doc, "Total regle", x + mm(4), rowY, blockWidth - mm(8));
  writeValue(doc, formatMoney(financials.paid, order.currency || "MAD"), x + mm(4), rowY + mm(4.2), blockWidth - mm(8), "right");
  rowY += lineGap;

  doc.fillColor(financials.outstanding > 0 ? COLORS.danger : COLORS.text).font("Helvetica-Bold").fontSize(11.2).text(
    "Reste a payer",
    x + mm(4),
    rowY,
    { width: blockWidth - mm(8) }
  );
  doc.text(
    financials.outstanding > 0 ? formatMoney(financials.outstanding, order.currency || "MAD") : "-",
    x + mm(4),
    rowY,
    { width: blockWidth - mm(8), align: "right" }
  );

  doc.y = height + mm(8);
}

function drawClosingNote(doc: PDFKit.PDFDocument, order: OrderSnapshot, financials: FinancialSummary, preset: DocumentPreset): void {
  ensureSpaceWithHeader(doc, mm(24), order, preset, financials);

  const left = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const note =
    financials.outstanding > 0
      ? "Nous vous remercions pour votre confiance. Le solde restant pourra etre regle selon les modalites convenues avec la Maison."
      : "Nous vous remercions pour votre confiance. Ce document confirme le reglement de votre commande couture.";

  doc.rect(left, doc.y, width, mm(18)).fill(COLORS.ivoryStrong);
  doc.strokeColor(COLORS.line).lineWidth(0.8).rect(left, doc.y, width, mm(18)).stroke();
  doc.fillColor(COLORS.text).font("Helvetica").fontSize(10.2).text(note, left + mm(4), doc.y + mm(5.3), {
    width: width - mm(8),
    align: "left"
  });
  doc.y += mm(24);
}

function addFooters(doc: PDFKit.PDFDocument, preset: DocumentPreset): void {
  const range = doc.bufferedPageRange();
  for (let index = 0; index < range.count; index += 1) {
    doc.switchToPage(range.start + index);
    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const footerY = doc.page.height - doc.page.margins.bottom + mm(2);
    drawRule(doc, footerY - mm(3));
    doc.fillColor(COLORS.muted).font("Helvetica").fontSize(8.5).text(preset.footerNote, left, footerY, {
      width: right - left - mm(24)
    });
    doc.text(`Page ${index + 1}/${range.count}`, right - mm(24), footerY, {
      width: mm(24),
      align: "right"
    });
  }
}

async function renderPremiumDocument(
  doc: PDFKit.PDFDocument,
  order: OrderSnapshot,
  templateChoice: string
): Promise<void> {
  const preset = documentPreset(templateChoice);
  const financials = computeFinancialSummary(order);

  drawHeader(doc, order, preset, financials);
  drawClientAndOrderBlocks(doc, order, preset, financials);
  drawArticlesTable(doc, order, preset, financials);
  drawTotalsBlock(doc, order, financials, preset);
  drawClosingNote(doc, order, financials, preset);
  addFooters(doc, preset);
}

export async function buildOrderInvoicePdf(order: OrderSnapshot, templateChoice: string): Promise<Buffer> {
  const preset = documentPreset(templateChoice);
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: mm(18), left: mm(18), right: mm(18), bottom: mm(18) },
    bufferPages: true,
    info: {
      Title: `${preset.internalTitle} ${safeText(order.name, "")}`.trim(),
      Author: "Maison Bouchra Filali Lahlou",
      Subject: preset.internalTitle
    }
  });

  const chunks: Buffer[] = [];
  doc.on("data", (chunk) => chunks.push(Buffer.from(chunk)));

  await renderPremiumDocument(doc, order, templateChoice);

  const bufferPromise = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  doc.end();
  return await bufferPromise;
}
