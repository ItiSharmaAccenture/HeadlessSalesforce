'use client';

import { memo } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Bot, CircleAlert, Loader2, User } from 'lucide-react';

import ExecutionProgress from './ExecutionProgress';
import type { ChatMessage as ChatMessageModel } from '@/types/chat';

interface ChatMessageProps {
  message: ChatMessageModel;
}

/**
 * Markdown renderer for assistant content.
 *
 * Tables are wrapped so a wide Salesforce result scrolls inside the bubble
 * instead of stretching the layout, and links open safely.
 */
const markdownComponents = {
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="table-wrap">
      <table>{children}</table>
    </div>
  ),
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  ),
};

function ChatMessageView({ message }: ChatMessageProps) {
  const isUser = message.role === 'user';

  if (isUser) {
    return (
      <div className="animate-rise flex justify-end gap-3">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-brand-500 px-4 py-2.5 text-[0.9375rem] leading-relaxed whitespace-pre-wrap text-white shadow-sm">
          {message.content}
        </div>
        <div
          className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-200 text-slate-600"
          aria-hidden
        >
          <User className="h-4 w-4" />
        </div>
      </div>
    );
  }

  const showTypingIndicator = message.pending && !message.content && !message.error;

  return (
    <div className="animate-rise flex gap-3">
      <div
        className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-600 ring-1 ring-brand-100 ring-inset"
        aria-hidden
      >
        <Bot className="h-4 w-4" />
      </div>

      <div className="min-w-0 max-w-[85%] flex-1">
        {(message.content || showTypingIndicator || message.error) && (
          <div className="rounded-2xl rounded-tl-md border border-slate-200 bg-white px-4 py-3 shadow-sm">
            {message.content && (
              <div className="markdown text-slate-700">
                <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                  {message.content}
                </Markdown>
              </div>
            )}

            {showTypingIndicator && (
              <div className="flex items-center gap-2 text-sm text-slate-400">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                <span>Working on it…</span>
              </div>
            )}

            {message.error && (
              <div
                role="alert"
                className={`flex items-start gap-2 text-sm text-amber-800 ${message.content ? 'mt-3 border-t border-amber-100 pt-3' : ''}`}
              >
                <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" aria-hidden />
                <span>{message.error}</span>
              </div>
            )}
          </div>
        )}

        {message.stages && message.stages.length > 0 && (
          <ExecutionProgress stages={message.stages} live={Boolean(message.pending)} />
        )}
      </div>
    </div>
  );
}

// The transcript re-renders on every streamed delta; settled messages should not.
export default memo(ChatMessageView);
