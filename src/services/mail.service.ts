import { Resend } from "resend";

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

const resend = new Resend(process.env.RESEND_API_KEY);

export async function sendEmail({
  to,
  subject,
  html,
  attachments,
}: SendMailOptions): Promise<boolean> {
  try {
    if (!process.env.RESEND_API_KEY) {
      throw new Error("RESEND_API_KEY is missing");
    }

    const { error } = await resend.emails.send({
      from: process.env.SMTP_FROM!,
      to,
      subject,
      html,
      attachments: attachments?.map((attachment) => ({
        filename: attachment.filename,
        content:
          typeof attachment.content === "string"
            ? attachment.content
            : attachment.content.toString("base64"),
        contentType: attachment.contentType,
      })),
    });

    if (error) {
      console.error("[MailService] Resend error:", error);
      return false;
    }

    return true;
  } catch (error) {
    console.error("[MailService] Error sending email:", error);
    return false;
  }
}
