import { randomUUID } from 'node:crypto';

export function newAssetId(): string {
  return `asset_${randomUUID()}`;
}

export function newRenditionId(): string {
  return `rendition_${randomUUID()}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
