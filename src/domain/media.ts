/** Every stored object of a store lives under the store's own prefix. */
export function storePrefix(businessId: string): string {
  return `stores/${businessId}/`;
}

export function mediaObjectKey(businessId: string, assetId: string): string {
  return `${storePrefix(businessId)}media/${assetId}`;
}

export function isUnderStorePrefix(businessId: string, key: string): boolean {
  return key.startsWith(storePrefix(businessId));
}
