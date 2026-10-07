import PizZip from 'pizzip';

/**
 * Minimal DOCX writer for the built-in templates. Each docxtemplater tag sits in a single run, so
 * Word never splits it. Institutions replace these templates with their own (Administrare).
 */
export type Block =
  | { p: string; bold?: boolean; size?: number; align?: 'left' | 'center' | 'right' | 'both'; spaceAfter?: number }
  | { table: { header: string[]; row: string[]; loop?: string; widths?: number[] } }
  | { pageBreak: true };

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function run(text: string, bold = false, size = 22): string {
  return `<w:r><w:rPr>${bold ? '<w:b/>' : ''}<w:sz w:val="${size}"/></w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
}

function para(text: string, o: { bold?: boolean; size?: number; align?: string; spaceAfter?: number } = {}): string {
  // **bold** segments inside a paragraph
  const parts = text.split(/(\*\*[^*]+\*\*)/).filter(Boolean);
  const runs = parts.map((t) => (t.startsWith('**') ? run(t.slice(2, -2), true, o.size) : run(t, o.bold, o.size))).join('');
  return `<w:p><w:pPr><w:spacing w:after="${o.spaceAfter ?? 120}"/>${o.align ? `<w:jc w:val="${o.align}"/>` : ''}</w:pPr>${runs}</w:p>`;
}

function cell(text: string, width: number, bold = false): string {
  return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/></w:tcPr>${para(text, { bold, size: 18, spaceAfter: 0 })}</w:tc>`;
}

function table(t: { header: string[]; row: string[]; loop?: string; widths?: number[] }): string {
  const total = 9600;
  const widths = t.widths ?? t.header.map(() => Math.floor(total / t.header.length));
  const border = '<w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/>';
  const head = `<w:tr>${t.header.map((h, i) => cell(h, widths[i]!, true)).join('')}</w:tr>`;
  const cells = t.row.map((c, i) => {
    let text = c;
    if (t.loop && i === 0) text = `{#${t.loop}}${text}`;
    if (t.loop && i === t.row.length - 1) text = `${text}{/${t.loop}}`;
    return cell(text, widths[i]!);
  });
  return `<w:tbl><w:tblPr><w:tblW w:w="${total}" w:type="dxa"/><w:tblBorders>${border}</w:tblBorders></w:tblPr><w:tblGrid>${widths
    .map((w) => `<w:gridCol w:w="${w}"/>`)
    .join('')}</w:tblGrid>${head}<w:tr>${cells.join('')}</w:tr></w:tbl>${para('', { spaceAfter: 120 })}`;
}

export function buildDocx(blocks: Block[]): Buffer {
  const body = blocks
    .map((b) => {
      if ('pageBreak' in b) return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
      if ('table' in b) return table(b.table);
      return para(b.p, b);
    })
    .join('');
  const zip = new PizZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`,
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  zip.file(
    'word/_rels/document.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
  );
  zip.file(
    'word/styles.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Liberation Serif" w:hAnsi="Liberation Serif" w:cs="Liberation Serif" w:eastAsia="Liberation Serif"/><w:sz w:val="22"/><w:lang w:val="ro-RO"/></w:rPr></w:rPrDefault></w:docDefaults></w:styles>`,
  );
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr></w:body></w:document>`,
  );
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }) as Buffer;
}
