import type { Block } from './docx.js';

/** Built-in DOCX templates. Tags: see documents/service.ts templateData(). */
export const TEMPLATES: Record<string, { name: string; blocks: Block[] }> = {
  p1_verification_note: {
    name: 'Notă de verificare a cererii',
    blocks: [
      { p: '{organization.name}', bold: true },
      { p: 'Nr. înregistrare: {registration_in}     Data: {today}', align: 'right' },
      { p: 'NOTĂ DE VERIFICARE', bold: true, size: 28, align: 'center', spaceAfter: 60 },
      { p: 'a cererii de {request_type} nr. {request_no} din {submitted_at}', align: 'center', spaceAfter: 240 },
      { p: '**Beneficiar:** {beneficiary_name} (CUI {beneficiary_cui})' },
      { p: '**Proiect:** {project_title}, cod SMIS {smis_code}' },
      { p: '**Contract de finanțare:** nr. {contract_number} din {contract_date}; valoare eligibilă {eligible_value} lei' },
      { p: '**Cont IBAN beneficiar:** {beneficiary_iban}', spaceAfter: 240 },
      { p: '1. Cheltuieli verificate', bold: true },
      {
        table: {
          header: ['Nr.', 'Linie bugetară', 'Document justificativ', 'Solicitat (lei)', 'Eligibil (lei)', 'Neeligibil (lei)', 'Motiv'],
          row: ['{nr}', '{budget_line}', '{document_ref}', '{requested}', '{eligible}', '{non_eligible}', '{reason}'],
          loop: 'expenses',
          widths: [600, 1300, 1900, 1350, 1350, 1350, 1750],
        },
      },
      { p: '**Total solicitat:** {total_requested} lei     **Total eligibil:** {total_eligible} lei', spaceAfter: 240 },
      { p: '2. Lista de verificare', bold: true },
      {
        table: {
          header: ['Nr.', 'Întrebare', 'Răspuns', 'Observații'],
          row: ['{code}', '{question}', '{answer}', '{observation}'],
          loop: 'checklist',
          widths: [600, 5400, 1200, 2400],
        },
      },
      { p: '3. Constatări', bold: true },
      { p: '{findings}', spaceAfter: 360 },
      { p: '**Întocmit:** expert verificare financiară {people.evf_check.name}' },
      { p: '**Avizat:** șef serviciu' },
      { p: '**Aprobat:** director' },
      { p: 'Semnăturile electronice ale persoanelor de mai sus sunt aplicate pe document.', size: 18 },
    ],
  },
  p1_clarification_letter: {
    name: 'Scrisoare de solicitare clarificări',
    blocks: [
      { p: '{organization.name}', bold: true },
      { p: 'Către: {beneficiary_name}', spaceAfter: 60 },
      { p: 'Referitor la: cererea nr. {request_no}, proiect cod SMIS {smis_code}', spaceAfter: 240 },
      { p: 'Stimată doamnă / Stimate domn,', spaceAfter: 120 },
      {
        p: 'În urma verificării cererii menționate, vă rugăm să transmiteți, prin MySMIS2021, următoarele clarificări și documente:',
        align: 'both',
      },
      { p: '{clarification_questions}', spaceAfter: 240 },
      { p: 'Termenul de verificare a cererii se suspendă până la primirea răspunsului.', align: 'both', spaceAfter: 360 },
      { p: 'Cu stimă,' },
      { p: '{people.evf_check.name}' },
    ],
  },
  p1_authorization_notice: {
    name: 'Notificare de autorizare la plată',
    blocks: [
      { p: '{organization.name}', bold: true },
      { p: 'Către: {beneficiary_name} (CUI {beneficiary_cui})', spaceAfter: 240 },
      { p: 'NOTIFICARE', bold: true, size: 28, align: 'center' },
      { p: 'privind autorizarea cererii de {request_type} nr. {request_no}', align: 'center', spaceAfter: 240 },
      {
        p: 'Vă informăm că, pentru proiectul cod SMIS {smis_code} – {project_title}, din suma solicitată de {total_requested} lei a fost autorizată la plată suma de {total_eligible} lei.',
        align: 'both',
      },
      { p: 'Detalierea pe linii bugetare se regăsește în nota de verificare.', spaceAfter: 360 },
      { p: 'Director' },
    ],
  },
  p2_procurement_note: {
    name: 'Notă de verificare a achiziției',
    blocks: [
      { p: '{organization.name}', bold: true },
      { p: 'Nr. înregistrare: {registration_in}     Data: {today}', align: 'right' },
      { p: 'NOTĂ DE VERIFICARE A DOSARULUI DE ACHIZIȚIE', bold: true, size: 26, align: 'center', spaceAfter: 240 },
      { p: '**Beneficiar:** {beneficiary_name}, proiect cod SMIS {smis_code}' },
      { p: '**Obiectul achiziției:** {procurement_object}' },
      { p: '**Procedura:** {procedure_type}; **valoare:** {contract_value} lei; **contractant:** {supplier_name} ({supplier_cui})', spaceAfter: 240 },
      {
        table: {
          header: ['Nr.', 'Verificare', 'Temei', 'Rezultat', 'Observații'],
          row: ['{code}', '{question}', '{legal_basis}', '{answer}', '{observation}'],
          loop: 'checklist',
          widths: [500, 4200, 1500, 1200, 2200],
        },
      },
      { p: '**Constatări:** {findings}' },
      { p: '**Aviz:** {verdict}; reducere propusă: {correction_percent}% ({correction_amount} lei)', spaceAfter: 360 },
      { p: '**Întocmit:** {people.procurement_check.name}' },
      { p: '**Avizat:** șef serviciu' },
      { p: '**Aprobat:** director' },
    ],
  },
  p5_reply_letter: {
    name: 'Răspuns la corespondență',
    blocks: [
      { p: '{organization.name}', bold: true },
      { p: 'Către: {sender_name}', spaceAfter: 60 },
      { p: 'Referitor la: {subject} (înregistrat cu nr. {registration_in})', spaceAfter: 240 },
      { p: '{reply_summary}', align: 'both', spaceAfter: 360 },
      { p: 'Cu stimă,' },
      { p: 'Semnat electronic' },
    ],
  },
};
