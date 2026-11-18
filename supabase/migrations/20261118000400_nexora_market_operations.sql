create or replace function nexora.create_market_listing(
  p_user_id text,p_item_id text,p_quantity integer,p_unit_price integer,p_request_id uuid
) returns jsonb
language plpgsql security definer set search_path=nexora,pg_temp
as $$
declare
  v_username text;
  v_listing_id text;
  v_inventory_qty bigint;
begin
  if p_user_id is null or length(p_user_id)<1 then raise exception 'UNAUTHENTICATED'; end if;
  if p_request_id is null then raise exception 'INVALID_REQUEST_ID'; end if;
  if p_item_id not in ('silicon_ore','copper_wire','energy_cells','crude_alloy','carbon_fiber','rare_minerals','microchips','precision_frame','synth_polymer','quantum_server','logistics_drone','bio_module') then
    raise exception 'INVALID_ITEM';
  end if;
  if p_quantity is null or p_quantity<1 or p_quantity>10000 or p_unit_price is null or p_unit_price<1 or p_unit_price>1000000 then
    raise exception 'INVALID_LISTING_PARAMS';
  end if;
  v_listing_id := 'lst_'||p_user_id||'_'||p_request_id::text;
  if exists(select 1 from market_listings where id=v_listing_id) then
    return jsonb_build_object('ok',true,'listingId',v_listing_id,'replayed',true);
  end if;
  select username into v_username from player_profiles where user_id=p_user_id;
  if not found then raise exception 'ACCOUNT_NOT_FOUND'; end if;
  select quantity into v_inventory_qty from inventory where user_id=p_user_id and item_id=p_item_id for update;
  if not found or v_inventory_qty<p_quantity then raise exception 'INSUFFICIENT_INVENTORY'; end if;
  update inventory set quantity=quantity-p_quantity,updated_at=now()
   where user_id=p_user_id and item_id=p_item_id;
  insert into market_listings(id,seller_uid,seller_name,item_id,quantity,remaining_qty,unit_price,status)
  values(v_listing_id,p_user_id,v_username,p_item_id,p_quantity,p_quantity,p_unit_price,'active');
  insert into audit_logs(id,user_id,action,entity_type,entity_id,details)
  values('listing_'||p_user_id||'_'||p_request_id::text,p_user_id,'market_listing_create','market_listing',v_listing_id,
         jsonb_build_object('item_id',p_item_id,'quantity',p_quantity,'unit_price',p_unit_price));
  return jsonb_build_object('ok',true,'listingId',v_listing_id,'replayed',false);
end;
$$;

create or replace function nexora.buy_market_listing(
  p_buyer_uid text,p_listing_id text,p_quantity integer,p_request_id uuid
) returns jsonb
language plpgsql security definer set search_path=nexora,pg_temp
as $$
declare
  v_listing market_listings%rowtype;
  v_buyer_level integer;
  v_buyer_xp bigint;
  v_buyer_skill_points integer;
  v_buyer_skills jsonb;
  v_buyer_stats jsonb;
  v_buyer_rep bigint;
  v_buyer_influence bigint;
  v_trade_skill integer;
  v_leadership numeric;
  v_seller_balance numeric;
  v_buyer_balance numeric;
  v_seller_earned numeric;
  v_buyer_spent numeric;
  v_total numeric;
  v_tax_rate numeric;
  v_tax numeric;
  v_net numeric;
  v_tx_id text;
  v_order_id text;
  v_next_xp bigint;
  v_next_level integer;
  v_xp_gain integer;
begin
  if p_buyer_uid is null or length(p_buyer_uid)<1 then raise exception 'UNAUTHENTICATED'; end if;
  if p_request_id is null then raise exception 'INVALID_REQUEST_ID'; end if;
  if p_quantity is null or p_quantity<1 or p_quantity>10000 then raise exception 'INVALID_QUANTITY'; end if;
  v_tx_id := 'market_'||p_buyer_uid||'_'||p_request_id::text;
  v_order_id := 'ord_'||p_buyer_uid||'_'||p_request_id::text;

  if exists(select 1 from transactions where id=v_tx_id and from_uid=p_buyer_uid and type='market_buy') then
    return jsonb_build_object('ok',true,'transactionId',v_tx_id,'replayed',true);
  end if;

  select * into v_listing from market_listings where id=p_listing_id for update;
  if not found then raise exception 'LISTING_NOT_FOUND'; end if;
  -- Recheck after the listing lock so concurrent retries return the committed order.
  if exists(select 1 from transactions where id=v_tx_id and from_uid=p_buyer_uid and type='market_buy') then
    return jsonb_build_object('ok',true,'transactionId',v_tx_id,'replayed',true);
  end if;
  if v_listing.status<>'active' or v_listing.remaining_qty<p_quantity then raise exception 'INSUFFICIENT_LISTING_QTY'; end if;
  if v_listing.seller_uid=p_buyer_uid then raise exception 'CANNOT_BUY_OWN_LISTING'; end if;

  select level,xp,skill_points,skills,stats,reputation,influence
    into v_buyer_level,v_buyer_xp,v_buyer_skill_points,v_buyer_skills,v_buyer_stats,v_buyer_rep,v_buyer_influence
    from player_profiles where user_id=p_buyer_uid for update;
  if not found then raise exception 'ACCOUNT_NOT_FOUND'; end if;
  v_trade_skill:=coalesce((v_buyer_skills->>'trade')::integer,0);
  v_leadership:=coalesce((v_buyer_skills->>'leadership')::numeric,0);

  v_total:=v_listing.unit_price*p_quantity;
  if v_total>10000000 then raise exception 'INVALID_TOTAL'; end if;

  -- Lock wallets in deterministic UID order, matching transfer lock ordering.
  if p_buyer_uid < v_listing.seller_uid then
    select balance,total_spent into v_buyer_balance,v_buyer_spent from wallets where user_id=p_buyer_uid for update;
    if v_listing.seller_uid<>'SYSTEM' then
      select balance,total_earned into v_seller_balance,v_seller_earned from wallets where user_id=v_listing.seller_uid for update;
    end if;
  else
    if v_listing.seller_uid<>'SYSTEM' then
      select balance,total_earned into v_seller_balance,v_seller_earned from wallets where user_id=v_listing.seller_uid for update;
    end if;
    select balance,total_spent into v_buyer_balance,v_buyer_spent from wallets where user_id=p_buyer_uid for update;
  end if;
  if v_buyer_balance is null then raise exception 'ACCOUNT_NOT_FOUND'; end if;
  if v_buyer_balance<v_total then raise exception 'INSUFFICIENT_FUNDS'; end if;

  v_tax_rate:=0.05-(v_trade_skill*0.004)+coalesce((
    select sum(tax_delta) from world_events
    where active=true and starts_at<=now() and ends_at>now()
  ),0);
  v_tax_rate:=greatest(0.01,least(0.12,v_tax_rate));
  v_tax:=round(v_total*v_tax_rate);
  v_net:=v_total-v_tax;

  insert into transactions(id,from_uid,to_uid,amount,fee,net_amount,type,reference_id,description,status)
  values(v_tx_id,p_buyer_uid,v_listing.seller_uid,v_total,v_tax,v_net,'market_buy',p_listing_id,
         'Market buy: '||p_quantity::text||'x '||v_listing.item_id,'completed');
  insert into market_orders(id,listing_id,buyer_uid,seller_uid,item_id,quantity,unit_price,total_price,tax_amount,tx_id)
  values(v_order_id,p_listing_id,p_buyer_uid,v_listing.seller_uid,v_listing.item_id,p_quantity,v_listing.unit_price,v_total,v_tax,v_tx_id);

  update wallets set balance=balance-v_total,total_spent=total_spent+v_total,last_tx_id=v_tx_id,updated_at=now()
   where user_id=p_buyer_uid;
  if v_listing.seller_uid<>'SYSTEM' and v_seller_balance is not null then
    update wallets set balance=balance+v_net,total_earned=total_earned+v_net,last_tx_id=v_tx_id,updated_at=now()
     where user_id=v_listing.seller_uid;
  end if;

  update market_listings set remaining_qty=remaining_qty-p_quantity,
    status=case when remaining_qty-p_quantity=0 then 'sold' else 'active' end,updated_at=now()
   where id=p_listing_id;

  insert into inventory(user_id,item_id,quantity,updated_at)
  values(p_buyer_uid,v_listing.item_id,p_quantity,now())
  on conflict(user_id,item_id) do update set quantity=inventory.quantity+excluded.quantity,updated_at=now();

  v_xp_gain:=25+least(50,p_quantity*2);
  v_next_xp:=v_buyer_xp+v_xp_gain;
  v_next_level:=1;
  while v_next_level<100 loop
    if v_next_xp<(200+(v_next_level-1)*120) then exit; end if;
    v_next_xp:=v_next_xp-(200+(v_next_level-1)*120);
    v_next_level:=v_next_level+1;
  end loop;
  update player_profiles
    set xp=xp+v_xp_gain,level=v_next_level,
        skill_points=skill_points+greatest(0,(v_next_level-v_buyer_level)*2),
        reputation=reputation+round(2*(1+v_leadership*0.1))::bigint,
        influence=influence+round(1*(1+v_leadership*0.1))::bigint,
        stats=jsonb_set(v_buyer_stats,'{tradesCount}',to_jsonb(coalesce((v_buyer_stats->>'tradesCount')::integer,0)+1),true),
        updated_at=now()
   where user_id=p_buyer_uid;

  insert into audit_logs(id,user_id,action,entity_type,entity_id,details)
  values('audit_'||v_tx_id,p_buyer_uid,'market_purchase','market_order',v_order_id,
         jsonb_build_object('listing_id',p_listing_id,'quantity',p_quantity,'tax',v_tax));
  return jsonb_build_object('ok',true,'transactionId',v_tx_id,'orderId',v_order_id,'totalPrice',v_total,'taxAmount',v_tax,'replayed',false);
end;
$$;

revoke all on function nexora.create_market_listing(text,text,integer,integer,uuid) from public,anon,authenticated;
revoke all on function nexora.buy_market_listing(text,text,integer,uuid) from public,anon,authenticated;
grant execute on function nexora.create_market_listing(text,text,integer,integer,uuid) to service_role;
grant execute on function nexora.buy_market_listing(text,text,integer,uuid) to service_role;
