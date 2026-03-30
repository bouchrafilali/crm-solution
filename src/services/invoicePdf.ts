import PDFDocument from "pdfkit";
import type { OrderArticle, OrderSnapshot } from "./orderSnapshots.js";

const PT_PER_MM = 72 / 25.4;

const COLORS = {
  ink: "#121212",
  softInk: "#2b2724",
  muted: "#756e66",
  faint: "#bdb4ab",
  line: "#ded6cb",
  lineSoft: "#ebe5dc",
  paper: "#fcfaf6",
  accent: "#5f5346"
} as const;

type FinancialSummary = {
  subtotal: number;
  discount: number;
  total: number;
  paid: number;
  outstanding: number;
};

type DocumentTone = {
  title: string;
  overline: string;
  footer: string;
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

function textOr(value: unknown, fallback: string): string {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function pageLeft(doc: PDFKit.PDFDocument): number {
  return doc.page.margins.left;
}

function pageRight(doc: PDFKit.PDFDocument): number {
  return doc.page.width - doc.page.margins.right;
}

function pageWidth(doc: PDFKit.PDFDocument): number {
  return pageRight(doc) - pageLeft(doc);
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return textOr(value, "Date non renseignee");
  const dateLabel = date.toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "long",
    year: "numeric"
  });
  const timeLabel = date.toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit"
  });
  return `${dateLabel} a ${timeLabel}`;
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

function paymentStatusLabel(order: OrderSnapshot): string {
  const status = String(order.financialStatus || "").trim().toLowerCase();
  if (status === "paid" || Number(order.outstandingAmount || 0) <= 0) return "Reglement integral";
  if (status === "partially_paid") return "Reglement partiel";
  return "Reglement en attente";
}

function paymentMethodLabel(order: OrderSnapshot): string {
  return textOr(order.paymentGateway, "Mode de reglement non renseigne");
}

function toneForTemplate(templateChoice: string): DocumentTone {
  if (templateChoice === "showroom_receipt") {
    return {
      title: "Recu de maison",
      overline: "Edition privee",
      footer: "Avec nos remerciements."
    };
  }
  if (templateChoice === "international_invoice") {
    return {
      title: "Facture de couture",
      overline: "Edition atelier",
      footer: "Maison Bouchra Filali Lahlou"
    };
  }
  if (templateChoice === "coin") {
    return {
      title: "Facture atelier",
      overline: "Edition atelier",
      footer: "Maison Bouchra Filali Lahlou"
    };
  }
  return {
    title: "Facture de couture",
    overline: "Edition atelier",
    footer: "Maison Bouchra Filali Lahlou"
  };
}

function lineTotal(article: OrderArticle): number {
  return Math.max(0, toNumber(article.quantity)) * Math.max(0, toNumber(article.unitPrice));
}

function sumLineTotals(articles: OrderArticle[]): number {
  return articles.reduce((sum, article) => sum + lineTotal(article), 0);
}

function computeFinancialSummary(order: OrderSnapshot): FinancialSummary {
  const linesSubtotal = sumLineTotals(order.articles || []);
  const subtotal = Math.max(0, linesSubtotal);
  const discount = clamp(Math.max(0, toNumber(order.discountAmount)), 0, subtotal);
  const total = Math.max(0, subtotal - discount);

  const paymentTransactions = Array.isArray(order.paymentTransactions) ? order.paymentTransactions : [];
  const paidFromTransactions = paymentTransactions.reduce((sum, entry) => {
    const sameCurrency = !entry.currency || String(entry.currency).toUpperCase() === String(order.currency || "MAD").toUpperCase();
    return sameCurrency ? sum + Math.max(0, toNumber(entry.amount)) : sum;
  }, 0);

  const paidFromOutstanding = clamp(total - Math.max(0, toNumber(order.outstandingAmount)), 0, total);
  const paid = clamp(paidFromTransactions > 0 ? paidFromTransactions : paidFromOutstanding, 0, total);
  const outstanding = clamp(total - paid, 0, total);

  return { subtotal, discount, total, paid, outstanding };
}

function drawHorizontalRule(doc: PDFKit.PDFDocument, y?: number, color: string = COLORS.line): void {
  const lineY = y ?? doc.y;
  doc
    .moveTo(pageLeft(doc), lineY)
    .lineTo(pageRight(doc), lineY)
    .lineWidth(0.6)
    .strokeColor(color)
    .stroke();
}

function mutedLabel(
  doc: PDFKit.PDFDocument,
  text: string,
  x: number,
  y: number,
  width: number,
  align: "left" | "center" | "right" = "left"
): void {
  doc.fillColor(COLORS.muted).font("Helvetica").fontSize(8).text(text.toUpperCase(), x, y, {
    width,
    align,
    characterSpacing: 1.4
  });
}

function softText(
  doc: PDFKit.PDFDocument,
  text: string,
  x: number,
  y: number,
  width: number,
  align: "left" | "center" | "right" = "left"
): void {
  doc.fillColor(COLORS.softInk).font("Helvetica").fontSize(10.2).text(text, x, y, { width, align });
}

function strongText(
  doc: PDFKit.PDFDocument,
  text: string,
  x: number,
  y: number,
  width: number,
  align: "left" | "right" = "left",
  size = 10.8
): void {
  doc.fillColor(COLORS.ink).font("Helvetica-Bold").fontSize(size).text(text, x, y, { width, align });
}

function serifTitle(
  doc: PDFKit.PDFDocument,
  text: string,
  x: number,
  y: number,
  width: number,
  size: number,
  align: "left" | "center" | "right" = "left"
): void {
  doc.fillColor(COLORS.ink).font("Times-Bold").fontSize(size).text(text, x, y, { width, align });
}

function ensureSpace(doc: PDFKit.PDFDocument, height: number): boolean {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + height <= bottom) return false;
  doc.addPage();
  return true;
}

function drawPageFrame(doc: PDFKit.PDFDocument): void {
  doc.rect(0, 0, doc.page.width, doc.page.height).fill(COLORS.paper);
  doc.fillColor(COLORS.ink);
}

function drawHeader(doc: PDFKit.PDFDocument, order: OrderSnapshot, tone: DocumentTone, financials: FinancialSummary): void {
  drawPageFrame(doc);

  const left = pageLeft(doc);
  const width = pageWidth(doc);
  const top = doc.page.margins.top;

  mutedLabel(doc, tone.overline, left, top, width, "center");
  serifTitle(doc, "MAISON BOUCHRA FILALI LAHLOU", left, top + mm(7), width, 26, "center");
  softText(doc, "Casablanca · contact@bouchrafilalilahlou.com · www.bouchrafilalilahlou.com", left, top + mm(16), width, "center");
  drawHorizontalRule(doc, top + mm(24.5), COLORS.lineSoft);

  const metaTop = top + mm(33);
  const widthLeft = width * 0.58;
  const gap = mm(8);
  const widthRight = width - widthLeft - gap;
  const rightX = left + widthLeft + gap;

  serifTitle(doc, tone.title, left, metaTop, widthLeft, 19);
  softText(doc, "Edite le " + formatDateTime(order.createdAt), left, metaTop + mm(7), widthLeft);

  mutedLabel(doc, "Reference", rightX, metaTop, widthRight);
  strongText(doc, textOr(order.name, "Non renseignee"), rightX, metaTop + mm(4.2), widthRight);
  mutedLabel(doc, "Reglement", rightX, metaTop + mm(13), widthRight);
  softText(doc, paymentStatusLabel(order), rightX, metaTop + mm(17.2), widthRight);
  mutedLabel(doc, "Montant de la commande", rightX, metaTop + mm(26), widthRight);
  strongText(doc, formatMoney(financials.total, order.currency || "MAD"), rightX, metaTop + mm(30.2), widthRight, "left", 11.3);

  doc.y = metaTop + mm(43);
}

function drawIdentityColumns(doc: PDFKit.PDFDocument, order: OrderSnapshot): void {
  const left = pageLeft(doc);
  const width = pageWidth(doc);
  const gap = mm(12);
  const colW = (width - gap) / 2;
  const y = doc.y;

  mutedLabel(doc, "A l'attention de", left, y, colW);
  strongText(doc, textOr(order.customerLabel, "Cliente non renseignee"), left, y + mm(4.2), colW, "left", 11.2);
  softText(doc, textOr(order.customerPhone, "Telephone non renseigne"), left, y + mm(10), colW);
  softText(doc, textOr(order.customerEmail, "E-mail non renseigne"), left, y + mm(15.5), colW);

  mutedLabel(doc, "Coordonnees de commande", left + colW + gap, y, colW);
  strongText(doc, paymentMethodLabel(order), left + colW + gap, y + mm(4.2), colW, "left", 11.2);
  softText(doc, textOr(order.shippingAddress, "Adresse de livraison non renseignee"), left + colW + gap, y + mm(10), colW);

  doc.y = y + mm(27);
}

function drawTableHeader(doc: PDFKit.PDFDocument): void {
  const left = pageLeft(doc);
  const right = pageRight(doc);
  const width = pageWidth(doc);
  const qtyW = mm(16);
  const amountW = mm(42);
  const articleX = left + qtyW + mm(6);
  const articleW = width - qtyW - amountW - mm(10);
  const top = doc.y;

  mutedLabel(doc, "Qte", left, top, qtyW);
  mutedLabel(doc, "Piece", articleX, top, articleW);
  mutedLabel(doc, "Montant", right - amountW, top, amountW, "right");
  doc.y = top + mm(5.2);
  drawHorizontalRule(doc, doc.y, COLORS.line);
  doc.y += mm(4.2);
}

function articleTextHeight(doc: PDFKit.PDFDocument, title: string, width: number): number {
  doc.font("Helvetica-Bold").fontSize(11);
  return doc.heightOfString(title, { width });
}

function drawArticleRow(doc: PDFKit.PDFDocument, article: OrderArticle, currency: string): void {
  const left = pageLeft(doc);
  const right = pageRight(doc);
  const width = pageWidth(doc);
  const qtyW = mm(16);
  const amountW = mm(42);
  const articleX = left + qtyW + mm(6);
  const articleW = width - qtyW - amountW - mm(10);
  const title = textOr(article.title, "Piece couture");
  const lineHeight = Math.max(mm(11.5), articleTextHeight(doc, title, articleW) + mm(3));
  const top = doc.y;

  doc.fillColor(COLORS.muted).font("Helvetica").fontSize(9.5).text(String(Math.max(0, toNumber(article.quantity))), left, top, {
    width: qtyW
  });
  doc.fillColor(COLORS.ink).font("Helvetica-Bold").fontSize(11).text(title, articleX, top, { width: articleW });
  doc.fillColor(COLORS.softInk).font("Helvetica").fontSize(10.5).text(formatMoney(lineTotal(article), currency), right - amountW, top, {
    width: amountW,
    align: "right"
  });

  doc.y = Math.max(doc.y, top + lineHeight);
  drawHorizontalRule(doc, doc.y, COLORS.lineSoft);
  doc.y += mm(4.8);
}

function drawArticles(doc: PDFKit.PDFDocument, order: OrderSnapshot, tone: DocumentTone, financials: FinancialSummary): void {
  const articles = Array.isArray(order.articles) && order.articles.length > 0
    ? order.articles
    : [{ id: "empty", title: "Aucune piece ajoutee", quantity: 0, unitPrice: 0, status: "pending" as const }];

  drawTableHeader(doc);
  for (const article of articles) {
    const projectedHeight = Math.max(mm(18), articleTextHeight(doc, textOr(article.title, "Piece couture"), pageWidth(doc) - mm(64)) + mm(10));
    if (ensureSpace(doc, projectedHeight + mm(34))) {
      drawHeader(doc, order, tone, financials);
      drawTableHeader(doc);
    }
    drawArticleRow(doc, article, order.currency || "MAD");
  }
}

function drawFinancialSummary(doc: PDFKit.PDFDocument, order: OrderSnapshot, tone: DocumentTone, financials: FinancialSummary): void {
  const needed = mm(38);
  if (ensureSpace(doc, needed + mm(28))) {
    drawHeader(doc, order, tone, financials);
  }

  const left = pageLeft(doc);
  const right = pageRight(doc);
  const width = pageWidth(doc);
  const labelW = mm(45);
  const amountW = mm(45);
  const blockW = labelW + amountW;
  const x = right - blockW;
  let y = doc.y + mm(4);

  drawHorizontalRule(doc, y - mm(2), COLORS.line);

  mutedLabel(doc, "Sous-total", x, y, labelW);
  strongText(doc, formatMoney(financials.subtotal, order.currency || "MAD"), x + labelW, y, amountW, "right", 10.7);
  y += mm(6.5);

  if (financials.discount > 0) {
    mutedLabel(doc, "Remise", x, y, labelW);
    softText(doc, formatMoney(-financials.discount, order.currency || "MAD"), x + labelW, y, amountW, "right");
    y += mm(6.5);
  }

  mutedLabel(doc, "Total de la piece", x, y, labelW);
  strongText(doc, formatMoney(financials.total, order.currency || "MAD"), x + labelW, y, amountW, "right", 10.9);
  y += mm(6.5);

  mutedLabel(doc, "Regle a ce jour", x, y, labelW);
  softText(doc, formatMoney(financials.paid, order.currency || "MAD"), x + labelW, y, amountW, "right");
  y += mm(7.3);

  doc.strokeColor(COLORS.lineSoft).lineWidth(0.6).moveTo(x, y - mm(1.5)).lineTo(right, y - mm(1.5)).stroke();
  doc.fillColor(COLORS.accent).font("Times-Bold").fontSize(12.8).text("Reste a payer", x, y, {
    width: labelW + mm(20)
  });
  doc.fillColor(COLORS.accent).font("Helvetica-Bold").fontSize(12.2).text(
    financials.outstanding > 0 ? formatMoney(financials.outstanding, order.currency || "MAD") : "-",
    x + labelW,
    y,
    { width: amountW, align: "right" }
  );

  doc.y = y + mm(12);
}

function drawFooterNote(doc: PDFKit.PDFDocument, tone: DocumentTone): void {
  const needed = mm(18);
  if (ensureSpace(doc, needed)) return;

  doc.y += mm(5);
  drawHorizontalRule(doc, doc.y, COLORS.lineSoft);
  doc.y += mm(5.5);
  serifTitle(doc, tone.footer, pageLeft(doc), doc.y, pageWidth(doc), 11.4, "center");
  doc.y += mm(8);
}

function addPageFooters(doc: PDFKit.PDFDocument): void {
  const range = doc.bufferedPageRange();
  for (let index = 0; index < range.count; index += 1) {
    doc.switchToPage(range.start + index);
    const left = pageLeft(doc);
    const right = pageRight(doc);
    const y = doc.page.height - doc.page.margins.bottom + mm(1.5);
    doc.fillColor(COLORS.faint).font("Helvetica").fontSize(7.5).text("Maison Bouchra Filali Lahlou", left, y, {
      width: pageWidth(doc) / 2
    });
    doc.text(`Page ${index + 1}`, right - mm(18), y, {
      width: mm(18),
      align: "right"
    });
  }
}

async function renderDocument(doc: PDFKit.PDFDocument, order: OrderSnapshot, templateChoice: string): Promise<void> {
  const tone = toneForTemplate(templateChoice);
  const financials = computeFinancialSummary(order);

  drawHeader(doc, order, tone, financials);
  drawIdentityColumns(doc, order);
  drawArticles(doc, order, tone, financials);
  drawFinancialSummary(doc, order, tone, financials);
  drawFooterNote(doc, tone);
  addPageFooters(doc);
}

export async function buildOrderInvoicePdf(order: OrderSnapshot, templateChoice: string): Promise<Buffer> {
  const tone = toneForTemplate(templateChoice);
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: mm(24), left: mm(22), right: mm(22), bottom: mm(22) },
    bufferPages: true,
    info: {
      Title: `${tone.title} ${textOr(order.name, "")}`.trim(),
      Author: "Maison Bouchra Filali Lahlou",
      Subject: tone.title
    }
  });

  const chunks: Buffer[] = [];
  doc.on("data", (chunk) => chunks.push(Buffer.from(chunk)));

  await renderDocument(doc, order, templateChoice);

  const bufferPromise = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  doc.end();
  return await bufferPromise;
}
