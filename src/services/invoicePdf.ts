import PDFDocument from "pdfkit";
import { existsSync } from "node:fs";
import type { OrderArticle, OrderSnapshot } from "./orderSnapshots.js";

const PT_PER_MM = 72 / 25.4;
const RECEIPT_PDF_MARGINS_MM = {
  top: 18,
  right: 20,
  bottom: 16,
  left: 20
} as const;

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

type ReceiptHtmlViewModel = {
  tone: DocumentTone;
  reference: string;
  dateLabel: string;
  financialLabel: string;
  paymentMethod: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  shippingAddress: string;
  currency: string;
  articles: Array<{ quantity: number; title: string; amountLabel: string }>;
  subtotalLabel: string;
  discountLabel: string | null;
  totalLabel: string;
  paidLabel: string;
  outstandingLabel: string;
  hasOutstanding: boolean;
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

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
  if (Number.isNaN(date.getTime())) return textOr(value, "Date non renseignée");
  const dateLabel = date.toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "long",
    year: "numeric"
  });
  const timeLabel = date.toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit"
  });
  return `${dateLabel} à ${timeLabel}`;
}

function formatMoney(value: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency || "MAD"
  }).format(Number(value || 0));
}

function paymentStatusLabel(order: OrderSnapshot): string {
  const status = String(order.financialStatus || "").trim().toLowerCase();
  if (status === "paid" || Number(order.outstandingAmount || 0) <= 0) return "Règlement intégral";
  if (status === "partially_paid") return "Règlement partiel";
  return "Règlement en attente";
}

function paymentMethodLabel(order: OrderSnapshot): string {
  return textOr(order.paymentGateway, "Mode de règlement non renseigné");
}

function toneForTemplate(templateChoice: string): DocumentTone {
  if (templateChoice === "showroom_receipt") {
    return {
      title: "Reçu de maison",
      overline: "Édition privée",
      footer: "Avec nos remerciements."
    };
  }
  if (templateChoice === "international_invoice") {
    return {
      title: "Facture de couture",
      overline: "Édition atelier",
      footer: "Maison Bouchra Filali Lahlou"
    };
  }
  if (templateChoice === "coin") {
    return {
      title: "Facture atelier",
      overline: "Édition atelier",
      footer: "Maison Bouchra Filali Lahlou"
    };
  }
  return {
    title: "Facture de couture",
    overline: "Édition atelier",
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

function buildReceiptHtmlViewModel(order: OrderSnapshot, templateChoice: string): ReceiptHtmlViewModel {
  const tone = toneForTemplate(templateChoice);
  const financials = computeFinancialSummary(order);
  return {
    tone,
    reference: textOr(order.name, "Non renseignée"),
    dateLabel: formatDateTime(order.createdAt),
    financialLabel: paymentStatusLabel(order),
    paymentMethod: paymentMethodLabel(order),
    customerName: textOr(order.customerLabel, "Cliente non renseignée"),
    customerPhone: textOr(order.customerPhone, "Téléphone non renseigné"),
    customerEmail: textOr(order.customerEmail, "E-mail non renseigne"),
    shippingAddress: textOr(order.shippingAddress, "Adresse de livraison non renseignée"),
    currency: order.currency || "MAD",
    articles: (Array.isArray(order.articles) && order.articles.length > 0
      ? order.articles
      : [{ id: "empty", title: "Aucune piece ajoutee", quantity: 0, unitPrice: 0, status: "pending" as const }]).map((article) => ({
        quantity: Math.max(0, toNumber(article.quantity)),
        title: textOr(article.title, "Pièce couture"),
        amountLabel: formatMoney(lineTotal(article), order.currency || "MAD")
      })),
    subtotalLabel: formatMoney(financials.subtotal, order.currency || "MAD"),
    discountLabel: financials.discount > 0 ? formatMoney(-financials.discount, order.currency || "MAD") : null,
    totalLabel: formatMoney(financials.total, order.currency || "MAD"),
    paidLabel: formatMoney(financials.paid, order.currency || "MAD"),
    outstandingLabel: financials.outstanding > 0 ? formatMoney(financials.outstanding, order.currency || "MAD") : "-",
    hasOutstanding: financials.outstanding > 0
  };
}

export function buildOrderInvoiceHtml(order: OrderSnapshot, templateChoice: string): string | null {
  if (templateChoice !== "showroom_receipt") return null;

  const view = buildReceiptHtmlViewModel(order, templateChoice);
  return (
    "<!doctype html><html><head><meta charset='utf-8' /><title>" + escapeHtml(view.tone.title + " " + view.reference) + "</title>" +
    "<style>@page{size:A4;margin:18mm}html,body{margin:0;padding:0;background:#fcfaf6;color:#121212;font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif}" +
    "*{box-sizing:border-box}.page{padding:18mm 20mm 16mm;min-height:100vh}.overline{text-align:center;font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:#756e66}" +
    ".brand{text-align:center;font-family:Georgia,'Times New Roman',serif;font-size:34px;letter-spacing:.05em;line-height:1.1;margin-top:14px}" +
    ".meta{text-align:center;color:#756e66;font-size:13px;margin-top:10px}.rule{height:1px;background:#ebe5dc;margin:24px 0 28px}" +
    ".hero{display:grid;grid-template-columns:1.45fr .85fr;gap:44px;align-items:start}.doc-title{font-family:Georgia,'Times New Roman',serif;font-size:33px;line-height:1.08;font-weight:500}" +
    ".doc-sub{margin-top:10px;color:#756e66;font-size:14px}.meta-stack{padding-top:2px}.meta-label{font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:#756e66;margin-top:14px}" +
    ".meta-label:first-child{margin-top:0}.meta-value{margin-top:5px;font-size:16px;line-height:1.35}.meta-value.strong{font-weight:700}" +
    ".identity{display:grid;grid-template-columns:1fr 1fr;gap:54px;margin-top:34px}.identity-label{font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:#756e66}" +
    ".identity-value{margin-top:7px;font-size:17px;font-weight:700}.identity-copy{margin-top:7px;font-size:14px;line-height:1.6;color:#2b2724}" +
    ".table{margin-top:42px}.table-head,.table-row{display:grid;grid-template-columns:52px 1fr 210px;gap:16px;align-items:start}.table-head{font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:#756e66;padding-bottom:12px}" +
    ".table-rule{height:1px;background:#ded6cb}.table-row{padding:16px 0 18px;border-bottom:1px solid #ebe5dc}.qty{font-size:13px;color:#756e66}.piece{font-size:18px;line-height:1.35;font-weight:600}" +
    ".amount{text-align:right;font-size:16px;line-height:1.35;color:#2b2724}.financials{margin-top:34px;display:grid;grid-template-columns:1fr 270px;gap:40px;align-items:end}" +
    ".financial-copy{font-size:14px;line-height:1.7;color:#756e66;padding-bottom:6px}.totals{padding-top:10px}.totals-row{display:grid;grid-template-columns:1fr auto;gap:18px;padding:6px 0}" +
    ".totals-label{font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:#756e66}.totals-value{text-align:right;font-size:15px;color:#2b2724}" +
    ".totals-rule{height:1px;background:#ebe5dc;margin:8px 0 10px}.balance{display:grid;grid-template-columns:1fr auto;gap:18px;align-items:end;padding-top:2px}" +
    ".balance-label{font-family:Georgia,'Times New Roman',serif;font-size:24px;line-height:1.1;color:#5f5346}.balance-value{text-align:right;font-size:21px;font-weight:700;color:#5f5346}" +
    ".footer{margin-top:54px;padding-top:18px;border-top:1px solid #ebe5dc;text-align:center;font-family:Georgia,'Times New Roman',serif;font-size:18px;color:#2b2724}" +
    "@media (max-width: 820px){.page{padding:12mm}.hero,.identity,.financials{grid-template-columns:1fr}.table-head,.table-row{grid-template-columns:42px 1fr 120px;gap:10px}.brand{font-size:28px}.doc-title{font-size:28px}.piece{font-size:16px}.balance-label{font-size:20px}.balance-value{font-size:18px}}</style></head><body><div class='page'>" +
    "<div class='overline'>" + escapeHtml(view.tone.overline) + "</div>" +
    "<div class='brand'>Maison Bouchra Filali Lahlou</div>" +
    "<div class='meta'>Casablanca · contact@bouchrafilalilahlou.com · www.bouchrafilalilahlou.com</div>" +
    "<div class='rule'></div>" +
    "<div class='hero'><div><div class='doc-title'>" + escapeHtml(view.tone.title) + "</div><div class='doc-sub'>Edite le " + escapeHtml(view.dateLabel) + "</div></div><div class='meta-stack'>" +
    "<div class='meta-label'>Reference</div><div class='meta-value strong'>" + escapeHtml(view.reference) + "</div>" +
    "<div class='meta-label'>Reglement</div><div class='meta-value'>" + escapeHtml(view.financialLabel) + "</div>" +
    "<div class='meta-label'>Montant de la commande</div><div class='meta-value strong'>" + escapeHtml(view.totalLabel) + "</div>" +
    "</div></div>" +
    "<div class='identity'><div><div class='identity-label'>A l'attention de</div><div class='identity-value'>" + escapeHtml(view.customerName) + "</div><div class='identity-copy'>" + escapeHtml(view.customerPhone) + "<br/>" + escapeHtml(view.customerEmail) + "</div></div>" +
    "<div><div class='identity-label'>Coordonnees de commande</div><div class='identity-value'>" + escapeHtml(view.paymentMethod) + "</div><div class='identity-copy'>" + escapeHtml(view.shippingAddress) + "</div></div></div>" +
    "<div class='table'><div class='table-head'><div>Qte</div><div>Piece</div><div style='text-align:right'>Montant</div></div><div class='table-rule'></div>" +
    view.articles.map((article) =>
      "<div class='table-row'><div class='qty'>" + article.quantity + "</div><div class='piece'>" + escapeHtml(article.title) + "</div><div class='amount'>" + escapeHtml(article.amountLabel) + "</div></div>"
    ).join("") +
    "</div>" +
    "<div class='financials'><div class='financial-copy'>" + escapeHtml(
      view.hasOutstanding
        ? "Le solde restant pourra etre regle selon les modalites convenues avec la Maison."
        : "Ce document confirme le reglement de votre commande couture."
    ) + "</div><div class='totals'>" +
    "<div class='totals-row'><div class='totals-label'>Sous-total</div><div class='totals-value'>" + escapeHtml(view.subtotalLabel) + "</div></div>" +
    (view.discountLabel ? "<div class='totals-row'><div class='totals-label'>Remise</div><div class='totals-value'>" + escapeHtml(view.discountLabel) + "</div></div>" : "") +
    "<div class='totals-row'><div class='totals-label'>Total</div><div class='totals-value'>" + escapeHtml(view.totalLabel) + "</div></div>" +
    "<div class='totals-row'><div class='totals-label'>Regle a ce jour</div><div class='totals-value'>" + escapeHtml(view.paidLabel) + "</div></div>" +
    "<div class='totals-rule'></div><div class='balance'><div class='balance-label'>Reste a payer</div><div class='balance-value'>" + escapeHtml(view.outstandingLabel) + "</div></div>" +
    "</div></div>" +
    "<div class='footer'>" + escapeHtml(view.tone.footer) + "</div>" +
    "</div></body></html>"
  );
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

function measureShowroomArticleHeight(doc: PDFKit.PDFDocument, title: string, width: number): number {
  doc.font("Helvetica-Bold").fontSize(13.5);
  const textHeight = doc.heightOfString(title, {
    width,
    lineGap: 0
  });
  return Math.max(mm(13), textHeight + mm(5.2));
}

function buildShowroomArticleChunks(
  doc: PDFKit.PDFDocument,
  articles: OrderArticle[],
  articleWidth: number,
  firstPageStartY: number,
  continuedPageStartY: number,
  pageBottomY: number,
  summaryReserve: number
): OrderArticle[][] {
  const chunks: OrderArticle[][] = [];
  let index = 0;

  while (index < articles.length) {
    const startY = chunks.length === 0 ? firstPageStartY : continuedPageStartY;
    const availableHeight = Math.max(mm(24), pageBottomY - startY);
    const chunk: OrderArticle[] = [];
    let usedHeight = 0;

    while (index < articles.length) {
      const article = articles[index];
      const rowHeight = measureShowroomArticleHeight(doc, textOr(article.title, "Pièce couture"), articleWidth) + mm(4.6);
      const reserve = index === articles.length - 1 ? summaryReserve : 0;
      const wouldOverflow = usedHeight + rowHeight + reserve > availableHeight;

      if (wouldOverflow && chunk.length > 0) break;

      chunk.push(article);
      usedHeight += rowHeight;
      index += 1;

      if (wouldOverflow) break;
    }

    chunks.push(chunk);
  }

  return chunks;
}

function drawShowroomPageHeader(
  doc: PDFKit.PDFDocument,
  order: OrderSnapshot,
  tone: DocumentTone,
  financials: FinancialSummary,
  continuation: boolean
): number {
  drawPageFrame(doc);

  const left = pageLeft(doc);
  const width = pageWidth(doc);
  const top = doc.page.margins.top;

  mutedLabel(doc, tone.overline, left, top - mm(1), width, "center");
  serifTitle(doc, "MAISON BOUCHRA FILALI LAHLOU", left, top + mm(5), width, continuation ? 20.5 : 22.5, "center");
  softText(
    doc,
    "Casablanca · contact@bouchrafilalilahlou.com · www.bouchrafilalilahlou.com",
    left,
    top + mm(12.8),
    width,
    "center"
  );
  drawHorizontalRule(doc, top + mm(19.8), COLORS.lineSoft);

  if (continuation) {
    mutedLabel(doc, "Référence", left, top + mm(24.5), width * 0.45);
    strongText(doc, textOr(order.name, "Non renseignée"), left, top + mm(28.6), width * 0.45, "left", 11);
    mutedLabel(doc, tone.title, left + width * 0.54, top + mm(24.5), width * 0.46, "right");
    return top + mm(36.5);
  }

  const heroTop = top + mm(28.2);
  const leftWidth = width * 0.57;
  const gap = mm(8);
  const rightWidth = width - leftWidth - gap;
  const rightX = left + leftWidth + gap;

  serifTitle(doc, tone.title, left, heroTop, leftWidth, 16.5);
  softText(doc, "Édité le " + formatDateTime(order.createdAt), left, heroTop + mm(5.8), leftWidth);

  mutedLabel(doc, "Référence", rightX, heroTop + mm(0.3), rightWidth);
  strongText(doc, textOr(order.name, "Non renseignée"), rightX, heroTop + mm(4), rightWidth, "left", 10.8);
  mutedLabel(doc, "Règlement", rightX, heroTop + mm(10.8), rightWidth);
  softText(doc, paymentStatusLabel(order), rightX, heroTop + mm(14.7), rightWidth);
  mutedLabel(doc, "Montant de la commande", rightX, heroTop + mm(21.2), rightWidth);
  strongText(doc, formatMoney(financials.total, order.currency || "MAD"), rightX, heroTop + mm(25.2), rightWidth, "left", 10.9);

  return heroTop + mm(36);
}

function drawShowroomIdentity(doc: PDFKit.PDFDocument, order: OrderSnapshot, startY: number): number {
  const left = pageLeft(doc);
  const width = pageWidth(doc);
  const gap = mm(12);
  const colW = (width - gap) / 2;
  const rightX = left + colW + gap;

  mutedLabel(doc, "À l'attention de", left, startY, colW);
  strongText(doc, textOr(order.customerLabel, "Cliente non renseignée"), left, startY + mm(3.8), colW, "left", 10.8);
  softText(doc, textOr(order.customerPhone, "Téléphone non renseigné"), left, startY + mm(9.1), colW);
  softText(doc, textOr(order.customerEmail, "E-mail non renseigné"), left, startY + mm(14.1), colW);

  mutedLabel(doc, "Coordonnées de commande", rightX, startY, colW);
  strongText(doc, paymentMethodLabel(order), rightX, startY + mm(3.8), colW, "left", 10.8);
  softText(doc, textOr(order.shippingAddress, "Adresse de livraison non renseignée"), rightX, startY + mm(9.1), colW);

  return startY + mm(24.5);
}

function drawShowroomTableHeader(doc: PDFKit.PDFDocument, startY: number): { nextY: number; articleWidth: number; amountW: number; qtyW: number } {
  const left = pageLeft(doc);
  const width = pageWidth(doc);
  const right = pageRight(doc);
  const qtyW = mm(15);
  const amountW = mm(48);
  const articleX = left + qtyW + mm(7);
  const articleWidth = width - qtyW - amountW - mm(12);

  mutedLabel(doc, "Qté", left, startY, qtyW);
  mutedLabel(doc, "Pièce", articleX, startY, articleWidth);
  mutedLabel(doc, "Montant", right - amountW, startY, amountW, "right");
  drawHorizontalRule(doc, startY + mm(5.8), COLORS.line);

  return { nextY: startY + mm(10.2), articleWidth, amountW, qtyW };
}

function drawShowroomArticles(
  doc: PDFKit.PDFDocument,
  articles: OrderArticle[],
  startY: number,
  currency: string
): number {
  const left = pageLeft(doc);
  const right = pageRight(doc);
  const width = pageWidth(doc);
  const qtyW = mm(15);
  const amountW = mm(48);
  const articleX = left + qtyW + mm(7);
  const articleWidth = width - qtyW - amountW - mm(12);
  let y = startY;

  for (const article of articles) {
    const title = textOr(article.title, "Pièce couture");
    const rowHeight = measureShowroomArticleHeight(doc, title, articleWidth);

    doc.fillColor(COLORS.muted).font("Helvetica").fontSize(10.5).text(String(Math.max(0, toNumber(article.quantity))), left, y + mm(0.8), {
      width: qtyW
    });
    doc.fillColor(COLORS.ink).font("Helvetica-Bold").fontSize(13.5).text(title, articleX, y, {
      width: articleWidth,
      lineGap: 0
    });
    doc.fillColor(COLORS.softInk).font("Helvetica").fontSize(12.8).text(formatMoney(lineTotal(article), currency), right - amountW, y + mm(0.2), {
      width: amountW,
      align: "right",
      lineGap: 0
    });

    y += rowHeight;
    drawHorizontalRule(doc, y + mm(0.6), COLORS.lineSoft);
    y += mm(4);
  }

  return y;
}

function drawShowroomSummary(
  doc: PDFKit.PDFDocument,
  order: OrderSnapshot,
  financials: FinancialSummary,
  startY: number
): number {
  const left = pageLeft(doc);
  const right = pageRight(doc);
  const width = pageWidth(doc);
  const copyWidth = width * 0.54;
  const summaryX = left + width * 0.63;
  const labelW = mm(38);
  const amountW = right - summaryX - labelW;
  let y = startY;

  doc.fillColor(COLORS.muted).font("Helvetica").fontSize(10.6).text(
    financials.outstanding > 0
      ? "Le solde restant pourra être réglé selon les modalités convenues avec la Maison."
      : "Ce document confirme le règlement de votre commande couture.",
    left,
    y + mm(0.5),
    {
      width: copyWidth,
      lineGap: 1.5
    }
  );

  mutedLabel(doc, "Sous-total", summaryX, y, labelW);
  strongText(doc, formatMoney(financials.subtotal, order.currency || "MAD"), summaryX + labelW, y - mm(0.4), amountW, "right", 11.2);
  y += mm(6.4);

  if (financials.discount > 0) {
    mutedLabel(doc, "Remise", summaryX, y, labelW);
    softText(doc, formatMoney(-financials.discount, order.currency || "MAD"), summaryX + labelW, y - mm(0.2), amountW, "right");
    y += mm(6.2);
  }

  mutedLabel(doc, "Total", summaryX, y, labelW);
  strongText(doc, formatMoney(financials.total, order.currency || "MAD"), summaryX + labelW, y - mm(0.4), amountW, "right", 11.2);
  y += mm(6.2);

  mutedLabel(doc, "Réglé à ce jour", summaryX, y, labelW);
  softText(doc, formatMoney(financials.paid, order.currency || "MAD"), summaryX + labelW, y - mm(0.2), amountW, "right");
  y += mm(7);

  drawHorizontalRule(doc, y - mm(1), COLORS.lineSoft);
  doc.fillColor(COLORS.accent).font("Times-Bold").fontSize(16).text("Reste à payer", summaryX, y + mm(1.6), {
    width: labelW + mm(22)
  });
  doc.fillColor(COLORS.accent).font("Helvetica-Bold").fontSize(15.2).text(
    financials.outstanding > 0 ? formatMoney(financials.outstanding, order.currency || "MAD") : "-",
    summaryX + labelW,
    y + mm(1.1),
    { width: amountW, align: "right" }
  );

  return y + mm(14);
}

function drawShowroomFooter(doc: PDFKit.PDFDocument, tone: DocumentTone, y: number): void {
  drawHorizontalRule(doc, y, COLORS.lineSoft);
  serifTitle(doc, tone.footer, pageLeft(doc), y + mm(6.5), pageWidth(doc), 12.6, "center");
}

export async function renderHtmlToPdfBuffer(html: string): Promise<Buffer> {
  const puppeteerModule = await import("puppeteer");
  const puppeteer = puppeteerModule.default;
  const localMacChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH
    || (process.platform === "darwin" && existsSync(localMacChrome) ? localMacChrome : undefined);
  const browser = await puppeteer.launch({
    headless: true,
    executablePath,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--font-render-hinting=medium"]
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1810, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    await page.emulateMediaType("screen");
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      margin: {
        top: "0",
        right: "0",
        bottom: "0",
        left: "0"
      }
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}

async function renderShowroomReceiptPdf(doc: PDFKit.PDFDocument, order: OrderSnapshot): Promise<void> {
  const tone = toneForTemplate("showroom_receipt");
  const financials = computeFinancialSummary(order);
  const articles = Array.isArray(order.articles) && order.articles.length > 0
    ? order.articles
    : [{ id: "empty", title: "Aucune pièce ajoutée", quantity: 0, unitPrice: 0, status: "pending" as const }];

  const left = pageLeft(doc);
  const width = pageWidth(doc);
  const qtyW = mm(15);
  const amountW = mm(48);
  const articleWidth = width - qtyW - amountW - mm(12);
  const pageBottomY = doc.page.height - doc.page.margins.bottom - mm(10);
  const summaryReserve = mm(50);
  const top = doc.page.margins.top;
  const firstPageStartY = top + mm(109.4);
  const continuedHeaderTopY = top + mm(41.5);
  const continuedPageStartY = top + mm(51.7);

  const firstHeaderBottom = drawShowroomPageHeader(doc, order, tone, financials, false);
  const firstIdentityBottom = drawShowroomIdentity(doc, order, firstHeaderBottom + mm(6.5));
  drawShowroomTableHeader(doc, firstIdentityBottom + mm(4));

  const chunks = buildShowroomArticleChunks(
    doc,
    articles,
    articleWidth,
    firstPageStartY,
    continuedPageStartY,
    pageBottomY,
    summaryReserve
  );

  for (let pageIndex = 0; pageIndex < chunks.length; pageIndex += 1) {
    if (pageIndex > 0) {
      doc.addPage();
      drawShowroomPageHeader(doc, order, tone, financials, true);
      drawShowroomTableHeader(doc, continuedHeaderTopY);
    }

    const rowStart = pageIndex === 0 ? firstPageStartY : continuedPageStartY;
    const rowsBottomY = drawShowroomArticles(doc, chunks[pageIndex], rowStart, order.currency || "MAD");

    if (pageIndex === chunks.length - 1) {
      const summaryBottomY = drawShowroomSummary(doc, order, financials, rowsBottomY + mm(6.5));
      drawShowroomFooter(doc, tone, Math.max(summaryBottomY + mm(8), doc.page.height - doc.page.margins.bottom - mm(15)));
    }
  }
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
  softText(doc, "Édité le " + formatDateTime(order.createdAt), left, metaTop + mm(7), widthLeft);

  mutedLabel(doc, "Référence", rightX, metaTop, widthRight);
  strongText(doc, textOr(order.name, "Non renseignée"), rightX, metaTop + mm(4.2), widthRight);
  mutedLabel(doc, "Règlement", rightX, metaTop + mm(13), widthRight);
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

  mutedLabel(doc, "À l'attention de", left, y, colW);
  strongText(doc, textOr(order.customerLabel, "Cliente non renseignée"), left, y + mm(4.2), colW, "left", 11.2);
  softText(doc, textOr(order.customerPhone, "Téléphone non renseigné"), left, y + mm(10), colW);
  softText(doc, textOr(order.customerEmail, "E-mail non renseigné"), left, y + mm(15.5), colW);

  mutedLabel(doc, "Coordonnées de commande", left + colW + gap, y, colW);
  strongText(doc, paymentMethodLabel(order), left + colW + gap, y + mm(4.2), colW, "left", 11.2);
  softText(doc, textOr(order.shippingAddress, "Adresse de livraison non renseignée"), left + colW + gap, y + mm(10), colW);

  doc.y = y + mm(27);
}

function drawTableHeader(doc: PDFKit.PDFDocument): void {
  const left = pageLeft(doc);
  const right = pageRight(doc);
  const width = pageWidth(doc);
  const qtyW = mm(16);
  const amountW = mm(50);
  const articleX = left + qtyW + mm(6);
  const articleW = width - qtyW - amountW - mm(10);
  const top = doc.y;

  mutedLabel(doc, "Qté", left, top, qtyW);
  mutedLabel(doc, "Pièce", articleX, top, articleW);
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
  const amountW = mm(50);
  const articleX = left + qtyW + mm(6);
  const articleW = width - qtyW - amountW - mm(10);
  const title = textOr(article.title, "Pièce couture");
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
    const projectedHeight = Math.max(mm(18), articleTextHeight(doc, textOr(article.title, "Pièce couture"), pageWidth(doc) - mm(64)) + mm(10));
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

  mutedLabel(doc, "Total", x, y, labelW);
  strongText(doc, formatMoney(financials.total, order.currency || "MAD"), x + labelW, y, amountW, "right", 10.9);
  y += mm(6.5);

  mutedLabel(doc, "Réglé à ce jour", x, y, labelW);
  softText(doc, formatMoney(financials.paid, order.currency || "MAD"), x + labelW, y, amountW, "right");
  y += mm(7.3);

  doc.strokeColor(COLORS.lineSoft).lineWidth(0.6).moveTo(x, y - mm(1.5)).lineTo(right, y - mm(1.5)).stroke();
  doc.fillColor(COLORS.accent).font("Times-Bold").fontSize(12.8).text("Reste à payer", x, y, {
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

function addPageFooters(doc: PDFKit.PDFDocument, templateChoice: string): void {
  if (templateChoice === "showroom_receipt") return;

  const range = doc.bufferedPageRange();
  for (let index = 0; index < range.count; index += 1) {
    doc.switchToPage(range.start + index);
    const left = pageLeft(doc);
    const right = pageRight(doc);
    const y = doc.page.height - mm(11);
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
  if (templateChoice === "showroom_receipt") {
    await renderShowroomReceiptPdf(doc, order);
    return;
  }

  const tone = toneForTemplate(templateChoice);
  const financials = computeFinancialSummary(order);

  drawHeader(doc, order, tone, financials);
  drawIdentityColumns(doc, order);
  drawArticles(doc, order, tone, financials);
  drawFinancialSummary(doc, order, tone, financials);
  drawFooterNote(doc, tone);
  addPageFooters(doc, templateChoice);
}

export async function buildOrderInvoicePdf(order: OrderSnapshot, templateChoice: string): Promise<Buffer> {
  if (templateChoice === "showroom_receipt") {
    const html = buildOrderInvoiceHtml(order, templateChoice);
    if (!html) {
      throw new Error("HTML showroom introuvable.");
    }
    return await renderHtmlToPdfBuffer(html);
  }

  const tone = toneForTemplate(templateChoice);
  const doc = new PDFDocument({
    size: "A4",
    margins: {
      top: mm(RECEIPT_PDF_MARGINS_MM.top),
      left: mm(RECEIPT_PDF_MARGINS_MM.left),
      right: mm(RECEIPT_PDF_MARGINS_MM.right),
      bottom: mm(RECEIPT_PDF_MARGINS_MM.bottom)
    },
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
