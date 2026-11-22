import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import {
  Chevron,
  EmptyState,
  ErrorNotice,
  formatDate,
  Loading,
  StatusBadge,
} from '../components/ui.js';
import { api } from '../lib/api.js';

interface ObjectResponse {
  object: {
    id: string;
    serialNumber: string;
    label: string | null;
    objectType: string | null;
    notes: string | null;
    siteId: string;
    siteName: string;
    createdAt: string;
  };
  history: {
    jobId: string;
    jobNumber: string;
    title: string;
    status: string;
    scheduledFor: string | null;
    photoCount: number;
  }[];
}

/**
 * The payoff of objects persisting across jobs: one serial number, every
 * inspection it has ever been part of, in one place.
 */
export default function ObjectDetail() {
  const { objectId } = useParams<{ objectId: string }>();

  const data = useQuery({
    queryKey: ['object', objectId],
    queryFn: () => api<ObjectResponse>(`/api/objects/${objectId}`),
  });

  if (data.isLoading) return <Loading label="Loading structure" />;
  if (data.isError) return <ErrorNotice error={data.error} />;
  if (!data.data) return null;

  const { object, history } = data.data;
  const totalPhotos = history.reduce((n, h) => n + h.photoCount, 0);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="mono">{object.serialNumber}</h1>
          <div className="page-sub">
            {object.label ?? 'No label'}
            {object.objectType ? ` · ${object.objectType}` : ''} · {object.siteName}
          </div>
        </div>
        <div className="spacer" />
        <Link className="btn" to={`/gallery?objectId=${object.id}`}>
          View {totalPhotos} photos
        </Link>
      </div>

      {object.notes && (
        <div className="card card-pad mb">
          <div className="label">Notes</div>
          <p className="small">{object.notes}</p>
        </div>
      )}

      <div className="card">
        <div className="card-pad between">
          <h2>Inspection history</h2>
          <span className="pill">{history.length} jobs</span>
        </div>
        {history.length === 0 ? (
          <EmptyState title="Not inspected yet">
            This structure was recorded but has not been part of a completed job.
          </EmptyState>
        ) : (
          <div className="list" style={{ borderTop: '1px solid var(--border)' }}>
            {history.map((h) => (
              <Link className="row" key={h.jobId} to={`/jobs/${h.jobId}`}>
                <div className="row-main">
                  <div className="row-title">{h.title}</div>
                  <div className="row-meta">
                    <span className="mono">{h.jobNumber}</span>
                    {h.scheduledFor ? ` · ${formatDate(h.scheduledFor)}` : ''} ·{' '}
                    {h.photoCount} photos
                  </div>
                </div>
                <div className="row-side">
                  <StatusBadge status={h.status} />
                  <Chevron />
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
