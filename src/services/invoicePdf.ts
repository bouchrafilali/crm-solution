import PDFDocument from "pdfkit";
import type { OrderSnapshot } from "./orderSnapshots.js";
const BFL_LOGO_URL = "https://cdn.shopify.com/s/files/1/0551/5558/9305/files/logoo.svg?v=1727895516";
const BFL_LOGO_FALLBACK_URL = "https://cdn.shopify.com/s/files/1/0551/5558/9305/files/loooogoooo.png?v=1727896750";
const PT_PER_MM = 72 / 25.4;

function mm(value: number): number {
  return value * PT_PER_MM;
}

function paymentStatusLabel(order: OrderSnapshot): string {
  const status = String(order.financialStatus || "").toLowerCase();
  if (status === "paid" || Number(order.outstandingAmount || 0) <= 0) return "Paid";
  if (status === "partially_paid") return "Partially Paid";
  return "Pending";
}

function paymentStatusFr(order: OrderSnapshot): string {
  const status = String(order.financialStatus || "").toLowerCase();
  if (status === "paid" || Number(order.outstandingAmount || 0) <= 0) return "Payée";
  if (status === "partially_paid") return "Partiellement payée";
  return "Paiement en attente";
}

function formatMoney(value: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency || "MAD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(Number(value || 0));
}

function invoiceTitle(template: string): string {
  if (template === "coin") return "Coin de Couture Invoice";
  if (template === "showroom_receipt") return "Showroom Receipt";
  if (template === "international_invoice") return "International Couture Invoice";
  return "Invoice";
}

function drawCard(
  doc: PDFKit.PDFDocument,
  x: number,
  y: number,
  width: number,
  height: number,
  title: string,
  lines: string[]
): void {
  doc.roundedRect(x, y, width, height, 8).lineWidth(1).strokeColor("#e6e6e6").stroke();
  doc.fillColor("#1f1f1f").font("Helvetica-Bold").fontSize(10).text(title, x + 10, y + 10, { width: width - 20 });
  let cy = y + 30;
  doc.font("Helvetica").fontSize(9.5).fillColor("#2a2a2a");
  lines.forEach((line) => {
    if (!line) {
      cy += 6;
      return;
    }
    doc.text(line, x + 10, cy, { width: width - 20 });
    cy = doc.y + 2;
  });
}

async function loadRemoteImageBuffer(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  } catch {
    return null;
  }
}

async function drawClassicPdf(doc: PDFKit.PDFDocument, order: OrderSnapshot): Promise<void> {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const contentWidth = right - left;
  const top = doc.page.margins.top;

  doc.font("Helvetica").fillColor("#212121");
  const logoCandidates = [BFL_LOGO_URL, BFL_LOGO_FALLBACK_URL];
  const logoW = mm(52);
  const logoH = mm(10);
  let logoDrawn = false;
  for (const candidate of logoCandidates) {
    const logoBuffer = await loadRemoteImageBuffer(candidate);
    if (!logoBuffer) continue;
    try {
      doc.image(logoBuffer, left, top + mm(0.5), { fit: [logoW, logoH], valign: "center" });
      logoDrawn = true;
      break;
    } catch {
      // Try next candidate (SVG can fail depending on renderer support).
    }
  }
  if (!logoDrawn) {
    doc.fontSize(11).fillColor("#b88b53").text("BOUCHRA FILALI LAHLOU", left, top + mm(1.5));
  }
  doc.fillColor("#3f4348").font("Helvetica-Bold").fontSize(13).text("Bouchra Filali Lahlou", left + mm(44), top + mm(0.8));
  doc.fillColor("#3f4348").font("Helvetica").fontSize(10).text("www.bouchrafilalilahlou.com", left + mm(44), top + mm(8));
  doc.font("Helvetica-Bold").fontSize(20).fillColor("#1b1b1b").text("Facture", left, top + mm(18));

  const createdAt = new Date(order.createdAt);
  const createdLabel = Number.isNaN(createdAt.getTime())
    ? String(order.createdAt || "")
    : createdAt.toLocaleString("fr-FR", { dateStyle: "long", timeStyle: "short" });

  const badgeW = mm(24);
  const badgeH = mm(20);
  const badgeX = right - badgeW;
  doc.roundedRect(badgeX, top, badgeW, badgeH, mm(2.5)).fillAndStroke("#f5f5f5", "#e1e1e1");
  doc.fillColor("#5c5c5c").font("Helvetica").fontSize(10).text("Facture", badgeX + mm(3.2), top + mm(2.8));
  doc.fillColor("#1f1f1f").font("Helvetica-Bold").fontSize(14).text(order.name, badgeX + mm(3.2), top + mm(9.2));
  doc.fillColor("#3d3d3d")
    .font("Helvetica")
    .fontSize(11)
    .text(`Statut : ${paymentStatusFr(order)}`, right - mm(48), top + mm(24), { width: mm(48), align: "right" });
  doc.fillColor("#3d3d3d").font("Helvetica").fontSize(11).text(createdLabel, right - mm(48), top + mm(30), { width: mm(48), align: "right" });

  const cardY = top + mm(43);
  const gap = mm(3.5);
  const cardW = (contentWidth - gap * 3) / 4;
  const cardH = mm(44);

  drawCard(doc, left, cardY, cardW, cardH, "De", [
    "www.bouchrafilalilahlou.com",
    "19/21 Rond-point des Sports",
    "Casablanca, 20250"
  ]);
  drawCard(doc, left + cardW + gap, cardY, cardW, cardH, "Client", [
    order.customerLabel || "-",
    order.customerPhone || "-",
    order.customerEmail || ""
  ]);
  drawCard(doc, left + (cardW + gap) * 2, cardY, cardW, cardH, "Adresse de Facturation", [
    " ",
    order.billingAddress || "Aucune adresse de facturation renseignée"
  ]);
  drawCard(doc, left + (cardW + gap) * 3, cardY, cardW, cardH, "Adresse de Livraison", [
    order.shippingAddress || "Aucune adresse de livraison renseignée"
  ]);

  let y = cardY + cardH + mm(7);
  doc.moveTo(left, y).lineTo(right, y).lineWidth(1).strokeColor("#ececec").stroke();
  y += mm(4);

  const headerTop = y - mm(1.2);
  const headerHeight = mm(9.2);
  doc.rect(left, headerTop, contentWidth, headerHeight).fill("#f5f5f5");
  const headerTextY = headerTop + mm(2.3);
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#666").text("Qté", left + 8, headerTextY);
  doc.text("Article", left + 70, headerTextY);
  doc.text("Prix", right - 120, headerTextY, { width: 100, align: "right" });
  doc.moveTo(left, headerTop + headerHeight).lineTo(right, headerTop + headerHeight).lineWidth(1).strokeColor("#ececec").stroke();
  y = headerTop + headerHeight + mm(3.1);

  doc.font("Helvetica").fontSize(10.5).fillColor("#222");
  order.articles.forEach((article) => {
    const amount = Number(article.unitPrice || 0) * Number(article.quantity || 0);
    doc.text(String(article.quantity), left + 8, y, { width: 48 });
    doc.font("Helvetica-Bold").text(article.title, left + 70, y, { width: contentWidth - 200 });
    doc.font("Helvetica-Bold").text(formatMoney(amount, order.currency), right - 120, y, { width: 100, align: "right" });
    y += mm(6);
    doc.moveTo(left, y).lineTo(right, y).lineWidth(1).strokeColor("#f0f0f0").stroke();
    y += mm(3);
    doc.font("Helvetica");
  });

  const subtotal = Number(order.totalAmount || 0);
  const paid = Math.max(0, subtotal - Number(order.outstandingAmount || 0));
  const outstanding = Number(order.outstandingAmount || 0);

  const labelX = right - 220;
  const valueX = right - 120;
  doc.font("Helvetica").fontSize(10).fillColor("#333");
  doc.text("Sous-total", labelX, y, { width: 100, align: "right" });
  doc.font("Helvetica-Bold").text(formatMoney(subtotal, order.currency), valueX, y, { width: 100, align: "right" });
  y += mm(6.8);
  doc.font("Helvetica-Bold").fontSize(11).text("Total", labelX, y, { width: 100, align: "right" });
  doc.text(formatMoney(subtotal, order.currency), valueX, y, { width: 100, align: "right" });
  y += mm(6.8);
  doc.font("Helvetica").fontSize(10).text("Total payé", labelX, y, { width: 100, align: "right" });
  doc.font("Helvetica-Bold").text(formatMoney(paid, order.currency), valueX, y, { width: 100, align: "right" });

  if (outstanding > 0) {
    y += mm(6.8);
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#b41c18").text("Montant impayé", labelX, y, {
      width: 100,
      align: "right"
    });
    doc.text(formatMoney(outstanding, order.currency), valueX, y, { width: 100, align: "right" });
    doc.fillColor("#222");
  }

  if (outstanding > 0) {
    y += mm(9.8);
    doc
      .roundedRect(left, y, contentWidth, mm(24), mm(2.8))
      .lineWidth(1)
      .dash(2, { space: 2 })
      .strokeColor("#dddddd")
      .stroke()
      .undash();
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#1f1f1f").text("Coordonnées Bancaires", left + 10, y + 10);
    doc.font("Helvetica").fontSize(10).fillColor("#666");
    if (order.bankDetails && Object.values(order.bankDetails).some(Boolean)) {
      const lines = [
        order.bankDetails.beneficiaryName ? `Bénéficiaire: ${order.bankDetails.beneficiaryName}` : "",
        order.bankDetails.bankName ? `Banque: ${order.bankDetails.bankName}` : "",
        order.bankDetails.accountNumber ? `Compte: ${order.bankDetails.accountNumber}` : "",
        order.bankDetails.swiftBic ? `SWIFT/BIC: ${order.bankDetails.swiftBic}` : "",
        order.bankDetails.routingNumber ? `Code: ${order.bankDetails.routingNumber}` : "",
        order.bankDetails.paymentReference ? `Référence: ${order.bankDetails.paymentReference}` : ""
      ].filter(Boolean);
      doc.text(lines.join(" · "), left + 10, y + 30, { width: contentWidth - 20 });
    } else {
      doc.text("Aucune coordonnée bancaire renseignée.", left + 10, y + 30);
    }
    y += mm(28);
  } else {
    y += mm(8.2);
    const boxGap = mm(4.5);
    const boxW = (contentWidth - boxGap) / 2;
    const boxH = mm(36);

    doc.roundedRect(left, y, boxW, boxH, 8).lineWidth(1).strokeColor("#d7e9e0").fillAndStroke("#edf8f2", "#d7e9e0");
    doc.fillColor("#128a4a").font("Helvetica-Bold").fontSize(11).text("Paiement reçu", left + 12, y + 12);
    doc.fillColor("#1f1f1f").font("Helvetica").fontSize(10);
    doc.text("Montant réglé : ", left + 12, y + 36, { continued: true });
    doc.font("Helvetica-Bold").text(formatMoney(paid, order.currency));
    doc.font("Helvetica").text("Statut financier : ", left + 12, y + 54, { continued: true });
    doc.font("Helvetica-Bold").text(paymentStatusFr(order));
    doc.font("Helvetica").text("Méthode : ", left + 12, y + 72, { continued: true });
    doc.font("Helvetica-Bold").text(order.paymentGateway || "manual");

    const box2X = left + boxW + boxGap;
    doc.roundedRect(box2X, y, boxW, boxH, 8).lineWidth(1).strokeColor("#e6e6e6").stroke();
    doc.fillColor("#1f1f1f").font("Helvetica-Bold").fontSize(11).text("Récapitulatif des paiements", box2X + 12, y + 12);
    const headY = y + mm(13.8);
    doc.roundedRect(box2X + 12, headY, boxW - 24, 24, 0).fill("#f5f5f5");
    const col1X = box2X + 18;
    const col2X = box2X + boxW - 160;
    const col3X = box2X + boxW - 78;
    doc.fillColor("#666").font("Helvetica-Bold").fontSize(9.5);
    doc.text("Paiement", col1X, headY + 7, { width: col2X - col1X - 12 });
    doc.text("Montant", col2X, headY + 7, { width: 72, align: "right" });
    doc.text("Statut", col3X, headY + 7, { width: 62, align: "right" });
    doc.fillColor("#1f1f1f").font("Helvetica").fontSize(10);
    doc.text("Paiement", col1X, headY + 32, { width: col2X - col1X - 12 });
    doc.text(formatMoney(paid, order.currency), col2X, headY + 32, { width: 72, align: "right" });
    doc.text("Success", col3X, headY + 32, { width: 62, align: "right" });

    y += boxH + mm(5.2);
  }

  doc.roundedRect(left, y, contentWidth, mm(25), mm(2.8)).lineWidth(1).strokeColor("#e6e6e6").stroke();
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#1f1f1f").text("Merci pour votre confiance.", left + 10, y + 12);
  doc
    .font("Helvetica")
    .fontSize(10)
    .fillColor("#444")
    .text(
      "Chaque pièce est confectionnée sur mesure avec le plus grand soin. Si vous avez des questions concernant cette facture ou votre commande, n’hésitez pas à nous contacter.",
      left + 10,
      y + 30,
      { width: contentWidth - 20 }
    );

  doc.fillColor("#666").font("Helvetica").fontSize(10).text("Document généré par www.bouchrafilalilahlou.com", left, y + mm(30.5));
}

export async function buildOrderInvoicePdf(order: OrderSnapshot, templateChoice: string): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: mm(12), left: mm(12), right: mm(12), bottom: mm(12) },
    info: {
      Title: `${invoiceTitle(templateChoice)} ${order.name}`,
      Author: "Maison Bouchra Filali Lahlou",
      Subject: "Order invoice"
    }
  });

  const chunks: Buffer[] = [];
  doc.on("data", (chunk) => chunks.push(Buffer.from(chunk)));

  if (templateChoice === "classic") {
    await drawClassicPdf(doc, order);
  } else {
    doc.fontSize(20).font("Helvetica-Bold").text(templateChoice === "coin" ? "COIN DE COUTURE" : "MAISON BOUCHRA FILALI LAHLOU");
    doc.moveDown(0.2);
    doc
      .fontSize(10)
      .fillColor("#666666")
      .font("Helvetica")
      .text(
        templateChoice === "coin"
          ? "Casablanca · ICE 002031076000092 · RC 401313 · contact@bouchrafilalilahlou.com"
          : "Casablanca, Morocco · contact@bouchrafilalilahlou.com · www.bouchrafilalilahlou.com"
      )
      .fillColor("#111111");
    doc.moveDown(1.2);
    doc.fontSize(14).font("Helvetica-Bold").text(invoiceTitle(templateChoice).toUpperCase());
    doc.moveDown(0.8);
    doc.font("Helvetica").fontSize(10).text(`Order: ${order.name}`);
    doc.text(`Payment Status: ${paymentStatusLabel(order)}`);
    doc.text(`Client: ${order.customerLabel || "-"}`);
    doc.moveDown(0.8);
    order.articles.forEach((article) => {
      const amount = Number(article.unitPrice || 0) * Number(article.quantity || 0);
      doc.text(`${article.quantity} x ${article.title} — ${formatMoney(amount, order.currency)}`);
    });
    doc.moveDown(0.8);
    doc.font("Helvetica-Bold").text(`Total: ${formatMoney(order.totalAmount || 0, order.currency)}`);
    if (Number(order.outstandingAmount || 0) > 0) {
      doc.text(`Outstanding: ${formatMoney(order.outstandingAmount || 0, order.currency)}`);
    }
  }

  const bufferPromise = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  doc.end();
  return await bufferPromise;
}
