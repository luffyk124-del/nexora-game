create or replace function nexora.manufacture_recipe(p_user_id text,p_recipe_id text,p_batch_quantity integer,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=nexora,pg_temp as $$
declare
 v_output text; v_output_qty integer; v_processing_cost integer; v_xp_reward integer; v_required_skill integer; v_inputs jsonb;
 v_level integer; v_xp bigint; v_points integer; v_rep bigint; v_influence bigint; v_skills jsonb; v_stats jsonb;
 v_industry integer; v_leadership numeric; v_discount numeric; v_cost integer; v_qty bigint;
 v_next_xp bigint; v_next_level integer; v_tx_id text; v_entry jsonb; v_item text; v_required integer;
begin
 if p_user_id is null or length(p_user_id)<1 then raise exception 'UNAUTHENTICATED'; end if;
 if p_request_id is null then raise exception 'INVALID_REQUEST_ID'; end if;
 if p_batch_quantity is null or p_batch_quantity<1 or p_batch_quantity>999 then raise exception 'INVALID_QUANTITY'; end if;
 select output_item_id,output_qty,processing_cost,xp_reward,required_industry_skill,inputs
 into v_output,v_output_qty,v_processing_cost,v_xp_reward,v_required_skill,v_inputs
 from (values
 ('rec_microchips','microchips',2,40,45,0,'[{"itemId":"silicon_ore","qty":2},{"itemId":"copper_wire","qty":2}]'::jsonb),
 ('rec_precision_frame','precision_frame',2,50,55,0,'[{"itemId":"crude_alloy","qty":2},{"itemId":"carbon_fiber","qty":1}]'::jsonb),
 ('rec_synth_polymer','synth_polymer',2,60,65,1,'[{"itemId":"energy_cells","qty":2},{"itemId":"rare_minerals","qty":1}]'::jsonb),
 ('rec_quantum_server','quantum_server',1,90,110,1,'[{"itemId":"microchips","qty":2},{"itemId":"energy_cells","qty":1}]'::jsonb),
 ('rec_logistics_drone','logistics_drone',1,110,125,2,'[{"itemId":"precision_frame","qty":2},{"itemId":"microchips","qty":1}]'::jsonb),
 ('rec_bio_module','bio_module',1,125,140,2,'[{"itemId":"synth_polymer","qty":2},{"itemId":"rare_minerals","qty":2}]'::jsonb)
 ) as r(id,output_item_id,output_qty,processing_cost,xp_reward,required_industry_skill,inputs)
 where r.id=p_recipe_id;
 if not found then raise exception 'INVALID_RECIPE'; end if;

 v_tx_id:='manufacture_'||p_user_id||'_'||p_request_id::text;
 if exists(select 1 from transactions where id=v_tx_id and from_uid=p_user_id and type='manufacturing') then
  return jsonb_build_object('ok',true,'transactionId',v_tx_id,'replayed',true);
 end if;
 select level,xp,skill_points,reputation,influence,skills,stats
 into v_level,v_xp,v_points,v_rep,v_influence,v_skills,v_stats
 from player_profiles where user_id=p_user_id for update;
 if not found then raise exception 'ACCOUNT_NOT_FOUND'; end if;
 v_industry:=coalesce((v_skills->>'industry')::integer,0);
 v_leadership:=coalesce((v_skills->>'leadership')::numeric,0);
 if v_industry<v_required_skill then raise exception 'INDUSTRY_SKILL_TOO_LOW'; end if;
 v_discount:=least(0.45,greatest(0,v_industry)*0.06);
 v_cost:=greatest(10,round(v_processing_cost*(1-v_discount))::integer)*p_batch_quantity;
 if v_cost>10000000 then raise exception 'INVALID_TOTAL'; end if;
 perform 1 from wallets where user_id=p_user_id for update;
 if not found then raise exception 'ACCOUNT_NOT_FOUND'; end if;
 -- Lock all input rows in a stable order before validating/decrementing.
 for v_entry in select value from jsonb_array_elements(v_inputs) order by value->>'itemId' loop
  v_item:=v_entry->>'itemId';
  perform 1 from inventory where user_id=p_user_id and item_id=v_item for update;
  if not found then raise exception 'MISSING_INPUTS'; end if;
 end loop;
 for v_entry in select value from jsonb_array_elements(v_inputs) loop
  v_item:=v_entry->>'itemId'; v_required:=(v_entry->>'qty')::integer*p_batch_quantity;
  select quantity into v_qty from inventory where user_id=p_user_id and item_id=v_item;
  if not found or v_qty<v_required then raise exception 'MISSING_INPUTS'; end if;
 end loop;
 if (select balance from wallets where user_id=p_user_id)<v_cost then raise exception 'INSUFFICIENT_FUNDS'; end if;

 insert into transactions(id,from_uid,to_uid,amount,fee,net_amount,type,reference_id,description,status)
 values(v_tx_id,p_user_id,'SYSTEM',v_cost,0,v_cost,'manufacturing',p_recipe_id,
  'Manufactured '||(v_output_qty*p_batch_quantity)::text||'x '||v_output||' ('||p_batch_quantity::text||' batches)','completed');
 update wallets set balance=balance-v_cost,total_spent=total_spent+v_cost,last_tx_id=v_tx_id,updated_at=now()
 where user_id=p_user_id;
 for v_entry in select value from jsonb_array_elements(v_inputs) loop
  v_item:=v_entry->>'itemId'; v_required:=(v_entry->>'qty')::integer*p_batch_quantity;
  update inventory set quantity=quantity-v_required,updated_at=now()
  where user_id=p_user_id and item_id=v_item;
 end loop;
 insert into inventory(user_id,item_id,quantity,updated_at)
 values(p_user_id,v_output,v_output_qty*p_batch_quantity,now())
 on conflict(user_id,item_id) do update set quantity=inventory.quantity+excluded.quantity,updated_at=now();

 v_next_xp:=v_xp+(v_xp_reward*p_batch_quantity); v_next_level:=1;
 while v_next_level<100 loop
  if v_next_xp<(200+(v_next_level-1)*120) then exit; end if;
  v_next_xp:=v_next_xp-(200+(v_next_level-1)*120); v_next_level:=v_next_level+1;
 end loop;
 update player_profiles set xp=xp+(v_xp_reward*p_batch_quantity),level=v_next_level,
  skill_points=skill_points+greatest(0,(v_next_level-v_level)*2),
  reputation=reputation+round(3*(1+v_leadership*0.1))::bigint,
  influence=influence+round(2*(1+v_leadership*0.1))::bigint,
  stats=jsonb_set(v_stats,'{totalProduced}',to_jsonb(coalesce((v_stats->>'totalProduced')::integer,0)+(v_output_qty*p_batch_quantity)),true),
  updated_at=now() where user_id=p_user_id;
 insert into audit_logs(id,user_id,action,entity_type,entity_id,details)
 values('audit_'||v_tx_id,p_user_id,'manufacture_recipe','manufacturing',p_recipe_id,
  jsonb_build_object('batch_quantity',p_batch_quantity,'output_item',v_output,'output_quantity',v_output_qty*p_batch_quantity,'cost',v_cost));
 return jsonb_build_object('ok',true,'cost',v_cost,'outputItemId',v_output,'outputQuantity',v_output_qty*p_batch_quantity,'replayed',false);
end $$;
revoke all on function nexora.manufacture_recipe(text,text,integer,uuid) from public,anon,authenticated;
grant execute on function nexora.manufacture_recipe(text,text,integer,uuid) to service_role;
