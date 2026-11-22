import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  EmptyState,
  ErrorNotice,
  formatDateTime,
  Modal,
  Skeletons,
} from '../components/ui.js';
import { api } from '../lib/api.js';

interface GalleryPhoto {
  id: string;
  url: string;
  caption: string | null;
  voiceNote: string | null;
  includeInReport: boolean;
  nonConforming: boolean;
  isSerialPlate: boolean;
  takenAt: string | null;
  gpsLat: number | null;
  gpsLng: number | null;
  jobId: string;
  jobNumber: string;
  jobTitle: string;
  siteId: string;
  siteName: string;
  clientName: string;
  objectId: string | null;
  objectSerial: string | null;
  objectLabel: string | null;
}

/**
 * Deliberately separate from the report.
 *
 * Most photos never make it into a report, but the company and the client both
 * still need to browse everything that was documented - which is exactly why
 * this view filters by job, site, object and date rather than only showing what
 * was selected for the write-up.
 */
export default function Gallery() {
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const [open, setOpen] = useState<GalleryPhoto | null>(null);

  const query = Object.fromEntries(params.entries());
  const search = new URLSearchParams(query).toString();

  const photos = useQuery({
    queryKey: ['gallery', search],
    queryFn: () =>
      api<{ photos: GalleryPhoto[] }>(`/api/gallery${search ? `?${search}` : ''}`),
  });

  const sites = useQuery({
    queryKey: ['sites'],
    queryFn: () => api<{ sites: { id: string; name: string }[] }>('/api/sites'),
  });

  const toggleInclude = useMutation({
    mutationFn: (photo: GalleryPhoto) =>
      api(`/api/photos/${photo.id}`, {
        method: 'PATCH',
        body: { includeInReport: !photo.includeInReport },
      }),
    onSuccess: (_data, photo) => {
      setOpen((p) => (p ? { ...p, includeInReport: !p.includeInReport } : p));
      qc.invalidateQueries({ queryKey: ['gallery'] });
      qc.invalidateQueries({ queryKey: ['structures', photo.jobId] });
      qc.invalidateQueries({ queryKey: ['structure', photo.jobId] });
    },
  });

  function setFilter(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  }

  const grouped = groupByDay(photos.data?.photos ?? []);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Photos</h1>
          <div className="page-sub">
            Everything documented, whether or not it reaches a report
          </div>
        </div>
      </div>

      <div className="card card-pad mb">
        <div className="grid grid-3">
          <label>
            <span className="label">Site</span>
            <select
              className="select"
              value={params.get('siteId') ?? ''}
              onChange={(e) => setFilter('siteId', e.target.value)}
            >
              <option value="">All sites</option>
              {(sites.data?.sites ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span className="label">In report</span>
            <select
              className="select"
              value={
                params.get('nonConforming') === 'true'
                  ? 'nc'
                  : (params.get('includeInReport') ?? '')
              }
              onChange={(e) => {
                const next = new URLSearchParams(params);
                next.delete('includeInReport');
                next.delete('nonConforming');
                if (e.target.value === 'nc') next.set('nonConforming', 'true');
                else if (e.target.value) next.set('includeInReport', e.target.value);
                setParams(next, { replace: true });
              }}
            >
              <option value="">All photos</option>
              <option value="true">Included only</option>
              <option value="false">Excluded only</option>
              <option value="nc">Non-conforming only</option>
            </select>
          </label>

          <label>
            <span className="label">Taken from</span>
            <input
              className="input"
              type="date"
              value={params.get('takenFrom')?.slice(0, 10) ?? ''}
              onChange={(e) =>
                setFilter(
                  'takenFrom',
                  e.target.value ? new Date(e.target.value).toISOString() : '',
                )
              }
            />
          </label>
        </div>

        {search && (
          <button
            className="btn btn-sm mt"
            onClick={() => setParams(new URLSearchParams(), { replace: true })}
          >
            Clear filters
          </button>
        )}
      </div>

      <ErrorNotice error={photos.error} />
      {photos.isLoading && <Skeletons count={2} />}

      {photos.data &&
        (photos.data.photos.length === 0 ? (
          <div className="card">
            <EmptyState title="No photos here">
              Photos appear once an inspector captures them on a job you can see.
            </EmptyState>
          </div>
        ) : (
          <div className="stack">
            {grouped.map(([day, items]) => (
              <div key={day}>
                <h2 className="mb">{day}</h2>
                <div className="photo-grid">
                  {items.map((p) => (
                    <button className="photo" key={p.id} onClick={() => setOpen(p)}>
                      <img
                        src={p.url}
                        alt={p.caption ?? 'Inspection photo'}
                        loading="lazy"
                      />
                      <div className="photo-tag">
                        {p.objectSerial && (
                          <span className="photo-flag mono">{p.objectSerial}</span>
                        )}
                        {p.nonConforming && (
                          <span className="photo-flag nc">non-conforming</span>
                        )}
                        {!p.includeInReport && (
                          <span className="photo-flag excluded">not in report</span>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ))}

      {open && (
        <Modal wide title={open.caption ?? 'Photo'} onClose={() => setOpen(null)}>
          <div className="lightbox mb">
            <img src={open.url} alt={open.caption ?? 'Inspection photo'} />
          </div>

          {open.voiceNote && (
            <div className="notice notice-info">
              <div className="tiny strong mb" style={{ marginBottom: 4 }}>
                Inspector's note
              </div>
              {open.voiceNote}
            </div>
          )}

          <div className="stack small">
            <div className="between">
              <span className="muted">Job</span>
              <Link to={`/jobs/${open.jobId}`}>
                {open.jobNumber} · {open.jobTitle}
              </Link>
            </div>
            <div className="between">
              <span className="muted">Client</span>
              <span>{open.clientName}</span>
            </div>
            <div className="between">
              <span className="muted">Site</span>
              <span>{open.siteName}</span>
            </div>
            <div className="between">
              <span className="muted">Structure</span>
              {open.objectId ? (
                <Link to={`/objects/${open.objectId}`} className="mono">
                  {open.objectSerial}
                </Link>
              ) : (
                <span className="dim">Unassigned</span>
              )}
            </div>
            <div className="between">
              <span className="muted">Taken</span>
              <span>{formatDateTime(open.takenAt)}</span>
            </div>
            {open.gpsLat !== null && (
              <div className="between">
                <span className="muted">Location</span>
                <a
                  href={`https://www.google.com/maps?q=${open.gpsLat},${open.gpsLng}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {open.gpsLat.toFixed(5)}, {open.gpsLng?.toFixed(5)}
                </a>
              </div>
            )}
            <div className="between">
              <span className="muted">In report</span>
              <span className={open.includeInReport ? 'badge badge-delivered' : 'badge'}>
                {open.includeInReport ? 'included' : 'excluded'}
              </span>
            </div>
            {open.nonConforming && (
              <div className="between">
                <span className="muted">Finding</span>
                <span className="badge badge-nc">non-conforming</span>
              </div>
            )}
          </div>

          <ErrorNotice error={toggleInclude.error} />
          {open.nonConforming ? (
            <p className="hint mt">
              Non-conforming photos are always in the report. Clear the flag on the
              structure's screen first if it was set by mistake.
            </p>
          ) : (
            <>
              <button
                className="btn btn-block mt"
                disabled={toggleInclude.isPending}
                onClick={() => toggleInclude.mutate(open)}
              >
                {toggleInclude.isPending && <span className="spin" />}
                {open.includeInReport ? 'Exclude from report' : 'Include in report'}
              </button>
              <p className="hint">
                Only people who can edit this job can change that. Clients see this
                control fail, which is intended.
              </p>
            </>
          )}
        </Modal>
      )}
    </>
  );
}

/** Grouping by capture day is how people actually look for a photo. */
function groupByDay(photos: GalleryPhoto[]): [string, GalleryPhoto[]][] {
  const map = new Map<string, GalleryPhoto[]>();
  for (const p of photos) {
    const key = p.takenAt
      ? new Date(p.takenAt).toLocaleDateString(undefined, {
          weekday: 'long',
          month: 'long',
          day: 'numeric',
          year: 'numeric',
        })
      : 'Undated';
    const list = map.get(key);
    if (list) list.push(p);
    else map.set(key, [p]);
  }
  return [...map.entries()];
}
