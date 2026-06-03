import express from "express";
import http from "http";
import cors from "cors";
import morgan from "morgan";
import dotenv from "dotenv";
import { Server } from "socket.io";
import { createClient } from "redis";
import { logger } from "./logger";
import { errorHandler } from "./middleware/errorHandler";
import uploadRouter from "./routes/upload";

dotenv.config();

const app = express();
const server = http.createServer(app);

// Initialize Socket.io
const io = new Server(server, {
  cors: {
    origin: "*", // Adjust as necessary for production
    methods: ["GET", "POST"],
  },
});

const port = process.env.PORT || 5000;

// Enable CORS
app.use(cors());

// Parse JSON payloads
app.use(express.json());

// Morgan HTTP request logging integrated with Winston
app.use(
  morgan(":method :url :status :res[content-length] - :response-time ms", {
    stream: {
      write: (message) => logger.http(message.trim()),
    },
  })
);

// Route declarations
app.use("/api/upload", uploadRouter);

// Health Check API
app.get("/health", (req, res) => {
  res.status(200).json({ status: "OK", service: "backend" });
});

// Real-Time Socket Connections
io.on("connection", (socket) => {
  logger.info(`Socket client connected: ${socket.id}`);
  
  socket.on("disconnect", () => {
    logger.info(`Socket client disconnected: ${socket.id}`);
  });
});

// Make Socket.IO available globally if needed
app.set("io", io);

// Redis Subscriber Setup
const redisUrl = `redis://:${process.env.REDIS_PASSWORD || ""}@${process.env.REDIS_HOST || "redis"}:${process.env.REDIS_PORT || "6379"}`;
const redisSubscriber = createClient({ url: redisUrl });

redisSubscriber.on("error", (err) => logger.error(`Redis Subscriber Error: ${err.message}`));

const initSubscriber = async () => {
  try {
    await redisSubscriber.connect();
    logger.info("Redis Subscriber connected successfully for backend Socket.IO broadcast.");

    await redisSubscriber.subscribe("job-updates", (message) => {
      try {
        const data = JSON.parse(message);
        logger.debug(`Broadcasting job update via Socket.IO: ${JSON.stringify(data)}`);
        io.emit("job-update", data);
      } catch (err: any) {
        logger.error(`Error parsing Redis Pub/Sub message: ${err.message}`);
      }
    });
  } catch (err: any) {
    logger.error(`Redis Subscriber setup failed: ${err.message}`);
  }
};
initSubscriber();

// Global Error Handler
app.use(errorHandler);

server.listen(port, () => {
  logger.info(`Backend Server successfully started on port ${port}`);
});
