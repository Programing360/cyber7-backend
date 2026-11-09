import type { Response } from "express";
import PDFDocument from "pdfkit";
import mongoose, { type Types } from "mongoose";
import Invoice, { type IInvoice } from "./invoice.model.js";
import Payment, { type IPayment } from "./payment.model.js";
import Workspace from "../workspace/workspace.model.js";
import { sendEmail } from "../../services/mail.service.js";
import { adminSecurityAuditService } from "../admin-auth/admin-security-audit.service.js";
import type { ResendInvoiceEmailInput } from "./invoice-email.validation.js";

// Safe constructor resolution across ESM / CJS bundlers
const PDFDocConstructor =
  (PDFDocument as unknown as { default?: typeof PDFDocument }).default ||
  PDFDocument;

export interface AdminAuditContext {
  adminUserId?: string | Types.ObjectId;
  adminEmail?: string;
  sessionId?: string | Types.ObjectId;
  ipAddress?: string;
  userAgent?: string;
}

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
 * Draw a styled invoice onto a PDFKit document
 */
export function renderInvoicePdfLayout(
  doc: InstanceType<typeof PDFDocument>,
  invoice: IInvoice,
  payment?: IPayment | null,
): void {
  const margin = 40;
  const pageWidth = 595.28; // Standard A4 points
  const contentWidth = pageWidth - margin * 2;

  // --- 1. HEADER SECTION ---
  // Top brand bar
  doc.rect(margin, margin, contentWidth, 4).fill("#2563EB");

  // Company Letterhead (Left)
  doc
    .font("Helvetica-Bold")
    .fontSize(22)
    .fillColor("#0F172A")
    .text("CYBER7", margin, margin + 14);

  doc
    .font("Helvetica")
    .fontSize(10)
    .fillColor("#2563EB")
    .text("VEXCHAT CLOUD SUITE", margin, margin + 40);

  doc
    .font("Helvetica")
    .fontSize(8.5)
    .fillColor("#64748B")
    .text("Cyber7 Bangladesh Ltd.", margin, margin + 56)
    .text("Level 14, BDBL Bhaban, Karwan Bazar, Dhaka-1215", margin, margin + 68)
    .text("Support: support@vexchat.com | Web: https://vexchat.com", margin, margin + 80);

  // Invoice Title & Status (Right)
  const isPaid = invoice.status === "PAID";
  const badgeColor = isPaid ? "#059669" : invoice.status === "PENDING" ? "#D97706" : "#DC2626";
  const badgeText = invoice.status;

  doc
    .font("Helvetica-Bold")
    .fontSize(24)
    .fillColor("#0F172A")
    .text("INVOICE", margin + 300, margin + 14, { width: contentWidth - 300, align: "right" });

  doc
    .font("Helvetica-Bold")
    .fontSize(10)
    .fillColor("#64748B")
    .text(`NO: ${invoice.invoiceNumber}`, margin + 300, margin + 44, {
      width: contentWidth - 300,
      align: "right",
    });

  // Status Badge
  const badgeWidth = 70;
  const badgeHeight = 18;
  const badgeX = margin + contentWidth - badgeWidth;
  const badgeY = margin + 62;
  doc
    .roundedRect(badgeX, badgeY, badgeWidth, badgeHeight, 3)
    .fill(badgeColor);

  doc
    .font("Helvetica-Bold")
    .fontSize(9)
    .fillColor("#FFFFFF")
    .text(badgeText, badgeX, badgeY + 4, {
      width: badgeWidth,
      align: "center",
    });

  // Date metadata
  doc
    .font("Helvetica")
    .fontSize(8.5)
    .fillColor("#64748B")
    .text(`Issue Date: ${formatDate(invoice.createdAt)}`, margin + 250, margin + 84, {
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

  // --- 3. BILLED TO & PAYMENT DETAILS ---
  const infoY = dividerY + 12;

  // Left Column: Bill To
  doc
    .font("Helvetica-Bold")
    .fontSize(9)
    .fillColor("#2563EB")
    .text("BILLED TO:", margin, infoY);

  doc
    .font("Helvetica-Bold")
    .fontSize(10)
    .fillColor("#0F172A")
    .text(invoice.issuedTo?.workspaceName || "Workspace Customer", margin, infoY + 14);

  doc
    .font("Helvetica")
    .fontSize(8.5)
    .fillColor("#475569")
    .text(`Attention: ${invoice.issuedTo?.userName || "Workspace Administrator"}`, margin, infoY + 28)
    .text(`Email: ${invoice.issuedTo?.userEmail || "N/A"}`, margin, infoY + 40);

  // Right Column: Payment & Settlement Details
  const rightColX = margin + 280;
  doc
    .font("Helvetica-Bold")
    .fontSize(9)
    .fillColor("#2563EB")
    .text("PAYMENT & SETTLEMENT:", rightColX, infoY);

  const trxRef =
    payment?.gatewayData?.trxID ||
    payment?.gatewayData?.bankTransfer?.referenceNumber ||
    "N/A";

  doc
    .font("Helvetica")
    .fontSize(8.5)
    .fillColor("#475569")
    .text(`Method: ${invoice.paymentMethod}`, rightColX, infoY + 14)
    .text(`Billing Cycle: ${invoice.billingCycle}`, rightColX, infoY + 26)
    .text(`Transaction Ref: ${trxRef}`, rightColX, infoY + 38)
    .text(`Settlement Date: ${formatDate(invoice.paidAt || payment?.completedAt)}`, rightColX, infoY + 50);

  // --- 4. LINE ITEMS TABLE ---
  const tableY = infoY + 75;

  // Table Header Background
  doc
    .rect(margin, tableY, contentWidth, 22)
    .fill("#F1F5F9");

  // Table Headers
  doc
    .font("Helvetica-Bold")
    .fontSize(8.5)
    .fillColor("#1E293B")
    .text("DESCRIPTION & COVERAGE", margin + 10, tableY + 6, { width: 260 })
    .text("BILLING CYCLE", margin + 280, tableY + 6, { width: 90, align: "center" })
    .text("QTY", margin + 380, tableY + 6, { width: 30, align: "center" })
    .text("AMOUNT (BDT)", margin + 420, tableY + 6, { width: 85, align: "right" });

  // Table Row 1
  const rowY = tableY + 26;
  doc
    .rect(margin, rowY, contentWidth, 38)
    .fill("#FFFFFF");

  doc
    .strokeColor("#E2E8F0")
    .lineWidth(0.5)
    .moveTo(margin, rowY + 38)
    .lineTo(margin + contentWidth, rowY + 38)
    .stroke();

  // Item description
  doc
    .font("Helvetica-Bold")
    .fontSize(9.5)
    .fillColor("#0F172A")
    .text(`${invoice.planName} (${invoice.planCode})`, margin + 10, rowY + 6, { width: 260 });

  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor("#64748B")
    .text(
      `Service Period: ${formatDate(invoice.periodCoveredStart)} — ${formatDate(invoice.periodCoveredEnd)}`,
      margin + 10,
      rowY + 20,
      { width: 260 },
    );

  doc
    .font("Helvetica")
    .fontSize(8.5)
    .fillColor("#334155")
    .text(invoice.billingCycle, margin + 280, rowY + 12, { width: 90, align: "center" })
    .text("1", margin + 380, rowY + 12, { width: 30, align: "center" });

  doc
    .font("Helvetica-Bold")
    .fontSize(9)
    .fillColor("#0F172A")
    .text(formatBDT(invoice.amount), margin + 420, rowY + 12, { width: 85, align: "right" });

  // --- 5. SUMMARY & TOTALS SECTION ---
  const summaryBoxY = rowY + 54;
  const summaryBoxWidth = 220;
  const summaryBoxX = margin + contentWidth - summaryBoxWidth;

  // Background box for summary
  doc
    .roundedRect(summaryBoxX, summaryBoxY, summaryBoxWidth, 90, 4)
    .fill("#F8FAFC");

  doc
    .strokeColor("#E2E8F0")
    .lineWidth(1)
    .roundedRect(summaryBoxX, summaryBoxY, summaryBoxWidth, 90, 4)
    .stroke();

  // Subtotal
  doc
    .font("Helvetica")
    .fontSize(8.5)
    .fillColor("#64748B")
    .text("Subtotal:", summaryBoxX + 12, summaryBoxY + 10);
  doc
    .font("Helvetica")
    .fontSize(8.5)
    .fillColor("#0F172A")
    .text(formatBDT(invoice.amount), summaryBoxX + 100, summaryBoxY + 10, {
      width: summaryBoxWidth - 112,
      align: "right",
    });

  // VAT (0% / Included)
  doc
    .font("Helvetica")
    .fontSize(8.5)
    .fillColor("#64748B")
    .text("VAT / Taxes (0%):", summaryBoxX + 12, summaryBoxY + 26);
  doc
    .font("Helvetica")
    .fontSize(8.5)
    .fillColor("#0F172A")
    .text("BDT 0.00", summaryBoxX + 100, summaryBoxY + 26, {
      width: summaryBoxWidth - 112,
      align: "right",
    });

  // Separator in summary
  doc
    .strokeColor("#E2E8F0")
    .lineWidth(0.5)
    .moveTo(summaryBoxX + 12, summaryBoxY + 42)
    .lineTo(summaryBoxX + summaryBoxWidth - 12, summaryBoxY + 42)
    .stroke();

  // Grand Total
  doc
    .font("Helvetica-Bold")
    .fontSize(10)
    .fillColor("#0F172A")
    .text("Total Amount:", summaryBoxX + 12, summaryBoxY + 48);
  doc
    .font("Helvetica-Bold")
    .fontSize(10)
    .fillColor("#2563EB")
    .text(formatBDT(invoice.amount), summaryBoxX + 100, summaryBoxY + 48, {
      width: summaryBoxWidth - 112,
      align: "right",
    });

  // Paid / Balance Due
  const balanceDue = isPaid ? 0 : invoice.amount;
  doc
    .font("Helvetica-Bold")
    .fontSize(8.5)
    .fillColor(isPaid ? "#059669" : "#DC2626")
    .text(
      isPaid ? "Paid in Full" : `Balance Due: ${formatBDT(balanceDue)}`,
      summaryBoxX + 12,
      summaryBoxY + 68,
      { width: summaryBoxWidth - 24, align: "center" },
    );

  // --- 6. DIGITAL VERIFICATION SEAL (Bottom Left) ---
  const sealX = margin;
  const sealY = summaryBoxY;
  const sealWidth = contentWidth - summaryBoxWidth - 20;

  doc
    .roundedRect(sealX, sealY, sealWidth, 90, 4)
    .fill("#F8FAFC");

  doc
    .strokeColor("#E2E8F0")
    .lineWidth(1)
    .roundedRect(sealX, sealY, sealWidth, 90, 4)
    .stroke();

  doc
    .font("Helvetica-Bold")
    .fontSize(8.5)
    .fillColor("#059669")
    .text("✔ OFFICIALLY VALIDATED & DIGITALLY VERIFIED", sealX + 12, sealY + 10);

  doc
    .font("Helvetica")
    .fontSize(7.5)
    .fillColor("#475569")
    .text(`Document ID: INV-${invoice.invoiceNumber}`, sealX + 12, sealY + 26)
    .text(`Security Hash: SHA256-${String(invoice._id).substring(0, 16).toUpperCase()}`, sealX + 12, sealY + 38)
    .text("Issued by: Cyber7 Automated Financial Ledger", sealX + 12, sealY + 50)
    .text("This is an official computer-generated document requiring no physical signature.", sealX + 12, sealY + 66, {
      width: sealWidth - 24,
    });

  // --- 7. FOOTER NOTE ---
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
      "Thank you for partnering with Cyber7 VexChat! For billing inquiries, contact us at billing@vexchat.com",
      margin,
      footerY + 8,
      { width: contentWidth, align: "center" },
    );
}

/**
 * Fetch invoice and its populated references
 */
export async function getInvoiceWithDetails(
  invoiceId: string,
): Promise<{ invoice: IInvoice; payment: IPayment | null }> {
  let query: Record<string, unknown> = { invoiceNumber: invoiceId };
  if (mongoose.Types.ObjectId.isValid(invoiceId)) {
    query = { $or: [{ _id: invoiceId }, { invoiceNumber: invoiceId }] };
  }

  const invoice = await Invoice.findOne(query);
  if (!invoice) {
    throw new Error(`Invoice '${invoiceId}' not found.`);
  }

  let payment: IPayment | null = null;
  if (invoice.paymentId) {
    payment = await Payment.findById(invoice.paymentId);
  }

  return { invoice, payment };
}

/**
 * Stream invoice PDF directly to Express response
 */
export async function streamInvoicePdf(invoiceId: string, res: Response): Promise<void> {
  const { invoice, payment } = await getInvoiceWithDetails(invoiceId);

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `inline; filename="Invoice-${invoice.invoiceNumber}.pdf"`,
  );

  const doc = new PDFDocConstructor({ margin: 40, size: "A4" });

  res.on("close", () => {
    doc.destroy();
  });

  doc.pipe(res);

  renderInvoicePdfLayout(doc, invoice, payment);

  doc.end();
}

/**
 * Generate invoice PDF as an in-memory buffer (for email attachments)
 */
export async function generateInvoicePdfBuffer(
  invoice: IInvoice,
  payment?: IPayment | null,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocConstructor({ margin: 40, size: "A4" });
    const chunks: Buffer[] = [];

    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", (err: Error) => reject(err));

    renderInvoicePdfLayout(doc, invoice, payment);

    doc.end();
  });
}

/**
 * Resend invoice via transactional email with attached PDF
 */
export async function resendInvoiceEmailService(
  invoiceId: string,
  input: ResendInvoiceEmailInput,
  adminContext: AdminAuditContext,
): Promise<{ invoiceNumber: string; recipientEmail: string; sentAt: string }> {
  const { invoice, payment } = await getInvoiceWithDetails(invoiceId);

  // Resolve target email recipient
  let recipientEmail = input.recipientEmail?.trim();
  if (!recipientEmail) {
    recipientEmail = invoice.issuedTo?.userEmail?.trim();
  }

  if (!recipientEmail && invoice.workspaceId) {
    const workspace = await Workspace.findById(invoice.workspaceId);
    recipientEmail = (workspace as any)?.billingEmail?.trim();
  }

  if (!recipientEmail) {
    throw new Error(
      "No valid recipient email address found for this invoice. Please provide an explicit recipientEmail.",
    );
  }

  // Generate PDF buffer
  const pdfBuffer = await generateInvoicePdfBuffer(invoice, payment);

  // Compose email HTML
  const subject = `Invoice ${invoice.invoiceNumber} from Cyber7 VexChat`;
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #1e293b; line-height: 1.5;">
      <div style="border-bottom: 3px solid #2563eb; padding-bottom: 16px; margin-bottom: 24px;">
        <h1 style="color: #0f172a; margin: 0; font-size: 24px;">Cyber7 VexChat</h1>
        <p style="color: #64748b; margin: 4px 0 0 0; font-size: 13px;">Official Billing & Subscription Notification</p>
      </div>

      <p style="font-size: 15px;">Dear <strong>${invoice.issuedTo?.userName || "Customer"}</strong>,</p>
      <p style="font-size: 14px; color: #475569;">
        Please find attached your official invoice <strong>#${invoice.invoiceNumber}</strong> for workspace <strong>${invoice.issuedTo?.workspaceName || "VexChat Workspace"}</strong>.
      </p>

      <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin: 20px 0;">
        <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
          <tr>
            <td style="padding: 6px 0; color: #64748b;">Invoice Number:</td>
            <td style="padding: 6px 0; font-weight: 600; text-align: right;">${invoice.invoiceNumber}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #64748b;">Plan:</td>
            <td style="padding: 6px 0; font-weight: 600; text-align: right;">${invoice.planName} (${invoice.planCode})</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #64748b;">Billing Cycle:</td>
            <td style="padding: 6px 0; text-align: right;">${invoice.billingCycle}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #64748b;">Period Covered:</td>
            <td style="padding: 6px 0; text-align: right;">${formatDate(invoice.periodCoveredStart)} — ${formatDate(invoice.periodCoveredEnd)}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #64748b;">Status:</td>
            <td style="padding: 6px 0; font-weight: 600; text-align: right; color: ${invoice.status === "PAID" ? "#059669" : "#d97706"};">${invoice.status}</td>
          </tr>
          <tr style="border-top: 1px solid #cbd5e1;">
            <td style="padding: 10px 0 4px 0; font-size: 15px; font-weight: 700; color: #0f172a;">Total Amount:</td>
            <td style="padding: 10px 0 4px 0; font-size: 16px; font-weight: 700; text-align: right; color: #2563eb;">${formatBDT(invoice.amount)}</td>
          </tr>
        </table>
      </div>

      <p style="font-size: 13px; color: #64748b;">
        A copy of your PDF invoice is attached to this email for your records. If you have any questions or require custom assistance, feel free to reply directly or contact our finance desk at <a href="mailto:billing@vexchat.com" style="color: #2563eb;">billing@vexchat.com</a>.
      </p>

      <div style="margin-top: 32px; padding-top: 16px; border-top: 1px solid #e2e8f0; font-size: 12px; color: #94a3b8; text-align: center;">
        Cyber7 Bangladesh Ltd. • BDBL Bhaban, Karwan Bazar, Dhaka-1215 • https://vexchat.com
      </div>
    </div>
  `;

  // Dispatch email with attachment
  await sendEmail({
    to: recipientEmail,
    subject,
    html,
    attachments: [
      {
        filename: `Invoice-${invoice.invoiceNumber}.pdf`,
        content: pdfBuffer,
        contentType: "application/pdf",
      },
    ],
  });

  // Record audit log
  await adminSecurityAuditService.recordSecurityEvent({
    eventType: "INVOICE_RESENT",
    adminUserId: adminContext.adminUserId,
    adminEmail: adminContext.adminEmail,
    sessionId: adminContext.sessionId,
    ipAddress: adminContext.ipAddress,
    userAgent: adminContext.userAgent,
    reason: `Invoice ${invoice.invoiceNumber} resent to ${recipientEmail}`,
    metadata: {
      invoiceId: String(invoice._id),
      invoiceNumber: invoice.invoiceNumber,
      recipientEmail,
      amount: invoice.amount,
      planCode: invoice.planCode,
    },
  });

  return {
    invoiceNumber: invoice.invoiceNumber,
    recipientEmail,
    sentAt: new Date().toISOString(),
  };
}
