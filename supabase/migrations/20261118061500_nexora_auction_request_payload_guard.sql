create or replace function nexora.create_company_auction(
 p_user_id text,p_company_id text,p_starting_price bigint,p_request_id uuid
) returns jsonb language plpgsql security definer set search_path=nexora,pg_temp as $$
declare
 v_company companies%rowtype; v_existing company_auctions%rowtype; v_profile player_profiles%rowtype; v_id text;
 v_now timestamptz:=now(); v_now_ms bigint; v_ends bigint;
 v_min bigint; v_max bigint; v_seller text; v_net numeric; v_gross numeric; v_expense numeric;
 v_mgmt numeric; v_finance numeric; v_rep_bonus numeric; v_staff numeric; v_event numeric;
 v_vault_level integer; v_capacity numeric; v_stored numeric; v_elapsed numeric; v_preserved numeric;
begin
 if p_user_id is null or p_request_id is null or p_company_id is null then raise exception 'INVALID_REQUEST'; end if;
 if p_starting_price is null or p_starting_price<0 or p_starting_price>10000000 then raise exception 'INVALID_ARGUMENT'; end if;
 v_id:='auc_'||p_user_id||'_'||p_request_id::text;
 select * into v_existing from company_auctions where id=v_id;
 if found then
  if v_existing.seller_uid<>p_user_id or v_existing.company_id<>p_company_id or v_existing.starting_price<>p_starting_price then raise exception 'REQUEST_ID_CONFLICT'; end if;
  return jsonb_build_object('ok',true,'auctionId',v_id,'endsAt',v_existing.ends_at,
   'minPrice',v_existing.company_level*1000,'maxPrice',v_existing.company_level*100000,'replayed',true);
 end if;
 select * into v_company from companies where id=p_company_id for update;
 if not found then raise exception 'NOT_FOUND'; end if;
 select * into v_profile from player_profiles where user_id=p_user_id for update;
 if not found then raise exception 'ACCOUNT_NOT_FOUND'; end if;
 if v_company.owner_uid<>p_user_id then raise exception 'NOT_COMPANY_OWNER'; end if;
 if v_company.level<50 then raise exception 'COMPANY_LEVEL_TOO_LOW'; end if;
 if v_company.auction_id is not null then raise exception 'AUCTION_ALREADY_ACTIVE'; end if;
 v_now_ms:=floor(extract(epoch from v_now)*1000)::bigint;
 if coalesce(v_company.level_upgrade_ends_at,0)>v_now_ms or coalesce(v_company.vault_upgrade_ends_at,0)>v_now_ms then
  raise exception 'COMPANY_UPGRADE_IN_PROGRESS';
 end if;
 v_min:=v_company.level*1000; v_max:=v_company.level*100000;
 if p_starting_price<>0 and (p_starting_price<v_min or p_starting_price>v_max) then raise exception 'START_PRICE_OUT_OF_RANGE'; end if;
 v_ends:=v_now_ms+86400000;
 v_seller:=coalesce(nullif(v_profile.username,''),v_company.owner_name,'Player');
 v_mgmt:=greatest(0,coalesce((v_profile.skills->>'management')::numeric,0));
 v_finance:=greatest(0,coalesce((v_profile.skills->>'finance')::numeric,0));
 v_staff:=1+greatest(0,v_company.employees_count-1)*0.05;
 v_rep_bonus:=case when v_profile.reputation>=700 then 1.08 when v_profile.reputation>=350 then 1.06
  when v_profile.reputation>=160 then 1.04 when v_profile.reputation>=60 then 1.02 else 1 end;
 select coalesce(exp(sum(ln(greatest(0.0001,e.revenue_multiplier)))),1) into v_event
 from (
  select x.revenue_multiplier,x.affected_sectors from (
   select distinct on (coalesce(stack_group,effect_type,id)) revenue_multiplier,affected_sectors,
    coalesce(stack_group,effect_type,id) grp,created_at
   from world_events where active=true and (starts_at is null or starts_at<=v_now) and (ends_at is null or ends_at>v_now)
   order by coalesce(stack_group,effect_type,id),created_at
  ) x order by x.created_at limit 3
 ) e where v_company.sector=any(e.affected_sectors);
 v_event:=greatest(0.75,least(1.4,coalesce(v_event,1)));
 v_gross:=round(v_company.base_revenue_per_hour*(1+(v_company.level-1)*0.32)*v_staff*(1+v_mgmt*0.08)*v_event*v_rep_bonus);
 v_expense:=round((v_company.expense_per_hour*(1+(v_company.level-1)*0.2)+greatest(0,v_company.employees_count-3)*8)*(1-least(0.45,v_finance*0.05)));
 v_net:=greatest(15,v_gross-v_expense);
 v_vault_level:=greatest(1,least(25,coalesce(v_company.vault_level,1)));
 v_capacity:=greatest(3500,floor((greatest(0,v_net)*4*v_vault_level)/25));
 v_stored:=greatest(0,coalesce(v_company.vault_balance,0));
 v_elapsed:=greatest(0,extract(epoch from (v_now-coalesce(v_company.last_collected_at,v_now)))/3600.0);
 v_preserved:=least(v_capacity,v_stored+greatest(0,floor(v_net*v_elapsed)));
 insert into company_auctions(id,company_id,company_name,company_level,seller_uid,seller_name,
  starting_price,current_bid,highest_bidder_uid,highest_bidder_name,ends_at,status)
 values(v_id,p_company_id,v_company.name,v_company.level,p_user_id,v_seller,
  p_starting_price,0,null,null,v_ends,'active');
 update companies set auction_id=v_id,auction_ends_at=v_ends,auction_status='active',
  vault_balance=v_preserved,last_collected_at=v_now,updated_at=v_now where id=p_company_id;
 return jsonb_build_object('ok',true,'auctionId',v_id,'endsAt',v_ends,'minPrice',v_min,'maxPrice',v_max,'replayed',false);
end $$;

revoke all on function nexora.create_company_auction(text,text,bigint,uuid) from public,anon,authenticated;
grant execute on function nexora.create_company_auction(text,text,bigint,uuid) to service_role;
create or replace function nexora.place_company_auction_bid(
 p_user_id text,p_auction_id text,p_bid_amount bigint,p_request_id uuid
) returns jsonb language plpgsql security definer set search_path=nexora,pg_temp as $$
declare
 v_auction company_auctions%rowtype; v_company companies%rowtype; v_profile player_profiles%rowtype;
 v_bidder wallets%rowtype; v_previous wallets%rowtype; v_old_uid text; v_old_bid numeric;
 v_min numeric; v_bid_tx text; v_refund_tx text; v_bid_id text; v_next numeric;
 v_owned integer; v_limit integer;
begin
 if p_user_id is null or p_request_id is null or p_auction_id is null then raise exception 'INVALID_REQUEST'; end if;
 if p_bid_amount is null or p_bid_amount<1 or p_bid_amount>10000000 then raise exception 'INVALID_ARGUMENT'; end if;
 select * into v_auction from company_auctions where id=p_auction_id for update;
 if not found then raise exception 'AUCTION_NOT_FOUND'; end if;
 v_bid_id:='auc_bid_'||p_auction_id||'_'||p_user_id||'_'||p_request_id::text;
 if exists(select 1 from company_auction_bids where id=v_bid_id) then
  select * into strict v_auction from company_auctions where id=p_auction_id;
  select next_minimum_bid,bid_amount into v_next,v_old_bid from company_auction_bids where id=v_bid_id;
  if v_old_bid<>p_bid_amount then raise exception 'REQUEST_ID_CONFLICT'; end if;
  return jsonb_build_object('ok',true,'currentBid',v_old_bid,'nextMinimumBid',v_next,'replayed',true);
 end if;
 if v_auction.status<>'active' or v_auction.ends_at<=floor(extract(epoch from now())*1000)::bigint then raise exception 'AUCTION_ENDED'; end if;
 if v_auction.seller_uid=p_user_id then raise exception 'CANNOT_BID_OWN_AUCTION'; end if;
 if v_auction.highest_bidder_uid=p_user_id then raise exception 'ALREADY_HIGHEST_BIDDER'; end if;
 select * into v_company from companies where id=v_auction.company_id for update;
 if not found or v_company.owner_uid<>v_auction.seller_uid or v_company.auction_id<>p_auction_id then raise exception 'AUCTION_COMPANY_MISMATCH'; end if;
 select * into v_profile from player_profiles where user_id=p_user_id for update;
 if not found then raise exception 'ACCOUNT_NOT_FOUND'; end if;
 v_owned:=greatest(0,coalesce((v_profile.stats->>'companiesOwned')::integer,0));
 v_limit:=least(10,1+floor(((greatest(1,least(100,v_profile.level))-1)*9)::numeric/49)::integer);
 if v_owned>=v_limit then raise exception 'COMPANY_OWNERSHIP_LIMIT'; end if;
 v_old_uid:=v_auction.highest_bidder_uid;
 v_old_bid:=greatest(0,v_auction.current_bid);
 v_min:=case when v_old_bid>0 then v_old_bid+greatest(100,ceil(v_old_bid*0.05)) else greatest(1,v_auction.starting_price) end;
 if p_bid_amount<v_min then raise exception 'BID_TOO_LOW'; end if;
 -- Lock every wallet in a stable order so concurrent bids across auctions cannot deadlock.
 perform 1 from wallets where user_id in (p_user_id,v_old_uid) order by user_id for update;
 select * into v_bidder from wallets where user_id=p_user_id;
 if not found then raise exception 'ACCOUNT_NOT_FOUND'; end if;
 if v_bidder.balance<p_bid_amount then raise exception 'INSUFFICIENT_FUNDS'; end if;
 if v_old_uid is not null then
  select * into v_previous from wallets where user_id=v_old_uid;
  if not found then raise exception 'PREVIOUS_ESCROW_ACCOUNT_MISSING'; end if;
 end if;
 v_bid_tx:='auc_bid_tx_'||p_auction_id||'_'||p_user_id||'_'||p_request_id::text;
 update wallets set balance=balance-p_bid_amount,total_spent=total_spent+p_bid_amount,
  last_tx_id=v_bid_tx,updated_at=now() where user_id=p_user_id;
 insert into transactions(id,from_uid,to_uid,amount,fee,net_amount,type,reference_id,description,status)
 values(v_bid_tx,p_user_id,'SYSTEM',p_bid_amount,0,p_bid_amount,'company_auction_bid',p_auction_id,
  'Escrow bid for '||v_auction.company_name,'completed');
 if v_old_uid is not null then
  v_refund_tx:='auc_refund_tx_'||p_auction_id||'_'||p_user_id||'_'||p_request_id::text;
  update wallets set balance=balance+v_old_bid,total_spent=greatest(0,total_spent-v_old_bid),
   last_tx_id=v_refund_tx,updated_at=now() where user_id=v_old_uid;
  insert into transactions(id,from_uid,to_uid,amount,fee,net_amount,type,reference_id,description,status)
  values(v_refund_tx,'SYSTEM',v_old_uid,v_old_bid,0,v_old_bid,'company_auction_refund',p_auction_id,
   'Outbid refund for '||v_auction.company_name,'completed');
  insert into notifications(id,user_id,title,body,type,is_read)
  values('auc_outbid_'||p_auction_id||'_'||p_request_id::text,v_old_uid,'تم تجاوز مزايدتك','تم رد ضمان مزايدتك السابقة في مزاد '||v_auction.company_name,'market',false);
 end if;
 v_next:=p_bid_amount+greatest(100,ceil(p_bid_amount*0.05));
 update company_auctions set current_bid=p_bid_amount,highest_bidder_uid=p_user_id,
  highest_bidder_name=coalesce(nullif(v_profile.username,''),'Player'),updated_at=now()
 where id=p_auction_id;
 insert into company_auction_bids(id,auction_id,bidder_uid,request_id,bid_amount,
  previous_bidder_uid,previous_bid_amount,next_minimum_bid)
 values(v_bid_id,p_auction_id,p_user_id,p_request_id,p_bid_amount,v_old_uid,v_old_bid,v_next);
 insert into audit_logs(id,user_id,action,entity_type,entity_id,details)
 values('audit_'||v_bid_id,p_user_id,'company_auction_bid','company_auction',p_auction_id,
  jsonb_build_object('amount',p_bid_amount,'previousBidder',v_old_uid));
 return jsonb_build_object('ok',true,'currentBid',p_bid_amount,'nextMinimumBid',v_next,'replayed',false);
end $$;

revoke all on function nexora.place_company_auction_bid(text,text,bigint,uuid) from public,anon,authenticated;
grant execute on function nexora.place_company_auction_bid(text,text,bigint,uuid) to service_role;
revoke all on function nexora.create_company_auction(text,text,bigint,uuid) from public,anon,authenticated;
revoke all on function nexora.place_company_auction_bid(text,text,bigint,uuid) from public,anon,authenticated;
grant execute on function nexora.create_company_auction(text,text,bigint,uuid) to service_role;
grant execute on function nexora.place_company_auction_bid(text,text,bigint,uuid) to service_role;
