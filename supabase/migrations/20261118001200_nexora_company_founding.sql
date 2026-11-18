create or replace function nexora.found_company(p_user_id text,p_name text,p_sector text,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=nexora,pg_temp as $$
declare
 v_cost integer; v_revenue integer; v_expense integer; v_name text; v_owner text;
 v_company_id text; v_tx_id text; v_level integer; v_xp bigint; v_points integer; v_rep bigint;
 v_influence bigint; v_skills jsonb; v_stats jsonb; v_leadership numeric; v_balance numeric;
 v_next_xp bigint; v_next_level integer; v_owned integer; v_limit integer;
begin
 if p_user_id is null or p_request_id is null then raise exception 'INVALID_REQUEST'; end if;
 v_name:=trim(coalesce(p_name,''));
 if length(v_name)<2 or length(v_name)>48 then raise exception 'INVALID_NAME'; end if;
 select founding_cost,base_revenue_per_hour,base_expense_per_hour into v_cost,v_revenue,v_expense
 from (values ('trade',900,140,35),('services',1100,175,45),('logistics',1400,225,60),
 ('manufacturing',1800,290,80),('tech',2200,365,95)) s(sector,founding_cost,base_revenue_per_hour,base_expense_per_hour)
 where s.sector=p_sector;
 if not found then raise exception 'INVALID_SECTOR'; end if;
 v_company_id:='cmp_'||p_user_id||'_'||p_request_id::text;
 v_tx_id:='company_create_'||p_user_id||'_'||p_request_id::text;
 if exists(select 1 from transactions where id=v_tx_id and from_uid=p_user_id and type='company_create') then
  return jsonb_build_object('ok',true,'companyId',v_company_id,'replayed',true);
 end if;
 select username,level,xp,skill_points,reputation,influence,skills,stats
 into v_owner,v_level,v_xp,v_points,v_rep,v_influence,v_skills,v_stats
 from player_profiles where user_id=p_user_id for update;
 if not found then raise exception 'ACCOUNT_NOT_FOUND'; end if;
 v_owned:=greatest(0,coalesce((v_stats->>'companiesOwned')::integer,0));
 v_limit:=least(10,1+floor(((greatest(1,least(100,coalesce(v_level,1)))-1)*9)::numeric/49)::integer);
 if v_owned>=v_limit then raise exception 'COMPANY_OWNERSHIP_LIMIT'; end if;
 select balance into v_balance from wallets where user_id=p_user_id for update;
 if not found then raise exception 'ACCOUNT_NOT_FOUND'; end if;
 if v_balance<v_cost then raise exception 'INSUFFICIENT_FUNDS'; end if;
 v_leadership:=coalesce((v_skills->>'leadership')::numeric,0);
 insert into companies(id,owner_uid,owner_name,name,sector,level,capital,employees_count,
  base_revenue_per_hour,expense_per_hour,total_revenue,vault_level,vault_balance,last_collected_at)
 values(v_company_id,p_user_id,v_owner,v_name,p_sector,1,v_cost,0,v_revenue,v_expense,0,1,0,now());
 insert into transactions(id,from_uid,to_uid,amount,fee,net_amount,type,reference_id,description,status)
 values(v_tx_id,p_user_id,'SYSTEM',v_cost,0,v_cost,'company_create',v_company_id,'Founded company: '||v_name,'completed');
 update wallets set balance=balance-v_cost,total_spent=total_spent+v_cost,last_tx_id=v_tx_id,updated_at=now()
 where user_id=p_user_id;
 v_next_xp:=v_xp+100; v_next_level:=1;
 while v_next_level<100 loop
  if v_next_xp<(200+(v_next_level-1)*120) then exit; end if;
  v_next_xp:=v_next_xp-(200+(v_next_level-1)*120); v_next_level:=v_next_level+1;
 end loop;
 update player_profiles set xp=xp+100,level=v_next_level,
  skill_points=skill_points+greatest(0,(v_next_level-v_level)*2),
  reputation=reputation+round(10*(1+v_leadership*0.1))::bigint,
  influence=influence+round(8*(1+v_leadership*0.1))::bigint,
  stats=jsonb_set(v_stats,'{companiesOwned}',to_jsonb(v_owned+1),true),updated_at=now()
 where user_id=p_user_id;
 insert into company_logs(id,company_id,owner_uid,action,amount,details)
 values('founded_'||v_company_id,v_company_id,p_user_id,'founded',-v_cost,'Company established in '||p_sector||' sector');
 return jsonb_build_object('ok',true,'companyId',v_company_id,'replayed',false);
end $$;
revoke all on function nexora.found_company(text,text,text,uuid) from public,anon,authenticated;
grant execute on function nexora.found_company(text,text,text,uuid) to service_role;
