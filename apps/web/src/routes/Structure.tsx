import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  PhotoReview,
  ToggleRow,
  usePhotoPicker,
  type PhotoChoices,
} from '../components/capture.js';
import {
  AlertIcon,
  CameraIcon,
  CheckIcon,
  ImagesIcon,
  MicIcon,
  TagIcon,
} from '../components/icons.js';
import { ErrorNotice, formatDateTime, Loading, Modal } from '../components/ui.js';
import { api, ApiError } from '../lib/api.js';
import { releasePhoto, renderReportPhoto, type CapturedPhoto } from '../lib/image.js';
import {
  inspectionKeys,
  plural,
  structureTitle,
  type StructurePhoto,
  type StructureResponse,
  type StructureSummary,
} from '../lib/inspection.js';
import { useDictation } from '../lib/speech.js';
import { uploadPhoto } from '../lib/upload.js';

/**
 * One structure: where the inspection actually happens.
 *
 * Every photo taken here files under this structure. Comments are dictated or
 * typed and save themselves, so a dropped phone or a dead battery costs at
 * most the last second of typing. "Finish Structure" puts it on the
 * inspection screen as done; it stays editable until the job is submitted.
 */
export default function StructureRoute() {
  const { structureId = '' } = useParams<{ structureId: string }>();
  // Keyed, so moving between structures starts clean instead of carrying
  // one structure's unsaved comments into the next.
  return <Structure key={structureId} />;
}

function Structure() {
  const { id: jobId = '', structureId = '' } = useParams<{
    id: string;
    structureId: string;
  }>();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const [pending, setPending] = useState<CapturedPhoto | null>(null);
  const [openPhotoId, setOpenPhotoId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const data = useQuery({
    queryKey: inspectionKeys.structure(jobId, structureId),
    queryFn: () => api<StructureResponse>(`/api/jobs/${jobId}/structures/${structureId}`),
  });

  const canWrite = data.data?.permissions.canWriteContent ?? false;
  const comments = useAutosavedComments(jobId, structureId, data.data?.structure.comments, canWrite);

  // The tile on the inspection screen and the job's photo count change with
  // anything done here, so all three are refreshed together.
  const refresh = useCallback(
    () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: inspectionKeys.structure(jobId, structureId) }),
        qc.invalidateQueries({ queryKey: inspectionKeys.structures(jobId) }),
        qc.invalidateQueries({ queryKey: inspectionKeys.job(jobId) }),
      ]),
    [qc, jobId, structureId],
  );

  const savePhoto = useMutation({
    mutationFn: async (choices: PhotoChoices) => {
      if (!pending || !data.data) throw new Error('No photo to save');
      return uploadPhoto({
        jobId,
        objectId: data.data.structure.objectId,
        photo: await renderReportPhoto(pending, choices.offset),
        includeInReport: choices.includeInReport,
        nonConforming: choices.nonConforming,
        caption: choices.caption || undefined,
        clientRef: pending.clientRef,
      });
    },
    onSuccess: () => {
      setPending(null);
      return refresh();
    },
  });

  const picker = usePhotoPicker((photo) => {
    savePhoto.reset();
    setPending(photo);
  });

  // Release each preview when it is replaced, and the last one on leaving.
  useEffect(() => () => releasePhoto(pending), [pending]);

  const finish = useMutation({
    mutationFn: async () => {
      if (!(await comments.flush())) {
        throw new Error("Your comments haven't saved yet. Check your signal and try again.");
      }
      return api(`/api/jobs/${jobId}/structures/${structureId}`, {
        method: 'PATCH',
        body: { finished: true },
      });
    },
    onSuccess: async () => {
      await refresh();
      navigate(`/jobs/${jobId}/inspect`);
    },
  });

  async function done() {
    await comments.flush();
    navigate(`/jobs/${jobId}/inspect`);
  }

  if (data.isLoading) return <Loading label="Loading structure" />;
  if (data.isError) {
    return (
      <>
        <ErrorNotice error={data.error} />
        <Link className="btn" to={`/jobs/${jobId}/inspect`}>
          Back to the inspection
        </Link>
      </>
    );
  }
  if (!data.data) return null;

  const { structure: s, photos, structureTypes } = data.data;
  const openPhoto = photos.find((p) => p.id === openPhotoId) ?? null;

  return (
    <>
      {picker.inputs}

      <div className="page-head" style={{ marginBottom: 12 }}>
        <Link to={`/jobs/${jobId}/inspect`} className="small muted">
          ← Inspection
        </Link>
      </div>

      <div className="card structure-head mb">
        <button
          className="head-thumb"
          onClick={() => s.cover && setOpenPhotoId(s.cover.photoId)}
          aria-label="Open the serial plate photo"
          disabled={!s.cover}
        >
          {s.cover ? <img src={s.cover.url} alt="" /> : <CameraIcon size={26} />}
        </button>
        <div className="head-main">
          <h1 className="structure-title">{structureTitle(s)}</h1>
          <div className="mono muted truncate">{s.serialNumber}</div>
          <div className="inline" style={{ marginTop: 8, gap: 6 }}>
            {s.finishedAt ? (
              <span className="badge badge-delivered">
                <CheckIcon size={12} />
                Finished
              </span>
            ) : (
              <span className="badge badge-in_progress">In progress</span>
            )}
            {s.nonConformingCount > 0 && (
              <span className="badge badge-nc">
                <AlertIcon size={12} />
                {s.nonConformingCount} non-conforming
              </span>
            )}
          </div>
        </div>
        {canWrite && (
          <button className="btn btn-sm head-edit" onClick={() => setEditing(true)}>
            Edit
          </button>
        )}
      </div>

      <CommentsCard comments={comments} canWrite={canWrite} saved={s.comments} />

      <div className="card card-pad mb">
        <div className="between mb">
          <h2>Photos</h2>
          <span className="pill">{plural(photos.length, 'photo')}</span>
        </div>
        {photos.length === 0 ? (
          <p className="small muted">
            {canWrite
              ? `Tap the camera to photograph this structure. Every photo files under ${s.serialNumber}.`
              : 'No photos of this structure.'}
          </p>
        ) : (
          <div className="photo-grid">
            {photos.map((p) => (
              <button
                key={p.id}
                className={`photo${p.nonConforming ? ' photo-nc' : ''}`}
                onClick={() => setOpenPhotoId(p.id)}
              >
                <img src={p.url} alt={p.caption ?? 'Inspection photo'} loading="lazy" />
                <div className="photo-tag">
                  {p.isSerialPlate && <span className="photo-flag plate">Serial plate</span>}
                  {p.nonConforming && <span className="photo-flag nc">Non-conforming</span>}
                  {!p.includeInReport && (
                    <span className="photo-flag excluded">Not in report</span>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}
        <Link to={`/objects/${s.objectId}`} className="small mt" style={{ display: 'inline-block' }}>
          Every inspection of {s.serialNumber} →
        </Link>
      </div>

      <ErrorNotice error={picker.error ?? finish.error} />

      {canWrite && (
        <div className="capture-bar">
          <div className="capture-row">
            <button
              className="btn btn-lg icon-btn"
              onClick={picker.openLibrary}
              disabled={picker.busy}
              aria-label="Add a photo from the library"
            >
              <ImagesIcon size={22} />
            </button>
            <button
              className="camera-btn"
              onClick={picker.openCamera}
              disabled={picker.busy}
              aria-label="Take a photo"
            >
              {picker.busy ? <span className="spin" /> : <CameraIcon size={30} />}
            </button>
            {s.finishedAt ? (
              <button className="btn btn-lg" onClick={done}>
                Done
              </button>
            ) : (
              <button
                className="btn btn-primary btn-lg"
                onClick={() => finish.mutate()}
                disabled={finish.isPending}
              >
                {finish.isPending ? <span className="spin" /> : <CheckIcon size={18} />}
                Finish Structure
              </button>
            )}
          </div>
        </div>
      )}

      {pending && (
        <PhotoReview
          photo={pending}
          saving={savePhoto.isPending}
          error={savePhoto.error}
          onSave={(choices) => savePhoto.mutate(choices)}
          onDiscard={() => {
            savePhoto.reset();
            setPending(null);
          }}
          onRetake={() => {
            savePhoto.reset();
            setPending(null);
            picker.openCamera();
          }}
        />
      )}

      {openPhoto && (
        <PhotoSheet
          photo={openPhoto}
          canWrite={canWrite}
          onChanged={refresh}
          onClose={() => setOpenPhotoId(null)}
        />
      )}

      {editing && (
        <EditStructure
          jobId={jobId}
          structure={s}
          types={structureTypes}
          onClose={() => setEditing(false)}
          onSaved={async () => {
            setEditing(false);
            await refresh();
          }}
          onRemoved={async () => {
            await qc.invalidateQueries({ queryKey: inspectionKeys.structures(jobId) });
            await qc.invalidateQueries({ queryKey: inspectionKeys.job(jobId) });
            navigate(`/jobs/${jobId}/inspect`, { replace: true });
          }}
        />
      )}
    </>
  );
}

// --- Comments ----------------------------------------------------------------

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

interface AutosavedComments {
  value: string;
  setValue(next: string): void;
  append(text: string): void;
  state: SaveState;
  /** Saves whatever is newest and resolves true once the server has it. */
  flush(): Promise<boolean>;
}

/**
 * Comments that save themselves a moment after the inspector stops typing or
 * speaking. Saves run one at a time and each sends the newest text, so a slow
 * request can never land after a faster, newer one and roll the comments back.
 */
function useAutosavedComments(
  jobId: string,
  structureId: string,
  initial: string | null | undefined,
  enabled: boolean,
): AutosavedComments {
  const [value, setValueState] = useState<string | null>(null);
  const [state, setState] = useState<SaveState>('idle');
  const latest = useRef<string | null>(null);
  const saved = useRef<string>('');
  const chain = useRef<Promise<boolean>>(Promise.resolve(true));

  // Adopt the server's text once, when it first arrives.
  useEffect(() => {
    if (value === null && initial !== undefined) {
      const text = initial ?? '';
      saved.current = text;
      latest.current = text;
      setValueState(text);
    }
  }, [initial, value]);

  const setValue = useCallback((next: string) => {
    latest.current = next;
    setValueState(next);
  }, []);

  const append = useCallback((text: string) => {
    const prev = latest.current ?? '';
    const next = prev.trim() ? `${prev.trimEnd()} ${text}` : text;
    latest.current = next;
    setValueState(next);
  }, []);

  const flush = useCallback((): Promise<boolean> => {
    const run = async (): Promise<boolean> => {
      const text = latest.current;
      if (!enabled || text === null || text === saved.current) return true;
      setState('saving');
      try {
        await api(`/api/jobs/${jobId}/structures/${structureId}`, {
          method: 'PATCH',
          body: { comments: text },
        });
        saved.current = text;
        setState(latest.current === text ? 'saved' : 'saving');
        return true;
      } catch {
        setState('error');
        return false;
      }
    };
    const next = chain.current.then(run, run);
    chain.current = next;
    return next;
  }, [enabled, jobId, structureId]);

  // Save shortly after the last keystroke or dictated phrase.
  useEffect(() => {
    if (value === null || value === saved.current) return;
    const timer = setTimeout(() => void flush(), 900);
    return () => clearTimeout(timer);
  }, [value, flush]);

  // And once more on the way out, for anything typed in the last moment.
  useEffect(() => () => void flush(), [flush]);

  return { value: value ?? '', setValue, append, state, flush };
}

function CommentsCard({
  comments,
  canWrite,
  saved,
}: {
  comments: AutosavedComments;
  canWrite: boolean;
  saved: string | null;
}) {
  const dictation = useDictation(comments.append);
  const fieldId = useId();

  if (!canWrite) {
    return (
      <div className="card card-pad mb">
        <h2 style={{ marginBottom: 8 }}>Comments</h2>
        <p className="small" style={{ whiteSpace: 'pre-wrap' }}>
          {saved?.trim() ? saved : <span className="muted">No comments.</span>}
        </p>
      </div>
    );
  }

  return (
    <div className="card card-pad mb">
      <div className="between" style={{ marginBottom: 8 }}>
        <label htmlFor={fieldId}>
          <h2>Comments</h2>
        </label>
        {dictation.supported && (
          <button
            type="button"
            className={`btn btn-sm${dictation.listening ? ' btn-danger dictating' : ''}`}
            onClick={() => (dictation.listening ? dictation.stop() : dictation.start())}
          >
            <MicIcon size={16} />
            {dictation.listening ? 'Stop' : 'Dictate'}
          </button>
        )}
      </div>
      <textarea
        id={fieldId}
        className="textarea comments-box"
        placeholder="What did you find? Condition, any deviation from the drawings, and what needs to happen."
        value={comments.value + (dictation.interim ? ` ${dictation.interim}` : '')}
        onChange={(e) => comments.setValue(e.target.value)}
      />
      <div className="between" style={{ marginTop: 6 }}>
        <span className={`tiny ${comments.state === 'error' ? 'nc-text' : 'dim'}`}>
          {comments.state === 'saving' && 'Saving…'}
          {comments.state === 'saved' && 'Saved'}
          {comments.state === 'error' && "Not saved - check your signal"}
        </span>
        {comments.state === 'error' && (
          <button className="btn btn-sm btn-ghost" onClick={() => void comments.flush()}>
            Try again
          </button>
        )}
      </div>
      {dictation.error && <div className="hint">{dictation.error}</div>}
      {!dictation.supported && (
        <div className="hint">Dictation isn't available in this browser - type instead.</div>
      )}
    </div>
  );
}

// --- One photo ---------------------------------------------------------------

function PhotoSheet({
  photo,
  canWrite,
  onChanged,
  onClose,
}: {
  photo: StructurePhoto;
  canWrite: boolean;
  onChanged(): Promise<unknown>;
  onClose(): void;
}) {
  const [caption, setCaption] = useState(photo.caption ?? '');

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api(`/api/photos/${photo.id}`, { method: 'PATCH', body }),
    // Wait for the fresh list, so the toggles never show a stale state.
    onSuccess: () => onChanged(),
  });

  const remove = useMutation({
    mutationFn: () => api(`/api/photos/${photo.id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      onClose();
      await onChanged();
    },
  });

  const busy = patch.isPending || remove.isPending;

  return (
    <Modal wide title={photo.isSerialPlate ? 'Serial plate photo' : 'Photo'} onClose={onClose}>
      <div className="lightbox mb">
        <img src={photo.url} alt={photo.caption ?? 'Inspection photo'} />
      </div>

      {canWrite ? (
        <>
          <div className="stack" style={{ gap: 8 }}>
            <ToggleRow
              checked={photo.nonConforming}
              disabled={busy}
              onChange={(v) => patch.mutate({ nonConforming: v })}
              tone="danger"
              title="Non-conforming"
              description="Shows something that doesn't meet the drawings or spec. Always included in the report."
            />
            <ToggleRow
              checked={photo.includeInReport}
              disabled={busy || photo.nonConforming}
              onChange={(v) => patch.mutate({ includeInReport: v })}
              title="Include in report"
              description={
                photo.nonConforming
                  ? 'Required for non-conforming photos.'
                  : 'Every photo stays in the gallery either way.'
              }
            />
          </div>

          <label className="field mt">
            <span className="label">Caption</span>
            <input
              className="input"
              value={caption}
              placeholder="Optional"
              onChange={(e) => setCaption(e.target.value)}
              onBlur={() => {
                const next = caption.trim();
                if (next !== (photo.caption ?? '')) patch.mutate({ caption: next || null });
              }}
            />
          </label>

          <div className="btn-row">
            {!photo.isSerialPlate && (
              <button
                className="btn btn-sm"
                disabled={busy}
                onClick={() => patch.mutate({ serialPlate: true })}
              >
                <TagIcon size={16} />
                Use as the serial plate photo
              </button>
            )}
            <button
              className="btn btn-sm btn-danger"
              disabled={busy}
              onClick={() => {
                if (window.confirm('Delete this photo? This cannot be undone.')) remove.mutate();
              }}
            >
              Delete photo
            </button>
          </div>
        </>
      ) : (
        <div className="inline">
          {photo.isSerialPlate && <span className="badge">Serial plate</span>}
          {photo.nonConforming && <span className="badge badge-nc">Non-conforming</span>}
          <span className={photo.includeInReport ? 'badge badge-delivered' : 'badge'}>
            {photo.includeInReport ? 'In report' : 'Not in report'}
          </span>
        </div>
      )}

      <div className="stack small mt">
        <div className="between">
          <span className="muted">Taken</span>
          <span>{formatDateTime(photo.takenAt)}</span>
        </div>
        {photo.gpsLat !== null && photo.gpsLng !== null && (
          <div className="between">
            <span className="muted">Location</span>
            <a
              href={`https://www.google.com/maps?q=${photo.gpsLat},${photo.gpsLng}`}
              target="_blank"
              rel="noreferrer"
            >
              {photo.gpsLat.toFixed(5)}, {photo.gpsLng.toFixed(5)}
            </a>
          </div>
        )}
      </div>

      <div className="mt">
        <ErrorNotice error={patch.error ?? remove.error} />
      </div>
    </Modal>
  );
}

// --- Edit --------------------------------------------------------------------

function EditStructure({
  jobId,
  structure,
  types,
  onClose,
  onSaved,
  onRemoved,
}: {
  jobId: string;
  structure: StructureSummary;
  types: string[];
  onClose(): void;
  onSaved(): Promise<void>;
  onRemoved(): Promise<void>;
}) {
  const typeListId = useId();
  const [serialNumber, setSerialNumber] = useState(structure.serialNumber);
  const [structureType, setStructureType] = useState(structure.structureType ?? '');
  const url = `/api/jobs/${jobId}/structures/${structure.id}`;

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, string> = {};
      if (serialNumber.trim() !== structure.serialNumber) body.serialNumber = serialNumber.trim();
      if (structureType.trim() !== (structure.structureType ?? '')) {
        body.structureType = structureType.trim();
      }
      return api(url, { method: 'PATCH', body });
    },
    onSuccess: () => onSaved(),
  });

  const remove = useMutation({
    mutationFn: () => api(url, { method: 'DELETE' }),
    onSuccess: () => onRemoved(),
  });

  const clash =
    save.error instanceof ApiError && save.error.code === 'structure_exists'
      ? (save.error.details as { structureId?: string } | undefined)?.structureId
      : undefined;
  const busy = save.isPending || remove.isPending;

  return (
    <Modal
      title="Edit structure"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || !serialNumber.trim() || !structureType.trim()}
            onClick={() => save.mutate()}
          >
            {save.isPending && <span className="spin" />}
            Save
          </button>
        </>
      }
    >
      <label className="field">
        <span className="label">Serial number</span>
        <input
          className="input mono"
          autoCapitalize="characters"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          value={serialNumber}
          onChange={(e) => setSerialNumber(e.target.value)}
        />
        <span className="hint">
          Correcting a typo moves this structure's photos to the right serial. Other
          inspections of the old serial are not changed.
        </span>
      </label>

      <label className="field">
        <span className="label">Structure type</span>
        <input
          className="input"
          list={typeListId}
          autoComplete="off"
          value={structureType}
          onChange={(e) => setStructureType(e.target.value)}
        />
        <datalist id={typeListId}>
          {types.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
      </label>

      {clash ? (
        <div className="notice notice-warn">
          {serialNumber.trim()} is already a structure in this inspection.{' '}
          <Link to={`/jobs/${jobId}/inspect/${clash}`} onClick={onClose}>
            Open it
          </Link>
        </div>
      ) : (
        <ErrorNotice error={save.error ?? remove.error} />
      )}

      <div className="danger-zone">
        <div className="small">
          <div className="strong">Remove from this inspection</div>
          <div className="muted">
            Deletes this structure and its {plural(structure.photoCount, 'photo')} on this
            job.
          </div>
        </div>
        <button
          className="btn btn-sm btn-danger"
          disabled={busy}
          onClick={() => {
            if (
              window.confirm(
                `Remove ${structure.serialNumber} and its ${plural(structure.photoCount, 'photo')} from this inspection? This cannot be undone.`,
              )
            ) {
              remove.mutate();
            }
          }}
        >
          Remove
        </button>
      </div>
    </Modal>
  );
}
