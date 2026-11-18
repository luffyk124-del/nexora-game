create or replace function nexora.collect_company_revenue(p_user_id text,p_company_id text,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=nexora,pg_temp as $$
declare
 v_company companies%rowtype; v_profile player_profiles%rowtype; v_wallet_balance numeric;
 v_now timestamptz:=now(); v_last timestamptz; v_net numeric; v_gross numeric; v_expense numeric;
 v_level_mult numeric; v_staff_bonus numeric; v_mgmt numeric; v_finance numeric; v_leadership numeric;
 v_rep_bonus numeric; v_event_mult numeric; v_commerce integer:=0; v_vault_level integer;
 v_capacity numeric; v_stored numeric; v_elapsed numeric; v_payout integer; v_xp_gain integer;
 v_next_xp bigint; v_next_level integer; v_tx text; v_log text;
begin
 if p_user_id is null or p_request_id is null then raise exception 'INVALID_REQUEST'; end if;
 v_tx:='company_collect_'||p_user_id||'_'||p_request_id::text;
 if exists(select 1 from transactions where id=v_tx and to_uid=p_user_id and type='company_collect') then
  return jsonb_build_object('ok',true,'payout',(select amount from transactions where id=v_tx),'replayed',true);
 end if;
 select * into v_company from companies where id=p_company_id for update;
 if not found then raise exception 'COMPANY_NOT_FOUND'; end if;
 if v_company.owner_uid<>p_user_id then raise exception 'UNAUTHORIZED'; end if;
 if v_company.auction_id is not null then raise exception 'COMPANY_IN_AUCTION'; end if;
 select * into v_profile from player_profiles where user_id=p_user_id for update;
 if not found then raise exception 'ACCOUNT_NOT_FOUND'; end if;
 select balance into v_wallet_balance from wallets where user_id=p_user_id for update;
 if not found then raise exception 'ACCOUNT_NOT_FOUND'; end if;
 v_last:=coalesce(v_company.last_collected_at,v_now);
 if v_now-v_last<interval '30 seconds' then raise exception 'NOTHING_TO_COLLECT'; end if;

 v_mgmt:=greatest(0,coalesce((v_profile.skills->>'management')::numeric,0));
 v_finance:=greatest(0,coalesce((v_profile.skills->>'finance')::numeric,0));
 v_leadership:=greatest(0,coalesce((v_profile.skills->>'leadership')::numeric,0));
 v_level_mult:=1+(v_company.level-1)*0.32;
 v_staff_bonus:=1+greatest(0,v_company.employees_count-1)*0.05;
 v_rep_bonus:=case when v_profile.reputation>=700 then 1.08 when v_profile.reputation>=350 then 1.06
  when v_profile.reputation>=160 then 1.04 when v_profile.reputation>=60 then 1.02 else 1 end;
 if v_profile.org_id is not null then
  select coalesce((research->>'commerce')::integer,0) into v_commerce from organizations where id=v_profile.org_id;
  v_commerce:=least(10,greatest(0,coalesce(v_commerce,0)));
 end if;
 select coalesce(exp(sum(ln(greatest(0.0001,e.revenue_multiplier)))),1) into v_event_mult
 from (
   select x.revenue_multiplier,x.affected_sectors
   from (
     select distinct on (coalesce(stack_group,effect_type,id)) revenue_multiplier,affected_sectors,
       coalesce(stack_group,effect_type,id) as grp,created_at
     from world_events
     where active=true and starts_at<=v_now and ends_at>v_now
     order by coalesce(stack_group,effect_type,id),created_at
   ) x
   order by x.created_at
   limit 3
 ) e
 where v_company.sector=any(e.affected_sectors);
 v_event_mult:=round(greatest(0.75,least(1.4,coalesce(v_event_mult,1))),3);
 v_gross:=round(v_company.base_revenue_per_hour*v_level_mult*v_staff_bonus*(1+v_mgmt*0.08)*v_event_mult*v_rep_bonus*(1+v_commerce*0.005));
 v_expense:=round((v_company.expense_per_hour*(1+(v_company.level-1)*0.2)+greatest(0,v_company.employees_count-3)*8)*(1-least(0.45,v_finance*0.05)));
 v_net:=greatest(15,v_gross-v_expense);

 v_vault_level:=greatest(1,least(25,coalesce(v_company.vault_level,1)));
 v_capacity:=greatest(3500,floor((greatest(0,v_net)*4*v_vault_level)/25));
 v_stored:=greatest(0,coalesce(v_company.vault_balance,0));
 v_elapsed:=greatest(0,extract(epoch from (v_now-v_last))/3600.0);
 v_payout:=least(v_capacity,floor(v_stored+greatest(0,floor(v_net*v_elapsed)))::integer);
 if v_payout<1 then raise exception 'NOTHING_TO_COLLECT'; end if;

 v_xp_gain:=least(80,greatest(10,floor(v_payout/15.0)::integer));
 v_next_xp:=v_profile.xp+v_xp_gain; v_next_level:=1;
 while v_next_level<100 loop
  if v_next_xp<(200+(v_next_level-1)*120) then exit; end if;
  v_next_xp:=v_next_xp-(200+(v_next_level-1)*120); v_next_level:=v_next_level+1;
 end loop;
 insert into transactions(id,from_uid,to_uid,amount,fee,net_amount,type,reference_id,description,status)
 values(v_tx,'SYSTEM',p_user_id,v_payout,0,v_payout,'company_collect',p_company_id,
  'Company revenue collected: '||v_company.name,'completed');
 update wallets set balance=balance+v_payout,total_earned=total_earned+v_payout,last_tx_id=v_tx,updated_at=now()
 where user_id=p_user_id;
 update companies set total_revenue=total_revenue+v_payout,vault_balance=0,last_collected_at=v_now,updated_at=v_now
 where id=p_company_id;
 update player_profiles set xp=xp+v_xp_gain,level=v_next_level,
  skill_points=skill_points+greatest(0,(v_next_level-v_profile.level)*2),
  reputation=reputation+round(2*(1+v_leadership*0.1))::bigint,
  influence=influence+round(1*(1+v_leadership*0.1))::bigint,updated_at=now()
 where user_id=p_user_id;
 v_log:='clog_'||v_tx;
 insert into company_logs(id,company_id,owner_uid,action,amount,details)
 values(v_log,p_company_id,p_user_id,'collect',v_payout,'Collected +$'||v_payout::text);
 return jsonb_build_object('ok',true,'payout',v_payout,'replayed',false);
end $$;
revoke all on function nexora.collect_company_revenue(text,text,uuid) from public,anon,authenticated;
grant execute on function nexora.collect_company_revenue(text,text,uuid) to service_role;
