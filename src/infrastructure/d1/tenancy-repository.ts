import type { ChannelAccount, Member, Tenant, TenancyRepository } from "../../application/ports";

interface ChannelRow {
  id: string;
  business_id: string;
  phone_number_id: string;
}

const toChannel = (row: ChannelRow): ChannelAccount => ({
  id: row.id,
  businessId: row.business_id,
  phoneNumberId: row.phone_number_id,
});

export class D1TenancyRepository implements TenancyRepository {
  constructor(private readonly db: D1Database) {}

  async findChannelAccount(phoneNumberId: string): Promise<ChannelAccount | null> {
    const row = await this.db
      .prepare(
        `SELECT id, business_id, phone_number_id FROM channel_accounts
         WHERE provider = 'whatsapp' AND phone_number_id = ?1`,
      )
      .bind(phoneNumberId)
      .first<ChannelRow>();
    return row === null ? null : toChannel(row);
  }

  async findChannelAccountOf(tenant: Tenant, channelAccountId: string): Promise<ChannelAccount | null> {
    const row = await this.db
      .prepare(`SELECT id, business_id, phone_number_id FROM channel_accounts WHERE business_id = ?1 AND id = ?2`)
      .bind(tenant.businessId, channelAccountId)
      .first<ChannelRow>();
    return row === null ? null : toChannel(row);
  }

  async findActiveMember(tenant: Tenant, phone: string): Promise<Member | null> {
    const row = await this.db
      .prepare(
        `SELECT m.user_id, m.role FROM memberships m JOIN users u ON u.id = m.user_id
         WHERE m.business_id = ?1 AND u.phone = ?2 AND m.active = 1`,
      )
      .bind(tenant.businessId, phone)
      .first<{ user_id: string; role: Member["role"] }>();
    return row === null ? null : { userId: row.user_id, role: row.role };
  }
}
