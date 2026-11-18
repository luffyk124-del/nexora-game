create or replace function nexora.join_organization(p_user_id text,p_org_id text)
returns jsonb language plpgsql security definer set search_path=nexora,pg_temp as $$
declare v_org organizations%rowtype; v_profile player_profiles%rowtype; v_username text; v_capacity integer; v_request_id text;
begin
 select * into v_org from organizations where id=p_org_id for update;
 if not found then raise exception 'NOT_FOUND'; end if;
 select * into v_profile from player_profiles where user_id=p_user_id for update;
 if not found then raise exception 'NOT_FOUND'; end if;
 if v_profile.org_id is not null then raise exception 'ALREADY_IN_ORG'; end if;
 if exists(select 1 from organization_members where org_id=p_org_id and user_id=p_user_id) then raise exception 'ALREADY_ORG_MEMBER'; end if;
 if v_org.join_mode='closed' then raise exception 'ORG_JOIN_CLOSED'; end if;
 v_capacity:=coalesce(v_org.member_capacity,least(70,20+(greatest(1,v_org.level)-1)*5));
 if v_org.member_count>=v_capacity then raise exception 'ORG_FULL'; end if;
 v_username:=coalesce(v_profile.username,'Player');
 if v_org.join_mode<>'open' then
  v_request_id:='join_'||p_org_id||'_'||p_user_id;
  if exists(select 1 from organization_requests where id=v_request_id and status='pending') then raise exception 'REQUEST_ALREADY_PENDING'; end if;
  insert into organization_requests(id,org_id,user_id,username,status)
  values(v_request_id,p_org_id,p_user_id,v_username,'pending')
  on conflict(id) do update set status='pending',updated_at=now();
  return jsonb_build_object('ok',true,'status','requested');
 end if;
 insert into organization_members(org_id,user_id,username,role,permissions)
 values(p_org_id,p_user_id,v_username,'member','[]'::jsonb);
 update player_profiles set org_id=p_org_id,updated_at=now() where user_id=p_user_id;
 update organizations set member_count=member_count+1,updated_at=now() where id=p_org_id;
 return jsonb_build_object('ok',true,'status','joined');
end $$;

create or replace function nexora.leave_organization(p_user_id text,p_org_id text)
returns jsonb language plpgsql security definer set search_path=nexora,pg_temp as $$
declare v_org organizations%rowtype; v_member organization_members%rowtype; v_profile player_profiles%rowtype;
begin
 select * into v_org from organizations where id=p_org_id for update;
 if not found then raise exception 'NOT_FOUND'; end if;
 select * into v_member from organization_members where org_id=p_org_id and user_id=p_user_id for update;
 if not found then raise exception 'NOT_FOUND'; end if;
 select * into v_profile from player_profiles where user_id=p_user_id for update;
 if not found then raise exception 'NOT_FOUND'; end if;
 if v_profile.org_id<>p_org_id then raise exception 'MEMBERSHIP_MISMATCH'; end if;
 if v_member.role='leader' or v_org.leader_uid=p_user_id then raise exception 'LEADER_CANNOT_LEAVE'; end if;
 delete from organization_members where org_id=p_org_id and user_id=p_user_id;
 update player_profiles set org_id=null,updated_at=now() where user_id=p_user_id;
 update organizations set member_count=greatest(1,member_count-1),updated_at=now() where id=p_org_id;
 return jsonb_build_object('ok',true);
end $$;

create or replace function nexora.handle_org_join_request(p_actor_uid text,p_org_id text,p_request_id text,p_applicant_uid text,p_decision text)
returns jsonb language plpgsql security definer set search_path=nexora,pg_temp as $$
declare v_org organizations%rowtype; v_actor organization_members%rowtype; v_req organization_requests%rowtype;
 v_profile player_profiles%rowtype; v_capacity integer;
begin
 if p_decision not in ('approved','rejected') then raise exception 'INVALID_ARGUMENT'; end if;
 select * into v_org from organizations where id=p_org_id for update;
 if not found then raise exception 'NOT_FOUND'; end if;
 select * into v_actor from organization_members where org_id=p_org_id and user_id=p_actor_uid;
 if not found then raise exception 'NOT_FOUND'; end if;
 if v_org.leader_uid<>p_actor_uid and v_actor.role<>'deputy'
   and not (v_actor.permissions @> '["manage_members"]'::jsonb) then raise exception 'UNAUTHORIZED'; end if;
 select * into v_req from organization_requests where id=p_request_id and org_id=p_org_id and user_id=p_applicant_uid for update;
 if not found then raise exception 'NOT_FOUND'; end if;
 if v_req.status<>'pending' then raise exception 'REQUEST_ALREADY_HANDLED'; end if;
 if p_decision='rejected' then
  update organization_requests set status='rejected',updated_at=now() where id=p_request_id;
  return jsonb_build_object('ok',true,'status','rejected');
 end if;
 select * into v_profile from player_profiles where user_id=p_applicant_uid for update;
 if not found then raise exception 'APPLICANT_NOT_FOUND'; end if;
 if exists(select 1 from organization_members where org_id=p_org_id and user_id=p_applicant_uid) then raise exception 'ALREADY_ORG_MEMBER'; end if;
 if v_profile.org_id is not null then raise exception 'APPLICANT_IN_OTHER_ORG'; end if;
 v_capacity:=coalesce(v_org.member_capacity,least(70,20+(greatest(1,v_org.level)-1)*5));
 if v_org.member_count>=v_capacity then raise exception 'ORG_FULL'; end if;
 insert into organization_members(org_id,user_id,username,role,permissions)
 values(p_org_id,p_applicant_uid,coalesce(v_profile.username,'Player'),'member','[]'::jsonb);
 update player_profiles set org_id=p_org_id,updated_at=now() where user_id=p_applicant_uid;
 update organization_requests set status='approved',updated_at=now() where id=p_request_id;
 update organizations set member_count=member_count+1,updated_at=now() where id=p_org_id;
 return jsonb_build_object('ok',true,'status','approved');
end $$;

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
 if v_org.leader_uid<>p_actor_uid and v_actor.role<>'deputy'
   and not (v_actor.permissions @> '["manage_members"]'::jsonb) then raise exception 'UNAUTHORIZED'; end if;
 v_actor_weight:=case v_actor.role when 'leader' then 4 when 'deputy' then 3 when 'officer' then 2 else 1 end;
 v_target_weight:=case v_target.role when 'leader' then 4 when 'deputy' then 3 when 'officer' then 2 else 1 end;
 if v_target.role='leader' or v_actor_weight<=v_target_weight then raise exception 'RANK_TOO_HIGH'; end if;
 select * into v_profile from player_profiles where user_id=p_target_uid for update;
 if not found or v_profile.org_id<>p_org_id then raise exception 'PROFILE_MEMBERSHIP_MISMATCH'; end if;
 delete from organization_members where org_id=p_org_id and user_id=p_target_uid;
 update player_profiles set org_id=null,updated_at=now() where user_id=p_target_uid;
 update organizations set member_count=greatest(1,member_count-1),updated_at=now() where id=p_org_id;
 return jsonb_build_object('ok',true);
end $$;

create or replace function nexora.set_org_join_mode(p_actor_uid text,p_org_id text,p_mode text)
returns jsonb language plpgsql security definer set search_path=nexora,pg_temp as $$
declare v_org organizations%rowtype; v_member organization_members%rowtype;
begin
 if p_mode not in ('open','request','closed') then raise exception 'INVALID_ARGUMENT'; end if;
 select * into v_org from organizations where id=p_org_id for update;
 if not found then raise exception 'NOT_FOUND'; end if;
 select * into v_member from organization_members where org_id=p_org_id and user_id=p_actor_uid;
 if not found then raise exception 'NOT_FOUND'; end if;
 if v_org.leader_uid<>p_actor_uid and v_member.role<>'deputy'
   and not (v_member.permissions @> '["manage_org"]'::jsonb) then raise exception 'PERMISSION_DENIED'; end if;
 update organizations set join_mode=p_mode,updated_at=now() where id=p_org_id;
 return jsonb_build_object('ok',true,'mode',p_mode);
end $$;

revoke all on function nexora.join_organization(text,text) from public,anon,authenticated;
revoke all on function nexora.leave_organization(text,text) from public,anon,authenticated;
revoke all on function nexora.handle_org_join_request(text,text,text,text,text) from public,anon,authenticated;
revoke all on function nexora.kick_org_member(text,text,text) from public,anon,authenticated;
revoke all on function nexora.set_org_join_mode(text,text,text) from public,anon,authenticated;
grant execute on function nexora.join_organization(text,text) to service_role;
grant execute on function nexora.leave_organization(text,text) to service_role;
grant execute on function nexora.handle_org_join_request(text,text,text,text,text) to service_role;
grant execute on function nexora.kick_org_member(text,text,text) to service_role;
grant execute on function nexora.set_org_join_mode(text,text,text) to service_role;
