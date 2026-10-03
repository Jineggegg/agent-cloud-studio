import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

// The slice of the Web Speech API this hook uses (SpeechRecognition / webkitSpeechRecognition).
type SpeechResultList = ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { results: SpeechResultList }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};
type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

// Errors that only mean "nothing was heard" or "we stopped it ourselves": dictation carries on.
const QUIET_ERRORS = new Set(['no-speech', 'aborted']);
const PERMISSION_ERRORS = new Set(['not-allowed', 'service-not-allowed']);

function speechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === 'undefined') return null;
  const scope = window as Window & { SpeechRecognition?: SpeechRecognitionConstructor; webkitSpeechRecognition?: SpeechRecognitionConstructor };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

/**
 * Used by the workbench chat composers (WorkbenchComposer, WorkbenchDeepSeekChat) for the microphone button: Chinese
 * dictation through the browser's own Web Speech API (iPadOS Safari has it), with no server and no dependency.
 * While listening, the words being recognised appear live after the draft (`text`) through `onText`; it keeps
 * listening across pauses until `toggle` is tapped again. A draft cleared from outside (sent) ends dictation; a draft
 * edited from outside becomes the new starting point. `supported` is false where the API is missing, and the
 * button is then not shown.
 */
export function useSpeechDictation({ text, onText, onError }: { text: string; onText: (next: string) => void; onError?: (message: string) => void }) {
  const supported = speechRecognitionConstructor() !== null;
  // Whether the microphone is on, for the button's state.
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  // The owner wants dictation on: a recognition the browser ends after a pause is restarted while this holds.
  const wantedRef = useRef(false);
  // The draft as this recognition session found it; its words are appended to this.
  const baseRef = useRef('');
  // The last draft this hook wrote, to tell its own updates from the owner's edits (or a send).
  const writtenRef = useRef<string | null>(null);
  // The latest draft and callbacks, for the recognition's event handlers (they outlive the render that made them).
  const textRef = useRef(text);
  const onTextRef = useRef(onText);
  const onErrorRef = useRef(onError);
  useLayoutEffect(() => {
    textRef.current = text;
    onTextRef.current = onText;
    onErrorRef.current = onError;
  });
  // startSession itself, so a recognition the browser ends can start the next one.
  const restartRef = useRef<() => void>(() => undefined);

  const startSession = useCallback(() => {
    const Recognition = speechRecognitionConstructor();
    if (!Recognition) return;
    const recognition = new Recognition();
    recognition.lang = 'zh-CN';
    recognition.continuous = true;
    recognition.interimResults = true;
    baseRef.current = textRef.current;
    writtenRef.current = textRef.current;
    recognition.onresult = (event) => {
      // The list holds every result of this session: finished phrases first, the phrase being spoken last.
      let heard = '';
      for (let index = 0; index < event.results.length; index += 1) heard += event.results[index][0].transcript;
      const next = baseRef.current + heard;
      writtenRef.current = next;
      onTextRef.current(next);
    };
    recognition.onerror = (event) => {
      if (QUIET_ERRORS.has(event.error)) return;
      wantedRef.current = false;
      onErrorRef.current?.(PERMISSION_ERRORS.has(event.error) ? '没有麦克风或语音识别权限，请在浏览器设置里允许' : '语音输入中断了，请再试一次');
    };
    recognition.onend = () => {
      if (recognitionRef.current === recognition) recognitionRef.current = null;
      // Safari ends a recognition after a pause even when continuous; keep listening until the owner taps stop.
      if (wantedRef.current) { restartRef.current(); return; }
      setListening(false);
    };
    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      recognitionRef.current = null;
      wantedRef.current = false;
      setListening(false);
      onErrorRef.current?.('语音输入没能开始，请再试一次');
    }
  }, []);

  useEffect(() => { restartRef.current = startSession; }, [startSession]);

  // Tapped off: the phrase being spoken still lands in the draft before the microphone closes.
  const stop = useCallback(() => {
    wantedRef.current = false;
    const recognition = recognitionRef.current;
    if (recognition) recognition.stop(); else setListening(false);
  }, []);

  // Drops the running recognition without its pending words; it restarts on the current draft while still wanted.
  const discard = useCallback(() => {
    const recognition = recognitionRef.current;
    if (!recognition) { if (!wantedRef.current) setListening(false); return; }
    recognition.onresult = null;
    recognition.abort();
  }, []);

  const toggle = useCallback(() => {
    if (wantedRef.current) { stop(); return; }
    wantedRef.current = true;
    setListening(true);
    startSession();
  }, [startSession, stop]);

  // The draft changed outside dictation: a send (or clearing it) ends dictation, and late words must not bring the
  // sent text back; an edit restarts recognition on the edited draft.
  useEffect(() => {
    if (!listening || writtenRef.current === null || text === writtenRef.current) return;
    if (!text.trim()) wantedRef.current = false;
    discard();
  }, [discard, listening, text]);

  // Leaving the chat turns the microphone off.
  useEffect(() => () => {
    wantedRef.current = false;
    recognitionRef.current?.abort();
    recognitionRef.current = null;
  }, []);

  return { supported, listening, toggle, stop };
}
