import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api';
import { fmtDateTime } from '../format';
import { Card, Empty, Loading } from './ui';

export const mapLink = (lat: number | string, lon: number | string) => `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=18/${lat}/${lon}`;

export function gpsLabel(e: { latitude?: string | number | null; longitude?: string | number | null; accuracy_m?: string | number | null }) {
  if (e.latitude === null || e.latitude === undefined || e.longitude === null || e.longitude === undefined) return null;
  return `${Number(e.latitude).toFixed(5)}, ${Number(e.longitude).toFixed(5)}${e.accuracy_m !== null && e.accuracy_m !== undefined ? ` (±${Math.round(Number(e.accuracy_m))} m)` : ''}`;
}

/** Photos and the representative's signature of an on-site visit, as shown in the dossier. */
export function EvidencePanel({ instanceId, fieldLink }: { instanceId: string; fieldLink: boolean }) {
  const q = useQuery({ queryKey: ['evidence', instanceId], queryFn: () => api.get(`/instances/${instanceId}/evidence`) });
  const [open, setOpen] = useState<any>(null);
  if (q.isLoading) return <Loading />;
  const items: any[] = q.data?.items ?? [];
  const photos = items.filter((e) => e.kind === 'photo');
  const signature = items.find((e) => e.kind === 'signature');
  return (
    <div className="stack">
      {fieldLink && (
        <div className="alert info row" style={{ justifyContent: 'space-between' }}>
          <span>
            <strong>Modul de teren.</strong> Pe telefon sau tabletă: lista de verificare, fotografii cu poziție GPS și semnătura reprezentantului, și fără semnal.
          </span>
          <Link className="button primary small" to={`/teren/${instanceId}`}>
            Deschide modul de teren
          </Link>
        </div>
      )}
      <Card title={`Fotografii (${photos.length})`}>
        {photos.length === 0 ? (
          <Empty>Nicio fotografie încă.</Empty>
        ) : (
          <div className="evidence-grid">
            {photos.map((p, i) => (
              <figure key={p.id} className="evidence-item">
                <button className="evidence-thumb" onClick={() => setOpen(p)} aria-label={`Mărește fotografia ${i + 1}`}>
                  <img src={p.url} alt={p.caption ?? `Fotografia ${i + 1}`} loading="lazy" />
                </button>
                <figcaption>
                  <strong>
                    Foto {i + 1}
                    {p.caption ? ` – ${p.caption}` : ''}
                  </strong>
                  <div className="small muted">
                    {p.taken_at ? fmtDateTime(p.taken_at) : 'ora necunoscută'} · {p.captured_by_name}
                  </div>
                  <div className="small">
                    {gpsLabel(p) ? (
                      <a href={mapLink(p.latitude, p.longitude)} target="_blank" rel="noreferrer">
                        GPS {gpsLabel(p)}
                      </a>
                    ) : (
                      <span className="muted">fără poziție GPS</span>
                    )}
                  </div>
                  <div className="small muted mono" title={p.sha256}>
                    SHA-256 {p.sha256.slice(0, 12)}…
                  </div>
                </figcaption>
              </figure>
            ))}
          </div>
        )}
      </Card>
      <Card title="Semnătura reprezentantului beneficiarului">
        {signature ? (
          <div className="row" style={{ alignItems: 'flex-start' }}>
            <img src={signature.url} alt={`Semnătura lui ${signature.signer_name ?? 'reprezentantului'}`} style={{ maxWidth: 260, border: '1px solid var(--c-border)', borderRadius: 4, background: '#fff' }} />
            <div className="small">
              <div>
                <strong>{signature.signer_name ?? '—'}</strong>
              </div>
              <div className="muted">{signature.taken_at ? fmtDateTime(signature.taken_at) : ''}</div>
              {gpsLabel(signature) && (
                <a href={mapLink(signature.latitude, signature.longitude)} target="_blank" rel="noreferrer">
                  GPS {gpsLabel(signature)}
                </a>
              )}
            </div>
          </div>
        ) : (
          <Empty>Semnătura nu a fost preluată.</Empty>
        )}
      </Card>
      {open && (
        <div className="lightbox" role="dialog" aria-modal="true" aria-label="Fotografie mărită" onClick={() => setOpen(null)}>
          <img src={open.url} alt={open.caption ?? 'Fotografie'} />
          <div className="lightbox-caption">
            {open.caption ?? ''} · {open.taken_at ? fmtDateTime(open.taken_at) : ''} {gpsLabel(open) ? `· GPS ${gpsLabel(open)}` : ''}
          </div>
        </div>
      )}
    </div>
  );
}

/** Finger / stylus / mouse signature pad. Calls onChange with a PNG when the user lifts the pen. */
export function SignaturePad({ onChange, height = 200 }: { onChange: (png: Blob | null) => void; height?: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [empty, setEmpty] = useState(true);

  useEffect(() => {
    const c = canvas.current!;
    const ratio = window.devicePixelRatio || 1;
    c.width = c.clientWidth * ratio;
    c.height = height * ratio;
    const ctx = c.getContext('2d')!;
    ctx.scale(ratio, ratio);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#14286e';
  }, [height]);

  const point = (e: React.PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as const;
  };
  const down = (e: React.PointerEvent) => {
    canvas.current!.setPointerCapture(e.pointerId);
    drawing.current = true;
    const ctx = canvas.current!.getContext('2d')!;
    const [x, y] = point(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
  };
  const move = (e: React.PointerEvent) => {
    if (!drawing.current) return;
    const ctx = canvas.current!.getContext('2d')!;
    const [x, y] = point(e);
    ctx.lineTo(x, y);
    ctx.stroke();
    setEmpty(false);
  };
  const up = () => {
    if (!drawing.current) return;
    drawing.current = false;
    canvas.current!.toBlob((b) => onChange(b), 'image/png');
  };
  const clear = () => {
    const c = canvas.current!;
    const ctx = c.getContext('2d')!;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.restore();
    setEmpty(true);
    onChange(null);
  };
  return (
    <div>
      <canvas
        ref={canvas}
        className="signature-pad"
        style={{ height }}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        aria-label="Spațiu pentru semnătură: semnați cu degetul sau cu creionul"
        role="img"
      />
      <div className="row small" style={{ justifyContent: 'space-between', marginTop: 4 }}>
        <span className="muted">{empty ? 'Semnați în chenar, cu degetul sau cu creionul.' : 'Semnătură desenată.'}</span>
        <button type="button" className="small" onClick={clear}>
          Șterge
        </button>
      </div>
    </div>
  );
}
