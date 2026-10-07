import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import { ApiError, type Me } from '../api';
import { fmtDate } from '../format';

export const MeContext = createContext<Me | null>(null);
export function useMe(): Me {
  const me = useContext(MeContext);
  if (!me) throw new Error('MeContext missing');
  return me;
}

export function Spinner({ label = 'Se încarcă…' }: { label?: string }) {
  return (
    <span role="status" className="row muted">
      <span className="spinner" aria-hidden="true" /> {label}
    </span>
  );
}

export function Loading() {
  return (
    <div className="empty">
      <Spinner />
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

/** Shows what went wrong and, for validation errors, each problem to fix. */
export function ErrorAlert({ error }: { error: unknown }) {
  if (!error) return null;
  const e = error instanceof ApiError ? error : new ApiError(0, (error as Error).message ?? 'Eroare');
  return (
    <div className="alert error" role="alert">
      <strong>{e.title}</strong>
      {e.errors.length > 0 && (
        <ul>
          {e.errors.map((x, i) => (
            <li key={i}>{x.message}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Badge({ tone = 'gray', children }: { tone?: 'gray' | 'green' | 'yellow' | 'red' | 'blue'; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

const STATUS_TONE: Record<string, 'blue' | 'green' | 'gray' | 'red'> = {
  active: 'blue',
  completed_positive: 'green',
  completed_negative: 'gray',
  cancelled: 'gray',
  suspended: 'red',
};
const STATUS_LABEL: Record<string, string> = {
  active: 'În lucru',
  completed_positive: 'Finalizat',
  completed_negative: 'Închis',
  cancelled: 'Anulat',
  suspended: 'Suspendat',
};
export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUS_TONE[status] ?? 'gray'}>{STATUS_LABEL[status] ?? status}</Badge>;
}

export function DueBadge({ due, today }: { due: string | null | undefined; today: string }) {
  if (!due) return <span className="muted">—</span>;
  const d = due.slice(0, 10);
  const days = Math.round((Date.parse(d) - Date.parse(today)) / 86_400_000);
  const tone = days < 0 ? 'red' : days <= 3 ? 'yellow' : 'green';
  const text = days < 0 ? `depășit cu ${-days} z` : days === 0 ? 'azi' : `${days} z`;
  return (
    <span className="nowrap">
      <span className={`dot ${tone}`} aria-hidden="true" />
      {fmtDate(d)} <span className="muted small">({text})</span>
    </span>
  );
}

export function Modal({ open, title, onClose, children, footer }: { open: boolean; title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} aria-labelledby="dialog-title">
      <header>
        <h2 id="dialog-title">{title}</h2>
      </header>
      <div className="body">{children}</div>
      {footer && <footer>{footer}</footer>}
    </dialog>
  );
}

export function Card({ title, actions, children, flush }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; flush?: boolean }) {
  return (
    <section className="card">
      {(title || actions) && (
        <header>
          {typeof title === 'string' ? <h2>{title}</h2> : title}
          {actions && <div className="row">{actions}</div>}
        </header>
      )}
      <div className={`body${flush ? ' flush' : ''}`}>{children}</div>
    </section>
  );
}
