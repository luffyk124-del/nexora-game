create or replace function nexora.buy_property(p_user_id text,p_name text,p_type text,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=nexora,pg_temp as $$
declare
 v_price integer; v_rent integer; v_maintenance integer; v_name text; v_property_id text; v_tx_id text;
 v_level integer; v_xp bigint; v_points integer; v_rep bigint; v_influence bigint; v_skills jsonb; v_stats jsonb; v_leadership numeric;
 v_balance numeric; v_spent numeric; v_next_xp bigint; v_next_level integer;
begin
 if p_user_id is null or length(p_user_id)<1 then raise exception 'UNAUTHENTICATED'; end if;
 if p_request_id is null then raise exception 'INVALID_REQUEST_ID'; end if;
 v_name:=trim(coalesce(p_name,''));
 if length(v_name)<2 or length(v_name)>48 then raise exception 'INVALID_NAME'; end if;
 select purchase_price,rent_per_hour,maintenance_per_hour into v_price,v_rent,v_maintenance
 from (values ('shop',950,115,25),('office',1650,205,45),('facility',2800,350,80)) p(type,purchase_price,rent_per_hour,maintenance_per_hour)
 where p.type=p_type;
 if not found then raise exception 'INVALID_PROPERTY_TYPE'; end if;
 v_property_id:='prop_'||p_user_id||'_'||p_request_id::text;
 v_tx_id:='property_buy_'||p_user_id||'_'||p_request_id::text;
 if exists(select 1 from transactions where id=v_tx_id and from_uid=p_user_id and type='property_buy') then
  return jsonb_build_object('ok',true,'propertyId',v_property_id,'replayed',true);
 end if;
 select level,xp,skill_points,reputation,influence,skills,stats into v_level,v_xp,v_points,v_rep,v_influence,v_skills,v_stats
 from player_profiles where user_id=p_user_id for update;
 if not found then raise exception 'ACCOUNT_NOT_FOUND'; end if;
 select balance,total_spent into v_balance,v_spent from wallets where user_id=p_user_id for update;
 if not found then raise exception 'ACCOUNT_NOT_FOUND'; end if;
 if v_balance<v_price then raise exception 'INSUFFICIENT_FUNDS'; end if;
 insert into properties(id,owner_uid,name,property_type,level,purchase_price,rent_per_hour,maintenance_per_hour,is_rented,last_collected_at)
 values(v_property_id,p_user_id,v_name,p_type,1,v_price,v_rent,v_maintenance,true,now());
 insert into transactions(id,from_uid,to_uid,amount,fee,net_amount,type,reference_id,description,status)
 values(v_tx_id,p_user_id,'SYSTEM',v_price,0,v_price,'property_buy',v_property_id,'Acquired property: '||v_name,'completed');
 update wallets set balance=balance-v_price,total_spent=total_spent+v_price,last_tx_id=v_tx_id,updated_at=now()
 where user_id=p_user_id;
 v_next_xp:=v_xp+90; v_next_level:=1;
 while v_next_level<100 loop
  if v_next_xp<(200+(v_next_level-1)*120) then exit; end if;
  v_next_xp:=v_next_xp-(200+(v_next_level-1)*120); v_next_level:=v_next_level+1;
 end loop;
 v_leadership:=coalesce((v_skills->>'leadership')::numeric,0);
 update player_profiles set xp=xp+90,level=v_next_level,
  skill_points=skill_points+greatest(0,(v_next_level-v_level)*2),
  reputation=reputation+round(8*(1+v_leadership*0.1))::bigint,
  influence=influence+round(6*(1+v_leadership*0.1))::bigint,
  stats=jsonb_set(v_stats,'{propertiesOwned}',to_jsonb(coalesce((v_stats->>'propertiesOwned')::integer,0)+1),true),
  updated_at=now() where user_id=p_user_id;
 return jsonb_build_object('ok',true,'propertyId',v_property_id,'replayed',false);
end $$;

create or replace function nexora.upgrade_property(p_user_id text,p_property_id text,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=nexora,pg_temp as $$
declare v_property properties%rowtype; v_balance numeric; v_spent numeric; v_cost integer; v_tx_id text;
begin
 if p_user_id is null or p_request_id is null then raise exception 'INVALID_REQUEST'; end if;
 v_tx_id:='property_upgrade_'||p_user_id||'_'||p_request_id::text;
 if exists(select 1 from transactions where id=v_tx_id and from_uid=p_user_id and type='property_upgrade') then
  return jsonb_build_object('ok',true,'replayed',true);
 end if;
 select * into v_property from properties where id=p_property_id for update;
 if not found then raise exception 'PROPERTY_NOT_FOUND'; end if;
 if v_property.owner_uid<>p_user_id then raise exception 'UNAUTHORIZED'; end if;
 if v_property.level>=15 then raise exception 'MAX_LEVEL'; end if;
 select balance,total_spent into v_balance,v_spent from wallets where user_id=p_user_id for update;
 if not found then raise exception 'ACCOUNT_NOT_FOUND'; end if;
 v_cost:=v_property.level*480;
 if v_balance<v_cost then raise exception 'INSUFFICIENT_FUNDS'; end if;
 insert into transactions(id,from_uid,to_uid,amount,fee,net_amount,type,reference_id,description,status)
 values(v_tx_id,p_user_id,'SYSTEM',v_cost,0,v_cost,'property_upgrade',p_property_id,
  'Upgraded property '||v_property.name||' to Lv.'||(v_property.level+1)::text,'completed');
 update wallets set balance=balance-v_cost,total_spent=total_spent+v_cost,last_tx_id=v_tx_id,updated_at=now()
 where user_id=p_user_id;
 update properties set level=level+1,updated_at=now() where id=p_property_id;
 return jsonb_build_object('ok',true,'level',v_property.level+1,'cost',v_cost,'replayed',false);
end $$;

create or replace function nexora.collect_property_rent(p_user_id text,p_property_id text,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=nexora,pg_temp as $$
declare
 v_property properties%rowtype; v_negotiation numeric; v_level integer; v_xp bigint; v_points integer;
 v_rep bigint; v_influence bigint; v_skills jsonb; v_stats jsonb; v_balance numeric; v_earned numeric;
 v_gross numeric; v_maintenance numeric; v_net numeric; v_elapsed numeric; v_payout integer; v_tx_id text;
begin
 if p_user_id is null or p_request_id is null then raise exception 'INVALID_REQUEST'; end if;
 v_tx_id:='property_collect_'||p_user_id||'_'||p_request_id::text;
 if exists(select 1 from transactions where id=v_tx_id and to_uid=p_user_id and type='property_collect') then
  return jsonb_build_object('ok',true,'payout',(select amount from transactions where id=v_tx_id),'replayed',true);
 end if;
 select * into v_property from properties where id=p_property_id for update;
 if not found then raise exception 'PROPERTY_NOT_FOUND'; end if;
 if v_property.owner_uid<>p_user_id then raise exception 'UNAUTHORIZED'; end if;
 if not v_property.is_rented then raise exception 'PROPERTY_VACANT'; end if;
 select level,xp,skill_points,reputation,influence,skills,stats into v_level,v_xp,v_points,v_rep,v_influence,v_skills,v_stats
 from player_profiles where user_id=p_user_id;
 if not found then raise exception 'ACCOUNT_NOT_FOUND'; end if;
 select balance,total_earned into v_balance,v_earned from wallets where user_id=p_user_id for update;
 if not found then raise exception 'ACCOUNT_NOT_FOUND'; end if;
 if now()-v_property.last_collected_at<interval '1 minute' then raise exception 'NOTHING_TO_COLLECT'; end if;
 v_negotiation:=coalesce((v_skills->>'negotiation')::numeric,0);
 v_gross:=round(v_property.rent_per_hour*(1+(v_property.level-1)*0.28)*(1+greatest(0,v_negotiation)*0.07));
 v_maintenance:=round(v_property.maintenance_per_hour*(1+(v_property.level-1)*0.15));
 v_net:=case when v_property.is_rented then v_gross else 0 end-v_maintenance;
 if v_net<=0 then raise exception 'PROPERTY_VACANT'; end if;
 v_elapsed:=least(12,extract(epoch from (now()-v_property.last_collected_at))/3600.0);
 v_payout:=least(15000,greatest(0,floor(v_net*v_elapsed)::integer));
 if v_payout<1 then raise exception 'NOTHING_TO_COLLECT'; end if;
 insert into transactions(id,from_uid,to_uid,amount,fee,net_amount,type,reference_id,description,status)
 values(v_tx_id,'SYSTEM',p_user_id,v_payout,0,v_payout,'property_collect',p_property_id,
  'Collected rent from '||v_property.name,'completed');
 update wallets set balance=balance+v_payout,total_earned=total_earned+v_payout,last_tx_id=v_tx_id,updated_at=now()
 where user_id=p_user_id;
 update properties set last_collected_at=now(),updated_at=now() where id=p_property_id;
 return jsonb_build_object('ok',true,'payout',v_payout,'replayed',false);
end $$;

create or replace function nexora.toggle_property_lease(p_user_id text,p_property_id text,p_is_rented boolean)
returns jsonb language plpgsql security definer set search_path=nexora,pg_temp as $$
begin
 if p_user_id is null then raise exception 'UNAUTHENTICATED'; end if;
 update properties set is_rented=p_is_rented,updated_at=now()
 where id=p_property_id and owner_uid=p_user_id;
 if not found then
  if exists(select 1 from properties where id=p_property_id) then raise exception 'UNAUTHORIZED'; end if;
  raise exception 'PROPERTY_NOT_FOUND';
 end if;
 return jsonb_build_object('ok',true,'isRented',p_is_rented);
end $$;

revoke all on function nexora.buy_property(text,text,text,uuid) from public,anon,authenticated;
revoke all on function nexora.upgrade_property(text,text,uuid) from public,anon,authenticated;
revoke all on function nexora.collect_property_rent(text,text,uuid) from public,anon,authenticated;
revoke all on function nexora.toggle_property_lease(text,text,boolean) from public,anon,authenticated;
grant execute on function nexora.buy_property(text,text,text,uuid) to service_role;
grant execute on function nexora.upgrade_property(text,text,uuid) to service_role;
grant execute on function nexora.collect_property_rent(text,text,uuid) to service_role;
grant execute on function nexora.toggle_property_lease(text,text,boolean) to service_role;
