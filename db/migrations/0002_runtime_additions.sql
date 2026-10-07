-- Additions found while implementing the phase 1 services.
set search_path = flux, public;

-- Sessions are looked up by the hash of the cookie token; the raw token is never stored.
alter table user_session add column token_hash bytea not null unique;

-- Checklist template version pinned when the instance starts (like the process definition).
create table instance_checklist (
    instance_id    uuid not null references instance on delete cascade,
    checklist_key  text not null,
    template_id    uuid not null references checklist_template,
    primary key (instance_id, checklist_key)
);

-- Process documents are addressed by the definition's document key (verification_note ...).
alter table document add column doc_key text;
create unique index document_instance_key_uq on document (instance_id, doc_key) where doc_key is not null;

-- Fast lookups for signature rules ("has this user signed this document?").
alter table signature add column document_id uuid references document;
create index on signature (document_id, status);

-- The letter an outgoing registration refers to.
alter table register_entry add column document_id uuid references document;

-- Search on dossiers: title + reference number + beneficiary name, maintained by the API.
create index instance_title_trgm_fallback on instance (lower(title));

-- Deadlines started from a definition entry are unique per instance.
alter table deadline add column deadline_key text not null default '';
create unique index deadline_instance_key_uq on deadline (instance_id, deadline_key) where status <> 'cancelled';
alter table deadline add column extended boolean not null default false;

-- Outbox: retries and last error, so a failing job is visible instead of silently lost.
alter table job_outbox add column attempts int not null default 0;
alter table job_outbox add column last_error text;
alter table job_outbox add column run_after timestamptz not null default now();

-- Migration bookkeeping is created by the migration runner itself (flux.schema_migrations).
