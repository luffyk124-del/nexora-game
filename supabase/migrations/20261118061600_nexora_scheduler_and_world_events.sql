-- NEXORA scheduler: DB-native world-event rotation and auction settlement.
create table if not exists nexora.scheduler_flags (
 job_key text primary key,
 enabled boolean not null default false,
 updated_at timestamptz not null default now()
);
insert into nexora.scheduler_flags(job_key,enabled)
values ('company_auction_settlement',false),('world_event_rotation',false)
on conflict(job_key) do nothing;
alter table nexora.scheduler_flags enable row level security;
revoke all on table nexora.scheduler_flags from public,anon,authenticated;

create or replace function nexora.rotate_world_events()
returns jsonb language plpgsql security definer set search_path=nexora,pg_temp as $$
declare
 v_now timestamptz:=now(); v_now_ms bigint; v_offset integer; v_count integer:=6;
 v_deactivate text[]:=array[]::text[]; v_just_expired text[]:=array[]::text[];
 v_kept_ids text[]:=array[]::text[]; v_used_groups text[]:=array[]::text[];
 v_activated text[]:=array[]::text[]; v_slots integer; v_active record; v_tpl record;
begin
 v_now_ms:=floor(extract(epoch from v_now)*1000)::bigint;
 v_offset:=mod(floor(v_now_ms/21600000)::bigint,v_count)::integer;
 for v_active in
  select id,coalesce(nullif(stack_group,''),id) as grp,
   (ends_at is not null and floor(extract(epoch from ends_at)*1000)::bigint<=v_now_ms) as expired
  from world_events where active=true order by id
 loop
  if v_active.expired then
   v_deactivate:=array_append(v_deactivate,v_active.id);
   v_just_expired:=array_append(v_just_expired,v_active.id);
  elsif cardinality(v_kept_ids)>=3 or v_active.grp=any(v_used_groups) then
   v_deactivate:=array_append(v_deactivate,v_active.id);
  else
   v_kept_ids:=array_append(v_kept_ids,v_active.id);
   v_used_groups:=array_append(v_used_groups,v_active.grp);
  end if;
 end loop;
 v_slots:=greatest(0,3-cardinality(v_kept_ids));
 if v_slots>0 then
  for v_tpl in
   select * from (values
    (0,'evt_silicon_boom','طفرة الطلب على الرقائق','Silicon & Microchip Demand Surge',
     'ارتفاع الطلب العالمي على أشباه الموصلات يرفع تقييم الرقائق (+18%) وعوائد شركات التقنية (+15%).',
     'Global semiconductor demand boosts Microchip index (+18%) and Tech company yields (+15%).',
     'demand_surge','microchips',array['tech']::text[],1.18::numeric,1.15::numeric,0::numeric,'sector_tech',24),
    (1,'evt_raw_shortage','شح المعادن والخامات','Raw Material Supply Squeeze',
     'تباطؤ الإمدادات العالمية يرفع قيمة خام السيليكون (+22%) ويضغط على هوامش التصنيع (-6%).',
     'Global extraction bottleneck elevates Silicon Ore value (+22%) while tightening factory margins (-6%).',
     'supply_shortage','silicon_ore',array['manufacturing']::text[],1.22::numeric,0.94::numeric,0.01::numeric,'supply_raw',18),
    (2,'evt_industrial_surge','ذروة الطلب الصناعي','Industrial Compute Expansion',
     'موجة توسع في مراكز البيانات ترفع قيمة الخادم الكمومي (+15%) وعائد قطاعي التصنيع والتقنية (+18%).',
     'Data-center expansion lifts Quantum Server prices (+15%) and Tech/Manufacturing output (+18%).',
     'industrial_boom','quantum_server',array['manufacturing','tech']::text[],1.15::numeric,1.18::numeric,0::numeric,'sector_industry',24),
    (3,'evt_service_crisis','تباطؤ قطاع الخدمات','Service Sector Contraction',
     'انخفاض مؤقت في الإنفاق المؤسسي يخفض عوائد قطاعي الخدمات والتجارة (-15%) ويرفع الرسوم 1%.',
     'Temporary corporate spending pullback trims Services & Trade yields (-15%) and nudges fees +1%.',
     'service_crisis','',array['services','trade']::text[],0.92::numeric,0.85::numeric,0.01::numeric,'macro_demand',12),
    (4,'evt_tax_holiday','حافز التجارة الحرة','Free Trade Tax Incentive',
     'خفض مؤقت لضريبة معاملات السوق بمقدار 1% مع دفعة تشجيعية لقطاع التجارة (+8%).',
     'Temporary 1% market transaction tax cut with a +8% Trade sector liquidity boost.',
     'tax_cut','',array['trade']::text[],1.0::numeric,1.08::numeric,-0.01::numeric,'fiscal_policy',24),
    (5,'evt_logistics_boom','ازدهار النقل والإمداد','Global Logistics & Freight Boom',
     'تسارع حركة الشحن العالمية يرفع قيمة طائرات الشحن (+14%) وعوائد النقل والتجارة (+16%).',
     'Surging freight corridors boost Logistics Drone valuations (+14%) and Logistics/Trade yields (+16%).',
     'logistics_boom','logistics_drone',array['logistics','trade']::text[],1.14::numeric,1.16::numeric,0::numeric,'sector_logistics',24)
   ) as t(rotation_index,id,title_ar,title_en,description_ar,description_en,effect_type,target_item_id,
    affected_sectors,price_multiplier,revenue_multiplier,tax_delta,stack_group,duration_hours)
   order by case when t.id=any(v_just_expired) then 1 else 0 end,
    mod(t.rotation_index-v_offset+v_count,v_count)
  loop
   exit when cardinality(v_activated)>=v_slots;
   if v_tpl.id=any(v_kept_ids) or v_tpl.stack_group=any(v_used_groups) then continue; end if;
   v_kept_ids:=array_append(v_kept_ids,v_tpl.id);
   v_used_groups:=array_append(v_used_groups,v_tpl.stack_group);
   v_activated:=array_append(v_activated,v_tpl.id);
   insert into world_events(id,title_ar,title_en,effect_type,target_item_id,price_multiplier,
    tax_delta,active,starts_at,ends_at,created_at,description_ar,description_en,
    affected_sectors,revenue_multiplier,stack_group)
   values(v_tpl.id,v_tpl.title_ar,v_tpl.title_en,v_tpl.effect_type,v_tpl.target_item_id,
    v_tpl.price_multiplier,v_tpl.tax_delta,true,v_now,
    v_now+make_interval(hours=>v_tpl.duration_hours),v_now,v_tpl.description_ar,
    v_tpl.description_en,v_tpl.affected_sectors,v_tpl.revenue_multiplier,v_tpl.stack_group)
   on conflict(id) do update set title_ar=excluded.title_ar,title_en=excluded.title_en,
    effect_type=excluded.effect_type,target_item_id=excluded.target_item_id,
    price_multiplier=excluded.price_multiplier,tax_delta=excluded.tax_delta,active=true,
    starts_at=excluded.starts_at,ends_at=excluded.ends_at,created_at=excluded.created_at,
    description_ar=excluded.description_ar,description_en=excluded.description_en,
    affected_sectors=excluded.affected_sectors,revenue_multiplier=excluded.revenue_multiplier,
    stack_group=excluded.stack_group;
  end loop;
 end if;
 if cardinality(v_deactivate)>0 then
  update world_events set active=false where id=any(v_deactivate);
 end if;
 return jsonb_build_object('ok',true,'deactivated',to_jsonb(v_deactivate),'activated',to_jsonb(v_activated));
end $$;

create or replace function nexora.run_company_auction_settlement()
returns jsonb language plpgsql security definer set search_path=nexora,pg_temp as $$
begin
 if not coalesce((select enabled from scheduler_flags where job_key='company_auction_settlement'),false) then
  return jsonb_build_object('ok',true,'skipped',true,'reason','CUTOVER_DISABLED');
 end if;
 return settle_expired_company_auctions(100);
end $$;

create or replace function nexora.run_world_event_rotation()
returns jsonb language plpgsql security definer set search_path=nexora,pg_temp as $$
begin
 if not coalesce((select enabled from scheduler_flags where job_key='world_event_rotation'),false) then
  return jsonb_build_object('ok',true,'skipped',true,'reason','CUTOVER_DISABLED');
 end if;
 return rotate_world_events();
end $$;

revoke all on function nexora.rotate_world_events() from public,anon,authenticated;
revoke all on function nexora.run_company_auction_settlement() from public,anon,authenticated;
revoke all on function nexora.run_world_event_rotation() from public,anon,authenticated;
grant execute on function nexora.rotate_world_events() to service_role;
grant execute on function nexora.run_company_auction_settlement() to service_role;
grant execute on function nexora.run_world_event_rotation() to service_role;

create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;
do $$
declare v_job record;
begin
 for v_job in select jobid from cron.job
  where jobname in ('nexora-company-auction-settlement','nexora-world-event-rotation')
 loop
  perform cron.unschedule(v_job.jobid);
 end loop;
end $$;
select cron.schedule('nexora-company-auction-settlement','* * * * *',
 'select nexora.run_company_auction_settlement();');
select cron.schedule('nexora-world-event-rotation','0 */6 * * *',
 'select nexora.run_world_event_rotation();');
