import winston from "winston";
import { env } from "./env";

export const logger = winston.createLogger({
  level: env.nodeEnv === "production" ? "info" : "debug",
  format:
    env.nodeEnv === "production"
      ? winston.format.combine(
          winston.format.timestamp(),
          winston.format.json()
        )
      : winston.format.combine(
          winston.format.timestamp(),
          winston.format.colorize(),
          winston.format.simple()
        ),
  transports: [new winston.transports.Console()],
});
