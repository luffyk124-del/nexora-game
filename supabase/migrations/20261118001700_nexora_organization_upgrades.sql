create or replace function nexora.start_organization_upgrade(p_user_id text,p_org_id text)
returns jsonb language plpgsql security definer set search_path=nexora,pg_temp as $$
declare v_org organizations%rowtype; v_member organization_members%rowtype; v_level integer; v_finance integer; v_engineering integer;
 v_cost integer; v_target integer; v_now bigint; v_ends bigint; v_username text; v_tx text;
begin
 select * into v_org from organizations where id=p_org_id for update;
 if not found then raise exception 'NOT_FOUND'; end if;
 select * into v_member from organization_members where org_id=p_org_id and user_id=p_user_id;
 if not found then raise exception 'NOT_FOUND'; end if;
 if v_member.role not in ('leader','deputy') then raise exception 'UNAUTHORIZED'; end if;
 v_now:=floor(extract(epoch from now())*1000)::bigint;
 if coalesce(v_org.upgrade_ends_at,0)>v_now then raise exception 'UPGRADE_IN_PROGRESS'; end if;
 v_level:=greatest(1,coalesce(v_org.level,1));
 if v_level>=10 then raise exception 'MAX_LEVEL'; end if;
 v_finance:=least(10,greatest(0,coalesce((v_org.research->>'finance')::integer,0)));
 v_engineering:=least(10,greatest(0,coalesce((v_org.research->>'engineering')::integer,0)));
 v_cost:=round(12000*v_level*v_level*(1-v_finance*0.005))::integer;
 if v_org.treasury_balance<v_cost then raise exception 'INSUFFICIENT_TREASURY'; end if;
 v_target:=v_level+1;
 v_ends:=v_now+round(28800000*power(1.5::numeric,greatest(0,v_target-2))*(1-v_engineering*0.005))::bigint;
 v_tx:='org_upgrade_'||p_org_id||'_'||p_user_id||'_'||v_now::text;
 update organizations set treasury_balance=treasury_balance-v_cost,upgrade_started_at=v_now,
  upgrade_ends_at=v_ends,upgrade_target_level=v_target,updated_at=now() where id=p_org_id;
 insert into organization_transactions(id,org_id,user_id,username,type,amount,note)
 values(v_tx,p_org_id,p_user_id,coalesce(v_member.username,'Member'),'upgrade',v_cost,
  'Started organization upgrade to Lv.'||v_target::text);
 return jsonb_build_object('ok',true,'targetLevel',v_target,'endsAt',v_ends,'cost',v_cost,'durationMs',v_ends-v_now);
end $$;

create or replace function nexora.complete_organization_upgrade(p_user_id text,p_org_id text)
returns jsonb language plpgsql security definer set search_path=nexora,pg_temp as $$
declare v_org organizations%rowtype; v_member organization_members%rowtype; v_now bigint; v_target integer; v_capacity integer;
begin
 select * into v_org from organizations where id=p_org_id for update;
 if not found then raise exception 'NOT_FOUND'; end if;
 select * into v_member from organization_members where org_id=p_org_id and user_id=p_user_id;
 if not found then raise exception 'NOT_FOUND'; end if;
 v_now:=floor(extract(epoch from now())*1000)::bigint;
 v_target:=coalesce(v_org.upgrade_target_level,0);
 if coalesce(v_org.upgrade_ends_at,0)=0 or v_target=0 or v_now<v_org.upgrade_ends_at then raise exception 'UPGRADE_NOT_READY'; end if;
 v_capacity:=least(80,20+(v_target-1)*5+coalesce((v_org.research->>'expansion')::integer,0));
 update organizations set level=v_target,member_capacity=v_capacity,upgrade_ends_at=null,
  upgrade_target_level=null,upgrade_started_at=null,updated_at=now() where id=p_org_id;
 return jsonb_build_object('ok',true,'level',v_target,'memberCapacity',v_capacity);
end $$;

create or replace function nexora.research_organization(p_user_id text,p_org_id text,p_research_id text)
returns jsonb language plpgsql security definer set search_path=nexora,pg_temp as $$
declare v_org organizations%rowtype; v_member organization_members%rowtype; v_base integer; v_level integer;
 v_cost integer; v_research jsonb; v_capacity integer; v_tx text;
begin
 select * into v_org from organizations where id=p_org_id for update;
 if not found then raise exception 'NOT_FOUND'; end if;
 select * into v_member from organization_members where org_id=p_org_id and user_id=p_user_id;
 if not found then raise exception 'NOT_FOUND'; end if;
 if v_member.role not in ('leader','deputy') then raise exception 'UNAUTHORIZED'; end if;
 v_base:=case p_research_id when 'commerce' then 25000 when 'engineering' then 30000
  when 'expansion' then 20000 when 'finance' then 35000 when 'diplomacy' then 18000 else 0 end;
 if v_base=0 then raise exception 'INVALID_RESEARCH'; end if;
 v_level:=coalesce((v_org.research->>p_research_id)::integer,0);
 if v_level>=10 then raise exception 'RESEARCH_MAX_LEVEL'; end if;
 v_cost:=v_base*(v_level+1)*(v_level+1);
 if v_org.treasury_balance<v_cost then raise exception 'INSUFFICIENT_TREASURY'; end if;
 v_research:=jsonb_set(coalesce(v_org.research,'{}'::jsonb),array[p_research_id],to_jsonb(v_level+1),true);
 if p_research_id='expansion' then
  v_capacity:=least(80,20+(greatest(1,v_org.level)-1)*5+v_level+1);
 else
  v_capacity:=coalesce(v_org.member_capacity,least(70,20+(greatest(1,v_org.level)-1)*5));
 end if;
 v_tx:='org_research_'||p_org_id||'_'||p_research_id||'_'||(v_level+1)::text||'_'||extract(epoch from now())::bigint::text;
 update organizations set treasury_balance=treasury_balance-v_cost,research=v_research,member_capacity=v_capacity,updated_at=now()
 where id=p_org_id;
 insert into organization_transactions(id,org_id,user_id,username,type,amount,note)
 values(v_tx,p_org_id,p_user_id,coalesce(v_member.username,'Member'),'upgrade',v_cost,
  'Research '||p_research_id||' advanced to Lv.'||(v_level+1)::text);
 return jsonb_build_object('ok',true,'researchId',p_research_id,'level',v_level+1,'cost',v_cost,'memberCapacity',v_capacity);
end $$;

revoke all on function nexora.start_organization_upgrade(text,text) from public,anon,authenticated;
revoke all on function nexora.complete_organization_upgrade(text,text) from public,anon,authenticated;
revoke all on function nexora.research_organization(text,text,text) from public,anon,authenticated;
grant execute on function nexora.start_organization_upgrade(text,text) to service_role;
grant execute on function nexora.complete_organization_upgrade(text,text) to service_role;
grant execute on function nexora.research_organization(text,text,text) to service_role;
