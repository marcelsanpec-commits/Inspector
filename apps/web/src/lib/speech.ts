import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * On-device dictation via the Web Speech API.
 *
 * Free, no API key, no audio leaves the phone in most implementations. Support
 * is genuinely uneven - solid in Chrome and Edge, present but less reliable in
 * Safari, absent in Firefox - so every screen that uses this must also accept
 * typed text. Dictation is an accelerator here, never the only way in.
 */

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: any) => void) | null;
  onerror: ((e: any) => void) | null;
  onend: (() => void) | null;
};

function getRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  const w = window as unknown as Record<string, unknown>;
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition) as
    | (new () => SpeechRecognitionLike)
    | null;
}

export const dictationSupported = (): boolean => getRecognitionCtor() !== null;

export interface Dictation {
  supported: boolean;
  listening: boolean;
  /** Words recognised but not yet finalised - shown greyed while speaking. */
  interim: string;
  error: string | null;
  start(): void;
  stop(): void;
}

/**
 * @param onFinal receives each finalised phrase, to append to the note.
 */
export function useDictation(onFinal: (text: string) => void): Dictation {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<SpeechRecognitionLike | null>(null);

  // Keep the newest callback without restarting recognition on every render.
  const onFinalRef = useRef(onFinal);
  useEffect(() => {
    onFinalRef.current = onFinal;
  }, [onFinal]);

  const stop = useCallback(() => {
    ref.current?.stop();
    setListening(false);
    setInterim('');
  }, []);

  const start = useCallback(() => {
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      setError('Dictation is not supported in this browser. You can type instead.');
      return;
    }

    setError(null);
    const rec = new Ctor();
    rec.lang = navigator.language || 'en-US';
    rec.continuous = true;
    rec.interimResults = true;

    rec.onresult = (event: any) => {
      let pending = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text: string = result[0]?.transcript ?? '';
        if (result.isFinal) {
          const trimmed = text.trim();
          if (trimmed) onFinalRef.current(trimmed);
        } else {
          pending += text;
        }
      }
      setInterim(pending);
    };

    rec.onerror = (event: any) => {
      const code = event?.error;
      setError(
        code === 'not-allowed'
          ? 'Microphone access was blocked. Allow it in your browser settings, or type the note.'
          : code === 'no-speech'
            ? null
            : `Dictation stopped (${code ?? 'unknown error'}). You can type instead.`,
      );
      setListening(false);
      setInterim('');
    };

    rec.onend = () => {
      setListening(false);
      setInterim('');
    };

    ref.current = rec;
    try {
      rec.start();
      setListening(true);
    } catch {
      setError('Could not start dictation. You can type the note instead.');
    }
  }, []);

  useEffect(() => () => ref.current?.abort(), []);

  return { supported: dictationSupported(), listening, interim, error, start, stop };
}
