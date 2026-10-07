-- On-site verification (P8): photos with time and GPS position, the beneficiary representative's
-- signature, and the link between a sampling plan and the visits it produced.
set search_path = flux, public;

create table visit_evidence (
    id               uuid primary key default gen_random_uuid(),
    organization_id  uuid not null references organization,
    instance_id      uuid not null references instance,
    kind             text not null check (kind in ('photo', 'signature')),
    storage_key      text not null,                -- content-addressed file (documents/storage.ts)
    sha256           bytea not null,
    mime_type        text not null check (mime_type in ('image/jpeg', 'image/png')),
    size_bytes       int not null,
    width            int,
    height           int,
    caption          text,
    signer_name      text,                         -- signature: who signed on the device
    taken_at         timestamptz,                  -- device clock at capture (may differ from upload time)
    latitude         numeric(9,6),
    longitude        numeric(9,6),
    accuracy_m       numeric(8,1),
    client_id        text not null,                -- generated on the device; makes offline re-sends idempotent
    captured_by      uuid not null references app_user,
    step_key         text not null,
    created_at       timestamptz not null default now(),
    deleted_at       timestamptz,
    deleted_by       uuid references app_user,
    unique (instance_id, client_id),
    check ((latitude is null) = (longitude is null)),
    check (latitude is null or (latitude between -90 and 90 and longitude between -180 and 180))
);
create index visit_evidence_instance_idx on visit_evidence (instance_id) where deleted_at is null;

-- One visit per sampled dossier and plan; re-running "create visits" does not duplicate them.
create table sampling_visit (
    sampling_plan_id   uuid not null references sampling_plan,
    sampled_instance_id uuid not null references instance,
    visit_instance_id  uuid not null references instance,
    created_by         uuid not null references app_user,
    created_at         timestamptz not null default now(),
    primary key (sampling_plan_id, sampled_instance_id)
);
create index sampling_visit_visit_idx on sampling_visit (visit_instance_id);
