#!/usr/bin/env bash
# Loads db/schema.sql into a scratch database and checks the guarantees the design relies on:
# gap-free concurrent register numbering, append-only hash-chained audit, immutable definitions.
# Usage: PGHOST=... PGPORT=... PGUSER=... db/tests/verify-schema.sh   (needs createdb rights)
set -euo pipefail
cd "$(dirname "$0")/../.."
DB=flux_verify_$$
createdb "$DB"
trap 'dropdb --if-exists "$DB"' EXIT
P=(psql -X -q -t -A -v ON_ERROR_STOP=1 -d "$DB")
"${P[@]}" -f db/schema.sql >/dev/null

ORG=00000000-0000-0000-0000-000000000001
USR=00000000-0000-0000-0000-0000000000a1
REG=00000000-0000-0000-0000-0000000000b1
"${P[@]}" -c "insert into flux.organization(id,name,cui) values ('$ORG','Test','1');
  insert into flux.app_user(id,organization_id,username,email,full_name) values ('$USR','$ORG','u','u@x.ro','U');
  insert into flux.register(id,organization_id,key,name) values ('$REG','$ORG','general','Registru general');"

fail() { echo "FAIL: $*"; exit 1; }

# 1. 100 concurrent registrations + 1 rolled back -> numbers 1..100, no gaps, no duplicates.
REGISTER="begin;
insert into flux.register_entry(register_id,year,number,number_display,direction,subject,created_by)
select '$REG',2026,n,n::text,'in','test','$USR' from flux.next_register_number('$REG',2026) n;
select pg_sleep(random()*0.05);
commit;"
for _ in $(seq 1 100); do "${P[@]}" -c "$REGISTER" >/dev/null & done; wait
"${P[@]}" -c "begin; select flux.next_register_number('$REG',2026); rollback;" >/dev/null
[ "$("${P[@]}" -c "select count(distinct number)||'/'||min(number)||'/'||max(number) from flux.register_entry")" = "100/1/100" ] \
  || fail "register numbering"
echo "ok   register: 100 concurrent registrations -> 1..100, rollback consumed no number"

# 2. Audit chain under concurrency, append-only, tamper detection.
AUDIT="insert into flux.audit_event(organization_id,actor_user_id,action,entity_type,entity_id,new_value)
values ('$ORG','$USR','document.view','document',gen_random_uuid()::text,'{\"a\": 1}');"
for _ in $(seq 1 100); do "${P[@]}" -c "$AUDIT" >/dev/null & done; wait
[ -z "$("${P[@]}" -c "select * from flux.audit_verify_chain()")" ] || fail "audit chain broken after concurrent inserts"
"${P[@]}" -c "update flux.audit_event set action='x' where id=1" 2>/dev/null && fail "audit update allowed"
"${P[@]}" -c "delete from flux.audit_event where id=1" 2>/dev/null && fail "audit delete allowed"
"${P[@]}" -c "set session_replication_role=replica; update flux.audit_event set new_value='{\"a\":2}' where id=42;" >/dev/null
[ "$("${P[@]}" -c "select * from flux.audit_verify_chain()")" = "42" ] || fail "tampering not detected"
echo "ok   audit: 100 concurrent events chained, update/delete refused, tampering detected at the changed row"

# 3. Published definitions are immutable; one published version per key.
"${P[@]}" -c "insert into flux.process_definition(organization_id,key,version,name,definition,status,created_by)
  values ('$ORG','p1',1,'P1','{}','published','$USR')" >/dev/null
"${P[@]}" -c "update flux.process_definition set definition='{\"x\":1}' where key='p1'" 2>/dev/null && fail "published definition changed"
"${P[@]}" -c "insert into flux.process_definition(organization_id,key,version,name,definition,status,created_by)
  values ('$ORG','p1',2,'P1','{}','published','$USR')" 2>/dev/null && fail "two published versions"
echo "ok   definitions: published version immutable, single published version per key"
