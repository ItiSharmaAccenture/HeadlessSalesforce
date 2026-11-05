'use client';

import { Sparkles } from 'lucide-react';

/**
 * Starter prompts shown on an empty transcript.
 *
 * Deliberately phrased without "my": the chat is anonymous, so ownership would
 * be a claim the application cannot make.
 */
export const SUGGESTED_QUESTIONS = [
  'Show me the top 5 opportunities by amount.',
  'Which Salesforce tools do you have available?',
  'Show opportunities closing this month.',
  'List the open cases raised in the last 30 days.',
  'What fields does the Account object have?',
] as const;

interface SuggestedQuestionsProps {
  onSelect: (question: string) => void;
  disabled?: boolean;
}

export default function SuggestedQuestions({ onSelect, disabled = false }: SuggestedQuestionsProps) {
  return (
    <div className="mx-auto w-full max-w-3xl px-4">
      <div className="mb-3 flex items-center gap-2 text-sm font-medium text-slate-500">
        <Sparkles className="h-4 w-4 text-brand-500" aria-hidden />
        Try one of these
      </div>

      <ul className="grid gap-2 sm:grid-cols-2">
        {SUGGESTED_QUESTIONS.map((question) => (
          <li key={question}>
            <button
              type="button"
              onClick={() => onSelect(question)}
              disabled={disabled}
              className="w-full cursor-pointer rounded-xl border border-slate-200 bg-white px-4 py-3 text-left text-sm text-slate-700 shadow-sm transition hover:border-brand-200 hover:bg-brand-50 hover:text-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {question}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
