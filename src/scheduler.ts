/**
 * Recurring-job scheduler.
 *
 * Definitions live in SQLite (`schedules`), so a restart never loses a
 * schedule and `last_run_at` survives. The runtime is a single node timer that
 * ticks once a minute and executes any schedule whose next-run time has
 * passed; there is no cron dependency and no separate process.
 *
 * Built-in tasks:
 *   descriptions_missing — products whose plain-text description is shorter
 *                          than MISSING_DESCRIPTION_MAX get an AI description
 *   alt_text_missing     — products with images lacking ALT text get ALT text
 *   bg_remove_new        — recently added products get background removal
 *   upscale_small        — recently edited products get an upscale pass
 *
 * Every run is credit-guarded: the orchestrator's preflight runs first and the
 * run aborts when the estimate exceeds `max_credits_per_run`, so an unattended
 * nightly job can never drain a merchant's balance. Results land as pending
 * drafts exactly like a manual run — the scheduler never writes to the store.
 */

import { JobOrchestrator, BulkRunOptions } from "./jobs";
import { DraftStore } from "./draft-store";
import {
  JobKind,
  JobOptions,
  Language,
  LogSink,
  ProductQuery,
  ScheduleDefinition,
  ScheduleInput,
  ScheduleTask,
  Tone,
} from "./types";

/** Description shorter than this counts as "missing". */
export const MISSING_DESCRIPTION_MAX = 20;
/** How often the scheduler wakes up. */
export const TICK_INTERVAL_MS = 60_000;

export interface SchedulerDeps {
  store: DraftStore;
  /**
   * Lazily builds an orchestrator. Called per run so credential changes and
   * reconnects are picked up without restarting the process, and so a
   * disconnected app simply skips runs instead of crashing the timer.
   */
  getOrchestrator: () => JobOrchestrator;
  logger?: LogSink;
  /** Injectable clock (tests). */
  now?: () => number;
}

export interface ScheduleRunResult {
  schedule_id: number;
  task: ScheduleTask;
  status: "skipped" | "submitted" | "blocked" | "error";
  detail: string;
  batch_id?: string;
  items?: number;
  estimated_credits?: number;
  next_run_at?: string | null;
}

interface TaskSpec {
  kind: JobKind;
  filter: (schedule: ScheduleDefinition) => ProductQuery;
  options: (schedule: ScheduleDefinition) => JobOptions;
  /** Requires an image model. */
  needsModel: boolean;
}

const TASKS: Record<ScheduleTask, TaskSpec> = {
  descriptions_missing: {
    kind: "description",
    filter: () => ({
      maxDescriptionLength: MISSING_DESCRIPTION_MAX,
      sort: "newest",
    }),
    options: (schedule) => ({
      language: (schedule.options?.language as Language | undefined) ?? "pl",
      tone: (schedule.options?.tone as Tone | undefined) ?? "professional",
      ...schedule.options,
    }),
    needsModel: false,
  },
  alt_text_missing: {
    kind: "alt_text",
    filter: () => ({ missingAltText: true, sort: "newest" }),
    options: (schedule) => ({
      language: (schedule.options?.language as Language | undefined) ?? "pl",
      ...schedule.options,
    }),
    needsModel: false,
  },
  bg_remove_new: {
    kind: "bg_remove",
    filter: (schedule) => ({
      addedAfter: isoDaysAgo(Math.max(1, schedule.interval_days) * 2),
      sort: "newest",
    }),
    options: (schedule) => ({ ...schedule.options }),
    needsModel: true,
  },
  upscale_small: {
    kind: "upscale",
    filter: (schedule) => ({
      editedAfter: isoDaysAgo(Math.max(1, schedule.interval_days) * 2),
      sort: "newest",
    }),
    options: (schedule) => ({ ...schedule.options }),
    needsModel: true,
  },
};

/* -------------------------------------------------------------------- */
/* Scheduler                                                             */
/* -------------------------------------------------------------------- */

export class Scheduler {
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private readonly running = new Set<number>();
  private readonly now: () => number;

  constructor(private readonly deps: SchedulerDeps) {
    this.now = deps.now ?? Date.now;
  }

  private log(
    level: "debug" | "info" | "warn" | "error",
    msg: string,
    meta?: Record<string, unknown>
  ): void {
    if (!this.deps.logger) return;
    try {
      this.deps.logger(meta ? { level, msg, meta } : { level, msg });
    } catch {
      /* ignore */
    }
  }

  /** Start ticking. Idempotent. */
  start(): void {
    if (this.timer) return;
    // Backfill next_run_at for schedules that never had one computed.
    for (const schedule of this.deps.store.listSchedules()) {
      if (schedule.enabled && !schedule.next_run_at) {
        this.deps.store.setScheduleNextRun(
          schedule.id,
          nextRunAt(schedule, this.now()).toISOString()
        );
      }
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, TICK_INTERVAL_MS);
    // Do not keep the event loop alive purely for the scheduler.
    this.timer.unref?.();
    this.log("info", "scheduler started");
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
      this.log("info", "scheduler stopped");
    }
  }

  get isRunning(): boolean {
    return this.timer !== undefined;
  }

  /** Schedules currently executing (surfaced in /api/schedules). */
  get activeRuns(): number[] {
    return [...this.running];
  }

  /** One scheduler tick: run every schedule that is due. */
  async tick(): Promise<ScheduleRunResult[]> {
    if (this.ticking) return [];
    this.ticking = true;
    const results: ScheduleRunResult[] = [];
    try {
      const due = this.dueSchedules();
      for (const schedule of due) {
        results.push(await this.runSchedule(schedule.id, { respectDueTime: true }));
      }
    } finally {
      this.ticking = false;
    }
    return results;
  }

  /** Schedules whose next run time has passed. */
  dueSchedules(at: number = this.now()): ScheduleDefinition[] {
    return this.deps.store.listSchedules(true).filter((schedule) => {
      if (this.running.has(schedule.id)) return false;
      const next = schedule.next_run_at
        ? Date.parse(schedule.next_run_at)
        : nextRunAt(schedule, at).getTime();
      return Number.isFinite(next) && next <= at;
    });
  }

  /**
   * Execute one schedule now. `respectDueTime` is set by the tick loop;
   * a manual "Run now" from the UI passes false.
   */
  async runSchedule(
    scheduleId: number,
    options: { respectDueTime?: boolean; dryRun?: boolean } = {}
  ): Promise<ScheduleRunResult> {
    const schedule = this.deps.store.getSchedule(scheduleId);
    if (!schedule) {
      return {
        schedule_id: scheduleId,
        task: "descriptions_missing",
        status: "error",
        detail: "schedule not found",
      };
    }
    if (this.running.has(scheduleId)) {
      return {
        schedule_id: scheduleId,
        task: schedule.task,
        status: "skipped",
        detail: "already running",
      };
    }
    if (options.respectDueTime && !schedule.enabled) {
      return {
        schedule_id: scheduleId,
        task: schedule.task,
        status: "skipped",
        detail: "disabled",
      };
    }

    const spec = TASKS[schedule.task];
    if (!spec) {
      const detail = `unknown task: ${schedule.task}`;
      this.deps.store.recordScheduleRun(scheduleId, "error", detail, null);
      return { schedule_id: scheduleId, task: schedule.task, status: "error", detail };
    }

    this.running.add(scheduleId);
    const next = nextRunAt(schedule, this.now(), true).toISOString();
    try {
      const orchestrator = this.deps.getOrchestrator();
      const runOptions: BulkRunOptions = {
        filter: spec.filter(schedule),
        options: spec.options(schedule),
        maxItems: schedule.max_items_per_run,
        maxCredits: schedule.max_credits_per_run,
        scheduleId,
      };
      if (schedule.model) runOptions.model = schedule.model;
      else if (spec.needsModel) runOptions.model = undefined;
      if (schedule.preset_slug) runOptions.presetSlug = schedule.preset_slug;

      // Preflight first: this is where the credit guard bites.
      const preflight = await orchestrator.preflight(spec.kind, runOptions);
      if (preflight.blocked) {
        const status = preflight.blocked.reason === "no_products" ? "skipped" : "blocked";
        this.deps.store.recordScheduleRun(
          scheduleId,
          status,
          preflight.blocked.detail,
          next
        );
        this.log("info", `schedule ${scheduleId} ${status}: ${preflight.blocked.detail}`);
        return {
          schedule_id: scheduleId,
          task: schedule.task,
          status,
          detail: preflight.blocked.detail,
          items: preflight.num_items,
          next_run_at: next,
        };
      }

      if (options.dryRun) {
        const detail = `dry run: ${preflight.num_items} products, ~${
          preflight.estimate?.total_credits ?? 0
        } credits`;
        return {
          schedule_id: scheduleId,
          task: schedule.task,
          status: "skipped",
          detail,
          items: preflight.num_items,
          estimated_credits: preflight.estimate?.total_credits ?? 0,
          next_run_at: next,
        };
      }

      const handle = await orchestrator.run(spec.kind, {
        ...runOptions,
        productIds: preflight.product_ids,
        skipEstimate: true,
      });
      const detail = `submitted ${handle.total_items} items in ${handle.job_ids.length} job(s), ~${handle.estimated_credits} credits`;
      this.deps.store.recordScheduleRun(scheduleId, "submitted", detail, next);
      this.log("info", `schedule ${scheduleId} submitted`, {
        batch_id: handle.batch_id,
        items: handle.total_items,
      });
      return {
        schedule_id: scheduleId,
        task: schedule.task,
        status: "submitted",
        detail,
        batch_id: handle.batch_id,
        items: handle.total_items,
        estimated_credits: handle.estimated_credits,
        next_run_at: next,
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.deps.store.recordScheduleRun(scheduleId, "error", detail, next);
      this.log("error", `schedule ${scheduleId} failed: ${detail}`);
      return {
        schedule_id: scheduleId,
        task: schedule.task,
        status: "error",
        detail,
        next_run_at: next,
      };
    } finally {
      this.running.delete(scheduleId);
    }
  }

  /* ---------------------------------------------------------------- */
  /* CRUD passthrough (keeps next_run_at consistent)                   */
  /* ---------------------------------------------------------------- */

  create(input: ScheduleInput): ScheduleDefinition {
    const created = this.deps.store.createSchedule(input);
    if (created.enabled) {
      this.deps.store.setScheduleNextRun(
        created.id,
        nextRunAt(created, this.now()).toISOString()
      );
    }
    return this.deps.store.getSchedule(created.id) ?? created;
  }

  update(id: number, patch: Partial<ScheduleInput>): ScheduleDefinition | null {
    const updated = this.deps.store.updateSchedule(id, patch);
    if (!updated) return null;
    this.deps.store.setScheduleNextRun(
      id,
      updated.enabled ? nextRunAt(updated, this.now()).toISOString() : null
    );
    return this.deps.store.getSchedule(id);
  }

  setEnabled(id: number, enabled: boolean): ScheduleDefinition | null {
    return this.update(id, { enabled });
  }

  remove(id: number): boolean {
    return this.deps.store.deleteSchedule(id);
  }

  list(): ScheduleDefinition[] {
    return this.deps.store.listSchedules();
  }

  /** Task catalogue for the settings UI. */
  static get tasks(): Array<{ task: ScheduleTask; kind: JobKind; needs_model: boolean }> {
    return (Object.keys(TASKS) as ScheduleTask[]).map((task) => ({
      task,
      kind: TASKS[task].kind,
      needs_model: TASKS[task].needsModel,
    }));
  }
}

/* -------------------------------------------------------------------- */
/* Time maths                                                            */
/* -------------------------------------------------------------------- */

/**
 * Next occurrence of the schedule's local hour:minute, honouring
 * interval_days from the last run.
 *
 * `afterRun` forces the result strictly into the future (used right after a
 * run so the same tick cannot fire twice).
 */
export function nextRunAt(
  schedule: Pick<ScheduleDefinition, "hour" | "minute" | "interval_days" | "last_run_at">,
  from: number = Date.now(),
  afterRun = false
): Date {
  const interval = Math.max(1, Math.floor(schedule.interval_days || 1));
  const base = new Date(from);
  const candidate = new Date(base);
  candidate.setHours(clamp(schedule.hour, 0, 23), clamp(schedule.minute, 0, 59), 0, 0);

  if (candidate.getTime() <= from || afterRun) {
    candidate.setDate(candidate.getDate() + 1);
  }

  // Respect the interval relative to the last successful run.
  const lastRun = afterRun ? from : schedule.last_run_at ? Date.parse(schedule.last_run_at) : NaN;
  if (Number.isFinite(lastRun)) {
    const earliest = lastRun + interval * 86_400_000;
    while (candidate.getTime() < earliest) {
      candidate.setDate(candidate.getDate() + 1);
    }
  }
  return candidate;
}

function clamp(value: number, min: number, max: number): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - Math.max(0, days) * 86_400_000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
}

/** Exported for the settings UI + tests. */
export const SCHEDULE_TASK_SPECS = TASKS;
