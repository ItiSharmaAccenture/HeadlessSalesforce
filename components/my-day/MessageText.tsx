import { Fragment, type ReactNode } from 'react';

import { escapeRegExp, mapsSearchUrl } from './format';

interface Context {
  addresses: string[];
  onOpenAppointment: (number: string) => void;
}

interface Props extends Context {
  text: string;
}

const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+/;

/**
 * Renders an assistant reply: short paragraphs, simple lists and **bold**.
 * Appointment numbers open the detail view; addresses Salesforce returned open
 * in Google Maps. Nothing else in the text becomes a link.
 */
export function MessageText({ text, addresses, onOpenAppointment }: Props) {
  const context = { addresses, onOpenAppointment };
  const blocks = text.trim().split(/\n{2,}/);

  return (
    <>
      {blocks.map((block, index) => {
        const lines = block.split('\n').filter((line) => line.trim());
        if (lines.length > 0 && lines.every((line) => BULLET.test(line))) {
          const items = lines.map((line, item) => <li key={item}>{inline(line.replace(BULLET, ''), context)}</li>);
          return /^\s*\d/.test(lines[0]) ? (
            <ol key={index} className="cp-list">
              {items}
            </ol>
          ) : (
            <ul key={index} className="cp-list">
              {items}
            </ul>
          );
        }

        return (
          <p key={index} className="cp-p">
            {lines.map((line, item) => (
              <Fragment key={item}>
                {item > 0 && <br />}
                {inline(line, context)}
              </Fragment>
            ))}
          </p>
        );
      })}
    </>
  );
}

function inline(text: string, context: Context): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).flatMap((part, index): ReactNode[] => {
    if (!part) return [];
    if (/^\*\*[^*]+\*\*$/.test(part)) {
      return [<strong key={`b${index}`}>{linkify(part.slice(2, -2), context, `b${index}`)}</strong>];
    }
    return linkify(part, context, `t${index}`);
  });
}

function linkify(text: string, { addresses, onOpenAppointment }: Context, keyBase: string): ReactNode[] {
  const known = [...new Set(addresses.filter(Boolean))].sort((a, b) => b.length - a.length).map(escapeRegExp);
  const pattern = new RegExp(`(\\bSA-\\d{1,10}\\b${known.length ? `|${known.join('|')}` : ''})`, 'g');

  return text.split(pattern).map((piece, index) => {
    const key = `${keyBase}-${index}`;
    if (index % 2 === 0) return piece ? <Fragment key={key}>{piece}</Fragment> : null;

    if (/^SA-\d+$/.test(piece)) {
      return (
        <button
          key={key}
          type="button"
          className="cp-link"
          onClick={() => onOpenAppointment(piece)}
          aria-label={`${piece}, open appointment details`}
        >
          {piece}
        </button>
      );
    }

    return (
      <a key={key} className="cp-link" href={mapsSearchUrl(piece)} target="_blank" rel="noopener noreferrer">
        {piece}
        <span className="cp-sr"> (opens Google Maps in a new tab)</span>
      </a>
    );
  });
}
