create or replace function nexora.kick_org_member(p_actor_uid text,p_org_id text,p_target_uid text)
returns jsonb language plpgsql security definer set search_path=nexora,pg_temp as $$
declare v_org organizations%rowtype; v_actor organization_members%rowtype; v_target organization_members%rowtype; v_profile player_profiles%rowtype;
 v_actor_weight integer; v_target_weight integer;
begin
 if p_actor_uid=p_target_uid then raise exception 'INVALID_ARGUMENT'; end if;
 select * into v_org from organizations where id=p_org_id for update;
 if not found then raise exception 'NOT_FOUND'; end if;
 select * into v_actor from organization_members where org_id=p_org_id and user_id=p_actor_uid;
 if not found then raise exception 'NOT_FOUND'; end if;
 select * into v_target from organization_members where org_id=p_org_id and user_id=p_target_uid for update;
 if not found then raise exception 'NOT_FOUND'; end if;
 if v_org.leader_uid<>p_actor_uid and v_actor.role<>'deputy' and not (v_actor.permissions @> '["manage_members"]'::jsonb) then raise exception 'UNAUTHORIZED'; end if;
 v_actor_weight:=case v_actor.role when 'leader' then 4 when 'deputy' then 3 when 'officer' then 2 else 1 end;
 v_target_weight:=case v_target.role when 'leader' then 4 when 'deputy' then 3 when 'officer' then 2 else 1 end;
 if v_target.role='leader' or v_actor_weight<=v_target_weight then raise exception 'RANK_TOO_HIGH'; end if;
 select * into v_profile from player_profiles where user_id=p_target_uid for update;
 if not found or v_profile.org_id is distinct from p_org_id then raise exception 'PROFILE_MEMBERSHIP_MISMATCH'; end if;
 delete from organization_members where org_id=p_org_id and user_id=p_target_uid;
 update player_profiles set org_id=null,updated_at=now() where user_id=p_target_uid;
 update organizations set member_count=greatest(1,member_count-1),updated_at=now() where id=p_org_id;
 return jsonb_build_object('ok',true);
end $$;
revoke all on function nexora.kick_org_member(text,text,text) from public,anon,authenticated;
grant execute on function nexora.kick_org_member(text,text,text) to service_role;
