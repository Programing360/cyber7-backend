import type { Request } from "express";

export function getRouteParam(req: Request, name: string): string | undefined {
  const value = req.params[name];

  if (typeof value === "string") {
    return value;
  }

  return undefined;
}
