import type { MediaBytes, MediaStore, StoredMedia, Tenant } from "../application/ports";
import { isUnderStorePrefix } from "../domain/media";

/**
 * Private R2 storage with immutable keys: `prefix/<sha256 of the bytes>`. Two writers of different
 * bytes write different objects, so a stale writer can't overwrite what a newer one published;
 * writers of the same bytes write the same object. A prefix outside the tenant's is refused.
 */
export class R2MediaStore implements MediaStore {
  constructor(private readonly bucket: R2Bucket) {}

  async putImmutable(tenant: Tenant, prefix: string, media: MediaBytes): Promise<StoredMedia> {
    if (!isUnderStorePrefix(tenant.businessId, prefix)) {
      throw new Error("media key is outside the store's prefix");
    }
    const digest = await crypto.subtle.digest("SHA-256", media.bytes);
    const sha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const key = `${prefix}/${sha256}`;
    // R2 checks the bytes against the digest before storing them.
    await this.bucket.put(key, media.bytes, { httpMetadata: { contentType: media.contentType }, sha256 });
    return { key, sha256, size: media.bytes.byteLength };
  }

  async read(tenant: Tenant, key: string): Promise<MediaBytes | null> {
    if (!isUnderStorePrefix(tenant.businessId, key)) {
      throw new Error("media key is outside the store's prefix");
    }
    const object = await this.bucket.get(key);
    if (object === null) return null;
    return {
      bytes: await object.arrayBuffer(),
      contentType: object.httpMetadata?.contentType ?? "application/octet-stream",
    };
  }
}
