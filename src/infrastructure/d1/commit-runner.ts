import type { Commit } from "../../application/ports";
import { guardedBatch } from "./fence";

/** Runs commits as one guarded batch: every guard first, then the statements, then the post guards. */
export class D1CommitRunner {
  constructor(private readonly db: D1Database) {}

  async run(commits: readonly Commit[]): Promise<void> {
    if (commits.length === 0) return;
    await guardedBatch(
      this.db,
      commits.flatMap((commit) => commit.guards),
      commits.flatMap((commit) => commit.statements),
      commits.flatMap((commit) => commit.post ?? []),
    );
  }
}
