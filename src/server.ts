import pg from "pg";
import { createApp } from "./app.js";
import { SCHEMA } from "./db.js";

const secret = process.env.QUO_WEBHOOK_KEY;
const databaseUrl = process.env.DATABASE_URL;
if (!secret || !databaseUrl) {
  console.error("Set QUO_WEBHOOK_KEY (whsec_...) and DATABASE_URL");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: databaseUrl });
await pool.query(SCHEMA);

const port = Number(process.env.PORT ?? 3000);
createApp(pool, secret).listen(port, () => console.log(`Listening on :${port}`));
