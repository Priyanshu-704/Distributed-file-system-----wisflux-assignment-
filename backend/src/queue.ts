import { Queue } from "bullmq";
import { logger } from "./logger";

const redisConnection = {
  host: process.env.REDIS_HOST || "redis",
  port: parseInt(process.env.REDIS_PORT || "6379"),
  password: process.env.REDIS_PASSWORD || undefined,
};

export const fileProcessingQueue = new Queue("file-processing", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 2000, // 2s, 4s, 8s backoff
    },
    removeOnComplete: true,
    removeOnFail: false,
  },
});

fileProcessingQueue.on("error", (err) => {
  logger.error(`BullMQ Queue error: ${err.message}`, { error: err });
});

logger.info("BullMQ Queue initialized successfully.");
