import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { capturePhoto, frameSlack, type CapturedPhoto } from '../lib/image.js';
import { CameraIcon } from './icons.js';
import { ErrorNotice, Modal } from './ui.js';

/**
 * The camera, as the inspection screens use it.
 *
 * `capture="environment"` hands over to the phone's own camera app rather
 * than drawing a viewfinder in the page: the native camera has the focus,
 * exposure, zoom and flash an inspector needs to read a stamped serial plate,
 * and it works over plain http on the local network, where an in-page camera
 * (getUserMedia) is blocked. The 4:3 frame is applied afterwards, with a
 * preview the inspector can slide before saving.
 */
export function usePhotoPicker(onPicked: (photo: CapturedPhoto) => void) {
  const cameraRef = useRef<HTMLInputElement>(null);
  const libraryRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // Keep the newest callback without re-creating the inputs' handler.
  const onPickedRef = useRef(onPicked);
  useEffect(() => {
    onPickedRef.current = onPicked;
  }, [onPicked]);

  const handle = useCallback(async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset so choosing the same file twice still fires a change event.
    e.target.value = '';
    if (!file) return;

    setError(null);
    setBusy(true);
    try {
      onPickedRef.current(await capturePhoto(file));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }, []);

  const inputs = (
    <>
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={handle}
      />
      <input ref={libraryRef} type="file" accept="image/*" hidden onChange={handle} />
    </>
  );

  return {
    inputs,
    busy,
    error,
    // Both must be called straight from a tap: browsers only open a file
    // picker in response to a user gesture.
    openCamera: () => cameraRef.current?.click(),
    openLibrary: () => libraryRef.current?.click(),
  };
}

/** The photo as it will appear in the report: cropped to 4:3 or 3:4. */
export function FramedPhoto({ photo, offset }: { photo: CapturedPhoto; offset: number }) {
  const slack = frameSlack(photo);
  const pct = `${Math.round(offset * 100)}%`;
  return (
    <div className={`frame${photo.height > photo.width ? ' frame-portrait' : ''}`}>
      <img
        src={photo.previewUrl}
        alt="Photo as it will be cropped"
        style={{ objectPosition: slack === 'x' ? `${pct} 50%` : `50% ${pct}` }}
      />
    </div>
  );
}

/**
 * Shown only when the camera's shape differs from the report's (a 16:9
 * phone), since a 4:3 shot has nothing to trim.
 */
export function ReframeSlider({
  photo,
  offset,
  onChange,
}: {
  photo: CapturedPhoto;
  offset: number;
  onChange(offset: number): void;
}) {
  const slack = frameSlack(photo);
  if (!slack) return null;
  return (
    <label className="reframe">
      <span className="tiny muted">
        Cropped to the report's 4:3 frame. Slide to choose what stays:{' '}
        {slack === 'x' ? 'left ↔ right' : 'top ↔ bottom'}
      </span>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={offset}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label="Reframe photo"
      />
    </label>
  );
}

/** A big, glove-friendly checkbox row. */
export function ToggleRow({
  checked,
  onChange,
  title,
  description,
  disabled,
  tone,
}: {
  checked: boolean;
  onChange(checked: boolean): void;
  title: string;
  description: string;
  disabled?: boolean;
  tone?: 'danger';
}) {
  return (
    <label
      className={[
        'toggle-row',
        checked ? 'on' : '',
        tone === 'danger' ? 'danger' : '',
        disabled ? 'disabled' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        <span className="segment-title">{title}</span>
        <span className="segment-desc">{description}</span>
      </span>
    </label>
  );
}

export interface PhotoChoices {
  offset: number;
  nonConforming: boolean;
  includeInReport: boolean;
  caption: string;
}

/**
 * Review a fresh photo before it is saved: framing, whether it is a finding,
 * whether it goes in the report. A non-conforming photo is always in the
 * report, so ticking one ticks and locks the other - the API refuses the
 * combination anyway, but the inspector should never get as far as trying.
 */
export function PhotoReview({
  photo,
  saving,
  error,
  onSave,
  onRetake,
  onDiscard,
}: {
  photo: CapturedPhoto;
  saving: boolean;
  error: unknown;
  onSave(choices: PhotoChoices): void;
  onRetake(): void;
  onDiscard(): void;
}) {
  const [offset, setOffset] = useState(0.5);
  const [nonConforming, setNonConforming] = useState(false);
  const [include, setInclude] = useState(true);
  const [caption, setCaption] = useState('');

  function close() {
    // Closing by accident would silently lose a shot that may be hard to
    // retake, so make it a decision.
    if (saving) return;
    if (window.confirm('Discard this photo?')) onDiscard();
  }

  return (
    <Modal
      title="New photo"
      onClose={close}
      footer={
        <>
          <button className="btn" onClick={onRetake} disabled={saving}>
            <CameraIcon size={18} />
            Retake
          </button>
          <button
            className="btn btn-primary"
            disabled={saving}
            onClick={() =>
              onSave({
                offset,
                nonConforming,
                includeInReport: nonConforming || include,
                caption: caption.trim(),
              })
            }
          >
            {saving && <span className="spin" />}
            {saving ? 'Saving' : 'Save photo'}
          </button>
        </>
      }
    >
      <FramedPhoto photo={photo} offset={offset} />
      <ReframeSlider photo={photo} offset={offset} onChange={setOffset} />

      <div className="stack mt" style={{ gap: 8 }}>
        <ToggleRow
          checked={nonConforming}
          onChange={setNonConforming}
          tone="danger"
          title="Non-conforming"
          description="Shows something that doesn't meet the drawings or spec. Always included in the report."
        />
        <ToggleRow
          checked={nonConforming || include}
          onChange={setInclude}
          disabled={nonConforming}
          title="Include in report"
          description={
            nonConforming
              ? 'Required for non-conforming photos.'
              : 'Every photo stays in the gallery either way. You can change this later.'
          }
        />
      </div>

      <label className="field mt">
        <span className="label">Caption (optional)</span>
        <input
          className="input"
          placeholder={nonConforming ? '3/4" nut welded, drawing calls for 5/8"' : 'East face, base plate'}
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
        />
      </label>

      <ErrorNotice error={error} />
    </Modal>
  );
}
