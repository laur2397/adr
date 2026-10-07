-- Flux AM - Phase 1 starting schema (PostgreSQL 16).
-- Becomes the first migration once the data model is approved.
-- Conventions: snake_case, uuid primary keys (except append-only logs), timestamptz everywhere,
-- money as numeric(18,2) in RON, every business table carries organization_id (see assumption A1).

create extension if not exists pgcrypto with schema public;   -- gen_random_uuid(), digest()
create extension if not exists unaccent with schema public;    -- Romanian full-text search without diacritics

create schema if not exists flux;
set search_path = flux, public;

-- Full-text configuration: Romanian stemming, diacritics folded.
create text search configuration flux.ro (copy = pg_catalog.romanian);
alter text search configuration flux.ro
    alter mapping for hword, hword_part, word with public.unaccent, romanian_stem;

-- ============================================================================================
-- 1. Organization, identity, roles
-- ============================================================================================

create table organization (
    id          uuid primary key default gen_random_uuid(),
    name        text not null,
    cui         text not null unique,
    created_at  timestamptz not null default now()
);

create table department (
    id               uuid primary key default gen_random_uuid(),
    organization_id  uuid not null references organization,
    parent_id        uuid references department,
    code             text not null,
    name             text not null,
    head_user_id     uuid,                                   -- FK added after app_user
    active           boolean not null default true,
    unique (organization_id, code)
);

create table app_user (
    id                uuid primary key default gen_random_uuid(),
    organization_id   uuid not null references organization,
    department_id     uuid references department,
    username          text not null,
    email             text not null,
    full_name         text not null,
    job_title         text,
    password_hash     text,                                  -- argon2id; null when SSO only
    totp_secret_enc   bytea,                                 -- encrypted with app key
    external_subject  text,                                  -- OIDC / AD subject
    active            boolean not null default true,
    created_at        timestamptz not null default now(),
    unique (organization_id, username)
);
create unique index app_user_email_uq on app_user (organization_id, lower(email));

alter table department
    add constraint department_head_fk foreign key (head_user_id) references app_user;

-- Roles are data, not an enum: the 10 base roles are seeded, an admin can add more.
create table role (
    id               uuid primary key default gen_random_uuid(),
    organization_id  uuid not null references organization,
    key              text not null,      -- registry_inspector, evf_expert, ei_expert, procurement_expert,
                                         -- head_of_unit, director, cfpp, functional_admin, it_admin, auditor
    name             text not null,
    unique (organization_id, key)
);

-- A user can hold several roles, scoped by department and/or program, for a period.
create table role_assignment (
    id             uuid primary key default gen_random_uuid(),
    user_id        uuid not null references app_user,
    role_id        uuid not null references role,
    department_id  uuid references department,               -- null = whole organization
    program_id     uuid,                                     -- FK added after program; null = all programs
    valid_from     date not null default current_date,
    valid_to       date,
    check (valid_to is null or valid_to >= valid_from)
);
create index on role_assignment (user_id);
create index on role_assignment (role_id);

-- Substitution during leave: tasks only, or full rights; optionally limited to one process.
create table substitution (
    id                      uuid primary key default gen_random_uuid(),
    absent_user_id          uuid not null references app_user,
    substitute_user_id      uuid not null references app_user,
    scope                   text not null check (scope in ('tasks', 'full')),
    process_definition_key  text,                            -- null = all processes
    valid_from              timestamptz not null,
    valid_to                timestamptz not null,
    created_by              uuid not null references app_user,
    created_at              timestamptz not null default now(),
    check (absent_user_id <> substitute_user_id),
    check (valid_to > valid_from)
);
create index on substitution (absent_user_id, valid_from, valid_to);

create table user_session (
    id            uuid primary key default gen_random_uuid(),
    user_id       uuid not null references app_user,
    created_at    timestamptz not null default now(),
    last_seen_at  timestamptz not null default now(),
    expires_at    timestamptz not null,
    ip            inet,
    user_agent    text,
    revoked_at    timestamptz
);
create index on user_session (user_id);

-- ============================================================================================
-- 2. Reference data: programs, calls, beneficiaries, projects, nomenclatures
-- ============================================================================================

create table program (
    id               uuid primary key default gen_random_uuid(),
    organization_id  uuid not null references organization,
    code             text not null,                          -- PR SVO, PTJ, ...
    name             text not null,
    active           boolean not null default true,
    unique (organization_id, code)
);

alter table role_assignment
    add constraint role_assignment_program_fk foreign key (program_id) references program;

create table priority (
    id          uuid primary key default gen_random_uuid(),
    program_id  uuid not null references program,
    code        text not null,
    name        text not null,
    unique (program_id, code)
);

create table call_for_proposals (
    id           uuid primary key default gen_random_uuid(),
    priority_id  uuid not null references priority,
    code         text not null,
    name         text not null,
    unique (priority_id, code)
);

create table beneficiary (
    id                uuid primary key default gen_random_uuid(),
    organization_id   uuid not null references organization,
    cui               text not null,
    name              text not null,
    trade_register_no text,                                  -- nr. ONRC
    caen_code         text,
    address           text,
    county            text,
    vat_payer         boolean,
    anaf_fetched_at   timestamptz,                           -- when the fields above came from ANAF
    anaf_payload      jsonb,                                 -- raw ANAF response kept for traceability
    unique (organization_id, cui)
);

create table project (
    id                      uuid primary key default gen_random_uuid(),
    organization_id         uuid not null references organization,
    smis_code               text not null,
    title                   text not null,
    beneficiary_id          uuid not null references beneficiary,
    call_id                 uuid references call_for_proposals,
    program_id              uuid not null references program,
    contract_number         text,
    contract_date           date,
    total_value             numeric(18,2),
    eligible_value          numeric(18,2),
    non_reimbursable_value  numeric(18,2),
    start_date              date,
    end_date                date,
    responsible_expert_id   uuid references app_user,        -- used by the "project_expert" assignment rule
    source                  text not null default 'manual' check (source in ('manual', 'import', 'mysmis')),
    source_at               timestamptz,
    unique (organization_id, smis_code)
);
create index on project (beneficiary_id);

create table project_budget_line (
    id                      uuid primary key default gen_random_uuid(),
    project_id              uuid not null references project on delete cascade,
    code                    text not null,
    category                text not null,
    eligible_amount         numeric(18,2) not null default 0,
    non_eligible_amount     numeric(18,2) not null default 0,
    approved_to_date        numeric(18,2) not null default 0,  -- updated when a CR/CP is registered
    unique (project_id, code)
);

create table nomenclature (
    id               uuid primary key default gen_random_uuid(),
    organization_id  uuid not null references organization,
    key              text not null,
    name             text not null,
    unique (organization_id, key)
);

create table nomenclature_item (
    id               uuid primary key default gen_random_uuid(),
    nomenclature_id  uuid not null references nomenclature on delete cascade,
    parent_id        uuid references nomenclature_item,
    code             text not null,
    label            text not null,
    position         int not null default 0,
    active           boolean not null default true,
    unique (nomenclature_id, code)
);

-- ============================================================================================
-- 3. Working-day calendar and deadline definitions (Module 4, configuration part)
-- ============================================================================================

create table holiday (
    organization_id  uuid not null references organization,
    day              date not null,
    name             text not null,
    primary key (organization_id, day)
);

-- Saturdays/Sundays that are working days (recovered days) can be added here as exceptions.
create table working_day_exception (
    organization_id  uuid not null references organization,
    day              date not null,
    is_working       boolean not null,
    note             text,
    primary key (organization_id, day)
);

create table deadline_definition (
    id                    uuid primary key default gen_random_uuid(),
    organization_id       uuid not null references organization,
    key                   text not null,                     -- p1_verification, petition_og27, foia_544 ...
    name                  text not null,
    day_type              text not null check (day_type in ('calendar', 'working')),
    days                  int not null check (days > 0),
    start_point           text not null check (start_point in ('submission_date', 'registration_date', 'step_entry')),
    pause_mode            text not null default 'suspend' check (pause_mode in ('suspend', 'restart')),
    max_pauses            int,                                -- cap on number of suspensions; null = none
    max_paused_days       int,                                -- cap on total suspended days; null = none
    extension_days        int,                                -- e.g. +15 for OG 27/2002
    warn_before_days      int not null default 2,
    legal_reference       text,
    legal_status          text not null default 'to_validate' check (legal_status in ('to_validate', 'validated')),
    validated_by          uuid references app_user,
    validated_at          timestamptz,
    unique (organization_id, key)
);

-- ============================================================================================
-- 4. Workflow engine (Module 1)
-- ============================================================================================

create table process_definition (
    id               uuid primary key default gen_random_uuid(),
    organization_id  uuid not null references organization,
    key              text not null,                          -- p1_reimbursement_check
    version          int not null,
    name             text not null,
    definition       jsonb not null,                         -- validated against packages/process-schema
    status           text not null default 'draft' check (status in ('draft', 'published', 'retired')),
    created_by       uuid not null references app_user,
    created_at       timestamptz not null default now(),
    published_at     timestamptz,
    unique (organization_id, key, version)
);
-- Only one published version per key at a time.
create unique index process_definition_one_published
    on process_definition (organization_id, key) where status = 'published';

-- Published definitions are immutable.
create function forbid_published_definition_change() returns trigger language plpgsql as $$
begin
    if old.status <> 'draft' and (new.definition is distinct from old.definition or new.version <> old.version) then
        raise exception 'published process definition % v% is immutable', old.key, old.version;
    end if;
    return new;
end $$;
create trigger process_definition_immutable before update on process_definition
    for each row execute function forbid_published_definition_change();

create table instance (
    id                   uuid primary key default gen_random_uuid(),
    organization_id      uuid not null references organization,
    definition_id        uuid not null references process_definition,
    reference_no         text,                               -- usually the registration number
    title                text not null,
    status               text not null default 'active'
                         check (status in ('active', 'suspended', 'completed_positive', 'completed_negative', 'cancelled')),
    project_id           uuid references project,
    beneficiary_id       uuid references beneficiary,
    program_id           uuid references program,
    responsible_user_id  uuid references app_user,
    parent_instance_id   uuid references instance,           -- sub-flows
    started_by           uuid not null references app_user,
    started_at           timestamptz not null default now(),
    finished_at          timestamptz,
    search_vector        tsvector
);
create index on instance (definition_id, status);
create index on instance (project_id);
create index on instance (responsible_user_id) where status = 'active';
create index on instance using gin (search_vector);

-- One row per active branch ("token"). Parallel split creates one per branch; join consumes them.
create table execution (
    id             uuid primary key default gen_random_uuid(),
    instance_id    uuid not null references instance on delete cascade,
    parent_id      uuid references execution,              -- the split that created this branch
    step_key       text not null,
    status         text not null default 'active' check (status in ('active', 'waiting_join', 'done', 'cancelled')),
    entered_at     timestamptz not null default now(),
    left_at        timestamptz
);
create index on execution (instance_id) where status in ('active', 'waiting_join');

create table task (
    id                     uuid primary key default gen_random_uuid(),
    instance_id            uuid not null references instance on delete cascade,
    execution_id           uuid not null references execution,
    step_key               text not null,
    name                   text not null,
    assignee_user_id       uuid references app_user,         -- null while it sits in a queue
    candidate_role_id      uuid references role,
    candidate_department_id uuid references department,
    status                 text not null default 'open' check (status in ('open', 'completed', 'cancelled')),
    created_at             timestamptz not null default now(),
    due_at                 timestamptz,
    completed_at           timestamptz,
    completed_by           uuid references app_user,         -- who clicked (the substitute, if any)
    on_behalf_of           uuid references app_user,         -- the titular, when a substitute acted
    path_key               text,                             -- the path (button) taken
    comment                text,
    check (assignee_user_id is not null or candidate_role_id is not null or candidate_department_id is not null)
);
create index on task (assignee_user_id) where status = 'open';
create index on task (candidate_role_id) where status = 'open';
create index on task (instance_id);

-- Step history for the circuit bar: who, which step, when, which path. Derived from tasks and
-- system steps; kept separate so system/automatic steps also appear.
create table step_history (
    id            bigserial primary key,
    instance_id   uuid not null references instance on delete cascade,
    step_key      text not null,
    entered_at    timestamptz not null,
    left_at       timestamptz,
    actor_user_id uuid references app_user,
    on_behalf_of  uuid references app_user,
    path_key      text,
    comment       text
);
create index on step_history (instance_id, entered_at);

-- Explicit access to a dossier (acceptance criterion 4). Rows are added by the engine as people
-- become involved (assignee, reviewer) and by admins/heads for read access.
create table instance_acl (
    instance_id     uuid not null references instance on delete cascade,
    principal_type  text not null check (principal_type in ('user', 'role', 'department')),
    principal_id    uuid not null,
    permission      text not null check (permission in ('view', 'edit')),
    reason          text not null,                            -- assignee, participant, granted, auditor
    granted_by      uuid references app_user,
    granted_at      timestamptz not null default now(),
    primary key (instance_id, principal_type, principal_id, permission)
);
create index on instance_acl (principal_type, principal_id);

-- Transactional outbox: slow side effects (PDF, email, ANAF refresh) are enqueued after commit.
create table job_outbox (
    id            bigserial primary key,
    kind          text not null,
    payload       jsonb not null,
    created_at    timestamptz not null default now(),
    dispatched_at timestamptz
);
create index on job_outbox (id) where dispatched_at is null;

-- ============================================================================================
-- 5. Forms: field values with provenance, line items (Module 2)
-- ============================================================================================

create table instance_field (
    instance_id  uuid not null references instance on delete cascade,
    field_key    text not null,
    value        jsonb,
    source       text not null default 'manual' check (source in ('manual', 'project', 'beneficiary', 'anaf', 'mysmis', 'import', 'calculated', 'previous_instance')),
    source_at    timestamptz,                                -- when the source value was obtained
    updated_by   uuid references app_user,
    updated_at   timestamptz not null default now(),
    primary key (instance_id, field_key)
);

-- Rows of an editable table (e.g. expense lines). Typed values live in jsonb, validated by the
-- field definition; amounts are stored as strings of numeric to avoid float rounding.
create table instance_list_row (
    id           uuid primary key default gen_random_uuid(),
    instance_id  uuid not null references instance on delete cascade,
    list_key     text not null,
    position     int not null,
    values       jsonb not null,
    updated_by   uuid references app_user,
    updated_at   timestamptz not null default now(),
    unique (instance_id, list_key, position) deferrable initially deferred
);

-- ============================================================================================
-- 6. Checklists
-- ============================================================================================

create table checklist_template (
    id               uuid primary key default gen_random_uuid(),
    organization_id  uuid not null references organization,
    key              text not null,                          -- p1_default, p2_procurement_55
    version          int not null,
    name             text not null,
    answer_set       text[] not null default array['DA', 'NU', 'NA'],  -- P2 uses DA, DA_CU_OBS, NU, NA
    status           text not null default 'draft' check (status in ('draft', 'published', 'retired')),
    unique (organization_id, key, version)
);

create table checklist_item (
    id            uuid primary key default gen_random_uuid(),
    template_id   uuid not null references checklist_template on delete cascade,
    position      int not null,
    code          text not null,
    question      text not null,
    legal_basis   text,
    observation_required_on text[] not null default array['NU'],
    unique (template_id, code)
);

create table checklist_response (
    instance_id     uuid not null references instance on delete cascade,
    item_id         uuid not null references checklist_item,
    verifier_role   text not null default 'primary',        -- primary (EVF) / second (EI) for double check
    answer          text,
    observation     text,
    document_id     uuid,                                     -- FK added after document
    answered_by     uuid references app_user,
    answered_at     timestamptz,
    primary key (instance_id, item_id, verifier_role)
);

-- ============================================================================================
-- 7. Documents, versions, templates
-- ============================================================================================

create table document_template (
    id               uuid primary key default gen_random_uuid(),
    organization_id  uuid not null references organization,
    key              text not null,                          -- p1_verification_note, p1_clarification_letter
    version          int not null,
    name             text not null,
    storage_key      text not null,
    sha256           bytea not null,
    status           text not null default 'draft' check (status in ('draft', 'published', 'retired')),
    created_by       uuid not null references app_user,
    created_at       timestamptz not null default now(),
    unique (organization_id, key, version)
);

create table archive_nomenclature_item (
    id               uuid primary key default gen_random_uuid(),
    organization_id  uuid not null references organization,
    department_id    uuid references department,
    indicative       text not null,                          -- indicativ dosar
    title            text not null,
    retention_years  int,                                    -- null = permanent (Legea 16/1996)
    unique (organization_id, indicative)
);

-- Archival file ("dosar") for a given year.
create table archive_file (
    id                uuid primary key default gen_random_uuid(),
    nomenclature_item_id uuid not null references archive_nomenclature_item,
    year              int not null,
    closed_at         timestamptz,
    unique (nomenclature_item_id, year)
);

create table document (
    id                  uuid primary key default gen_random_uuid(),
    organization_id     uuid not null references organization,
    instance_id         uuid references instance on delete restrict,
    doc_type            text not null,                       -- verification_note, invoice, payment_order ...
    title               text not null,
    archive_file_id     uuid references archive_file,
    created_by          uuid not null references app_user,
    created_at          timestamptz not null default now()
);
create index on document (instance_id);

create table document_version (
    id                   uuid primary key default gen_random_uuid(),
    document_id          uuid not null references document on delete restrict,
    version_no           int not null,
    storage_key          text not null,
    file_name            text not null,
    mime_type            text not null,
    size_bytes           bigint not null,
    sha256               bytea not null,
    source               text not null check (source in ('generated', 'uploaded', 'email', 'scanned')),
    template_id          uuid references document_template,  -- set when generated
    archival_metadata    jsonb not null default '{}',
    created_by           uuid not null references app_user,
    created_at           timestamptz not null default now(),
    unique (document_id, version_no)
);

alter table checklist_response
    add constraint checklist_response_document_fk foreign key (document_id) references document;

-- File content is immutable: a change is always a new version.
create function forbid_version_content_change() returns trigger language plpgsql as $$
begin
    if new.sha256 <> old.sha256 or new.storage_key <> old.storage_key then
        raise exception 'document versions are immutable; create a new version';
    end if;
    return new;
end $$;
create trigger document_version_immutable before update on document_version
    for each row execute function forbid_version_content_change();

-- ============================================================================================
-- 8. Signatures (Module 5)
-- ============================================================================================

create table signature (
    id                   uuid primary key default gen_random_uuid(),
    document_version_id  uuid not null references document_version,
    instance_id          uuid references instance,
    step_key             text,                               -- step that requested it (for invalidation on return)
    sequence             int not null,                       -- signing order defined by the flow
    signer_user_id       uuid references app_user,           -- null for external signatures found on upload
    signer_role          text,
    level                text not null check (level in ('simple', 'advanced', 'qualified', 'seal')),
    status               text not null default 'pending'
                         check (status in ('pending', 'signed', 'rejected', 'invalidated', 'external')),
    provider             text,                               -- certsign, digisign, transsped, namirial
    provider_reference   text,
    format               text check (format in ('PAdES-B-B', 'PAdES-B-T', 'PAdES-B-LT', 'PAdES-B-LTA')),
    signed_at            timestamptz,
    signed_version_id    uuid references document_version,   -- the signed PDF is a new version
    validation_result    jsonb,                              -- DSS report summary
    invalidated_at       timestamptz,
    invalidated_reason   text,
    created_at           timestamptz not null default now()
);
create index on signature (signer_user_id) where status = 'pending';   -- "Documente de semnat"
create index on signature (document_version_id);

-- ============================================================================================
-- 9. Registry (Module 3)
-- ============================================================================================

create table correspondent (
    id               uuid primary key default gen_random_uuid(),
    organization_id  uuid not null references organization,
    name             text not null,
    cui              text,
    email            text,
    address          text,
    beneficiary_id   uuid references beneficiary
);
-- Deduplication by CUI / e-mail (Module 3, point 4).
create unique index correspondent_cui_uq   on correspondent (organization_id, cui) where cui is not null;
create unique index correspondent_email_uq on correspondent (organization_id, lower(email)) where email is not null and cui is null;

create table register (
    id               uuid primary key default gen_random_uuid(),
    organization_id  uuid not null references organization,
    key              text not null,                          -- general, contracts, cr_cp, decisions, irregularities ...
    name             text not null,
    number_format    text not null default '{n}/{dd}.{mm}.{yyyy}',
    yearly_reset     boolean not null default true,
    fields           jsonb not null default '[]',            -- extra columns specific to this register
    active           boolean not null default true,
    unique (organization_id, key)
);

create table register_counter (
    register_id  uuid not null references register,
    year         int not null,                               -- 0 when yearly_reset = false
    last_value   bigint not null default 0,
    primary key (register_id, year)
);

create table register_entry (
    id                uuid primary key default gen_random_uuid(),
    register_id       uuid not null references register,
    year              int not null,
    number            bigint not null,
    number_display    text not null,                         -- 4812/07.10.2026
    registered_at     timestamptz not null default now(),
    direction         text not null check (direction in ('in', 'out', 'internal')),
    sender_id         uuid references correspondent,
    recipient_id      uuid references correspondent,
    internal_department_id uuid references department,
    subject           text not null,
    channel           text check (channel in ('desk', 'email', 'post', 'portal', 'mysmis', 'internal')),
    instance_id       uuid references instance,
    archive_file_id   uuid references archive_file,
    related_entry_id  uuid references register_entry,        -- conexare (e.g. reply to an earlier letter)
    resolution        text,
    extra             jsonb not null default '{}',
    created_by        uuid not null references app_user,
    search_vector     tsvector generated always as (to_tsvector('flux.ro', coalesce(subject, '') || ' ' || coalesce(number_display, ''))) stored,
    unique (register_id, year, number)
);
create index on register_entry using gin (search_vector);
create index on register_entry (instance_id);

-- Atomic, gap-free numbering: the counter row is locked until the calling transaction commits,
-- so a rolled-back registration does not consume a number.
create function next_register_number(p_register_id uuid, p_year int) returns bigint
language sql as $$
    insert into flux.register_counter as c (register_id, year, last_value)
    values (p_register_id, p_year, 1)
    on conflict (register_id, year) do update set last_value = c.last_value + 1
    returning last_value;
$$;

-- ============================================================================================
-- 10. Deadlines at runtime (Module 4)
-- ============================================================================================

create table deadline (
    id               uuid primary key default gen_random_uuid(),
    instance_id      uuid not null references instance on delete cascade,
    task_id          uuid references task,
    definition_id    uuid not null references deadline_definition,
    started_on       date not null,
    due_on           date not null,                          -- recomputed on every suspension/resume
    status           text not null default 'running' check (status in ('running', 'paused', 'met', 'breached', 'cancelled')),
    pause_count      int not null default 0,
    paused_days      int not null default 0,
    last_reminder_at timestamptz,
    escalated_at     timestamptz,
    closed_at        timestamptz
);
create index on deadline (due_on) where status = 'running';

create table deadline_pause (
    id            uuid primary key default gen_random_uuid(),
    deadline_id   uuid not null references deadline on delete cascade,
    paused_on     date not null,
    resumed_on    date,
    reason        text not null,                             -- e.g. clarification request no.
    created_by    uuid not null references app_user
);

create table notification (
    id           bigserial primary key,
    user_id      uuid not null references app_user,
    kind         text not null,                              -- task_assigned, deadline_warning, escalation ...
    instance_id  uuid references instance,
    payload      jsonb not null default '{}',
    created_at   timestamptz not null default now(),
    read_at      timestamptz,
    emailed_at   timestamptz
);
create index on notification (user_id) where read_at is null;

-- ============================================================================================
-- 11. Audit (Module 6): append-only, hash-chained
-- ============================================================================================

create sequence audit_event_id_seq;

create table audit_event (
    id                    bigint primary key,            -- assigned by the chain trigger, under the lock
    occurred_at           timestamptz not null default clock_timestamp(),
    organization_id       uuid not null,
    actor_user_id         uuid,                              -- null for system actions
    on_behalf_of_user_id  uuid,
    action                text not null,                     -- instance.transition, document.view, register.entry.create ...
    entity_type           text not null,
    entity_id             text not null,
    old_value             jsonb,
    new_value             jsonb,
    ip                    inet,
    user_agent            text,
    prev_hash             bytea,
    hash                  bytea not null
);
create index on audit_event (entity_type, entity_id);
create index on audit_event (actor_user_id, occurred_at);

-- Hash = sha256(prev_hash || canonical row). Inserts are serialized with a transaction-level
-- advisory lock so the chain has no forks. The application role gets INSERT/SELECT only.
create function audit_event_chain() returns trigger language plpgsql as $$
declare
    v_prev bytea;
begin
    perform pg_advisory_xact_lock(hashtext('flux.audit_event'));
    -- The id is taken under the lock, so id order = chain order even with concurrent writers.
    new.id := nextval('flux.audit_event_id_seq');
    select hash into v_prev from flux.audit_event order by id desc limit 1;
    new.occurred_at := clock_timestamp();
    new.prev_hash := v_prev;
    new.hash := digest(
        coalesce(encode(v_prev, 'hex'), '') || '|' ||
        new.id::text || '|' || (new.occurred_at at time zone 'UTC')::text || '|' || new.organization_id::text || '|' ||
        coalesce(new.actor_user_id::text, '') || '|' || coalesce(new.on_behalf_of_user_id::text, '') || '|' ||
        new.action || '|' || new.entity_type || '|' || new.entity_id || '|' ||
        coalesce(new.old_value::text, '') || '|' || coalesce(new.new_value::text, '') || '|' ||
        coalesce(host(new.ip), ''),
        'sha256');
    return new;
end $$;
create trigger audit_event_chain before insert on audit_event
    for each row execute function audit_event_chain();

create function forbid_audit_change() returns trigger language plpgsql as $$
begin
    raise exception 'audit_event is append-only';
end $$;
create trigger audit_event_no_update before update or delete on audit_event
    for each row execute function forbid_audit_change();
create trigger audit_event_no_truncate before truncate on audit_event
    for each statement execute function forbid_audit_change();

-- Verification: returns the first broken link, or no rows when the chain is intact.
create function audit_verify_chain() returns table (broken_id bigint) language sql stable as $$
    with ordered as (
        select e.*, lag(e.hash) over (order by e.id) as expected_prev
        from flux.audit_event e
    )
    select id from ordered
    where prev_hash is distinct from expected_prev
       or hash <> digest(
            coalesce(encode(prev_hash, 'hex'), '') || '|' ||
            id::text || '|' || (occurred_at at time zone 'UTC')::text || '|' || organization_id::text || '|' ||
            coalesce(actor_user_id::text, '') || '|' || coalesce(on_behalf_of_user_id::text, '') || '|' ||
            action || '|' || entity_type || '|' || entity_id || '|' ||
            coalesce(old_value::text, '') || '|' || coalesce(new_value::text, '') || '|' ||
            coalesce(host(ip), ''),
            'sha256')
    order by id
    limit 1;
$$;

-- ============================================================================================
-- 12. GDPR: record of processing activities and retention
-- ============================================================================================

create table processing_activity (
    id                uuid primary key default gen_random_uuid(),
    organization_id   uuid not null references organization,
    name              text not null,
    purpose           text not null,
    legal_basis       text not null,
    data_categories   text[] not null,
    retention         text not null,
    process_definition_key text                              -- links an activity to a process
);
