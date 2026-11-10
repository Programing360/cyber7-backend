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

// এনভায়রনমেন্ট ভেরিয়েবল চেক
const user = (process.env.SMTP_USER || "").trim();
const pass = (process.env.SMTP_PASS || "").trim();

if (!user || !pass) {
  console.error("❌ [MailService] Missing credentials:");
  console.error(`- SMTP_USER present: ${Boolean(user)} (${user})`);
  console.error(
    `- SMTP_PASS present: ${Boolean(pass)} (Length: ${pass.length})`,
  );
}

/**
 * গ্লোবালি একবারই ট্রান্সপোর্টার ক্রিয়েট করা হলো (Connection Pooling সহ)
 * এতে বারবার নতুন করে হ্যান্ডশেক করতে হবে না, মেইল চোখের পলকে চলে যাবে।
 */
const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false, // TLS-এর জন্য false (Port 465 হলে true হতো)
  pool: true, // কানেকশন পুলিং অন করা হলো
  maxConnections: 5, // এক সাথে সর্বোচ্চ ৫টি কানেকশন খোলা রাখবে
  maxMessages: 100, // প্রতি কানেকশনে সর্বোচ্চ ১০০টি মেইল পাঠাবে
  auth: {
    user,
    pass,
  },
});

export async function sendEmail({
  to,
  subject,
  html,
  attachments,
}: SendMailOptions): Promise<boolean> {
  try {
    if (!user || !pass) {
      throw new Error("SMTP credentials are not defined in process.env");
    }

    const fromAddress = (
      process.env.SMTP_FROM ||
      process.env.SMTP_USER ||
      ""
    ).trim();

    await transporter.sendMail({
      from: `"VexChat Security" <${fromAddress}>`,
      to,
      subject,
      html,
      attachments,
    });

    return true;
  } catch (error) {
    console.error("[MailService] Error sending email:", error);
    return false;
  }
}
