import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyWhatsAppWebhookSignature(
  rawBody: Buffer,
  signature: string | undefined,
): boolean {
  const appSecret = process.env.META_APP_SECRET;

  if (!appSecret || !signature || !signature.startsWith("sha256=")) {
    return false;
  }

  const expectedSignature = `sha256=${createHmac("sha256", appSecret)
    .update(rawBody)
    .digest("hex")}`;

  const expectedBuffer = Buffer.from(expectedSignature);
  const receivedBuffer = Buffer.from(signature);

  if (expectedBuffer.length !== receivedBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, receivedBuffer);
}
