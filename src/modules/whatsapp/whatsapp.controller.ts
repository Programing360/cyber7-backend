import type { Request, Response, NextFunction } from "express";
import { connectWhatsAppAccount } from "./whatsapp.service.js";
import { connectWhatsAppSchema } from "./whatsapp.validation.js";
import { AppError } from "../../utils/app-error.js";

export async function connectWhatsAppController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const workspaceId = req.params.workspaceId as string;

    if (!workspaceId) {
      throw new AppError("Workspace ID is required", 400);
    }

    const parsedInput = connectWhatsAppSchema.safeParse(req.body);

    if (!parsedInput.success) {
      throw new AppError(
        parsedInput.error.issues[0]?.message ?? "Invalid request data",
        400,
      );
    }

    const account = await connectWhatsAppAccount({
      workspaceId,
      input: parsedInput.data,
    });

    res.status(201).json({
      success: true,
      message: "WhatsApp account registered successfully",
      data: account,
    });
  } catch (error) {
    next(error);
  }
}
