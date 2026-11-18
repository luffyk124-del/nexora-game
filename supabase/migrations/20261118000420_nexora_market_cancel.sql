create or replace function nexora.cancel_market_listing(p_user_id text,p_listing_id text)
returns jsonb
language plpgsql security definer set search_path=nexora,pg_temp
as $$
declare v_listing market_listings%rowtype;
begin
  if p_user_id is null or length(p_user_id)<1 then raise exception 'UNAUTHENTICATED'; end if;
  select * into v_listing from market_listings where id=p_listing_id for update;
  if not found then raise exception 'LISTING_NOT_FOUND'; end if;
  if v_listing.seller_uid<>p_user_id or v_listing.status<>'active' then raise exception 'CANNOT_CANCEL_LISTING'; end if;
  update market_listings set remaining_qty=0,status='cancelled',updated_at=now() where id=p_listing_id;
  insert into inventory(user_id,item_id,quantity,last_listing_id,updated_at)
  values(p_user_id,v_listing.item_id,v_listing.remaining_qty,p_listing_id,now())
  on conflict(user_id,item_id) do update
    set quantity=inventory.quantity+excluded.quantity,last_listing_id=excluded.last_listing_id,updated_at=now();
  insert into audit_logs(id,user_id,action,entity_type,entity_id,details)
  values('cancel_'||p_listing_id,p_user_id,'market_listing_cancel','market_listing',p_listing_id,
         jsonb_build_object('returned_quantity',v_listing.remaining_qty));
  return jsonb_build_object('ok',true,'returnedQuantity',v_listing.remaining_qty);
end;
$$;
revoke all on function nexora.cancel_market_listing(text,text) from public,anon,authenticated;
grant execute on function nexora.cancel_market_listing(text,text) to service_role;
