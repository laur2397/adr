-- Phase 2: sub-flows, dossier comments, API tokens and webhooks, e-mail intake, debtor ledger,
-- e-archive operations.
set search_path = flux, public;

-- A 'subflow' step waits for a child instance; the child resumes the parent when it ends.
alter table execution add column child_instance_id uuid references instance;
create index on execution (child_instance_id) where child_instance_id is not null;

-- Comments on a dossier (append-only, like the audit: corrections are new comments).
create table instance_comment (
    id           uuid primary key default gen_random_uuid(),
    instance_id  uuid not null references instance on delete cascade,
    author_id    uuid not null references app_user,
    on_behalf_of uuid references app_user,
    body         text not null check (length(body) between 1 and 5000),
    mentions     uuid[] not null default '{}',
    created_at   timestamptz not null default now()
);
create index on instance_comment (instance_id, created_at);

-- Machine access for integrations (Power BI, other systems). Only the hash is stored.
create table api_token (
    id               uuid primary key default gen_random_uuid(),
    organization_id  uuid not null references organization,
    name             text not null,
    token_hash       bytea not null unique,
    -- the token acts as this (technical) user, with that user's roles and rights
    user_id          uuid not null references app_user,
    created_by       uuid not null references app_user,
    created_at       timestamptz not null default now(),
    expires_at       timestamptz,
    last_used_at     timestamptz,
    revoked_at       timestamptz
);

-- Outgoing notifications to other systems, signed with HMAC-SHA256.
create table webhook (
    id               uuid primary key default gen_random_uuid(),
    organization_id  uuid not null references organization,
    name             text not null,
    url              text not null check (url ~ '^https?://'),
    events           text[] not null,
    secret_enc       bytea not null,
    active           boolean not null default true,
    created_by       uuid not null references app_user,
    created_at       timestamptz not null default now()
);

-- E-mail intake: each message becomes an incoming registration (and optionally a dossier),
-- or is attached to the dossier whose registration number appears in the subject.
create table mail_message (
    id               uuid primary key default gen_random_uuid(),
    organization_id  uuid not null references organization,
    message_id       text not null,
    from_address     text not null,
    from_name        text,
    subject          text not null,
    received_at      timestamptz not null,
    body_text        text,
    to_address       text,
    status           text not null check (status in ('pending', 'registered', 'attached', 'ignored', 'error')),
    raw_storage_key  text,                       -- the original .eml, content-addressed like documents
    attachments      jsonb not null default '[]',-- [{fileName, mimeType, size, storageKey}]
    suggested_instance_id uuid references instance,
    register_entry_id uuid references register_entry,
    instance_id      uuid references instance,
    error            text,
    processed_at     timestamptz,
    processed_by     uuid references app_user,
    created_at       timestamptz not null default now(),
    unique (organization_id, message_id)
);

-- Debtor ledger (P4): debt securities (titluri de creanta), payments, balance.
create table debt (
    id               uuid primary key default gen_random_uuid(),
    organization_id  uuid not null references organization,
    instance_id      uuid references instance,
    project_id       uuid references project,
    beneficiary_id   uuid not null references beneficiary,
    title_number     text not null,
    title_date       date not null,
    due_date         date not null,
    principal        numeric(18,2) not null check (principal >= 0),
    accessories      numeric(18,2) not null default 0,
    reason           text not null,
    status           text not null default 'open' check (status in ('open', 'partially_paid', 'paid', 'contested', 'cancelled')),
    created_by       uuid not null references app_user,
    created_at       timestamptz not null default now(),
    unique (organization_id, title_number)
);

create table debt_payment (
    id          uuid primary key default gen_random_uuid(),
    debt_id     uuid not null references debt on delete cascade,
    amount      numeric(18,2) not null check (amount > 0),
    paid_on     date not null,
    reference   text not null,
    kind        text not null default 'payment' check (kind in ('payment', 'offset')),
    created_by  uuid not null references app_user,
    created_at  timestamptz not null default now()
);

-- E-archive: an archival file is closed at year end, then kept until its retention expires;
-- disposal (eliminare) needs a recorded decision (Legea 16/1996).
alter table archive_file add column closed_by uuid references app_user;
alter table archive_file add column disposed_at timestamptz;
alter table archive_file add column disposal_decision text;
alter table archive_file add column disposed_by uuid references app_user;

-- Full-text search over dossiers: title, reference, field values, comments, document titles.
alter table instance add column search_text text not null default '';
create index instance_search_idx on instance using gin (to_tsvector('flux.ro', search_text));
