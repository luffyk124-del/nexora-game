-- NEXORA social and messaging server-side workflows.
create or replace function nexora.get_public_player_profile(p_target_uid text)
returns jsonb language plpgsql security definer set search_path=nexora,pg_temp as $$
declare v_profile player_profiles%rowtype;
begin
 if p_target_uid is null or length(p_target_uid)>128 then raise exception 'INVALID_TARGET'; end if;
 select * into v_profile from player_profiles where user_id=p_target_uid;
 if not found then raise exception 'PLAYER_NOT_FOUND'; end if;
 return jsonb_build_object('uid',v_profile.user_id,'username',v_profile.username,'avatarId',v_profile.avatar_id,
  'title',v_profile.title,'level',v_profile.level,'reputation',v_profile.reputation,
  'influence',v_profile.influence,'orgId',v_profile.org_id);
end $$;

create or replace function nexora.search_players(p_user_id text,p_prefix text)
returns jsonb language plpgsql security definer set search_path=nexora,pg_temp as $$
declare v_prefix text; v_players jsonb;
begin
 if p_user_id is null then raise exception 'UNAUTHENTICATED'; end if;
 v_prefix:=lower(trim(coalesce(p_prefix,'')));
 if length(v_prefix)<2 or length(v_prefix)>24 or v_prefix !~ '^[a-z0-9_]+$' then
  return jsonb_build_object('players','[]'::jsonb);
 end if;
 select coalesce(jsonb_agg(jsonb_build_object(
  'uid',q.user_id,'username',q.username,'avatarId',q.avatar_id,'title',q.title,
  'level',q.level,'reputation',q.reputation,'influence',q.influence,'orgId',q.org_id
 ) order by q.username_lower),'[]'::jsonb) into v_players
 from (select user_id,username,username_lower,avatar_id,title,level,reputation,influence,org_id
  from player_profiles where username_lower like v_prefix||'%' and user_id<>p_user_id
  order by username_lower limit 15) q;
 return jsonb_build_object('players',v_players);
end $$;

create or replace function nexora.block_player(p_user_id text,p_target_uid text)
returns jsonb language plpgsql security definer set search_path=nexora,pg_temp as $$
begin
 if p_user_id is null then raise exception 'UNAUTHENTICATED'; end if;
 if p_target_uid is null or p_target_uid=p_user_id or length(p_target_uid)>128 then raise exception 'INVALID_TARGET'; end if;
 if not exists(select 1 from player_profiles where user_id=p_user_id) or
    not exists(select 1 from player_profiles where user_id=p_target_uid) then raise exception 'PLAYER_NOT_FOUND'; end if;
 insert into user_blocks(id,owner_uid,target_uid,created_at)
 values(p_user_id||'__'||p_target_uid,p_user_id,p_target_uid,now())
 on conflict(id) do nothing;
 return jsonb_build_object('ok',true);
end $$;

create or replace function nexora.unblock_player(p_user_id text,p_target_uid text)
returns jsonb language plpgsql security definer set search_path=nexora,pg_temp as $$
begin
 if p_user_id is null then raise exception 'UNAUTHENTICATED'; end if;
 if p_target_uid is null or p_target_uid=p_user_id or length(p_target_uid)>128 then raise exception 'INVALID_TARGET'; end if;
 delete from user_blocks where owner_uid=p_user_id and target_uid=p_target_uid;
 return jsonb_build_object('ok',true);
end $$;

create or replace function nexora.submit_player_report(p_user_id text,p_target_uid text,p_reason text,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=nexora,pg_temp as $$
declare v_report_id text; v_rate_id text;
begin
 if p_user_id is null or p_request_id is null then raise exception 'INVALID_REQUEST'; end if;
 if p_target_uid is null or p_target_uid=p_user_id or length(p_target_uid)>128 or
  p_reason not in ('harassment','spam','inappropriate','impersonation','other') then raise exception 'INVALID_REPORT'; end if;
 v_report_id:='report_'||p_user_id||'_'||p_request_id::text;
 if exists(select 1 from player_reports where id=v_report_id and reporter_uid=p_user_id) then
  return jsonb_build_object('ok',true,'replayed',true);
 end if;
 if not exists(select 1 from player_profiles where user_id=p_user_id) or
    not exists(select 1 from player_profiles where user_id=p_target_uid) then raise exception 'PLAYER_NOT_FOUND'; end if;
 insert into chat_rate_limits(id,last_sent_at) values('report_'||p_user_id,now())
 on conflict(id) do update set last_sent_at=excluded.last_sent_at
 where chat_rate_limits.last_sent_at is null or chat_rate_limits.last_sent_at<=now()-interval '30 seconds'
 returning id into v_rate_id;
 if v_rate_id is null then raise exception 'REPORT_RATE_LIMIT'; end if;
 insert into player_reports(id,reporter_uid,target_uid,reason,status,created_at)
 values(v_report_id,p_user_id,p_target_uid,p_reason,'open',now());
 return jsonb_build_object('ok',true,'replayed',false);
end $$;

create or replace function nexora.open_direct_conversation(p_user_id text,p_target_uid text)
returns jsonb language plpgsql security definer set search_path=nexora,pg_temp as $$
declare v_sender player_profiles%rowtype; v_target player_profiles%rowtype;
 v_participants text[]; v_id text; v_existing text[];
begin
 if p_user_id is null then raise exception 'UNAUTHENTICATED'; end if;
 if p_target_uid is null or p_target_uid=p_user_id or length(p_target_uid)>128 then raise exception 'INVALID_TARGET'; end if;
 select * into v_sender from player_profiles where user_id=p_user_id;
 select * into v_target from player_profiles where user_id=p_target_uid;
 if v_sender.user_id is null or v_target.user_id is null then raise exception 'PLAYER_NOT_FOUND'; end if;
 if exists(select 1 from user_blocks where (owner_uid=p_user_id and target_uid=p_target_uid)
  or (owner_uid=p_target_uid and target_uid=p_user_id)) then raise exception 'PLAYER_BLOCKED'; end if;
 select array_agg(x order by x) into v_participants from unnest(array[p_user_id,p_target_uid]) x;
 v_id:='dm_'||array_to_string(v_participants,'_');
 insert into conversations(id,participants,participant_names,participant_avatars,last_message,last_message_at,last_sender_uid,created_at,updated_at)
 values(v_id,v_participants,
  jsonb_build_object(p_user_id,v_sender.username,p_target_uid,v_target.username),
  jsonb_build_object(p_user_id,v_sender.avatar_id,p_target_uid,v_target.avatar_id),
  '',now(),' ',now(),now())
 on conflict(id) do nothing;
 select participants into v_existing from conversations where id=v_id;
 if v_existing is distinct from v_participants then raise exception 'CONVERSATION_ACCESS_DENIED'; end if;
 return jsonb_build_object('conversationId',v_id);
end $$;

create or replace function nexora.send_direct_message(p_user_id text,p_target_uid text,p_text text,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=nexora,pg_temp as $$
declare v_sender player_profiles%rowtype; v_target player_profiles%rowtype;
 v_participants text[]; v_conversation_id text; v_message_id text; v_text text; v_rate_id text;
begin
 if p_user_id is null or p_request_id is null then raise exception 'INVALID_REQUEST'; end if;
 if p_target_uid is null or p_target_uid=p_user_id or length(p_target_uid)>128 then raise exception 'INVALID_TARGET'; end if;
 v_text:=left(trim(regexp_replace(regexp_replace(coalesce(p_text,''),'[<>]','','g'), '[[:space:]]+',' ','g')),1000);
 if v_text='' then raise exception 'INVALID_MESSAGE'; end if;
 v_message_id:='msg_'||p_user_id||'_'||p_request_id::text;
 if exists(select 1 from conversation_messages where id=v_message_id and sender_uid=p_user_id) then
  return jsonb_build_object('ok',true,'replayed',true);
 end if;
 select * into v_sender from player_profiles where user_id=p_user_id;
 select * into v_target from player_profiles where user_id=p_target_uid;
 if v_sender.user_id is null or v_target.user_id is null then raise exception 'PLAYER_NOT_FOUND'; end if;
 if exists(select 1 from user_blocks where (owner_uid=p_user_id and target_uid=p_target_uid)
  or (owner_uid=p_target_uid and target_uid=p_user_id)) then raise exception 'PLAYER_BLOCKED'; end if;
 select array_agg(x order by x) into v_participants from unnest(array[p_user_id,p_target_uid]) x;
 v_conversation_id:='dm_'||array_to_string(v_participants,'_');
 insert into conversations(id,participants,participant_names,participant_avatars,last_message,last_message_at,last_sender_uid,created_at,updated_at)
 values(v_conversation_id,v_participants,
  jsonb_build_object(p_user_id,v_sender.username,p_target_uid,v_target.username),
  jsonb_build_object(p_user_id,v_sender.avatar_id,p_target_uid,v_target.avatar_id),
  '',now(),' ',now(),now())
 on conflict(id) do nothing;
 if not exists(select 1 from conversations where id=v_conversation_id and participants=v_participants) then
  raise exception 'CONVERSATION_ACCESS_DENIED';
 end if;
 insert into chat_rate_limits(id,last_sent_at) values('dm_'||p_user_id,now())
 on conflict(id) do update set last_sent_at=excluded.last_sent_at
 where chat_rate_limits.last_sent_at is null or chat_rate_limits.last_sent_at<=now()-interval '1 second'
 returning id into v_rate_id;
 if v_rate_id is null then raise exception 'CHAT_RATE_LIMIT'; end if;
 update conversations set last_message=left(v_text,120),last_message_at=now(),
  last_sender_uid=p_user_id,updated_at=now() where id=v_conversation_id;
 insert into conversation_messages(id,conversation_id,sender_uid,sender_name,message_text,created_at)
 values(v_message_id,v_conversation_id,p_user_id,coalesce(nullif(v_sender.username,''),'Player'),v_text,now());
 return jsonb_build_object('ok',true,'replayed',false);
end $$;

create or replace function nexora.send_global_chat_message(p_user_id text,p_text text,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=nexora,pg_temp as $$
declare v_profile player_profiles%rowtype; v_text text; v_message_id text; v_rate_id text;
begin
 if p_user_id is null or p_request_id is null then raise exception 'INVALID_REQUEST'; end if;
 v_text:=left(trim(regexp_replace(regexp_replace(coalesce(p_text,''),'[<>]','','g'), '[[:space:]]+',' ','g')),280);
 if v_text='' then raise exception 'EMPTY_MESSAGE'; end if;
 v_message_id:='gmsg_'||p_user_id||'_'||p_request_id::text;
 if exists(select 1 from global_chat_messages where id=v_message_id and sender_uid=p_user_id) then
  return jsonb_build_object('ok',true,'replayed',true);
 end if;
 select * into v_profile from player_profiles where user_id=p_user_id;
 if not found then raise exception 'PROFILE_NOT_FOUND'; end if;
 insert into chat_rate_limits(id,last_sent_at) values('global_'||p_user_id,now())
 on conflict(id) do update set last_sent_at=excluded.last_sent_at
 where chat_rate_limits.last_sent_at is null or chat_rate_limits.last_sent_at<=now()-interval '3 seconds'
 returning id into v_rate_id;
 if v_rate_id is null then raise exception 'CHAT_RATE_LIMIT'; end if;
 insert into global_chat_messages(id,sender_uid,sender_name,avatar_id,message_text,created_at)
 values(v_message_id,p_user_id,coalesce(nullif(v_profile.username,''),'Player'),
  coalesce(nullif(v_profile.avatar_id,''),'default'),v_text,now());
 return jsonb_build_object('ok',true,'replayed',false);
end $$;

create or replace function nexora.invite_player_to_organization(p_user_id text,p_target_uid text)
returns jsonb language plpgsql security definer set search_path=nexora,pg_temp as $$
declare v_inviter player_profiles%rowtype; v_target player_profiles%rowtype;
 v_org organizations%rowtype; v_member organization_members%rowtype; v_invite_id text; v_inserted text;
begin
 if p_user_id is null then raise exception 'UNAUTHENTICATED'; end if;
 if p_target_uid is null or p_target_uid=p_user_id or length(p_target_uid)>128 then raise exception 'INVALID_TARGET'; end if;
 select * into v_inviter from player_profiles where user_id=p_user_id for update;
 if not found then raise exception 'PROFILE_NOT_FOUND'; end if;
 if v_inviter.org_id is null then raise exception 'NOT_IN_ORG'; end if;
 select * into v_org from organizations where id=v_inviter.org_id for update;
 if not found then raise exception 'NOT_FOUND'; end if;
 select * into v_member from organization_members where org_id=v_org.id and user_id=p_user_id;
 if not found then raise exception 'NOT_FOUND'; end if;
 if v_member.role not in ('leader','deputy') and not (v_member.permissions @> '["manage_members"]'::jsonb) then
  raise exception 'INVITE_PERMISSION_REQUIRED';
 end if;
 select * into v_target from player_profiles where user_id=p_target_uid for update;
 if not found then raise exception 'PLAYER_NOT_FOUND'; end if;
 if v_target.org_id is not null then raise exception 'TARGET_ALREADY_IN_ORG'; end if;
 v_invite_id:=v_org.id||'_'||p_target_uid;
 insert into organization_invites(id,org_id,org_name,org_tag,target_uid,inviter_uid,inviter_name,status,created_at)
 values(v_invite_id,v_org.id,v_org.name,v_org.tag,p_target_uid,p_user_id,
  coalesce(nullif(v_inviter.username,''),'Player'),'pending',now())
 on conflict(id) do update set org_id=excluded.org_id,org_name=excluded.org_name,org_tag=excluded.org_tag,
  target_uid=excluded.target_uid,inviter_uid=excluded.inviter_uid,inviter_name=excluded.inviter_name,
  status='pending',created_at=now(),responded_at=null
 where organization_invites.status<>'pending'
 returning id into v_inserted;
 if v_inserted is null then raise exception 'INVITE_ALREADY_PENDING'; end if;
 return jsonb_build_object('ok',true);
end $$;

create or replace function nexora.respond_organization_invite(p_user_id text,p_invite_id text,p_response text)
returns jsonb language plpgsql security definer set search_path=nexora,pg_temp as $$
declare v_invite organization_invites%rowtype; v_org organizations%rowtype;
 v_profile player_profiles%rowtype; v_existing organization_members%rowtype; v_capacity integer;
begin
 if p_user_id is null then raise exception 'UNAUTHENTICATED'; end if;
 if p_invite_id is null or length(p_invite_id)>180 or p_response not in ('accept','decline') then raise exception 'INVALID_ARGUMENT'; end if;
 select * into v_invite from organization_invites where id=p_invite_id for update;
 if not found then raise exception 'INVITE_NOT_FOUND'; end if;
 if v_invite.target_uid<>p_user_id or v_invite.status<>'pending' then raise exception 'INVITE_NOT_AVAILABLE'; end if;
 if p_response='decline' then
  update organization_invites set status='rejected',responded_at=now() where id=p_invite_id;
  return jsonb_build_object('ok',true,'status','rejected');
 end if;
 select * into v_org from organizations where id=v_invite.org_id for update;
 if not found then raise exception 'ORG_NOT_FOUND'; end if;
 select * into v_profile from player_profiles where user_id=p_user_id for update;
 if not found then raise exception 'PROFILE_NOT_FOUND'; end if;
 select * into v_existing from organization_members where org_id=v_invite.org_id and user_id=p_user_id for update;
 if found or v_profile.org_id is not null then raise exception 'ALREADY_IN_ORG'; end if;
 v_capacity:=coalesce(v_org.member_capacity,least(70,20+(greatest(1,v_org.level)-1)*5));
 if v_org.member_count>=v_capacity then raise exception 'ORG_FULL'; end if;
 insert into organization_members(org_id,user_id,username,role,permissions,joined_at)
 values(v_invite.org_id,p_user_id,coalesce(nullif(v_profile.username,''),'Player'),'member','[]'::jsonb,now());
 update player_profiles set org_id=v_invite.org_id,updated_at=now() where user_id=p_user_id;
 update organizations set member_count=member_count+1,updated_at=now() where id=v_invite.org_id;
 update organization_invites set status='accepted',responded_at=now() where id=p_invite_id;
 return jsonb_build_object('ok',true,'status','accepted');
end $$;

revoke all on function nexora.get_public_player_profile(text) from public,anon,authenticated;
revoke all on function nexora.search_players(text,text) from public,anon,authenticated;
revoke all on function nexora.block_player(text,text) from public,anon,authenticated;
revoke all on function nexora.unblock_player(text,text) from public,anon,authenticated;
revoke all on function nexora.submit_player_report(text,text,text,uuid) from public,anon,authenticated;
revoke all on function nexora.open_direct_conversation(text,text) from public,anon,authenticated;
revoke all on function nexora.send_direct_message(text,text,text,uuid) from public,anon,authenticated;
revoke all on function nexora.send_global_chat_message(text,text,uuid) from public,anon,authenticated;
revoke all on function nexora.invite_player_to_organization(text,text) from public,anon,authenticated;
revoke all on function nexora.respond_organization_invite(text,text,text) from public,anon,authenticated;
grant execute on function nexora.get_public_player_profile(text) to service_role;
grant execute on function nexora.search_players(text,text) to service_role;
grant execute on function nexora.block_player(text,text) to service_role;
grant execute on function nexora.unblock_player(text,text) to service_role;
grant execute on function nexora.submit_player_report(text,text,text,uuid) to service_role;
grant execute on function nexora.open_direct_conversation(text,text) to service_role;
grant execute on function nexora.send_direct_message(text,text,text,uuid) to service_role;
grant execute on function nexora.send_global_chat_message(text,text,uuid) to service_role;
grant execute on function nexora.invite_player_to_organization(text,text) to service_role;
grant execute on function nexora.respond_organization_invite(text,text,text) to service_role;
