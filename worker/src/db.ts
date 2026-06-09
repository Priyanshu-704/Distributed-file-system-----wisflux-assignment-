import { Pool } from "pg";

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.on("error", (err, client) => {
  console.error("Unexpected error on idle client", err);
});

// Run simple migration to ensure minio_key column exists
pool.query("ALTER TABLE processed_files ADD COLUMN IF NOT EXISTS minio_key TEXT;")
  .then(() => {
    console.log("Database schema successfully verified/migrated.");
  })
  .catch((err) => {
    console.error("Error during database schema verification/migration:", err);
  });

