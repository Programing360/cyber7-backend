import nodemailer from "nodemailer";

export interface EmailAttachment {
  filename: string;
  content: Buffer | string;
  contentType?: string;
}

export interface SendMailOptions {
  to: string;
  subject: string;
  html: string;
  attachments?: EmailAttachment[];
}

/**
 * রানটাইমে সুরক্ষিতভাবে ট্রান্সপোর্টার ইনিশিয়ালাইজ করার হেল্পার
 */
function createTransporter() {
  const user = (process.env.SMTP_USER || "").trim();
  const pass = (process.env.SMTP_PASS || "").trim();

  if (!user || !pass) {
    console.error("❌ [MailService] Missing credentials:");
    console.error(`- SMTP_USER present: ${Boolean(user)} (${user})`);
    console.error(
      `- SMTP_PASS present: ${Boolean(pass)} (Length: ${pass.length})`,
    );
    return null;
  }

  // Gmail এর জন্য অফিশিয়াল সার্ভিস কনফিগারেশন
  return nodemailer.createTransport({
    service: "gmail",
    auth: {
      user,
      pass,
    },
  });
}

export async function sendEmail({
  to,
  subject,
  html,
  attachments,
}: SendMailOptions): Promise<boolean> {
  try {
    const transporter = createTransporter();
    if (!transporter) {
      throw new Error("SMTP credentials are not defined in process.env");
    }

    const fromAddress = (
      process.env.SMTP_FROM ||
      process.env.SMTP_USER ||
      ""
    ).trim();

    const info = await transporter.sendMail({
      from: `"VexChat Security" <${fromAddress}>`,
      to,
      subject,
      html,
      attachments,
    });

    // console.log(
    //   "[MailService] Email sent successfully. Message ID:",
    //   info.messageId,
    // );
    return true;
  } catch (error) {
    console.error("[MailService] Error sending email:", error);
    return false;
  }
}
