/**
 * The core's D1 batch: one entry becomes guards, statements and post-guards over the four tables that
 * `LedgerConfig` names. Nothing here reads what a kind or an evidence kind means: the policy decides.
 * A host's own work joins the same batch through a `HostExtension`.
 */
import { judge } from "./judge";
import type { BatchPlan, CoreGuard, HostExtension, LedgerConfig, LedgerStore, RefusalError } from "./store";
import type { Closure, Entry, EvidenceRule, JudgeState, Policy, Requirement, Verdict } from "./types";

const PLAIN_NAME = /^[a-z_][a-z0-9_]*$/;

/** A name from the config, checked before it is written into SQL: names come from code, never from input. */
function plain(name: string): string {
  if (!PLAIN_NAME.test(name)) throw new Error(`not a plain SQL name: ${name}`);
  return name;
}

/** A kind from the policy, as a SQL string literal. */
function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** The count bound of a requirement, as SQL: `min` and `max` both inclusive, an absent bound is open. */
function holdsSql(req: Requirement): string {
  const count = `(SELECT count(*) FROM e WHERE kind = ${literal(req.kind)})`;
  const bounds: string[] = [];
  if (req.min !== undefined) bounds.push(`${count} >= ${wholeNumber(req.min)}`);
  if (req.max !== undefined) bounds.push(`${count} <= ${wholeNumber(req.max)}`);
  return bounds.length === 0 ? "1" : `(${bounds.join(" AND ")})`;
}

function wholeNumber(value: number): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(`not a count: ${value}`);
  return value;
}

/** The first rule whose `when` holds decides; its `require` gives 1 or NULL. No rule holding gives NULL. */
function rulesSql(rules: readonly EvidenceRule[]): string {
  let arms = "";
  let fallback = "NULL";
  for (const rule of rules) {
    const satisfied = rule.require.length === 0 ? "1" : `CASE WHEN ${rule.require.map(holdsSql).join(" AND ")} THEN 1 END`;
    if (rule.when === undefined) {
      fallback = satisfied;
      break;
    }
    arms += ` WHEN ${holdsSql(rule.when)} THEN ${satisfied}`;
  }
  return arms === "" ? fallback : `CASE${arms} ELSE ${fallback} END`;
}

/**
 * The post-guard: the fact rests on the evidence its kind's policy rules require. Holds when the fact is absent,
 * so the fence's re-check after a rolled-back batch reports the real cause. A kind the policy doesn't name, or
 * a fact with no evidence at all, is NULL (refused). Bind four values: scope, fact id, scope, fact id.
 */
export function compileEvidence(policy: Policy, config: LedgerConfig): string {
  const scope = plain(config.columns.scope);
  const facts = plain(config.tables.facts);
  const evidence = plain(config.tables.evidence);
  const arms = Object.entries(policy.kinds).map(([kind, { evidence: rules }]) => `WHEN (SELECT kind FROM f) = ${literal(kind)} THEN ${rulesSql(rules)}`);
  return `WITH
    f AS (SELECT kind FROM ${facts} WHERE ${scope} = ? AND id = ?),
    e AS (SELECT kind FROM ${evidence} WHERE ${scope} = ? AND fact_id = ?)
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM f) THEN 1
    WHEN NOT EXISTS (SELECT 1 FROM e) THEN NULL
    ${arms.join("\n    ")}
    ELSE NULL
  END`;
}

/**
 * Every dependency and its ancestors exist in this scope and none is closed in a way that kills it (see
 * `killingClosure`). Bind: the dependencies as JSON, then the scope four times. 1 when the gate is open, NULL otherwise.
 */
function dependenciesLiveSql(config: LedgerConfig): string {
  const scope = plain(config.columns.scope);
  return `WITH RECURSIVE ancestors(id) AS (
    SELECT value FROM json_each(?)
    UNION
    SELECT d.depends_on_fact_id FROM ${plain(config.tables.dependencies)} d
    JOIN ancestors a ON d.fact_id = a.id WHERE d.${scope} = ?
  )
  SELECT CASE WHEN NOT EXISTS (${killingClosure(config)}) AND (SELECT count(*) FROM ${plain(config.tables.facts)} f JOIN ancestors a ON f.id = a.id WHERE f.${scope} = ?)
      = (SELECT count(*) FROM ancestors) THEN 1 END`;
}

/**
 * A closure that kills a fact reached through `ancestors`. A supersede by another ancestor doesn't: v2 depends on
 * v1 and closes it `superseded`, so v2 stays live while whatever rests on v1 alone dies with it. Binds one scope.
 */
function killingClosure(config: LedgerConfig): string {
  const scope = plain(config.columns.scope);
  return `SELECT 1 FROM ${plain(config.tables.closures)} c JOIN ancestors a ON c.fact_id = a.id WHERE c.${scope} = ?
    AND NOT (c.reason = 'superseded' AND c.closed_by_fact_id IN (SELECT id FROM ancestors))`;
}

/**
 * The fact just written and every ancestor exist and none is closed (the fact is among the ancestors, so the
 * version it supersedes doesn't kill it). For a dependency written earlier in the same batch. Holds when the fact
 * is absent. Binds six values: fact id, scope, scope, fact id, scope, scope.
 */
function writtenLiveSql(config: LedgerConfig): string {
  const scope = plain(config.columns.scope);
  const facts = plain(config.tables.facts);
  return `WITH RECURSIVE ancestors(id) AS (
    SELECT ?
    UNION
    SELECT d.depends_on_fact_id FROM ${plain(config.tables.dependencies)} d
    JOIN ancestors a ON d.fact_id = a.id WHERE d.${scope} = ?
  )
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM ${facts} WHERE ${scope} = ? AND id = ?) THEN 1
    WHEN NOT EXISTS (${killingClosure(config)}) AND (SELECT count(*) FROM ${facts} f JOIN ancestors a ON f.id = a.id WHERE f.${scope} = ?)
      = (SELECT count(*) FROM ancestors) THEN 1 END`;
}

/**
 * Builds the batch for one entry. The sequence is the sequence of the checks a caller sees: the extension's guards,
 * then the dependency gate and the closed-fact guard; statements: the extension's `statementsBefore`, the fact,
 * its evidence and dependencies, the closure, the extension's `statementsAfter`; post-guards: the evidence
 * rule, the same-batch gate, then the extension's `post`. `refuse` maps a core reason to the host's error.
 */
export function planEntry(
  db: D1Database,
  config: LedgerConfig,
  policy: Policy,
  scope: string,
  entry: Entry,
  nowMs: number,
  refuse: RefusalError,
  extension: HostExtension = {},
): BatchPlan {
  const tables = config.tables;
  const scopeColumn = plain(config.columns.scope);
  const actorColumn = plain(config.columns.actor);
  const sameBatch = entry.sameBatch ?? [];

  const guards: CoreGuard[] = [...(extension.guards ?? [])];
  guards.push({
    holdsSql: dependenciesLiveSql(config),
    params: [JSON.stringify(entry.dependsOn.filter((id) => !sameBatch.includes(id))), scope, scope, scope],
    error: () => refuse("dependency_not_live"),
  });
  if (entry.closes !== null) {
    guards.push({
      holdsSql: `SELECT CASE WHEN EXISTS (SELECT 1 FROM ${plain(tables.facts)} WHERE ${scopeColumn} = ? AND id = ?)
                   AND NOT EXISTS (SELECT 1 FROM ${plain(tables.closures)} WHERE ${scopeColumn} = ? AND fact_id = ?) THEN 1 END`,
      params: [scope, entry.closes.factId, scope, entry.closes.factId],
      error: () => refuse("closes_not_live"),
    });
  }

  const factColumns = Object.entries(extension.factColumns ?? {});
  for (const [column] of factColumns) plain(column);
  const statements: D1PreparedStatement[] = [...(extension.statementsBefore ?? [])];
  statements.push(
    db
      .prepare(
        `INSERT INTO ${plain(tables.facts)} (id, ${scopeColumn}, kind, operation_key, ${actorColumn}, valid_from_ms,
           recorded_at_ms, body_json, agent_id${factColumns.map(([column]) => `, ${column}`).join("")})
         VALUES (${Array.from({ length: 9 + factColumns.length }, () => "?").join(", ")})`,
      )
      .bind(
        entry.factId,
        scope,
        entry.kind,
        entry.operationKey,
        entry.actor,
        entry.validFromMs,
        nowMs,
        JSON.stringify(entry.body ?? null),
        entry.agentId ?? null,
        ...factColumns.map(([, value]) => value),
      ),
  );
  for (const item of entry.evidence) {
    statements.push(
      db
        .prepare(`INSERT INTO ${plain(tables.evidence)} (${scopeColumn}, fact_id, kind, ref_id, content_sha256) VALUES (?, ?, ?, ?, ?)`)
        .bind(scope, entry.factId, item.kind, item.refId, item.contentSha256),
    );
  }
  for (const dependsOn of entry.dependsOn) {
    statements.push(
      db
        .prepare(`INSERT INTO ${plain(tables.dependencies)} (${scopeColumn}, fact_id, depends_on_fact_id) VALUES (?, ?, ?)`)
        .bind(scope, entry.factId, dependsOn),
    );
  }
  if (entry.closes !== null) {
    statements.push(
      db
        .prepare(`INSERT INTO ${plain(tables.closures)} (${scopeColumn}, fact_id, closed_by_fact_id, reason, closed_at_ms) VALUES (?, ?, ?, ?, ?)`)
        .bind(scope, entry.closes.factId, entry.factId, entry.closes.reason, nowMs),
    );
  }
  statements.push(...(extension.statementsAfter ?? []));

  const post: CoreGuard[] = [
    {
      holdsSql: compileEvidence(policy, config),
      params: [scope, entry.factId, scope, entry.factId],
      error: () => refuse("evidence_incomplete"),
    },
  ];
  if (sameBatch.length > 0) {
    post.push({
      holdsSql: writtenLiveSql(config),
      params: [entry.factId, scope, scope, entry.factId, scope, scope],
      error: () => refuse("dependency_not_live"),
    });
  }
  post.push(...(extension.post ?? []));
  return { guards, statements, post };
}

/** Whether the operation key already has an entry in this scope. */
export async function readUsedKey(db: D1Database, config: LedgerConfig, scope: string, operationKey: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS used FROM ${plain(config.tables.facts)} WHERE ${plain(config.columns.scope)} = ? AND operation_key = ?`)
    .bind(scope, operationKey)
    .first<{ used: number }>();
  return row !== null;
}

/** The dependencies, and their ancestors, that are missing in this scope or closed in a killing way. */
async function readDeadDependencies(db: D1Database, config: LedgerConfig, scope: string, dependsOn: readonly string[]): Promise<string[]> {
  if (dependsOn.length === 0) return [];
  const column = plain(config.columns.scope);
  const { results } = await db
    .prepare(
      `WITH RECURSIVE requested(id) AS (SELECT value FROM json_each(?)),
         ancestors(id) AS (
           SELECT id FROM requested
           UNION
           SELECT d.depends_on_fact_id FROM ${plain(config.tables.dependencies)} d
           JOIN ancestors a ON d.fact_id = a.id WHERE d.${column} = ?
         )
       SELECT a.id AS id FROM ancestors a
       WHERE NOT EXISTS (SELECT 1 FROM ${plain(config.tables.facts)} f WHERE f.${column} = ? AND f.id = a.id)
          OR EXISTS (SELECT 1 FROM ${plain(config.tables.closures)} c WHERE c.${column} = ? AND c.fact_id = a.id
            AND NOT (c.reason = 'superseded' AND c.closed_by_fact_id IN (SELECT id FROM ancestors)))`,
    )
    .bind(JSON.stringify(dependsOn), scope, scope, scope)
    .all<{ id: string }>();
  return results.map((row) => row.id);
}

/** The state of the fact an entry closes: "missing" when absent in this scope, "closed" when already closed. */
async function readClosesState(db: D1Database, config: LedgerConfig, scope: string, closes: Closure): Promise<JudgeState["closes"]> {
  const column = plain(config.columns.scope);
  const target = await db
    .prepare(
      `SELECT EXISTS (SELECT 1 FROM ${plain(config.tables.closures)} c WHERE c.${column} = f.${column} AND c.fact_id = f.id) AS closed
       FROM ${plain(config.tables.facts)} f WHERE f.${column} = ? AND f.id = ?`,
    )
    .bind(scope, closes.factId)
    .first<{ closed: number }>();
  return target === null ? "missing" : target.closed === 1 ? "closed" : "live";
}

/** A core refusal raised inside the batch: the admit call turns it into the verdict it names. */
class CoreRefusal extends Error {
  constructor(readonly reason: string) {
    super(`refused: ${reason}`);
  }
}

/** Runs the plan as one D1 batch. A guard that fails after the batch throws its own error, first one first. */
async function runPlan(db: D1Database, plan: BatchPlan): Promise<void> {
  const all = [...plan.guards, ...plan.post];
  const ids = all.map(() => crypto.randomUUID());
  const insertGuard = (guard: CoreGuard, n: number) =>
    db.prepare(`INSERT INTO batch_guards (guard_id, ok) VALUES (?, (${guard.holdsSql}))`).bind(ids[n], ...guard.params);
  const cleanup = db.prepare(`DELETE FROM batch_guards WHERE guard_id IN (${ids.map(() => "?").join(", ")})`).bind(...ids);
  try {
    await db.batch([
      ...plan.guards.map((guard, n) => insertGuard(guard, n)),
      ...plan.statements,
      ...plan.post.map((guard, n) => insertGuard(guard, plan.guards.length + n)),
      cleanup,
    ]);
  } catch (error) {
    for (const guard of all) {
      const row = await db
        .prepare(`SELECT (${guard.holdsSql}) AS ok`)
        .bind(...guard.params)
        .first<{ ok: number | null }>();
      if (row?.ok !== 1) throw guard.error();
    }
    throw error;
  }
}

/** A host with no extension: admits entries on a D1 database, judged first, then written in one batch. */
export class D1LedgerStore implements LedgerStore {
  constructor(
    private readonly db: D1Database,
    private readonly config: LedgerConfig,
    private readonly policy: Policy,
  ) {}

  async admit(scope: string, entry: Entry, nowMs: number): Promise<Verdict> {
    const sameBatch = entry.sameBatch ?? [];
    const state: JudgeState = {
      keyUsed: await readUsedKey(this.db, this.config, scope, entry.operationKey),
      deadDependencies: await readDeadDependencies(
        this.db,
        this.config,
        scope,
        entry.dependsOn.filter((id) => !sameBatch.includes(id)),
      ),
      closes: entry.closes === null ? null : await readClosesState(this.db, this.config, scope, entry.closes),
    };
    const verdict = judge(entry, state, this.policy);
    if (!verdict.admitted) return verdict;
    try {
      await runPlan(this.db, planEntry(this.db, this.config, this.policy, scope, entry, nowMs, (reason) => new CoreRefusal(reason)));
    } catch (error) {
      if (error instanceof CoreRefusal) return { admitted: false, reason: error.reason };
      throw error;
    }
    return verdict;
  }
}
