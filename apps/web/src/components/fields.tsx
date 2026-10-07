import { useQuery } from '@tanstack/react-query';
import { api, type ProblemError } from '../api';
import { SOURCE_LABEL, fmtAmount, fmtDate } from '../format';

export interface FieldView {
  key: string;
  label: string;
  type: string;
  resultType: string | null;
  format: string | null;
  nomenclature: string | null;
  columns: Array<{ key: string; label: string; type: string; nomenclature?: string; total?: boolean; resultType?: string }> | null;
  access: 'visible' | 'editable' | 'required';
  value: unknown;
  source: string | null;
  sourceAt: string | null;
}

export function useNomenclature(key: string | null | undefined, projectId?: string | null) {
  return useQuery({
    queryKey: ['nomenclature', key, projectId],
    queryFn: () => api.get<{ items: Array<{ code: string; label: string }> }>(`/nomenclatures/${key}${projectId ? `?projectId=${projectId}` : ''}`),
    enabled: Boolean(key),
    staleTime: 300_000,
  });
}

/** Read-only rendering of a stored value. */
export function displayValue(type: string, value: unknown, resultType?: string | null, options?: Array<{ code: string; label: string }>): string {
  if (value === null || value === undefined || value === '') return '—';
  const t = type === 'calculated' ? (resultType ?? 'text') : type;
  if (t === 'amount') return `${fmtAmount(value)} lei`;
  if (t === 'date') return fmtDate(String(value));
  if (t === 'boolean') return value ? 'Da' : 'Nu';
  if (t === 'percent') return `${String(value).replace('.', ',')} %`;
  if (t === 'choice') return options?.find((o) => o.code === value)?.label ?? String(value);
  return String(value);
}

export function SourceNote({ source, sourceAt }: { source: string | null; sourceAt: string | null }) {
  if (!source || source === 'manual' || source === 'calculated') return null;
  return (
    <span className="field-hint">
      Precompletat {SOURCE_LABEL[source] ?? source}
      {sourceAt ? `, la ${fmtDate(sourceAt.slice(0, 10))}` : ''}
    </span>
  );
}

interface InputProps {
  field: FieldView;
  value: unknown;
  onChange: (v: unknown) => void;
  error?: ProblemError;
  projectId?: string | null;
}

export function FieldInput({ field, value, onChange, error, projectId }: InputProps) {
  const id = `f-${field.key}`;
  const editable = field.access === 'editable' || field.access === 'required';
  const options = useNomenclature(field.type === 'choice' ? field.nomenclature : null, projectId);
  const describedBy = error ? `${id}-err` : undefined;
  const common = { id, 'aria-invalid': error ? true : undefined, 'aria-describedby': describedBy, required: field.access === 'required' } as const;
  const wide = field.type === 'textarea';

  let control;
  if (!editable) {
    control = (
      <div id={id} style={{ padding: '0.45rem 0', whiteSpace: 'pre-wrap' }}>
        {displayValue(field.type, field.value, field.resultType, options.data?.items)}
      </div>
    );
  } else if (field.type === 'textarea') {
    control = <textarea {...common} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />;
  } else if (field.type === 'boolean') {
    control = (
      <label className="row" style={{ padding: '0.45rem 0' }}>
        <input type="checkbox" id={id} checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} /> Da
      </label>
    );
  } else if (field.type === 'date') {
    control = <input {...common} type="date" value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />;
  } else if (field.type === 'choice') {
    control = (
      <select {...common} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">— alegeți —</option>
        {options.data?.items.map((o) => (
          <option key={o.code} value={o.code}>
            {o.label}
          </option>
        ))}
      </select>
    );
  } else if (field.type === 'amount' || field.type === 'integer' || field.type === 'percent') {
    control = (
      <input
        {...common}
        className="num"
        inputMode="decimal"
        value={value === null || value === undefined ? '' : String(value)}
        onChange={(e) => onChange(e.target.value)}
        onBlur={(e) => field.type === 'amount' && e.target.value && /^-?\d+(\.\d{1,2})?$/.test(e.target.value) && onChange(fmtAmount(e.target.value))}
      />
    );
  } else {
    control = <input {...common} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />;
  }

  return (
    <div className={`field${wide ? ' wide' : ''}`} style={{ marginBottom: '0.85rem' }}>
      <label htmlFor={id} className="field-label">
        {field.label}
        {field.access === 'required' && (
          <span className="req" aria-hidden="true">
            *
          </span>
        )}
        {field.type === 'amount' && editable && <span className="muted small"> (lei)</span>}
      </label>
      {control}
      <SourceNote source={field.source} sourceAt={field.sourceAt} />
      {error && (
        <div className="field-error" id={describedBy}>
          {error.message}
        </div>
      )}
    </div>
  );
}
