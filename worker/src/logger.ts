import winston from "winston";

const format = winston.format.combine(
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss:ms" }),
  winston.format.colorize({ all: true }),
  winston.format.printf(
    (info) => `[${info.timestamp}] [${info.level}] [Worker]: ${info.message}`
  )
);

const transports = [
  new winston.transports.Console({
    format: process.env.NODE_ENV === "production" 
      ? winston.format.json() 
      : format
  }),
];

export const logger = winston.createLogger({
  level: "debug",
  transports,
});
