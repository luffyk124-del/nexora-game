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
