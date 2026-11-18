create or replace function nexora.create_player_character(
 p_user_id text,p_email text,p_username text,p_avatar_id text,p_language text
) returns jsonb language plpgsql security definer set search_path=nexora,pg_temp as $$
declare v_username text; v_lower text; v_title text;
begin
 if p_user_id is null or length(p_user_id)<1 then raise exception 'UNAUTHENTICATED'; end if;
 v_username:=trim(coalesce(p_username,''));
 if v_username !~ '^[A-Za-z0-9_]{3,24}$' then raise exception 'INVALID_USERNAME'; end if;
 v_lower:=lower(v_username);
 if p_language not in ('ar','en') then raise exception 'INVALID_LANGUAGE'; end if;
 if p_avatar_id is null or length(p_avatar_id)<1 or length(p_avatar_id)>64 or p_avatar_id !~ '^[A-Za-z0-9_-]+$' then raise exception 'INVALID_AVATAR'; end if;
 if p_email is null or length(p_email)>254 or p_email !~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$' then raise exception 'INVALID_EMAIL'; end if;
 if exists(select 1 from player_profiles where user_id=p_user_id) then raise exception 'PROFILE_EXISTS'; end if;
 v_title:=case when p_language='ar' then 'مؤسس طموح' else 'Executive Founder' end;
 insert into usernames(username_lower,uid,username) values(v_lower,p_user_id,v_username);
 insert into player_profiles(user_id,username,username_lower,avatar_id,title,level,xp,reputation,influence,skill_points,skills,stats,org_id)
 values(p_user_id,v_username,v_lower,p_avatar_id,v_title,1,0,10,5,3,
  '{"trade":0,"management":0,"industry":0,"negotiation":0,"finance":0,"leadership":0}'::jsonb,
  '{"missionsCompleted":0,"tradesCount":0,"companiesOwned":0,"propertiesOwned":0,"totalProduced":0}'::jsonb,null);
 insert into player_private(user_id,email,language,notifications_enabled)
 values(p_user_id,lower(p_email),p_language,true);
 insert into wallets(user_id,balance,total_earned,total_spent,last_tx_id)
 values(p_user_id,2500,2500,0,'init_'||p_user_id);
 insert into notifications(id,user_id,title,body,type,is_read)
 values('welcome_'||p_user_id,p_user_id,
  case when p_language='ar' then 'مرحباً بك في NEXORA' else 'Welcome to NEXORA' end,
  case when p_language='ar' then 'تم إيداع $2,500 في محفظتك وتخصيص 3 نقاط مهارة.' else '$2,500 and 3 skill points credited to your account.' end,
  'system',false);
 return jsonb_build_object('ok',true,'username',v_username,'startingCredits',2500);
exception when unique_violation then
 raise exception 'USERNAME_TAKEN';
end $$;
revoke all on function nexora.create_player_character(text,text,text,text,text) from public,anon,authenticated;
grant execute on function nexora.create_player_character(text,text,text,text,text) to service_role;
