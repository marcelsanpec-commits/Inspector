import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CameraIcon } from '../components/icons.js';
import {
  Chevron,
  EmptyState,
  ErrorNotice,
  formatDate,
  Loading,
  StatusBadge,
} from '../components/ui.js';
import { api } from '../lib/api.js';
import { plural } from '../lib/inspection.js';

interface JobDetailResponse {
  job: {
    id: string;
    jobNumber: string;
    title: string;
    status: string;
    clientAccess: string;
    scheduledFor: string | null;
    startedAt: string | null;
    submittedAt: string | null;
    deliveredAt: string | null;
    notes: string | null;
  };
  site: { id: string; name: string; addressLine1: string | null; city: string | null };
  client: { id: string; name: string };
  inspectors: { userId: string; name: string; email: string }[];
  objects: {
    structureId: string;
    objectId: string;
    serialNumber: string;
    label: string | null;
    objectType: string | null;
    finishedAt: string | null;
    photoCount: number;
  }[];
  photoCount: number;
  permissions: {
    canWriteContent: boolean;
    canManage: boolean;
    canSubmit: boolean;
  };
}

export default function JobDetail() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const navigate = useNavigate();

  const job = useQuery({
    queryKey: ['job', id],
    queryFn: () => api<JobDetailResponse>(`/api/jobs/${id}`),
  });

  const transition = useMutation({
    mutationFn: (action: 'start' | 'submit' | 'deliver') =>
      api(`/api/jobs/${id}/${action}`, { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['job', id] });
      qc.invalidateQueries({ queryKey: ['jobs'] });
    },
  });

  const startInspection = useMutation({
    mutationFn: () => api(`/api/jobs/${id}/start`, { method: 'POST' }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['job', id] });
      qc.invalidateQueries({ queryKey: ['jobs'] });
      navigate(`/jobs/${id}/inspect`);
    },
  });

  if (job.isLoading) return <Loading label="Loading job" />;
  if (job.isError) return <ErrorNotice error={job.error} />;
  if (!job.data) return null;

  const { job: j, site, client, inspectors, objects, photoCount, permissions } =
    job.data;

  return (
    <>
      <div className="page-head">
        <div style={{ minWidth: 0 }}>
          <div className="inline">
            <Link to="/jobs" className="small muted">
              ← Jobs
            </Link>
          </div>
          <h1 style={{ marginTop: 6 }}>{j.title}</h1>
          <div className="page-sub">
            <span className="mono">{j.jobNumber}</span> · {client.name} · {site.name}
            {site.city ? `, ${site.city}` : ''}
          </div>
        </div>
        <div className="spacer" />
        <div className="inline">
          {j.clientAccess === 'restricted' && (
            <span className="badge badge-restricted">restricted</span>
          )}
          <StatusBadge status={j.status} />
        </div>
      </div>

      <ErrorNotice error={transition.error ?? startInspection.error} />

      {(permissions.canWriteContent || objects.length > 0) && (
        <InspectionCard
          jobId={j.id}
          status={j.status}
          canWrite={permissions.canWriteContent}
          structureCount={objects.length}
          starting={startInspection.isPending}
          onStart={() => startInspection.mutate()}
        />
      )}

      <div className="grid grid-2">
        <div className="card">
          <div className="card-pad between">
            <h2>Structures</h2>
            <span className="pill">{objects.length}</span>
          </div>
          {objects.length === 0 ? (
            <EmptyState title="No structures recorded yet">
              A structure is a serial-numbered item at this site. The inspector adds
              each one during the inspection, starting with its serial plate.
            </EmptyState>
          ) : (
            <div className="list" style={{ borderTop: '1px solid var(--border)' }}>
              {objects.map((o) => (
                <Link
                  className="row"
                  key={o.structureId}
                  to={`/jobs/${j.id}/inspect/${o.structureId}`}
                >
                  <div className="row-main">
                    <div className="row-title">{o.objectType ?? o.serialNumber}</div>
                    <div className="row-meta">
                      <span className="mono">{o.serialNumber}</span>
                      {o.label ? ` · ${o.label}` : ''}
                    </div>
                  </div>
                  <div className="row-side">
                    {!o.finishedAt && (
                      <span className="badge badge-in_progress hide-sm">in progress</span>
                    )}
                    <span className="pill">{plural(o.photoCount, 'photo')}</span>
                    <Chevron />
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>

        <div className="stack">
          <div className="card card-pad">
            <h2 className="mb">Details</h2>
            <div className="stack small">
              <div className="between">
                <span className="muted">Client</span>
                <span className="strong">{client.name}</span>
              </div>
              <div className="between">
                <span className="muted">Site</span>
                <span className="strong truncate">{site.name}</span>
              </div>
              {site.addressLine1 && (
                <div className="between">
                  <span className="muted">Address</span>
                  <span className="truncate">{site.addressLine1}</span>
                </div>
              )}
              <div className="between">
                <span className="muted">Scheduled</span>
                <span>{formatDate(j.scheduledFor)}</span>
              </div>
              <div className="between">
                <span className="muted">Started</span>
                <span>{formatDate(j.startedAt)}</span>
              </div>
              <div className="between">
                <span className="muted">Submitted</span>
                <span>{formatDate(j.submittedAt)}</span>
              </div>
              <div className="between">
                <span className="muted">Delivered</span>
                <span>{formatDate(j.deliveredAt)}</span>
              </div>
              <div className="between">
                <span className="muted">Photos</span>
                <Link to={`/gallery?jobId=${j.id}`}>{photoCount} in gallery</Link>
              </div>
            </div>

            {j.notes && (
              <>
                <div className="label mt">Notes</div>
                <p className="small">{j.notes}</p>
              </>
            )}
          </div>

          <div className="card card-pad">
            <h2 className="mb">Inspectors</h2>
            {inspectors.length === 0 ? (
              <p className="small muted">Nobody assigned yet.</p>
            ) : (
              <div className="stack small">
                {inspectors.map((i) => (
                  <div key={i.userId} className="between">
                    <span className="strong">{i.name}</span>
                    <span className="muted truncate">{i.email}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {(permissions.canManage || permissions.canSubmit) && (
            <div className="card card-pad">
              <h2 className="mb">Move this job along</h2>
              <div className="btn-row">
                {/* Draft and scheduled jobs start from the Inspection card. */}
                {permissions.canWriteContent && j.status === 'submitted' && (
                  <button
                    className="btn"
                    disabled={transition.isPending}
                    onClick={() => transition.mutate('start')}
                  >
                    Reopen for field work
                  </button>
                )}
                {permissions.canSubmit &&
                  ['in_progress', 'scheduled', 'draft'].includes(j.status) && (
                    <button
                      className="btn"
                      disabled={transition.isPending}
                      onClick={() => transition.mutate('submit')}
                    >
                      Submit for review
                    </button>
                  )}
                {permissions.canManage && j.status !== 'delivered' && (
                  <button
                    className="btn btn-primary"
                    disabled={transition.isPending}
                    onClick={() => transition.mutate('deliver')}
                  >
                    Deliver to client
                  </button>
                )}
              </div>
              <p className="hint">
                Delivering makes this job, its photos, and its report visible to{' '}
                {client.name}. Nothing is visible to them before that.
              </p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * Where field work begins. "Start Inspection" marks the job in progress and
 * opens it; after that the same card continues it, and once the job is
 * submitted it opens the record read-only.
 */
function InspectionCard({
  jobId,
  status,
  canWrite,
  structureCount,
  starting,
  onStart,
}: {
  jobId: string;
  status: string;
  canWrite: boolean;
  structureCount: number;
  starting: boolean;
  onStart(): void;
}) {
  const startable = canWrite && (status === 'draft' || status === 'scheduled');
  const underway = canWrite && !startable;

  return (
    <div className="card card-pad mb">
      <div className="between" style={{ flexWrap: 'wrap' }}>
        <div>
          <h3>Inspection</h3>
          <div className="small muted" style={{ marginTop: 3 }}>
            {startable
              ? "Photograph each structure's serial plate, then everything about it."
              : structureCount > 0
                ? `${plural(structureCount, 'structure')} recorded.`
                : 'No structures recorded yet.'}
          </div>
        </div>
        {startable ? (
          <button className="btn btn-primary btn-lg" onClick={onStart} disabled={starting}>
            {starting ? <span className="spin" /> : <CameraIcon size={20} />}
            Start Inspection
          </button>
        ) : underway && status === 'in_progress' ? (
          <Link className="btn btn-primary btn-lg" to={`/jobs/${jobId}/inspect`}>
            <CameraIcon size={20} />
            Continue Inspection
          </Link>
        ) : underway ? (
          // Company staff reviewing a submitted job can still correct it.
          <Link className="btn btn-lg" to={`/jobs/${jobId}/inspect`}>
            Open inspection
          </Link>
        ) : (
          <Link className="btn btn-lg" to={`/jobs/${jobId}/inspect`}>
            View inspection
          </Link>
        )}
      </div>
    </div>
  );
}
