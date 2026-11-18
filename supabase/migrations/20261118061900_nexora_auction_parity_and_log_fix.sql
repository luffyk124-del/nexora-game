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
  if v_existing.seller_uid<>p_user_id then raise exception 'REQUEST_ID_CONFLICT'; end if;
  return jsonb_build_object('ok',true,'auctionId',v_id,'endsAt',v_existing.ends_at,
   'minPrice',v_existing.company_level*1000,'maxPrice',v_existing.company_level*100000,'replayed',true);
 end if;
 select * into v_company from companies where id=p_company_id for update;
 if not found then raise exception 'NOT_FOUND'; end if;
 select * into v_profile from player_profiles where user_id=p_user_id for update;
 if not found then raise exception 'ACCOUNT_NOT_FOUND'; end if;
 if v_company.owner_uid<>p_user_id then raise exception 'NOT_COMPANY_OWNER'; end if;
 if v_company.level<50 then raise exception 'COMPANY_LEVEL_TOO_LOW'; end if;
 if nullif(v_company.auction_id,'') is not null then raise exception 'AUCTION_ALREADY_ACTIVE'; end if;
 v_now_ms:=floor(extract(epoch from v_now)*1000)::bigint;
 if coalesce(v_company.level_upgrade_ends_at,0)<>0 or coalesce(v_company.vault_upgrade_ends_at,0)<>0 then
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
 v_event:=round(greatest(0.75,least(1.4,coalesce(v_event,1))),3);
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
create or replace function nexora.settle_company_auction(p_auction_id text)
returns jsonb language plpgsql security definer set search_path=nexora,pg_temp as $$
declare
 v_auction company_auctions%rowtype; v_company companies%rowtype;
 v_seller_profile player_profiles%rowtype; v_winner_profile player_profiles%rowtype;
 v_seller_wallet wallets%rowtype; v_winner_wallet wallets%rowtype;
 v_winner text; v_now_ms bigint; v_owned integer; v_limit integer;
 v_sale_tx text; v_refund_tx text; v_seller_stats jsonb; v_winner_stats jsonb;
begin
 select * into v_auction from company_auctions where id=p_auction_id for update;
 if not found then return jsonb_build_object('ok',true,'status','missing'); end if;
 if v_auction.status<>'active' then return jsonb_build_object('ok',true,'status',v_auction.status,'replayed',true); end if;
 v_now_ms:=floor(extract(epoch from now())*1000)::bigint;
 if v_auction.ends_at>v_now_ms then return jsonb_build_object('ok',false,'status','not_due'); end if;
 select * into v_company from companies where id=v_auction.company_id for update;
 v_winner:=v_auction.highest_bidder_uid;
 if v_winner is null then
  if found and v_company.auction_id=p_auction_id then
   update companies set auction_id=null,auction_ends_at=null,auction_status=null,
    last_collected_at=now(),updated_at=now() where id=v_auction.company_id;
  end if;
  update company_auctions set status='ended_no_bids',settled_at=now(),updated_at=now() where id=p_auction_id;
  return jsonb_build_object('ok',true,'status','ended_no_bids');
 end if;
 select * into v_seller_profile from player_profiles where user_id=v_auction.seller_uid for update;
 select * into v_winner_profile from player_profiles where user_id=v_winner for update;
 -- Lock both wallets in stable order before reading balances.
 perform 1 from wallets where user_id in (v_auction.seller_uid,v_winner) order by user_id for update;
 select * into v_seller_wallet from wallets where user_id=v_auction.seller_uid;
 select * into v_winner_wallet from wallets where user_id=v_winner;
 if not found then
  -- The escrow remains in place; leave the auction active so a later run can retry.
  return jsonb_build_object('ok',false,'status','winner_wallet_missing_retry');
 end if;
 v_owned:=greatest(0,coalesce((v_winner_profile.stats->>'companiesOwned')::integer,0));
 v_limit:=least(10,1+floor(((greatest(1,least(100,v_winner_profile.level))-1)*9)::numeric/49)::integer);
 if not found or v_company.id is null or v_company.owner_uid<>v_auction.seller_uid or
    v_company.auction_id<>p_auction_id or v_seller_profile.user_id is null or
    v_seller_wallet.user_id is null or v_winner_profile.user_id is null or v_owned>=v_limit then
  v_refund_tx:='auc_refund_'||p_auction_id;
  update wallets set balance=balance+v_auction.current_bid,
   total_spent=greatest(0,total_spent-v_auction.current_bid),last_tx_id=v_refund_tx,updated_at=now()
  where user_id=v_winner;
  insert into transactions(id,from_uid,to_uid,amount,fee,net_amount,type,reference_id,description,status)
  values(v_refund_tx,'SYSTEM',v_winner,v_auction.current_bid,0,v_auction.current_bid,
   'company_auction_refund',p_auction_id,'Auction settlement refund for '||v_auction.company_name,'completed');
  if v_company.id is not null and v_company.auction_id=p_auction_id then
   update companies set auction_id=null,auction_ends_at=null,auction_status=null,
    last_collected_at=now(),updated_at=now() where id=v_auction.company_id;
  end if;
  update company_auctions set status='ended_refunded',settled_at=now(),updated_at=now() where id=p_auction_id;
  insert into notifications(id,user_id,title,body,type,is_read)
  values('auc_refund_notice_'||p_auction_id,v_winner,'تم رد ضمان المزاد',
   'تعذر إتمام نقل الشركة، وتم رد مبلغ المزايدة إلى محفظتك.','market',false);
  return jsonb_build_object('ok',true,'status','ended_refunded');
 end if;
 v_seller_stats:=coalesce(v_seller_profile.stats,'{}'::jsonb);
 v_winner_stats:=coalesce(v_winner_profile.stats,'{}'::jsonb);
 v_seller_stats:=jsonb_set(v_seller_stats,'{companiesOwned}',
  to_jsonb(greatest(0,coalesce((v_seller_stats->>'companiesOwned')::integer,0)-1)),true);
 v_winner_stats:=jsonb_set(v_winner_stats,'{companiesOwned}',to_jsonb(v_owned+1),true);
 v_sale_tx:='auc_sale_'||p_auction_id;
 update companies set owner_uid=v_winner,owner_name=coalesce(nullif(v_winner_profile.username,''),'Player'),
  auction_id=null,auction_ends_at=null,auction_status=null,last_collected_at=now(),updated_at=now()
 where id=v_auction.company_id;
 update player_profiles set stats=v_seller_stats,updated_at=now() where user_id=v_auction.seller_uid;
 update player_profiles set stats=v_winner_stats,updated_at=now() where user_id=v_winner;
 update wallets set balance=balance+v_auction.current_bid,total_earned=total_earned+v_auction.current_bid,
  last_tx_id=v_sale_tx,updated_at=now() where user_id=v_auction.seller_uid;
 insert into transactions(id,from_uid,to_uid,amount,fee,net_amount,type,reference_id,description,status)
 values(v_sale_tx,'SYSTEM',v_auction.seller_uid,v_auction.current_bid,0,v_auction.current_bid,
  'company_auction_sale',p_auction_id,'Sold company '||v_auction.company_name,'completed');
 update company_auctions set status='ended_sold',winner_uid=v_winner,winner_name=coalesce(nullif(v_winner_profile.username,''),'Player'),
  settled_at=now(),updated_at=now() where id=p_auction_id;
 insert into company_logs(id,company_id,owner_uid,action,amount,details)
 values('auc_sale_log_'||p_auction_id,v_auction.company_id,v_winner,'auction_purchase',-v_auction.current_bid,
  to_jsonb('Acquired '||v_auction.company_name||' from auction'));
 insert into notifications(id,user_id,title,body,type,is_read)
 values('auc_sold_seller_'||p_auction_id,v_auction.seller_uid,'تم بيع شركتك',
  'تم بيع '||v_auction.company_name||' بمبلغ '||v_auction.current_bid::text||' ووصل المبلغ إلى محفظتك.','market',false),
 ('auc_sold_winner_'||p_auction_id,v_winner,'فزت بمزاد الشركة',
  'أصبحت مالكًا لشركة '||v_auction.company_name||'.','market',false);
 insert into audit_logs(id,user_id,action,entity_type,entity_id,details)
 values('audit_auc_sale_'||p_auction_id,v_winner,'company_auction_settled','company',v_auction.company_id,
  jsonb_build_object('sellerUid',v_auction.seller_uid,'winnerUid',v_winner,'amount',v_auction.current_bid));
 return jsonb_build_object('ok',true,'status','ended_sold','winnerUid',v_winner,'amount',v_auction.current_bid);
end $$;

revoke all on function nexora.create_company_auction(text,text,bigint,uuid) from public,anon,authenticated;
revoke all on function nexora.settle_company_auction(text) from public,anon,authenticated;
grant execute on function nexora.create_company_auction(text,text,bigint,uuid) to service_role;
grant execute on function nexora.settle_company_auction(text) to service_role;
