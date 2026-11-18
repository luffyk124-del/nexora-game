create or replace function nexora.update_player_settings(p_user_id text,p_language text,p_notifications_enabled boolean)
returns jsonb language plpgsql security definer set search_path=nexora,pg_temp as $$
begin
 if p_user_id is null then raise exception 'UNAUTHENTICATED'; end if;
 if p_language not in ('ar','en') then raise exception 'INVALID_LANGUAGE'; end if;
 if p_notifications_enabled is null then raise exception 'INVALID_ARGUMENT'; end if;
 update player_private set language=p_language,notifications_enabled=p_notifications_enabled,updated_at=now()
 where user_id=p_user_id;
 if not found then raise exception 'ACCOUNT_NOT_FOUND'; end if;
 return jsonb_build_object('ok',true,'language',p_language,'notificationsEnabled',p_notifications_enabled);
end $$;

create or replace function nexora.update_player_avatar(p_user_id text,p_avatar_id text)
returns jsonb language plpgsql security definer set search_path=nexora,pg_temp as $$
begin
 if p_user_id is null then raise exception 'UNAUTHENTICATED'; end if;
 if p_avatar_id is null or length(p_avatar_id)<1 or length(p_avatar_id)>64 or p_avatar_id !~ '^[A-Za-z0-9_-]+$' then
  raise exception 'INVALID_AVATAR';
 end if;
 update player_profiles set avatar_id=p_avatar_id,updated_at=now() where user_id=p_user_id;
 if not found then raise exception 'ACCOUNT_NOT_FOUND'; end if;
 return jsonb_build_object('ok',true,'avatarId',p_avatar_id);
end $$;

create or replace function nexora.mark_notification_read(p_user_id text,p_notification_id text)
returns jsonb language plpgsql security definer set search_path=nexora,pg_temp as $$
begin
 if p_user_id is null then raise exception 'UNAUTHENTICATED'; end if;
 update notifications set is_read=true where id=p_notification_id and user_id=p_user_id;
 if not found then raise exception 'NOTIFICATION_NOT_FOUND'; end if;
 return jsonb_build_object('ok',true);
end $$;

create or replace function nexora.mark_notifications_read(p_user_id text,p_notification_ids text[])
returns jsonb language plpgsql security definer set search_path=nexora,pg_temp as $$
declare v_count integer;
begin
 if p_user_id is null then raise exception 'UNAUTHENTICATED'; end if;
 if p_notification_ids is null or cardinality(p_notification_ids)>200 then raise exception 'INVALID_ARGUMENT'; end if;
 update notifications set is_read=true where user_id=p_user_id and id=any(p_notification_ids) and is_read=false;
 get diagnostics v_count=row_count;
 return jsonb_build_object('ok',true,'updated',v_count);
end $$;

revoke all on function nexora.update_player_settings(text,text,boolean) from public,anon,authenticated;
revoke all on function nexora.update_player_avatar(text,text) from public,anon,authenticated;
revoke all on function nexora.mark_notification_read(text,text) from public,anon,authenticated;
revoke all on function nexora.mark_notifications_read(text,text[]) from public,anon,authenticated;
grant execute on function nexora.update_player_settings(text,text,boolean) to service_role;
grant execute on function nexora.update_player_avatar(text,text) to service_role;
grant execute on function nexora.mark_notification_read(text,text) to service_role;
grant execute on function nexora.mark_notifications_read(text,text[]) to service_role;
