import type { MediaEraser, Tenant } from "../application/ports";
import { isUnderStorePrefix } from "../domain/media";

/** Deletes a customer's stored media from R2 for the deletion purge. Refuses a prefix outside the store's. */
export class R2MediaEraser implements MediaEraser {
  constructor(private readonly bucket: R2Bucket) {}

  async erasePrefix(tenant: Tenant, prefix: string): Promise<number> {
    if (!isUnderStorePrefix(tenant.businessId, prefix) || prefix.includes("..")) {
      throw new Error("media prefix is outside the store's prefix");
    }
    let erased = 0;
    let cursor: string | undefined;
    do {
      const listed = await this.bucket.list({ prefix: `${prefix}/`, ...(cursor === undefined ? {} : { cursor }) });
      const keys = listed.objects.map((object) => object.key);
      if (keys.length > 0) await this.bucket.delete(keys);
      erased += keys.length;
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor !== undefined);
    return erased;
  }
}
