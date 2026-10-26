import type { FileRecord } from "../domain/file.js";
import { availableBytes, type Tenant } from "../domain/tenant.js";
import type { UploadSession } from "../domain/uploadSession.js";

export interface FileBody {
  id: string;
  path: string;
  size: number;
  sha256: string;
  contentType: string;
  declaredType: string | null;
  originalName: string;
  status: string;
  image: { width: number; height: number } | null;
  createdAt: string;
  updatedAt: string;
}

export function serializeFile(file: FileRecord): FileBody {
  return {
    id: file.id,
    path: file.path,
    size: file.size,
    sha256: file.sha256,
    contentType: file.contentType,
    declaredType: file.declaredType,
    originalName: file.originalName,
    status: file.status,
    image: file.image ? { width: file.image.width, height: file.image.height } : null,
    createdAt: file.createdAt.toISOString(),
    updatedAt: file.updatedAt.toISOString(),
  };
}

export function serializeSession(session: UploadSession) {
  return {
    id: session.id,
    path: session.path,
    size: session.size,
    offset: session.offset,
    state: session.state,
    declaredType: session.declaredType,
    overwrite: session.overwrite,
    fileId: session.fileId,
    createdAt: session.createdAt.toISOString(),
    expiresAt: session.expiresAt.toISOString(),
  };
}

export function serializeTenant(tenant: Tenant) {
  return {
    id: tenant.id,
    name: tenant.name,
    quotaBytes: tenant.quotaBytes,
    usedBytes: tenant.usedBytes,
    availableBytes: availableBytes(tenant),
    createdAt: tenant.createdAt.toISOString(),
  };
}
