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
