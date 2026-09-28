import type { NextFunction, Request, Response } from "express";

export function bearerAuth(req: Request, res: Response, next: NextFunction): void {
  const expectedToken = process.env.MCP_SERVER_TOKEN;
  const header = req.headers["authorization"];
  const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!expectedToken || !token || token !== expectedToken) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  next();
}
