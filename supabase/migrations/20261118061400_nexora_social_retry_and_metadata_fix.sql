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
  '',now(),'',now(),now())
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
 select * into v_sender from player_profiles where user_id=p_user_id;
 select * into v_target from player_profiles where user_id=p_target_uid;
 if v_sender.user_id is null or v_target.user_id is null then raise exception 'PLAYER_NOT_FOUND'; end if;
 if exists(select 1 from user_blocks where (owner_uid=p_user_id and target_uid=p_target_uid)
  or (owner_uid=p_target_uid and target_uid=p_user_id)) then raise exception 'PLAYER_BLOCKED'; end if;
 select array_agg(x order by x) into v_participants from unnest(array[p_user_id,p_target_uid]) x;
 v_conversation_id:='dm_'||array_to_string(v_participants,'_');
 if exists(select 1 from conversation_messages where id=v_message_id) then
  if exists(select 1 from conversation_messages where id=v_message_id and sender_uid=p_user_id and conversation_id=v_conversation_id) then
   return jsonb_build_object('ok',true,'replayed',true);
  end if;
  raise exception 'REQUEST_ID_CONFLICT';
 end if;
 insert into conversations(id,participants,participant_names,participant_avatars,last_message,last_message_at,last_sender_uid,created_at,updated_at)
 values(v_conversation_id,v_participants,
  jsonb_build_object(p_user_id,v_sender.username,p_target_uid,v_target.username),
  jsonb_build_object(p_user_id,v_sender.avatar_id,p_target_uid,v_target.avatar_id),
  '',now(),'',now(),now())
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

revoke all on function nexora.open_direct_conversation(text,text) from public,anon,authenticated;
revoke all on function nexora.send_direct_message(text,text,text,uuid) from public,anon,authenticated;
grant execute on function nexora.open_direct_conversation(text,text) to service_role;
grant execute on function nexora.send_direct_message(text,text,text,uuid) to service_role;
