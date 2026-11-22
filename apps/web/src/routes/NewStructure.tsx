import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { FramedPhoto, ReframeSlider, usePhotoPicker } from '../components/capture.js';
import { CameraIcon, ImagesIcon } from '../components/icons.js';
import { ErrorNotice, Loading } from '../components/ui.js';
import { api, ApiError } from '../lib/api.js';
import { releasePhoto, renderReportPhoto, type CapturedPhoto } from '../lib/image.js';
import {
  inspectionKeys,
  type InspectionJob,
  type StructuresResponse,
  type StructureSummary,
} from '../lib/inspection.js';
import { uploadPhoto } from '../lib/upload.js';

/**
 * "New Structure": photograph the ID plate, then record the serial and what
 * the structure is.
 *
 * The plate comes first because it is the record of what was actually there -
 * the photo the serial is typed from, the structure's thumbnail, and the first
 * photo of its section in the report. A structure with no plate to photograph
 * (painted over, missing - itself often a finding) can skip it.
 */
export default function NewStructure() {
  const { id: jobId = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const typeListId = useId();

  const [plate, setPlate] = useState<CapturedPhoto | null>(null);
  const [skipPlate, setSkipPlate] = useState(false);
  const [offset, setOffset] = useState(0.5);
  const [serialNumber, setSerialNumber] = useState('');
  const [structureType, setStructureType] = useState('');
  /** Set once the structure exists, so a failed plate upload retries alone. */
  const [created, setCreated] = useState<StructureSummary | null>(null);
  const [duplicateOf, setDuplicateOf] = useState<string | null>(null);

  const job = useQuery({
    queryKey: inspectionKeys.job(jobId),
    queryFn: () => api<InspectionJob>(`/api/jobs/${jobId}`),
  });
  const structures = useQuery({
    queryKey: inspectionKeys.structures(jobId),
    queryFn: () => api<StructuresResponse>(`/api/jobs/${jobId}/structures`),
  });

  const picker = usePhotoPicker((photo) => {
    setPlate(photo);
    setSkipPlate(false);
    setOffset(0.5);
  });

  // Release each preview when it is replaced, and the last one on leaving.
  useEffect(() => () => releasePhoto(plate), [plate]);

  const save = useMutation({
    mutationFn: async () => {
      let structure = created;
      if (!structure) {
        const res = await api<{ structure: StructureSummary }>(
          `/api/jobs/${jobId}/structures`,
          {
            method: 'POST',
            body: {
              serialNumber: serialNumber.trim(),
              structureType: structureType.trim(),
            },
          },
        );
        structure = res.structure;
        setCreated(structure);
      }

      if (plate) {
        await uploadPhoto({
          jobId,
          objectId: structure.objectId,
          photo: await renderReportPhoto(plate, offset),
          includeInReport: true,
          serialPlate: true,
          clientRef: plate.clientRef,
        });
      }
      return structure;
    },
    onMutate: () => setDuplicateOf(null),
    onSuccess: (structure) => {
      qc.invalidateQueries({ queryKey: inspectionKeys.structures(jobId) });
      qc.invalidateQueries({ queryKey: inspectionKeys.job(jobId) });
      // Replace, so Back from the structure returns to the inspection rather
      // than to this form.
      navigate(`/jobs/${jobId}/inspect/${structure.id}`, { replace: true });
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'structure_exists') {
        const details = err.details as { structureId?: string } | undefined;
        setDuplicateOf(details?.structureId ?? null);
      }
      if (created) {
        qc.invalidateQueries({ queryKey: inspectionKeys.structures(jobId) });
      }
    },
  });

  if (job.isLoading) return <Loading label="Loading inspection" />;
  if (job.isError) return <ErrorNotice error={job.error} />;
  if (!job.data) return null;

  if (!job.data.permissions.canWriteContent) {
    return (
      <div className="card card-pad">
        <div className="notice notice-warn">
          This inspection is closed, so structures can't be added.
        </div>
        <Link className="btn" to={`/jobs/${jobId}/inspect`}>
          Back to the inspection
        </Link>
      </div>
    );
  }

  const ready = !!serialNumber.trim() && !!structureType.trim();
  const showDetails = !!plate || skipPlate;

  return (
    <>
      {picker.inputs}

      <div className="page-head">
        <div style={{ minWidth: 0 }}>
          <Link to={`/jobs/${jobId}/inspect`} className="small muted">
            ← Inspection
          </Link>
          <h1 style={{ marginTop: 6 }}>New Structure</h1>
          <div className="page-sub">{job.data.site.name}</div>
        </div>
      </div>

      <div className="card card-pad mb">
        <div className="step-label">Step 1 of 2</div>
        <h2 className="mb">Serial number plate</h2>

        {!plate && !skipPlate && (
          <>
            <p className="small muted mb">
              Photograph the structure's ID plate so the serial can be read off it.
              This photo becomes the structure's thumbnail and the first photo in its
              section of the report.
            </p>
            <button
              className="btn btn-primary btn-lg btn-block"
              onClick={picker.openCamera}
              disabled={picker.busy}
            >
              {picker.busy ? <span className="spin" /> : <CameraIcon size={22} />}
              {picker.busy ? 'Opening photo' : 'Photograph the serial plate'}
            </button>
            <div className="between mt">
              <button className="btn btn-ghost btn-sm" onClick={picker.openLibrary}>
                <ImagesIcon size={16} />
                Choose from library
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => setSkipPlate(true)}>
                No plate? Skip
              </button>
            </div>
          </>
        )}

        {plate && (
          <>
            <div className="plate-preview">
              <FramedPhoto photo={plate} offset={offset} />
            </div>
            <ReframeSlider photo={plate} offset={offset} onChange={setOffset} />
            {!created && (
              <div className="btn-row mt">
                <button className="btn btn-sm" onClick={picker.openCamera}>
                  <CameraIcon size={16} />
                  Retake
                </button>
                <button className="btn btn-sm btn-ghost" onClick={picker.openLibrary}>
                  <ImagesIcon size={16} />
                  Library
                </button>
              </div>
            )}
          </>
        )}

        {skipPlate && !plate && (
          <div className="between">
            <p className="small muted">
              No plate photo. The structure's first photo will be its thumbnail.
            </p>
            <button className="btn btn-sm" onClick={picker.openCamera}>
              <CameraIcon size={16} />
              Take one after all
            </button>
          </div>
        )}

        <ErrorNotice error={picker.error} />
      </div>

      {showDetails && (
        <div className="card card-pad mb">
          <div className="step-label">Step 2 of 2</div>
          <h2 className="mb">What is it?</h2>

          <label className="field">
            <span className="label">Serial number</span>
            <input
              className="input mono"
              autoCapitalize="characters"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              placeholder="44065-3004-2"
              value={serialNumber}
              disabled={!!created}
              onChange={(e) => setSerialNumber(e.target.value)}
            />
            <span className="hint">
              As stamped on the plate. If this serial is already on record at this
              site, its earlier inspections stay linked to it.
            </span>
          </label>

          <label className="field">
            <span className="label">Structure type</span>
            <input
              className="input"
              list={typeListId}
              autoComplete="off"
              placeholder="Anchor bolt cage"
              value={structureType}
              disabled={!!created}
              onChange={(e) => setStructureType(e.target.value)}
            />
            <datalist id={typeListId}>
              {(structures.data?.structureTypes ?? []).map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
            <span className="hint">
              What the structure is classified as. It becomes the title of its tile.
            </span>
          </label>

          {duplicateOf ? (
            <div className="notice notice-warn">
              {serialNumber.trim()} is already a structure in this inspection.{' '}
              <Link to={`/jobs/${jobId}/inspect/${duplicateOf}`} replace>
                Open it
              </Link>
            </div>
          ) : (
            <ErrorNotice error={save.error} />
          )}

          {created && save.isError && (
            <p className="hint mb">
              The structure was saved, but its plate photo didn't upload. Try again,
              or{' '}
              <Link to={`/jobs/${jobId}/inspect/${created.id}`} replace>
                continue without it
              </Link>
              .
            </p>
          )}

          <button
            className="btn btn-primary btn-lg btn-block"
            disabled={!ready || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending && <span className="spin" />}
            {save.isPending
              ? 'Saving'
              : created
                ? 'Try the plate photo again'
                : 'Start structure'}
          </button>
        </div>
      )}
    </>
  );
}
