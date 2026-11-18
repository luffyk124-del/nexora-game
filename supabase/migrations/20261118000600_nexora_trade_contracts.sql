create or replace function nexora.fulfill_trade_contract(p_user_id text,p_contract_id text)
returns jsonb
language plpgsql security definer set search_path=nexora,pg_temp
as $$
declare
  v_item text; v_required integer; v_base integer; v_xp_gain integer; v_rep_gain integer; v_title text;
  v_date date := (now() at time zone 'UTC')::date; v_claim_key text; v_payout integer;
  v_level integer; v_xp bigint; v_points integer; v_rep bigint; v_influence bigint;
  v_skills jsonb; v_stats jsonb; v_negotiation numeric; v_leadership numeric; v_bonus numeric;
  v_inventory_qty bigint; v_next_xp bigint; v_next_level integer; v_tx_id text;
begin
  if p_user_id is null or length(p_user_id)<1 then raise exception 'UNAUTHENTICATED'; end if;
  select item_id,required_qty,payout_credits,xp_reward,reputation_reward,title_en
    into v_item,v_required,v_base,v_xp_gain,v_rep_gain,v_title
  from (values
    ('ctr_chip_batch','microchips',2,420,75,12,'Cloud Lab Microchip Supply'),
    ('ctr_drone_fleet','logistics_drone',1,890,145,24,'Express Cargo Drone Fleet'),
    ('ctr_quantum_node','quantum_server',1,840,135,22,'Quantum Node Deployment')
  ) as c(id,item_id,required_qty,payout_credits,xp_reward,reputation_reward,title_en)
  where c.id=p_contract_id;
  if not found then raise exception 'INVALID_CONTRACT'; end if;

  v_claim_key:=p_contract_id||'_'||to_char(v_date,'YYYY-MM-DD');
  if exists(select 1 from contract_claims where user_id=p_user_id and contract_id=v_claim_key) then
    raise exception 'CONTRACT_ALREADY_FULFILLED';
  end if;
  select level,xp,skill_points,reputation,influence,skills,stats
    into v_level,v_xp,v_points,v_rep,v_influence,v_skills,v_stats
    from player_profiles where user_id=p_user_id for update;
  if not found then raise exception 'ACCOUNT_NOT_FOUND'; end if;
  select quantity into v_inventory_qty from inventory where user_id=p_user_id and item_id=v_item for update;
  if not found or v_inventory_qty<v_required then raise exception 'MISSING_INPUTS'; end if;
  perform 1 from wallets where user_id=p_user_id for update;
  if not found then raise exception 'ACCOUNT_NOT_FOUND'; end if;

  v_negotiation:=coalesce((v_skills->>'negotiation')::numeric,0);
  v_leadership:=coalesce((v_skills->>'leadership')::numeric,0);
  v_bonus:=case when v_rep>=700 then 0.15 when v_rep>=350 then 0.12 when v_rep>=160 then 0.08 when v_rep>=60 then 0.04 else 0 end;
  v_payout:=least(2500,round(v_base*(1+greatest(0,v_negotiation)*0.07)*(1+v_bonus))::integer);
  v_tx_id:='contract_'||p_user_id||'_'||v_claim_key;

  insert into contract_claims(user_id,contract_id,amount,claimed_at)
  values(p_user_id,v_claim_key,v_payout,now());
  insert into transactions(id,from_uid,to_uid,amount,fee,net_amount,type,reference_id,description,status)
  values(v_tx_id,'SYSTEM',p_user_id,v_payout,0,v_payout,'contract_deal',v_claim_key,
         'Contract fulfilled: '||v_title,'completed');
  update inventory set quantity=quantity-v_required,updated_at=now()
   where user_id=p_user_id and item_id=v_item;
  update wallets set balance=balance+v_payout,total_earned=total_earned+v_payout,
    last_tx_id=v_tx_id,updated_at=now() where user_id=p_user_id;

  v_next_xp:=v_xp+v_xp_gain; v_next_level:=1;
  while v_next_level<100 loop
    if v_next_xp<(200+(v_next_level-1)*120) then exit; end if;
    v_next_xp:=v_next_xp-(200+(v_next_level-1)*120); v_next_level:=v_next_level+1;
  end loop;
  update player_profiles set xp=xp+v_xp_gain,level=v_next_level,
    skill_points=skill_points+greatest(0,(v_next_level-v_level)*2),
    reputation=reputation+round(v_rep_gain*(1+v_leadership*0.1))::bigint,
    influence=influence+round(5*(1+v_leadership*0.1))::bigint,
    stats=jsonb_set(v_stats,'{tradesCount}',to_jsonb(coalesce((v_stats->>'tradesCount')::integer,0)+1),true),
    updated_at=now() where user_id=p_user_id;
  insert into audit_logs(id,user_id,action,entity_type,entity_id,details)
  values('audit_'||v_tx_id,p_user_id,'trade_contract_fulfill','contract',v_claim_key,
         jsonb_build_object('item_id',v_item,'quantity',v_required,'payout',v_payout));
  return jsonb_build_object('ok',true,'payout',v_payout,'contractId',p_contract_id,'dateKey',v_date);
end;
$$;
revoke all on function nexora.fulfill_trade_contract(text,text) from public,anon,authenticated;
grant execute on function nexora.fulfill_trade_contract(text,text) to service_role;
