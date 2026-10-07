import { addAmounts, parseAmount } from '@flux/validators';
import { useEffect, useState } from 'react';
import type { ProblemError } from '../api';
import { fmtAmount } from '../format';
import { displayValue, useNomenclature, type FieldView } from './fields';

type Row = Record<string, unknown>;

function safeAmount(v: unknown): string | null {
  try {
    return v === null || v === undefined || v === '' ? null : parseAmount(String(v));
  } catch {
    return null;
  }
}

/** Editable table (e.g. expense lines). Calculated columns are computed by the server on save. */
export function LineItems({
  field,
  editable,
  projectId,
  onSave,
  saving,
  errors,
}: {
  field: FieldView;
  editable: boolean;
  projectId: string | null;
  onSave: (rows: Row[]) => void;
  saving: boolean;
  errors: ProblemError[];
}) {
  const columns = field.columns ?? [];
  const stored = (field.value as Row[] | null) ?? [];
  const [rows, setRows] = useState<Row[]>(stored);
  const [dirty, setDirty] = useState(false);
  const choiceCol = columns.find((c) => c.type === 'choice');
  const options = useNomenclature(choiceCol?.nomenclature, projectId);

  useEffect(() => {
    if (!dirty) setRows((field.value as Row[] | null) ?? []);
  }, [field.value, dirty]);

  const update = (i: number, key: string, v: unknown) => {
    setDirty(true);
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [key]: v } : r)));
  };
  const add = () => {
    setDirty(true);
    setRows((rs) => [...rs, {}]);
  };
  const remove = (i: number) => {
    setDirty(true);
    setRows((rs) => rs.filter((_, j) => j !== i));
  };
  const total = (key: string) => addAmounts(...rows.map((r) => safeAmount(r[key])));
  const rowErrors = (i: number) => errors.filter((e) => e.field === field.key && e.row === i);

  return (
    <div className="wide" style={{ marginBottom: '1rem' }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="field-label">{field.label}</span>
        {editable && (
          <div className="row">
            <button type="button" className="small" onClick={add}>
              Adaugă rând
            </button>
            <button
              type="button"
              className="small primary"
              disabled={!dirty || saving}
              onClick={() => {
                onSave(rows);
                setDirty(false);
              }}
            >
              {saving ? 'Se salvează…' : 'Salvează tabelul'}
            </button>
          </div>
        )}
      </div>
      <div className="table-wrap card" style={{ marginTop: '0.4rem' }}>
        <table className="data">
          <caption className="sr-only">{field.label}</caption>
          <thead>
            <tr>
              <th scope="col">Nr.</th>
              {columns.map((c) => (
                <th key={c.key} scope="col" className={c.type === 'amount' || c.resultType === 'amount' || c.type === 'calculated' ? 'num' : ''}>
                  {c.label}
                </th>
              ))}
              {editable && (
                <th>
                  <span className="sr-only">Acțiuni</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={columns.length + 2} className="muted">
                  Niciun rând.
                </td>
              </tr>
            )}
            {rows.map((r, i) => (
              <tr key={i}>
                <td>{i + 1}</td>
                {columns.map((c) => {
                  const label = `${c.label}, rândul ${i + 1}`;
                  if (!editable || c.type === 'calculated') {
                    const v = c.type === 'calculated' && dirty ? null : r[c.key];
                    return (
                      <td key={c.key} className={c.type === 'amount' || c.type === 'calculated' ? 'num' : ''}>
                        {c.type === 'calculated' && dirty ? <span className="muted small">după salvare</span> : displayValue(c.type, v, c.resultType ?? 'amount', options.data?.items)}
                      </td>
                    );
                  }
                  if (c.type === 'choice') {
                    return (
                      <td key={c.key}>
                        <select aria-label={label} value={(r[c.key] as string) ?? ''} onChange={(e) => update(i, c.key, e.target.value || null)}>
                          <option value="">—</option>
                          {options.data?.items.map((o) => (
                            <option key={o.code} value={o.code}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      </td>
                    );
                  }
                  return (
                    <td key={c.key} className={c.type === 'amount' ? 'num' : ''}>
                      <input
                        aria-label={label}
                        className={c.type === 'amount' ? 'num' : ''}
                        inputMode={c.type === 'amount' ? 'decimal' : undefined}
                        value={(r[c.key] as string) ?? ''}
                        onChange={(e) => update(i, c.key, e.target.value)}
                        style={{ minWidth: c.type === 'amount' ? 120 : 140 }}
                      />
                    </td>
                  );
                })}
                {editable && (
                  <td>
                    <button type="button" className="small danger" onClick={() => remove(i)} aria-label={`Șterge rândul ${i + 1}`}>
                      Șterge
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
          {columns.some((c) => c.total) && (
            <tfoot>
              <tr>
                <th scope="row">Total</th>
                {columns.map((c) => (
                  <td key={c.key} className="num" style={{ fontWeight: 700 }}>
                    {c.total && !(c.type === 'calculated' && dirty)
                      ? fmtAmount(c.type === 'calculated' ? addAmounts(...rows.map((r) => safeAmount(r[c.key]))) : total(c.key))
                      : ''}
                  </td>
                ))}
                {editable && <td />}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {rows.map((_, i) =>
        rowErrors(i).map((e, j) => (
          <div key={`${i}-${j}`} className="field-error">
            {e.message}
          </div>
        )),
      )}
      {dirty && <div className="field-hint">Aveți modificări nesalvate în tabel.</div>}
    </div>
  );
}
