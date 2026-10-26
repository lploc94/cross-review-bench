import type { SyncEvent } from "@sync/shared";
import type { DeviceWithCursor, Device } from "../domain/accounts.js";
import type { StoredDocument } from "../repositories/documents.js";
import type { StoredEvent } from "../repositories/events.js";

export function serializeEvent(event: StoredEvent): SyncEvent {
  return {
    seq: event.seq,
    mutationId: event.mutationId,
    deviceId: event.deviceId,
    collection: event.collection,
    docId: event.docId,
    field: event.field,
    value: event.value as SyncEvent["value"],
    hlc: event.hlc,
    serverReceivedAt: event.serverReceivedAt.toISOString(),
  };
}

export function serializeDocument(doc: StoredDocument) {
  return {
    collection: doc.collection,
    id: doc.docId,
    fields: doc.fields,
    fieldHlcs: doc.fieldHlcs,
    updatedSeq: doc.updatedSeq,
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export function serializeDevice(device: Device) {
  return {
    id: device.id,
    name: device.name,
    createdAt: device.createdAt.toISOString(),
    lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
  };
}

export function serializeDeviceWithCursor(device: DeviceWithCursor, currentDeviceId: string) {
  return {
    ...serializeDevice(device),
    lastPulledSeq: device.lastPulledSeq,
    current: device.id === currentDeviceId,
  };
}
