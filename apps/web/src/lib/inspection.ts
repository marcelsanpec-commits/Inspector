/**
 * Shapes and cache keys shared by the three inspection screens: the
 * structure tiles, New Structure, and one structure's photos and comments.
 */

export interface StructureCover {
  photoId: string;
  url: string;
  /** False when no plate was photographed and the first photo stands in. */
  isSerialPlate: boolean;
}

export interface StructureSummary {
  id: string;
  objectId: string;
  serialNumber: string;
  structureType: string | null;
  label: string | null;
  comments: string | null;
  position: number;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  photoCount: number;
  includedCount: number;
  nonConformingCount: number;
  cover: StructureCover | null;
}

export interface StructurePhoto {
  id: string;
  url: string;
  width: number | null;
  height: number | null;
  caption: string | null;
  voiceNote: string | null;
  includeInReport: boolean;
  nonConforming: boolean;
  isSerialPlate: boolean;
  takenAt: string | null;
  gpsLat: number | null;
  gpsLng: number | null;
  createdAt: string;
}

export interface StructuresResponse {
  structures: StructureSummary[];
  structureTypes: string[];
  permissions: { canWriteContent: boolean };
}

export interface StructureResponse {
  structure: StructureSummary;
  photos: StructurePhoto[];
  structureTypes: string[];
  permissions: { canWriteContent: boolean };
}

/** The slice of GET /api/jobs/:id the inspection screens need. */
export interface InspectionJob {
  job: { id: string; jobNumber: string; title: string; status: string };
  site: { id: string; name: string };
  permissions: { canWriteContent: boolean };
}

export const inspectionKeys = {
  job: (jobId: string) => ['job', jobId] as const,
  structures: (jobId: string) => ['structures', jobId] as const,
  structure: (jobId: string, structureId: string) =>
    ['structure', jobId, structureId] as const,
};

/** A tile's title is what the structure is; the serial is the fallback. */
export function structureTitle(
  s: Pick<StructureSummary, 'structureType' | 'serialNumber'>,
): string {
  return s.structureType?.trim() || s.serialNumber;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
