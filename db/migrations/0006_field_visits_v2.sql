-- Field visits v2 (Anexa 6 la Ordinul MIPE 1777/2023): checklist items grouped in sections, with
-- guidance and a condition that makes them apply only to some visits (ex-post, works, energy
-- efficiency); photos tagged with the report section they document; built-in templates that are
-- upgraded when the product ships a new version.
set search_path = flux, public;

alter table checklist_item add column section text;
alter table checklist_item add column hint text;
alter table checklist_item add column applies_when jsonb;

alter table visit_evidence add column section text;

-- Hash of the built-in template source; null for templates uploaded by the institution.
alter table document_template add column source_hash text;
