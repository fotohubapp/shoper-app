/**
 * Local persistence for the Shoper app, backed by SQLite (better-sqlite3).
 *
 * Concerns living here:
 *  - schema:    versioned migrations recorded in a `migrations` table, so an
 *               upgrade over an existing production DB is safe and repeatable.
 *  - drafts:    DRAFT-FIRST write-back. Bridge job results land as pending
 *               drafts; nothing touches the live product until the merchant
 *               approves. Approval delegates to ShoperWriteBack and only marks
 *               the draft approved once the store write succeeded — a failure
 *               rolls the row back to `failed` with the error recorded.
 *  - journal:   applied bridge_item_ids, the idempotency anchor for write-back.
 *  - jobs:      local job + batch records so bulk runs survive a restart and
 *               the progress UI can poll us instead of the bridge.
 *  - schedules: persisted recurring-job definitions for src/scheduler.ts.
 *  - config:    encrypted secret storage (AES-256-GCM) for the FOTOhub API
 *               key, Shoper credentials, connection id and callback secret.
 *  - webhooks:  seen delivery ids for replay suppression.
 *
 * All statements are prepared (better-sqlite3 caches them per SQL string); the
 * DB runs in WAL mode with NORMAL synchronous and a busy timeout so a long
 * write-back cannot block the HTTP layer.
 */

import Database from "better-sqlite3";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "crypto";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { ShoperClient } from "./shoper-client";
import { ShoperWriteBack, WriteBackJournal, WriteBackOptions } from "./writeback";
import {
  CachedJob,
  DraftFilter,
  DraftPayload,
  DraftRow,
  DraftStatus,
  DraftType,
  JobBatch,
  JobItem,
  JobKind,
  JobOptions,
  JobState,
  ScheduleDefinition,
  ScheduleInput,
  ScheduleTask,
  TERMINAL_JOB_STATUSES,
  WriteBackResult,
} from "./types";

/* -------------------------------------------------------------------- */
/* Encryption helpers (AES-256-GCM, key derived from a passphrase)        */
/* -------------------------------------------------------------------- */

function deriveKey(passphrase: string): Buffer {
  return createHash("sha256").update(passphrase, "utf8").digest();
}

function encrypt(plain: string, passphrase: string): string {
  const key = deriveKey(passphrase);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

function decrypt(payload: string, passphrase: string): string {
  const [version, ivB64, tagB64, dataB64] = payload.split(":");
  if (version !== "v1" || !ivB64 || !tagB64 || !dataB64) {
    throw new Error("Unrecognised encrypted payload format");
  }
  const key = deriveKey(passphrase);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/* -------------------------------------------------------------------- */
/* Stored config shape                                                   */
/* -------------------------------------------------------------------- */

export interface StoredConfig {
  fotohubApiKey?: string;
  shoperStoreUrl?: string;
  shoperAccessToken?: string;
  shoperLogin?: string;
  shoperPassword?: string;
  storeName?: string;
  connectionId?: string;
  callbackSecret?: string;
  defaultPresetSlug?: string;
  uiLanguage?: "pl" | "en";
  /** Default image model pre-selected in the job wizard. */
  defaultModel?: string;
  /** Default content language for text jobs (pl|en|de). */
  defaultLanguage?: string;
  /** Default copy tone for text jobs. */
  defaultTone?: string;
  /** "1" when image jobs should also request ALT text. */
  autoAltText?: string;
  /** "1" once the user dismissed the onboarding checklist. */
  onboardingDismissed?: string;
  /** Shoper translation locale used for reads/writes (default pl_PL). */
  shoperLocale?: string;
  /** Secondary locale mirrored on text write-back (e.g. en_US). */
  shoperSecondaryLocale?: string;
  /** "1" to mirror text write-back into the secondary locale. */
  mirrorSecondaryLocale?: string;
  /** Days a decided draft is retained before cleanup. */
  draftRetentionDays?: string;
  /** Requests per second against the Shoper webapi. */
  shoperRps?: string;
  /** "1" to set the first generated image as the product main image. */
  setMainImage?: string;
  /** "1" to overwrite ALT text that already exists. */
  overwriteAlt?: string;
  /** Max bytes accepted for a downloaded result image. */
  maxImageBytes?: string;
}

const SECRET_KEYS: ReadonlyArray<keyof StoredConfig> = [
  "fotohubApiKey",
  "shoperAccessToken",
  "shoperPassword",
  "callbackSecret",
];

/** Keys that must never leave the process in an API response. */
export const CONFIG_SECRET_KEYS: ReadonlySet<string> = new Set(SECRET_KEYS as string[]);

/* -------------------------------------------------------------------- */
/* Results                                                               */
/* -------------------------------------------------------------------- */

export interface ApplyResult {
  product_id: number;
  applied_images: number;
  applied_fields: string[];
  skipped?: string[];
  warnings?: string[];
}

export interface BulkApproveResult {
  approved: ApplyResult[];
  failed: Array<{ id: number; error: string }>;
}

/* -------------------------------------------------------------------- */
/* Migrations                                                            */
/* -------------------------------------------------------------------- */

interface Migration {
  version: number;
  name: string;
  up: (db: Database.Database) => void;
}

function columnExists(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}

function tableExists(db: Database.Database, table: string): boolean {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) !== undefined
  );
}

function addColumn(db: Database.Database, table: string, column: string, ddl: string): void {
  if (!columnExists(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "base_schema",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS drafts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          product_id INTEGER NOT NULL,
          job_id TEXT NOT NULL,
          item_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          type TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          payload TEXT NOT NULL,
          created_at TEXT NOT NULL,
          applied_at TEXT,
          error TEXT,
          UNIQUE(job_id, item_id)
        );
        CREATE INDEX IF NOT EXISTS idx_drafts_status ON drafts(status);
        CREATE INDEX IF NOT EXISTS idx_drafts_product ON drafts(product_id);

        CREATE TABLE IF NOT EXISTS jobs (
          job_id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          product_ids TEXT NOT NULL,
          created_at TEXT NOT NULL,
          state TEXT,
          terminal INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS config (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          encrypted INTEGER NOT NULL DEFAULT 0
        );
      `);
    },
  },
  {
    version: 2,
    name: "drafts_variant_and_decision_columns",
    up: (db) => {
      addColumn(db, "drafts", "variant_id", "TEXT");
      addColumn(db, "drafts", "bridge_item_id", "TEXT");
      addColumn(db, "drafts", "decided_at", "TEXT");
      addColumn(db, "drafts", "decided_by", "TEXT");
      addColumn(db, "drafts", "attempts", "INTEGER NOT NULL DEFAULT 0");
      // Backfill bridge_item_id for rows created before this column existed.
      db.exec(
        "UPDATE drafts SET bridge_item_id = job_id || ':' || item_id " +
          "WHERE bridge_item_id IS NULL OR bridge_item_id = ''"
      );
      db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_drafts_bridge_item ON drafts(bridge_item_id)"
      );
      db.exec("CREATE INDEX IF NOT EXISTS idx_drafts_job ON drafts(job_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_drafts_kind ON drafts(kind)");
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_drafts_status_created ON drafts(status, created_at DESC)"
      );
    },
  },
  {
    version: 3,
    name: "jobs_batches_and_metadata",
    up: (db) => {
      addColumn(db, "jobs", "batch_id", "TEXT");
      addColumn(db, "jobs", "model", "TEXT");
      addColumn(db, "jobs", "preset_slug", "TEXT");
      addColumn(db, "jobs", "options", "TEXT");
      addColumn(db, "jobs", "estimated_credits", "REAL");
      addColumn(db, "jobs", "schedule_id", "INTEGER");
      db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at DESC)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_batch ON jobs(batch_id)");
      db.exec(`
        CREATE TABLE IF NOT EXISTS job_batches (
          batch_id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          created_at TEXT NOT NULL,
          total_items INTEGER NOT NULL DEFAULT 0,
          estimated_credits REAL NOT NULL DEFAULT 0,
          model TEXT,
          preset_slug TEXT,
          options TEXT,
          schedule_id INTEGER,
          status TEXT NOT NULL DEFAULT 'queued'
        );
      `);
    },
  },
  {
    version: 4,
    name: "writeback_journal",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS writeback_journal (
          bridge_item_id TEXT PRIMARY KEY,
          product_id INTEGER NOT NULL,
          applied_at TEXT NOT NULL,
          detail TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_journal_product ON writeback_journal(product_id);
      `);
      // Seed the journal from drafts already approved by an earlier version so
      // an upgrade cannot re-upload images that are already live.
      if (tableExists(db, "drafts")) {
        db.exec(
          "INSERT OR IGNORE INTO writeback_journal (bridge_item_id, product_id, applied_at, detail) " +
            "SELECT bridge_item_id, product_id, COALESCE(applied_at, created_at), '{\"migrated\":true}' " +
            "FROM drafts WHERE status = 'approved' AND bridge_item_id IS NOT NULL"
        );
      }
    },
  },
  {
    version: 5,
    name: "schedules",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS schedules (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          task TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 0,
          hour INTEGER NOT NULL DEFAULT 3,
          minute INTEGER NOT NULL DEFAULT 0,
          interval_days INTEGER NOT NULL DEFAULT 1,
          max_credits_per_run REAL NOT NULL DEFAULT 200,
          max_items_per_run INTEGER NOT NULL DEFAULT 100,
          model TEXT,
          preset_slug TEXT,
          options TEXT,
          last_run_at TEXT,
          last_run_status TEXT,
          last_run_detail TEXT,
          next_run_at TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_schedules_enabled ON schedules(enabled);
      `);
    },
  },
  {
    version: 6,
    name: "webhook_deliveries",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS webhook_deliveries (
          delivery_id TEXT PRIMARY KEY,
          received_at TEXT NOT NULL,
          event TEXT,
          job_id TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_webhook_received ON webhook_deliveries(received_at);
      `);
    },
  },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

/* -------------------------------------------------------------------- */
/* Store                                                                 */
/* -------------------------------------------------------------------- */

export interface DraftStoreOptions {
  /** Days after which decided drafts are pruned. Default 30. */
  retentionDays?: number;
  /** Days after which webhook delivery ids are pruned. Default 7. */
  webhookRetentionDays?: number;
  /** Set false for in-memory test DBs. */
  wal?: boolean;
}

const DRAFT_COLUMNS =
  "id, product_id, variant_id, job_id, item_id, bridge_item_id, kind, type, status, " +
  "payload, created_at, decided_at, decided_by, applied_at, attempts, error";

interface DraftRowRaw {
  id: number;
  product_id: number;
  variant_id: string | null;
  job_id: string;
  item_id: string;
  bridge_item_id: string | null;
  kind: string;
  type: string;
  status: string;
  payload: string;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
  applied_at: string | null;
  attempts: number | null;
  error: string | null;
}

interface JobRowRaw {
  job_id: string;
  kind: string;
  product_ids: string;
  created_at: string;
  state: string | null;
  terminal: number;
  batch_id: string | null;
  model: string | null;
  preset_slug: string | null;
  options: string | null;
  estimated_credits: number | null;
  schedule_id: number | null;
}

interface ScheduleRowRaw {
  id: number;
  name: string;
  task: string;
  enabled: number;
  hour: number;
  minute: number;
  interval_days: number;
  max_credits_per_run: number;
  max_items_per_run: number;
  model: string | null;
  preset_slug: string | null;
  options: string | null;
  last_run_at: string | null;
  last_run_status: string | null;
  last_run_detail: string | null;
  next_run_at: string | null;
  created_at: string;
}

export class DraftStore implements WriteBackJournal {
  private readonly db: Database.Database;
  private readonly secret: string;
  private readonly retentionDays: number;
  private readonly webhookRetentionDays: number;

  constructor(dbPath: string, configSecret: string, options: DraftStoreOptions = {}) {
    const inMemory = dbPath === ":memory:" || dbPath.startsWith("file::memory:");
    if (!inMemory) mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.secret = configSecret;
    this.retentionDays = Math.max(1, options.retentionDays ?? 30);
    this.webhookRetentionDays = Math.max(1, options.webhookRetentionDays ?? 7);

    if (options.wal !== false && !inMemory) this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 5000");
    this.migrate();
  }

  /* ---------------------------------------------------------------- */
  /* Schema                                                            */
  /* ---------------------------------------------------------------- */

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    const applied = new Set(
      (
        this.db.prepare("SELECT version FROM migrations").all() as Array<{ version: number }>
      ).map((r) => r.version)
    );
    const record = this.db.prepare(
      "INSERT OR IGNORE INTO migrations (version, name, applied_at) VALUES (?, ?, ?)"
    );
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      const run = this.db.transaction(() => {
        migration.up(this.db);
        record.run(migration.version, migration.name, new Date().toISOString());
      });
      run();
    }
  }

  get schemaVersion(): number {
    const row = this.db.prepare("SELECT MAX(version) AS v FROM migrations").get() as
      | { v: number | null }
      | undefined;
    return Number(row?.v ?? 0);
  }

  close(): void {
    try {
      this.db.pragma("wal_checkpoint(TRUNCATE)");
    } catch {
      /* not in WAL mode */
    }
    this.db.close();
  }

  /** Escape hatch for maintenance/diagnostic queries. */
  get raw(): Database.Database {
    return this.db;
  }

  /* ---------------------------------------------------------------- */
  /* Config                                                            */
  /* ---------------------------------------------------------------- */

  readConfig(): StoredConfig {
    const rows = this.db
      .prepare("SELECT key, value, encrypted FROM config")
      .all() as Array<{ key: string; value: string; encrypted: number }>;
    const out: Record<string, string> = {};
    for (const row of rows) {
      try {
        out[row.key] = row.encrypted ? decrypt(row.value, this.secret) : row.value;
      } catch {
        /* wrong passphrase — skip the value rather than crash */
      }
    }
    return out as StoredConfig;
  }

  writeConfig(partial: Partial<StoredConfig>): void {
    const stmt = this.db.prepare(
      "INSERT INTO config (key, value, encrypted) VALUES (?, ?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, encrypted = excluded.encrypted"
    );
    const del = this.db.prepare("DELETE FROM config WHERE key = ?");
    const tx = this.db.transaction(() => {
      for (const [key, value] of Object.entries(partial)) {
        if (value === undefined || value === null || value === "") {
          del.run(key);
          continue;
        }
        const isSecret = SECRET_KEYS.includes(key as keyof StoredConfig);
        stmt.run(
          key,
          isSecret ? encrypt(String(value), this.secret) : String(value),
          isSecret ? 1 : 0
        );
      }
    });
    tx();
  }

  clearConfig(): void {
    this.db.prepare("DELETE FROM config").run();
  }

  /* ---------------------------------------------------------------- */
  /* Write-back journal (WriteBackJournal implementation)               */
  /* ---------------------------------------------------------------- */

  wasApplied(bridgeItemId: string): boolean {
    return (
      this.db
        .prepare("SELECT 1 AS ok FROM writeback_journal WHERE bridge_item_id = ?")
        .get(bridgeItemId) !== undefined
    );
  }

  markApplied(bridgeItemId: string, detail: WriteBackResult): void {
    this.db
      .prepare(
        "INSERT INTO writeback_journal (bridge_item_id, product_id, applied_at, detail) " +
          "VALUES (?, ?, ?, ?) ON CONFLICT(bridge_item_id) DO NOTHING"
      )
      .run(bridgeItemId, detail.product_id, new Date().toISOString(), JSON.stringify(detail));
  }

  journalSize(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM writeback_journal").get() as
      | { n: number }
      | undefined;
    return Number(row?.n ?? 0);
  }

  /* ---------------------------------------------------------------- */
  /* Job records                                                       */
  /* ---------------------------------------------------------------- */

  rememberJob(job: CachedJob): void {
    this.db
      .prepare(
        "INSERT INTO jobs (job_id, kind, product_ids, created_at, state, terminal, batch_id, model, preset_slug, options, estimated_credits, schedule_id) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(job_id) DO UPDATE SET state = excluded.state, terminal = excluded.terminal, " +
          "product_ids = excluded.product_ids, batch_id = COALESCE(excluded.batch_id, jobs.batch_id), " +
          "model = COALESCE(excluded.model, jobs.model), preset_slug = COALESCE(excluded.preset_slug, jobs.preset_slug), " +
          "options = COALESCE(excluded.options, jobs.options), " +
          "estimated_credits = COALESCE(excluded.estimated_credits, jobs.estimated_credits), " +
          "schedule_id = COALESCE(excluded.schedule_id, jobs.schedule_id)"
      )
      .run(
        job.job_id,
        job.kind,
        JSON.stringify(job.product_ids ?? []),
        job.created_at,
        job.state ? JSON.stringify(job.state) : null,
        job.terminal ? 1 : 0,
        job.batch_id ?? null,
        job.model ?? null,
        job.preset_slug ?? null,
        job.options ? JSON.stringify(job.options) : null,
        job.estimated_credits ?? null,
        job.schedule_id ?? null
      );
  }

  updateJobState(jobId: string, state: JobState, terminal: boolean): void {
    this.db
      .prepare("UPDATE jobs SET state = ?, terminal = ? WHERE job_id = ?")
      .run(JSON.stringify(state), terminal ? 1 : 0, jobId);
  }

  markJobTerminal(jobId: string): void {
    this.db.prepare("UPDATE jobs SET terminal = 1 WHERE job_id = ?").run(jobId);
  }

  private rowToJob(row: JobRowRaw): CachedJob {
    return {
      job_id: row.job_id,
      kind: row.kind as JobKind,
      product_ids: safeParse<number[]>(row.product_ids, []),
      created_at: row.created_at,
      state: row.state ? safeParse<JobState | undefined>(row.state, undefined) : undefined,
      terminal: row.terminal === 1,
      batch_id: row.batch_id,
      model: row.model,
      preset_slug: row.preset_slug,
      options: row.options ? safeParse<JobOptions | null>(row.options, null) : null,
      estimated_credits: row.estimated_credits,
      schedule_id: row.schedule_id,
    };
  }

  getJob(jobId: string): CachedJob | null {
    const row = this.db.prepare("SELECT * FROM jobs WHERE job_id = ?").get(jobId) as
      | JobRowRaw
      | undefined;
    return row ? this.rowToJob(row) : null;
  }

  listJobs(limit = 50, offset = 0): CachedJob[] {
    const rows = this.db
      .prepare("SELECT * FROM jobs ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?")
      .all(Math.min(Math.max(1, limit), 500), Math.max(0, offset)) as JobRowRaw[];
    return rows.map((r) => this.rowToJob(r));
  }

  /** Jobs not yet known to be terminal — used to resume after a restart. */
  listActiveJobs(): CachedJob[] {
    const rows = this.db
      .prepare("SELECT * FROM jobs WHERE terminal = 0 ORDER BY created_at ASC")
      .all() as JobRowRaw[];
    return rows
      .map((r) => this.rowToJob(r))
      .filter((j) => !j.state || !TERMINAL_JOB_STATUSES.includes(j.state.status));
  }

  listJobsByBatch(batchId: string): CachedJob[] {
    const rows = this.db
      .prepare("SELECT * FROM jobs WHERE batch_id = ? ORDER BY created_at ASC")
      .all(batchId) as JobRowRaw[];
    return rows.map((r) => this.rowToJob(r));
  }

  countJobs(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as
      | { n: number }
      | undefined;
    return Number(row?.n ?? 0);
  }

  /* ---------------------------------------------------------------- */
  /* Batches                                                           */
  /* ---------------------------------------------------------------- */

  createBatch(batch: Omit<JobBatch, "job_ids">): void {
    this.db
      .prepare(
        "INSERT INTO job_batches (batch_id, kind, created_at, total_items, estimated_credits, model, preset_slug, options, schedule_id, status) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(batch_id) DO UPDATE SET " +
          "total_items = excluded.total_items, estimated_credits = excluded.estimated_credits, status = excluded.status"
      )
      .run(
        batch.batch_id,
        batch.kind,
        batch.created_at,
        batch.total_items,
        batch.estimated_credits,
        batch.model ?? null,
        batch.preset_slug ?? null,
        batch.options ? JSON.stringify(batch.options) : null,
        batch.schedule_id ?? null,
        batch.status
      );
  }

  updateBatchStatus(batchId: string, status: string): void {
    this.db.prepare("UPDATE job_batches SET status = ? WHERE batch_id = ?").run(status, batchId);
  }

  getBatch(batchId: string): JobBatch | null {
    const row = this.db.prepare("SELECT * FROM job_batches WHERE batch_id = ?").get(batchId) as
      | {
          batch_id: string;
          kind: string;
          created_at: string;
          total_items: number;
          estimated_credits: number;
          model: string | null;
          preset_slug: string | null;
          options: string | null;
          schedule_id: number | null;
          status: string;
        }
      | undefined;
    if (!row) return null;
    const jobIds = (
      this.db
        .prepare("SELECT job_id FROM jobs WHERE batch_id = ? ORDER BY created_at ASC")
        .all(batchId) as Array<{ job_id: string }>
    ).map((r) => r.job_id);
    return {
      batch_id: row.batch_id,
      kind: row.kind as JobKind,
      created_at: row.created_at,
      job_ids: jobIds,
      total_items: Number(row.total_items),
      estimated_credits: Number(row.estimated_credits),
      model: row.model,
      preset_slug: row.preset_slug,
      options: row.options ? safeParse<JobOptions | null>(row.options, null) : null,
      schedule_id: row.schedule_id,
      status: row.status as JobBatch["status"],
    };
  }

  listBatches(limit = 25): JobBatch[] {
    const rows = this.db
      .prepare("SELECT batch_id FROM job_batches ORDER BY created_at DESC LIMIT ?")
      .all(Math.min(Math.max(1, limit), 200)) as Array<{ batch_id: string }>;
    return rows.map((r) => this.getBatch(r.batch_id)).filter((b): b is JobBatch => b !== null);
  }

  /* ---------------------------------------------------------------- */
  /* Webhook replay suppression                                        */
  /* ---------------------------------------------------------------- */

  /** Record a delivery id; returns false when it was already seen. */
  registerDelivery(deliveryId: string, event?: string, jobId?: string): boolean {
    const result = this.db
      .prepare(
        "INSERT INTO webhook_deliveries (delivery_id, received_at, event, job_id) " +
          "VALUES (?, ?, ?, ?) ON CONFLICT(delivery_id) DO NOTHING"
      )
      .run(deliveryId, new Date().toISOString(), event ?? null, jobId ?? null);
    return result.changes > 0;
  }

  /* ---------------------------------------------------------------- */
  /* Drafts: create                                                    */
  /* ---------------------------------------------------------------- */

  /**
   * Store a completed bridge job item as a pending draft. Idempotent per
   * bridge_item_id — re-collecting the same job never duplicates a draft.
   */
  createDraftFromItem(
    jobId: string,
    kind: JobKind,
    item: JobItem,
    before: DraftPayload["before"],
    extra: { locale?: string; setMainImage?: boolean } = {}
  ): DraftRow | null {
    const productId = Number(item.external_id);
    if (!Number.isFinite(productId) || productId <= 0) return null;

    const urls = (item.result?.image_urls ?? []).filter(
      (url): url is string => typeof url === "string" && url.length > 0
    );
    const images = urls.map((url, index) => {
      const image: NonNullable<DraftPayload["images"]>[number] = { url };
      const alt = item.result?.text?.alt_text;
      if (alt) image.alt_text = alt;
      if (extra.setMainImage === true && index === 0) image.main = true;
      return image;
    });

    const payload: DraftPayload = {};
    if (images.length > 0) payload.images = images;
    if (item.result?.text && Object.keys(item.result.text).length > 0) {
      payload.text = item.result.text;
    }
    if (before && Object.keys(before).length > 0) payload.before = before;
    if (extra.locale) payload.locale = extra.locale;
    if (!payload.images?.length && !payload.text) return null;

    const type: DraftType =
      payload.images?.length && payload.text
        ? "mixed"
        : payload.images?.length
          ? "images"
          : "text";

    const itemId = String(item.id ?? item.external_id);
    const bridgeItemId = item.id ? String(item.id) : `${jobId}:${item.external_id}`;

    this.db
      .prepare(
        "INSERT INTO drafts (product_id, variant_id, job_id, item_id, bridge_item_id, kind, type, status, payload, created_at, attempts) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 0) " +
          "ON CONFLICT(bridge_item_id) DO NOTHING"
      )
      .run(
        productId,
        item.variant_id ?? null,
        jobId,
        itemId,
        bridgeItemId,
        kind,
        type,
        JSON.stringify(payload),
        new Date().toISOString()
      );

    return this.getDraftByBridgeItem(bridgeItemId);
  }

  /* ---------------------------------------------------------------- */
  /* Drafts: read                                                      */
  /* ---------------------------------------------------------------- */

  private rowToDraft(row: DraftRowRaw): DraftRow {
    return {
      id: row.id,
      product_id: row.product_id,
      variant_id: row.variant_id ?? null,
      job_id: row.job_id,
      item_id: row.item_id,
      bridge_item_id: row.bridge_item_id ?? `${row.job_id}:${row.item_id}`,
      kind: row.kind as JobKind,
      type: row.type as DraftType,
      status: row.status as DraftStatus,
      payload: safeParse<DraftPayload>(row.payload, {}),
      created_at: row.created_at,
      decided_at: row.decided_at,
      decided_by: row.decided_by,
      applied_at: row.applied_at,
      attempts: Number(row.attempts ?? 0),
      error: row.error,
    };
  }

  listDrafts(filter: DraftFilter = {}): DraftRow[] {
    const clauses: string[] = [];
    const args: unknown[] = [];
    if (filter.status) {
      clauses.push("status = ?");
      args.push(filter.status);
    }
    if (filter.jobId) {
      clauses.push("job_id = ?");
      args.push(filter.jobId);
    }
    if (filter.productId !== undefined) {
      clauses.push("product_id = ?");
      args.push(filter.productId);
    }
    if (filter.kind) {
      clauses.push("kind = ?");
      args.push(filter.kind);
    }
    if (filter.type) {
      clauses.push("type = ?");
      args.push(filter.type);
    }
    if (filter.search) {
      clauses.push("(payload LIKE ? ESCAPE '\\' OR CAST(product_id AS TEXT) LIKE ? ESCAPE '\\')");
      const like = `%${filter.search.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
      args.push(like, like);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    const limit = Math.min(Math.max(1, filter.limit ?? 500), 2000);
    const offset = Math.max(0, filter.offset ?? 0);
    const rows = this.db
      .prepare(
        `SELECT ${DRAFT_COLUMNS} FROM drafts${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
      )
      .all(...args, limit, offset) as DraftRowRaw[];
    return rows.map((r) => this.rowToDraft(r));
  }

  countDraftsFiltered(filter: DraftFilter = {}): number {
    const clauses: string[] = [];
    const args: unknown[] = [];
    if (filter.status) {
      clauses.push("status = ?");
      args.push(filter.status);
    }
    if (filter.jobId) {
      clauses.push("job_id = ?");
      args.push(filter.jobId);
    }
    if (filter.kind) {
      clauses.push("kind = ?");
      args.push(filter.kind);
    }
    if (filter.productId !== undefined) {
      clauses.push("product_id = ?");
      args.push(filter.productId);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM drafts${where}`).get(...args) as
      | { n: number }
      | undefined;
    return Number(row?.n ?? 0);
  }

  /** Draft counts per status, for the dashboard KPI row. */
  countDrafts(): Record<DraftStatus, number> {
    const rows = this.db
      .prepare("SELECT status, COUNT(*) AS n FROM drafts GROUP BY status")
      .all() as Array<{ status: string; n: number }>;
    const out: Record<DraftStatus, number> = {
      pending: 0,
      applying: 0,
      approved: 0,
      rejected: 0,
      failed: 0,
    };
    for (const row of rows) {
      if (row.status in out) out[row.status as DraftStatus] = Number(row.n);
    }
    return out;
  }

  getDraft(id: number): DraftRow | null {
    const row = this.db.prepare(`SELECT ${DRAFT_COLUMNS} FROM drafts WHERE id = ?`).get(id) as
      | DraftRowRaw
      | undefined;
    return row ? this.rowToDraft(row) : null;
  }

  getDraftByItem(jobId: string, itemId: string): DraftRow | null {
    const row = this.db
      .prepare(`SELECT ${DRAFT_COLUMNS} FROM drafts WHERE job_id = ? AND item_id = ?`)
      .get(jobId, itemId) as DraftRowRaw | undefined;
    return row ? this.rowToDraft(row) : null;
  }

  getDraftByBridgeItem(bridgeItemId: string): DraftRow | null {
    const row = this.db
      .prepare(`SELECT ${DRAFT_COLUMNS} FROM drafts WHERE bridge_item_id = ?`)
      .get(bridgeItemId) as DraftRowRaw | undefined;
    return row ? this.rowToDraft(row) : null;
  }

  /* ---------------------------------------------------------------- */
  /* Drafts: approve — the ONLY path that writes to the live product    */
  /* ---------------------------------------------------------------- */

  /**
   * Claim a pending/failed draft for application. Returns the row when this
   * caller won the claim, null when another worker already holds it. The
   * compare-and-set happens inside a SQLite transaction, so two concurrent
   * approve calls can never both write to Shoper.
   */
  private claimDraft(id: number): DraftRow | null {
    const claim = this.db.transaction((draftId: number): DraftRow | null => {
      const result = this.db
        .prepare(
          "UPDATE drafts SET status = 'applying', attempts = attempts + 1, error = NULL " +
            "WHERE id = ? AND status IN ('pending', 'failed')"
        )
        .run(draftId);
      if (result.changes === 0) return null;
      const row = this.db
        .prepare(`SELECT ${DRAFT_COLUMNS} FROM drafts WHERE id = ?`)
        .get(draftId) as DraftRowRaw | undefined;
      return row ? this.rowToDraft(row) : null;
    });
    return claim(id);
  }

  /** Commit a claimed draft to a final state. */
  private settleDraft(
    id: number,
    status: DraftStatus,
    options: { error?: string | null; decidedBy?: string; applied?: boolean } = {}
  ): void {
    const now = new Date().toISOString();
    const decided = status === "approved" || status === "rejected";
    this.db
      .prepare(
        "UPDATE drafts SET status = ?, error = ?, " +
          "decided_at = CASE WHEN ? = 1 THEN COALESCE(decided_at, ?) ELSE decided_at END, " +
          "decided_by = CASE WHEN ? IS NOT NULL THEN ? ELSE decided_by END, " +
          "applied_at = CASE WHEN ? = 1 THEN ? ELSE applied_at END " +
          "WHERE id = ?"
      )
      .run(
        status,
        options.error ?? null,
        decided ? 1 : 0,
        now,
        options.decidedBy ?? null,
        options.decidedBy ?? null,
        options.applied ? 1 : 0,
        now,
        id
      );
  }

  /**
   * Approve one draft: write its images/text to the live Shoper product, then
   * mark the draft approved.
   *
   * Transaction discipline: the row is first claimed (pending -> applying)
   * inside a SQLite transaction, then the remote write runs OUTSIDE the
   * transaction (network IO must never hold a write lock), and only on success
   * is the row committed to `approved`. If the remote write throws, the row is
   * rolled back to `failed` with the error recorded and nothing is marked
   * approved — a retry is safe because the write-back journal suppresses a
   * duplicate image upload.
   */
  async approveDraft(
    id: number,
    shoper: ShoperClient,
    options: { decidedBy?: string; writeBack?: WriteBackOptions } = {}
  ): Promise<ApplyResult> {
    const existing = this.getDraft(id);
    if (!existing) throw new Error(`Draft not found: ${id}`);
    if (existing.status === "approved") {
      return {
        product_id: existing.product_id,
        applied_images: 0,
        applied_fields: [],
        skipped: ["already_approved"],
      };
    }
    if (existing.status === "rejected") {
      throw new Error(`Draft ${id} was rejected and cannot be approved`);
    }

    const draft = this.claimDraft(id);
    if (!draft) throw new Error(`Draft ${id} is already being applied`);

    const writeBackOptions: WriteBackOptions = { ...options.writeBack, journal: this };
    const locale = draft.payload.locale ?? options.writeBack?.locale;
    if (locale) writeBackOptions.locale = locale;
    const writeBack = new ShoperWriteBack(shoper, writeBackOptions);

    try {
      const applied = draft.variant_id
        ? await writeBack.applyVariantImages(
            draft.product_id,
            Number(draft.variant_id),
            draft.payload,
            draft.bridge_item_id
          )
        : await writeBack.apply(draft.product_id, draft.payload, draft.bridge_item_id);
      this.settleDraft(id, "approved", {
        error: null,
        decidedBy: options.decidedBy ?? "admin",
        applied: true,
      });
      return {
        product_id: applied.product_id,
        applied_images: applied.applied_images,
        applied_fields: applied.applied_fields,
        skipped: applied.skipped,
        warnings: applied.warnings,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Roll the claim back so the merchant can retry from the UI. The draft
      // is NOT approved and the live product keeps whatever partial state the
      // remote call left (images are additive, so this is always safe).
      this.settleDraft(id, "failed", { error: message.slice(0, 2000) });
      throw err;
    }
  }

  /** Approve all pending drafts (optionally scoped to one job). */
  async approveAll(
    shoper: ShoperClient,
    jobId?: string,
    options: { decidedBy?: string; writeBack?: WriteBackOptions } = {}
  ): Promise<BulkApproveResult> {
    const filter: DraftFilter = { status: "pending" };
    if (jobId) filter.jobId = jobId;
    const pending = this.listDrafts(filter);
    return this.approveMany(
      shoper,
      pending.map((d) => d.id),
      options
    );
  }

  /**
   * Approve an explicit list of drafts, collecting per-item errors so one bad
   * product never aborts the batch. Sequential on purpose: the Shoper webapi
   * bucket is small and image uploads are large, so parallelism here only
   * produces 429s.
   */
  async approveMany(
    shoper: ShoperClient,
    ids: readonly number[],
    options: { decidedBy?: string; writeBack?: WriteBackOptions } = {}
  ): Promise<BulkApproveResult> {
    const approved: ApplyResult[] = [];
    const failed: Array<{ id: number; error: string }> = [];
    for (const id of ids) {
      try {
        approved.push(await this.approveDraft(id, shoper, options));
      } catch (err) {
        failed.push({ id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { approved, failed };
  }

  /** Reject (discard) a draft. The live product is untouched. */
  rejectDraft(id: number, decidedBy = "admin"): boolean {
    const result = this.db
      .prepare(
        "UPDATE drafts SET status = 'rejected', decided_at = ?, decided_by = ?, error = NULL " +
          "WHERE id = ? AND status != 'approved'"
      )
      .run(new Date().toISOString(), decidedBy, id);
    return result.changes > 0;
  }

  rejectMany(ids: readonly number[], decidedBy = "admin"): number {
    const stmt = this.db.prepare(
      "UPDATE drafts SET status = 'rejected', decided_at = ?, decided_by = ?, error = NULL " +
        "WHERE id = ? AND status != 'approved'"
    );
    const now = new Date().toISOString();
    let count = 0;
    const tx = this.db.transaction(() => {
      for (const id of ids) count += stmt.run(now, decidedBy, id).changes;
    });
    tx();
    return count;
  }

  /** Reset a failed/stuck draft back to pending so it can be retried. */
  resetDraft(id: number): boolean {
    const result = this.db
      .prepare(
        "UPDATE drafts SET status = 'pending', error = NULL WHERE id = ? AND status IN ('failed', 'applying')"
      )
      .run(id);
    return result.changes > 0;
  }

  /**
   * Release drafts stuck in `applying` (process crashed mid-write) so they can
   * be retried. Called on boot.
   */
  recoverStuckDrafts(): number {
    const result = this.db
      .prepare(
        "UPDATE drafts SET status = 'failed', error = COALESCE(error, 'interrupted before completion') " +
          "WHERE status = 'applying'"
      )
      .run();
    return result.changes;
  }

  /* ---------------------------------------------------------------- */
  /* Retention                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Delete decided (approved/rejected) drafts older than the retention
   * window, plus stale webhook delivery ids and orphaned terminal jobs. The
   * write-back journal is deliberately kept: it is tiny and it is what
   * prevents a duplicate image upload forever.
   */
  cleanup(retentionDays: number = this.retentionDays): {
    drafts: number;
    deliveries: number;
    jobs: number;
  } {
    const days = Math.max(1, retentionDays);
    const draftCutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const deliveryCutoff = new Date(
      Date.now() - this.webhookRetentionDays * 86_400_000
    ).toISOString();
    const jobCutoff = new Date(Date.now() - days * 2 * 86_400_000).toISOString();

    const tx = this.db.transaction(() => {
      const drafts = this.db
        .prepare(
          "DELETE FROM drafts WHERE status IN ('approved', 'rejected') " +
            "AND COALESCE(decided_at, applied_at, created_at) <= ?"
        )
        .run(draftCutoff).changes;
      const deliveries = this.db
        .prepare("DELETE FROM webhook_deliveries WHERE received_at <= ?")
        .run(deliveryCutoff).changes;
      const jobs = this.db
        .prepare(
          "DELETE FROM jobs WHERE terminal = 1 AND created_at <= ? " +
            "AND job_id NOT IN (SELECT DISTINCT job_id FROM drafts)"
        )
        .run(jobCutoff).changes;
      return { drafts, deliveries, jobs };
    });
    return tx();
  }

  /** Reclaim space after a large cleanup. */
  vacuum(): void {
    this.db.exec("VACUUM");
  }

  /* ---------------------------------------------------------------- */
  /* Schedules                                                         */
  /* ---------------------------------------------------------------- */

  private rowToSchedule(row: ScheduleRowRaw): ScheduleDefinition {
    return {
      id: row.id,
      name: row.name,
      task: row.task as ScheduleTask,
      enabled: row.enabled === 1,
      hour: Number(row.hour),
      minute: Number(row.minute),
      interval_days: Number(row.interval_days),
      max_credits_per_run: Number(row.max_credits_per_run),
      max_items_per_run: Number(row.max_items_per_run),
      model: row.model,
      preset_slug: row.preset_slug,
      options: row.options ? safeParse<JobOptions | null>(row.options, null) : null,
      last_run_at: row.last_run_at,
      last_run_status: row.last_run_status,
      last_run_detail: row.last_run_detail,
      next_run_at: row.next_run_at,
      created_at: row.created_at,
    };
  }

  createSchedule(input: ScheduleInput): ScheduleDefinition {
    const result = this.db
      .prepare(
        "INSERT INTO schedules (name, task, enabled, hour, minute, interval_days, max_credits_per_run, max_items_per_run, model, preset_slug, options, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        input.name,
        input.task,
        input.enabled ? 1 : 0,
        clampInt(input.hour, 0, 23),
        clampInt(input.minute, 0, 59),
        clampInt(input.interval_days, 1, 365),
        Math.max(0, Number(input.max_credits_per_run) || 0),
        clampInt(input.max_items_per_run, 1, 5000),
        input.model ?? null,
        input.preset_slug ?? null,
        input.options ? JSON.stringify(input.options) : null,
        new Date().toISOString()
      );
    const created = this.getSchedule(Number(result.lastInsertRowid));
    if (!created) throw new Error("Failed to persist schedule");
    return created;
  }

  updateSchedule(id: number, patch: Partial<ScheduleInput>): ScheduleDefinition | null {
    const existing = this.getSchedule(id);
    if (!existing) return null;
    const merged: ScheduleInput = {
      name: patch.name ?? existing.name,
      task: patch.task ?? existing.task,
      enabled: patch.enabled ?? existing.enabled,
      hour: patch.hour ?? existing.hour,
      minute: patch.minute ?? existing.minute,
      interval_days: patch.interval_days ?? existing.interval_days,
      max_credits_per_run: patch.max_credits_per_run ?? existing.max_credits_per_run,
      max_items_per_run: patch.max_items_per_run ?? existing.max_items_per_run,
      model: patch.model !== undefined ? patch.model : existing.model,
      preset_slug: patch.preset_slug !== undefined ? patch.preset_slug : existing.preset_slug,
      options: patch.options !== undefined ? patch.options : existing.options,
    };
    this.db
      .prepare(
        "UPDATE schedules SET name = ?, task = ?, enabled = ?, hour = ?, minute = ?, interval_days = ?, " +
          "max_credits_per_run = ?, max_items_per_run = ?, model = ?, preset_slug = ?, options = ? WHERE id = ?"
      )
      .run(
        merged.name,
        merged.task,
        merged.enabled ? 1 : 0,
        clampInt(merged.hour, 0, 23),
        clampInt(merged.minute, 0, 59),
        clampInt(merged.interval_days, 1, 365),
        Math.max(0, Number(merged.max_credits_per_run) || 0),
        clampInt(merged.max_items_per_run, 1, 5000),
        merged.model ?? null,
        merged.preset_slug ?? null,
        merged.options ? JSON.stringify(merged.options) : null,
        id
      );
    return this.getSchedule(id);
  }

  deleteSchedule(id: number): boolean {
    return this.db.prepare("DELETE FROM schedules WHERE id = ?").run(id).changes > 0;
  }

  getSchedule(id: number): ScheduleDefinition | null {
    const row = this.db.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as
      | ScheduleRowRaw
      | undefined;
    return row ? this.rowToSchedule(row) : null;
  }

  listSchedules(onlyEnabled = false): ScheduleDefinition[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM schedules${onlyEnabled ? " WHERE enabled = 1" : ""} ORDER BY id ASC`
      )
      .all() as ScheduleRowRaw[];
    return rows.map((r) => this.rowToSchedule(r));
  }

  recordScheduleRun(
    id: number,
    status: string,
    detail: string,
    nextRunAt: string | null
  ): void {
    this.db
      .prepare(
        "UPDATE schedules SET last_run_at = ?, last_run_status = ?, last_run_detail = ?, next_run_at = ? WHERE id = ?"
      )
      .run(new Date().toISOString(), status, detail.slice(0, 1000), nextRunAt, id);
  }

  setScheduleNextRun(id: number, nextRunAt: string | null): void {
    this.db.prepare("UPDATE schedules SET next_run_at = ? WHERE id = ?").run(nextRunAt, id);
  }

  /* ---------------------------------------------------------------- */
  /* Stats                                                             */
  /* ---------------------------------------------------------------- */

  stats(): {
    schema_version: number;
    drafts: Record<DraftStatus, number>;
    jobs: number;
    batches: number;
    journal: number;
    schedules: number;
  } {
    const count = (table: string): number => {
      const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as
        | { n: number }
        | undefined;
      return Number(row?.n ?? 0);
    };
    return {
      schema_version: this.schemaVersion,
      drafts: this.countDrafts(),
      jobs: count("jobs"),
      batches: count("job_batches"),
      journal: count("writeback_journal"),
      schedules: count("schedules"),
    };
  }
}

/* -------------------------------------------------------------------- */
/* Helpers                                                               */
/* -------------------------------------------------------------------- */

function safeParse<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function clampInt(value: number, min: number, max: number): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/** Constant-time string comparison (CSRF tokens). */
export function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Re-export so existing importers of draft-store keep working. */
export { textToTranslationPatch as textToTranslationUpdate } from "./writeback";
