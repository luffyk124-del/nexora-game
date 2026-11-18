create or replace function nexora.upgrade_company_vault(p_user_id text,p_company_id text,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=nexora,pg_temp as $$
declare
 v_company companies%rowtype; v_profile player_profiles%rowtype; v_wallet numeric;
 v_level integer; v_target integer; v_cost integer; v_materials jsonb; v_item text; v_qty integer; v_have bigint;
 v_now_ms bigint; v_ends bigint; v_duration numeric; v_net numeric; v_gross numeric; v_expense numeric;
 v_mgmt numeric; v_finance numeric; v_staff numeric; v_rep_bonus numeric; v_event numeric; v_commerce integer:=0;
 v_capacity numeric; v_preserved numeric; v_elapsed numeric; v_stored numeric; v_tx text; v_log text;
begin
 if p_user_id is null or p_request_id is null then raise exception 'INVALID_REQUEST'; end if;
 v_tx:='vault_upgrade_'||p_user_id||'_'||p_request_id::text;
 if exists(select 1 from transactions where id=v_tx and from_uid=p_user_id and type='company_vault_upgrade') then
  return jsonb_build_object('ok',true,'replayed',true);
 end if;
 select * into v_company from companies where id=p_company_id for update;
 if not found then raise exception 'COMPANY_NOT_FOUND'; end if;
 if v_company.owner_uid<>p_user_id then raise exception 'UNAUTHORIZED'; end if;
 if v_company.auction_id is not null then raise exception 'COMPANY_IN_AUCTION'; end if;
 v_level:=greatest(1,least(25,coalesce(v_company.vault_level,1)));
 if coalesce(v_company.vault_upgrade_ends_at,0)>floor(extract(epoch from now())*1000)::bigint then raise exception 'UPGRADE_IN_PROGRESS'; end if;
 if v_level>=25 then raise exception 'VAULT_MAX_LEVEL'; end if;
 v_target:=v_level+1;
 v_cost:=round(1500*power(1.32::numeric,v_level-1))::integer;
 case ((v_level-1)%4)
  when 0 then v_materials:=jsonb_build_object('copper_wire',round(20*(1+(v_level-1)*0.12))::integer,'crude_alloy',round(10*(1+(v_level-1)*0.12))::integer);
  when 1 then v_materials:=jsonb_build_object('silicon_ore',round(20*(1+(v_level-1)*0.12))::integer,'energy_cells',round(15*(1+(v_level-1)*0.12))::integer);
  when 2 then v_materials:=jsonb_build_object('carbon_fiber',round(15*(1+(v_level-1)*0.12))::integer,'precision_frame',round(10*(1+(v_level-1)*0.12))::integer);
  else v_materials:=jsonb_build_object('rare_minerals',round(20*(1+(v_level-1)*0.12))::integer,'quantum_server',round(5*(1+(v_level-1)*0.12))::integer);
 end case;
 select * into v_profile from player_profiles where user_id=p_user_id for update;
 if not found then raise exception 'ACCOUNT_NOT_FOUND'; end if;
 select balance into v_wallet from wallets where user_id=p_user_id for update;
 if not found then raise exception 'ACCOUNT_NOT_FOUND'; end if;
 if v_wallet<v_cost then raise exception 'INSUFFICIENT_FUNDS'; end if;

 for v_item in select key from jsonb_each(v_materials) order by key loop
  perform 1 from inventory where user_id=p_user_id and item_id=v_item for update;
  if not found then raise exception 'MISSING_VAULT_MATERIALS'; end if;
 end loop;
 for v_item,v_qty in select key,(value#>>'{}')::integer from jsonb_each(v_materials) loop
  select quantity into v_have from inventory where user_id=p_user_id and item_id=v_item;
  if not found or v_have<v_qty then raise exception 'MISSING_VAULT_MATERIALS'; end if;
 end loop;

 v_now_ms:=floor(extract(epoch from now())*1000)::bigint;
 if v_target<=50 then v_duration:=2000*power(43200::numeric,(v_target-2)::numeric/48);
 else v_duration:=86400000*power(15::numeric,(v_target-50)::numeric/50); end if;
 v_ends:=v_now_ms+greatest(1000,floor(v_duration/2)::bigint);

 v_mgmt:=greatest(0,coalesce((v_profile.skills->>'management')::numeric,0));
 v_finance:=greatest(0,coalesce((v_profile.skills->>'finance')::numeric,0));
 v_staff:=1+greatest(0,v_company.employees_count-1)*0.05;
 v_rep_bonus:=case when v_profile.reputation>=700 then 1.08 when v_profile.reputation>=350 then 1.06
  when v_profile.reputation>=160 then 1.04 when v_profile.reputation>=60 then 1.02 else 1 end;
 if v_profile.org_id is not null then
  select least(10,greatest(0,coalesce((research->>'commerce')::integer,0))) into v_commerce from organizations where id=v_profile.org_id;
  v_commerce:=coalesce(v_commerce,0);
 end if;
 select coalesce(exp(sum(ln(greatest(0.0001,e.revenue_multiplier)))),1) into v_event
 from (
   select x.revenue_multiplier,x.affected_sectors from (
     select distinct on (coalesce(stack_group,effect_type,id)) revenue_multiplier,affected_sectors,
       coalesce(stack_group,effect_type,id) grp,created_at
     from world_events where active=true and starts_at<=now() and ends_at>now()
     order by coalesce(stack_group,effect_type,id),created_at
   ) x order by x.created_at limit 3
 ) e where v_company.sector=any(e.affected_sectors);
 v_event:=round(greatest(0.75,least(1.4,coalesce(v_event,1))),3);
 v_gross:=round(v_company.base_revenue_per_hour*(1+(v_company.level-1)*0.32)*v_staff*(1+v_mgmt*0.08)*v_event*v_rep_bonus*(1+v_commerce*0.005));
 v_expense:=round((v_company.expense_per_hour*(1+(v_company.level-1)*0.2)+greatest(0,v_company.employees_count-3)*8)*(1-least(0.45,v_finance*0.05)));
 v_net:=greatest(15,v_gross-v_expense);
 v_capacity:=greatest(3500,floor((greatest(0,v_net)*4*v_level)/25));
 v_stored:=greatest(0,coalesce(v_company.vault_balance,0));
 v_elapsed:=greatest(0,extract(epoch from (now()-coalesce(v_company.last_collected_at,now())))/3600.0);
 v_preserved:=least(v_capacity,v_stored+greatest(0,floor(v_net*v_elapsed)));

 update wallets set balance=balance-v_cost,total_spent=total_spent+v_cost,last_tx_id=v_tx,updated_at=now() where user_id=p_user_id;
 for v_item,v_qty in select key,(value#>>'{}')::integer from jsonb_each(v_materials) loop
  update inventory set quantity=quantity-v_qty,updated_at=now() where user_id=p_user_id and item_id=v_item;
 end loop;
 update companies set vault_balance=v_preserved,vault_upgrade_started_at=v_now_ms,
  vault_upgrade_ends_at=v_ends,vault_upgrade_target_level=v_target,last_collected_at=now(),updated_at=now()
 where id=p_company_id;
 insert into transactions(id,from_uid,to_uid,amount,fee,net_amount,type,reference_id,description,status)
 values(v_tx,p_user_id,'SYSTEM',v_cost,0,v_cost,'company_vault_upgrade',p_company_id,
  'Upgraded '||v_company.name||' profit vault to Lv.'||v_target::text,'completed');
 v_log:='clog_'||v_tx;
 insert into company_logs(id,company_id,owner_uid,action,amount,details)
 values(v_log,p_company_id,p_user_id,'vault_upgrade',-v_cost,
  'Profit vault upgrade to Lv.'||v_target::text||'; preserved '||v_preserved::text);
 return jsonb_build_object('ok',true,'targetLevel',v_target,'endsAt',v_ends,'vaultBalance',v_preserved,'capacity',v_capacity,'replayed',false);
end $$;

create or replace function nexora.complete_company_vault_upgrade(p_user_id text,p_company_id text)
returns jsonb language plpgsql security definer set search_path=nexora,pg_temp as $$
declare v_company companies%rowtype; v_now bigint; v_target integer; v_log text; v_level integer;
begin
 if p_user_id is null then raise exception 'UNAUTHENTICATED'; end if;
 select * into v_company from companies where id=p_company_id for update;
 if not found then raise exception 'COMPANY_NOT_FOUND'; end if;
 if v_company.owner_uid<>p_user_id then raise exception 'UNAUTHORIZED'; end if;
 if v_company.auction_id is not null then raise exception 'COMPANY_IN_AUCTION'; end if;
 v_level:=greatest(1,least(25,coalesce(v_company.vault_level,1)));
 v_now:=floor(extract(epoch from now())*1000)::bigint;
 if coalesce(v_company.vault_upgrade_ends_at,0)=0 or coalesce(v_company.vault_upgrade_target_level,0)=0 then raise exception 'NO_UPGRADE_IN_PROGRESS'; end if;
 if v_now<v_company.vault_upgrade_ends_at then raise exception 'UPGRADE_NOT_FINISHED'; end if;
 v_target:=v_company.vault_upgrade_target_level;
 if v_target<>v_level+1 or v_target>25 then raise exception 'INVALID_UPGRADE_STATE'; end if;
 update companies set vault_level=v_target,vault_upgrade_started_at=null,vault_upgrade_ends_at=null,
  vault_upgrade_target_level=null,updated_at=now() where id=p_company_id;
 v_log:='clog_vault_complete_'||p_company_id||'_'||v_target::text;
 insert into company_logs(id,company_id,owner_uid,action,amount,details)
 values(v_log,p_company_id,p_user_id,'vault_upgrade_completed',0,'Profit vault reached Level '||v_target::text);
 return jsonb_build_object('ok',true,'vaultLevel',v_target);
end $$;
revoke all on function nexora.upgrade_company_vault(text,text,uuid) from public,anon,authenticated;
revoke all on function nexora.complete_company_vault_upgrade(text,text) from public,anon,authenticated;
grant execute on function nexora.upgrade_company_vault(text,text,uuid) to service_role;
grant execute on function nexora.complete_company_vault_upgrade(text,text) to service_role;
