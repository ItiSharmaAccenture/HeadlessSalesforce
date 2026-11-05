'use client';

import { useEffect, useRef, type FormEvent, type KeyboardEvent } from 'react';
import { ArrowUp, Square } from 'lucide-react';

interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  busy: boolean;
  maxLength: number;
}

export default function ChatInput({ value, onChange, onSubmit, onStop, busy, maxLength }: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Grow with the content up to a cap, then scroll inside the textarea.
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
  }, [value]);

  // Return focus once a turn finishes so the next question can be typed straight away.
  useEffect(() => {
    if (!busy) textareaRef.current?.focus();
  }, [busy]);

  const canSend = value.trim().length > 0 && !busy;

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter inserts a newline. IME composition must not send.
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (canSend) onSubmit();
    }
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (canSend) onSubmit();
  };

  return (
    <form onSubmit={handleSubmit} className="mx-auto w-full max-w-3xl px-4 pb-4">
      <div className="flex items-end gap-2 rounded-2xl border border-slate-200 bg-white p-2 shadow-sm transition focus-within:border-brand-200 focus-within:ring-2 focus-within:ring-brand-100">
        <label htmlFor="chat-input" className="sr-only">
          Ask about accounts or opportunities
        </label>

        <textarea
          id="chat-input"
          ref={textareaRef}
          rows={1}
          value={value}
          maxLength={maxLength}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask about accounts or opportunities…"
          className="scroll-subtle max-h-45 flex-1 resize-none bg-transparent px-2 py-2 text-[0.9375rem] text-slate-800 placeholder:text-slate-400 focus:outline-none"
        />

        {busy ? (
          <button
            type="button"
            onClick={onStop}
            aria-label="Stop generating"
            className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-xl bg-slate-800 text-white transition hover:bg-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-800"
          >
            <Square className="h-3.5 w-3.5 fill-current" aria-hidden />
          </button>
        ) : (
          <button
            type="submit"
            disabled={!canSend}
            aria-label="Send message"
            className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-xl bg-brand-500 text-white transition hover:bg-brand-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
          >
            <ArrowUp className="h-4.5 w-4.5" aria-hidden />
          </button>
        )}
      </div>

      <p className="mt-2 text-center text-xs text-slate-400">
        Enter to send · Shift + Enter for a new line · Access is governed by Salesforce permissions
      </p>
    </form>
  );
}
