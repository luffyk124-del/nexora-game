create or replace function nexora.claim_mission_reward(p_user_id text,p_mission_id text)
returns jsonb
language plpgsql security definer set search_path=nexora,pg_temp
as $$
declare
  v_category text; v_credits integer; v_reward_xp integer; v_reward_rep integer;
  v_target integer; v_metric text; v_progress integer;
  v_level integer; v_xp bigint; v_points integer; v_rep bigint; v_influence bigint;
  v_skills jsonb; v_stats jsonb; v_leadership numeric;
  v_next_xp bigint; v_next_level integer; v_gain integer;
  v_tx_id text; v_claim_id text; v_org_id text;
begin
  if p_user_id is null or length(p_user_id)<1 then raise exception 'UNAUTHENTICATED'; end if;
  select category,reward_credits,reward_xp,reward_rep,target,metric
    into v_category,v_credits,v_reward_xp,v_reward_rep,v_target,v_metric
  from (values
    ('tut_first_trade','tutorial',450,90,10,1,'trades'),
    ('tut_first_production','tutorial',550,110,15,1,'produced'),
    ('tut_first_company','tutorial',850,160,25,1,'companies'),
    ('daily_active_trader','daily',600,120,14,3,'trades'),
    ('weekly_real_estate','weekly',950,210,28,1,'properties'),
    ('seasonal_syndicate','seasonal',1200,260,35,1,'org')
  ) as m(id,category,reward_credits,reward_xp,reward_rep,target,metric)
  where m.id=p_mission_id;
  if not found then raise exception 'INVALID_MISSION'; end if;
  select level,xp,skill_points,reputation,influence,skills,stats,org_id
    into v_level,v_xp,v_points,v_rep,v_influence,v_skills,v_stats,v_org_id
    from player_profiles where user_id=p_user_id for update;
  if not found then raise exception 'ACCOUNT_NOT_FOUND'; end if;
  if v_metric='trades' then v_progress:=coalesce((v_stats->>'tradesCount')::integer,0);
  elsif v_metric='produced' then v_progress:=coalesce((v_stats->>'totalProduced')::integer,0);
  elsif v_metric='companies' then v_progress:=coalesce((v_stats->>'companiesOwned')::integer,0);
  elsif v_metric='properties' then v_progress:=coalesce((v_stats->>'propertiesOwned')::integer,0);
  elsif v_metric='org' then v_progress:=case when v_org_id is null then 0 else 1 end;
  else v_progress:=v_level;
  end if;
  if v_progress<v_target then raise exception 'MISSION_NOT_COMPLETE'; end if;

  if exists(select 1 from player_missions where user_id=p_user_id and mission_id=p_mission_id) then
    raise exception 'MISSION_ALREADY_CLAIMED';
  end if;
  perform 1 from wallets where user_id=p_user_id for update;
  if not found then raise exception 'ACCOUNT_NOT_FOUND'; end if;

  v_leadership:=coalesce((v_skills->>'leadership')::numeric,0);
  v_gain:=v_reward_xp;
  v_next_xp:=v_xp+v_gain;
  v_next_level:=1;
  while v_next_level<100 loop
    if v_next_xp<(200+(v_next_level-1)*120) then exit; end if;
    v_next_xp:=v_next_xp-(200+(v_next_level-1)*120);
    v_next_level:=v_next_level+1;
  end loop;
  v_claim_id:=p_user_id||'_'||p_mission_id;
  v_tx_id:='mission_'||p_user_id||'_'||p_mission_id;

  insert into player_missions(user_id,mission_id,category,reward_credits,reward_xp,claimed_at)
  values(p_user_id,p_mission_id,v_category,v_credits,v_reward_xp,now());
  insert into transactions(id,from_uid,to_uid,amount,fee,net_amount,type,reference_id,description,status)
  values(v_tx_id,'SYSTEM',p_user_id,v_credits,0,v_credits,'mission_reward',v_claim_id,
         'Mission reward: '||p_mission_id,'completed');
  update wallets set balance=balance+v_credits,total_earned=total_earned+v_credits,
    last_tx_id=v_tx_id,updated_at=now() where user_id=p_user_id;
  update player_profiles set xp=xp+v_gain,level=v_next_level,
    skill_points=skill_points+greatest(0,(v_next_level-v_level)*2),
    reputation=reputation+round(v_reward_rep*(1+v_leadership*0.1))::bigint,
    influence=influence+round(5*(1+v_leadership*0.1))::bigint,
    stats=jsonb_set(v_stats,'{missionsCompleted}',to_jsonb(coalesce((v_stats->>'missionsCompleted')::integer,0)+1),true),
    updated_at=now() where user_id=p_user_id;
  insert into audit_logs(id,user_id,action,entity_type,entity_id,details)
  values('audit_'||v_tx_id,p_user_id,'mission_reward_claim','mission',p_mission_id,
         jsonb_build_object('credits',v_credits,'xp',v_reward_xp));
  return jsonb_build_object('ok',true,'credits',v_credits,'xp',v_reward_xp,'replayed',false);
end;
$$;
revoke all on function nexora.claim_mission_reward(text,text) from public,anon,authenticated;
grant execute on function nexora.claim_mission_reward(text,text) to service_role;
