import type { Request, Response } from "express";
import { whatsappConfig } from "../config/whatsapp.config.js";
import { verifyWhatsAppWebhookSignature } from "../services/whatsapp-webhook.service.js";

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}


export function verifyWhatsAppWebhook(req: Request, res: Response) {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (
    mode === "subscribe" &&
    token === whatsappConfig.webhookVerifyToken &&
    typeof challenge === "string"
  ) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
}

// export function receiveWhatsAppWebhook(
//   req: Request,
//   res: Response,
// ) {
//   try {
//     const webhookData = req.body;

//     if (!webhookData || typeof webhookData !== "object") {
//       return res.status(400).json({
//         success: false,
//         message: "Invalid webhook payload",
//       });
//     }

//     // Temporary: inspect incoming webhook structure.
//     // Do not log access tokens or sensitive information.
//     console.log(
//       "WhatsApp webhook received:",
//       JSON.stringify(webhookData, null, 2),
//     );

//     return res.status(200).json({
//       success: true,
//       message: "Webhook received successfully",
//     });
//   } catch {
//     return res.status(500).json({
//       success: false,
//       message: "Webhook processing failed",
//     });
//   }
// }

export function receiveWhatsAppWebhook(
  req: RawBodyRequest,
  res: Response,
) {
  const signature = req.headers["x-hub-signature-256"];

  const isValid = verifyWhatsAppWebhookSignature(
    req.rawBody ?? Buffer.alloc(0),
    typeof signature === "string" ? signature : undefined,
  );

  if (!isValid) {
    return res.status(401).json({
      success: false,
      message: "Invalid webhook signature",
    });
  }

  console.log("Verified WhatsApp webhook received");

  return res.status(200).json({
    success: true,
    message: "Webhook signature verified",
  });
}