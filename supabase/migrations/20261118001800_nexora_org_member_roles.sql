create or replace function nexora.update_org_member_role(p_actor_uid text,p_org_id text,p_target_uid text,p_new_role text)
returns jsonb language plpgsql security definer set search_path=nexora,pg_temp as $$
declare v_actor_role text; v_target_role text; v_permissions jsonb;
 v_actor_weight integer; v_target_weight integer;
begin
 if p_actor_uid is null or p_target_uid is null or p_org_id is null then raise exception 'INVALID_ARGUMENT'; end if;
 if p_new_role not in ('deputy','officer','member') then raise exception 'INVALID_ROLE'; end if;
 select role into v_actor_role from organization_members where org_id=p_org_id and user_id=p_actor_uid for update;
 if not found then raise exception 'UNAUTHORIZED'; end if;
 select role into v_target_role from organization_members where org_id=p_org_id and user_id=p_target_uid for update;
 if not found then raise exception 'MEMBER_NOT_FOUND'; end if;
 v_actor_weight:=case v_actor_role when 'leader' then 4 when 'deputy' then 3 when 'officer' then 2 else 1 end;
 v_target_weight:=case v_target_role when 'leader' then 4 when 'deputy' then 3 when 'officer' then 2 else 1 end;
 if v_target_role='leader' or v_actor_weight<=v_target_weight then raise exception 'UNAUTHORIZED'; end if;
 v_permissions:=case p_new_role
  when 'deputy' then '["manage_members","manage_roles","manage_treasury"]'::jsonb
  when 'officer' then '["manage_members"]'::jsonb
  else '[]'::jsonb end;
 update organization_members set role=p_new_role,permissions=v_permissions
 where org_id=p_org_id and user_id=p_target_uid;
 return jsonb_build_object('ok',true,'role',p_new_role,'permissions',v_permissions);
end $$;
revoke all on function nexora.update_org_member_role(text,text,text,text) from public,anon,authenticated;
grant execute on function nexora.update_org_member_role(text,text,text,text) to service_role;
