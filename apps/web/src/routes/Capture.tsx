import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ErrorNotice, Loading, Modal } from '../components/ui.js';
import { api } from '../lib/api.js';
import { formatBytes, processPhoto, type ProcessedPhoto } from '../lib/image.js';
import { useDictation } from '../lib/speech.js';
import { newClientRef, uploadPhoto } from '../lib/upload.js';

interface JobDetailResponse {
  job: { id: string; jobNumber: string; title: string; status: string };
  site: { id: string; name: string };
  objects: {
    objectId: string;
    serialNumber: string;
    label: string | null;
    photoCount: number;
  }[];
  permissions: { canWriteContent: boolean };
}

interface PhotoRow {
  id: string;
  url: string;
  caption: string | null;
  voiceNote: string | null;
  includeInReport: boolean;
  objectSerial: string | null;
}

/**
 * The inspector's working screen.
 *
 * Everything is organised by object, because that is how the work actually
 * happens: you stand in front of one piece of equipment and document it before
 * moving to the next. The object is chosen once and stays selected across
 * shots, so photographing eight views of the same unit is eight taps, not
 * twenty-four.
 */
export default function Capture() {
  const { id: jobId } = useParams<{ id: string }>();
  const qc = useQueryClient();

  const [objectId, setObjectId] = useState<string | null>(null);
  const [showNewObject, setShowNewObject] = useState(false);
  const [pending, setPending] = useState<ProcessedPhoto | null>(null);
  const [processing, setProcessing] = useState(false);
  const [caption, setCaption] = useState('');
  const [voiceNote, setVoiceNote] = useState('');
  const [dictated, setDictated] = useState(false);
  const [includeInReport, setIncludeInReport] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const cameraRef = useRef<HTMLInputElement>(null);
  const libraryRef = useRef<HTMLInputElement>(null);

  const job = useQuery({
    queryKey: ['job', jobId],
    queryFn: () => api<JobDetailResponse>(`/api/jobs/${jobId}`),
  });

  const photos = useQuery({
    queryKey: ['job-photos', jobId],
    queryFn: () => api<{ photos: PhotoRow[] }>(`/api/jobs/${jobId}/photos`),
  });

  const appendDictation = useCallback((text: string) => {
    setDictated(true);
    setVoiceNote((prev) => (prev ? `${prev.trim()} ${text}` : text));
  }, []);
  const dictation = useDictation(appendDictation);

  // A preview blob URL is a real allocation; release it when it goes away.
  useEffect(() => {
    return () => {
      if (pending) URL.revokeObjectURL(pending.previewUrl);
    };
  }, [pending]);

  const createObject = useMutation({
    mutationFn: (input: { serialNumber: string; label?: string; objectType?: string }) =>
      api<{ object: { id: string }; reused: boolean }>('/api/objects', {
        method: 'POST',
        body: { ...input, siteId: job.data!.site.id, jobId },
      }),
    onSuccess: (res) => {
      setObjectId(res.object.id);
      setShowNewObject(false);
      qc.invalidateQueries({ queryKey: ['job', jobId] });
    },
  });

  const save = useMutation({
    mutationFn: async () => {
      if (!pending || !jobId) throw new Error('No photo to save');
      return uploadPhoto({
        jobId,
        objectId,
        photo: pending,
        caption,
        voiceNote,
        voiceNoteIsDictated: dictated,
        includeInReport,
        clientRef: newClientRef(),
      });
    },
    onSuccess: () => {
      discard();
      qc.invalidateQueries({ queryKey: ['job-photos', jobId] });
      qc.invalidateQueries({ queryKey: ['job', jobId] });
    },
    onError: (err) => setError(err),
  });

  function discard() {
    if (pending) URL.revokeObjectURL(pending.previewUrl);
    setPending(null);
    setCaption('');
    setVoiceNote('');
    setDictated(false);
    setIncludeInReport(true);
    dictation.stop();
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset so picking the same file twice still fires a change event.
    e.target.value = '';
    if (!file) return;

    setError(null);
    setProcessing(true);
    try {
      setPending(await processPhoto(file));
    } catch (err) {
      setError(err);
    } finally {
      setProcessing(false);
    }
  }

  if (job.isLoading) return <Loading label="Loading job" />;
  if (job.isError) return <ErrorNotice error={job.error} />;
  if (!job.data) return null;

  if (!job.data.permissions.canWriteContent) {
    return (
      <div className="card card-pad">
        <div className="notice notice-warn">
          This job is no longer open for field work, so photos cannot be added.
        </div>
        <Link className="btn" to={`/jobs/${jobId}`}>
          Back to job
        </Link>
      </div>
    );
  }

  const current = job.data.objects.find((o) => o.objectId === objectId);
  const objectPhotos = objectId
    ? (photos.data?.photos ?? []).filter(
        (p) => p.objectSerial === current?.serialNumber,
      )
    : (photos.data?.photos ?? []);

  return (
    <>
      <div className="page-head">
        <div style={{ minWidth: 0 }}>
          <Link to={`/jobs/${jobId}`} className="small muted">
            ← {job.data.job.title}
          </Link>
          <h1 style={{ marginTop: 6 }}>Capture</h1>
          <div className="page-sub">{job.data.site.name}</div>
        </div>
      </div>

      <ErrorNotice error={error} />

      {/* --- Object selection ------------------------------------------- */}
      <div className="card card-pad mb">
        <div className="between mb">
          <h2>Object</h2>
          <button className="btn btn-sm" onClick={() => setShowNewObject(true)}>
            + New object
          </button>
        </div>

        {job.data.objects.length === 0 ? (
          <p className="small muted">
            No objects on this job yet. Add one with its serial number, then start
            photographing it.
          </p>
        ) : (
          <div className="btn-row">
            <button
              className={`btn btn-sm${objectId === null ? ' btn-primary' : ''}`}
              onClick={() => setObjectId(null)}
            >
              Unassigned
            </button>
            {job.data.objects.map((o) => (
              <button
                key={o.objectId}
                className={`btn btn-sm${objectId === o.objectId ? ' btn-primary' : ''}`}
                onClick={() => setObjectId(o.objectId)}
              >
                <span className="mono">{o.serialNumber}</span>
                <span className="tiny dim">{o.photoCount}</span>
              </button>
            ))}
          </div>
        )}

        {current && (
          <p className="hint">
            Photos will be filed under <strong>{current.serialNumber}</strong>
            {current.label ? ` — ${current.label}` : ''}. This object keeps its
            history across every job at this site.
          </p>
        )}
        {!current && (
          <p className="hint">
            Photos taken now are unassigned. You can attach them to an object
            later from the gallery.
          </p>
        )}
      </div>

      {/* --- Existing photos --------------------------------------------- */}
      {objectPhotos.length > 0 && (
        <div className="card card-pad mb">
          <div className="between mb">
            <h2>{current ? `Photos of ${current.serialNumber}` : 'Photos on this job'}</h2>
            <span className="pill">{objectPhotos.length}</span>
          </div>
          <div className="photo-grid">
            {objectPhotos.map((p) => (
              <div className="photo" key={p.id}>
                <img src={p.url} alt={p.caption ?? 'Inspection photo'} loading="lazy" />
                <div className="photo-tag">
                  {!p.includeInReport && (
                    <span className="photo-flag excluded">not in report</span>
                  )}
                  {p.voiceNote && <span className="photo-flag">note</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* --- Capture bar -------------------------------------------------- */}
      <div className="capture-bar">
        <input
          ref={cameraRef}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={onFile}
        />
        <input ref={libraryRef} type="file" accept="image/*" hidden onChange={onFile} />

        <div className="btn-row">
          <button
            className="btn btn-primary btn-lg"
            style={{ flex: 1 }}
            disabled={processing}
            onClick={() => cameraRef.current?.click()}
          >
            {processing ? <span className="spin" /> : null}
            {processing ? 'Processing' : 'Take photo'}
          </button>
          <button
            className="btn btn-lg"
            disabled={processing}
            onClick={() => libraryRef.current?.click()}
          >
            Library
          </button>
        </div>
      </div>

      {/* --- New object modal --------------------------------------------- */}
      {showNewObject && (
        <NewObjectModal
          onClose={() => setShowNewObject(false)}
          onSubmit={(v) => createObject.mutate(v)}
          busy={createObject.isPending}
          error={createObject.error}
        />
      )}

      {/* --- Review captured photo ---------------------------------------- */}
      {pending && (
        <Modal
          title="Review photo"
          onClose={discard}
          footer={
            <>
              <button className="btn" onClick={discard} disabled={save.isPending}>
                Discard
              </button>
              <button
                className="btn btn-primary"
                onClick={() => save.mutate()}
                disabled={save.isPending}
              >
                {save.isPending && <span className="spin" />}
                Save photo
              </button>
            </>
          }
        >
          <div className="lightbox mb">
            <img src={pending.previewUrl} alt="Captured" />
          </div>

          <div className="inline tiny dim mb">
            <span>
              {pending.width}×{pending.height}
            </span>
            <span>·</span>
            <span>
              {formatBytes(pending.originalBytes)} → {formatBytes(pending.bytes)}
            </span>
            {pending.gpsLat !== null && (
              <>
                <span>·</span>
                <span>
                  {pending.gpsLat.toFixed(5)}, {pending.gpsLng?.toFixed(5)}{' '}
                  {pending.gpsSource === 'exif' ? '(photo)' : '(device)'}
                </span>
              </>
            )}
          </div>

          {pending.gpsLat === null && (
            <div className="notice notice-warn tiny">
              No location captured. Allow location access if you need photos to
              carry proof of where they were taken.
            </div>
          )}

          <label className="field">
            <span className="label">Caption</span>
            <input
              className="input"
              placeholder="Northeast foundation wall"
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
            />
          </label>

          <div className="field">
            <div className="between" style={{ marginBottom: 5 }}>
              <span className="label" style={{ margin: 0 }}>
                Note
              </span>
              {dictation.supported && (
                <button
                  type="button"
                  className={`btn btn-sm${dictation.listening ? ' btn-danger dictating' : ''}`}
                  onClick={() => (dictation.listening ? dictation.stop() : dictation.start())}
                >
                  {dictation.listening ? '● Stop dictation' : '🎤 Dictate'}
                </button>
              )}
            </div>
            <textarea
              className="textarea"
              placeholder="Describe what you are looking at…"
              value={voiceNote + (dictation.interim ? ` ${dictation.interim}` : '')}
              onChange={(e) => {
                setVoiceNote(e.target.value);
                setDictated(false);
              }}
            />
            {dictation.error && <div className="hint">{dictation.error}</div>}
            {!dictation.supported && (
              <div className="hint">
                Dictation isn't available in this browser — type the note instead.
              </div>
            )}
          </div>

          <label className="check">
            <input
              type="checkbox"
              checked={includeInReport}
              onChange={(e) => setIncludeInReport(e.target.checked)}
            />
            <span>
              <span className="strong">Include in report</span>
              <span className="segment-desc">
                Every photo stays in the gallery either way. You can change this
                later.
              </span>
            </span>
          </label>
        </Modal>
      )}
    </>
  );
}

function NewObjectModal({
  onClose,
  onSubmit,
  busy,
  error,
}: {
  onClose(): void;
  onSubmit(v: { serialNumber: string; label?: string; objectType?: string }): void;
  busy: boolean;
  error: unknown;
}) {
  const [serialNumber, setSerialNumber] = useState('');
  const [label, setLabel] = useState('');
  const [objectType, setObjectType] = useState('');

  return (
    <Modal
      title="New object"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || !serialNumber.trim()}
            onClick={() =>
              onSubmit({
                serialNumber: serialNumber.trim(),
                label: label.trim() || undefined,
                objectType: objectType.trim() || undefined,
              })
            }
          >
            {busy && <span className="spin" />}
            Add object
          </button>
        </>
      }
    >
      <ErrorNotice error={error} />
      <label className="field">
        <span className="label">Serial number</span>
        <input
          className="input mono"
          autoFocus
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          placeholder="ELV-4471"
          value={serialNumber}
          onChange={(e) => setSerialNumber(e.target.value)}
        />
        <span className="hint">
          If this serial already exists at this site, you'll be switched to that
          object instead of creating a duplicate.
        </span>
      </label>
      <label className="field">
        <span className="label">Label (optional)</span>
        <input
          className="input"
          placeholder="Passenger Elevator 1"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
      </label>
      <label className="field">
        <span className="label">Type (optional)</span>
        <input
          className="input"
          placeholder="Elevator"
          value={objectType}
          onChange={(e) => setObjectType(e.target.value)}
        />
      </label>
    </Modal>
  );
}
