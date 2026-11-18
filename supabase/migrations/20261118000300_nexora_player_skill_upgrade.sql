create or replace function nexora.upgrade_player_skill(p_user_id text,p_skill_key text)
returns jsonb
language plpgsql
security definer
set search_path = nexora, pg_temp
as $$
declare
  v_points integer;
  v_skills jsonb;
  v_current integer;
begin
  if p_user_id is null or length(p_user_id)<1 then raise exception 'UNAUTHENTICATED'; end if;
  if p_skill_key not in ('trade','management','industry','negotiation','finance','leadership') then
    raise exception 'INVALID_SKILL';
  end if;
  select skill_points,skills into v_points,v_skills
    from player_profiles where user_id=p_user_id for update;
  if not found then raise exception 'ACCOUNT_NOT_FOUND'; end if;
  v_current := coalesce((v_skills->>p_skill_key)::integer,0);
  if v_points<1 then raise exception 'NO_SKILL_POINTS'; end if;
  if v_current>=10 then raise exception 'SKILL_MAXED'; end if;
  update player_profiles
     set skill_points=skill_points-1,
         skills=jsonb_set(skills,array[p_skill_key],to_jsonb(v_current+1),true),
         updated_at=now()
   where user_id=p_user_id;
  insert into audit_logs(id,user_id,action,entity_type,entity_id,details)
  values ('skill_'||p_user_id||'_'||p_skill_key||'_'||(v_current+1)::text||'_'||extract(epoch from now())::bigint::text,
          p_user_id,'skill_upgrade','player_skill',p_skill_key,
          jsonb_build_object('from',v_current,'to',v_current+1));
  return jsonb_build_object('ok',true,'skillKey',p_skill_key,'level',v_current+1);
end;
$$;
revoke all on function nexora.upgrade_player_skill(text,text) from public,anon,authenticated;
grant execute on function nexora.upgrade_player_skill(text,text) to service_role;
