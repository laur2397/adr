-- Controls required for EU-funds management verifications (Reg. 2021/1060 art. 74, Legea 184/2016):
-- conflict-of-interest declarations, double-funding detection, risk-based sampling.
set search_path = flux, public;

-- A verifier declares the absence (or presence) of a conflict of interest before acting on a dossier.
create table coi_declaration (
    instance_id   uuid not null references instance on delete cascade,
    user_id       uuid not null references app_user,
    has_conflict  boolean not null,
    statement     text,
    declared_at   timestamptz not null default now(),
    primary key (instance_id, user_id)
);

-- One row per invoice claimed in a dossier: the same invoice claimed twice (same supplier and
-- number) in any project or programme is a double-funding alert.
create table invoice_fingerprint (
    id               uuid primary key default gen_random_uuid(),
    organization_id  uuid not null references organization,
    instance_id      uuid not null references instance on delete cascade,
    project_id       uuid references project,
    supplier_cui     text not null,
    invoice_no       text not null,          -- normalized: upper case, no spaces or separators, no leading zeros
    invoice_no_raw   text not null,
    invoice_date     date,
    amount           numeric(18,2),
    row_position     int not null,
    created_at       timestamptz not null default now()
);
create index on invoice_fingerprint (organization_id, supplier_cui, invoice_no);
create index on invoice_fingerprint (instance_id);

-- Risk-based sampling for on-the-spot checks: population, scores, the seed and the selection are
-- stored so that the selection can be reproduced and audited.
create table sampling_plan (
    id               uuid primary key default gen_random_uuid(),
    organization_id  uuid not null references organization,
    name             text not null,
    definition_key   text not null,
    period_from      date,
    period_to        date,
    method           text not null check (method in ('risk_weighted', 'simple_random')),
    sample_size      int not null check (sample_size > 0),
    high_risk_threshold numeric(5,2) not null default 70,
    seed             text not null,
    population_size  int not null,
    items            jsonb not null,             -- [{instanceId, score, factors, selected, reason}]
    justification    text not null,
    created_by       uuid not null references app_user,
    created_at       timestamptz not null default now()
);
