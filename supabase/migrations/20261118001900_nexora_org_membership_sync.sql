create or replace function nexora.sync_self_org_membership(p_user_id text,p_org_id text)
returns jsonb language plpgsql security definer set search_path=nexora,pg_temp as $$
begin
 if p_user_id is null then raise exception 'UNAUTHENTICATED'; end if;
 if p_org_id is not null and not exists(select 1 from organization_members where org_id=p_org_id and user_id=p_user_id) then
  raise exception 'UNAUTHORIZED';
 end if;
 update player_profiles set org_id=p_org_id,updated_at=now() where user_id=p_user_id;
 if not found then raise exception 'ACCOUNT_NOT_FOUND'; end if;
 return jsonb_build_object('ok',true,'orgId',p_org_id);
end $$;
revoke all on function nexora.sync_self_org_membership(text,text) from public,anon,authenticated;
grant execute on function nexora.sync_self_org_membership(text,text) to service_role;
