create or replace function nexora.start_company_upgrade(p_user_id text,p_company_id text,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=nexora,pg_temp as $$
declare v_company companies%rowtype; v_balance numeric; v_cost integer; v_target integer; v_now bigint; v_ends bigint; v_tx text; v_log text;
begin
 if p_user_id is null or p_request_id is null then raise exception 'INVALID_REQUEST'; end if;
 v_tx:='company_upgrade_'||p_user_id||'_'||p_request_id::text;
 if exists(select 1 from transactions where id=v_tx and from_uid=p_user_id and type='company_upgrade') then
  return jsonb_build_object('ok',true,'replayed',true);
 end if;
 select * into v_company from companies where id=p_company_id for update;
 if not found then raise exception 'COMPANY_NOT_FOUND'; end if;
 if v_company.owner_uid<>p_user_id then raise exception 'UNAUTHORIZED'; end if;
 if v_company.auction_id is not null then raise exception 'COMPANY_IN_AUCTION'; end if;
 if v_company.level>=100 then raise exception 'MAX_LEVEL'; end if;
 if coalesce(v_company.level_upgrade_ends_at,0)>floor(extract(epoch from now())*1000)::bigint then raise exception 'UPGRADE_IN_PROGRESS'; end if;
 v_cost:=v_company.level*550; v_target:=v_company.level+1;
 select balance into v_balance from wallets where user_id=p_user_id for update;
 if not found then raise exception 'ACCOUNT_NOT_FOUND'; end if;
 if v_balance<v_cost then raise exception 'INSUFFICIENT_FUNDS'; end if;
 v_now:=floor(extract(epoch from now())*1000)::bigint;
 if v_target<=50 then
  v_ends:=v_now+greatest(1000,round(2000*power(43200::numeric,(v_target-2)::numeric/48))::bigint);
 else
  v_ends:=v_now+greatest(1000,round(86400000*power(15::numeric,(v_target-50)::numeric/50))::bigint);
 end if;
 v_log:='clog_'||v_tx;
 update wallets set balance=balance-v_cost,total_spent=total_spent+v_cost,last_tx_id=v_tx,updated_at=now() where user_id=p_user_id;
 update companies set level_upgrade_started_at=v_now,level_upgrade_ends_at=v_ends,
  level_upgrade_target_level=v_target,level_upgrade_cost=v_cost,updated_at=now() where id=p_company_id;
 insert into transactions(id,from_uid,to_uid,amount,fee,net_amount,type,reference_id,description,status)
 values(v_tx,p_user_id,'SYSTEM',v_cost,0,v_cost,'company_upgrade',p_company_id,
  'Started upgrade of '||v_company.name||' to Lv.'||v_target::text,'completed');
 insert into company_logs(id,company_id,owner_uid,action,amount,details)
 values(v_log,p_company_id,p_user_id,'upgrade_started',-v_cost,'Started upgrade to Level '||v_target::text);
 return jsonb_build_object('ok',true,'targetLevel',v_target,'endsAt',v_ends,'replayed',false);
end $$;

create or replace function nexora.complete_company_upgrade(p_user_id text,p_company_id text)
returns jsonb language plpgsql security definer set search_path=nexora,pg_temp as $$
declare v_company companies%rowtype; v_profile player_profiles%rowtype; v_now bigint; v_target integer; v_next_xp bigint; v_next_level integer; v_log text; v_cost integer;
begin
 if p_user_id is null then raise exception 'UNAUTHENTICATED'; end if;
 select * into v_company from companies where id=p_company_id for update;
 if not found then raise exception 'COMPANY_NOT_FOUND'; end if;
 if v_company.owner_uid<>p_user_id then raise exception 'UNAUTHORIZED'; end if;
 if v_company.auction_id is not null then raise exception 'COMPANY_IN_AUCTION'; end if;
 v_now:=floor(extract(epoch from now())*1000)::bigint;
 if coalesce(v_company.level_upgrade_ends_at,0)=0 or coalesce(v_company.level_upgrade_target_level,0)=0 then raise exception 'NO_UPGRADE_IN_PROGRESS'; end if;
 if v_now<v_company.level_upgrade_ends_at then raise exception 'UPGRADE_NOT_FINISHED'; end if;
 v_target:=v_company.level_upgrade_target_level;
 if v_target<>v_company.level+1 or v_target>100 then raise exception 'INVALID_UPGRADE_STATE'; end if;
 select * into v_profile from player_profiles where user_id=p_user_id for update;
 if not found then raise exception 'ACCOUNT_NOT_FOUND'; end if;
 v_next_xp:=v_profile.xp+75; v_next_level:=1;
 while v_next_level<100 loop
  if v_next_xp<(200+(v_next_level-1)*120) then exit; end if;
  v_next_xp:=v_next_xp-(200+(v_next_level-1)*120); v_next_level:=v_next_level+1;
 end loop;
 v_cost:=coalesce(v_company.level_upgrade_cost,0);
 update companies set level=v_target,capital=capital+v_cost,
  level_upgrade_started_at=null,level_upgrade_ends_at=null,level_upgrade_target_level=null,level_upgrade_cost=null,
  updated_at=now() where id=p_company_id;
 update player_profiles set xp=xp+75,level=v_next_level,
  skill_points=skill_points+greatest(0,(v_next_level-v_profile.level)*2),updated_at=now()
 where user_id=p_user_id;
 v_log:='clog_company_complete_'||p_company_id||'_'||v_target::text;
 insert into company_logs(id,company_id,owner_uid,action,amount,details)
 values(v_log,p_company_id,p_user_id,'upgrade_completed',0,'Company reached Level '||v_target::text);
 return jsonb_build_object('ok',true,'level',v_target);
end $$;

revoke all on function nexora.start_company_upgrade(text,text,uuid) from public,anon,authenticated;
revoke all on function nexora.complete_company_upgrade(text,text) from public,anon,authenticated;
grant execute on function nexora.start_company_upgrade(text,text,uuid) to service_role;
grant execute on function nexora.complete_company_upgrade(text,text) to service_role;
