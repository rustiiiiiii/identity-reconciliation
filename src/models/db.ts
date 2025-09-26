// src/config/db.ts
import "dotenv/config";
import { neon } from "@neondatabase/serverless";

// Use DATABASE_URL from .env
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not defined");
}

export const sql = neon(process.env.DATABASE_URL);
