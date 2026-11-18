create or replace function nexora.set_player_report_status(
  p_report_id text,
  p_status text,
  p_actor_uid text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, nexora
as $$
declare
  v_report_id text;
begin
  if p_report_id is null or length(p_report_id) = 0 or length(p_report_id) > 180 then
    raise exception 'INVALID_REPORT_ID';
  end if;
  if p_status is null or p_status not in ('open', 'reviewing', 'closed') then
    raise exception 'INVALID_REPORT_STATUS';
  end if;
  if p_actor_uid is null or length(p_actor_uid) = 0 or length(p_actor_uid) > 180 then
    raise exception 'INVALID_ACTOR_UID';
  end if;

  update nexora.player_reports
     set status = p_status,
         reviewed_by = p_actor_uid,
         reviewed_at = pg_catalog.now()
   where id = p_report_id
   returning id into v_report_id;

  if v_report_id is null then
    return false;
  end if;

  insert into nexora.player_report_audit
    (id, report_id, actor_uid, action, new_status, created_at)
  values
    (pg_catalog.gen_random_uuid()::text, v_report_id, p_actor_uid,
     'status_changed', p_status, pg_catalog.now());

  return true;
end;
$$;

revoke all on function nexora.set_player_report_status(text, text, text) from public;
revoke all on function nexora.set_player_report_status(text, text, text) from anon, authenticated;
grant execute on function nexora.set_player_report_status(text, text, text) to service_role;
