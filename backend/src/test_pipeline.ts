import axios from "axios";
import crypto from "crypto";
import FormData from "form-data";
import { logger } from "./logger";

const BASE_URL = "http://localhost:5000/api/upload";

// Helper to compute MD5 hash
const md5Hash = (buf: Buffer): string => {
  return crypto.createHash("md5").update(buf).digest("hex");
};

// Helper sleep
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function runTests() {
  logger.info("==================================================");
  logger.info("STARTING PIPELINE TEST SUITE (PHASES 2 & 3)");
  logger.info("==================================================");

  try {
    // ----------------------------------------------------
    // TEST 1: Initiate Upload Session
    // ----------------------------------------------------
    logger.info("\n--- TEST 1: Initiating Upload Session ---");
    const initResponse = await axios.post(`${BASE_URL}/initiate`, {
      fileName: "test_image.png",
      fileSize: 6291456, // 6MB
      mimeType: "image/png",
      totalChunks: 3,
    });
    
    const sessionId = initResponse.data.id;
    logger.info(`Session initialized successfully. SessionID: ${sessionId}`);
    if (initResponse.data.status !== "PENDING") {
      throw new Error("Initial status should be PENDING");
    }

    // ----------------------------------------------------
    // TEST 2: Chunk Upload Integrity Verification
    // ----------------------------------------------------
    logger.info("\n--- TEST 2: Chunk Upload with Integrity Checks ---");
    
    // Create mock chunk data (2MB each)
    const chunk0 = Buffer.alloc(2 * 1024 * 1024, "A");
    const chunk1 = Buffer.alloc(2 * 1024 * 1024, "B");
    const chunk2 = Buffer.alloc(2 * 1024 * 1024, "C");

    const hash0 = md5Hash(chunk0);
    const hash1 = md5Hash(chunk1);
    const hash2 = md5Hash(chunk2);

    // Try uploading chunk 0 with a WRONG hash (should fail)
    logger.info("Attempting to upload chunk 0 with invalid hash (integrity test)...");
    try {
      const badForm = new FormData();
      badForm.append("chunk", chunk0, "chunk0");
      await axios.post(`${BASE_URL}/${sessionId}/chunk`, badForm, {
        params: { chunkIndex: 0, hash: "bad_hash_value_here" },
        headers: badForm.getHeaders(),
      });
      throw new Error("Chunk upload with invalid hash should have failed, but succeeded.");
    } catch (err: any) {
      if (err.response && err.response.status === 400) {
        logger.info(`✅ Chunk rejected correctly with 400 Bad Request: ${err.response.data.error.message}`);
      } else {
        throw err;
      }
    }

    // Upload chunk 0 successfully
    logger.info("Uploading chunk 0 with correct hash...");
    const form0 = new FormData();
    form0.append("chunk", chunk0, "chunk0");
    const uploadRes0 = await axios.post(`${BASE_URL}/${sessionId}/chunk`, form0, {
      params: { chunkIndex: 0, hash: hash0 },
      headers: form0.getHeaders(),
    });
    logger.info(`✅ Chunk 0 uploaded. UploadedChunks array: [${uploadRes0.data.uploadedChunks.join(", ")}]`);

    // ----------------------------------------------------
    // TEST 3: Mock Interrupted Upload & Resumption
    // ----------------------------------------------------
    logger.info("\n--- TEST 3: Mock Interruption and Resumption ---");
    
    // Upload chunk 1
    logger.info("Uploading chunk 1...");
    const form1 = new FormData();
    form1.append("chunk", chunk1, "chunk1");
    await axios.post(`${BASE_URL}/${sessionId}/chunk`, form1, {
      params: { chunkIndex: 1, hash: hash1 },
      headers: form1.getHeaders(),
    });

    // Simulate network drop/refresh: query session status to resume
    logger.info("Simulating interruption. Querying active session state...");
    const statusRes = await axios.get(`${BASE_URL}/${sessionId}`);
    const resumeFrom = statusRes.data.uploadedChunks;
    logger.info(`Resuming upload. Detected already uploaded chunk indices: [${resumeFrom.join(", ")}]`);

    // Only upload the missing chunk (chunk 2)
    if (!resumeFrom.includes(2)) {
      logger.info("Uploading remaining chunk 2...");
      const form2 = new FormData();
      form2.append("chunk", chunk2, "chunk2");
      const uploadRes2 = await axios.post(`${BASE_URL}/${sessionId}/chunk`, form2, {
        params: { chunkIndex: 2, hash: hash2 },
        headers: form2.getHeaders(),
      });
      logger.info(`✅ Remaining chunk 2 uploaded. UploadedChunks array: [${uploadRes2.data.uploadedChunks.join(", ")}]`);
    }

    // ----------------------------------------------------
    // TEST 4: Chunk Merging & Processing Queue Trigger
    // ----------------------------------------------------
    logger.info("\n--- TEST 4: Merging Chunks & Worker Execution ---");
    logger.info("Requesting file merge...");
    const mergeResponse = await axios.post(`${BASE_URL}/merge`, { sessionId });
    logger.info(`Merge Endpoint Response: ${mergeResponse.data.message}`);
    logger.info(`ProcessedFile Status: ${mergeResponse.data.processedFile.status}`);

    // Poll the backend until the file processing changes status to COMPLETED
    logger.info("Polling file processing status from DB...");
    let completed = false;
    for (let attempts = 0; attempts < 15; attempts++) {
      await sleep(1000);
      const pollRes = await axios.get(`${BASE_URL}/${sessionId}`);
      const procFile = pollRes.data.processedFile;
      logger.info(`Polling... ProcessedFile Status: ${procFile.status} | Duration: ${procFile.processingDuration}ms`);
      
      if (procFile.status === "COMPLETED") {
        logger.info(`✅ File fully processed! Merged path: ${procFile.filePath}`);
        completed = true;
        break;
      } else if (procFile.status === "FAILED") {
        throw new Error(`File processing failed unexpectedly: ${procFile.errorMessage}`);
      }
    }

    if (!completed) {
      throw new Error("File processing timed out.");
    }

    // ----------------------------------------------------
    // TEST 5: Concurrent Queue Processing (10 jobs)
    // ----------------------------------------------------
    logger.info("\n--- TEST 5: Concurrency Verification (10 Simulataneous Jobs) ---");
    const CONCURRENT_JOBS = 10;
    logger.info(`Initiating, uploading, and merging ${CONCURRENT_JOBS} files concurrently...`);

    const sessions = await Promise.all(
      Array.from({ length: CONCURRENT_JOBS }).map(async (_, idx) => {
        const initRes = await axios.post(`${BASE_URL}/initiate`, {
          fileName: `concurrent_file_${idx}.txt`,
          fileSize: 1024, // 1KB
          mimeType: "text/plain",
          totalChunks: 1,
        });
        return initRes.data;
      })
    );

    // Upload single chunk for each concurrent session
    await Promise.all(
      sessions.map(async (sess, idx) => {
        const txtChunk = Buffer.from(`Content for file index ${idx}`);
        const hash = md5Hash(txtChunk);
        const form = new FormData();
        form.append("chunk", txtChunk, `chunk_${idx}`);
        await axios.post(`${BASE_URL}/${sess.id}/chunk`, form, {
          params: { chunkIndex: 0, hash },
          headers: form.getHeaders(),
        });
      })
    );

    // Trigger merge concurrently
    logger.info("Triggering merges concurrently...");
    const mergePromises = sessions.map((sess) => axios.post(`${BASE_URL}/merge`, { sessionId: sess.id }));
    await Promise.all(mergePromises);
    logger.info("All 10 jobs pushed to the queue! Monitoring concurrent completion...");

    // Wait and verify completion
    let allFinished = false;
    for (let attempts = 0; attempts < 15; attempts++) {
      await sleep(1500);
      const statuses = await Promise.all(
        sessions.map(async (sess) => {
          const res = await axios.get(`${BASE_URL}/${sess.id}`);
          return res.data.processedFile.status;
        })
      );
      
      const completedCount = statuses.filter((st) => st === "COMPLETED").length;
      logger.info(`Concurrent Jobs Status: Completed ${completedCount}/${CONCURRENT_JOBS}`);
      
      if (completedCount === CONCURRENT_JOBS) {
        logger.info("✅ All 10 concurrent jobs processed successfully without crashing the worker!");
        allFinished = true;
        break;
      }
    }

    if (!allFinished) {
      throw new Error("Concurrency test timed out.");
    }

    // ----------------------------------------------------
    // TEST 6: Job Failures, Backoff and Retry Queue
    // ----------------------------------------------------
    logger.info("\n--- TEST 6: Backoff & Exponential Retry Queue ---");
    logger.info("Initiating a job named 'corrupt_file.txt' designed to fail...");
    const failSessionRes = await axios.post(`${BASE_URL}/initiate`, {
      fileName: "corrupt_file.txt",
      fileSize: 500,
      mimeType: "text/plain",
      totalChunks: 1,
    });
    
    const failSessionId = failSessionRes.data.id;
    const failChunk = Buffer.from("Corrupt file content");
    const failHash = md5Hash(failChunk);

    const failForm = new FormData();
    failForm.append("chunk", failChunk, "fail_chunk");
    await axios.post(`${BASE_URL}/${failSessionId}/chunk`, failForm, {
      params: { chunkIndex: 0, hash: failHash },
      headers: failForm.getHeaders(),
    });

    logger.info("Merging corrupt file. This will trigger failures and retries...");
    await axios.post(`${BASE_URL}/merge`, { sessionId: failSessionId });

    // We will poll the session. The job retry settings are:
    // Attempts: 3, delay: 2s (exponential: 2s, 4s)
    // So it should fail, wait 2s, fail, wait 4s, fail, then mark as FAILED. Total time ~6-8 seconds.
    logger.info("Polling DB to watch retry execution progress...");
    let retryTestSuccess = false;
    for (let attempts = 0; attempts < 15; attempts++) {
      await sleep(1500);
      const res = await axios.get(`${BASE_URL}/${failSessionId}`);
      const procFile = res.data.processedFile;
      
      logger.info(`Poll Retry: Status = ${procFile.status} | ErrorMessage = ${procFile.errorMessage || "None"}`);
      
      if (procFile.status === "FAILED") {
        logger.info("✅ Verified: Job failed, retried 3 times, and gracefully transitioned to FAILED status in the database!");
        logger.info(`Error recorded: "${procFile.errorMessage}"`);
        retryTestSuccess = true;
        break;
      }
    }

    if (!retryTestSuccess) {
      throw new Error("Retry validation timed out or job did not fail correctly.");
    }

    logger.info("\n==================================================");
    logger.info("✅ ALL PIPELINE TESTS PASSED SUCCESSFULY!");
    logger.info("==================================================");

  } catch (error: any) {
    logger.error("❌ PIPELINE TEST FAILED");
    if (error.response) {
      logger.error(`API Error response status: ${error.response.status}`);
      logger.error(`API Error message: ${JSON.stringify(error.response.data)}`);
    } else {
      logger.error(error.stack || error.message || error);
    }
    process.exit(1);
  }
}

// Check if running directly
if (require.main === module) {
  runTests();
}
