create or replace function nexora.create_organization(
 p_user_id text,p_name text,p_tag text,p_description text,p_request_id uuid
) returns jsonb language plpgsql security definer set search_path=nexora,pg_temp as $$
declare
 v_name text; v_tag text; v_desc text; v_profile player_profiles%rowtype; v_balance numeric;
 v_org_id text; v_tx text; v_next_xp bigint; v_next_level integer; v_leadership numeric;
begin
 if p_user_id is null or p_request_id is null then raise exception 'INVALID_REQUEST'; end if;
 v_name:=trim(coalesce(p_name,'')); v_tag:=upper(trim(coalesce(p_tag,''))); v_desc:=left(trim(coalesce(p_description,'')),240);
 if length(v_name)<3 or length(v_name)>40 then raise exception 'INVALID_NAME'; end if;
 if length(v_tag)<2 or length(v_tag)>6 or v_tag !~ '^[A-Z0-9]+$' then raise exception 'INVALID_TAG'; end if;
 v_org_id:='org_'||p_user_id||'_'||p_request_id::text;
 v_tx:='org_create_'||p_user_id||'_'||p_request_id::text;
 if exists(select 1 from organizations where id=v_org_id) then return jsonb_build_object('ok',true,'orgId',v_org_id,'replayed',true); end if;
 select * into v_profile from player_profiles where user_id=p_user_id for update;
 if not found then raise exception 'ACCOUNT_NOT_FOUND'; end if;
 if v_profile.org_id is not null and v_profile.org_id<>'' then raise exception 'ALREADY_IN_ORG'; end if;
 select balance into v_balance from wallets where user_id=p_user_id for update;
 if not found then raise exception 'ACCOUNT_NOT_FOUND'; end if;
 if v_balance<1000 then raise exception 'INSUFFICIENT_FUNDS'; end if;
 v_next_xp:=v_profile.xp+150; v_next_level:=1;
 while v_next_level<100 loop
  if v_next_xp<(200+(v_next_level-1)*120) then exit; end if;
  v_next_xp:=v_next_xp-(200+(v_next_level-1)*120); v_next_level:=v_next_level+1;
 end loop;
 v_leadership:=greatest(0,coalesce((v_profile.skills->>'leadership')::numeric,0));
 insert into organizations(id,name,tag,description,leader_uid,leader_name,treasury_balance,member_count,reputation,level,join_mode,research,member_capacity)
 values(v_org_id,v_name,v_tag,v_desc,p_user_id,v_profile.username,0,1,15,1,'request','{}'::jsonb,20);
 insert into organization_members(org_id,user_id,username,role,permissions)
 values(v_org_id,p_user_id,v_profile.username,'leader','["manage_members","manage_roles","manage_treasury","manage_org"]'::jsonb);
 insert into transactions(id,from_uid,to_uid,amount,fee,net_amount,type,reference_id,description,status)
 values(v_tx,p_user_id,'SYSTEM',1000,0,1000,'org_create',v_org_id,
  'Founded organization ['||v_tag||'] '||v_name,'completed');
 update wallets set balance=balance-1000,total_spent=total_spent+1000,last_tx_id=v_tx,updated_at=now()
 where user_id=p_user_id;
 update player_profiles set xp=xp+150,level=v_next_level,
  skill_points=skill_points+greatest(0,(v_next_level-v_profile.level)*2),
  reputation=reputation+round(20*(1+v_leadership*0.1))::bigint,
  influence=influence+round(25*(1+v_leadership*0.1))::bigint,
  org_id=v_org_id,updated_at=now() where user_id=p_user_id;
 return jsonb_build_object('ok',true,'orgId',v_org_id,'replayed',false);
exception when unique_violation then
 raise exception 'TAG_TAKEN';
end $$;
revoke all on function nexora.create_organization(text,text,text,text,uuid) from public,anon,authenticated;
grant execute on function nexora.create_organization(text,text,text,text,uuid) to service_role;
