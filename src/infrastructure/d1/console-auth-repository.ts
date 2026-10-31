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

  async addStaff(
    tenant: Tenant,
    person: { readonly phone: string; readonly displayName: string | null; readonly nowMs: number },
  ): Promise<{ readonly userId: string; readonly role: "owner" | "staff" }> {
    await this.db.batch([
      // A person can belong to several stores: an existing name is kept, a blank one is filled.
      this.db
        .prepare(
          `INSERT INTO users (id, phone, display_name, created_at_ms) VALUES (?, ?, ?, ?)
           ON CONFLICT (phone) DO UPDATE SET display_name = COALESCE(users.display_name, excluded.display_name)`,
        )
        .bind(crypto.randomUUID(), person.phone, person.displayName, person.nowMs),
      this.db
        .prepare(
          `INSERT INTO memberships (business_id, user_id, location_id, role, created_at_ms)
           SELECT ?, id, NULL, 'staff', ? FROM users WHERE phone = ?
           ON CONFLICT (business_id, user_id) DO NOTHING`,
        )
        .bind(tenant.businessId, person.nowMs, person.phone),
    ]);
    const row = await this.db
      .prepare(
        `SELECT m.user_id, m.role FROM memberships m JOIN users u ON u.id = m.user_id
         WHERE m.business_id = ? AND u.phone = ?`,
      )
      .bind(tenant.businessId, person.phone)
      .first<{ user_id: string; role: "owner" | "staff" }>();
    if (row === null) throw new Error("staff membership missing after insert");
    return { userId: row.user_id, role: row.role };
  }

  async createStaffInvite(
    tenant: Tenant,
    userId: string,
    invite: { readonly id: string; readonly tokenHash: string; readonly nowMs: number; readonly expiresAtMs: number },
  ): Promise<{ readonly phone: string; readonly displayName: string | null } | null> {
    // Both statements match only a staff membership of this store, so an owner or another store's
    // member gets neither a reactivation nor an invite. A re-added person starts without fiado.
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE memberships SET can_approve_fiado = CASE WHEN active = 0 THEN 0 ELSE can_approve_fiado END, active = 1
           WHERE business_id = ? AND user_id = ? AND role = 'staff'`,
        )
        .bind(tenant.businessId, userId),
      this.db
        .prepare(
          `INSERT INTO console_invites (id, business_id, user_id, token_hash, expires_at_ms, created_at_ms)
           SELECT ?, business_id, user_id, ?, ?, ? FROM memberships
           WHERE business_id = ? AND user_id = ? AND role = 'staff' AND active = 1`,
        )
        .bind(invite.id, invite.tokenHash, invite.expiresAtMs, invite.nowMs, tenant.businessId, userId),
    ]);
    const row = await this.db
      .prepare(
        `SELECT u.phone, u.display_name FROM console_invites i JOIN users u ON u.id = i.user_id
         WHERE i.token_hash = ? AND i.business_id = ?`,
      )
      .bind(invite.tokenHash, tenant.businessId)
      .first<{ phone: string; display_name: string | null }>();
    return row === null ? null : { phone: row.phone, displayName: row.display_name };
  }

  async removeStaff(tenant: Tenant, userId: string, nowMs: number): Promise<boolean> {
    const [removed] = await this.db.batch([
      this.db
        .prepare(`UPDATE memberships SET active = 0 WHERE business_id = ? AND user_id = ? AND role = 'staff'`)
        .bind(tenant.businessId, userId),
      // An unused invite would open a session again if the person were re-added within 15 minutes.
      this.db
        .prepare(
          `UPDATE console_invites SET expires_at_ms = ?
           WHERE business_id = ? AND user_id = ? AND used_at_ms IS NULL AND expires_at_ms > ?
             AND EXISTS (SELECT 1 FROM memberships WHERE business_id = ? AND user_id = ? AND role = 'staff')`,
        )
        .bind(nowMs, tenant.businessId, userId, nowMs, tenant.businessId, userId),
    ]);
    return (removed?.meta.changes ?? 0) > 0;
  }

  async setFiadoPermission(tenant: Tenant, userId: string, allowed: boolean): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE memberships SET can_approve_fiado = ?
         WHERE business_id = ? AND user_id = ? AND role = 'staff' AND active = 1`,
      )
      .bind(allowed ? 1 : 0, tenant.businessId, userId)
      .run();
    return result.meta.changes > 0;
  }

  async voiceNoticeSeen(tenant: Tenant, userId: string): Promise<boolean> {
    const row = await this.db
      .prepare(`SELECT voice_notice_seen_at_ms FROM memberships WHERE business_id = ? AND user_id = ?`)
      .bind(tenant.businessId, userId)
      .first<{ voice_notice_seen_at_ms: number | null }>();
    return row !== null && row.voice_notice_seen_at_ms !== null;
  }

  async markVoiceNoticeSeen(tenant: Tenant, userId: string, nowMs: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE memberships SET voice_notice_seen_at_ms = ?
         WHERE business_id = ? AND user_id = ? AND voice_notice_seen_at_ms IS NULL`,
      )
      .bind(nowMs, tenant.businessId, userId)
      .run();
  }
}
