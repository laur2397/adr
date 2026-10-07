import PizZip from 'pizzip';
import { query, type Db } from '../core/db.js';
import { getFile } from '../documents/storage.js';

/**
 * Evidence captured during an on-site verification (P8): photos with the device time and GPS
 * position, and the beneficiary representative's handwritten signature. Files live in the
 * content-addressed storage; the rows keep the metadata and the hash.
 */

export interface EvidenceRow {
  id: string;
  kind: 'photo' | 'signature';
  storage_key: string;
  sha256: string;
  mime_type: 'image/jpeg' | 'image/png';
  width: number | null;
  height: number | null;
  caption: string | null;
  signer_name: string | null;
  taken_at: string | null;
  latitude: string | null;
  longitude: string | null;
  accuracy_m: string | null;
  captured_by: string;
  captured_by_name: string;
  created_at: string;
}

export async function listEvidence(db: Db, instanceId: string): Promise<EvidenceRow[]> {
  return query(
    db,
    `select e.id, e.kind, e.storage_key, encode(e.sha256, 'hex') as sha256, e.mime_type, e.width, e.height, e.caption, e.signer_name,
            e.taken_at, e.latitude, e.longitude, e.accuracy_m, e.captured_by, u.full_name as captured_by_name, e.created_at
       from visit_evidence e join app_user u on u.id = e.captured_by
      where e.instance_id = $1 and e.deleted_at is null
      order by e.kind desc, coalesce(e.taken_at, e.created_at), e.created_at`,
    [instanceId],
  );
}

/** Used by path validations: `evidence.photos` and `evidence.signature`. */
export async function evidenceCounts(db: Db, instanceId: string): Promise<{ photos: number; signature: boolean }> {
  const [row] = await query(
    db,
    `select count(*) filter (where kind = 'photo')::int as photos, bool_or(kind = 'signature') as signature
       from visit_evidence where instance_id = $1 and deleted_at is null`,
    [instanceId],
  );
  return { photos: row?.photos ?? 0, signature: Boolean(row?.signature) };
}

/** Recognizes JPEG and PNG by their bytes (the declared MIME type is not trusted) and reads the size. */
export function imageInfo(buf: Buffer): { mime: 'image/jpeg' | 'image/png'; width: number; height: number } | null {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) {
    return { mime: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1]!;
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = buf.readUInt16BE(i + 2);
      // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { mime: 'image/jpeg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  return null;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function when(iso: string | null): string {
  if (!iso) return 'ora necunoscută';
  return new Intl.DateTimeFormat('ro-RO', { timeZone: 'Europe/Bucharest', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

function where(e: EvidenceRow): string {
  if (e.latitude === null || e.longitude === null) return 'fără poziție GPS';
  const acc = e.accuracy_m !== null ? ` (±${Math.round(Number(e.accuracy_m))} m)` : '';
  return `GPS ${Number(e.latitude).toFixed(5)}, ${Number(e.longitude).toFixed(5)}${acc}`;
}

const EMU_PER_CM = 360_000;

function para(text: string, o: { bold?: boolean; size?: number; center?: boolean; pageBreakBefore?: boolean; keepNext?: boolean; after?: number } = {}): string {
  return `<w:p><w:pPr>${o.keepNext ? '<w:keepNext/>' : ''}${o.pageBreakBefore ? '<w:pageBreakBefore/>' : ''}<w:spacing w:after="${o.after ?? 120}"/>${o.center ? '<w:jc w:val="center"/>' : ''}</w:pPr><w:r><w:rPr>${o.bold ? '<w:b/>' : ''}<w:sz w:val="${o.size ?? 20}"/></w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
}

function picture(relId: string, n: number, w: number, h: number, maxWcm: number, maxHcm: number): string {
  const scale = Math.min((maxWcm * EMU_PER_CM) / w, (maxHcm * EMU_PER_CM) / h);
  const cx = Math.round(w * scale);
  const cy = Math.round(h * scale);
  return `<w:p><w:pPr><w:keepNext/><w:spacing w:after="60"/><w:jc w:val="center"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${9000 + n}" name="Anexa ${n}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${9000 + n}" name="anexa${n}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

/**
 * Appends an annex to a rendered DOCX: every photo with its caption, time, GPS position and hash,
 * then the representative's signature. Done on the DOCX (not on the PDF) so the annex gets the
 * template's fonts and is present even when no PDF converter is installed.
 */
export async function appendEvidenceAnnex(docx: Buffer, items: EvidenceRow[]): Promise<Buffer> {
  if (!items.length) return docx;
  const zip = new PizZip(docx);
  let body = zip.file('word/document.xml')!.asText();
  let rels = zip.file('word/_rels/document.xml.rels')?.asText() ?? '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
  let types = zip.file('[Content_Types].xml')!.asText();

  // Namespaces used by the drawing markup, added to the root when the template lacks them.
  body = body.replace(/<w:document\b([^>]*)>/, (m, attrs: string) => {
    let a = attrs;
    if (!a.includes('xmlns:wp=')) a += ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"';
    if (!a.includes('xmlns:r=')) a += ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
    return `<w:document${a}>`;
  });
  for (const [ext, type] of [['jpeg', 'image/jpeg'], ['png', 'image/png']]) {
    if (!types.includes(`Extension="${ext}"`)) types = types.replace('</Types>', `<Default Extension="${ext}" ContentType="${type}"/></Types>`);
  }

  const photos = items.filter((e) => e.kind === 'photo');
  const signature = items.find((e) => e.kind === 'signature');
  let xml = para('ANEXĂ – Fotografii din timpul vizitei și semnătura reprezentantului beneficiarului', { bold: true, size: 24, center: true, pageBreakBefore: true, after: 240 });
  let n = 0;
  const add = async (e: EvidenceRow, maxW: number, maxH: number) => {
    n += 1;
    const ext = e.mime_type === 'image/png' ? 'png' : 'jpeg';
    const relId = `rIdEvidence${n}`;
    zip.file(`word/media/evidence${n}.${ext}`, await getFile(e.storage_key));
    rels = rels.replace('</Relationships>', `<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/evidence${n}.${ext}"/></Relationships>`);
    return picture(relId, n, e.width ?? 1600, e.height ?? 1200, maxW, maxH);
  };
  let i = 0;
  for (const p of photos) {
    i += 1;
    xml += await add(p, 15, 10.5);
    xml += para(`Foto ${i}${p.caption ? ` – ${p.caption}` : ''}`, { bold: true, size: 18, center: true, keepNext: true, after: 0 });
    xml += para(`${when(p.taken_at)} · ${where(p)} · ${p.captured_by_name} · SHA-256 ${p.sha256.slice(0, 16)}…`, { size: 16, center: true, after: 240 });
  }
  if (signature) {
    xml += para(`Semnătura reprezentantului beneficiarului${signature.signer_name ? `: ${signature.signer_name}` : ''}`, { bold: true, size: 20, keepNext: true, after: 60 });
    xml += await add(signature, 7, 3);
    xml += para(`${when(signature.taken_at)} · ${where(signature)} · SHA-256 ${signature.sha256.slice(0, 16)}…`, { size: 16, after: 120 });
  }

  // Before the body's final section properties, so the annex keeps the document's page setup.
  const sect = body.lastIndexOf('<w:sectPr');
  const end = body.lastIndexOf('</w:body>');
  const at = sect > -1 && sect < end ? sect : end;
  body = body.slice(0, at) + xml + body.slice(at);

  zip.file('word/document.xml', body);
  zip.file('word/_rels/document.xml.rels', rels);
  zip.file('[Content_Types].xml', types);
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }) as Buffer;
}
