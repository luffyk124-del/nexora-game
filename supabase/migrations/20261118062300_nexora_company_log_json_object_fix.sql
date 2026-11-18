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
  jsonb_build_object('message','Acquired '||v_auction.company_name||' from auction'));
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
grant execute on function nexora.settle_company_auction(text) to service_role;revoke all on function nexora.settle_company_auction(text) from public,anon,authenticated;
grant execute on function nexora.settle_company_auction(text) to service_role;
