import { createHmac, timingSafeEqual } from "node:crypto";

const SIGNATURE_PREFIX = "sha256=";

export function verifyWhatsAppWebhookSignature(
  rawBody: Buffer | undefined,
  signature: string | undefined,
): boolean {
  const appSecret = process.env.META_APP_SECRET;

  if (
    !appSecret ||
    !rawBody ||
    !Buffer.isBuffer(rawBody) ||
    rawBody.length === 0 ||
    !signature ||
    !signature.startsWith(SIGNATURE_PREFIX)
  ) {
    return false;
  }

  const receivedHex = signature.slice(SIGNATURE_PREFIX.length);

  // SHA-256 produces exactly 64 hexadecimal characters.
  if (!/^[a-fA-F0-9]{64}$/.test(receivedHex)) {
    return false;
  }

  const expectedSignature = createHmac("sha256", appSecret)
    .update(rawBody)
    .digest();

  const receivedSignature = Buffer.from(receivedHex, "hex");

  if (receivedSignature.length !== expectedSignature.length) {
    return false;
  }

  

  return timingSafeEqual(expectedSignature, receivedSignature);
}
