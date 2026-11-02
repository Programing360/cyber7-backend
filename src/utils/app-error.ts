export class AppError extends Error {
  public readonly statusCode: number;
  public readonly status: "fail" | "error";
  public readonly isOperational: boolean;
  public readonly code?: string;

  constructor(
    message: string,
    statusCode: number = 500,
    codeOrOperational: string | boolean = true,
    isOperational: boolean = true,
  ) {
    super(message);

    this.name = "AppError";
    this.statusCode = statusCode;
    this.status = statusCode >= 500 ? "error" : "fail";

    if (typeof codeOrOperational === "string") {
      this.code = codeOrOperational;
      this.isOperational = isOperational;
    } else {
      this.isOperational = codeOrOperational;
    }

    Error.captureStackTrace(this, this.constructor);
  }
}
