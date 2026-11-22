import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { AlertIcon, CameraIcon, PlusIcon } from '../components/icons.js';
import {
  EmptyState,
  ErrorNotice,
  Loading,
  Skeletons,
  StatusBadge,
} from '../components/ui.js';
import { api } from '../lib/api.js';
import {
  inspectionKeys,
  plural,
  structureTitle,
  type InspectionJob,
  type StructuresResponse,
  type StructureSummary,
} from '../lib/inspection.js';

/**
 * The inspection menu.
 *
 * One tile per structure, its serial plate photo as the picture and what the
 * structure is as the title - the same order the report will follow. Tiles
 * for structures still being worked carry an "In progress" badge, so nothing
 * started and forgotten slips through.
 */
export default function Inspection() {
  const { id: jobId = '' } = useParams<{ id: string }>();

  const job = useQuery({
    queryKey: inspectionKeys.job(jobId),
    queryFn: () => api<InspectionJob>(`/api/jobs/${jobId}`),
  });

  const data = useQuery({
    queryKey: inspectionKeys.structures(jobId),
    queryFn: () => api<StructuresResponse>(`/api/jobs/${jobId}/structures`),
  });

  if (job.isLoading) return <Loading label="Loading inspection" />;
  if (job.isError) return <ErrorNotice error={job.error} />;
  if (!job.data) return null;

  const canWrite = job.data.permissions.canWriteContent;
  const structures = data.data?.structures ?? [];
  const photoTotal = structures.reduce((n, s) => n + s.photoCount, 0);
  const findings = structures.reduce((n, s) => n + s.nonConformingCount, 0);
  const open = structures.filter((s) => !s.finishedAt).length;

  return (
    <>
      <div className="page-head">
        <div style={{ minWidth: 0 }}>
          <Link to={`/jobs/${jobId}`} className="small muted">
            ← {job.data.job.title}
          </Link>
          <h1 style={{ marginTop: 6 }}>Inspection</h1>
          <div className="page-sub">
            <span className="mono">{job.data.job.jobNumber}</span> · {job.data.site.name}
          </div>
        </div>
        <div className="spacer" />
        <StatusBadge status={job.data.job.status} />
      </div>

      {!canWrite && (
        <div className="notice notice-info">
          This inspection is closed for changes. You can look through it, but not
          edit it.
        </div>
      )}

      {canWrite && (
        <Link className="btn btn-primary btn-lg btn-block mb" to={`/jobs/${jobId}/inspect/new`}>
          <PlusIcon size={22} />
          New Structure
        </Link>
      )}

      <ErrorNotice error={data.error} />
      {data.isLoading && <Skeletons count={2} />}

      {data.data &&
        (structures.length === 0 ? (
          <div className="card">
            <EmptyState title="No structures yet">
              {canWrite
                ? 'Tap New Structure, photograph its serial number plate, and enter what it is. Everything you photograph after that files under it.'
                : 'Nothing was recorded on this inspection.'}
            </EmptyState>
          </div>
        ) : (
          <>
            <div className="inspection-summary small muted mb">
              <span>{plural(structures.length, 'structure')}</span>
              <span>{plural(photoTotal, 'photo')}</span>
              {findings > 0 && (
                <span className="nc-text strong">
                  {plural(findings, 'non-conforming photo')}
                </span>
              )}
              {open > 0 && <span>{open} in progress</span>}
            </div>
            <div className="structure-grid">
              {structures.map((s) => (
                <StructureTile key={s.id} jobId={jobId} structure={s} />
              ))}
            </div>
          </>
        ))}
    </>
  );
}

function StructureTile({ jobId, structure: s }: { jobId: string; structure: StructureSummary }) {
  return (
    <Link className="structure-tile" to={`/jobs/${jobId}/inspect/${s.id}`}>
      <div className="tile-thumb">
        {s.cover ? (
          <img src={s.cover.url} alt={`Serial plate of ${s.serialNumber}`} loading="lazy" />
        ) : (
          <div className="tile-empty">
            <CameraIcon size={30} />
          </div>
        )}
        <div className="tile-badges">
          {!s.finishedAt && <span className="photo-flag in-progress">In progress</span>}
          {s.nonConformingCount > 0 && (
            <span className="photo-flag nc">
              <AlertIcon size={12} />
              {s.nonConformingCount}
            </span>
          )}
        </div>
      </div>
      <div className="tile-body">
        <div className="tile-title">{structureTitle(s)}</div>
        <div className="tile-meta mono truncate">{s.serialNumber}</div>
        <div className="tile-meta">{plural(s.photoCount, 'photo')}</div>
      </div>
    </Link>
  );
}
