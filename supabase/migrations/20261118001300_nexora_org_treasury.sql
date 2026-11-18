create or replace function nexora.deposit_org_treasury(p_user_id text,p_org_id text,p_amount bigint,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=nexora,pg_temp as $$
declare v_org organizations%rowtype; v_username text; v_balance numeric; v_tx_id text; v_org_tx_id text; v_bonus integer;
begin
 if p_user_id is null or p_request_id is null then raise exception 'INVALID_REQUEST'; end if;
 if p_amount is null or p_amount<1 or p_amount>10000000 then raise exception 'INVALID_AMOUNT'; end if;
 v_tx_id:='org_deposit_'||p_user_id||'_'||p_request_id::text;
 v_org_tx_id:='orgtx_'||p_user_id||'_'||p_request_id::text;
 if exists(select 1 from transactions where id=v_tx_id and from_uid=p_user_id and type='org_deposit') then
  return jsonb_build_object('ok',true,'transactionId',v_tx_id,'replayed',true);
 end if;
 select * into v_org from organizations where id=p_org_id for update;
 if not found then raise exception 'NOT_FOUND'; end if;
 if not exists(select 1 from organization_members where org_id=p_org_id and user_id=p_user_id) then raise exception 'UNAUTHORIZED'; end if;
 select username into v_username from player_profiles where user_id=p_user_id;
 select balance into v_balance from wallets where user_id=p_user_id for update;
 if not found then raise exception 'NOT_FOUND'; end if;
 if v_balance<p_amount then raise exception 'INSUFFICIENT_FUNDS'; end if;
 v_bonus:=greatest(1,floor((p_amount/100.0)*(1+least(10,coalesce((v_org.research->>'diplomacy')::integer,0))*0.01))::integer);
 insert into transactions(id,from_uid,to_uid,amount,fee,net_amount,type,reference_id,description,status)
 values(v_tx_id,p_user_id,'ORG',p_amount,0,p_amount,'org_deposit',p_org_id,'Org treasury deposit ['||v_org.tag||']','completed');
 update wallets set balance=balance-p_amount,total_spent=total_spent+p_amount,last_tx_id=v_tx_id,updated_at=now()
 where user_id=p_user_id;
 update organizations set treasury_balance=treasury_balance+p_amount,reputation=reputation+v_bonus,updated_at=now()
 where id=p_org_id;
 insert into organization_transactions(id,org_id,user_id,username,type,amount,note)
 values(v_org_tx_id,p_org_id,p_user_id,coalesce(v_username,'Player'),'deposit',p_amount,'Deposit by '||coalesce(v_username,'Player'));
 return jsonb_build_object('ok',true,'transactionId',v_tx_id,'reputationGain',v_bonus,'replayed',false);
end $$;

create or replace function nexora.withdraw_org_treasury(p_user_id text,p_org_id text,p_amount bigint,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=nexora,pg_temp as $$
declare v_org organizations%rowtype; v_member organization_members%rowtype; v_username text; v_balance numeric; v_earned numeric; v_tx_id text; v_org_tx_id text;
begin
 if p_user_id is null or p_request_id is null then raise exception 'INVALID_REQUEST'; end if;
 if p_amount is null or p_amount<1 or p_amount>10000000 then raise exception 'INVALID_AMOUNT'; end if;
 v_tx_id:='org_withdraw_'||p_user_id||'_'||p_request_id::text;
 v_org_tx_id:='orgtx_'||p_user_id||'_'||p_request_id::text;
 if exists(select 1 from transactions where id=v_tx_id and to_uid=p_user_id and type='org_withdraw') then
  return jsonb_build_object('ok',true,'transactionId',v_tx_id,'replayed',true);
 end if;
 select * into v_org from organizations where id=p_org_id for update;
 if not found then raise exception 'NOT_FOUND'; end if;
 select * into v_member from organization_members where org_id=p_org_id and user_id=p_user_id;
 if not found then raise exception 'UNAUTHORIZED'; end if;
 if v_member.role<>'leader' and v_member.role<>'deputy'
   and not (v_member.permissions @> '["manage_treasury"]'::jsonb) then
  raise exception 'UNAUTHORIZED';
 end if;
 select username into v_username from player_profiles where user_id=p_user_id;
 select balance,total_earned into v_balance,v_earned from wallets where user_id=p_user_id for update;
 if not found then raise exception 'NOT_FOUND'; end if;
 if v_org.treasury_balance<p_amount then raise exception 'INSUFFICIENT_TREASURY'; end if;
 insert into transactions(id,from_uid,to_uid,amount,fee,net_amount,type,reference_id,description,status)
 values(v_tx_id,'ORG',p_user_id,p_amount,0,p_amount,'org_withdraw',p_org_id,'Org treasury withdrawal ['||v_org.tag||']','completed');
 update wallets set balance=balance+p_amount,total_earned=total_earned+p_amount,last_tx_id=v_tx_id,updated_at=now()
 where user_id=p_user_id;
 update organizations set treasury_balance=treasury_balance-p_amount,updated_at=now() where id=p_org_id;
 insert into organization_transactions(id,org_id,user_id,username,type,amount,note)
 values(v_org_tx_id,p_org_id,p_user_id,coalesce(v_username,'Player'),'withdraw',p_amount,'Withdrawal by '||coalesce(v_username,'Player'));
 return jsonb_build_object('ok',true,'transactionId',v_tx_id,'replayed',false);
end $$;

revoke all on function nexora.deposit_org_treasury(text,text,bigint,uuid) from public,anon,authenticated;
revoke all on function nexora.withdraw_org_treasury(text,text,bigint,uuid) from public,anon,authenticated;
grant execute on function nexora.deposit_org_treasury(text,text,bigint,uuid) to service_role;
grant execute on function nexora.withdraw_org_treasury(text,text,bigint,uuid) to service_role;
