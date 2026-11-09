import type { Response } from "express";
import PDFDocument from "pdfkit";
import mongoose from "mongoose";
import Payment, { type IPayment } from "./payment.model.js";
import Workspace from "../workspace/workspace.model.js";

// Safe constructor resolution across ESM / CJS bundlers
const PDFDocConstructor =
  (PDFDocument as unknown as { default?: typeof PDFDocument }).default ||
  PDFDocument;

/**
 * Format date in English (e.g., 08 Nov 2026)
 */
function formatDate(date?: Date | string | null): string {
  if (!date) return "N/A";
  const d = new Date(date);
  if (isNaN(d.getTime())) return "N/A";
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

/**
 * Format currency amount in BDT with commas and 2 decimals
 */
function formatBDT(amount: number): string {
  return `BDT ${amount.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Draw payment money receipt layout on a PDFKit document
 */
export function renderPaymentReceiptLayout(
  doc: InstanceType<typeof PDFDocument>,
  payment: IPayment,
  workspaceName: string,
): void {
  const margin = 40;
  const pageWidth = 595.28;
  const contentWidth = pageWidth - margin * 2;

  // --- 1. HEADER SECTION ---
  // Top brand bar
  doc.rect(margin, margin, contentWidth, 4).fill("#059669");

  // Company Letterhead (Left)
  doc
    .font("Helvetica-Bold")
    .fontSize(22)
    .fillColor("#0F172A")
    .text("CYBER7", margin, margin + 14);

  doc
    .font("Helvetica")
    .fontSize(10)
    .fillColor("#059669")
    .text("OFFICIAL PAYMENT RECEIPT", margin, margin + 40);

  doc
    .font("Helvetica")
    .fontSize(8.5)
    .fillColor("#64748B")
    .text("Cyber7 Bangladesh Ltd.", margin, margin + 56)
    .text("Level 14, BDBL Bhaban, Karwan Bazar, Dhaka-1215", margin, margin + 68)
    .text("Accounts & Treasury: billing@vexchat.com", margin, margin + 80);

  // Receipt Identifier & Badge (Right)
  const receiptNum = `REC-${payment.invoiceNumber || String(payment._id).substring(0, 8).toUpperCase()}`;

  doc
    .font("Helvetica-Bold")
    .fontSize(20)
    .fillColor("#0F172A")
    .text("MONEY RECEIPT", margin + 280, margin + 14, { width: contentWidth - 280, align: "right" });

  doc
    .font("Helvetica-Bold")
    .fontSize(9.5)
    .fillColor("#64748B")
    .text(`RECEIPT NO: ${receiptNum}`, margin + 280, margin + 42, {
      width: contentWidth - 280,
      align: "right",
    });

  // Green COMPLETED status badge
  const badgeWidth = 90;
  const badgeHeight = 18;
  const badgeX = margin + contentWidth - badgeWidth;
  const badgeY = margin + 60;
  doc
    .roundedRect(badgeX, badgeY, badgeWidth, badgeHeight, 3)
    .fill("#059669");

  doc
    .font("Helvetica-Bold")
    .fontSize(8.5)
    .fillColor("#FFFFFF")
    .text("PAID & VERIFIED", badgeX, badgeY + 4, {
      width: badgeWidth,
      align: "center",
    });

  doc
    .font("Helvetica")
    .fontSize(8.5)
    .fillColor("#64748B")
    .text(`Payment Date: ${formatDate(payment.completedAt || payment.createdAt)}`, margin + 250, margin + 82, {
      width: contentWidth - 250,
      align: "right",
    });

  // --- 2. DIVIDER LINE ---
  const dividerY = margin + 104;
  doc
    .strokeColor("#E2E8F0")
    .lineWidth(1)
    .moveTo(margin, dividerY)
    .lineTo(margin + contentWidth, dividerY)
    .stroke();

  // --- 3. RECEIVED FROM & CHANNEL DETAILS ---
  const infoY = dividerY + 12;

  // Left Column: Received From
  doc
    .font("Helvetica-Bold")
    .fontSize(9)
    .fillColor("#059669")
    .text("RECEIVED FROM:", margin, infoY);

  doc
    .font("Helvetica-Bold")
    .fontSize(11)
    .fillColor("#0F172A")
    .text(workspaceName, margin, infoY + 14);

  doc
    .font("Helvetica")
    .fontSize(8.5)
    .fillColor("#475569")
    .text(`Associated Invoice: ${payment.invoiceNumber || "N/A"}`, margin, infoY + 30)
    .text(`Subscription Plan: ${payment.planName} (${payment.planCode})`, margin, infoY + 44);

  // Right Column: Channel & Transaction Details
  const rightColX = margin + 280;
  doc
    .font("Helvetica-Bold")
    .fontSize(9)
    .fillColor("#059669")
    .text("TRANSACTION DETAILS:", rightColX, infoY);

  const trxRef =
    payment.gatewayData?.trxID ||
    payment.gatewayData?.bankTransfer?.referenceNumber ||
    "SYSTEM-CONFIRMED";

  doc
    .font("Helvetica")
    .fontSize(8.5)
    .fillColor("#475569")
    .text(`Payment Channel: ${payment.paymentMethod}`, rightColX, infoY + 14)
    .text(`Transaction Reference: ${trxRef}`, rightColX, infoY + 28);

  if (payment.gatewayData?.bankTransfer?.bankName) {
    doc.text(
      `Bank: ${payment.gatewayData.bankTransfer.bankName} (${payment.gatewayData.bankTransfer.branchName || "Main Branch"})`,
      rightColX,
      infoY + 42,
    );
  } else {
    doc.text(`Payment ID: ${payment._id}`, rightColX, infoY + 42);
  }

  // --- 4. RECEIPT STATEMENT BOX ---
  const receiptBoxY = infoY + 68;
  doc
    .roundedRect(margin, receiptBoxY, contentWidth, 80, 4)
    .fill("#F0FDF4");

  doc
    .strokeColor("#BBF7D0")
    .lineWidth(1)
    .roundedRect(margin, receiptBoxY, contentWidth, 80, 4)
    .stroke();

  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor("#166534")
    .text("Amount Received in Words / Value:", margin + 16, receiptBoxY + 14);

  doc
    .font("Helvetica-Bold")
    .fontSize(22)
    .fillColor("#0F172A")
    .text(formatBDT(payment.amount), margin + 16, receiptBoxY + 30);

  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor("#15803D")
    .text(
      `Received in full for SaaS subscription renewal and platform licensing services. Non-refundable except under terms of service.`,
      margin + 16,
      receiptBoxY + 58,
      { width: contentWidth - 32 },
    );

  // --- 5. VERIFICATION & AUDIT STAMP ---
  const stampBoxY = receiptBoxY + 96;

  doc
    .roundedRect(margin, stampBoxY, contentWidth, 85, 4)
    .fill("#F8FAFC");

  doc
    .strokeColor("#E2E8F0")
    .lineWidth(1)
    .roundedRect(margin, stampBoxY, contentWidth, 85, 4)
    .stroke();

  doc
    .font("Helvetica-Bold")
    .fontSize(8.5)
    .fillColor("#059669")
    .text("OFFICIAL SETTLEMENT RECORD & VERIFICATION", margin + 16, stampBoxY + 12);

  const verifiedDate = formatDate(payment.gatewayData?.bankTransfer?.verifiedAt || payment.completedAt);
  const verifiedByText = payment.gatewayData?.bankTransfer?.verifiedBy
    ? `Admin ID: ${payment.gatewayData.bankTransfer.verifiedBy}`
    : "Automated Gateway Reconciliation";

  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor("#475569")
    .text(`Verified By: ${verifiedByText}`, margin + 16, stampBoxY + 28)
    .text(`Reconciliation Timestamp: ${verifiedDate}`, margin + 16, stampBoxY + 40)
    .text(`Idempotency Hash: ${payment.idempotencyKey || "N/A"}`, margin + 16, stampBoxY + 52)
    .text("This receipt constitutes official acknowledgment of fund receipt by Cyber7 Bangladesh Ltd.", margin + 16, stampBoxY + 66);

  // --- 6. FOOTER ---
  const footerY = 770;
  doc
    .strokeColor("#E2E8F0")
    .lineWidth(0.5)
    .moveTo(margin, footerY)
    .lineTo(margin + contentWidth, footerY)
    .stroke();

  doc
    .font("Helvetica")
    .fontSize(7.5)
    .fillColor("#94A3B8")
    .text(
      "Cyber7 SaaS Financial Services • Thank you for your business • https://vexchat.com",
      margin,
      footerY + 8,
      { width: contentWidth, align: "center" },
    );
}

/**
 * Fetch payment by id or transaction reference
 */
export async function getCompletedPayment(
  paymentId: string,
): Promise<{ payment: IPayment; workspaceName: string }> {
  let query: Record<string, unknown> = { _id: paymentId };
  if (!mongoose.Types.ObjectId.isValid(paymentId)) {
    query = {
      $or: [
        { invoiceNumber: paymentId },
        { "gatewayData.trxID": paymentId },
        { idempotencyKey: paymentId },
      ],
    };
  }

  const payment = await Payment.findOne(query);
  if (!payment) {
    throw new Error(`Payment '${paymentId}' not found.`);
  }

  if (payment.status !== "COMPLETED") {
    throw new Error(
      `Payment receipt is only available for COMPLETED payments (current status: ${payment.status}).`,
    );
  }

  let workspaceName = "VexChat Customer";
  if (payment.workspaceId) {
    const workspace = await Workspace.findById(payment.workspaceId);
    if (workspace?.name) {
      workspaceName = workspace.name;
    }
  }

  return { payment, workspaceName };
}

/**
 * Stream payment receipt directly to Express response
 */
export async function streamPaymentReceiptPdf(
  paymentId: string,
  res: Response,
): Promise<void> {
  const { payment, workspaceName } = await getCompletedPayment(paymentId);

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `inline; filename="Receipt-${payment.invoiceNumber || payment._id}.pdf"`,
  );

  const doc = new PDFDocConstructor({ margin: 40, size: "A4" });

  res.on("close", () => {
    doc.destroy();
  });

  doc.pipe(res);

  renderPaymentReceiptLayout(doc, payment, workspaceName);

  doc.end();
}

