import type { ConsoleAuthRepository, ConsoleMember, InvitePreview, MemberSummary, NewConsoleSession, Tenant } from "../../application/ports";
import { type Guard, guardedBatch } from "./fence";

class InviteUnusableError extends Error {
  override readonly name = "InviteUnusableError";
}

interface SessionRow {
  id: string;
  business_id: string;
  user_id: string;
  role: ConsoleMember["role"];
  can_approve_fiado: number;
}

/** An invite is usable while unused, unexpired, and its membership active. Binds token hash, now. */
const USABLE_INVITE = `FROM console_invites i
  JOIN memberships m ON m.business_id = i.business_id AND m.user_id = i.user_id
  JOIN businesses b ON b.id = i.business_id
  WHERE i.token_hash = ? AND i.used_at_ms IS NULL AND i.expires_at_ms > ? AND m.active = 1`;

export class D1ConsoleAuthRepository implements ConsoleAuthRepository {
  constructor(private readonly db: D1Database) {}

  async previewInvite(tokenHash: string, nowMs: number): Promise<InvitePreview | null> {
    const row = await this.db.prepare(`SELECT b.name ${USABLE_INVITE}`).bind(tokenHash, nowMs).first<{ name: string }>();
    return row === null ? null : { storeName: row.name };
  }

  async acceptInvite(tokenHash: string, session: NewConsoleSession): Promise<ConsoleMember | null> {
    const usable: Guard = { holdsSql: `SELECT 1 ${USABLE_INVITE}`, params: [tokenHash, session.nowMs], error: () => new InviteUnusableError() };
    try {
      // One batch: the session opens and the invite is used, or neither. Two taps can't both win.
      await guardedBatch(this.db, [usable], [
        this.db
          .prepare(
            `INSERT INTO console_sessions (id, business_id, user_id, token_hash, created_at_ms, expires_at_ms)
             SELECT ?, business_id, user_id, ?, ?, ? FROM console_invites WHERE token_hash = ?`,
          )
          .bind(session.id, session.tokenHash, session.nowMs, session.expiresAtMs, tokenHash),
        this.db.prepare(`UPDATE console_invites SET used_at_ms = ? WHERE token_hash = ?`).bind(session.nowMs, tokenHash),
      ]);
    } catch (error) {
      if (error instanceof InviteUnusableError) return null;
      throw error;
    }
    return this.findSession(session.tokenHash, session.nowMs);
  }

  async findSession(tokenHash: string, nowMs: number): Promise<ConsoleMember | null> {
    const row = await this.db
      .prepare(
        `SELECT s.id, s.business_id, s.user_id, m.role, m.can_approve_fiado FROM console_sessions s
         JOIN memberships m ON m.business_id = s.business_id AND m.user_id = s.user_id
         WHERE s.token_hash = ? AND s.revoked_at_ms IS NULL AND s.expires_at_ms > ? AND m.active = 1`,
      )
      .bind(tokenHash, nowMs)
      .first<SessionRow>();
    if (row === null) return null;
    return {
      businessId: row.business_id,
      userId: row.user_id,
      sessionId: row.id,
      role: row.role,
      canApproveFiado: row.can_approve_fiado === 1,
    };
  }

  async revokeSessions(tenant: Tenant, userId: string, nowMs: number): Promise<number> {
    const result = await this.db
      .prepare(
        `UPDATE console_sessions SET revoked_at_ms = ?
         WHERE business_id = ? AND user_id = ? AND revoked_at_ms IS NULL`,
      )
      .bind(nowMs, tenant.businessId, userId)
      .run();
    return result.meta.changes;
  }

  async listMembers(tenant: Tenant): Promise<MemberSummary[]> {
    const { results } = await this.db
      .prepare(
        `SELECT m.user_id, u.display_name, m.role, m.active, m.can_approve_fiado FROM memberships m
         JOIN users u ON u.id = m.user_id
         WHERE m.business_id = ? ORDER BY m.role, u.display_name`,
      )
      .bind(tenant.businessId)
      .all<{ user_id: string; display_name: string | null; role: MemberSummary["role"]; active: number; can_approve_fiado: number }>();
    return results.map((row) => ({
      userId: row.user_id,
      displayName: row.display_name,
      role: row.role,
      active: row.active === 1,
      canApproveFiado: row.can_approve_fiado === 1,
    }));
  }
}
