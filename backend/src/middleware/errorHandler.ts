import { Request, Response, NextFunction } from "express";
import { logger } from "../logger";

export const errorHandler = (
  err: any,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  logger.error(`${req.method} ${req.url} - Error: ${err.message || err}`, {
    stack: err.stack,
    ip: req.ip,
  });

  const statusCode = err.status || err.statusCode || 500;
  
  res.status(statusCode).json({
    error: {
      message: err.message || "An unexpected error occurred on the server.",
      code: err.code || "INTERNAL_SERVER_ERROR",
      details: process.env.NODE_ENV === "development" ? err.stack : undefined,
    },
  });
};
